import { describe, expect, it } from "vitest";
import { Room } from "../src/server/room.js";
import {
  ATTACK_COOLDOWN_MS,
  BASE_ATTACK_DAMAGE,
  ENEMY_RESPAWN_MS,
  SWORD_BONUS_DAMAGE,
  WANDERER_MAX_HEALTH,
} from "../src/shared/constants.js";
import type { EnemySpawn, WorldMap } from "../src/shared/types.js";
import { emptyDungeon } from "./helpers/test-fixtures.js";

function makeTestMap(): WorldMap {
  const width = 10;
  const height = 10;
  const tiles = Array.from({ length: width * height }, () => ({ terrain: "grass" as const }));
  return {
    seed: "test",
    width,
    height,
    tiles,
    objects: [{ id: "entrance-1", kind: "dungeon_entrance", x: 1, y: 2, zone: "overworld" }],
    campsite: { x: 1, y: 1 },
    spawnPoint: { x: 1, y: 1 },
    farmArea: { x: 0, y: 0, width: 0, height: 0 },
    dungeonEntrance: { x: 1, y: 2 },
    dungeon: emptyDungeon(),
  };
}

/** Moves a player from the overworld into the dungeon via the test map's entrance object, for tests that need a dungeon-side player. */
function sendToDungeon(room: Room, playerId: string): void {
  const result = room.enterZone(playerId, "entrance-1", "dungeon", `enter-${playerId}`);
  if (!result.ok) throw new Error(`sendToDungeon failed: ${result.reason}`);
}

function makeClock(start = 0) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

const WANDERER_SPAWN: EnemySpawn = { kind: "wanderer", zone: "overworld", x: 2, y: 1 };
const GUARDIAN_SPAWN: EnemySpawn = { kind: "guardian", zone: "dungeon", x: 2, y: 1 };

