import { MAP_HEIGHT, MAP_WIDTH } from "./constants.js";
import type { EnemySpawn, MapObject, MapTile, ResourceKind, TerrainKind, WorldMap } from "./types.js";

/** Deterministic string -> 32-bit seed, so the same seed string always yields the same map. */
function hashSeed(seed: string): number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

/** mulberry32: small, fast, deterministic PRNG from a 32-bit seed. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function noiseAt(grid: Float64Array, x: number, y: number, w: number): number {
  return grid[y * w + x] ?? 0;
}

function buildNoiseGrid(rand: () => number, width: number, height: number): Float64Array {
  const grid = new Float64Array(width * height);
  for (let i = 0; i < grid.length; i++) grid[i] = rand();
  const smoothed = smooth(grid, width, height, 3);
  // Averaging independent uniform values repeatedly (the smoothing above)
  // regresses every cell toward the mean, shrinking the value range each
  // pass — after 3 passes almost nothing is left near 0 or 1, so terrainFor's
  // fixed thresholds (e.g. elevation > 0.78 for rock) become unreachable on
  // any seed. Re-stretching back to [0, 1] after smoothing restores a full
  // spread so every terrain threshold is actually reachable.
  return normalize(smoothed);
}

function normalize(grid: Float64Array): Float64Array {
  let min = Infinity;
  let max = -Infinity;
  for (const v of grid) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min;
  if (range === 0) return grid;
  const out = new Float64Array(grid.length);
  for (let i = 0; i < grid.length; i++) out[i] = ((grid[i] as number) - min) / range;
  return out;
}

function smooth(grid: Float64Array, width: number, height: number, passes: number): Float64Array {
  let src = grid;
  for (let p = 0; p < passes; p++) {
    const dst = new Float64Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let sum = 0;
        let count = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            sum += src[ny * width + nx] as number;
            count++;
          }
        }
        dst[y * width + x] = sum / count;
      }
    }
    src = dst;
  }
  return src;
}

function terrainFor(elevation: number, moisture: number): TerrainKind {
  if (elevation < 0.32) return "water";
  if (elevation > 0.78) return "rock";
  if (moisture > 0.58) return "forest";
  return "grass";
}

export function generateWorldMap(seed: string, width = MAP_WIDTH, height = MAP_HEIGHT): WorldMap {
  const seedNum = hashSeed(seed);
  const rand = mulberry32(seedNum ^ 0xc2b2ae35);

  const elevation = buildNoiseGrid(mulberry32(seedNum ^ 0x9e3779b9), width, height);
  const moisture = buildNoiseGrid(mulberry32(seedNum ^ 0x85ebca6b), width, height);

  const tiles: MapTile[] = new Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const e = noiseAt(elevation, x, y, width);
      const m = noiseAt(moisture, x, y, width);
      tiles[y * width + x] = { terrain: terrainFor(e, m) };
    }
  }

  // Campsite: cleared grass patch near the centre. The campfire sits on the
  // campsite tile itself (solid), so players spawn one tile south of it,
  // never on top of it.
  const campsite = { x: Math.floor(width / 2), y: Math.floor(height / 2) };
  clearPatch(tiles, width, height, campsite.x, campsite.y, 3);
  const spawnPoint = { x: campsite.x, y: campsite.y + 1 };

  const objects: MapObject[] = [];
  let objectSeq = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (nearCampsite(x, y, campsite, 4)) continue;

      const terrain = tiles[y * width + x]!.terrain;
      const roll = rand();
      if (terrain === "forest" && roll < 0.12) {
        objects.push(makeResourceObject(objectSeq++, "tree", x, y, "wood", 5));
      } else if (terrain === "rock" && roll < 0.25) {
        objects.push(makeResourceObject(objectSeq++, "rock", x, y, "stone", 5));
      } else if (terrain === "grass" && roll < 0.04) {
        objects.push(makeResourceObject(objectSeq++, "bush", x, y, "berries", 3));
      }
    }
  }

  objects.push({
    id: `object-${objectSeq++}`,
    kind: "campfire",
    x: campsite.x,
    y: campsite.y,
  });

  return { seed, width, height, tiles, objects, campsite, spawnPoint };
}

function makeResourceObject(
  seq: number,
  kind: Extract<MapObject["kind"], "tree" | "rock" | "bush">,
  x: number,
  y: number,
  resourceKind: ResourceKind,
  maxRemaining: number,
): MapObject {
  return {
    id: `object-${seq}`,
    kind,
    x,
    y,
    resource: { kind: resourceKind, remaining: maxRemaining, maxRemaining },
  };
}

function inBounds(x: number, y: number, width: number, height: number): boolean {
  return x >= 0 && y >= 0 && x < width && y < height;
}

function clearPatch(tiles: MapTile[], width: number, height: number, cx: number, cy: number, radius: number): void {
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      if (inBounds(x, y, width, height)) tiles[y * width + x] = { terrain: "grass" };
    }
  }
}

function nearCampsite(x: number, y: number, campsite: { x: number; y: number }, radius: number): boolean {
  return Math.abs(x - campsite.x) <= radius && Math.abs(y - campsite.y) <= radius;
}

/**
 * A deterministic initial enemy roster for a generated map: wanderers in a
 * close ring around the campsite, guardians further out, and the boss
 * furthest of all — every enemy now lives on the overworld (there's no
 * dungeon any more), with difficulty increasing by distance from camp
 * instead of by zone. Pure function of the map, so production (`world.ts`)
 * and the integration test harness build the exact same roster from the
 * exact same source, the same drift-prevention pattern `loadInitialRoomState`
 * already uses for buildings/chests.
 */
export function enemySpawnsFor(map: WorldMap): EnemySpawn[] {
  const spawns: EnemySpawn[] = [];

  const wandererOffsets: Array<[number, number]> = [
    [10, 0],
    [-10, 0],
    [0, 10],
    [0, -10],
  ];
  for (const [dx, dy] of wandererOffsets) {
    const x = clampInt(map.campsite.x + dx, 1, map.width - 2);
    const y = clampInt(map.campsite.y + dy, 1, map.height - 2);
    spawns.push({ kind: "wanderer", x, y });
  }

  const guardianOffsets: Array<[number, number]> = [
    [18, 18],
    [-18, -18],
  ];
  for (const [dx, dy] of guardianOffsets) {
    const x = clampInt(map.campsite.x + dx, 1, map.width - 2);
    const y = clampInt(map.campsite.y + dy, 1, map.height - 2);
    spawns.push({ kind: "guardian", x, y });
  }

  const bossX = clampInt(map.campsite.x + 28, 1, map.width - 2);
  const bossY = clampInt(map.campsite.y + 28, 1, map.height - 2);
  spawns.push({ kind: "boss", x: bossX, y: bossY });

  return spawns;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}
