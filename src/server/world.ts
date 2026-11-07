import type Database from "better-sqlite3";
import { DEFAULT_WORLD_SEED } from "../shared/constants.js";
import { enemySpawnsFor, generateWorldMap } from "../shared/map.js";
import type { Building, BuildingKind, EnemySpawn, ItemKind, WorldMap } from "../shared/types.js";
import { emptyInventory } from "../shared/types.js";
import type { RoomPersistence } from "./room.js";

/**
 * Loads the persisted world seed (or creates one on first run), regenerates
 * the deterministic map from it, then overlays any persisted resource-node
 * depletion so a restart doesn't reset gathered nodes.
 */
export function loadOrCreateWorld(db: Database.Database, seed = DEFAULT_WORLD_SEED): WorldMap {
  const existing = db.prepare("SELECT seed FROM world WHERE id = 1").get() as
    | { seed: string }
    | undefined;

  const resolvedSeed = existing?.seed ?? seed;
  if (!existing) {
    db.prepare("INSERT INTO world (id, seed) VALUES (1, ?)").run(resolvedSeed);
  }

  const map = generateWorldMap(resolvedSeed);

  const depletion = db.prepare("SELECT object_id, remaining FROM resource_nodes").all() as Array<{
    object_id: string;
    remaining: number;
  }>;
  const remainingById = new Map(depletion.map((row) => [row.object_id, row.remaining]));

  for (const obj of map.objects) {
    if (obj.resource && remainingById.has(obj.id)) {
      obj.resource.remaining = remainingById.get(obj.id)!;
    }
  }

  return map;
}

/** The world's creation timestamp (epoch ms), used as the fixed reference point for the day/night cycle. */
export function loadWorldCreatedAt(db: Database.Database): number {
  const row = db.prepare("SELECT created_at FROM world WHERE id = 1").get() as { created_at: string } | undefined;
  if (!row) throw new Error("loadWorldCreatedAt called before the world row exists");
  return Date.parse(row.created_at.replace(" ", "T") + "Z");
}

export function persistNodeRemaining(db: Database.Database, objectId: string, remaining: number): void {
  db.prepare(
    `INSERT INTO resource_nodes (object_id, remaining) VALUES (?, ?)
     ON CONFLICT(object_id) DO UPDATE SET remaining = excluded.remaining`,
  ).run(objectId, remaining);
}

export function loadBuildings(db: Database.Database): Building[] {
  const rows = db.prepare("SELECT id, kind, x, y, owner_id, created_at FROM buildings").all() as Array<{
    id: string;
    kind: BuildingKind;
    x: number;
    y: number;
    owner_id: string;
    created_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    x: row.x,
    y: row.y,
    ownerId: row.owner_id,
    // SQLite's datetime('now') is "YYYY-MM-DD HH:MM:SS" (UTC, space-separated,
    // not ISO 8601) — swap in a "T" and "Z" so Date.parse reads it reliably.
    placedAt: Date.parse(row.created_at.replace(" ", "T") + "Z"),
  }));
}

/**
 * Inserts a building row. The UNIQUE(x, y) constraint is what actually
 * enforces "two concurrent placements on the same cell can't both succeed" —
 * mirrors the same atomic-slot-assignment pattern The Wall's `bricks` table
 * uses. A constraint violation here means another placement already won the
 * cell; the caller treats that exactly like any other build rejection.
 */
export function persistBuilding(db: Database.Database, building: Building): boolean {
  try {
    db.prepare(
      `INSERT INTO buildings (id, kind, x, y, owner_id) VALUES (?, ?, ?, ?, ?)`,
    ).run(building.id, building.kind, building.x, building.y, building.ownerId);
    return true;
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed/.test(err.message)) return false;
    throw err;
  }
}

export function loadChestItems(db: Database.Database, chestId: string): Record<ItemKind, number> {
  const rows = db
    .prepare("SELECT item_kind, quantity FROM chest_items WHERE chest_id = ?")
    .all(chestId) as Array<{ item_kind: ItemKind; quantity: number }>;
  const items = emptyInventory();
  for (const row of rows) items[row.item_kind] = row.quantity;
  return items;
}

