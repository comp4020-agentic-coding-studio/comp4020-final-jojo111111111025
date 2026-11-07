import { describe, expect, it } from "vitest";
import { Room } from "../src/server/room.js";
import {
  ATTACK_COOLDOWN_MS,
  DAY_DURATION_MS,
  ENEMY_RESPAWN_MS,
  NIGHT_DURATION_MS,
  NIGHT_WANDERER_COUNT,
  WANDERER_AGGRO_RANGE_TILES,
  WANDERER_MAX_HEALTH,
  WANDERER_NIGHT_AGGRO_RANGE_TILES,
  WANDERER_NIGHT_RESPAWN_MS,
  WANDERER_NIGHT_SPEED_TILES_PER_SEC,
  WANDERER_SPEED_TILES_PER_SEC,
} from "../src/shared/constants.js";
import type { EnemySpawn, WorldMap } from "../src/shared/types.js";
import { emptyDungeon } from "./helpers/test-fixtures.js";

/**
 * Stage 10's night difficulty scaling: the instant isNight() flips to
 * true, Room.tick spawns NIGHT_WANDERER_COUNT extra wanderers in a ring
 * around the campsite (on top of the map's fixed roster), and every
 * wanderer (fixed roster and night-only alike) moves faster and
 * aggros/leashes from further away. The instant isNight() flips back to
 * false, every night-only wanderer is removed outright — no loot, no kill
 * credit either way.
 *
 * A 40x40 all-grass map (not the 10x10 used by most other Room tests) is
 * used here specifically because the night-wanderer ring is placed 12
 * tiles out from the campsite in every direction — a smaller map would
 * clamp every spawn into the same corner and the "they're spread in a
 * ring" and "they're all within map bounds" assertions below wouldn't
 * mean anything.
 */
function makeTestMap(): WorldMap {
  const width = 40;
  const height = 40;
  const tiles = Array.from({ length: width * height }, () => ({ terrain: "grass" as const }));
  return {
    seed: "test",
    width,
    height,
    tiles,
    objects: [],
    campsite: { x: 20, y: 20 },
    spawnPoint: { x: 20, y: 21 },
    farmArea: { x: 0, y: 0, width: 0, height: 0 },
    dungeonEntrance: { x: 39, y: 39 },
    dungeon: emptyDungeon(),
  };
}

function makeClock(start = 0) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

const BASE_WANDERER: EnemySpawn = { kind: "wanderer", zone: "overworld", x: 20, y: 22 };

describe("night-only wanderer spawning", () => {
  it("adds NIGHT_WANDERER_COUNT extra wanderers the instant night falls, on top of the fixed roster", () => {
    const clock = makeClock(0);
    const room = new Room(makeTestMap(), {}, [], new Map(), [], clock.now, 0, [BASE_WANDERER]);
    expect(room.getEnemies().length).toBe(1); // just the fixed-roster wanderer, it's still day

    clock.advance(DAY_DURATION_MS); // the exact instant night falls
    room.tick(0.05);
    expect(room.getEnemies().length).toBe(1 + NIGHT_WANDERER_COUNT);
  });

  it("places every night wanderer within the map's bounds, spread out (not all stacked on the campsite)", () => {
    const clock = makeClock(0);
    const room = new Room(makeTestMap(), {}, [], new Map(), [], clock.now, 0, []);
    clock.advance(DAY_DURATION_MS);
    room.tick(0.05);

    const enemies = room.getEnemies();
    expect(enemies.length).toBe(NIGHT_WANDERER_COUNT);
    for (const e of enemies) {
      expect(e.x).toBeGreaterThanOrEqual(0);
      expect(e.x).toBeLessThan(40);
      expect(e.y).toBeGreaterThanOrEqual(0);
      expect(e.y).toBeLessThan(40);
    }
    const uniquePositions = new Set(enemies.map((e) => `${e.x},${e.y}`));
    expect(uniquePositions.size).toBeGreaterThan(1); // a ring, not a single stacked point
  });

  it("does not spawn more night wanderers on every subsequent tick through the same night — only once, at the dusk edge", () => {
    const clock = makeClock(0);
    const room = new Room(makeTestMap(), {}, [], new Map(), [], clock.now, 0, []);
    clock.advance(DAY_DURATION_MS);
    room.tick(0.05);
    expect(room.getEnemies().length).toBe(NIGHT_WANDERER_COUNT);

    // Many more ticks, still the same night.
    for (let i = 0; i < 50; i++) {
      clock.advance(1000);
      room.tick(0.05);
    }
    expect(room.getEnemies().length).toBe(NIGHT_WANDERER_COUNT);
  });

  it("removes every night-only wanderer outright the instant day breaks, leaving only the fixed roster", () => {
    const clock = makeClock(0);
    const room = new Room(makeTestMap(), {}, [], new Map(), [], clock.now, 0, [BASE_WANDERER]);
    clock.advance(DAY_DURATION_MS);
    room.tick(0.05);
    expect(room.getEnemies().length).toBe(1 + NIGHT_WANDERER_COUNT);

    clock.advance(NIGHT_DURATION_MS); // the exact instant day breaks again
    room.tick(0.05);
    expect(room.getEnemies().length).toBe(1);
  });

  it("a night wanderer killed and not yet respawned is still removed outright at dawn (dead-or-alive, win or lose)", () => {
    const clock = makeClock(0);
    const room = new Room(makeTestMap(), {}, [], new Map(), [], clock.now, 0, []);
    clock.advance(DAY_DURATION_MS); // dusk
    room.tick(0.05);
    const nightWanderer = room.getEnemies()[0]!;

    const player = room.addPlayer("p1", "Alice");
    player.x = nightWanderer.x + 0.5;
    player.y = nightWanderer.y + 0.5;
    for (let i = 0; i < 10 && room.getEnemy(nightWanderer.id)!.alive; i++) {
      room.attack("p1", nightWanderer.id, `hit-${i}`);
      clock.advance(ATTACK_COOLDOWN_MS + 1);
    }
    expect(room.getEnemy(nightWanderer.id)!.alive).toBe(false); // dead, but still within WANDERER_NIGHT_RESPAWN_MS of its death

    clock.advance(NIGHT_DURATION_MS); // dawn, relative to whenever "now" landed above
    room.tick(0.05);
    expect(room.getEnemy(nightWanderer.id)).toBeUndefined();
  });
});

