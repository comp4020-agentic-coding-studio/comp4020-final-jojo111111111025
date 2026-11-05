/**
 * Loads the game's sprite sheets and exposes a lookup from game concepts
 * (a TerrainKind, an ObjectKind, ...) to a source rect on one of those
 * sheets. This replaces render.ts's old flat-color lookup tables
 * (TERRAIN_COLORS etc.) one-for-one in shape — same `Record<string, X>`
 * idea, `X` is now a sprite rect instead of a hex string.
 *
 * Sheets are ansimuz's Tiny RPG Forest/Mountain (CC0) and Calciumtrice's
 * Dungeon Tileset (CC-BY 3.0) — see public/assets/CREDITS.md. Coordinates
 * below were found by decoding each PNG's raw pixels and scanning for
 * low-variance (flat-colour) 16x16 regions, then confirmed by visual crop,
 * not guessed from the sheet's thumbnail.
 */
import type { TerrainKind } from "../shared/types.js";

export interface SpriteRect {
  sheet: "forest" | "mountain" | "dungeon";
  x: number;
  y: number;
  w: number;
  h: number;
}

const SHEET_PATHS: Record<SpriteRect["sheet"], string> = {
  forest: "/assets/forest/tileset.png",
  mountain: "/assets/mountain/tileset.png",
  dungeon: "/assets/dungeon/tileset.png",
};

/**
 * One sprite per TerrainKind. `water` has no sprite in either approved
 * pack (neither ansimuz's forest/mountain nor Calciumtrice's dungeon
 * tileset includes open water) — render.ts keeps a flat-colour fallback
 * for it, same as before this integration.
 */
export const TERRAIN_SPRITES: Partial<Record<TerrainKind, SpriteRect>> = {
  // ansimuz forest tileset: a clean, unbordered grass tile.
  grass: { sheet: "forest", x: 384, y: 80, w: 16, h: 16 },
  // ansimuz forest tileset: the clean dirt/path tile, used for "forest" too
  // since the pack has only one plain ground colour — the tree objects
  // drawn on top are what visually distinguish the two biomes in-game, not
  // the ground tile itself.
  forest: { sheet: "forest", x: 208, y: 288, w: 16, h: 16 },
  // ansimuz mountain tileset: the one flat (non-cliff-face) grey tile,
  // used for the overworld's walkable rock/mountain biome.
  rock: { sheet: "mountain", x: 48, y: 16, w: 16, h: 16 },
  // Calciumtrice dungeon tileset: floor and wall. The wall sprite is
  // 16x32 (taller than the tile grid) by the author's own design — see
  // CREDITS.md. render.ts's drawTile bottom-anchors it to compensate.
  dungeon_floor: { sheet: "dungeon", x: 16, y: 144, w: 16, h: 16 },
  dungeon_wall: { sheet: "dungeon", x: 16, y: 64, w: 16, h: 32 },
};

const images = new Map<string, HTMLImageElement>();
let loadPromise: Promise<void> | null = null;

/**
 * Starts loading every sheet exactly once; safe to call repeatedly (e.g.
 * from multiple places during startup) — subsequent calls return the same
 * in-flight/resolved promise. Resolves once every sheet has either loaded
 * or failed (a failed sheet's sprites simply don't draw — see `getImage`).
 */
export function loadSprites(): Promise<void> {
  if (loadPromise) return loadPromise;
  loadPromise = Promise.all(
    Object.entries(SHEET_PATHS).map(
      ([name, path]) =>
        new Promise<void>((resolve) => {
          const img = new Image();
          img.onload = () => {
            images.set(name, img);
            resolve();
          };
          img.onerror = () => resolve(); // missing sheet: that sprite silently doesn't draw, rest of the game still runs
          img.src = path;
        }),
    ),
  ).then(() => undefined);
  return loadPromise;
}

/** The loaded Image for a sprite's sheet, or undefined if it hasn't finished loading (or failed to). Callers should skip drawing rather than throw. */
export function getImage(rect: SpriteRect): HTMLImageElement | undefined {
  return images.get(rect.sheet);
}
