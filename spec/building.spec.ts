import { describe, expect, it } from "vitest";
import { Room } from "../src/server/room.js";
import type { MapObject, WorldMap } from "../src/shared/types.js";
import { emptyDungeon } from "./helpers/test-fixtures.js";

function makeNode(id: string, kind: "wood" | "stone", remaining: number, x: number, y: number): MapObject {
  const objectKind = kind === "wood" ? "tree" : "rock";
  return { id, kind: objectKind, x, y, resource: { kind, remaining, maxRemaining: remaining } };
}

/** Spawn is a clear (1, 1); the gatherable nodes sit at (0, 1)/(0, 2), off the spawn cell, so players can always move away from spawn. */
function makeTestMap(extraObjects: MapObject[] = []): WorldMap {
  const width = 10;
  const height = 10;
  const tiles = Array.from({ length: width * height }, () => ({ terrain: "grass" as const }));
  return {
    seed: "test",
    width,
    height,
    tiles,
    objects: [
      makeNode("wood-node", "wood", 1000, 0, 1),
      makeNode("stone-node", "stone", 1000, 0, 2),
      ...extraObjects,
    ],
    campsite: { x: 1, y: 1 },
    spawnPoint: { x: 1, y: 1 },
    farmArea: { x: 0, y: 0, width: 0, height: 0 },
    dungeonEntrance: { x: 9, y: 9 },
    dungeon: emptyDungeon(),
  };
}

let grantCounter = 0;
function grantResource(room: Room, playerId: string, kind: "wood" | "stone", qty: number): void {
  const objectId = `${kind}-node`;
  for (let i = 0; i < qty; i++) {
    const result = room.interact(playerId, objectId, `grant-${objectId}-${grantCounter++}`);
    if (!result.ok) throw new Error(`grantResource failed: ${result.reason}`);
  }
}

