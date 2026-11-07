import { describe, expect, it } from "vitest";
import { TERRAIN_SPRITES } from "../src/client/sprites.js";
import { SOLID_TERRAIN, type TerrainKind } from "../src/shared/types.js";

/**
 * Pure data-shape checks for the sprite manifest — no DOM/Image loading
 * involved (that needs a real browser; jsdom has no image decoder, so it
 * can't meaningfully exercise loadSprites()/getImage() and isn't used
 * here). What's checkable without a browser: every sprite rect has sane
 * dimensions, and every TerrainKind this game actually places tiles for has
 * a sprite or a documented reason it doesn't.
 */
describe("TERRAIN_SPRITES manifest", () => {
  it("every sprite rect has positive, pixel-grid-aligned dimensions", () => {
    for (const [terrain, rect] of Object.entries(TERRAIN_SPRITES)) {
      expect(rect!.w, `${terrain}'s sprite width`).toBeGreaterThan(0);
      expect(rect!.h, `${terrain}'s sprite height`).toBeGreaterThan(0);
      expect(rect!.x, `${terrain}'s sprite x`).toBeGreaterThanOrEqual(0);
      expect(rect!.y, `${terrain}'s sprite y`).toBeGreaterThanOrEqual(0);
    }
  });

  it("has a sprite for every solid dungeon terrain kind", () => {
    // dungeon_wall must have a sprite — it's the one SOLID_TERRAIN addition
    // this integration made, and it would be a silent visual regression
    // (falls back to a flat fillRect) if a future change to sprites.ts
    // accidentally dropped it.
    expect(TERRAIN_SPRITES.dungeon_wall).toBeDefined();
    expect(TERRAIN_SPRITES.dungeon_floor).toBeDefined();
  });

  it("has a sprite for every TerrainKind — Stage 5 gave water its own sprite, closing the one remaining gap from Stage 1", () => {
    const kinds: TerrainKind[] = ["grass", "forest", "water", "rock", "dungeon_floor", "dungeon_wall"];
    for (const kind of kinds) {
      expect(TERRAIN_SPRITES[kind], `${kind}'s sprite`).toBeDefined();
    }
  });

  it("water's sprite matches the exact verified coordinates and source sheet from Stage 5's asset inspection", () => {
    expect(TERRAIN_SPRITES.water).toEqual({ sheet: "serene-village", x: 224, y: 224, w: 16, h: 16 });
  });

  it("grass's sprite matches the exact verified coordinates and source sheet from Stage 5's asset inspection", () => {
    expect(TERRAIN_SPRITES.grass).toEqual({ sheet: "serene-village", x: 48, y: 0, w: 16, h: 16 });
  });

  it("dungeon_wall is the only sprite taller than one tile grid cell (16px) — the anchor logic in drawTile only needs to handle this one case today", () => {
    const tallSprites = Object.entries(TERRAIN_SPRITES).filter(([, rect]) => rect!.h > 16);
    expect(tallSprites.map(([terrain]) => terrain)).toEqual(["dungeon_wall"]);
  });

  it("every terrain in SOLID_TERRAIN that has a sprite uses that sprite consistently (sanity check against a future terrain rename)", () => {
    for (const terrain of SOLID_TERRAIN) {
      if (terrain in TERRAIN_SPRITES) {
        expect(TERRAIN_SPRITES[terrain]).toBeDefined();
      }
    }
  });
});
