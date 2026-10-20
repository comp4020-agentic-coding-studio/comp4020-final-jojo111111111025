import { describe, expect, it } from "vitest";
import { Room } from "../src/server/room.js";
import {
  BEACON_REQUIRED_ANCIENT_CORE,
  BEACON_REQUIRED_STONE,
  BEACON_REQUIRED_WOOD,
} from "../src/shared/constants.js";
import type { WorldMap } from "../src/shared/types.js";
import { emptyInventory } from "../src/shared/types.js";

function makeTestDungeon() {
  const width = 6;
  const height = 6;
  return {
    width,
    height,
    tiles: Array.from({ length: width * height }, () => ({ terrain: "grass" as const })),
    objects: [
      { id: "beacon-1", kind: "ancient_beacon" as const, x: 3, y: 3, zone: "dungeon" as const },
      { id: "dungeon-exit-1", kind: "dungeon_exit" as const, x: 1, y: 1, zone: "dungeon" as const },
    ],
    entryPoint: { x: 1, y: 1 },
    beaconLocation: { x: 3, y: 3 },
  };
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
    objects: [{ id: "entrance-1", kind: "dungeon_entrance", x: 5, y: 5, zone: "overworld" }],
    campsite: { x: 1, y: 1 },
    spawnPoint: { x: 5, y: 6 }, // in range of entrance-1
    farmArea: { x: 0, y: 0, width: 0, height: 0 },
    dungeonEntrance: { x: 5, y: 5 },
    dungeon: makeTestDungeon(),
  };
}

/** Builds a room, adds a player, and moves them into the dungeon near the beacon (3.5, 3.5). */
function setupPlayerAtBeacon(
  persistence: ConstructorParameters<typeof Room>[1] = {},
  bossAlreadyDefeated = false,
  initialBeaconMaterials: Partial<Record<"wood" | "stone" | "ancient_core", number>> = {},
  inventory = emptyInventory(),
): Room {
  const room = new Room(
    makeTestMap(),
    persistence,
    [],
    new Map(),
    [],
    Date.now,
    Date.now(),
    [],
    bossAlreadyDefeated,
    initialBeaconMaterials,
  );
  room.addPlayer("p1", "Alice", inventory);
  room.enterZone("p1", "entrance-1", "dungeon", "enter-1");
  // Walk from the dungeon entry point (1.5, 1.5) to right next to the beacon (3.5, 3.5).
  for (let i = 0; i < 50; i++) {
    const p = room.getPlayer("p1")!;
    if (Math.hypot(p.x - 3.5, p.y - 3.5) < 1) break;
    room.setInput("p1", 1, 1);
    room.tick(0.1);
  }
  return room;
}

