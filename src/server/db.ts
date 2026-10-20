import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MAX_HEALTH } from "../shared/constants.js";

export function openDatabase(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS world (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      seed TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS resource_nodes (
      object_id TEXT PRIMARY KEY,
      remaining INTEGER NOT NULL CHECK (remaining >= 0)
    );

    CREATE TABLE IF NOT EXISTS buildings (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      x INTEGER NOT NULL,
      y INTEGER NOT NULL,
      owner_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (x, y)
    );

    CREATE TABLE IF NOT EXISTS chest_items (
      chest_id TEXT NOT NULL,
      item_kind TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity >= 0),
      PRIMARY KEY (chest_id, item_kind),
      FOREIGN KEY (chest_id) REFERENCES buildings(id)
    );

    CREATE TABLE IF NOT EXISTS farm_plots (
      building_id TEXT PRIMARY KEY,
      seed_kind TEXT,
      planted_at INTEGER,
      watered_at INTEGER,
      FOREIGN KEY (building_id) REFERENCES buildings(id)
    );

    CREATE TABLE IF NOT EXISTS session_secret (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      secret BLOB NOT NULL
    );

    CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      revoked_at TEXT
    );

    CREATE TABLE IF NOT EXISTS player_inventory (
      player_id TEXT NOT NULL,
      item_kind TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity >= 0),
      PRIMARY KEY (player_id, item_kind),
      FOREIGN KEY (player_id) REFERENCES players(id)
    );

    CREATE TABLE IF NOT EXISTS world_progress (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      beacon_wood INTEGER NOT NULL DEFAULT 0 CHECK (beacon_wood >= 0),
      beacon_stone INTEGER NOT NULL DEFAULT 0 CHECK (beacon_stone >= 0),
      beacon_ancient_core INTEGER NOT NULL DEFAULT 0 CHECK (beacon_ancient_core >= 0),
      boss_defeated_at TEXT,
      completed_at TEXT
    );

    -- A reward earned (e.g. a boss-kill ancient_core) but not yet fully
    -- handed to the player's live inventory, because they weren't present in
    -- the Room at the moment it was earned (evicted after a disconnect), or
    -- because their inventory didn't have room for all of it at claim time.
    -- quantity is the total ever earned by this row; claimed_quantity is how
    -- much of that has actually been merged into player_inventory so far
    -- (0 <= claimed_quantity <= quantity) -- a claim that doesn't fully fit
    -- grants claimed_quantity up to the available room and leaves the row
    -- open (claimed_at still NULL) for the remainder to be claimed on a
    -- later join. claimed_at is set only once claimed_quantity reaches
    -- quantity (see claimAndApplyPendingRewards in world.ts).
    CREATE TABLE IF NOT EXISTS pending_rewards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id TEXT NOT NULL,
      item_kind TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      claimed_quantity INTEGER NOT NULL DEFAULT 0 CHECK (claimed_quantity >= 0 AND claimed_quantity <= quantity),
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      claimed_at TEXT,
      FOREIGN KEY (player_id) REFERENCES players(id)
    );
  `);

  // players.health was added in Phase D, after the table already existed in
  // deployed databases — SQLite's ALTER TABLE ADD COLUMN has no "IF NOT
  // EXISTS", so check first. Additive only: never drops or renames a column.
  const playerColumns = db.prepare("PRAGMA table_info(players)").all() as Array<{ name: string }>;
  if (!playerColumns.some((c) => c.name === "health")) {
    db.exec(`ALTER TABLE players ADD COLUMN health INTEGER NOT NULL DEFAULT ${MAX_HEALTH}`);
  }

  db.prepare("INSERT OR IGNORE INTO world_progress (id) VALUES (1)").run();
}
