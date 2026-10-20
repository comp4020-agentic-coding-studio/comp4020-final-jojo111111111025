import type Database from "better-sqlite3";
import { DEFAULT_WORLD_SEED, ITEM_STACK_LIMIT } from "../shared/constants.js";
import { enemySpawnsFor, generateWorldMap } from "../shared/map.js";
import type { Building, BuildingKind, EnemySpawn, FarmPlotState, ItemKind, WorldMap } from "../shared/types.js";
import { emptyInventory } from "../shared/types.js";
import type { BeaconMaterial, RoomPersistence } from "./room.js";

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

export function loadFarmPlots(db: Database.Database): FarmPlotState[] {
  const rows = db
    .prepare("SELECT building_id, seed_kind, planted_at, watered_at FROM farm_plots")
    .all() as Array<{
    building_id: string;
    seed_kind: ItemKind | null;
    planted_at: number | null;
    watered_at: number | null;
  }>;
  return rows.map((row) => ({
    buildingId: row.building_id,
    seedKind: row.seed_kind,
    plantedAt: row.planted_at,
    wateredAt: row.watered_at,
  }));
}

export function persistFarmPlot(db: Database.Database, plot: FarmPlotState): void {
  db.prepare(
    `INSERT INTO farm_plots (building_id, seed_kind, planted_at, watered_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(building_id) DO UPDATE SET
       seed_kind = excluded.seed_kind,
       planted_at = excluded.planted_at,
       watered_at = excluded.watered_at`,
  ).run(plot.buildingId, plot.seedKind, plot.plantedAt, plot.wateredAt);
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

export interface WorldProgress {
  beaconWood: number;
  beaconStone: number;
  beaconAncientCore: number;
  bossDefeatedAt: number | null;
  completedAt: number | null;
}

function parseSqliteTimestamp(value: string | null): number | null {
  if (value === null) return null;
  return Date.parse(value.replace(" ", "T") + "Z");
}

export function loadWorldProgress(db: Database.Database): WorldProgress {
  const row = db
    .prepare(
      "SELECT beacon_wood, beacon_stone, beacon_ancient_core, boss_defeated_at, completed_at FROM world_progress WHERE id = 1",
    )
    .get() as
    | {
        beacon_wood: number;
        beacon_stone: number;
        beacon_ancient_core: number;
        boss_defeated_at: string | null;
        completed_at: string | null;
      }
    | undefined;
  if (!row) {
    return { beaconWood: 0, beaconStone: 0, beaconAncientCore: 0, bossDefeatedAt: null, completedAt: null };
  }
  return {
    beaconWood: row.beacon_wood,
    beaconStone: row.beacon_stone,
    beaconAncientCore: row.beacon_ancient_core,
    bossDefeatedAt: parseSqliteTimestamp(row.boss_defeated_at),
    completedAt: parseSqliteTimestamp(row.completed_at),
  };
}

/** Marks the boss defeated exactly once. A boss that's already marked defeated is left untouched — returns false so the caller doesn't re-grant anything on a redundant call. */
export function persistBossDefeated(db: Database.Database): boolean {
  const result = db
    .prepare("UPDATE world_progress SET boss_defeated_at = datetime('now') WHERE id = 1 AND boss_defeated_at IS NULL")
    .run();
  return result.changes > 0;
}

/** Adds to the beacon's shared material pool. Not a set — an additive deposit, mirroring chest deposits. */
export function depositBeaconMaterial(
  db: Database.Database,
  kind: "wood" | "stone" | "ancient_core",
  qty: number,
): void {
  const column = kind === "wood" ? "beacon_wood" : kind === "stone" ? "beacon_stone" : "beacon_ancient_core";
  db.prepare(`UPDATE world_progress SET ${column} = ${column} + ? WHERE id = 1`).run(qty);
}

/**
 * Atomically activates the beacon. The WHERE clause is what actually
 * prevents a double-win: if two `beacon.activate` requests race, only the
 * first UPDATE can match a row still at completed_at IS NULL — the second
 * affects zero rows and `activateBeacon` returns false, exactly the same
 * "let the constraint resolve the race" approach persistBuilding's
 * UNIQUE(x, y) already uses for concurrent building placement.
 */
export function activateBeacon(db: Database.Database): boolean {
  const result = db
    .prepare("UPDATE world_progress SET completed_at = datetime('now') WHERE id = 1 AND completed_at IS NULL")
    .run();
  return result.changes > 0;
}

/**
 * Durably queues a reward for a stable identity who isn't (or might not be)
 * present in the live Room to receive it immediately — e.g. a boss-kill
 * contributor who was evicted by the time the kill landed. `reason` is a
 * label only (e.g. "boss_kill"), not load-bearing for correctness.
 */
export function grantPendingReward(
  db: Database.Database,
  playerId: string,
  kind: ItemKind,
  qty: number,
  reason: string,
): void {
  db.prepare(
    `INSERT INTO pending_rewards (player_id, item_kind, quantity, reason) VALUES (?, ?, ?, ?)`,
  ).run(playerId, kind, qty, reason);
}

export interface ClaimedReward {
  itemKind: ItemKind;
  quantity: number;
}

export interface ClaimPendingRewardsResult {
  /** What was actually merged into the inventory this call, per item kind (already summed — a call can touch several pending_rewards rows of the same kind). */
  claimed: ClaimedReward[];
  /** The player's full inventory after merging — the same shape `loadPlayerInventory` returns, so the caller never needs a second read. */
  inventory: Record<ItemKind, number>;
  /** True if at least one pending reward still has an unclaimed remainder after this call (inventory had no room for all of it) — the caller can use this to tell the player something is still waiting. */
  hasRemaining: boolean;
}

/** better-sqlite3 throws these (and only these) when a WAL-mode transaction's read snapshot was invalidated by another connection's commit before this transaction could write — not a logic bug, just "re-read and try again." See claimAndApplyPendingRewards's retry loop. */
function isSqliteBusyError(err: unknown): err is { code: string } {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof (err as { code: unknown }).code === "string" &&
    (err as { code: string }).code.startsWith("SQLITE_BUSY")
  );
}

