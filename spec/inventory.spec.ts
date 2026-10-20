import { describe, expect, it } from "vitest";
import { Room } from "../src/server/room.js";
import { ITEM_STACK_LIMIT } from "../src/shared/constants.js";
import type { MapObject, WorldMap } from "../src/shared/types.js";
import { emptyDungeon } from "./helpers/test-fixtures.js";

function makeNode(id: string, remaining: number): MapObject {
  return { id, kind: "bush", x: 1, y: 1, resource: { kind: "berries", remaining, maxRemaining: remaining } };
}

function makeTestMap(objects: MapObject[]): WorldMap {
  const width = 5;
  const height = 5;
  const tiles = Array.from({ length: width * height }, () => ({ terrain: "grass" as const }));
  return {
    seed: "test",
    width,
    height,
    tiles,
    objects,
    campsite: { x: 1, y: 1 },
    spawnPoint: { x: 1, y: 1 },
    farmArea: { x: 0, y: 0, width: 0, height: 0 },
    dungeonEntrance: { x: 4, y: 4 },
    dungeon: emptyDungeon(),
  };
}

describe("Room inventory stacking (via gather)", () => {
  it("a fresh player's inventory starts at zero for every item kind", () => {
    const room = new Room(makeTestMap([]));
    room.addPlayer("p1", "Alice");
    const inv = room.getPlayer("p1")!.inventory;
    expect(inv.wood).toBe(0);
    expect(inv.axe).toBe(0);
    expect(inv.seed_berry).toBe(0);
  });

  it("grants the full gathered amount when there is room in the stack", () => {
    const room = new Room(makeTestMap([makeNode("bush-1", 5)]));
    room.addPlayer("p1", "Alice");
    for (let i = 0; i < 5; i++) {
      const result = room.interact("p1", "bush-1", `req-${i}`);
      expect(result.ok).toBe(true);
    }
    expect(room.getPlayer("p1")!.inventory.berries).toBe(5);
  });

  it("stops granting once the stack is at ITEM_STACK_LIMIT, without duplicating or erroring", () => {
    const room = new Room(makeTestMap([makeNode("bush-1", ITEM_STACK_LIMIT + 2)]));
    room.addPlayer("p1", "Alice");
    for (let i = 0; i < ITEM_STACK_LIMIT; i++) {
      room.interact("p1", "bush-1", `req-${i}`);
    }
    expect(room.getPlayer("p1")!.inventory.berries).toBe(ITEM_STACK_LIMIT);

    // One more gather: the node still has stock, but the player's stack is full.
    const overflow = room.interact("p1", "bush-1", "req-overflow");
    expect(overflow.ok).toBe(false);
    expect(overflow.reason).toBe("inventory_full");
    // The node must not have been depleted for a gather that granted nothing.
    expect(room.map.objects.find((o) => o.id === "bush-1")!.resource!.remaining).toBe(2);
    expect(room.getPlayer("p1")!.inventory.berries).toBe(ITEM_STACK_LIMIT);
  });
});
