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
  sheet: "forest" | "mountain" | "dungeon" | "tiny-rpg-town";
  x: number;
  y: number;
  w: number;
  h: number;
}

const SHEET_PATHS: Record<SpriteRect["sheet"], string> = {
  forest: "/assets/forest/tileset.png",
  mountain: "/assets/mountain/tileset.png",
  dungeon: "/assets/dungeon/tileset.png",
  "tiny-rpg-town": "/assets/tiny-rpg-town/bush-2.png",
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
 * One sprite per ObjectKind that has a genuinely identifiable match in an
 * approved pack — not one per kind. `tree` and `rock` are deliberately
 * absent — see each one's own reasoning below; `bush` is sprited as of
 * Stage 4 Phase B2.
 *
 * `tree`: the forest sheet's own canopy is one continuous overlapping mass
 * (every 16px slice of it is a near-identical repeating edge pattern, not
 * a discrete tree shape). Stage 4 researched ansimuz's separate "Tiny RPG
 * Town" pack (CC0 — see public/assets/CREDITS.md) as a supplement: it has
 * two genuinely standalone tree sprites with real transparent backgrounds,
 * but both are ~113x119 and ~102x140 px — roughly 7x7 and 6x9 *tiles* at
 * this game's 16px grid, 6-7x larger than every other object/the player
 * (all 16x32 or smaller). Using them at native resolution would render a
 * single tree many times larger than a building; shrinking them to fit
 * would blur hand-placed pixel art rather than show a genuine low-res
 * version of it. Neither trade-off was accepted — `tree` stays on
 * render.ts's OBJECT_COLORS flat-colour fallback, a deliberate decision,
 * not an oversight.
 *
 * `rock`: the mountain sheet's one boulder-shaped sprite sits on a fully
 * opaque cave-floor background — part of an interior scene, not a
 * droppable prop — and its cliff-face tiles are diagonal terrain-autotile
 * pieces, not a freestanding rock. Tiny RPG Town's one standalone rock
 * candidate (reviewed in Phase B1) is a small, warm beige/tan-coloured
 * pebble that reads as a loaf of bread or a dirt clump rather than a rock,
 * and clashes with this project's existing grey-toned rock terrain
 * (TERRAIN_SPRITES.rock, from the mountain sheet) — not used, by explicit
 * decision, not because no candidate existed.
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
  // ansimuz "Tiny RPG Town" (CC0, free tier — see CREDITS.md), a genuinely
  // isolated conifer-shaped bush with a transparent background, unlike
  // every candidate previously found in the forest/dungeon sheets (which
  // turned out to be ground-attached dirt patches or a flower, not a
  // bush). Source file is public/assets/tiny-rpg-town/bush-2.png (30x32
  // canvas); these coordinates are its own opaque bounding box within that
  // file, found by alpha-channel scanning, not guessed. At 25x30 px
  // (~1.6x1.9 tiles) it is close enough to this game's existing object
  // scale (every other object/the player is 16x32 or smaller) not to clash
  // the way the pack's tree sprites would have — see this constant's own
  // doc-comment for why those were rejected.
  bush: { sheet: "tiny-rpg-town", x: 3, y: 1, w: 25, h: 30 },
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
