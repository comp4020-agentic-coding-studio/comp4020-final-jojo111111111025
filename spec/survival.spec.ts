import { afterEach, describe, expect, it } from "vitest";
import { Room } from "../src/server/room.js";
import { loadOrCreateSessionSecret, mintCookieValue, touchPlayerRecord } from "../src/server/identity.js";
import { loadPlayerHealth, persistPlayerHealth } from "../src/server/world.js";
import { BANDAGE_HEAL_AMOUNT, ENEMY_CONTACT_COOLDOWN_MS, MAX_HEALTH, WANDERER_CONTACT_DAMAGE } from "../src/shared/constants.js";
import { emptyInventory, type EnemySpawn, type WorldMap } from "../src/shared/types.js";
import { TestClient, fetchIdentityCookie, startTestServer, type TestServer } from "./helpers/server-harness.js";

function makeClock(start = 0) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

/** Kills `playerId` via repeated wanderer contact damage (the only way outside a direct unit test to actually reach 0 health and trigger Room's real death/wipe path), advancing `clock` past ENEMY_CONTACT_COOLDOWN_MS between each tick. */
function killViaContactDamage(room: Room, clock: ReturnType<typeof makeClock>): void {
  const hitsNeeded = Math.ceil(MAX_HEALTH / WANDERER_CONTACT_DAMAGE);
  for (let i = 0; i < hitsNeeded; i++) {
    room.tick(0.01);
    clock.advance(ENEMY_CONTACT_COOLDOWN_MS + 1);
  }
}

/** Mints a valid signed identity cookie for a specific id, for tests that need to control the identity ahead of the first join. */
function mintCookieForId(server: TestServer, id: string): string {
  const secret = loadOrCreateSessionSecret(server.db);
  return `ls_id=${mintCookieValue(secret, id)}`;
}

function makeTestMap(): WorldMap {
  const width = 10;
  const height = 10;
  const tiles = Array.from({ length: width * height }, () => ({ terrain: "grass" as const }));
  return {
    seed: "test",
    width,
    height,
    tiles,
    objects: [
      { id: "wood-node", kind: "tree", x: 0, y: 1, resource: { kind: "wood", remaining: 10, maxRemaining: 10 } },
    ],
    campsite: { x: 1, y: 1 },
    spawnPoint: { x: 1, y: 1 },
  };
}

