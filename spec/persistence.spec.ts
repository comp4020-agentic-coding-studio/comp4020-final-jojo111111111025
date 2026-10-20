import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/server/db.js";
import { touchPlayerRecord } from "../src/server/identity.js";
import { ITEM_STACK_LIMIT } from "../src/shared/constants.js";
import {
  claimAndApplyPendingRewards,
  grantPendingReward,
  loadBuildings,
  loadChestItems,
  loadOrCreateWorld,
  loadPlayerInventory,
  persistBuilding,
  persistChestItem,
  persistNodeRemaining,
  persistPlayerInventory,
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

describe("pending_rewards — durable boss-kill reward queue", () => {
  function withPlayer(db: Database.Database, id: string): void {
    touchPlayerRecord(db, id, "Alice");
  }

  /** Reads a pending_rewards row's claim state directly, for asserting on exactly what got committed. */
  function rewardRow(db: Database.Database, playerId: string): { quantity: number; claimed_quantity: number; claimed_at: string | null } {
    return db
      .prepare("SELECT quantity, claimed_quantity, claimed_at FROM pending_rewards WHERE player_id = ?")
      .get(playerId) as { quantity: number; claimed_quantity: number; claimed_at: string | null };
  }

  it("a successful claim updates inventory and claim state together", () => {
    const db = openDatabase(dbPath);
    withPlayer(db, "p1");
    grantPendingReward(db, "p1", "ancient_core", 1, "boss_kill");

    const result = claimAndApplyPendingRewards(db, "p1");
    const persistedInventory = loadPlayerInventory(db, "p1");
    const row = rewardRow(db, "p1");
    db.close();

    expect(result.claimed).toEqual([{ itemKind: "ancient_core", quantity: 1 }]);
    expect(result.inventory.ancient_core).toBe(1);
    expect(result.hasRemaining).toBe(false);
    // The in-memory result and what actually landed in player_inventory agree.
    expect(persistedInventory.ancient_core).toBe(1);
    expect(row.claimed_quantity).toBe(1);
    expect(row.claimed_at).not.toBeNull();
  });

  it("claiming twice only grants the reward once — the second claim is empty (idempotent)", () => {
    const db = openDatabase(dbPath);
    withPlayer(db, "p1");
    grantPendingReward(db, "p1", "ancient_core", 1, "boss_kill");

    const first = claimAndApplyPendingRewards(db, "p1");
    const second = claimAndApplyPendingRewards(db, "p1");
    db.close();

    expect(first.claimed).toEqual([{ itemKind: "ancient_core", quantity: 1 }]);
    expect(second.claimed).toEqual([]);
    expect(second.inventory.ancient_core).toBe(1); // unchanged, not re-granted
  });

  it("a reward survives a DB close and reopen, and is claimed exactly once across the restart", () => {
    const db1 = openDatabase(dbPath);
    withPlayer(db1, "p1");
    grantPendingReward(db1, "p1", "ancient_core", 1, "boss_kill");
    db1.close();

    const db2 = openDatabase(dbPath);
    const claimed = claimAndApplyPendingRewards(db2, "p1");
    const reclaimed = claimAndApplyPendingRewards(db2, "p1");
    db2.close();

    expect(claimed.claimed).toEqual([{ itemKind: "ancient_core", quantity: 1 }]);
    expect(reclaimed.claimed).toEqual([]);
  });

  it("multiple queued rewards for the same identity are all granted together, summed by item kind", () => {
    const db = openDatabase(dbPath);
    withPlayer(db, "p1");
    grantPendingReward(db, "p1", "ancient_core", 1, "boss_kill");
    grantPendingReward(db, "p1", "ancient_core", 1, "boss_kill"); // e.g. two separate boss kills before ever rejoining

    const result = claimAndApplyPendingRewards(db, "p1");
    db.close();

    expect(result.claimed).toEqual([{ itemKind: "ancient_core", quantity: 2 }]);
    expect(result.inventory.ancient_core).toBe(2);
  });

  it("a reward queued for one identity is never claimable by another", () => {
    const db = openDatabase(dbPath);
    withPlayer(db, "p1");
    withPlayer(db, "p2");
    grantPendingReward(db, "p1", "ancient_core", 1, "boss_kill");

    const wrongClaim = claimAndApplyPendingRewards(db, "p2");
    const rightClaim = claimAndApplyPendingRewards(db, "p1");
    db.close();

    expect(wrongClaim.claimed).toEqual([]);
    expect(rightClaim.claimed).toEqual([{ itemKind: "ancient_core", quantity: 1 }]);
  });

  it("an identity with no pending rewards gets back an empty claimed list and their unchanged inventory, not an error", () => {
    const db = openDatabase(dbPath);
    withPlayer(db, "p1");
    persistPlayerInventory(db, "p1", { ...loadPlayerInventory(db, "p1"), wood: 5 });
    const result = claimAndApplyPendingRewards(db, "p1");
    db.close();
    expect(result.claimed).toEqual([]);
    expect(result.inventory.wood).toBe(5);
  });

  it("repeated sequential claim calls for the same identity never both grant the same reward (claimed_at IS NULL guards the race)", () => {
    const db = openDatabase(dbPath);
    withPlayer(db, "p1");
    grantPendingReward(db, "p1", "ancient_core", 1, "boss_kill");

    // better-sqlite3 is synchronous, so two "concurrent" calls from the same
    // process are actually sequential — this proves the guard still behaves
    // correctly under that sequencing: the second call has nothing left to
    // claim, exactly as it would if a second real process raced and lost.
    // The cross-process case (two real processes against the same WAL-mode
    // file) is covered below using two separate db handles.
    const claimA = claimAndApplyPendingRewards(db, "p1");
    const claimB = claimAndApplyPendingRewards(db, "p1");
    db.close();

    expect(claimA.claimed).toEqual([{ itemKind: "ancient_core", quantity: 1 }]);
    expect(claimB.claimed).toEqual([]);
    expect(claimA.inventory.ancient_core + (claimB.claimed[0]?.quantity ?? 0)).toBe(1);
  });

  it("two separate database connections to the same file never both grant the same reward", () => {
    // Two independent better-sqlite3 handles on the same on-disk file (WAL
    // mode) stand in for two server processes racing a claim for the same
    // identity — a closer approximation of real cross-process concurrency
    // than two calls on one shared handle.
    const dbA = openDatabase(dbPath);
    withPlayer(dbA, "p1");
    grantPendingReward(dbA, "p1", "ancient_core", 1, "boss_kill");
    dbA.close();

    const dbB1 = openDatabase(dbPath);
    const dbB2 = openDatabase(dbPath);

    const resultA = claimAndApplyPendingRewards(dbB1, "p1");
    const resultB = claimAndApplyPendingRewards(dbB2, "p1");
    dbB1.close();
    dbB2.close();

    const totalGranted = (resultA.claimed[0]?.quantity ?? 0) + (resultB.claimed[0]?.quantity ?? 0);
    expect(totalGranted).toBe(1);

    const dbCheck = openDatabase(dbPath);
    expect(loadPlayerInventory(dbCheck, "p1").ancient_core).toBe(1);
    dbCheck.close();
  });

  /**
   * Forces a genuine interleaving of two connections' transactions, rather
   * than two merely-sequential calls: connection A's own `pending_rewards`
   * SELECT is monkey-patched so that, immediately after it returns (A's
   * transaction has started and taken its WAL snapshot, but A has not yet
   * written), connection B runs its own complete claimAndApplyPendingRewards
   * call against the *same* row and commits. A's transaction then attempts
   * its write against a snapshot that's now stale relative to the committed
   * row — this is exactly the condition that previously surfaced as an
   * uncaught SQLITE_BUSY_SNAPSHOT thrown out of claimAndApplyPendingRewards.
   */
  function claimWithInterleavedConflict(
    db: Database.Database,
    playerId: string,
    onSnapshotEstablished: () => void,
  ): ReturnType<typeof claimAndApplyPendingRewards> {
    const originalPrepare = db.prepare.bind(db);
    let intercepted = false;
    (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
      const stmt = originalPrepare(sql);
      if (!intercepted && sql.includes("SELECT id, item_kind, quantity, claimed_quantity FROM pending_rewards")) {
        intercepted = true;
        const originalAll = stmt.all.bind(stmt);
        stmt.all = ((...args: unknown[]) => {
          const result = originalAll(...(args as []));
          onSnapshotEstablished();
          return result;
        }) as typeof stmt.all;
      }
      return stmt;
    }) as typeof db.prepare;

    try {
      return claimAndApplyPendingRewards(db, playerId);
    } finally {
      (db as unknown as { prepare: typeof db.prepare }).prepare = originalPrepare;
    }
  }

  it("two connections racing a genuinely interleaved partial claim on the same row never duplicate, lose, or overflow — and neither throws", () => {
    const dbSetup = openDatabase(dbPath);
    withPlayer(dbSetup, "p1");
    // Only 3 slots of room; far more than that is queued, so both
    // connections will each try to claim against the same limited room.
    persistPlayerInventory(dbSetup, "p1", { ...loadPlayerInventory(dbSetup, "p1"), ancient_core: ITEM_STACK_LIMIT - 3 });
    grantPendingReward(dbSetup, "p1", "ancient_core", 10, "boss_kill");
    dbSetup.close();

    const dbA = openDatabase(dbPath);
    const dbB = openDatabase(dbPath);

    let resultB: ReturnType<typeof claimAndApplyPendingRewards> | undefined;
    let resultA: ReturnType<typeof claimAndApplyPendingRewards> | undefined;
    let thrown: unknown;
    try {
      resultA = claimWithInterleavedConflict(dbA, "p1", () => {
        // B commits its own complete claim while A's transaction is open,
        // mid-callback, after A's own read but before A's write.
        resultB = claimAndApplyPendingRewards(dbB, "p1");
      });
    } catch (err) {
      thrown = err;
    }
    dbA.close();
    dbB.close();

    // The defining requirement: no unhandled failure from a legitimate race —
    // claimAndApplyPendingRewards must retry internally and return normally.
    expect(thrown).toBeUndefined();
    expect(resultB).toBeDefined();
    expect(resultA).toBeDefined();

    // No duplicate grants, no lost quantity: exactly the available 3 slots
    // of room were granted in total, split however the two actually landed.
    const grantedA = resultA!.claimed[0]?.quantity ?? 0;
    const grantedB = resultB!.claimed[0]?.quantity ?? 0;
    expect(grantedA + grantedB).toBe(3);

    // No stack overflow: inventory landed exactly at the cap, never beyond.
    const dbCheck = openDatabase(dbPath);
    const finalInventory = loadPlayerInventory(dbCheck, "p1");
    expect(finalInventory.ancient_core).toBe(ITEM_STACK_LIMIT);

    // No lost quantity on the reward side either: the row still remembers
    // exactly how much was claimed and how much is still owed (7), rather
    // than silently dropping the unclaimed remainder.
    const row = dbCheck
      .prepare("SELECT quantity, claimed_quantity, claimed_at FROM pending_rewards WHERE player_id = ?")
      .get("p1") as { quantity: number; claimed_quantity: number; claimed_at: string | null };
    dbCheck.close();
    expect(row.quantity).toBe(10);
    expect(row.claimed_quantity).toBe(3);
    expect(row.claimed_at).toBeNull(); // 7 units still pending, not discarded
  });

  it("a failed inventory write rolls back the claim, leaving the reward fully available for a later attempt", () => {
    const db = openDatabase(dbPath);
    withPlayer(db, "p1");
    grantPendingReward(db, "p1", "ancient_core", 1, "boss_kill");

    // Simulate a mid-transaction failure (crash, disk error, thrown
    // exception) at the point where the merged inventory is written, by
    // making that specific prepared statement throw.
    const originalPrepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      if (sql.includes("INSERT INTO player_inventory")) {
        throw new Error("simulated failure writing player_inventory");
      }
      return originalPrepare(sql);
    }) as typeof db.prepare;

    expect(() => claimAndApplyPendingRewards(db, "p1")).toThrow("simulated failure writing player_inventory");

    db.prepare = originalPrepare;
    const row = rewardRow(db, "p1");
    const inventory = loadPlayerInventory(db, "p1");
    db.close();

    // Nothing committed: the reward is neither marked claimed nor partially
    // claimed, and nothing was written to player_inventory — the whole
    // transaction rolled back together, not just the half that failed.
    expect(row.claimed_quantity).toBe(0);
    expect(row.claimed_at).toBeNull();
    expect(inventory.ancient_core).toBe(0);

    // The reward is still fully claimable on a subsequent, un-mocked attempt.
    const db2 = openDatabase(dbPath);
    const retried = claimAndApplyPendingRewards(db2, "p1");
    db2.close();
    expect(retried.claimed).toEqual([{ itemKind: "ancient_core", quantity: 1 }]);
  });

  it("a full inventory does not discard the pending reward — it stays fully pending for a later claim", () => {
    const db = openDatabase(dbPath);
    withPlayer(db, "p1");
    persistPlayerInventory(db, "p1", { ...loadPlayerInventory(db, "p1"), ancient_core: ITEM_STACK_LIMIT });
    grantPendingReward(db, "p1", "ancient_core", 1, "boss_kill");

    const result = claimAndApplyPendingRewards(db, "p1");
    const row = rewardRow(db, "p1");
    db.close();

    expect(result.claimed).toEqual([]);
    expect(result.hasRemaining).toBe(true);
    expect(result.inventory.ancient_core).toBe(ITEM_STACK_LIMIT); // unchanged, never pushed over the cap
    expect(row.claimed_quantity).toBe(0);
    expect(row.claimed_at).toBeNull(); // still fully pending, not silently dropped
  });

  it("a partially full inventory receives only the amount that fits, leaving the remainder pending", () => {
    const db = openDatabase(dbPath);
    withPlayer(db, "p1");
    persistPlayerInventory(db, "p1", { ...loadPlayerInventory(db, "p1"), ancient_core: ITEM_STACK_LIMIT - 2 });
    grantPendingReward(db, "p1", "ancient_core", 5, "boss_kill"); // only 2 slots of room

    const result = claimAndApplyPendingRewards(db, "p1");
    const row = rewardRow(db, "p1");
    db.close();

    expect(result.claimed).toEqual([{ itemKind: "ancient_core", quantity: 2 }]);
    expect(result.hasRemaining).toBe(true);
    expect(result.inventory.ancient_core).toBe(ITEM_STACK_LIMIT); // filled exactly to the cap, never over
    expect(row.claimed_quantity).toBe(2);
    expect(row.quantity).toBe(5);
    expect(row.claimed_at).toBeNull(); // 3 units still owed
  });

  it("a later join can claim the remainder once inventory space becomes available", () => {
    const db = openDatabase(dbPath);
    withPlayer(db, "p1");
    persistPlayerInventory(db, "p1", { ...loadPlayerInventory(db, "p1"), ancient_core: ITEM_STACK_LIMIT - 2 });
    grantPendingReward(db, "p1", "ancient_core", 5, "boss_kill");

    const first = claimAndApplyPendingRewards(db, "p1");
    expect(first.claimed).toEqual([{ itemKind: "ancient_core", quantity: 2 }]);
    expect(first.hasRemaining).toBe(true);

    // Space frees up (e.g. the player used some ancient_core on a beacon deposit).
    persistPlayerInventory(db, "p1", { ...loadPlayerInventory(db, "p1"), ancient_core: 10 });

    const second = claimAndApplyPendingRewards(db, "p1");
    const row = rewardRow(db, "p1");
    db.close();

    expect(second.claimed).toEqual([{ itemKind: "ancient_core", quantity: 3 }]); // the remaining 3 of the original 5
    expect(second.hasRemaining).toBe(false);
    expect(second.inventory.ancient_core).toBe(13);
    expect(row.claimed_quantity).toBe(5);
    expect(row.claimed_at).not.toBeNull(); // now fully settled
  });

  it("a claim that only partially fits never duplicates the claimed portion on a subsequent call with no new space", () => {
    const db = openDatabase(dbPath);
    withPlayer(db, "p1");
    persistPlayerInventory(db, "p1", { ...loadPlayerInventory(db, "p1"), ancient_core: ITEM_STACK_LIMIT - 1 });
    grantPendingReward(db, "p1", "ancient_core", 3, "boss_kill");

    const first = claimAndApplyPendingRewards(db, "p1");
    const second = claimAndApplyPendingRewards(db, "p1"); // still no room; same call again
    db.close();

    expect(first.claimed).toEqual([{ itemKind: "ancient_core", quantity: 1 }]);
    expect(second.claimed).toEqual([]); // no room means nothing new is granted, and nothing already granted is re-granted
    expect(second.inventory.ancient_core).toBe(ITEM_STACK_LIMIT);
  });
});
