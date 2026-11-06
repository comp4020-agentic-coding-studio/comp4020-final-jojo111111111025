import { describe, expect, it } from "vitest";
import { OBJECT_SPRITES } from "../src/client/sprites.js";
import { SOLID_OBJECTS } from "../src/shared/types.js";

/**
 * Pure data-shape checks for the object sprite manifest — same approach as
 * spec/sprites.spec.ts for TERRAIN_SPRITES: no DOM/Image loading (jsdom has
 * no image decoder), just the manifest's own shape and the deliberate
 * per-kind coverage decisions from Stage 2's asset inspection.
 */
describe("OBJECT_SPRITES manifest", () => {
  it("every sprite rect has positive, non-negative-origin dimensions", () => {
    for (const [kind, rect] of Object.entries(OBJECT_SPRITES)) {
      expect(rect!.w, `${kind}'s sprite width`).toBeGreaterThan(0);
      expect(rect!.h, `${kind}'s sprite height`).toBeGreaterThan(0);
      expect(rect!.x, `${kind}'s sprite x`).toBeGreaterThanOrEqual(0);
      expect(rect!.y, `${kind}'s sprite y`).toBeGreaterThanOrEqual(0);
    }
  });

  it("has a sprite for the four kinds confirmed to have a genuine visual match", () => {
    expect(OBJECT_SPRITES.campfire).toBeDefined();
    expect(OBJECT_SPRITES.ancient_beacon).toBeDefined();
    expect(OBJECT_SPRITES.dungeon_entrance).toBeDefined();
    expect(OBJECT_SPRITES.dungeon_exit).toBeDefined();
  });

  it("documents tree, rock, and bush as having no sprite (render.ts's flat-colour fallback is intentional, not an oversight — see sprites.ts's doc-comment and PROCESS.md)", () => {
    expect(OBJECT_SPRITES.tree).toBeUndefined();
    expect(OBJECT_SPRITES.rock).toBeUndefined();
    expect(OBJECT_SPRITES.bush).toBeUndefined();
  });

  it("every sprite taller than one tile grid cell (16px) is exactly 32px (2 tile-rows) — drawObject's bottom-anchor math assumes a whole-tile-multiple height", () => {
    for (const [kind, rect] of Object.entries(OBJECT_SPRITES)) {
      if (rect!.h > 16) expect(rect!.h, `${kind}'s sprite height`).toBe(32);
    }
  });

  it("no sprite's kind was added to SOLID_OBJECTS or otherwise changes collision (Stage 2 is visual-only)", () => {
    // This asserts the inverse of what Stage 1 checked for terrain: Stage 2
    // must NOT touch SOLID_OBJECTS membership for any kind it draws a
    // sprite for. A kind having a sprite says nothing about whether it's
    // solid — that's room.ts's decision alone, unchanged by this stage.
    expect(SOLID_OBJECTS.has("campfire")).toBe(true); // unchanged from before Stage 2
    expect(SOLID_OBJECTS.has("ancient_beacon")).toBe(true); // unchanged from before Stage 2
    expect(SOLID_OBJECTS.has("dungeon_entrance")).toBe(false); // unchanged from before Stage 2
    expect(SOLID_OBJECTS.has("dungeon_exit")).toBe(false); // unchanged from before Stage 2
  });
});
