import { describe, expect, it } from "vitest";
import { BUILDING_SPRITES } from "../src/client/sprites.js";
import { SOLID_BUILDINGS } from "../src/shared/types.js";

/**
 * Pure data-shape checks for the building sprite manifest — same approach
 * as spec/object-sprites.spec.ts for OBJECT_SPRITES: no DOM/Image loading
 * (jsdom has no image decoder), just the manifest's own shape and the
 * deliberate per-kind coverage decisions from the "real pictures" asset
 * pass.
 */
describe("BUILDING_SPRITES manifest", () => {
  it("every sprite rect has positive, non-negative-origin dimensions", () => {
    for (const [kind, rect] of Object.entries(BUILDING_SPRITES)) {
      expect(rect!.w, `${kind}'s sprite width`).toBeGreaterThan(0);
      expect(rect!.h, `${kind}'s sprite height`).toBeGreaterThan(0);
      expect(rect!.x, `${kind}'s sprite x`).toBeGreaterThanOrEqual(0);
      expect(rect!.y, `${kind}'s sprite y`).toBeGreaterThanOrEqual(0);
    }
  });

  it("has a sprite for every placeable BuildingKind except campfire (which reuses OBJECT_SPRITES.campfire — see render.ts's drawBuilding)", () => {
    expect(BUILDING_SPRITES.chest).toBeDefined();
    expect(BUILDING_SPRITES.wall).toBeDefined();
    expect(BUILDING_SPRITES.workbench).toBeDefined();
    expect(BUILDING_SPRITES.floor).toBeDefined();
    expect(BUILDING_SPRITES.campfire).toBeUndefined();
  });

  it("matches the exact verified coordinates and source sheets found during asset inspection", () => {
    expect(BUILDING_SPRITES.chest).toEqual({ sheet: "dungeon", x: 32, y: 307, w: 16, h: 13 });
    expect(BUILDING_SPRITES.wall).toEqual({ sheet: "forest", x: 464, y: 304, w: 36, h: 31 });
    expect(BUILDING_SPRITES.workbench).toEqual({ sheet: "dungeon", x: 2, y: 305, w: 12, h: 15 });
    expect(BUILDING_SPRITES.floor).toEqual({ sheet: "forest", x: 496, y: 304, w: 32, h: 16 });
  });

  it("no sprite's kind was added to SOLID_BUILDINGS or otherwise changes collision (sprite-table additions are visual-only)", () => {
    expect(SOLID_BUILDINGS.has("wall")).toBe(true); // unchanged
    expect(SOLID_BUILDINGS.has("workbench")).toBe(true); // unchanged
    expect(SOLID_BUILDINGS.has("chest")).toBe(true); // unchanged
    expect(SOLID_BUILDINGS.has("floor")).toBe(false); // unchanged — floor was never solid
  });
});
