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

  `);

  // players.health was added in Phase D, after the table already existed in
  // deployed databases — SQLite's ALTER TABLE ADD COLUMN has no "IF NOT
  // EXISTS", so check first. Additive only: never drops or renames a column.
  const playerColumns = db.prepare("PRAGMA table_info(players)").all() as Array<{ name: string }>;
  if (!playerColumns.some((c) => c.name === "health")) {
    db.exec(`ALTER TABLE players ADD COLUMN health INTEGER NOT NULL DEFAULT ${MAX_HEALTH}`);
  }
}