export function persistChestItem(db: Database.Database, chestId: string, kind: ItemKind, quantity: number): void {
  db.prepare(
    `INSERT INTO chest_items (chest_id, item_kind, quantity) VALUES (?, ?, ?)
     ON CONFLICT(chest_id, item_kind) DO UPDATE SET quantity = excluded.quantity`,
  ).run(chestId, kind, quantity);
}

/**
 * Loads a stable player's persisted inventory, or an all-zero inventory if
 * they have no rows yet (first-ever join). Keyed by the verified identity's
 * id, not a per-connection id, so it survives reconnects and restarts.
 */
export function loadPlayerInventory(db: Database.Database, playerId: string): Record<ItemKind, number> {
  const rows = db
    .prepare("SELECT item_kind, quantity FROM player_inventory WHERE player_id = ?")
    .all(playerId) as Array<{ item_kind: ItemKind; quantity: number }>;
  const inventory = emptyInventory();
  for (const row of rows) inventory[row.item_kind] = row.quantity;
  return inventory;
}

/** Persists a player's full inventory in one transaction, so a reader never sees a half-written set of item rows. */
export function persistPlayerInventory(
  db: Database.Database,
  playerId: string,
  inventory: Record<ItemKind, number>,
): void {
  const upsert = db.prepare(
    `INSERT INTO player_inventory (player_id, item_kind, quantity) VALUES (?, ?, ?)
     ON CONFLICT(player_id, item_kind) DO UPDATE SET quantity = excluded.quantity`,
  );
  db.transaction(() => {
    for (const [kind, qty] of Object.entries(inventory)) {
      upsert.run(playerId, kind, qty);
    }
  })();
}

/** Loads a stable player's persisted health, defaulting to MAX_HEALTH if they have no row yet. */
export function loadPlayerHealth(db: Database.Database, playerId: string): number | undefined {
  const row = db.prepare("SELECT health FROM players WHERE id = ?").get(playerId) as
    | { health: number }
    | undefined;
  return row?.health;
}

export function persistPlayerHealth(db: Database.Database, playerId: string, health: number): void {
  db.prepare("UPDATE players SET health = ? WHERE id = ?").run(health, playerId);
}

export interface InitialRoomState {
  buildings: Building[];
  chestItems: Map<string, Record<ItemKind, number>>;
  enemySpawns: EnemySpawn[];
}

/**
 * Loads every piece of Room-constructor state that must be restored from
 * disk on startup. Factored out so the production server (src/server/index.ts)
 * and the integration test harness (spec/helpers/server-harness.ts) build a
 * Room from the exact same code path — a prior drift between the two (the
 * harness built a Room with no persistence hooks at all) meant every
 * "full stack" integration test silently exercised a server that never
 * wrote gameplay state to SQLite. See spec/state-consistency.spec.ts.
 */
export function loadInitialRoomState(db: Database.Database, map: WorldMap): InitialRoomState {
  const buildings = loadBuildings(db);
  const chestItems = new Map<string, Record<ItemKind, number>>(
    buildings.filter((b) => b.kind === "chest").map((b) => [b.id, loadChestItems(db, b.id)]),
  );
  return {
    buildings,
    chestItems,
    enemySpawns: enemySpawnsFor(map),
  };
}

/**
 * Builds the full RoomPersistence hook set backed by `db`. The single
 * source of truth for how a Room's mutations get written to SQLite — both
 * the production server and the integration test harness must use this
 * rather than hand-wiring a subset of hooks themselves.
 */
export function createRoomPersistence(db: Database.Database): RoomPersistence {
  return {
    nodeRemaining: (objectId, remaining) => persistNodeRemaining(db, objectId, remaining),
    building: (building) => persistBuilding(db, building),
    chestItem: (chestId, kind, quantity) => persistChestItem(db, chestId, kind, quantity),
    playerInventory: (playerId, inventory) => persistPlayerInventory(db, playerId, inventory),
    playerHealth: (playerId, health) => persistPlayerHealth(db, playerId, health),
  };
}
