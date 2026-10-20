export interface Vec2 {
  x: number;
  y: number;
}

export type TerrainKind = "grass" | "forest" | "water" | "rock";

export const SOLID_TERRAIN: ReadonlySet<TerrainKind> = new Set(["water"]);

export type ResourceKind = "wood" | "stone" | "berries";

/** Everything that can sit in a player's or a chest's inventory. */
export type ItemKind =
  | ResourceKind
  | "seed_berry"
  | "axe"
  | "pickaxe"
  | "sword"
  | "bandage"
  | "ancient_core";

export const ITEM_KINDS: readonly ItemKind[] = [
  "wood",
  "stone",
  "berries",
  "seed_berry",
  "axe",
  "pickaxe",
  "sword",
  "bandage",
  "ancient_core",
];

export function emptyInventory(): Record<ItemKind, number> {
  const inv = {} as Record<ItemKind, number>;
  for (const kind of ITEM_KINDS) inv[kind] = 0;
  return inv;
}

export type ObjectKind =
  | "tree"
  | "rock"
  | "bush"
  | "campfire"
  | "dungeon_entrance"
  | "dungeon_exit"
  | "ancient_beacon";

export const SOLID_OBJECTS: ReadonlySet<ObjectKind> = new Set([
  "tree",
  "rock",
  "campfire",
  "ancient_beacon",
]);

export type Zone = "overworld" | "dungeon";

/** A static map object, e.g. a tree or rock, which may also be a gatherable resource node. */
export interface MapObject {
  id: string;
  kind: ObjectKind;
  x: number;
  y: number;
  /** Which zone's coordinate space this object lives in. Absent means "overworld" — every pre-Phase-D object and test fixture predates this field. */
  zone?: Zone;
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

/**
 * The dungeon is a separate coordinate space from the overworld — its own
 * small grid, starting at (0, 0), entirely disjoint from the overworld's
 * tile array. This (rather than carving a region out of the overworld grid)
 * is what makes "an action in one zone can't touch the other zone's cells"
 * a structural fact rather than something every caller has to remember to
 * check: Room looks up collision/objects/enemies through whichever zone's
 * tile array matches the actor's own `zone` field.
 */
export interface DungeonMap {
  width: number;
  height: number;
  tiles: MapTile[];
  objects: MapObject[];
  /** Where a player entering the dungeon appears. */
  entryPoint: Vec2;
  /** The ancient_beacon's location, where beacon.deposit/activate are usable. */
  beaconLocation: Vec2;
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
  farmArea: { x: number; y: number; width: number; height: number };
  dungeonEntrance: Vec2;
  dungeon: DungeonMap;
}

export interface PlayerState {
  id: string;
  name: string;
  x: number;
  y: number;
  zone: Zone;
  health: number;
  alive: boolean;
  inventory: Record<ItemKind, number>;
  connected: boolean;
}

export type BuildingKind = "wall" | "floor" | "campfire" | "workbench" | "chest" | "farm_plot";

export const SOLID_BUILDINGS: ReadonlySet<BuildingKind> = new Set(["wall", "campfire", "workbench", "chest"]);

export interface Building {
  id: string;
  kind: BuildingKind;
  x: number;
  y: number;
  ownerId: string;
  placedAt: number;
}

export type CropStage = "empty" | "planted" | "growing" | "mature";

/** A farm_plot building's crop state. plantedAt/wateredAt are epoch ms, or null when empty/never watered. */
export interface FarmPlotState {
  buildingId: string;
  seedKind: ItemKind | null;
  plantedAt: number | null;
  wateredAt: number | null;
}

export type EnemyKind = "wanderer" | "guardian" | "boss";

/**
 * Enemies are in-memory-only, transient simulation state (same category as
 * player position) — never persisted per-tick. Only the boss's death and
 * the beacon's progress are durable, via world_progress, because those are
 * one-time meaningful transitions rather than continuous state.
 */
export interface EnemyState {
  id: string;
  kind: EnemyKind;
  zone: Zone;
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
  /** Boss only: every player who landed at least one hit before it died — each gets exactly one loot grant. */
  contributors: Set<string>;
  /** Trash enemies only: epoch ms when a dead enemy should respawn. Checked each tick against the injected clock — never a real setTimeout, so tests stay deterministic under an injected `now()`. */
  respawnAt: number | null;
}

/** A deterministic initial enemy placement, produced from the map/seed by `enemySpawnsFor` (shared/map.ts) so production and tests build the same roster from the same source. */
export interface EnemySpawn {
  kind: EnemyKind;
  zone: Zone;
  x: number;
  y: number;
}
