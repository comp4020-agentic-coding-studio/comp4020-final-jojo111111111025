import { afterEach, describe, expect, it } from "vitest";
import { ENEMY_CONTACT_COOLDOWN_MS, MAX_HEALTH, WANDERER_CONTACT_DAMAGE, WANDERER_MAX_HEALTH } from "../src/shared/constants.js";
import type { EnemySpawn } from "../src/shared/types.js";
import { TestClient, startTestServer, type TestServer } from "./helpers/server-harness.js";
import { compactIntegrationMap } from "./helpers/test-fixtures.js";

let server: TestServer | undefined;
let serverB: TestServer | undefined;

afterEach(async () => {
  await server?.close();
  await serverB?.close();
  server = undefined;
  serverB = undefined;
});

describe("combat — full wire path", () => {
  it("an attack beyond range is rejected over the wire without damaging the enemy", async () => {
    const farSpawn: EnemySpawn = { kind: "wanderer", x: 9, y: 9 };
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
    const closeSpawn: EnemySpawn = { kind: "wanderer", x: 2, y: 1 }; // right next to spawn (1.5, 1.5)
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

  it(
    "killing the last enemy on the map broadcasts game.victory to every connected client exactly once",
    async () => {
      const closeSpawn: EnemySpawn = { kind: "wanderer", x: 2, y: 1 };
      server = await startTestServer({ roomCode: "TEST", map: compactIntegrationMap(), enemySpawns: [closeSpawn] });
      const attacker = new TestClient(server.wsUrl);
      const observer = new TestClient(server.wsUrl);
      const joined = await attacker.join("Alice", "TEST");
      await observer.join("Bob", "TEST");

      const snapshot = await attacker.waitFor((m) => m.type === "world.snapshot");
      const enemy = snapshot.enemies[0];

      let died = false;
      for (let i = 0; i < 10 && !died; i++) {
        attacker.send({ type: "combat.attack", requestId: `atk-${i}`, targetId: enemy.id });
        const result = await attacker.waitFor((m) => m.requestId === `atk-${i}`);
        if (result.enemyDied) died = true;
        // ATTACK_COOLDOWN_MS is 600ms real time between hits — this test
        // uses the real wall clock (no injected clock override), so wait it
        // out between attempts rather than hammering the rate limiter.
        if (!died) await new Promise((resolve) => setTimeout(resolve, 650));
      }
      expect(died).toBe(true);

      const victoryToAttacker = await attacker.waitFor((m) => m.type === "game.victory");
      expect(victoryToAttacker.lastKillBy).toBe(joined.playerId);
      const victoryToObserver = await observer.waitFor((m) => m.type === "game.victory");
      expect(victoryToObserver.lastKillBy).toBe(joined.playerId);

      expect(attacker.messages.filter((m) => m.type === "game.victory").length).toBe(1);
      expect(observer.messages.filter((m) => m.type === "game.victory").length).toBe(1);

      attacker.close();
      observer.close();
    },
    15000,
  );

  it(
    "a won room's game.playAgain revives the enemy and broadcasts game.reset to every connected client",
    async () => {
      const closeSpawn: EnemySpawn = { kind: "wanderer", x: 2, y: 1 };
      server = await startTestServer({ roomCode: "TEST", map: compactIntegrationMap(), enemySpawns: [closeSpawn] });
      const attacker = new TestClient(server.wsUrl);
      const observer = new TestClient(server.wsUrl);
      await attacker.join("Alice", "TEST");
      await observer.join("Bob", "TEST");

      const snapshot = await attacker.waitFor((m) => m.type === "world.snapshot");
      const enemy = snapshot.enemies[0];

      let died = false;
      for (let i = 0; i < 10 && !died; i++) {
        attacker.send({ type: "combat.attack", requestId: `atk-${i}`, targetId: enemy.id });
        const result = await attacker.waitFor((m) => m.requestId === `atk-${i}`);
        if (result.enemyDied) died = true;
        if (!died) await new Promise((resolve) => setTimeout(resolve, 650));
      }
      expect(died).toBe(true);
      await attacker.waitFor((m) => m.type === "game.victory");
      await observer.waitFor((m) => m.type === "game.victory");
      expect(server.room.allEnemiesDefeated()).toBe(true);

      // The observer (not the one who landed the final blow) triggers the reset.
      observer.send({ type: "game.playAgain", requestId: "play-again-1" });
      const result = await observer.waitFor((m) => m.requestId === "play-again-1");
      expect(result.ok).toBe(true);

      const resetToAttacker = await attacker.waitFor((m) => m.type === "game.reset");
      const resetToObserver = await observer.waitFor((m) => m.type === "game.reset");
      expect(resetToAttacker).toBeDefined();
      expect(resetToObserver).toBeDefined();

      expect(server.room.allEnemiesDefeated()).toBe(false);
      expect(server.room.getEnemy(enemy.id)!.alive).toBe(true);
      expect(server.room.getEnemy(enemy.id)!.health).toBe(WANDERER_MAX_HEALTH);

      attacker.close();
      observer.close();
    },
    15000,
  );

  it("game.playAgain is rejected before the room has been won", async () => {
    const farSpawn: EnemySpawn = { kind: "wanderer", x: 9, y: 9 };
    server = await startTestServer({ roomCode: "TEST", map: compactIntegrationMap(), enemySpawns: [farSpawn] });
    const client = new TestClient(server.wsUrl);
    await client.join("Alice", "TEST");

    client.send({ type: "game.playAgain", requestId: "play-again-1" });
    const result = await client.waitFor((m) => m.requestId === "play-again-1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not_won");

    client.close();
  });
});

describe("cross-room isolation for combat actions", () => {
  it("a socket in room B cannot attack an enemy that exists only in room A's Room instance", async () => {
    const spawnA: EnemySpawn = { kind: "wanderer", x: 2, y: 1 };
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

describe("death — full wire path", () => {
  it(
    "a player killed by enemy contact damage has their buildings removed and inventory wiped, broadcast as player.died to every connected client",
    async () => {
      // A wanderer placed right on the spawn cell deals contact damage every
      // tick (well under its cooldown), so the player dies quickly without
      // needing to wait out real combat cooldowns.
      const spawnEnemy: EnemySpawn = { kind: "wanderer", x: 1, y: 1 };
      server = await startTestServer({ roomCode: "TEST", map: compactIntegrationMap(), enemySpawns: [spawnEnemy] });
      const victim = new TestClient(server.wsUrl);
      const observer = new TestClient(server.wsUrl);
      const joinedVictim = await victim.join("Alice", "TEST");
      await observer.join("Bob", "TEST");

      // Gather some wood and place a floor so there's something real to lose.
      for (let i = 0; i < 6; i++) {
        victim.send({ type: "player.interact", requestId: `gather-${i}`, objectId: "wood-node-1" });
        await victim.waitFor((m) => m.requestId === `gather-${i}`);
      }
      victim.send({ type: "building.place", requestId: "build-1", recipeId: "floor", x: 1, y: 2 });
      const buildResult = await victim.waitFor((m) => m.requestId === "build-1");
      expect(buildResult.ok).toBe(true);
      const buildingId = buildResult.buildingId as string;

      await observer.waitFor((m) => m.type === "entity.spawned" && m.building.id === buildingId);

      const hitsNeeded = Math.ceil(MAX_HEALTH / WANDERER_CONTACT_DAMAGE);
      // The tick loop (20Hz) applies contact damage on its own
      // ENEMY_CONTACT_COOLDOWN_MS cadence; give waitFor a timeout comfortably
      // longer than the real time that takes, rather than racing it with a
      // separate sleep (a sleep longer than waitFor's own timeout would let
      // waitFor reject before the event it's waiting for ever arrives).
      const waitForTimeoutMs = hitsNeeded * (ENEMY_CONTACT_COOLDOWN_MS + 100) + 5000;
      const diedToVictim = victim.waitFor((m) => m.type === "player.died", waitForTimeoutMs);
      const diedToObserver = observer.waitFor((m) => m.type === "player.died", waitForTimeoutMs);

      const deathToVictim = await diedToVictim;
      expect(deathToVictim.playerId).toBe(joinedVictim.playerId);
      expect(deathToVictim.removedBuildingIds).toEqual([buildingId]);
      expect(deathToVictim.inventory.wood).toBe(0);

      const deathToObserver = await diedToObserver;
      expect(deathToObserver.playerId).toBe(joinedVictim.playerId);
      expect(deathToObserver.removedBuildingIds).toEqual([buildingId]);

      expect(server.room.getPlayer(joinedVictim.playerId)!.alive).toBe(false);
      expect(server.room.getBuildings()).toHaveLength(0);

      victim.close();
      observer.close();
    },
    30000,
  );
});
