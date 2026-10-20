import { afterEach, describe, expect, it } from "vitest";
import {
  BEACON_REQUIRED_ANCIENT_CORE,
  BEACON_REQUIRED_STONE,
  BEACON_REQUIRED_WOOD,
  WANDERER_MAX_HEALTH,
} from "../src/shared/constants.js";
import type { EnemySpawn } from "../src/shared/types.js";
import { loadWorldProgress, persistPlayerInventory } from "../src/server/world.js";
import { TestClient, fetchIdentityCookie, startTestServer, type TestServer } from "./helpers/server-harness.js";
import { compactIntegrationMap } from "./helpers/test-fixtures.js";

let server: TestServer | undefined;
let serverB: TestServer | undefined;

afterEach(async () => {
  await server?.close();
  await serverB?.close();
  server = undefined;
  serverB = undefined;
});

let seqCounter = 0;

/**
 * Steers `playerId` toward (tx, ty) by sending player.input over the wire and
 * watching player.state broadcasts for the resulting position, exactly the
 * way a real client would. Resolves once within 0.5 tiles of the target.
 */
function walkTo(client: TestClient, playerId: string, tx: number, ty: number, timeoutMs = 10000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const iv = setInterval(() => {
      const latest = [...client.messages].reverse().find((m) => m.type === "player.state");
      const pos = latest?.players.find((p: any) => p.id === playerId);
      if (!pos) return;
      const dx = tx - pos.x;
      const dy = ty - pos.y;
      const d = Math.hypot(dx, dy);
      if (d < 0.5) {
        clearInterval(iv);
        client.send({ type: "player.input", seq: seqCounter++, dx: 0, dy: 0 });
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        clearInterval(iv);
        reject(new Error(`walkTo(${tx}, ${ty}) timed out at dist=${d}`));
        return;
      }
      client.send({ type: "player.input", seq: seqCounter++, dx: dx / d, dy: dy / d });
    }, 50);
  });
}

/** Repeatedly sends player.input toward (tx, ty) using a snapshot-derived starting position, for use right after join before any player.state has arrived. */
async function joinAndWalk(client: TestClient, playerId: string, tx: number, ty: number): Promise<void> {
  client.send({ type: "player.input", seq: seqCounter++, dx: 1, dy: 0 }); // nudge so a player.state broadcast starts arriving
  await client.waitFor((m) => m.type === "player.state" && m.players.some((p: any) => p.id === playerId));
  await walkTo(client, playerId, tx, ty);
}

