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
import type { BuildingKind, EnemyKind, ObjectKind, TerrainKind } from "../shared/types.js";

export interface SpriteRect {
  sheet: "forest" | "mountain" | "dungeon" | "tiny-rpg-town" | "serene-village" | "mountain-cutouts";
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
  "serene-village": "/assets/serene-village/terrains.png",
  "mountain-cutouts": "/assets/mountain-cutouts/boulder.png",
};

/**
 * One sprite per TerrainKind.
 *
 * `grass` was replaced in Stage 5 (Task B) — the original ansimuz tile was
 * a flat, low-saturation olive-green with no internal texture; LimeZu's
 * "Serene Village - revamped" pack (CC-BY 4.0 — see CREDITS.md) supplies a
 * brighter, textured grass tile from the same kind of RPG-Maker autotile
 * sheet Stage 4 already knew how to crop a pure interior cell from.
 *
 * `water` also gained a real sprite in Stage 5 — every previously-evaluated
 * pack (ansimuz's forest/mountain, Calciumtrice's dungeon, and Tiny RPG
 * Town, researched in Stage 4) either had no water at all or only a
 * hand-painted pond/waterfall scene that produced a visible repeating
 * pattern when tiled at this game's 16px grid (documented in PROCESS.md's
 * Stage 4 section). Serene Village's terrain sheet is a proper RPG-Maker
 * autotile sheet — its water section has a genuine solid-colour interior
 * cell, not a scene fragment, so it tiles cleanly.
 *
 * `forest` deliberately keeps its original ansimuz sprite, not a Serene
 * Village one: that pack has only a single grass tone, with no separate
 * darker/forest-floor variant, and `forest`/`grass` sharing one ground tile
 * with trees as the only biome-distinguishing element was Stage 1's
 * original design (now stale as a "tree objects" claim, since tree objects
 * are still flat-colour — see OBJECT_SPRITES — but the ground-tile
 * reasoning holds regardless of what's drawn on top of it). Mixing a new
 * bright-green grass with the old sprite for forest would make the two
 * biomes look like an inconsistent reskin rather than a deliberate pair;
 * `forest` will move to a matching sprite once one is found, not before.
 */
export const TERRAIN_SPRITES: Partial<Record<TerrainKind, SpriteRect>> = {
  // LimeZu "Serene Village - revamped" terrain autotile sheet: a pure
  // interior grass cell (no edge/transition pixels), found by alpha/colour
  // scanning the 47-cell autotile block, not guessed.
  grass: { sheet: "serene-village", x: 48, y: 0, w: 16, h: 16 },
  // ansimuz forest tileset: the clean dirt/path tile, kept as-is — see this
  // constant's own doc-comment for why "forest" doesn't move to the new
  // pack alongside "grass".
  forest: { sheet: "forest", x: 208, y: 288, w: 16, h: 16 },
  // ansimuz mountain tileset: the one flat (non-cliff-face) grey tile,
  // used for the overworld's walkable rock/mountain biome.
  rock: { sheet: "mountain", x: 48, y: 16, w: 16, h: 16 },
  // LimeZu "Serene Village - revamped": a pure interior water cell from the
  // same autotile sheet as grass above — solid colour, no wave/edge
  // pixels, confirmed tileable (see PROCESS.md's Stage 5 section for the
  // seam check this was verified against before being accepted).
  water: { sheet: "serene-village", x: 224, y: 224, w: 16, h: 16 },
};

/**
 * The one terrain-boundary transition sprite Stage 5 found and verified: a
 * clean, fully-opaque, water-above/grass-below 16x16 split with no
 * decorative noise (no path, no stray third colour) — found by
 * programmatically scanning every 16x16 cell in the Serene Village terrain
 * sheet for a near-50/50 two-colour split, not by eye (repeated by-eye
 * passes on this same sheet produced inconsistent, self-contradicting
 * coordinate judgements; only the programmatic scan's distance-to-reference
 * colour classification actually confirmed this one, and ruled out the
 * others — see PROCESS.md's Stage 5 section for the full account). This
 * single sprite is drawn in one of four 90-degree rotations by drawTile()
 * to cover all four compass directions — safe here specifically because
 * the sprite is a flat, direction-neutral colour split with no asymmetric
 * detail.
 *
 * No corner/inner-corner variant exists for this terrain pair: a
 * programmatic quarter-cell scan of the *entire* 768x768 sheet (sampling
 * all four 8x8 quadrants of every 16x16 cell, not just one point) found
 * exactly one grass/water split pattern in the whole file — this one.
 * Water-surrounded-by-grass therefore always renders with a hard right-
 * angle corner where two rotated edges meet; this is a real, verified
 * limitation of the source art, not a gap in the search. (The same
 * quarter-cell scan found six grass/sand corner/edge patterns elsewhere in
 * the sheet, which looked promising at first, but every one of them turned
 * out on visual inspection to include stray decorative detail — a path,
 * an isolated patch — not a clean geometric corner; none were usable for
 * the same reason the grass/sand edge candidate from the first pass
 * wasn't: this source art is a hand-painted scene collection, not a
 * systematically-authored blob-tileset, and quarter-pattern matches alone
 * don't guarantee a clean shape.)
 */
