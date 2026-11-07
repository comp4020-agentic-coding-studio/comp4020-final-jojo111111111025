import { describe, expect, it } from "vitest";
import { OBJECT_SPRITES } from "../src/client/sprites.js";
import { SOLID_OBJECTS } from "../src/shared/types.js";

/**
 * Pure data-shape checks for the object sprite manifest — same approach as
 * spec/sprites.spec.ts for TERRAIN_SPRITES: no DOM/Image loading (jsdom has
 * no image decoder), just the manifest's own shape and the deliberate
 * per-kind coverage decisions from Stage 2's and Stage 4's asset
 * inspections.
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

  it("has a sprite for the kinds confirmed to have a genuine visual match", () => {
    expect(OBJECT_SPRITES.campfire).toBeDefined();
    expect(OBJECT_SPRITES.bush).toBeDefined(); // added Stage 4 Phase B2
    expect(OBJECT_SPRITES.rock).toBeDefined(); // added in the "real pictures" pass (derived cutout — see sprites.ts)
  });

  it("documents tree as having no sprite (render.ts's flat-colour fallback is intentional, not an oversight — see sprites.ts's doc-comment and PROCESS.md)", () => {
    expect(OBJECT_SPRITES.tree).toBeUndefined();
  });

  it("every sprite taller than one tile grid cell (16px) was either exactly 32px, bush's 30px, or rock's 32px — drawObject's bottom-anchor formula (destY = y - (h - TILE_SIZE)) always lands a sprite's bottom edge on the cell's own bottom edge regardless of h, so this was never actually a constraint on h, just a coincidence of which sprites existed before bush", () => {
    for (const [kind, rect] of Object.entries(OBJECT_SPRITES)) {
      if (kind === "bush") continue; // the one sprite that is tall but not 32px — expected, not a gap
      if (rect!.h > 16) expect(rect!.h, `${kind}'s sprite height`).toBe(32);
    }
    expect(OBJECT_SPRITES.bush!.h).toBe(30);
  });

  it("bush matches the exact verified coordinates and source sheet from Stage 4's asset inspection", () => {
    expect(OBJECT_SPRITES.bush).toEqual({ sheet: "tiny-rpg-town", x: 3, y: 1, w: 25, h: 30 });
  });

  it("bush is wider than one tile grid cell (16px) — drawObject's horizontal-centring math exists specifically for this sprite", () => {
    expect(OBJECT_SPRITES.bush!.w).toBeGreaterThan(16);
  });

  it("rock matches the exact verified coordinates and derived-cutout sheet", () => {
    expect(OBJECT_SPRITES.rock).toEqual({ sheet: "mountain-cutouts", x: 0, y: 0, w: 32, h: 32 });
  });

  it("no sprite's kind was added to SOLID_OBJECTS or otherwise changes collision (sprite-table stages are visual-only)", () => {
    // This asserts the inverse of what Stage 1 checked for terrain: adding
    // a sprite must NOT touch SOLID_OBJECTS membership for any kind it
    // draws. A kind having a sprite says nothing about whether it's solid
    // — that's room.ts's decision alone, unchanged by any sprite-table
    // stage (Stage 2's four object sprites, Stage 4's bush, or rock).
    expect(SOLID_OBJECTS.has("campfire")).toBe(true); // unchanged from before Stage 2
    expect(SOLID_OBJECTS.has("bush")).toBe(false); // unchanged from before Stage 4
    expect(SOLID_OBJECTS.has("rock")).toBe(true); // unchanged — rock was already solid as a resource node
  });
});