const CLAIM_PENDING_REWARDS_MAX_ATTEMPTS = 5;

/**
 * Atomically claims as much of a stable identity's pending rewards as fits
 * in their inventory, merges it into `player_inventory`, and marks each
 * reward row claimed (fully or partially) — all inside one SQLite
 * transaction. Nothing else may write `pending_rewards` or this identity's
 * `player_inventory` row between the read and the write, and a thrown
 * error anywhere in the callback (a crash, a CHECK violation, a disk
 * error) rolls the whole transaction back via better-sqlite3's own
 * transaction semantics — so a reward can never end up marked claimed
 * without the matching inventory write having committed, and never end up
 * written to inventory without the row being marked claimed. This replaces
 * the two-step claim-then-persist that a prior version of this function
 * used, which left exactly that gap between its two separate transactions.
 *
 * Partial claims: if the inventory doesn't have room for a reward's full
 * remaining quantity, only the available room is granted and that row's
 * `claimed_quantity` is advanced by that amount — `claimed_at` is left
 * NULL, so the rest stays pending and claimable on a later join once space
 * frees up. Normal inventory stacks are never pushed over ITEM_STACK_LIMIT
 * by this function; the reward itself is never discarded, only deferred.
 *
 * Cross-process concurrency: this transaction reads every row's current
 * quantity/claimed_quantity and the player's current inventory, then writes
 * based on what it read, entirely within one SQLite transaction — WAL mode
 * gives that transaction a single consistent snapshot for its whole
 * lifetime. If a second connection commits a conflicting change to the same
 * player's pending_rewards or player_inventory rows after this transaction's
 * snapshot was taken but before this transaction's own write lands, SQLite
 * detects the conflict at write time and this call throws SQLITE_BUSY /
 * SQLITE_BUSY_SNAPSHOT — it does *not* silently apply a stale write, and it
 * does *not* corrupt data (better-sqlite3 rolls the whole transaction back
 * automatically on any thrown error). The loop below catches exactly that
 * error family and retries the whole transaction from scratch — a fresh
 * read now sees the other connection's committed change, so the retry
 * computes a correct grant against current data, the same "let the
 * constraint resolve the race, then retry from a fresh read" idiom
 * `activateBeacon`'s WHERE-guarded UPDATE already uses for its own
 * concurrent-write case. Any other error (a genuine CHECK violation, a
 * disk error, anything not in the SQLITE_BUSY family) is never caught here
 * and propagates immediately.
 */
