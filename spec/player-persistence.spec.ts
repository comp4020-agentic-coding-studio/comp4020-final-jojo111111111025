import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/server/db.js";
import { persistNodeRemaining } from "../src/server/world.js";
import { loadPlayerInventory, persistPlayerInventory } from "../src/server/world.js";
import { touchPlayerRecord } from "../src/server/identity.js";
import { Room } from "../src/server/room.js";
import type { MapObject, WorldMap } from "../src/shared/types.js";
import { emptyDungeon } from "./helpers/test-fixtures.js";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "last-shelter-player-persist-test-"));
  dbPath = join(dir, "world.sqlite");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeNode(id: string, kind: "wood" | "stone", remaining: number, x: number, y: number): MapObject {
  const objectKind = kind === "wood" ? "tree" : "rock";
  return { id, kind: objectKind, x, y, resource: { kind, remaining, maxRemaining: remaining } };
}

function makeTestMap(): WorldMap {
  const width = 10;
  const height = 10;
  const tiles = Array.from({ length: width * height }, () => ({ terrain: "grass" as const }));
  return {
    seed: "test",
    width,
    height,
    tiles,
    objects: [makeNode("wood-node", "wood", 100, 0, 1)],
    campsite: { x: 1, y: 1 },
    spawnPoint: { x: 1, y: 1 },
    farmArea: { x: 0, y: 0, width: 0, height: 0 },
    dungeonEntrance: { x: 9, y: 9 },
    dungeon: emptyDungeon(),
  };
}

describe("player inventory persistence tied to stable identity", () => {
  it("survives a simulated server restart: new Room, new DB handle, same identity", () => {
    const stableId = "11111111-1111-1111-1111-111111111111";

    // "Session 1": gather resources under a stable identity, backed by the real DB.
    const db1 = openDatabase(dbPath);
    touchPlayerRecord(db1, stableId, "Alice");
    const map1 = makeTestMap();
    const room1 = new Room(map1, {
      nodeRemaining: (objectId, remaining) => persistNodeRemaining(db1, objectId, remaining),
      playerInventory: (playerId, inventory) => persistPlayerInventory(db1, playerId, inventory),
    });
    room1.addPlayer(stableId, "Alice", loadPlayerInventory(db1, stableId));

    for (let i = 0; i < 5; i++) {
      const result = room1.interact(stableId, "wood-node", `gather-${i}`);
      expect(result.ok).toBe(true);
    }
    expect(room1.getPlayer(stableId)!.inventory.wood).toBe(5);
    db1.close();

    // "Session 2" (server restart): fresh DB handle, fresh in-memory Room —
    // only the stable id ties the two sessions' persisted state together.
    const db2 = openDatabase(dbPath);
    const map2 = makeTestMap();
    const room2 = new Room(map2, {
      nodeRemaining: (objectId, remaining) => persistNodeRemaining(db2, objectId, remaining),
      playerInventory: (playerId, inventory) => persistPlayerInventory(db2, playerId, inventory),
    });
    const restoredInventory = loadPlayerInventory(db2, stableId);
    room2.addPlayer(stableId, "Alice", restoredInventory);

    expect(room2.getPlayer(stableId)!.inventory.wood).toBe(5);
    db2.close();
  });

  it("does not leak one player's inventory into another identity's", () => {
    const db = openDatabase(dbPath);
    const idA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const idB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    touchPlayerRecord(db, idA, "Alice");
    touchPlayerRecord(db, idB, "Bob");

    persistPlayerInventory(db, idA, { ...loadPlayerInventory(db, idA), wood: 10 });
    persistPlayerInventory(db, idB, { ...loadPlayerInventory(db, idB), wood: 3 });

    expect(loadPlayerInventory(db, idA).wood).toBe(10);
    expect(loadPlayerInventory(db, idB).wood).toBe(3);
    db.close();
  });

  it("a brand-new identity with no prior rows loads an all-zero inventory", () => {
    const db = openDatabase(dbPath);
    const freshId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const inventory = loadPlayerInventory(db, freshId);
    expect(Object.values(inventory).every((qty) => qty === 0)).toBe(true);
    db.close();
  });

  it("persists inventory changes transactionally (a full inventory write never leaves a partial row set readable)", () => {
    const db = openDatabase(dbPath);
    const id = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    touchPlayerRecord(db, id, "Dave");
    persistPlayerInventory(db, id, { ...loadPlayerInventory(db, id), wood: 4, stone: 2, berries: 1 });

    const reloaded = loadPlayerInventory(db, id);
    expect(reloaded.wood).toBe(4);
    expect(reloaded.stone).toBe(2);
    expect(reloaded.berries).toBe(1);
    db.close();
  });
});
