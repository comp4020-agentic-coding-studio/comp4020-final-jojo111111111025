import { describe, expect, it } from "vitest";
import { Room } from "../src/server/room.js";
import {
  ATTACK_COOLDOWN_MS,
  BASE_ATTACK_DAMAGE,
  DAY_DURATION_MS,
  GUARDIAN_SPEED_TILES_PER_SEC,
  SWORD_BONUS_DAMAGE,
  WANDERER_NIGHT_SPEED_MULTIPLIER,
  WANDERER_SPEED_TILES_PER_SEC,
} from "../src/shared/constants.js";
import type { EnemySpawn, WorldMap } from "../src/shared/types.js";
import { emptyInventory } from "../src/shared/types.js";

function makeTestMap(): WorldMap {
  const width = 10;
  const height = 10;
  const tiles = Array.from({ length: width * height }, () => ({ terrain: "grass" as const }));
  return {
    seed: "test",
    width,
    height,
    tiles,
    objects: [],
    campsite: { x: 1, y: 1 },
    spawnPoint: { x: 1, y: 1 },
  };
}

function makeClock(start = 0) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

const WANDERER_SPAWN: EnemySpawn = { kind: "wanderer", x: 2, y: 1 };

describe("Room.attack — validation", () => {
  it("rejects an attack from an unknown player", () => {
    const room = new Room(makeTestMap(), {}, [], new Map(), Date.now, Date.now(), [WANDERER_SPAWN]);
    const [enemy] = room.getEnemies();
    const result = room.attack("ghost", enemy!.id, "r1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unknown_player");
  });

  it("rejects an attack from a dead player", () => {
    const room = new Room(makeTestMap(), {}, [], new Map(), Date.now, Date.now(), [WANDERER_SPAWN]);
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

  it("rejects an attack beyond ATTACK_RANGE_TILES", () => {
    const map = makeTestMap();
    const farSpawn: EnemySpawn = { kind: "wanderer", x: 8, y: 8 };
    const room = new Room(map, {}, [], new Map(), Date.now, Date.now(), [farSpawn]);
    room.addPlayer("p1", "Alice"); // spawns near (1.5, 1.5), far from (8, 8)
    const [enemy] = room.getEnemies();
    const result = room.attack("p1", enemy!.id, "r1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("too_far");
  });

  it("rejects a second attack inside ATTACK_COOLDOWN_MS, then allows one after cooldown", () => {
    const clock = makeClock();
    const closeSpawn: EnemySpawn = { kind: "wanderer", x: 1, y: 1 };
    const room = new Room(makeTestMap(), {}, [], new Map(), clock.now, clock.now(), [closeSpawn]);
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
    const closeSpawn: EnemySpawn = { kind: "wanderer", x: 1, y: 1 }; // 30 HP
    const clock = makeClock();
    const room = new Room(makeTestMap(), {}, [], new Map(), clock.now, clock.now(), [closeSpawn]);
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
    const closeSpawn: EnemySpawn = { kind: "wanderer", x: 1, y: 1 };
    const room = new Room(makeTestMap(), {}, [], new Map(), Date.now, Date.now(), [closeSpawn]);
    room.addPlayer("p1", "Alice");
    const [enemy] = room.getEnemies();
    const result = room.attack("p1", enemy!.id, "r1");
    expect(result.ok).toBe(true);
    expect(result.damageDealt).toBe(BASE_ATTACK_DAMAGE);
    expect(result.enemyHealth).toBe(enemy!.maxHealth - BASE_ATTACK_DAMAGE);
  });

  it("applies BASE_ATTACK_DAMAGE + SWORD_BONUS_DAMAGE when the attacker holds a sword", () => {
    const closeSpawn: EnemySpawn = { kind: "wanderer", x: 1, y: 1 };
    const room = new Room(makeTestMap(), {}, [], new Map(), Date.now, Date.now(), [closeSpawn]);
    const inventory = { ...emptyInventory(), sword: 1 };
    room.addPlayer("p1", "Alice", inventory);
    const [enemy] = room.getEnemies();
    const result = room.attack("p1", enemy!.id, "r1");
    expect(result.ok).toBe(true);
    expect(result.damageDealt).toBe(BASE_ATTACK_DAMAGE + SWORD_BONUS_DAMAGE);
  });

  it("marks an enemy dead exactly when its health reaches 0, and never goes negative", () => {
    const clock = makeClock();
    const closeSpawn: EnemySpawn = { kind: "wanderer", x: 1, y: 1 }; // 30 HP
    const room = new Room(makeTestMap(), {}, [], new Map(), clock.now, clock.now(), [closeSpawn]);
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

  it("a dead enemy is never removed from getEnemy, but disappears from getEnemies (the alive-only wire view)", () => {
    const clock = makeClock();
    const closeSpawn: EnemySpawn = { kind: "wanderer", x: 1, y: 1 };
    const room = new Room(makeTestMap(), {}, [], new Map(), clock.now, clock.now(), [closeSpawn]);
    room.addPlayer("p1", "Alice");
    const [enemy] = room.getEnemies();
    for (let i = 0; i < 5 && room.getEnemy(enemy!.id)!.alive; i++) {
      room.attack("p1", enemy!.id, `hit-${i}`);
      clock.advance(ATTACK_COOLDOWN_MS + 1);
    }
    expect(room.getEnemy(enemy!.id)).toBeDefined();
    expect(room.getEnemies()).toHaveLength(0);
  });
});

describe("Room.attack — dedupe", () => {
  it("returns the cached result for a repeated requestId instead of re-applying damage", () => {
    const closeSpawn: EnemySpawn = { kind: "wanderer", x: 1, y: 1 };
    const room = new Room(makeTestMap(), {}, [], new Map(), Date.now, Date.now(), [closeSpawn]);
    room.addPlayer("p1", "Alice");
    const [enemy] = room.getEnemies();

    const first = room.attack("p1", enemy!.id, "dup-1");
    const second = room.attack("p1", enemy!.id, "dup-1");
    expect(second).toEqual(first);
    // Only one hit's worth of damage was actually applied.
    expect(room.getEnemy(enemy!.id)!.health).toBe(enemy!.maxHealth - BASE_ATTACK_DAMAGE);
  });
});

describe("Room.allEnemiesDefeated — the shared win condition", () => {
  function killEnemy(room: Room, clock: ReturnType<typeof makeClock>, playerId: string, enemyId: string): void {
    for (let i = 0; i < 40 && room.getEnemy(enemyId)!.alive; i++) {
      room.attack(playerId, enemyId, `hit-${i}`);
      clock.advance(ATTACK_COOLDOWN_MS + 1);
    }
    expect(room.getEnemy(enemyId)!.alive).toBe(false);
  }

  it("is false with a fresh, fully-alive roster", () => {
    const room = new Room(makeTestMap(), {}, [], new Map(), Date.now, Date.now(), [
      { kind: "wanderer", x: 1, y: 1 },
      { kind: "guardian", x: 2, y: 2 },
    ]);
    expect(room.allEnemiesDefeated()).toBe(false);
  });

  it("is false with zero enemies on the map (a bare test fixture is never auto-'won')", () => {
    const room = new Room(makeTestMap());
    expect(room.allEnemiesDefeated()).toBe(false);
  });

  it("is false while at least one enemy is still alive", () => {
    const clock = makeClock();
    const room = new Room(makeTestMap(), {}, [], new Map(), clock.now, clock.now(), [
      { kind: "wanderer", x: 1, y: 1 },
      { kind: "wanderer", x: 1, y: 1 },
    ]);
    room.addPlayer("p1", "Alice");
    const [first] = room.getEnemies();
    killEnemy(room, clock, "p1", first!.id);
    expect(room.allEnemiesDefeated()).toBe(false);
  });

  it("is true the instant the last enemy dies, and the killing attack's result says so", () => {
    const clock = makeClock();
    const room = new Room(makeTestMap(), {}, [], new Map(), clock.now, clock.now(), [{ kind: "wanderer", x: 1, y: 1 }]);
    room.addPlayer("p1", "Alice");
    const [enemy] = room.getEnemies();

    let killResult;
    for (let i = 0; i < 5 && room.getEnemy(enemy!.id)!.alive; i++) {
      killResult = room.attack("p1", enemy!.id, `hit-${i}`);
      clock.advance(ATTACK_COOLDOWN_MS + 1);
    }
    expect(room.allEnemiesDefeated()).toBe(true);
    expect(killResult!.allEnemiesDefeated).toBe(true);
  });

  it("a non-killing hit's result never sets allEnemiesDefeated, even when it's the only enemy left and still alive", () => {
    const clock = makeClock();
    const room = new Room(makeTestMap(), {}, [], new Map(), clock.now, clock.now(), [{ kind: "wanderer", x: 1, y: 1 }]);
    room.addPlayer("p1", "Alice");
    const [enemy] = room.getEnemies();
    const result = room.attack("p1", enemy!.id, "h1"); // 30 -> 20, still alive
    expect(result.enemyDied).toBe(false);
    expect(result.allEnemiesDefeated).toBeUndefined();
  });
});

describe("wanderer night speed", () => {
  // Spawned far enough from the player that it never reaches contact range
  // during the single tick measured, so the only thing changing between
  // runs is how far it moved toward its target.
  const farWanderer: EnemySpawn = { kind: "wanderer", x: 9, y: 1 };

  function distanceMovedInOneTick(enemySpawn: EnemySpawn, worldCreatedAt: number, nowAtTick: number): number {
    const room = new Room(makeTestMap(), {}, [], new Map(), () => nowAtTick, worldCreatedAt, [enemySpawn]);
    room.addPlayer("p1", "Alice"); // near spawn (1.5, 1.5) — draws the enemy toward it
    const before = room.getEnemies()[0]!;
    const startX = before.x;
    const startY = before.y;
    room.tick(1); // 1 real second of movement
    const after = room.getEnemies()[0]!;
    return Math.hypot(after.x - startX, after.y - startY);
  }

  it("moves at WANDERER_SPEED_TILES_PER_SEC during the day", () => {
    // worldCreatedAt = 0, now = 0 is the instant the world was created — day.
    const moved = distanceMovedInOneTick(farWanderer, 0, 0);
    expect(moved).toBeCloseTo(WANDERER_SPEED_TILES_PER_SEC, 5);
  });

  it("moves at WANDERER_SPEED_TILES_PER_SEC * WANDERER_NIGHT_SPEED_MULTIPLIER at night", () => {
    // now = DAY_DURATION_MS is the instant night falls (see daynight.spec.ts).
    const moved = distanceMovedInOneTick(farWanderer, 0, DAY_DURATION_MS);
    expect(moved).toBeCloseTo(WANDERER_SPEED_TILES_PER_SEC * WANDERER_NIGHT_SPEED_MULTIPLIER, 5);
  });

  it("a guardian's speed is unaffected by night", () => {
    const farGuardian: EnemySpawn = { kind: "guardian", x: 9, y: 1 };
    const dayMoved = distanceMovedInOneTick(farGuardian, 0, 0);
    const nightMoved = distanceMovedInOneTick(farGuardian, 0, DAY_DURATION_MS);
    expect(dayMoved).toBeCloseTo(GUARDIAN_SPEED_TILES_PER_SEC, 5);
    expect(nightMoved).toBeCloseTo(GUARDIAN_SPEED_TILES_PER_SEC, 5);
  });
});
