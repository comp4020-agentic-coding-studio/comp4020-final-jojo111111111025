import { describe, expect, it } from "vitest";
import { Room } from "../src/server/room.js";
import { ITEM_STACK_LIMIT } from "../src/shared/constants.js";
import type { MapObject, WorldMap } from "../src/shared/types.js";

function makeNode(id: string, kind: "wood" | "stone" | "berries", remaining: number): MapObject {
  const objectKind = kind === "wood" ? "tree" : kind === "stone" ? "rock" : "bush";
  return { id, kind: objectKind, x: 1, y: 1, resource: { kind, remaining, maxRemaining: remaining } };
}

/** A map with one large pre-stocked node per resource kind, all within gather range of (1, 1). */
function makeTestMap(): WorldMap {
  const width = 5;
  const height = 5;
  const tiles = Array.from({ length: width * height }, () => ({ terrain: "grass" as const }));
  return {
    seed: "test",
    width,
    height,
    tiles,
    objects: [
      makeNode("wood-node", "wood", ITEM_STACK_LIMIT + 10),
      makeNode("stone-node", "stone", ITEM_STACK_LIMIT + 10),
      // Bandage costs 3 berries each; filling the bandage stack to
      // ITEM_STACK_LIMIT needs up to ITEM_STACK_LIMIT*3 berries plus a few more.
      makeNode("berries-node", "berries", ITEM_STACK_LIMIT * 3 + 10),
    ],
    campsite: { x: 1, y: 1 },
    spawnPoint: { x: 1, y: 1 },
  };
}

let grantCounter = 0;

/** Gathers `qty` of `kind` for playerId from this test map's pre-stocked node. */
function grantResource(room: Room, playerId: string, kind: "wood" | "stone" | "berries", qty: number): void {
  const objectId = `${kind}-node`;
  for (let i = 0; i < qty; i++) {
    const result = room.interact(playerId, objectId, `grant-${objectId}-${grantCounter++}`);
    if (!result.ok) throw new Error(`grantResource failed: ${result.reason}`);
  }
}

describe("Room.craft", () => {
  it("consumes inputs exactly once and grants exactly one output", () => {
    const room = new Room(makeTestMap());
    room.addPlayer("p1", "Alice");
    grantResource(room, "p1", "wood", 3);
    grantResource(room, "p1", "stone", 2);

    const result = room.craft("p1", "axe", "req-1");
    expect(result.ok).toBe(true);
    const inv = room.getPlayer("p1")!.inventory;
    expect(inv.axe).toBe(1);
    expect(inv.wood).toBe(0);
    expect(inv.stone).toBe(0);
  });

  it("rejects a craft with insufficient materials and mutates nothing", () => {
    const room = new Room(makeTestMap());
    room.addPlayer("p1", "Alice");
    grantResource(room, "p1", "wood", 1); // axe needs 3 wood + 2 stone

    const result = room.craft("p1", "axe", "req-1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("insufficient_materials");
    const inv = room.getPlayer("p1")!.inventory;
    expect(inv.wood).toBe(1);
    expect(inv.axe).toBe(0);
  });

  it("rejects crafting an unknown recipe id", () => {
    const room = new Room(makeTestMap());
    room.addPlayer("p1", "Alice");
    const result = room.craft("p1", "does-not-exist", "req-1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unknown_recipe");
  });

  it("is idempotent for a repeated request ID: only applies once", () => {
    const room = new Room(makeTestMap());
    room.addPlayer("p1", "Alice");
    grantResource(room, "p1", "wood", 3);
    grantResource(room, "p1", "stone", 2);

    const first = room.craft("p1", "axe", "req-dup");
    const second = room.craft("p1", "axe", "req-dup");

    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    expect(room.getPlayer("p1")!.inventory.axe).toBe(1);
  });

  it("rejects crafting a building recipe via craft() — that goes through build()", () => {
    const room = new Room(makeTestMap());
    room.addPlayer("p1", "Alice");
    grantResource(room, "p1", "wood", 6);
    const result = room.craft("p1", "workbench", "req-1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not_an_item_recipe");
    expect(room.getPlayer("p1")!.inventory.wood).toBe(6);
  });

  it("refuses to craft when the output item's stack is already full, consuming nothing", () => {
    const room = new Room(makeTestMap());
    room.addPlayer("p1", "Alice");

    // Craft bandage repeatedly (each craft: 3 berries -> 1 bandage), re-gathering
    // berries before each attempt, until the bandage stack can no longer fit
    // another craft's output. A monotonic counter keeps every requestId unique
    // so a transient failure can't repeat a stale dedupe hit.
    let attempt = 0;
    while (room.getPlayer("p1")!.inventory.bandage < ITEM_STACK_LIMIT) {
      grantResource(room, "p1", "berries", 3);
      room.craft("p1", "bandage", `fill-${attempt++}`);
    }
    grantResource(room, "p1", "berries", 3);
    const berriesBefore = room.getPlayer("p1")!.inventory.berries;
    const bandagesBefore = room.getPlayer("p1")!.inventory.bandage;
    expect(bandagesBefore).toBe(ITEM_STACK_LIMIT);

    const result = room.craft("p1", "bandage", "req-overflow");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("inventory_full");
    expect(room.getPlayer("p1")!.inventory.berries).toBe(berriesBefore);
    expect(room.getPlayer("p1")!.inventory.bandage).toBe(bandagesBefore);
  });
});
