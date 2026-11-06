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
import type { EnemyKind, ObjectKind, TerrainKind } from "../shared/types.js";

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

/**
 * One sprite per ObjectKind that has a genuinely identifiable match in the
 * approved packs — not one per kind. `tree`, `rock`, and `bush` are
 * deliberately absent: the forest sheet paints its canopy as one continuous
 * overlapping mass (every 16px slice of it is a near-identical repeating
 * edge pattern, confirmed by decoding and visually comparing adjacent
 * slices, not assumed), with no discrete single-tree shape anywhere in it.
 * The only "boulder" art in the mountain sheet sits on an opaque cave-floor
 * background — part of an interior scene, not a droppable prop — and its
 * cliff-face tiles are diagonal terrain-autotile pieces, not a freestanding
 * rock. The pack's one isolated small plant sprite is a rose/flower, not a
 * bush, and would misrepresent what it depicts if relabelled. render.ts's
 * OBJECT_COLORS fallback (unchanged) is what draws these three; see
 * PROCESS.md's Stage 2 section for the full per-kind reasoning.
 */
export const OBJECT_SPRITES: Partial<Record<ObjectKind, SpriteRect>> = {
  // Calciumtrice dungeon tileset, "FIRE 16x6" section: an isolated
  // flame-on-transparent sprite.
  campfire: { sheet: "dungeon", x: 240, y: 512, w: 16, h: 16 },
  // Calciumtrice dungeon tileset, "ALTARS" section: a statue on a stone
  // pedestal. Taller than one tile grid cell (32px, 2 tile-rows), like
  // dungeon_wall — render.ts's drawObject bottom-anchors it the same way.
  ancient_beacon: { sheet: "dungeon", x: 304, y: 304, w: 16, h: 32 },
  // Calciumtrice dungeon tileset, "DOORS+FENCES 16x32" section: one panel
  // of a wooden double-door, with its handle — a single 16-wide slice of a
  // wider 4-tile door art, chosen (over the full width) because every
  // MapObject occupies exactly one tile cell, same as dungeon_wall/floor.
  // Taller than one row (32px) like dungeon_wall — bottom-anchored the
  // same way.
  dungeon_entrance: { sheet: "dungeon", x: 16, y: 176, w: 16, h: 32 },
  // Calciumtrice dungeon tileset, "FLOOR STAIRS 32x32" section: a stone
  // staircase, taller than one tile (32px) like dungeon_wall/ancient_beacon.
  dungeon_exit: { sheet: "dungeon", x: 0, y: 240, w: 16, h: 32 },
};

/**
 * The single static player sprite. Named PLAYER_SPRITES (plural, to match
 * ENEMY_SPRITES below) but holds one SpriteRect, not a map keyed by kind —
 * there's no PlayerKind to key by, every player looks the same. There is
 * exactly one because the pack's "CHARACTERS" section has 15 front-facing
 * variants with no back/side/walk frames (confirmed by pixel-diffing every
 * pair: differences are confined to held-weapon pixels, never pose or leg
 * position), so there is no basis to pick more than one or to vary it by
 * facing/movement. The character always faces the viewer, regardless of
 * which way the player is actually moving — see PROCESS.md's Stage 3
 * section.
 */
export const PLAYER_SPRITES: SpriteRect = {
  sheet: "dungeon",
  x: 0,
  y: 416,
  w: 16,
  h: 32,
};

/**
 * One static sprite per EnemyKind, chosen from the "MONSTERS" section by
 * matching each kind's in-game role (see constants.ts's
 * WANDERER_MAX_HEALTH/GUARDIAN_MAX_HEALTH/BOSS_MAX_HEALTH) to the sheet's
 * three size tiers. Like PLAYER_SPRITES, every monster in this pack is a
 * single static pose — the only near-duplicate pairs found during
 * inspection (e.g. the two 32x32 ogre variants) differ solely in a held
 * weapon, never a walk/attack frame — so there is no animation to select
 * between, and no fallback is needed: every EnemyKind has a sprite.
 */
export const ENEMY_SPRITES: Record<EnemyKind, SpriteRect> = {
  // "MONSTERS 16x16" section: a green slime, matched to wanderer's role as
  // the weak, roaming trash mob.
  wanderer: { sheet: "dungeon", x: 48, y: 464, w: 16, h: 16 },
  // "MONSTERS 16x32" section: a leather-armoured orc/zombie, matched to
  // guardian's role as the tougher, more armoured mid-tier threat. Taller
  // than one tile grid cell (32px) — render.ts's drawEnemy bottom-anchors
  // it the same way drawTile/drawObject already do.
  guardian: { sheet: "dungeon", x: 208, y: 464, w: 16, h: 32 },
  // "MONSTERS 32x32" section: an armed horned ogre, matched to boss's role
  // as the single largest, most visually distinct threat guarding the
  // beacon. 32px tall — bottom-anchored the same way.
  boss: { sheet: "dungeon", x: 320, y: 464, w: 32, h: 32 },
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