describe("Room player health and respawn", () => {
  it("a fresh player starts at full health and alive", () => {
    const room = new Room(makeTestMap());
    const player = room.addPlayer("p1", "Alice");
    expect(player.health).toBe(MAX_HEALTH);
    expect(player.alive).toBe(true);
  });

  it("addPlayer accepts a restored health value (e.g. loaded from persistence)", () => {
    const room = new Room(makeTestMap());
    const player = room.addPlayer("p1", "Alice", undefined, 40);
    expect(player.health).toBe(40);
    expect(player.alive).toBe(true);
  });

  it("a player restored with 0 health starts dead", () => {
    const room = new Room(makeTestMap());
    const player = room.addPlayer("p1", "Alice", undefined, 0);
    expect(player.health).toBe(0);
    expect(player.alive).toBe(false);
  });

  it("respawn fails for a player who is still alive", () => {
    const room = new Room(makeTestMap());
    room.addPlayer("p1", "Alice");
    const result = room.respawn("p1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not_dead");
  });

  it("respawn fails for an unknown player", () => {
    const room = new Room(makeTestMap());
    const result = room.respawn("does-not-exist");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unknown_player");
  });

  it("respawn resets a dead player's health and position, and does not itself touch inventory (the wipe already happened at death, not here)", () => {
    const room = new Room(makeTestMap());
    const player = room.addPlayer("p1", "Alice", undefined, 0); // starts dead
    // interact() rejects a dead player's actions entirely, so there's no
    // inventory to re-check here — this confirms respawn's own code path
    // doesn't mutate inventory, distinct from the wipe damagePlayer already
    // applied at the moment health reached 0 (see the death-wipe describe
    // block below for that).
    for (let i = 0; i < 3; i++) {
      room.interact("p1", "wood-node", `grant-${i}`);
    }
    expect(room.getPlayer("p1")!.inventory.wood).toBe(0);

    const result = room.respawn("p1");
    expect(result.ok).toBe(true);
    expect(result.health).toBe(MAX_HEALTH);

    const respawned = room.getPlayer("p1")!;
    expect(respawned.alive).toBe(true);
    expect(respawned.health).toBe(MAX_HEALTH);
    expect(respawned.inventory.wood).toBe(0);
  });

  it("a dead player's interact/craft/build/chest actions are all rejected with reason 'dead'", () => {
    const room = new Room(makeTestMap());
    room.addPlayer("p1", "Alice", undefined, 0); // dead on arrival

    expect(room.interact("p1", "wood-node", "r1").reason).toBe("dead");
    expect(room.craft("p1", "axe", "r2").reason).toBe("dead");
    expect(room.build("p1", "wall", 2, 2, "r3").reason).toBe("dead");
    expect(room.chestTransfer("p1", "does-not-exist", "wood", 1, "deposit", "r4").reason).toBe("dead");
  });

  it("a dead player does not move even with input set", () => {
    const room = new Room(makeTestMap());
    room.addPlayer("p1", "Alice", undefined, 0);
    room.setInput("p1", 1, 0);
    room.tick(1);
    const player = room.getPlayer("p1")!;
    expect(player.x).toBeCloseTo(1.5, 5);
  });

  it("persists health via the provided callback on respawn", () => {
    const calls: Array<{ playerId: string; health: number }> = [];
    const room = new Room(makeTestMap(), {
      playerHealth: (playerId, health) => calls.push({ playerId, health }),
    });
    room.addPlayer("p1", "Alice", undefined, 0);
    room.respawn("p1");
    expect(calls).toEqual([{ playerId: "p1", health: MAX_HEALTH }]);
  });
});