describe("Room.build", () => {
  it("places a valid building and consumes the exact materials once", () => {
    const room = new Room(makeTestMap());
    room.addPlayer("p1", "Alice");
    grantResource(room, "p1", "wood", 2);
    grantResource(room, "p1", "stone", 1);

    const result = room.build("p1", "wall", 2, 2, "req-1");
    expect(result.ok).toBe(true);
    expect(result.buildingId).toBeDefined();

    const inv = room.getPlayer("p1")!.inventory;
    expect(inv.wood).toBe(0);
    expect(inv.stone).toBe(0);

    const buildings = room.getBuildings();
    expect(buildings).toHaveLength(1);
    expect(buildings[0]).toMatchObject({ kind: "wall", x: 2, y: 2, ownerId: "p1" });
  });

  it("a placed solid building blocks movement", () => {
    const room = new Room(makeTestMap());
    room.addPlayer("p1", "Alice");
    grantResource(room, "p1", "wood", 2);
    grantResource(room, "p1", "stone", 1);
    room.build("p1", "wall", 2, 1, "req-1"); // directly east of spawn (1,1)

    room.setInput("p1", 1, 0);
    for (let i = 0; i < 100; i++) room.tick(0.05);

    const player = room.getPlayer("p1")!;
    expect(player.x).toBeLessThan(2);
  });

  it("rejects placement on solid terrain/object and consumes nothing", () => {
    const room = new Room(makeTestMap());
    room.addPlayer("p1", "Alice");
    grantResource(room, "p1", "wood", 2);
    grantResource(room, "p1", "stone", 1);

    const result = room.build("p1", "wall", 0, 1, "req-1"); // (0,1) has the wood-node tree object
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("cell_occupied");
    expect(room.getPlayer("p1")!.inventory.wood).toBe(2);
  });

  it("rejects placement on an already-occupied building cell", () => {
    const room = new Room(makeTestMap());
    room.addPlayer("p1", "Alice");
    grantResource(room, "p1", "wood", 4);
    grantResource(room, "p1", "stone", 2);
    room.build("p1", "wall", 2, 2, "req-1");

    const result = room.build("p1", "wall", 2, 2, "req-2");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("cell_occupied");
    expect(room.getBuildings()).toHaveLength(1);
  });

  it("rejects placement out of range", () => {
    const room = new Room(makeTestMap());
    room.addPlayer("p1", "Alice");
    grantResource(room, "p1", "wood", 2);
    grantResource(room, "p1", "stone", 1);

    const result = room.build("p1", "wall", 8, 8, "req-1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("too_far");
    expect(room.getPlayer("p1")!.inventory.wood).toBe(2);
  });

  it("rejects placement out of bounds", () => {
    const room = new Room(makeTestMap());
    room.addPlayer("p1", "Alice");
    grantResource(room, "p1", "wood", 2);
    grantResource(room, "p1", "stone", 1);

    const result = room.build("p1", "wall", -1, 1, "req-1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("out_of_bounds");
  });

  it("rejects placement with insufficient materials, consuming nothing", () => {
    const room = new Room(makeTestMap());
    room.addPlayer("p1", "Alice");

    const result = room.build("p1", "wall", 2, 2, "req-1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("insufficient_materials");
    expect(room.getBuildings()).toHaveLength(0);
  });

  it("is idempotent for a repeated request ID: only places once", () => {
    const room = new Room(makeTestMap());
    room.addPlayer("p1", "Alice");
    grantResource(room, "p1", "wood", 2);
    grantResource(room, "p1", "stone", 1);

    const first = room.build("p1", "wall", 2, 2, "req-dup");
    const second = room.build("p1", "wall", 2, 2, "req-dup");

    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    expect(room.getBuildings()).toHaveLength(1);
  });

  it("two concurrent placement requests for the same cell: one wins, one is rejected via persistence", () => {
    // Simulates the database's UNIQUE(x, y) constraint rejecting the loser,
    // the same way two visitors racing for one Wall cell resolve in the
    // existing course project this one is modelled alongside.
    const claimedCells = new Set<string>();
    const room = new Room(makeTestMap(), {
      building: (building) => {
        const key = `${building.x},${building.y}`;
        if (claimedCells.has(key)) return false;
        claimedCells.add(key);
        return true;
      },
    });
    room.addPlayer("p1", "Alice");
    room.addPlayer("p2", "Bob");
    grantResource(room, "p1", "wood", 2);
    grantResource(room, "p1", "stone", 1);
    grantResource(room, "p2", "wood", 2);
    grantResource(room, "p2", "stone", 1);

    const first = room.build("p1", "wall", 2, 2, "req-a");
    const second = room.build("p2", "wall", 2, 2, "req-b");

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("cell_occupied");
    // The loser's materials must not be consumed.
    expect(room.getPlayer("p2")!.inventory.wood).toBe(2);
    expect(room.getPlayer("p2")!.inventory.stone).toBe(1);
  });
});

describe("Room.chestTransfer", () => {
  function placeChest(room: Room, playerId: string, x: number, y: number): string {
    grantResource(room, playerId, "wood", 5);
    const result = room.build(playerId, "chest", x, y, `chest-${grantCounter++}`);
    if (!result.ok || !result.buildingId) throw new Error("failed to place chest");
    return result.buildingId;
  }

  it("deposits items from the player into the chest", () => {
    const room = new Room(makeTestMap());
    room.addPlayer("p1", "Alice");
    const chestId = placeChest(room, "p1", 2, 2);
    grantResource(room, "p1", "wood", 3);

    const result = room.chestTransfer("p1", chestId, "wood", 3, "deposit", "req-1");
    expect(result.ok).toBe(true);
    expect(result.chestItems?.wood).toBe(3);
    expect(room.getPlayer("p1")!.inventory.wood).toBe(0);
  });

  it("withdraws items from the chest into the player's inventory", () => {
    const room = new Room(makeTestMap());
    room.addPlayer("p1", "Alice");
    const chestId = placeChest(room, "p1", 2, 2);
    grantResource(room, "p1", "wood", 3);
    room.chestTransfer("p1", chestId, "wood", 3, "deposit", "req-1");

    const result = room.chestTransfer("p1", chestId, "wood", 2, "withdraw", "req-2");
    expect(result.ok).toBe(true);
    expect(result.chestItems?.wood).toBe(1);
    expect(room.getPlayer("p1")!.inventory.wood).toBe(2);
  });

  it("chests are shared: a second player can withdraw what the first deposited", () => {
    const room = new Room(makeTestMap());
    room.addPlayer("p1", "Alice");
    room.addPlayer("p2", "Bob");
    const chestId = placeChest(room, "p1", 2, 2);
    grantResource(room, "p1", "wood", 5);
    room.chestTransfer("p1", chestId, "wood", 5, "deposit", "req-1");

    // Bob walks to the chest.
    room.setInput("p2", 1, 1);
    for (let i = 0; i < 20; i++) room.tick(0.05);

    const result = room.chestTransfer("p2", chestId, "wood", 5, "withdraw", "req-2");
    expect(result.ok).toBe(true);
    expect(room.getPlayer("p2")!.inventory.wood).toBe(5);
  });

  it("rejects withdrawing more than the chest holds, mutating nothing", () => {
    const room = new Room(makeTestMap());
    room.addPlayer("p1", "Alice");
    const chestId = placeChest(room, "p1", 2, 2);

    const result = room.chestTransfer("p1", chestId, "wood", 1, "withdraw", "req-1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("insufficient_materials");
  });

  it("rejects transfers from too far away", () => {
    const room = new Room(makeTestMap());
    room.addPlayer("p1", "Alice");
    grantResource(room, "p1", "wood", 5); // gather near spawn first

    // Now walk far away from spawn before placing the chest, so the chest
    // itself ends up far from where a second player will stand.
    room.setInput("p1", 1, 1);
    for (let i = 0; i < 150; i++) room.tick(0.05); // drifts toward the far (9,9) corner
    const alicePos = room.getPlayer("p1")!;
    const chestX = Math.min(8, Math.floor(alicePos.x));
    const chestY = Math.min(8, Math.floor(alicePos.y));
    const buildResult = room.build("p1", "chest", chestX, chestY, "far-chest-req");
    if (!buildResult.ok || !buildResult.buildingId) throw new Error("failed to place far chest");
    const chestId = buildResult.buildingId;

    // A second player, still at spawn (1.5, 1.5), is far from that chest.
    room.addPlayer("p2", "Bob");
    grantResource(room, "p2", "wood", 3);

    const result = room.chestTransfer("p2", chestId, "wood", 1, "deposit", "req-far");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("too_far");
  });
});