describe("Room.depositBeacon — validation", () => {
  it("rejects a deposit from an unknown player", () => {
    const room = setupPlayerAtBeacon();
    const result = room.depositBeacon("ghost", "wood", 1, "r1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unknown_player");
  });

  it("rejects a deposit from a player in the overworld", () => {
    const room = new Room(makeTestMap());
    room.addPlayer("p1", "Alice", { ...emptyInventory(), wood: 5 });
    const result = room.depositBeacon("p1", "wood", 1, "r1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("wrong_zone");
  });

  it("rejects a deposit when the player doesn't have enough of the material", () => {
    const room = setupPlayerAtBeacon();
    const result = room.depositBeacon("p1", "wood", 1, "r1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("insufficient_materials");
  });

  it("rejects a non-positive quantity", () => {
    const room = setupPlayerAtBeacon({}, false, {}, { ...emptyInventory(), wood: 5 });
    const result = room.depositBeacon("p1", "wood", 0, "r1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_quantity");
  });
});

describe("Room.depositBeacon — success", () => {
  it("moves materials from the player's inventory into the shared, durable pool", () => {
    const deposits: Array<{ kind: string; qty: number }> = [];
    const room = setupPlayerAtBeacon(
      { beaconDeposit: (kind, qty) => deposits.push({ kind, qty }) },
      false,
      {},
      { ...emptyInventory(), wood: 5 },
    );
    const result = room.depositBeacon("p1", "wood", 3, "r1");
    expect(result.ok).toBe(true);
    expect(room.getPlayer("p1")!.inventory.wood).toBe(2);
    expect(room.getBeaconProgress().wood).toBe(3);
    expect(deposits).toEqual([{ kind: "wood", qty: 3 }]);
  });

  it("is additive across two different players depositing concurrently (no overwrite)", () => {
    const room = setupPlayerAtBeacon({}, false, {}, { ...emptyInventory(), wood: 10 });
    room.addPlayer("p2", "Bob", { ...emptyInventory(), wood: 10 });
    room.enterZone("p2", "entrance-1", "dungeon", "enter-2");
    for (let i = 0; i < 50; i++) {
      const p = room.getPlayer("p2")!;
      if (Math.hypot(p.x - 3.5, p.y - 3.5) < 1) break;
      room.setInput("p2", 1, 1);
      room.tick(0.1);
    }

    const r1 = room.depositBeacon("p1", "wood", 4, "d1");
    const r2 = room.depositBeacon("p2", "wood", 6, "d2");
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(room.getBeaconProgress().wood).toBe(10);
  });

  it("deduplicates a repeated requestId rather than double-depositing", () => {
    const room = setupPlayerAtBeacon({}, false, {}, { ...emptyInventory(), wood: 5 });
    room.depositBeacon("p1", "wood", 2, "dup-1");
    room.depositBeacon("p1", "wood", 2, "dup-1");
    expect(room.getBeaconProgress().wood).toBe(2);
    expect(room.getPlayer("p1")!.inventory.wood).toBe(3);
  });
});

describe("Room.activateBeacon — validation", () => {
  it("rejects activation when the boss hasn't been defeated, even with full materials", () => {
    const room = setupPlayerAtBeacon(
      {},
      false,
      { wood: BEACON_REQUIRED_WOOD, stone: BEACON_REQUIRED_STONE, ancient_core: BEACON_REQUIRED_ANCIENT_CORE },
    );
    const result = room.activateBeacon("p1", "r1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("boss_not_defeated");
  });

  it("rejects activation when materials are insufficient, even with the boss defeated", () => {
    const room = setupPlayerAtBeacon({}, true, { wood: 1, stone: 1, ancient_core: 1 });
    const result = room.activateBeacon("p1", "r1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("insufficient_materials");
  });

  it("rejects activation from the overworld", () => {
    const room = new Room(
      makeTestMap(),
      {},
      [],
      new Map(),
      [],
      Date.now,
      Date.now(),
      [],
      true,
      { wood: BEACON_REQUIRED_WOOD, stone: BEACON_REQUIRED_STONE, ancient_core: BEACON_REQUIRED_ANCIENT_CORE },
    );
    room.addPlayer("p1", "Alice");
    const result = room.activateBeacon("p1", "r1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("wrong_zone");
  });

  it("rejects a second activation after the beacon is already lit", () => {
    const room = setupPlayerAtBeacon(
      {},
      true,
      { wood: BEACON_REQUIRED_WOOD, stone: BEACON_REQUIRED_STONE, ancient_core: BEACON_REQUIRED_ANCIENT_CORE },
    );
    const first = room.activateBeacon("p1", "r1");
    expect(first.ok).toBe(true);
    const second = room.activateBeacon("p1", "r2");
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("already_activated");
  });
});

describe("Room.activateBeacon — concurrent activation race", () => {
  it("only the first of two concurrent activate requests wins when persistence's atomic check is the source of truth", () => {
    // Simulates two different server processes (or two requests landing in
    // the same tick) racing to flip the same durable `completed_at` row: the
    // first call to the persistence hook wins, the second sees it already
    // claimed — mirroring activateBeacon()'s real `WHERE completed_at IS
    // NULL` semantics in world.ts without needing a real SQLite file here.
    let claimed = false;
    const persistence = {
      activateBeacon: () => {
        if (claimed) return false;
        claimed = true;
        return true;
      },
    };
    const room = setupPlayerAtBeacon(
      persistence,
      true,
      { wood: BEACON_REQUIRED_WOOD, stone: BEACON_REQUIRED_STONE, ancient_core: BEACON_REQUIRED_ANCIENT_CORE },
    );

    const first = room.activateBeacon("p1", "race-1");
    const second = room.activateBeacon("p1", "race-2"); // different requestId — not deduped, a genuine second call

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("already_activated");
  });
});

describe("Room.getBeaconProgress", () => {
  it("reports the static requirements alongside the current durable totals", () => {
    const room = setupPlayerAtBeacon({}, false, { wood: 4, stone: 2, ancient_core: 0 });
    const progress = room.getBeaconProgress();
    expect(progress).toEqual({
      wood: 4,
      stone: 2,
      ancientCore: 0,
      requiredWood: BEACON_REQUIRED_WOOD,
      requiredStone: BEACON_REQUIRED_STONE,
      requiredAncientCore: BEACON_REQUIRED_ANCIENT_CORE,
      bossDefeated: false,
      activated: false,
    });
  });
});