describe("death wipes inventory and buildings", () => {
  const WANDERER_ON_SPAWN: EnemySpawn = { kind: "wanderer", x: 1, y: 1 };

  it("empties a player's inventory the instant their health reaches 0", () => {
    const clock = makeClock();
    const room = new Room(makeTestMap(), {}, [], new Map(), clock.now, clock.now(), [WANDERER_ON_SPAWN]);
    room.addPlayer("p1", "Alice");
    for (let i = 0; i < 5; i++) room.interact("p1", "wood-node", `grant-${i}`);
    expect(room.getPlayer("p1")!.inventory.wood).toBe(5);

    killViaContactDamage(room, clock);

    const dead = room.getPlayer("p1")!;
    expect(dead.alive).toBe(false);
    expect(dead.inventory.wood).toBe(0);
  });

  it("removes every building the dead player owns from getBuildings", () => {
    const clock = makeClock();
    const room = new Room(makeTestMap(), {}, [], new Map(), clock.now, clock.now(), [WANDERER_ON_SPAWN]);
    room.addPlayer("p1", "Alice");
    for (let i = 0; i < 6; i++) room.interact("p1", "wood-node", `grant-${i}`);
    const build = room.build("p1", "floor", 2, 2, "build-1"); // within BUILD_RANGE_TILES of the (1.5, 1.5) spawn
    expect(build.ok).toBe(true);
    expect(room.getBuildings()).toHaveLength(1);

    killViaContactDamage(room, clock);

    expect(room.getBuildings()).toHaveLength(0);
  });

  it("leaves another player's buildings untouched", () => {
    const clock = makeClock();
    const room = new Room(makeTestMap(), {}, [], new Map(), clock.now, clock.now(), [WANDERER_ON_SPAWN]);
    room.addPlayer("p1", "Alice");
    room.addPlayer("p2", "Bob");
    for (let i = 0; i < 6; i++) room.interact("p2", "wood-node", `grant-${i}`);
    const build = room.build("p2", "floor", 2, 2, "build-1");
    expect(build.ok).toBe(true);

    killViaContactDamage(room, clock); // only p1 is in the wanderer's contact range

    expect(room.getPlayer("p1")!.alive).toBe(false);
    expect(room.getPlayer("p2")!.alive).toBe(true);
    expect(room.getBuildings()).toHaveLength(1);
    expect(room.getBuildings()[0]!.ownerId).toBe("p2");
  });

  it("calls removeBuilding for every building a dead player owned", () => {
    const removed: string[] = [];
    const clock = makeClock();
    const room = new Room(
      makeTestMap(),
      { removeBuilding: (id) => removed.push(id) },
      [],
      new Map(),
      clock.now,
      clock.now(),
      [WANDERER_ON_SPAWN],
    );
    room.addPlayer("p1", "Alice");
    for (let i = 0; i < 6; i++) room.interact("p1", "wood-node", `grant-${i}`);
    const build = room.build("p1", "floor", 2, 2, "build-1");
    const buildingId = build.buildingId!;

    killViaContactDamage(room, clock);

    expect(removed).toEqual([buildingId]);
  });

  it("drainDeathEvents reports the dead player's id, removed building ids, and the now-empty inventory, then empties on a second call", () => {
    const clock = makeClock();
    const room = new Room(makeTestMap(), {}, [], new Map(), clock.now, clock.now(), [WANDERER_ON_SPAWN]);
    room.addPlayer("p1", "Alice");
    for (let i = 0; i < 6; i++) room.interact("p1", "wood-node", `grant-${i}`);
    const build = room.build("p1", "floor", 2, 2, "build-1");
    const buildingId = build.buildingId!;

    killViaContactDamage(room, clock);

    const events = room.drainDeathEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.playerId).toBe("p1");
    expect(events[0]!.removedBuildingIds).toEqual([buildingId]);
    expect(events[0]!.inventory.wood).toBe(0);

    expect(room.drainDeathEvents()).toEqual([]);
  });

  it("a building placed and inventory gathered after respawning survive a second death normally (the wipe only fires on an actual death, not on every tick)", () => {
    const clock = makeClock();
    const room = new Room(makeTestMap(), {}, [], new Map(), clock.now, clock.now(), [WANDERER_ON_SPAWN]);
    room.addPlayer("p1", "Alice");
    for (let i = 0; i < 6; i++) room.interact("p1", "wood-node", `grant-${i}`);
    room.build("p1", "floor", 2, 2, "build-1");

    killViaContactDamage(room, clock);
    expect(room.getBuildings()).toHaveLength(0);
    room.drainDeathEvents();

    room.respawn("p1");
    for (let i = 10; i < 16; i++) room.interact("p1", "wood-node", `grant-${i}`);
    const rebuild = room.build("p1", "floor", 2, 1, "build-2");
    expect(rebuild.ok).toBe(true);
    expect(room.getBuildings()).toHaveLength(1);
  });
});