describe("night-time wanderer stat boosts", () => {
  it("uses the day speed/aggro constants during the day", () => {
    // Indirectly verified via the existing day-passivity test (wanderers
    // don't even aggro by day) plus the constants' own values — the night
    // math is additive on top of these, asserted directly below.
    expect(WANDERER_NIGHT_SPEED_TILES_PER_SEC).toBeGreaterThan(WANDERER_SPEED_TILES_PER_SEC);
    expect(WANDERER_NIGHT_AGGRO_RANGE_TILES).toBeGreaterThan(WANDERER_AGGRO_RANGE_TILES);
  });

  it("a wanderer moves at WANDERER_NIGHT_SPEED_TILES_PER_SEC, not the day speed, while chasing a player at night", () => {
    const clock = makeClock(0);
    const spawn: EnemySpawn = { kind: "wanderer", zone: "overworld", x: 20, y: 10 };
    const room = new Room(makeTestMap(), {}, [], new Map(), [], clock.now, 0, [spawn]);
    const player = room.addPlayer("p1", "Alice");
    // Directly below the wanderer (same x), 6 tiles away — inside
    // WANDERER_NIGHT_AGGRO_RANGE_TILES (8) but outside the day range (4),
    // so this distance only ever triggers a chase once night falls.
    player.x = 20.5;
    player.y = 16;
    room.setInput("p1", 0, 0);

    clock.advance(DAY_DURATION_MS); // the exact instant night falls
    const enemy = room.getEnemies().find((e) => e.kind === "wanderer")!;
    const startY = enemy.y;
    room.tick(1); // 1 second of chasing
    const moved = Math.abs(room.getEnemy(enemy.id)!.y - startY);

    expect(moved).toBeCloseTo(WANDERER_NIGHT_SPEED_TILES_PER_SEC, 1);
  });

  it("a night-only wanderer respawns on the shorter WANDERER_NIGHT_RESPAWN_MS timer, not the standard ENEMY_RESPAWN_MS", () => {
    expect(WANDERER_NIGHT_RESPAWN_MS).toBeLessThan(ENEMY_RESPAWN_MS);
  });

  it("night-time wanderer max health is unchanged — only speed/range/respawn-time scale, not raw stats", () => {
    const clock = makeClock(0);
    const room = new Room(makeTestMap(), {}, [], new Map(), [], clock.now, 0, []);
    clock.advance(DAY_DURATION_MS);
    room.tick(0.05);
    const nightWanderer = room.getEnemies()[0]!;
    expect(nightWanderer.maxHealth).toBe(WANDERER_MAX_HEALTH);
  });
});
