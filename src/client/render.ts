import { TILE_SIZE } from "../shared/constants.js";
import type { Building, MapObject, MapTile } from "../shared/types.js";
import { ENEMY_SPRITES, getImage, OBJECT_SPRITES, PLAYER_SPRITES, TERRAIN_SPRITES } from "./sprites.js";

/** Fallback for a terrain kind with no sprite (today: only "water" — neither
 * approved pack includes open water) and for any tile drawn before its
 * sheet has finished loading. */
const TERRAIN_COLORS: Record<string, string> = {
  grass: "#4a7c3c",
  forest: "#2e5a2a",
  water: "#2a5a8c",
  rock: "#6b6b6b",
  dungeon_wall: "#4a4654",
  dungeon_floor: "#c9c5cf",
};

/** Fallback for an ObjectKind with no sprite (tree/rock/bush — see
 * OBJECT_SPRITES's doc-comment for why) and for any object drawn before its
 * sheet has finished loading. */
const OBJECT_COLORS: Record<string, string> = {
  tree: "#1f3d1a",
  rock: "#8a8a8a",
  bush: "#7a2e3a",
  campfire: "#e08a2a",
  dungeon_entrance: "#3a1a4a",
  dungeon_exit: "#3a1a4a",
  ancient_beacon: "#c9a7ff",
};

const BUILDING_COLORS: Record<string, string> = {
  wall: "#5a4a3a",
  floor: "#8a7a5a",
  campfire: "#e08a2a",
  workbench: "#a87c4a",
  chest: "#c2a35a",
  farm_plot: "#6b4a2a",
};

const ENEMY_COLORS: Record<string, string> = {
  wanderer: "#a85a3a",
  guardian: "#7a3aa8",
  boss: "#c21a1a",
};

export interface RenderPlayer {
  id: string;
  x: number;
  y: number;
  isLocal: boolean;
  alive: boolean;
}

export interface RenderEnemy {
  id: string;
  kind: string;
  x: number;
  y: number;
  health: number;
  maxHealth: number;
  telegraphing: boolean;
}

export interface RenderZone {
  width: number;
  height: number;
  tiles: MapTile[];
  objects: MapObject[];
}

