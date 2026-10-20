import { TILE_SIZE } from "../shared/constants.js";
import type { Building, MapObject, MapTile } from "../shared/types.js";

const TERRAIN_COLORS: Record<string, string> = {
  grass: "#4a7c3c",
  forest: "#2e5a2a",
  water: "#2a5a8c",
  rock: "#6b6b6b",
};

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
      ctx.fillStyle = TERRAIN_COLORS[tile.terrain] ?? "#000";
      ctx.fillRect(
        Math.round(col * TILE_SIZE - originX),
        Math.round(row * TILE_SIZE - originY),
        TILE_SIZE,
        TILE_SIZE,
      );
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

  for (const player of players) {
    const px = player.x * TILE_SIZE - originX;
    const py = player.y * TILE_SIZE - originY;
    ctx.globalAlpha = player.alive ? 1 : 0.3;
    ctx.fillStyle = player.isLocal ? "#ffd84a" : "#4ac6ff";
    ctx.beginPath();
    ctx.arc(px, py, TILE_SIZE * 0.35, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // Night tint: a translucent dark-blue overlay over the whole viewport, so
  // the day/night cycle reads immediately without needing a HUD clock.
  if (isNight) {
    ctx.fillStyle = "rgba(10, 12, 40, 0.45)";
    ctx.fillRect(0, 0, viewport.width, viewport.height);
  }
}

function drawObject(ctx: CanvasRenderingContext2D, obj: MapObject, originX: number, originY: number): void {
  const depleted = obj.resource ? obj.resource.remaining <= 0 : false;
  ctx.fillStyle = OBJECT_COLORS[obj.kind] ?? "#fff";
  ctx.globalAlpha = depleted ? 0.25 : 1;
  const x = Math.round(obj.x * TILE_SIZE - originX);
  const y = Math.round(obj.y * TILE_SIZE - originY);
  ctx.fillRect(x + 2, y + 2, TILE_SIZE - 4, TILE_SIZE - 4);
  ctx.globalAlpha = 1;
}

function drawEnemy(ctx: CanvasRenderingContext2D, enemy: RenderEnemy, originX: number, originY: number): void {
  const px = enemy.x * TILE_SIZE - originX;
  const py = enemy.y * TILE_SIZE - originY;
  const radius = enemy.kind === "boss" ? TILE_SIZE * 0.55 : TILE_SIZE * 0.3;

  ctx.fillStyle = ENEMY_COLORS[enemy.kind] ?? "#e00";
  ctx.beginPath();
  ctx.arc(px, py, radius, 0, Math.PI * 2);
  ctx.fill();

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