export const WATER_GRASS_EDGE_SPRITE: SpriteRect = {
  sheet: "serene-village",
  x: 64,
  y: 512,
  w: 16,
  h: 16,
};

/**
 * One sprite per ObjectKind that has a genuinely identifiable match. `tree`
 * is deliberately absent — see its own reasoning below; `bush` was sprited
 * in Stage 4 Phase B2, `rock` in the "real pictures" pass that followed the
 * gameplay-simplification redesign.
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
 * `rock`: the mountain sheet has one genuinely isolated boulder sprite —
 * round, grey, unambiguous — but unlike every other sprite in this file it
 * sits on a fully *opaque* scene background (confirmed by alpha-channel
 * scan: the entire 32x32 region reads alpha 255), so it can't be referenced
 * in place the way every other sprite rect is. `public/assets/mountain-
 * cutouts/boulder.png` is a new, derived file — not a byte-for-byte copy of
 * source art like every other asset in this project — produced by a
 * colour-distance mask against the scene's own flat background colour
 * (sampled from a corner pixel, threshold tuned by visual inspection to
 * keep the boulder's lighter highlights while still cutting the
 * background), then re-encoded as its own transparent PNG. This is an
 * explicit, documented exception to this project's "cropped, never
 * modified" asset policy — see PROCESS.md and CREDITS.md for the
 * generation method and why no unmodified crop was possible.
 */
export const OBJECT_SPRITES: Partial<Record<ObjectKind, SpriteRect>> = {
  // Calciumtrice dungeon tileset, "FIRE 16x6" section: an isolated
  // flame-on-transparent sprite.
  campfire: { sheet: "dungeon", x: 240, y: 512, w: 16, h: 16 },
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
  // See this constant's own doc-comment for why this is a derived cutout
  // file rather than a plain crop of mountain/tileset.png.
  rock: { sheet: "mountain-cutouts", x: 0, y: 0, w: 32, h: 32 },
};

/**
 * One sprite per placeable BuildingKind that has a genuinely identifiable
 * match — `campfire` is deliberately absent here since it reuses
 * OBJECT_SPRITES.campfire (a placed campfire building and the world-gen
 * campfire object are the same flame sprite; see render.ts's drawBuilding).
 * All three found here come from Calciumtrice's dungeon sheet (CONTAINERS
 * 16x16 section) and ansimuz's forest sheet (its wood-plank/fence props),
 * both already-approved packs — no new license obligations.
 *
 * `chest`: the dungeon sheet's "CONTAINERS 16x16" section has a genuine
 * closed treasure chest (wood-bound lid, brass trim), transparent
 * background, unambiguous — the second, more armoured-looking container
 * cell right next to it was not used (reads as a different, sturdier chest
 * variant, not a better match for this game's single generic chest).
 *
 * `wall`: the forest sheet's wood-prop cluster (the same area ansimuz drew
 * fence posts and log piles) has a standalone stack of three tightly-packed
 * vertical planks, transparent background — reads as a short section of
 * plank wall, which is what this building represents.
 *
 * `workbench`: the dungeon sheet's "CONTAINERS 16x16" section also has a
 * slatted wooden crate (two horizontal-ribbed panels stacked), transparent
 * background — chosen over the sheet's barrel and sack containers because
 * its flat horizontal ribbing reads more like a work surface/bench than a
 * storage vessel does.
 *
 * `floor`: the forest sheet's same wood-prop cluster has a bundle of
 * horizontally-stacked planks, transparent background — reads as a laid
 * section of wood flooring.
 */
export const BUILDING_SPRITES: Partial<Record<BuildingKind, SpriteRect>> = {
  chest: { sheet: "dungeon", x: 32, y: 307, w: 16, h: 13 },
  wall: { sheet: "forest", x: 464, y: 304, w: 36, h: 31 },
  workbench: { sheet: "dungeon", x: 2, y: 305, w: 12, h: 15 },
  floor: { sheet: "forest", x: 496, y: 304, w: 32, h: 16 },
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