describe("Room.attack — validation", () => {
  it("rejects an attack from an unknown player", () => {
    const room = new Room(makeTestMap(), {}, [], new Map(), [], Date.now, Date.now(), [WANDERER_SPAWN]);
    const [enemy] = room.getEnemies();
    const result = room.attack("ghost", enemy!.id, "r1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unknown_player");
  });

  it("rejects an attack from a dead player", () => {
    const room = new Room(makeTestMap(), {}, [], new Map(), [], Date.now, Date.now(), [WANDERER_SPAWN]);
    room.addPlayer("p1", "Alice", undefined, 0);
    const [enemy] = room.getEnemies();
    const result = room.attack("p1", enemy!.id, "r1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("dead");
  });

  it("rejects an attack on an unknown target", () => {
    const room = new Room(makeTestMap());
    room.addPlayer("p1", "Alice");
    const result = room.attack("p1", "does-not-exist", "r1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unknown_target");
  });

  it("rejects an attack on a target in a different zone", () => {
    const room = new Room(makeTestMap(), {}, [], new Map(), [], Date.now, Date.now(), [GUARDIAN_SPAWN]);
    room.addPlayer("p1", "Alice"); // starts in overworld
    const [enemy] = room.getEnemies(); // guardian is in the dungeon
    const result = room.attack("p1", enemy!.id, "r1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("wrong_zone");
  });

  it("rejects an attack beyond ATTACK_RANGE_TILES", () => {
    const map = makeTestMap();
    const farSpawn: EnemySpawn = { kind: "wanderer", zone: "overworld", x: 8, y: 8 };
    const room = new Room(map, {}, [], new Map(), [], Date.now, Date.now(), [farSpawn]);
    room.addPlayer("p1", "Alice"); // spawns near (1.5, 1.5), far from (8, 8)
    const [enemy] = room.getEnemies();
    const result = room.attack("p1", enemy!.id, "r1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("too_far");
  });

  it("rejects a second attack inside ATTACK_COOLDOWN_MS, then allows one after cooldown", () => {
    const clock = makeClock();
    const closeSpawn: EnemySpawn = { kind: "wanderer", zone: "overworld", x: 1, y: 1 };
    const room = new Room(makeTestMap(), {}, [], new Map(), [], clock.now, clock.now(), [closeSpawn]);
    room.addPlayer("p1", "Alice");
    const [enemy] = room.getEnemies();

    const first = room.attack("p1", enemy!.id, "r1");
    expect(first.ok).toBe(true);

    const second = room.attack("p1", enemy!.id, "r2");
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("on_cooldown");

    clock.advance(ATTACK_COOLDOWN_MS + 1);
    const third = room.attack("p1", enemy!.id, "r3");
    expect(third.ok).toBe(true);
  });

  it("rejects an attack on an already-dead target", () => {
    const closeSpawn: EnemySpawn = { kind: "wanderer", zone: "overworld", x: 1, y: 1 }; // 30 HP
    const clock = makeClock();
    const room = new Room(makeTestMap(), {}, [], new Map(), [], clock.now, clock.now(), [closeSpawn]);
    room.addPlayer("p1", "Alice");
    const [enemy] = room.getEnemies();

    // Base damage 10 — three hits (with cooldown advanced between each) kill it.
    for (let i = 0; i < 5 && room.getEnemy(enemy!.id)!.alive; i++) {
      room.attack("p1", enemy!.id, `hit-${i}`);
      clock.advance(ATTACK_COOLDOWN_MS + 1);
    }
    expect(room.getEnemy(enemy!.id)!.alive).toBe(false);

    const afterDeath = room.attack("p1", enemy!.id, "post-death");
    expect(afterDeath.ok).toBe(false);
    expect(afterDeath.reason).toBe("already_dead");
  });
});

describe("Room.attack — damage and death", () => {
  it("applies BASE_ATTACK_DAMAGE without a sword", () => {
    const closeSpawn: EnemySpawn = { kind: "wanderer", zone: "overworld", x: 1, y: 1 };
    const room = new Room(makeTestMap(), {}, [], new Map(), [], Date.now, Date.now(), [closeSpawn]);
    room.addPlayer("p1", "Alice");
    const [enemy] = room.getEnemies();
    const result = room.attack("p1", enemy!.id, "r1");
    expect(result.ok).toBe(true);
    expect(result.damageDealt).toBe(BASE_ATTACK_DAMAGE);
    expect(result.enemyHealth).toBe(enemy!.maxHealth - BASE_ATTACK_DAMAGE);
  });

  it("applies BASE_ATTACK_DAMAGE + SWORD_BONUS_DAMAGE when the attacker holds a sword", () => {
    const closeSpawn: EnemySpawn = { kind: "wanderer", zone: "overworld", x: 1, y: 1 };
    const room = new Room(makeTestMap(), {}, [], new Map(), [], Date.now, Date.now(), [closeSpawn]);
    const inventory = { wood: 0, stone: 0, berries: 0, seed_berry: 0, axe: 0, pickaxe: 0, sword: 1, bandage: 0, ancient_core: 0 };
    room.addPlayer("p1", "Alice", inventory);
    const [enemy] = room.getEnemies();
    const result = room.attack("p1", enemy!.id, "r1");
    expect(result.ok).toBe(true);
    expect(result.damageDealt).toBe(BASE_ATTACK_DAMAGE + SWORD_BONUS_DAMAGE);
  });

  it("marks an enemy dead exactly when its health reaches 0, and never goes negative", () => {
    const clock = makeClock();
    const closeSpawn: EnemySpawn = { kind: "wanderer", zone: "overworld", x: 1, y: 1 }; // 30 HP
    const room = new Room(makeTestMap(), {}, [], new Map(), [], clock.now, clock.now(), [closeSpawn]);
    room.addPlayer("p1", "Alice");
    const [enemy] = room.getEnemies();

    const r1 = room.attack("p1", enemy!.id, "h1"); // 30 -> 20
    expect(r1.enemyDied).toBe(false);
    clock.advance(ATTACK_COOLDOWN_MS + 1);
    const r2 = room.attack("p1", enemy!.id, "h2"); // 20 -> 10
    expect(r2.enemyDied).toBe(false);
    clock.advance(ATTACK_COOLDOWN_MS + 1);
    const r3 = room.attack("p1", enemy!.id, "h3"); // 10 -> 0
    expect(r3.ok).toBe(true);
    expect(r3.enemyHealth).toBe(0);
    expect(r3.enemyDied).toBe(true);
    expect(room.getEnemy(enemy!.id)!.alive).toBe(false);
  });

  it("grants exactly one ancient_core per contributor when the boss dies, never more on a redundant death call", () => {
    const clock = makeClock();
    let bossDefeatedCalls = 0;
    // BOSS_MAX_HEALTH is 300 and BASE_ATTACK_DAMAGE is 10, so 30 hits kill it
    // — too slow for a unit test. Scale this down by building the Room with
    // a boss spawn and manually draining health via repeated attacks using a
    // bandage-free inventory isn't practical either, so instead this test
    // directly drives enough attacks (with cooldown advances) to reach 0.
    const room = new Room(
      makeTestMap(),
      { bossDefeated: () => (bossDefeatedCalls++ === 0 ? true : false) },
      [],
      new Map(),
      [],
      clock.now,
      clock.now(),
      [{ kind: "boss", zone: "dungeon", x: 1, y: 1 }],
    );
    room.addPlayer("p1", "Alice");
    room.addPlayer("p2", "Bob");
    sendToDungeon(room, "p1");
    sendToDungeon(room, "p2");

    const [boss] = room.getEnemies();
    expect(boss!.zone).toBe("dungeon");

    let died = false;
    for (let i = 0; i < 40 && !died; i++) {
      const attacker = i % 2 === 0 ? "p1" : "p2";
      const result = room.attack(attacker, boss!.id, `hit-${i}`);
      if (result.enemyDied) died = true;
      clock.advance(ATTACK_COOLDOWN_MS + 1);
    }
    expect(died).toBe(true);
    expect(bossDefeatedCalls).toBe(1);

    const alice = room.getPlayer("p1")!;
    const bob = room.getPlayer("p2")!;
    expect(alice.inventory.ancient_core).toBe(1);
    expect(bob.inventory.ancient_core).toBe(1);

    // A redundant death-handling call never re-grants loot — attacking the
    // (already dead) boss again is rejected before handleEnemyDeath could
    // run a second time.
    const afterDeath = room.attack("p1", boss!.id, "post-death");
    expect(afterDeath.ok).toBe(false);
    expect(afterDeath.reason).toBe("already_dead");
    expect(room.getPlayer("p1")!.inventory.ancient_core).toBe(1);

    // Regression: killing the boss must flip this Room's own in-memory
    // bossAlreadyDefeated immediately, not only the persisted DB row — a
    // player should be able to deposit/activate the beacon in the same
    // running session a boss kill happens in, without needing a restart to
    // pick the DB's value back up.
    expect(room.getBeaconProgress().bossDefeated).toBe(true);
  });

  it("queues a durable pending reward (never a direct inventory grant) for a contributor evicted before the kill lands", () => {
    const clock = makeClock();
    const pendingGrants: Array<{ playerId: string; kind: string; qty: number; reason: string }> = [];
    const room = new Room(
      makeTestMap(),
      { grantPendingReward: (playerId, kind, qty, reason) => pendingGrants.push({ playerId, kind, qty, reason }) },
      [],
      new Map(),
      [],
      clock.now,
      clock.now(),
      [{ kind: "boss", zone: "dungeon", x: 1, y: 1 }],
    );
    room.addPlayer("p1", "Alice");
    room.addPlayer("p2", "Bob");
    sendToDungeon(room, "p1");
    sendToDungeon(room, "p2");

    const [boss] = room.getEnemies();
    // Both land a hit (both become contributors)...
    room.attack("p1", boss!.id, "hit-0");
    clock.advance(ATTACK_COOLDOWN_MS + 1);
    room.attack("p2", boss!.id, "hit-1");
    clock.advance(ATTACK_COOLDOWN_MS + 1);

    // ...then p2 disconnects and is evicted (simulating a lapsed grace
    // window) before the boss actually dies.
    room.removePlayer("p2");

    let died = false;
    for (let i = 2; i < 40 && !died; i++) {
      const result = room.attack("p1", boss!.id, `hit-${i}`);
      if (result.enemyDied) died = true;
      clock.advance(ATTACK_COOLDOWN_MS + 1);
    }
    expect(died).toBe(true);

    // p1 (still present) gets the reward directly, same as before.
    expect(room.getPlayer("p1")!.inventory.ancient_core).toBe(1);
    // p2 (evicted) never had anything added to an inventory that no longer
    // exists in this Room — instead, exactly one pending-reward grant was
    // queued for their stable identity.
    expect(room.hasPlayer("p2")).toBe(false);
    expect(pendingGrants).toEqual([{ playerId: "p2", kind: "ancient_core", qty: 1, reason: "boss_kill" }]);
  });
});

describe("Room.attack — dedupe", () => {
  it("returns the cached result for a repeated requestId instead of re-applying damage", () => {
    const closeSpawn: EnemySpawn = { kind: "wanderer", zone: "overworld", x: 1, y: 1 };
    const room = new Room(makeTestMap(), {}, [], new Map(), [], Date.now, Date.now(), [closeSpawn]);
    room.addPlayer("p1", "Alice");
    const [enemy] = room.getEnemies();

    const first = room.attack("p1", enemy!.id, "dup-1");
    const second = room.attack("p1", enemy!.id, "dup-1");
    expect(second).toEqual(first);
    // Only one hit's worth of damage was actually applied.
    expect(room.getEnemy(enemy!.id)!.health).toBe(enemy!.maxHealth - BASE_ATTACK_DAMAGE);
  });
});

describe("trash-enemy respawn — driven by the injected clock, not a real timer", () => {
  /** Kills the enemy with however many hits it takes (up to BOSS_MAX_HEALTH / BASE_ATTACK_DAMAGE = 30), advancing the clock past ATTACK_COOLDOWN_MS between each. */
  function killEnemy(room: Room, clock: ReturnType<typeof makeClock>, playerId: string, enemyId: string): void {
    for (let i = 0; i < 40 && room.getEnemy(enemyId)!.alive; i++) {
      room.attack(playerId, enemyId, `hit-${i}`);
      clock.advance(ATTACK_COOLDOWN_MS + 1);
    }
    expect(room.getEnemy(enemyId)!.alive).toBe(false);
  }

  it("does not respawn before ENEMY_RESPAWN_MS has elapsed on the injected clock, even across many ticks", () => {
    const clock = makeClock();
    const closeSpawn: EnemySpawn = { kind: "wanderer", zone: "overworld", x: 1, y: 1 };
    const room = new Room(makeTestMap(), {}, [], new Map(), [], clock.now, clock.now(), [closeSpawn]);
    room.addPlayer("p1", "Alice");
    const [enemy] = room.getEnemies();
    killEnemy(room, clock, "p1", enemy!.id);

    // Advance well past real-world "the setTimeout would have fired by now"
    // but short of ENEMY_RESPAWN_MS on the *injected* clock, ticking the room
    // many times along the way — a real setTimeout keyed to wall-clock time
    // would have fired long ago if this test takes any real time to run at
    // all; the respawnAt-based mechanism must not care.
    for (let i = 0; i < 50; i++) {
      clock.advance(ENEMY_RESPAWN_MS / 100);
      room.tick(0.05);
      if (clock.now() >= ENEMY_RESPAWN_MS) break;
    }
    expect(room.getEnemy(enemy!.id)!.alive).toBe(false);
  });

  it("respawns exactly at ENEMY_RESPAWN_MS on the injected clock, with full health and original position", () => {
    const clock = makeClock();
    const closeSpawn: EnemySpawn = { kind: "wanderer", zone: "overworld", x: 1, y: 1 };
    const room = new Room(makeTestMap(), {}, [], new Map(), [], clock.now, clock.now(), [closeSpawn]);
    room.addPlayer("p1", "Alice");
    const [enemy] = room.getEnemies();
    killEnemy(room, clock, "p1", enemy!.id);

    // handleEnemyDeath stamps respawnAt as (death time + ENEMY_RESPAWN_MS) on
    // the injected clock — read it back directly rather than re-deriving it,
    // so this test fails loudly if that invariant ever changes.
    const respawnAt = room.getEnemy(enemy!.id)!.respawnAt;
    expect(respawnAt).not.toBeNull();
    expect(respawnAt).toBeGreaterThan(clock.now()); // still in the future relative to "now" right after the kill

    // One tick just before the deadline: still dead.
    clock.advance(respawnAt! - clock.now() - 1);
    room.tick(0.05);
    expect(room.getEnemy(enemy!.id)!.alive).toBe(false);

    // Cross the deadline: respawns on the very next tick.
    clock.advance(2);
    room.tick(0.05);
    const respawned = room.getEnemy(enemy!.id)!;
    expect(respawned.alive).toBe(true);
    expect(respawned.health).toBe(WANDERER_MAX_HEALTH);
    expect(respawned.x).toBe(1);
    expect(respawned.y).toBe(1);
    expect(respawned.respawnAt).toBeNull();
  });

  it("a respawned enemy can be damaged and killed again (contact cooldown and state are fully reset)", () => {
    const clock = makeClock();
    const closeSpawn: EnemySpawn = { kind: "wanderer", zone: "overworld", x: 1, y: 1 };
    const room = new Room(makeTestMap(), {}, [], new Map(), [], clock.now, clock.now(), [closeSpawn]);
    room.addPlayer("p1", "Alice");
    const [enemy] = room.getEnemies();
    killEnemy(room, clock, "p1", enemy!.id);

    clock.advance(ENEMY_RESPAWN_MS + 1);
    room.tick(0.05);
    expect(room.getEnemy(enemy!.id)!.alive).toBe(true);

    killEnemy(room, clock, "p1", enemy!.id);
    expect(room.getEnemy(enemy!.id)!.alive).toBe(false);
  });

  it("the boss never gets a respawnAt and does not respawn (loot handling takes a different path)", () => {
    const clock = makeClock();
    const bossSpawn: EnemySpawn = { kind: "boss", zone: "dungeon", x: 1, y: 2 };
    const room = new Room(
      makeTestMap(),
      {},
      [],
      new Map(),
      [],
      clock.now,
      clock.now(),
      [bossSpawn],
    );
    room.addPlayer("p1", "Alice");
    sendToDungeon(room, "p1");
    const [boss] = room.getEnemies();
    killEnemy(room, clock, "p1", boss!.id);

    clock.advance(ENEMY_RESPAWN_MS * 10);
    room.tick(0.05);
    expect(room.getEnemy(boss!.id)!.alive).toBe(false);
  });
});
