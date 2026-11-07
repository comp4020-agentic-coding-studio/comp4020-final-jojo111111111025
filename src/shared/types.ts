export interface Vec2 {
  x: number;
  y: number;
}

export type TerrainKind = "grass" | "forest" | "water" | "rock";

export const SOLID_TERRAIN: ReadonlySet<TerrainKind> = new Set(["water"]);

export type ResourceKind = "wood" | "stone" | "berries";

/** Everything that can sit in a player's or a chest's inventory. */
export type ItemKind = ResourceKind | "axe" | "pickaxe" | "sword" | "bandage";

export const ITEM_KINDS: readonly ItemKind[] = ["wood", "stone", "berries", "axe", "pickaxe", "sword", "bandage"];

export function emptyInventory(): Record<ItemKind, number> {
  const inv = {} as Record<ItemKind, number>;
  for (const kind of ITEM_KINDS) inv[kind] = 0;
  return inv;
}

export type ObjectKind = "tree" | "rock" | "bush" | "campfire";

export const SOLID_OBJECTS: ReadonlySet<ObjectKind> = new Set(["tree", "rock", "campfire"]);

/** A static map object, e.g. a tree or rock, which may also be a gatherable resource node. */
export interface MapObject {
  id: string;
  kind: ObjectKind;
  x: number;
  y: number;
  resource?: {
    kind: ResourceKind;
    /** Remaining yields before depletion. */
    remaining: number;
    maxRemaining: number;
  };
}

export interface MapTile {
  terrain: TerrainKind;
}

export interface WorldMap {
  seed: string;
  width: number;
  height: number;
  tiles: MapTile[];
  objects: MapObject[];
  campsite: Vec2;
  /** Where new players appear — adjacent to the campsite, clear of the campfire itself. */
  spawnPoint: Vec2;
}

export interface PlayerState {
  id: string;
  name: string;
  x: number;
  y: number;
  health: number;
  alive: boolean;
  inventory: Record<ItemKind, number>;
  connected: boolean;
}

export type BuildingKind = "wall" | "floor" | "campfire" | "workbench" | "chest";

export const SOLID_BUILDINGS: ReadonlySet<BuildingKind> = new Set(["wall", "campfire", "workbench", "chest"]);

export interface Building {
  id: string;
  kind: BuildingKind;
  x: number;
  y: number;
  ownerId: string;
  placedAt: number;
}

export type EnemyKind = "wanderer" | "guardian" | "boss";

/**
 * Enemies are in-memory-only, transient simulation state (same category as
 * player position) — never persisted per-tick, not even the boss. Killing
 * every enemy on the map is this game's win condition (see
 * Room.allEnemiesDefeated), so a server restart resets the enemy roster to
 * full via the deterministic map seed — a known, accepted limitation, not
 * an oversight (see PROCESS.md).
 */
export interface EnemyState {
  id: string;
  kind: EnemyKind;
  x: number;
  y: number;
  health: number;
  maxHealth: number;
  spawnX: number;
  spawnY: number;
  alive: boolean;
  /** Epoch ms of this enemy's last successful contact hit on any player — used to cooldown-gate contact damage per enemy (not per player-enemy pair, to keep it simple: one bite at a time). */
  lastContactAt: number;
  /** Boss only: true while in its visible windup before the AoE lands. */
  telegraphing: boolean;
  /** Boss only: epoch ms when the current windup/cooldown phase ends. */
  nextActionAt: number;
}

/** A deterministic initial enemy placement, produced from the map/seed by `enemySpawnsFor` (shared/map.ts) so production and tests build the same roster from the same source. */
export interface EnemySpawn {
  kind: EnemyKind;
  x: number;
  y: number;
}