export function claimAndApplyPendingRewards(db: Database.Database, playerId: string): ClaimPendingRewardsResult {
  const attempt = db.transaction(() => {
    const inventory = loadPlayerInventory(db, playerId);
    const rows = db
      .prepare(
        "SELECT id, item_kind, quantity, claimed_quantity FROM pending_rewards WHERE player_id = ? AND claimed_at IS NULL ORDER BY id",
      )
      .all(playerId) as Array<{ id: number; item_kind: ItemKind; quantity: number; claimed_quantity: number }>;

    const claimedByKind = new Map<ItemKind, number>();
    let hasRemaining = false;
    let inventoryChanged = false;

    const advance = db.prepare(
      `UPDATE pending_rewards
       SET claimed_quantity = claimed_quantity + ?,
           claimed_at = CASE WHEN claimed_quantity + ? >= quantity THEN datetime('now') ELSE NULL END
       WHERE id = ? AND claimed_at IS NULL`,
    );

    for (const row of rows) {
      const remaining = row.quantity - row.claimed_quantity;
      if (remaining <= 0) continue; // already fully claimed by a concurrent writer that beat us here
      const room = ITEM_STACK_LIMIT - inventory[row.item_kind];
      const grant = Math.min(remaining, Math.max(0, room));
      if (grant <= 0) {
        hasRemaining = true;
        continue;
      }

      const result = advance.run(grant, grant, row.id);
      if (result.changes === 0) continue; // lost a race to another concurrent claim of this exact row

      inventory[row.item_kind] += grant;
      inventoryChanged = true;
      claimedByKind.set(row.item_kind, (claimedByKind.get(row.item_kind) ?? 0) + grant);
      if (grant < remaining) hasRemaining = true;
    }

    if (inventoryChanged) {
      persistPlayerInventory(db, playerId, inventory);
    }

    const claimed: ClaimedReward[] = [...claimedByKind.entries()].map(([itemKind, quantity]) => ({
      itemKind,
      quantity,
    }));
    return { claimed, inventory, hasRemaining };
  });

  for (let i = 0; i < CLAIM_PENDING_REWARDS_MAX_ATTEMPTS; i++) {
    try {
      return attempt();
    } catch (err) {
      if (!isSqliteBusyError(err) || i === CLAIM_PENDING_REWARDS_MAX_ATTEMPTS - 1) throw err;
      // Retry with a fresh read/write — see the doc comment above.
    }
  }
  // Unreachable: the loop above always either returns or throws on its last iteration.
  throw new Error("claimAndApplyPendingRewards: exhausted retries without returning or throwing");
}

export interface InitialRoomState {
  buildings: Building[];
  chestItems: Map<string, Record<ItemKind, number>>;
  farmPlots: FarmPlotState[];
  enemySpawns: EnemySpawn[];
  bossAlreadyDefeated: boolean;
  beaconMaterials: Partial<Record<BeaconMaterial, number>>;
  beaconActivated: boolean;
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
  const farmPlots = loadFarmPlots(db);
  const progress = loadWorldProgress(db);
  return {
    buildings,
    chestItems,
    farmPlots,
    enemySpawns: enemySpawnsFor(map),
    bossAlreadyDefeated: progress.bossDefeatedAt !== null,
    beaconMaterials: {
      wood: progress.beaconWood,
      stone: progress.beaconStone,
      ancient_core: progress.beaconAncientCore,
    },
    beaconActivated: progress.completedAt !== null,
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
    farmPlot: (plot) => persistFarmPlot(db, plot),
    playerInventory: (playerId, inventory) => persistPlayerInventory(db, playerId, inventory),
    playerHealth: (playerId, health) => persistPlayerHealth(db, playerId, health),
    bossDefeated: () => persistBossDefeated(db),
    beaconDeposit: (kind, qty) => depositBeaconMaterial(db, kind, qty),
    activateBeacon: () => activateBeacon(db),
    grantPendingReward: (playerId, kind, qty, reason) => grantPendingReward(db, playerId, kind, qty, reason),
  };
}