export function render(
  ctx: CanvasRenderingContext2D,
  zone: RenderZone,
  players: RenderPlayer[],
  buildings: Building[],
  enemies: RenderEnemy[],
  camera: { x: number; y: number },
  viewport: { width: number; height: number },
  isNight: boolean,
  /** World-space centres of whatever a key press would currently act on (gather/zone-transition target for E, an attackable enemy for Space, a chest for C) — drawn as rings so a first-time player can see what a key will do before pressing it. Empty when nothing is in range. */
  highlights: Array<{ x: number; y: number; color: string }> = [],
): void {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, viewport.width, viewport.height);

  const originX = camera.x * TILE_SIZE - viewport.width / 2;
  const originY = camera.y * TILE_SIZE - viewport.height / 2;

  const startCol = Math.max(0, Math.floor(originX / TILE_SIZE));
  const startRow = Math.max(0, Math.floor(originY / TILE_SIZE));
  const endCol = Math.min(zone.width, Math.ceil((originX + viewport.width) / TILE_SIZE) + 1);
  const endRow = Math.min(zone.height, Math.ceil((originY + viewport.height) / TILE_SIZE) + 1);

  for (let row = startRow; row < endRow; row++) {
    for (let col = startCol; col < endCol; col++) {
      const tile = zone.tiles[row * zone.width + col];
      if (!tile) continue;
      drawTile(ctx, tile.terrain, Math.round(col * TILE_SIZE - originX), Math.round(row * TILE_SIZE - originY));
    }
  }

  for (const obj of zone.objects) {
    if (obj.x < startCol - 1 || obj.x > endCol || obj.y < startRow - 1 || obj.y > endRow) continue;
    drawObject(ctx, obj, originX, originY);
  }

  for (const building of buildings) {
    if (building.x < startCol - 1 || building.x > endCol || building.y < startRow - 1 || building.y > endRow) continue;
    drawBuilding(ctx, building, originX, originY);
  }

  for (const enemy of enemies) {
    drawEnemy(ctx, enemy, originX, originY);
  }

  for (const h of highlights) {
    const hx = h.x * TILE_SIZE - originX;
    const hy = h.y * TILE_SIZE - originY;
    ctx.strokeStyle = h.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(hx, hy, TILE_SIZE * 0.6, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Every player draws as the same static PLAYER_SPRITES character — the
  // pack has only one usable character art (see sprites.ts's doc-comment).
  // Since that sprite carries no colour cue of its own, a small flattened
  // "shadow" ellipse beneath the character's feet — drawPlayerMarker()'s
  // sole job — restores the isLocal (yellow) vs. remote (blue) distinction
  // the old plain-colour circles used to give for free, without touching
  // the character art itself.
  for (const player of players) {
    const px = player.x * TILE_SIZE - originX;
    const py = player.y * TILE_SIZE - originY;
    ctx.globalAlpha = player.alive ? 1 : 0.3;

    const img = getImage(PLAYER_SPRITES);
    if (img) {
      const x = Math.round(px - PLAYER_SPRITES.w / 2);
      const y = Math.round(py - TILE_SIZE / 2);
      const destY = y - (PLAYER_SPRITES.h - TILE_SIZE);
      ctx.drawImage(img, PLAYER_SPRITES.x, PLAYER_SPRITES.y, PLAYER_SPRITES.w, PLAYER_SPRITES.h, x, destY, PLAYER_SPRITES.w, PLAYER_SPRITES.h);
    } else {
      ctx.fillStyle = player.isLocal ? "#ffd84a" : "#4ac6ff";
      ctx.beginPath();
      ctx.arc(px, py, TILE_SIZE * 0.35, 0, Math.PI * 2);
      ctx.fill();
    }
    drawPlayerMarker(ctx, player, px, py);
    ctx.globalAlpha = 1;
  }

  // Night tint: a translucent dark-blue overlay over the whole viewport, so
  // the day/night cycle reads immediately without needing a HUD clock.
  if (isNight) {
    ctx.fillStyle = "rgba(10, 12, 40, 0.45)";
    ctx.fillRect(0, 0, viewport.width, viewport.height);
  }
}

/** Half-width/height, in pixels, of the small flattened identity marker
 * drawPlayerMarker() draws under a player's feet — deliberately smaller
 * than a full tile so it reads as a subtle ground marking, never obscuring
 * the character above it or the terrain around it. */
const PLAYER_MARKER_RADIUS_X = TILE_SIZE * 0.3;
const PLAYER_MARKER_RADIUS_Y = TILE_SIZE * 0.12;

/**
 * Draws a small flattened ellipse ("shadow") centred on a player's feet
 * (px, the same world-space foot position drawObject/drawEnemy anchor to),
 * offset down by half a tile so it sits on the ground rather than over the
 * character. Colour alone carries the isLocal/remote distinction — yellow
 * for the local player, blue for everyone else — the same two colours the
 * pre-sprite fallback circles used, so "which one is me" still reads the
 * same way it always did. Drawn after the character (sprite or fallback)
 * so it isn't itself hidden by anything just drawn for this player, but
 * its low alpha and small size keep it from reading as a second object.
 */
export function drawPlayerMarker(ctx: CanvasRenderingContext2D, player: RenderPlayer, px: number, py: number): void {
  // py + TILE_SIZE/2 is the bottom edge of the tile the character sprite is
  // anchored into (its feet line); nudging a couple pixels further down
  // keeps the marker visibly below the feet rather than sitting flush
  // against the sprite's own bottom edge.
  const markerY = py + TILE_SIZE / 2 + 2;
  ctx.globalAlpha *= 0.6;
  ctx.fillStyle = player.isLocal ? "#ffd84a" : "#4ac6ff";
  ctx.beginPath();
  ctx.ellipse(px, markerY, PLAYER_MARKER_RADIUS_X, PLAYER_MARKER_RADIUS_Y, 0, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * Draws one terrain tile at the given destination pixel position. Tries the
 * sprite sheet first (TERRAIN_SPRITES); falls back to a flat TERRAIN_COLORS
 * fill when there's no sprite for this terrain (today: "water" only) or the
 * sheet hasn't finished loading yet, so the map is never blank while
 * sprites load. Walls (dungeon_wall) are 16x32 — taller than the 16x16
 * floor grid — so they're bottom-anchored to the tile's bottom edge, which
 * makes a wall tile correctly paint over the floor tile directly above it
 * (walls read as "standing up" out of the floor, not floating above it).
 * drawObject/drawEnemy and the player-sprite code in render() all reuse this
 * same bottom-anchor formula for their own taller-than-one-tile sprites.
 */
function drawTile(ctx: CanvasRenderingContext2D, terrain: string, x: number, y: number): void {
  const rect = TERRAIN_SPRITES[terrain as keyof typeof TERRAIN_SPRITES];
  const img = rect && getImage(rect);
  if (rect && img) {
    const destY = y - (rect.h - TILE_SIZE); // bottom-anchor sprites taller than one tile
    ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h, x, destY, rect.w, rect.h);
    return;
  }
  ctx.fillStyle = TERRAIN_COLORS[terrain] ?? "#000";
  ctx.fillRect(x, y, TILE_SIZE, TILE_SIZE);
}

/**
 * Draws one map object (tree, campfire, dungeon entrance, ...). Tries
 * OBJECT_SPRITES first, same sprite-then-fallback pattern drawTile() uses
 * for terrain; falls back to a flat OBJECT_COLORS square when this kind has
 * no sprite (tree/rock — see OBJECT_SPRITES's doc-comment) or the sheet
 * hasn't loaded yet. A sprite taller than one tile (campfire's neighbours
 * ancient_beacon/dungeon_entrance/dungeon_exit are all 32px) is
 * bottom-anchored like drawTile()'s dungeon_wall, so it stands up out of
 * its own cell rather than floating above it. A sprite wider than one tile
 * (bush, from Stage 4's "Tiny RPG Town" pack, is 25px) is horizontally
 * centred on the cell the same way — every sprite before it happened to be
 * exactly TILE_SIZE wide, so this never came up until bush's width forced
 * it: drawn at x unchanged, it would overflow past the cell's right edge
 * rather than sit centred in it. Depleted-resource dimming applies the
 * same way whether a sprite or the fallback colour is drawn.
 */
export function drawObject(ctx: CanvasRenderingContext2D, obj: MapObject, originX: number, originY: number): void {
  const depleted = obj.resource ? obj.resource.remaining <= 0 : false;
  ctx.globalAlpha = depleted ? 0.25 : 1;
  const x = Math.round(obj.x * TILE_SIZE - originX);
  const y = Math.round(obj.y * TILE_SIZE - originY);

  const rect = OBJECT_SPRITES[obj.kind];
  const img = rect && getImage(rect);
  if (rect && img) {
    const destX = x - (rect.w - TILE_SIZE) / 2;
    const destY = y - (rect.h - TILE_SIZE);
    ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h, destX, destY, rect.w, rect.h);
    ctx.globalAlpha = 1;
    return;
  }

  ctx.fillStyle = OBJECT_COLORS[obj.kind] ?? "#fff";
  ctx.fillRect(x + 2, y + 2, TILE_SIZE - 4, TILE_SIZE - 4);
  ctx.globalAlpha = 1;
}

/**
 * Draws one enemy. Tries ENEMY_SPRITES first, same sprite-then-fallback
 * pattern as drawTile/drawObject; every EnemyKind has a sprite (unlike
 * terrain/objects, there's no partial-coverage case here), so the
 * ENEMY_COLORS fallback only fires before the sheet has finished loading,
 * or for a kind value this client doesn't recognise. guardian/boss sprites
 * are 32px tall (2 tile-rows) and bottom-anchored like
 * dungeon_wall/ancient_beacon, so they stand up out of their own cell. The
 * health bar and telegraph ring are positioned off the same radius/anchor
 * math either way, so they land in the same place sprite or fallback.
 */
function drawEnemy(ctx: CanvasRenderingContext2D, enemy: RenderEnemy, originX: number, originY: number): void {
  const px = enemy.x * TILE_SIZE - originX;
  const py = enemy.y * TILE_SIZE - originY;
  const radius = enemy.kind === "boss" ? TILE_SIZE * 0.55 : TILE_SIZE * 0.3;

  const rect = ENEMY_SPRITES[enemy.kind as keyof typeof ENEMY_SPRITES];
  const img = rect && getImage(rect);
  if (rect && img) {
    const x = Math.round(px - rect.w / 2);
    const y = Math.round(py - TILE_SIZE / 2);
    const destY = y - (rect.h - TILE_SIZE);
    ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h, x, destY, rect.w, rect.h);
  } else {
    ctx.fillStyle = ENEMY_COLORS[enemy.kind] ?? "#e00";
    ctx.beginPath();
    ctx.arc(px, py, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  if (enemy.telegraphing) {
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(px, py, radius + 4, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Health bar above the enemy.
  const barWidth = radius * 2;
  const barY = py - radius - 8;
  ctx.fillStyle = "#000";
  ctx.fillRect(px - barWidth / 2, barY, barWidth, 4);
  ctx.fillStyle = "#e03a3a";
  const pct = Math.max(0, enemy.health / enemy.maxHealth);
  ctx.fillRect(px - barWidth / 2, barY, barWidth * pct, 4);
}

function drawBuilding(ctx: CanvasRenderingContext2D, building: Building, originX: number, originY: number): void {
  ctx.fillStyle = BUILDING_COLORS[building.kind] ?? "#ccc";
  const x = Math.round(building.x * TILE_SIZE - originX);
  const y = Math.round(building.y * TILE_SIZE - originY);
  if (building.kind === "floor" || building.kind === "farm_plot") {
    ctx.fillRect(x, y, TILE_SIZE, TILE_SIZE);
  } else {
    ctx.fillRect(x + 1, y + 1, TILE_SIZE - 2, TILE_SIZE - 2);
  }
}