describe("combat — full wire path", () => {
  it("an attack beyond range is rejected over the wire without damaging the enemy", async () => {
    const farSpawn: EnemySpawn = { kind: "wanderer", zone: "overworld", x: 9, y: 9 };
    server = await startTestServer({ roomCode: "TEST", map: compactIntegrationMap(), enemySpawns: [farSpawn] });
    const client = new TestClient(server.wsUrl);
    const joined = await client.join("Alice", "TEST");
    const snapshot = await client.waitFor((m) => m.type === "world.snapshot");
    const enemy = snapshot.enemies[0];
    expect(enemy.health).toBe(WANDERER_MAX_HEALTH);

    client.send({ type: "combat.attack", requestId: "atk-1", targetId: enemy.id });
    const result = await client.waitFor((m) => m.requestId === "atk-1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("too_far");
    expect(server.room.getEnemy(enemy.id)!.health).toBe(WANDERER_MAX_HEALTH);

    client.close();
    void joined;
  });

  it("an attack on an unknown target is rejected and never crashes the connection", async () => {
    server = await startTestServer({ roomCode: "TEST", map: compactIntegrationMap(), enemySpawns: [] });
    const client = new TestClient(server.wsUrl);
    await client.join("Alice", "TEST");

    client.send({ type: "combat.attack", requestId: "atk-1", targetId: "no-such-enemy" });
    const result = await client.waitFor((m) => m.requestId === "atk-1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unknown_target");
    expect(client.socket.readyState).toBe(client.socket.OPEN);

    client.close();
  });

  it("a valid attack deals damage, is broadcast as a combat.event to every connected client, and a duplicate requestId is deduped", async () => {
    const closeSpawn: EnemySpawn = { kind: "wanderer", zone: "overworld", x: 2, y: 1 }; // right next to spawn (1.5, 1.5)
    server = await startTestServer({ roomCode: "TEST", map: compactIntegrationMap(), enemySpawns: [closeSpawn] });
    const attacker = new TestClient(server.wsUrl);
    const observer = new TestClient(server.wsUrl);
    const joinedA = await attacker.join("Alice", "TEST");
    await observer.join("Bob", "TEST");

    const snapshot = await attacker.waitFor((m) => m.type === "world.snapshot");
    const enemy = snapshot.enemies[0];

    attacker.send({ type: "combat.attack", requestId: "atk-1", targetId: enemy.id });
    const result = await attacker.waitFor((m) => m.requestId === "atk-1");
    expect(result.ok).toBe(true);
    expect(result.damageDealt).toBeGreaterThan(0);
    expect(result.enemyHealth).toBe(WANDERER_MAX_HEALTH - result.damageDealt);

    // Every connected client — not just the attacker — sees the combat event.
    const broadcastToObserver = await observer.waitFor((m) => m.type === "combat.event" && m.targetId === enemy.id);
    expect(broadcastToObserver.attackerId).toBe(joinedA.playerId);
    expect(broadcastToObserver.damage).toBe(result.damageDealt);
    expect(broadcastToObserver.enemyHealth).toBe(result.enemyHealth);

    // A duplicate requestId (client retry / network blip) must not double-hit.
    // The server still replies (net.ts always sends a response), but the
    // reply is the exact same cached ActionResult, not a fresh hit — assert
    // that by counting matching messages and checking the enemy's health
    // server-side never moved a second time.
    const countBefore = attacker.messages.filter((m) => m.requestId === "atk-1").length;
    attacker.send({ type: "combat.attack", requestId: "atk-1", targetId: enemy.id });
    await new Promise<void>((resolve) => {
      const iv = setInterval(() => {
        if (attacker.messages.filter((m) => m.requestId === "atk-1").length > countBefore) {
          clearInterval(iv);
          resolve();
        }
      }, 20);
    });
    const allAtk1 = attacker.messages.filter((m) => m.requestId === "atk-1");
    expect(allAtk1[allAtk1.length - 1]).toEqual(result);
    expect(server.room.getEnemy(enemy.id)!.health).toBe(result.enemyHealth);

    attacker.close();
    observer.close();
  });

  it("rejects an attack across zones — a player in the overworld cannot damage a dungeon enemy", async () => {
    const dungeonSpawn: EnemySpawn = { kind: "guardian", zone: "dungeon", x: 2, y: 1 };
    server = await startTestServer({ roomCode: "TEST", map: compactIntegrationMap(), enemySpawns: [dungeonSpawn] });
    const client = new TestClient(server.wsUrl);
    await client.join("Alice", "TEST");
    const snapshot = await client.waitFor((m) => m.type === "world.snapshot");
    const enemy = snapshot.enemies.find((e: any) => e.zone === "dungeon");
    expect(enemy).toBeDefined();

    client.send({ type: "combat.attack", requestId: "atk-1", targetId: enemy.id });
    const result = await client.waitFor((m) => m.requestId === "atk-1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("wrong_zone");

    client.close();
  });

  it(
    "a contributor who disconnects and is evicted before the boss's fatal blow receives exactly one pending reward on their next join",
    async () => {
      // A deterministic injected clock lets this test drive 30+ boss attacks
      // without any real-time cooldown waits, independent of the real
      // reconnectGraceMs eviction timer below (that one is wall-clock, by
      // design — see net.ts).
      let clock = 0;
      const advanceClock = (ms: number) => {
        clock += ms;
      };
      const bossSpawn: EnemySpawn = { kind: "boss", zone: "dungeon", x: 1, y: 1 };
      server = await startTestServer({
        roomCode: "TEST",
        map: compactIntegrationMap(),
        enemySpawns: [bossSpawn],
        reconnectGraceMs: 100,
        now: () => clock,
      });

      // Fetch Bob's identity cookie via plain HTTP first (same as
      // reconnect.spec.ts) so the exact same stable identity can be reused
      // for the later rejoin below — a TestClient with no cookie mints a
      // fresh, different identity on each connection.
      const bobCookie = await fetchIdentityCookie(server.httpUrl);
      const alice = new TestClient(server.wsUrl);
      const bob = new TestClient(server.wsUrl, bobCookie);
      const joinedAlice = await alice.join("Alice", "TEST");
      const joinedBob = await bob.join("Bob", "TEST");

      await joinAndWalk(alice, joinedAlice.playerId, 3.5, 1.5);
      alice.send({ type: "zone.enter", requestId: "zone-a", objectId: "entrance-1", target: "dungeon" });
      await alice.waitFor((m) => m.requestId === "zone-a");

      await joinAndWalk(bob, joinedBob.playerId, 3.5, 1.5);
      bob.send({ type: "zone.enter", requestId: "zone-b", objectId: "entrance-1", target: "dungeon" });
      await bob.waitFor((m) => m.requestId === "zone-b");

      const snapshot = await alice.waitFor((m) => m.type === "world.snapshot");
      const boss = snapshot.enemies.find((e: any) => e.kind === "boss");
      expect(boss).toBeDefined();

      // Bob lands exactly one hit, becoming a contributor...
      bob.send({ type: "combat.attack", requestId: "bob-hit", targetId: boss.id });
      const bobHit = await bob.waitFor((m) => m.requestId === "bob-hit");
      expect(bobHit.ok).toBe(true);
      advanceClock(1000);

      // ...then Bob disconnects and is genuinely evicted (past the short
      // real-time grace window) before the boss actually dies.
      bob.close();
      await bob.waitClose();
      await new Promise((resolve) => setTimeout(resolve, 300)); // past reconnectGraceMs: 100
      expect(server.room.hasPlayer(joinedBob.playerId)).toBe(false);

      // Alice finishes the boss off alone, advancing the injected clock past
      // ATTACK_COOLDOWN_MS between every hit so no real-time wait is needed.
      // Standing in melee range keeps her inside the boss's own AoE radius,
      // so its (real tick-driven, same injected clock) telegraphed attacks
      // would otherwise kill her well before the fight is over — this test
      // is about reward-claim correctness, not survival, so her health is
      // topped up directly between hits exactly like other tests in this
      // file mutate a live Room player's state directly.
      let died = false;
      for (let i = 0; i < 40 && !died; i++) {
        // The interactLimiter rate-limits by real wall-clock time (10/sec),
        // separate from the Room's injected game clock advanced below — a
        // short real delay keeps this loop under that limit.
        await new Promise((resolve) => setTimeout(resolve, 110));
        const aliceState = server.room.getPlayer(joinedAlice.playerId)!;
        aliceState.health = 100;
        aliceState.alive = true;
        alice.send({ type: "combat.attack", requestId: `alice-hit-${i}`, targetId: boss.id });
        const result = await alice.waitFor((m) => m.requestId === `alice-hit-${i}`);
        if (result.enemyDied) died = true;
        advanceClock(1000);
      }
      expect(died).toBe(true);

      // Bob rejoins as a brand-new connection, carrying the same identity
      // cookie fetched above — the server resolves it back to the exact same
      // stable id, now past its grace window and genuinely evicted, so this
      // exercises claimAndApplyPendingRewards via a real room.join over the wire.
      const bobRejoin = new TestClient(server.wsUrl, bobCookie);
      const rejoined = await bobRejoin.join("Bob", "TEST");
      expect(rejoined.playerId).toBe(joinedBob.playerId);

      const rejoinSnapshot = await bobRejoin.waitFor((m) => m.type === "world.snapshot");
      const bobAfterRejoin = rejoinSnapshot.players.find((p: any) => p.id === joinedBob.playerId);
      expect(bobAfterRejoin.inventory.ancient_core).toBe(1);

      // Alice (still present throughout) also got her reward directly, same as before.
      expect(server.room.getPlayer(joinedAlice.playerId)!.inventory.ancient_core).toBe(1);

      alice.close();
      bobRejoin.close();
    },
    15000,
  );
});

describe("zone transitions — full wire path", () => {
  it("a player walks to the dungeon entrance, enters, and the server records the zone change", async () => {
    server = await startTestServer({ roomCode: "TEST", map: compactIntegrationMap(), enemySpawns: [] });
    const client = new TestClient(server.wsUrl);
    const joined = await client.join("Alice", "TEST");

    await joinAndWalk(client, joined.playerId, 3.5, 1.5);

    client.send({ type: "zone.enter", requestId: "zone-1", objectId: "entrance-1", target: "dungeon" });
    const result = await client.waitFor((m) => m.requestId === "zone-1");
    expect(result.ok).toBe(true);
    expect(server.room.getPlayer(joined.playerId)!.zone).toBe("dungeon");

    client.close();
  });

  it("rejects entering the dungeon while out of range of the entrance, over the wire", async () => {
    server = await startTestServer({ roomCode: "TEST", map: compactIntegrationMap(), enemySpawns: [] });
    const client = new TestClient(server.wsUrl);
    const joined = await client.join("Alice", "TEST"); // spawns at (1.5, 1.5), entrance at (3.5, 1.5) — out of ZONE_TRANSITION_RANGE_TILES

    client.send({ type: "zone.enter", requestId: "zone-1", objectId: "entrance-1", target: "dungeon" });
    const result = await client.waitFor((m) => m.requestId === "zone-1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("too_far");
    expect(server.room.getPlayer(joined.playerId)!.zone).toBe("overworld");

    client.close();
  });

  it("a second player in a different zone cannot be reached by zone.enter spoofing another zone's object id", async () => {
    server = await startTestServer({ roomCode: "TEST", map: compactIntegrationMap(), enemySpawns: [] });
    const client = new TestClient(server.wsUrl);
    const joined = await client.join("Alice", "TEST");
    await joinAndWalk(client, joined.playerId, 3.5, 1.5);
    client.send({ type: "zone.enter", requestId: "zone-1", objectId: "entrance-1", target: "dungeon" });
    await client.waitFor((m) => m.requestId === "zone-1");
    expect(server.room.getPlayer(joined.playerId)!.zone).toBe("dungeon");

    // Still holding the overworld entrance's id, try to "enter the dungeon"
    // again (already there) and separately try using the overworld object
    // while physically in the dungeon zone.
    client.send({ type: "zone.enter", requestId: "zone-2", objectId: "entrance-1", target: "overworld" });
    const result = await client.waitFor((m) => m.requestId === "zone-2");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("wrong_zone");

    client.close();
  });
});

describe("beacon — full wire path", () => {
  it("deposits of each material are validated server-side and reflected in a broadcast beacon.progress", async () => {
    server = await startTestServer({ roomCode: "TEST", map: compactIntegrationMap(), enemySpawns: [] });
    const client = new TestClient(server.wsUrl);
    const observer = new TestClient(server.wsUrl);
    const joined = await client.join("Alice", "TEST");
    await observer.join("Bob", "TEST");

    // wood-node-1 (0, 1) is within GATHER_RANGE_TILES of spawn (1.5, 1.5)
    // already — a tree is a solid object, so a player can never walk onto
    // its own center tile; gathering and the beacon deposit below rely on
    // range alone, not on standing on top of either object.
    client.send({ type: "player.interact", requestId: "g1", objectId: "wood-node-1" });
    const gather = await client.waitFor((m) => m.requestId === "g1");
    expect(gather.ok).toBe(true);

    await joinAndWalk(client, joined.playerId, 3.5, 1.5);
    client.send({ type: "zone.enter", requestId: "zone-1", objectId: "entrance-1", target: "dungeon" });
    await client.waitFor((m) => m.requestId === "zone-1");

    // The dungeon's beacon-1 (2, 1) is within BEACON_RANGE_TILES of the
    // entry point (1, 1) the player now stands at — again, no walk needed.
    client.send({ type: "beacon.deposit", requestId: "dep-1", itemKind: "wood", quantity: 1 });
    const depositResult = await client.waitFor((m) => m.requestId === "dep-1");
    expect(depositResult.ok).toBe(true);

    const progressBroadcast = await observer.waitFor((m) => m.type === "beacon.progress" && m.wood === 1);
    expect(progressBroadcast.wood).toBe(1);
    expect(progressBroadcast.requiredWood).toBe(BEACON_REQUIRED_WOOD);
    expect(server.room.getBeaconProgress().wood).toBe(1);

    client.close();
    observer.close();
  }, 15000);

  it("rejects depositing more of a material than the player's inventory holds", async () => {
    server = await startTestServer({ roomCode: "TEST", map: compactIntegrationMap(), enemySpawns: [] });
    const client = new TestClient(server.wsUrl);
    const joined = await client.join("Alice", "TEST");
    await joinAndWalk(client, joined.playerId, 3.5, 1.5);
    client.send({ type: "zone.enter", requestId: "zone-1", objectId: "entrance-1", target: "dungeon" });
    await client.waitFor((m) => m.requestId === "zone-1");

    client.send({ type: "beacon.deposit", requestId: "dep-1", itemKind: "wood", quantity: 5 });
    const result = await client.waitFor((m) => m.requestId === "dep-1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("insufficient_materials");

    client.close();
  }, 15000);

  it("rejects an unknown item kind for beacon.deposit without crashing the connection", async () => {
    server = await startTestServer({ roomCode: "TEST", map: compactIntegrationMap(), enemySpawns: [] });
    const client = new TestClient(server.wsUrl);
    const joined = await client.join("Alice", "TEST");
    await joinAndWalk(client, joined.playerId, 3.5, 1.5);
    client.send({ type: "zone.enter", requestId: "zone-1", objectId: "entrance-1", target: "dungeon" });
    await client.waitFor((m) => m.requestId === "zone-1");

    client.send({ type: "beacon.deposit", requestId: "dep-1", itemKind: "sword", quantity: 1 });
    const result = await client.waitFor((m) => m.requestId === "dep-1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unknown_item_kind");
    expect(client.socket.readyState).toBe(client.socket.OPEN);

    client.close();
  });

  it("rejects beacon.activate until the boss is defeated and materials are met, then succeeds and broadcasts beacon.victory to everyone", async () => {
    server = await startTestServer({ roomCode: "TEST", map: compactIntegrationMap(), enemySpawns: [] });
    const client = new TestClient(server.wsUrl);
    const joined = await client.join("Alice", "TEST");

    await joinAndWalk(client, joined.playerId, 3.5, 1.5);
    client.send({ type: "zone.enter", requestId: "zone-1", objectId: "entrance-1", target: "dungeon" });
    await client.waitFor((m) => m.requestId === "zone-1");

    // Not enough materials and the boss isn't defeated yet.
    client.send({ type: "beacon.activate", requestId: "act-1" });
    const early = await client.waitFor((m) => m.requestId === "act-1");
    expect(early.ok).toBe(false);
    expect(["boss_not_defeated", "insufficient_materials"]).toContain(early.reason);

    // Grant every required material through the database-backed persistence
    // layer this room was built from, and have the player deposit them over
    // the real wire — the point of this test is activate's own gating and
    // broadcast, not re-proving combat's loot path (covered in the combat
    // suite's boss-kill test).
    persistPlayerInventory(server.db, joined.playerId, {
      wood: BEACON_REQUIRED_WOOD,
      stone: BEACON_REQUIRED_STONE,
      berries: 0,
      seed_berry: 0,
      axe: 0,
      pickaxe: 0,
      sword: 0,
      bandage: 0,
      ancient_core: BEACON_REQUIRED_ANCIENT_CORE,
    });
    const player = server.room.getPlayer(joined.playerId)!;
    player.inventory.wood = BEACON_REQUIRED_WOOD;
    player.inventory.stone = BEACON_REQUIRED_STONE;
    player.inventory.ancient_core = BEACON_REQUIRED_ANCIENT_CORE;

    client.send({ type: "beacon.deposit", requestId: "dep-w", itemKind: "wood", quantity: BEACON_REQUIRED_WOOD });
    await client.waitFor((m) => m.requestId === "dep-w");
    client.send({ type: "beacon.deposit", requestId: "dep-s", itemKind: "stone", quantity: BEACON_REQUIRED_STONE });
    await client.waitFor((m) => m.requestId === "dep-s");
    client.send({ type: "beacon.deposit", requestId: "dep-a", itemKind: "ancient_core", quantity: BEACON_REQUIRED_ANCIENT_CORE });
    await client.waitFor((m) => m.requestId === "dep-a");

    // Still not activatable: the boss hasn't been defeated.
    client.send({ type: "beacon.activate", requestId: "act-2" });
    const stillBlocked = await client.waitFor((m) => m.requestId === "act-2");
    expect(stillBlocked.ok).toBe(false);
    expect(stillBlocked.reason).toBe("boss_not_defeated");

    // Mark the boss defeated via the real persistence function (the same
    // write Room.handleEnemyDeath performs on a real kill), then restart the
    // server against that same DB file so the new Room's constructor reads
    // bossAlreadyDefeated = true from disk — the identical path a genuine
    // boss kill followed by a server restart would take.
    const { persistBossDefeated } = await import("../src/server/world.js");
    persistBossDefeated(server.db);
    client.close();

    const dir = server.dir;
    await server.close({ keepData: true });
    server = await startTestServer({ roomCode: "TEST", map: compactIntegrationMap(), enemySpawns: [], dbDir: dir });

    const client2 = new TestClient(server.wsUrl);
    const observer = new TestClient(server.wsUrl);
    const joined2 = await client2.join("Alice", "TEST");
    await observer.join("Bob", "TEST");
    // zone.enter again: this is a fresh Room instance (new server), so the
    // player starts back in the overworld despite the prior session's state.
    await joinAndWalk(client2, joined2.playerId, 3.5, 1.5);
    client2.send({ type: "zone.enter", requestId: "zone-2", objectId: "entrance-1", target: "dungeon" });
    await client2.waitFor((m) => m.requestId === "zone-2");

    client2.send({ type: "beacon.activate", requestId: "act-3" });
    const activated = await client2.waitFor((m) => m.requestId === "act-3");
    expect(activated.ok).toBe(true);

    const victoryBroadcast = await observer.waitFor((m) => m.type === "beacon.victory");
    expect(victoryBroadcast.activatedBy).toBe(joined2.playerId);

    client2.close();
    observer.close();
  }, 15000);

  it("only one of two concurrent beacon.activate requests wins and broadcasts victory exactly once", async () => {
    server = await startTestServer({ roomCode: "TEST", map: compactIntegrationMap(), enemySpawns: [] });
    const client = new TestClient(server.wsUrl);
    const joined = await client.join("Alice", "TEST");

    await joinAndWalk(client, joined.playerId, 3.5, 1.5);
    client.send({ type: "zone.enter", requestId: "zone-1", objectId: "entrance-1", target: "dungeon" });
    await client.waitFor((m) => m.requestId === "zone-1");

    const { persistBossDefeated: markBossDefeated } = await import("../src/server/world.js");
    markBossDefeated(server.db);
    const player = server.room.getPlayer(joined.playerId)!;
    player.inventory.wood = BEACON_REQUIRED_WOOD;
    player.inventory.stone = BEACON_REQUIRED_STONE;
    player.inventory.ancient_core = BEACON_REQUIRED_ANCIENT_CORE;
    client.send({ type: "beacon.deposit", requestId: "dep-w", itemKind: "wood", quantity: BEACON_REQUIRED_WOOD });
    await client.waitFor((m) => m.requestId === "dep-w");
    client.send({ type: "beacon.deposit", requestId: "dep-s", itemKind: "stone", quantity: BEACON_REQUIRED_STONE });
    await client.waitFor((m) => m.requestId === "dep-s");
    client.send({ type: "beacon.deposit", requestId: "dep-a", itemKind: "ancient_core", quantity: BEACON_REQUIRED_ANCIENT_CORE });
    await client.waitFor((m) => m.requestId === "dep-a");
    client.close();

    // Restart so the new Room reads bossAlreadyDefeated = true from disk,
    // same as the previous test — then race two genuinely distinct
    // activate requests (different requestIds, so neither hits the dedupe
    // cache) against the real persistence-layer atomic check.
    const dir = server.dir;
    await server.close({ keepData: true });
    server = await startTestServer({ roomCode: "TEST", map: compactIntegrationMap(), enemySpawns: [], dbDir: dir });

    const clientA = new TestClient(server.wsUrl);
    const clientB = new TestClient(server.wsUrl);
    const joinedA = await clientA.join("Alice", "TEST");
    await clientB.join("Bob", "TEST");

    await joinAndWalk(clientA, joinedA.playerId, 3.5, 1.5);
    clientA.send({ type: "zone.enter", requestId: "zone-2", objectId: "entrance-1", target: "dungeon" });
    await clientA.waitFor((m) => m.requestId === "zone-2");

    clientA.send({ type: "beacon.activate", requestId: "race-1" });
    clientA.send({ type: "beacon.activate", requestId: "race-2" });
    const r1 = await clientA.waitFor((m) => m.requestId === "race-1");
    const r2 = await clientA.waitFor((m) => m.requestId === "race-2");

    const outcomes = [r1.ok, r2.ok].sort();
    expect(outcomes).toEqual([false, true]);

    const victoryMessages = clientA.messages.filter((m) => m.type === "beacon.victory");
    expect(victoryMessages.length).toBe(1);

    clientA.close();
    clientB.close();
  }, 15000);

  it(
    "beacon.activate is rate-limited like every other mutating action, and a rejected attempt never activates the beacon or broadcasts victory",
    async () => {
      server = await startTestServer({ roomCode: "TEST", map: compactIntegrationMap(), enemySpawns: [] });
      const client = new TestClient(server.wsUrl);
      const observer = new TestClient(server.wsUrl);
      const joined = await client.join("Alice", "TEST");
      await observer.join("Bob", "TEST");

      await joinAndWalk(client, joined.playerId, 3.5, 1.5);
      client.send({ type: "zone.enter", requestId: "zone-1", objectId: "entrance-1", target: "dungeon" });
      await client.waitFor((m) => m.requestId === "zone-1");

      // interactLimiter allows 10 requests/second; fire 12 back-to-back
      // activate attempts (none of them meet the boss/material requirements
      // either, but that's not the point — the rate limit must trip first,
      // before validation even runs, exactly like every other action type).
      const results: any[] = [];
      for (let i = 0; i < 12; i++) {
        client.send({ type: "beacon.activate", requestId: `act-${i}` });
      }
      for (let i = 0; i < 12; i++) {
        results.push(await client.waitFor((m) => m.requestId === `act-${i}`));
      }

      const rateLimited = results.filter((r) => r.reason === "rate_limited");
      expect(rateLimited.length).toBeGreaterThan(0);

      // None of these ever activated the beacon (also blocked independently
      // by missing boss/materials) or broadcast victory to anyone.
      expect(results.every((r) => r.ok === false)).toBe(true);
      expect(server.room.getBeaconProgress().activated).toBe(false);
      expect(client.messages.some((m) => m.type === "beacon.victory")).toBe(false);
      expect(observer.messages.some((m) => m.type === "beacon.victory")).toBe(false);

      client.close();
      observer.close();
    },
    15000,
  );
});

describe("cross-room isolation for combat/beacon/zone actions", () => {
  it("a socket in room B cannot attack an enemy that exists only in room A's Room instance", async () => {
    const spawnA: EnemySpawn = { kind: "wanderer", zone: "overworld", x: 2, y: 1 };
    server = await startTestServer({ roomCode: "ROOM-A", map: compactIntegrationMap(), enemySpawns: [spawnA] });
    serverB = await startTestServer({ roomCode: "ROOM-B", map: compactIntegrationMap(), enemySpawns: [] });

    const clientA = new TestClient(server.wsUrl);
    await clientA.join("Alice", "ROOM-A");
    const snapshotA = await clientA.waitFor((m) => m.type === "world.snapshot");
    const enemyIdFromA = snapshotA.enemies[0].id;

    const clientB = new TestClient(serverB.wsUrl);
    await clientB.join("Bob", "ROOM-B");

    clientB.send({ type: "combat.attack", requestId: "atk-1", targetId: enemyIdFromA });
    const result = await clientB.waitFor((m) => m.requestId === "atk-1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unknown_target");
    expect(server.room.getEnemy(enemyIdFromA)!.health).toBe(WANDERER_MAX_HEALTH);

    clientA.close();
    clientB.close();
  });
});

describe("restart persistence for Phase D state", () => {
  it("beacon material deposits and boss-defeated status survive a full server restart", async () => {
    server = await startTestServer({ roomCode: "TEST", map: compactIntegrationMap(), enemySpawns: [] });
    const client = new TestClient(server.wsUrl);
    const joined = await client.join("Alice", "TEST");

    // wood-node-1 is already within GATHER_RANGE_TILES of spawn — no walk needed.
    client.send({ type: "player.interact", requestId: "g1", objectId: "wood-node-1" });
    await client.waitFor((m) => m.requestId === "g1");

    await joinAndWalk(client, joined.playerId, 3.5, 1.5);
    client.send({ type: "zone.enter", requestId: "zone-1", objectId: "entrance-1", target: "dungeon" });
    await client.waitFor((m) => m.requestId === "zone-1");

    // beacon-1 is within BEACON_RANGE_TILES of the dungeon's entry point.
    client.send({ type: "beacon.deposit", requestId: "dep-1", itemKind: "wood", quantity: 1 });
    const depositResult = await client.waitFor((m) => m.requestId === "dep-1");
    expect(depositResult.ok).toBe(true);

    const { persistBossDefeated } = await import("../src/server/world.js");
    persistBossDefeated(server.db);

    client.close();
    const dir = server.dir;
    await server.close({ keepData: true });

    const restarted = await startTestServer({ roomCode: "TEST", map: compactIntegrationMap(), enemySpawns: [], dbDir: dir });
    const progress = loadWorldProgress(restarted.db);
    expect(progress.beaconWood).toBe(1);
    expect(progress.bossDefeatedAt).not.toBeNull();
    expect(restarted.room.getBeaconProgress().wood).toBe(1);
    expect(restarted.room.getBeaconProgress().bossDefeated).toBe(true);

    server = restarted;
  }, 15000);

  it("a completed (activated) beacon stays activated across a restart and a stale client is told via a fresh snapshot", async () => {
    server = await startTestServer({ roomCode: "TEST", map: compactIntegrationMap(), enemySpawns: [] });
    const { activateBeacon } = await import("../src/server/world.js");
    activateBeacon(server.db);

    const dir = server.dir;
    await server.close({ keepData: true });

    const restarted = await startTestServer({ roomCode: "TEST", map: compactIntegrationMap(), enemySpawns: [], dbDir: dir });
    expect(restarted.room.getBeaconProgress().activated).toBe(true);

    const client = new TestClient(restarted.wsUrl);
    await client.join("Alice", "TEST");
    const snapshot = await client.waitFor((m) => m.type === "world.snapshot");
    expect(snapshot.beaconProgress.activated).toBe(true);

    client.close();
    server = restarted;
  });
});
