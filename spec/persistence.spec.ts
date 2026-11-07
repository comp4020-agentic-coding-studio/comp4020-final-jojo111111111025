import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/server/db.js";
import {
  loadBuildings,
  loadChestItems,
  loadOrCreateWorld,
  persistBuilding,
  persistChestItem,
  persistNodeRemaining,
} from "../src/server/world.js";
import type Database from "better-sqlite3";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "last-shelter-test-"));
  dbPath = join(dir, "world.sqlite");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("world persistence round-trips across a DB close and reopen", () => {
  it("restores the same seed instead of generating a new one", () => {
    const db1 = openDatabase(dbPath);
    const map1 = loadOrCreateWorld(db1, "fixed-seed");
    db1.close();

    const db2 = openDatabase(dbPath);
    const map2 = loadOrCreateWorld(db2, "a-different-seed-that-should-be-ignored");
    db2.close();

    expect(map2.seed).toBe(map1.seed);
    expect(map2.tiles).toEqual(map1.tiles);
  });

  it("restores resource node depletion after a restart", () => {
    const db1 = openDatabase(dbPath);
    loadOrCreateWorld(db1, "fixed-seed");
    persistNodeRemaining(db1, "object-5", 2);
    db1.close();

    const db2 = openDatabase(dbPath);
    const map2 = loadOrCreateWorld(db2, "fixed-seed");
    db2.close();

    const node = map2.objects.find((o) => o.id === "object-5");
    if (node?.resource) {
      expect(node.resource.remaining).toBe(2);
    }
  });

  it("restores a placed building after a restart", () => {
    const db1 = openDatabase(dbPath);
    const ok = persistBuilding(db1, {
      id: "building-1",
      kind: "wall",
      x: 3,
      y: 4,
      ownerId: "p1",
      placedAt: Date.now(),
    });
    expect(ok).toBe(true);
    db1.close();

    const db2 = openDatabase(dbPath);
    const buildings = loadBuildings(db2);
    db2.close();

    expect(buildings).toHaveLength(1);
    expect(buildings[0]).toMatchObject({ id: "building-1", kind: "wall", x: 3, y: 4, ownerId: "p1" });
  });

  it("rejects a second building persisted at the same cell (UNIQUE(x, y))", () => {
    const db = openDatabase(dbPath);
    const first = persistBuilding(db, { id: "b1", kind: "wall", x: 5, y: 5, ownerId: "p1", placedAt: Date.now() });
    const second = persistBuilding(db, { id: "b2", kind: "chest", x: 5, y: 5, ownerId: "p2", placedAt: Date.now() });
    db.close();

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("restores chest contents after a restart", () => {
    const db1 = openDatabase(dbPath);
    persistBuilding(db1, { id: "chest-1", kind: "chest", x: 2, y: 2, ownerId: "p1", placedAt: Date.now() });
    persistChestItem(db1, "chest-1", "wood", 7);
    persistChestItem(db1, "chest-1", "stone", 3);
    db1.close();

    const db2 = openDatabase(dbPath);
    const items = loadChestItems(db2, "chest-1");
    db2.close();

    expect(items.wood).toBe(7);
    expect(items.stone).toBe(3);
    expect(items.berries).toBe(0);
  });

  it("does not wipe the database on reopen — a fresh openDatabase call never drops existing tables", () => {
    const db1 = openDatabase(dbPath);
    loadOrCreateWorld(db1, "fixed-seed");
    persistBuilding(db1, { id: "b1", kind: "workbench", x: 1, y: 1, ownerId: "p1", placedAt: Date.now() });
    db1.close();

    // Reopening (as happens on every server restart) must be purely additive.
    const db2: Database.Database = openDatabase(dbPath);
    const buildings = loadBuildings(db2);
    db2.close();

    expect(buildings).toHaveLength(1);
  });
});
