import { describe, expect, it } from "vitest";
import { ENEMY_SPRITES, PLAYER_SPRITES } from "../src/client/sprites.js";
import {
  BOSS_MAX_HEALTH,
  GUARDIAN_MAX_HEALTH,
  WANDERER_MAX_HEALTH,
} from "../src/shared/constants.js";
import type { EnemyKind } from "../src/shared/types.js";

/**
 * Pure data-shape checks for Stage 3's player/enemy sprite manifests — same
 * approach as spec/sprites.spec.ts and spec/object-sprites.spec.ts: no
 * DOM/Image loading (jsdom has no image decoder), just the manifests' own
 * shape and the deliberate per-kind choices from Stage 3's asset inspection.
 */
describe("PLAYER_SPRITES", () => {
  it("has positive, non-negative-origin dimensions", () => {
    expect(PLAYER_SPRITES.w).toBeGreaterThan(0);
    expect(PLAYER_SPRITES.h).toBeGreaterThan(0);
    expect(PLAYER_SPRITES.x).toBeGreaterThanOrEqual(0);
    expect(PLAYER_SPRITES.y).toBeGreaterThanOrEqual(0);
  });

  it("is the verified gray-armoured CHARACTERS cell — exact coordinates from the approved asset inspection, not a different cell in the same row", () => {
    expect(PLAYER_SPRITES).toEqual({ sheet: "dungeon", x: 0, y: 416, w: 16, h: 32 });
  });

  it("is taller than one tile grid cell (16px) and exactly 32px (2 tile-rows), matching the bottom-anchor math render.ts's player-draw code assumes", () => {
    expect(PLAYER_SPRITES.h).toBe(32);
  });
});

describe("ENEMY_SPRITES", () => {
  it("has a sprite for every EnemyKind — unlike OBJECT_SPRITES, there is no partial-coverage/fallback-by-design case for enemies", () => {
    const kinds: EnemyKind[] = ["wanderer", "guardian", "boss"];
    for (const kind of kinds) {
      expect(ENEMY_SPRITES[kind], `${kind}'s sprite`).toBeDefined();
    }
  });

  it("every sprite rect has positive, non-negative-origin dimensions", () => {
    for (const [kind, rect] of Object.entries(ENEMY_SPRITES)) {
      expect(rect.w, `${kind}'s sprite width`).toBeGreaterThan(0);
      expect(rect.h, `${kind}'s sprite height`).toBeGreaterThan(0);
      expect(rect.x, `${kind}'s sprite x`).toBeGreaterThanOrEqual(0);
      expect(rect.y, `${kind}'s sprite y`).toBeGreaterThanOrEqual(0);
    }
  });

  it("matches the exact verified coordinates from the approved asset inspection, one per enemy kind", () => {
    expect(ENEMY_SPRITES.wanderer).toEqual({ sheet: "dungeon", x: 48, y: 464, w: 16, h: 16 });
    expect(ENEMY_SPRITES.guardian).toEqual({ sheet: "dungeon", x: 208, y: 464, w: 16, h: 32 });
    expect(ENEMY_SPRITES.boss).toEqual({ sheet: "dungeon", x: 320, y: 464, w: 32, h: 32 });
  });

  it("sprite size increases with enemy tier (wanderer < guardian <= boss by max health), matching the game's own threat model rather than being picked arbitrarily", () => {
    // Not a claim that pixel area must track health linearly — just that the
    // chosen sprites don't contradict the kind they represent (a tougher
    // enemy isn't drawn smaller than a weaker one).
    expect(WANDERER_MAX_HEALTH).toBeLessThan(GUARDIAN_MAX_HEALTH);
    expect(GUARDIAN_MAX_HEALTH).toBeLessThan(BOSS_MAX_HEALTH);
    const area = (k: EnemyKind) => ENEMY_SPRITES[k].w * ENEMY_SPRITES[k].h;
    expect(area("wanderer")).toBeLessThan(area("guardian"));
    expect(area("guardian")).toBeLessThanOrEqual(area("boss"));
  });

  it("every sprite taller than one tile grid cell (16px) is exactly 32px (2 tile-rows) — drawEnemy's bottom-anchor math assumes a whole-tile-multiple height", () => {
    for (const [kind, rect] of Object.entries(ENEMY_SPRITES)) {
      if (rect.h > 16) expect(rect.h, `${kind}'s sprite height`).toBe(32);
    }
  });
});