describe("Room.useBandage", () => {
  it("consumes one bandage and restores BANDAGE_HEAL_AMOUNT health", () => {
    const room = new Room(makeTestMap());
    const player = room.addPlayer("p1", "Alice", { ...emptyInventory(), bandage: 2 }, 50);

    const result = room.useBandage("p1", "req-1");
    expect(result.ok).toBe(true);
    expect(result.health).toBe(50 + BANDAGE_HEAL_AMOUNT);
    expect(result.inventory?.bandage).toBe(1);
    expect(player.health).toBe(50 + BANDAGE_HEAL_AMOUNT);
  });

  it("clamps healing at MAX_HEALTH rather than overhealing", () => {
    const room = new Room(makeTestMap());
    room.addPlayer("p1", "Alice", { ...emptyInventory(), bandage: 1 }, MAX_HEALTH - 10);

    const result = room.useBandage("p1", "req-1");
    expect(result.ok).toBe(true);
    expect(result.health).toBe(MAX_HEALTH);
  });

  it("still consumes the bandage even when already at full health", () => {
    const room = new Room(makeTestMap());
    room.addPlayer("p1", "Alice", { ...emptyInventory(), bandage: 1 });

    const result = room.useBandage("p1", "req-1");
    expect(result.ok).toBe(true);
    expect(result.health).toBe(MAX_HEALTH);
    expect(result.inventory?.bandage).toBe(0);
  });

  it("rejects when the player has no bandages", () => {
    const room = new Room(makeTestMap());
    room.addPlayer("p1", "Alice", emptyInventory(), 50);

    const result = room.useBandage("p1", "req-1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("insufficient_materials");
    expect(room.getPlayer("p1")!.health).toBe(50);
  });

  it("rejects for a dead player, and never consumes their bandage", () => {
    const room = new Room(makeTestMap());
    room.addPlayer("p1", "Alice", { ...emptyInventory(), bandage: 1 }, 0);

    const result = room.useBandage("p1", "req-1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("dead");
    expect(room.getPlayer("p1")!.inventory.bandage).toBe(1);
  });

  it("rejects for an unknown player", () => {
    const room = new Room(makeTestMap());
    const result = room.useBandage("does-not-exist", "req-1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unknown_player");
  });

  it("is idempotent for a repeated request ID — a retried use never double-consumes or double-heals", () => {
    const room = new Room(makeTestMap());
    room.addPlayer("p1", "Alice", { ...emptyInventory(), bandage: 3 }, 10);

    const first = room.useBandage("p1", "req-dup");
    const second = room.useBandage("p1", "req-dup");
    expect(second).toEqual(first);
    expect(room.getPlayer("p1")!.inventory.bandage).toBe(2);
    expect(room.getPlayer("p1")!.health).toBe(10 + BANDAGE_HEAL_AMOUNT);
  });

  it("persists both health and inventory via the provided callbacks", () => {
    const healthCalls: Array<{ playerId: string; health: number }> = [];
    const inventoryCalls: Array<{ playerId: string; inventory: Record<string, number> }> = [];
    const room = new Room(makeTestMap(), {
      playerHealth: (playerId, health) => healthCalls.push({ playerId, health }),
      playerInventory: (playerId, inventory) => inventoryCalls.push({ playerId, inventory }),
    });
    room.addPlayer("p1", "Alice", { ...emptyInventory(), bandage: 1 }, 50);

    room.useBandage("p1", "req-1");

    expect(healthCalls).toEqual([{ playerId: "p1", health: 50 + BANDAGE_HEAL_AMOUNT }]);
    expect(inventoryCalls).toHaveLength(1);
    expect(inventoryCalls[0]!.inventory.bandage).toBe(0);
  });
});

describe("health persistence through the real server and a restart", () => {
  let server: TestServer;

  afterEach(async () => {
    await server?.close();
  });

  it("a player.respawn through the wire persists health, and it survives a full server restart", async () => {
    server = await startTestServer({ roomCode: "TEST", reconnectGraceMs: 60_000 });

    // Simulate "joined once already, died, and the server restarted" by
    // seeding a players row at 0 health before this identity's first join
    // on this server instance — loadPlayerHealth will hand that back to
    // addPlayer exactly as a real reconnect-after-death would.
    const deadPlayerId = "dddddddd-0000-0000-0000-000000000000";
    touchPlayerRecord(server.db, deadPlayerId, "Alice");
    persistPlayerHealth(server.db, deadPlayerId, 0);

    const cookieValue = mintCookieForId(server, deadPlayerId);
    const client = new TestClient(server.wsUrl, cookieValue);
    const joined = await client.join("Alice", "TEST");
    expect(joined.playerId).toBe(deadPlayerId);

    const snapshot = await client.waitFor((m) => m.type === "world.snapshot");
    const me = snapshot.players.find((p: any) => p.id === deadPlayerId);
    expect(me.alive).toBe(false);
    expect(me.health).toBe(0);

    client.send({ type: "player.respawn", requestId: "respawn-1" });
    const result = await client.waitFor((m) => m.requestId === "respawn-1");
    expect(result.ok).toBe(true);
    expect(result.health).toBe(MAX_HEALTH);

    const persisted = loadPlayerHealth(server.db, deadPlayerId);
    expect(persisted).toBe(MAX_HEALTH);

    client.close();

    const dir = server.dir;
    await server.close({ keepData: true });
    const restarted = await startTestServer({ roomCode: "TEST", dbDir: dir });
    const restoredHealth = loadPlayerHealth(restarted.db, deadPlayerId);
    expect(restoredHealth).toBe(MAX_HEALTH);
    server = restarted;
  });
});
