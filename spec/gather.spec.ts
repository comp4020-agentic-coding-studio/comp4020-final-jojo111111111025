import { describe, expect, it } from "vitest";
import { Room } from "../src/server/room.js";
import { AXE_WOOD_YIELD, PICKAXE_STONE_YIELD, TOOL_DURABILITY_USES } from "../src/shared/constants.js";
import { emptyInventory, type WorldMap } from "../src/shared/types.js";

/**
 * Ticks the room, steering playerId toward (targetX, targetY), stopping once
 * within range (or after maxTicks as a safety cap). Steering toward a fixed
 * point — rather than ticking a fixed number of times with constant input —
 * keeps the test robust to movement-speed/tick-rate constants changing, and
 * avoids overshooting the target as a fixed-input, fixed-duration walk would.
 */
function walkPlayerTo(room: Room, playerId: string, targetX: number, targetY: number, maxTicks = 200): void {
  for (let i = 0; i < maxTicks; i++) {
    const player = room.getPlayer(playerId)!;
    const dx = targetX - player.x;
    const dy = targetY - player.y;
    if (Math.hypot(dx, dy) < 0.5) {
      room.setInput(playerId, 0, 0);
      return;
    }
    room.setInput(playerId, dx, dy);
    room.tick(0.05);
  }
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
    objects: [
      {
        id: "bush-1",
        kind: "bush",
        x: 3,
        y: 3,
        resource: { kind: "berries", remaining: 1, maxRemaining: 1 },
      },
      {
        id: "campfire-1",
        kind: "campfire",
        x: 1,
        y: 1,
      },
      {
        id: "tree-1",
        kind: "tree",
        x: 5,
        y: 5,
        resource: { kind: "wood", remaining: 10, maxRemaining: 10 },
      },
      {
        id: "rock-1",
        kind: "rock",
        x: 7,
        y: 8,
        resource: { kind: "stone", remaining: 10, maxRemaining: 10 },
      },
    ],
    campsite: { x: 1, y: 1 },
    spawnPoint: { x: 1, y: 2 },
  };
}

describe("Room.interact (gathering)", () => {
  it("grants the resource and depletes the node on a valid gather", () => {
    const room = new Room(makeTestMap());
    room.addPlayer("p1", "Alice");
    walkPlayerTo(room, "p1", 3.5, 3.5);

    const result = room.interact("p1", "bush-1", "req-1");
    expect(result.ok).toBe(true);
    expect(result.inventory?.berries).toBe(1);
    expect(result.objectRemaining).toBe(0);
  });

  it("rejects gathering from too far away", () => {
    const room = new Room(makeTestMap());
    room.addPlayer("p1", "Alice"); // spawns at campsite, far from the bush
    const result = room.interact("p1", "bush-1", "req-1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("too_far");
  });

  it("rejects gathering from a non-gatherable object", () => {
    const room = new Room(makeTestMap());
    room.addPlayer("p1", "Alice");
    const result = room.interact("p1", "campfire-1", "req-1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not_gatherable");
  });

  it("rejects gathering an unknown object", () => {
    const room = new Room(makeTestMap());
    room.addPlayer("p1", "Alice");
    const result = room.interact("p1", "does-not-exist", "req-1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unknown_object");
  });

  it("does not grant duplicate rewards when two gather attempts race on the same depleted node", () => {
    const room = new Room(makeTestMap());
    room.addPlayer("p1", "Alice");
    room.addPlayer("p2", "Bob");
    walkPlayerTo(room, "p1", 3.5, 3.5);
    walkPlayerTo(room, "p2", 3.5, 3.5);

    const first = room.interact("p1", "bush-1", "req-a");
    const second = room.interact("p2", "bush-1", "req-b");

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("depleted");

    const p1 = room.getPlayer("p1")!;
    const p2 = room.getPlayer("p2")!;
    expect(p1.inventory.berries).toBe(1);
    expect(p2.inventory.berries).toBe(0);
  });

  it("is idempotent for a repeated request ID from the same player", () => {
    const room = new Room(makeTestMap());
    room.addPlayer("p1", "Alice");
    walkPlayerTo(room, "p1", 3.5, 3.5);

    const first = room.interact("p1", "bush-1", "req-dup");
    const second = room.interact("p1", "bush-1", "req-dup");

    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    expect(room.getPlayer("p1")!.inventory.berries).toBe(1);
  });

  it("persists node depletion via the provided callback", () => {
    const calls: Array<{ objectId: string; remaining: number }> = [];
    const room = new Room(makeTestMap(), {
      nodeRemaining: (objectId, remaining) => {
        calls.push({ objectId, remaining });
      },
    });
    room.addPlayer("p1", "Alice");
    walkPlayerTo(room, "p1", 3.5, 3.5);

    room.interact("p1", "bush-1", "req-1");
    expect(calls).toEqual([{ objectId: "bush-1", remaining: 0 }]);
  });
});

describe("Room.interact — tool-boosted gather yield", () => {
  it("grants only 1 wood per gather from a tree without an axe", () => {
    const room = new Room(makeTestMap());
    room.addPlayer("p1", "Alice");
    walkPlayerTo(room, "p1", 5.5, 5.5);

    const result = room.interact("p1", "tree-1", "req-1");
    expect(result.ok).toBe(true);
    expect(result.inventory?.wood).toBe(1);
    expect(result.objectRemaining).toBe(9); // one node charge consumed regardless of yield
  });

  it(`grants AXE_WOOD_YIELD (${AXE_WOOD_YIELD}) wood per gather from a tree while holding an axe`, () => {
    const room = new Room(makeTestMap());
    room.addPlayer("p1", "Alice", { ...emptyInventory(), axe: 1 });
    walkPlayerTo(room, "p1", 5.5, 5.5);

    const result = room.interact("p1", "tree-1", "req-1");
    expect(result.ok).toBe(true);
    expect(result.inventory?.wood).toBe(AXE_WOOD_YIELD);
    expect(result.objectRemaining).toBe(9); // still only one node charge per interact
  });

  it("grants only 1 stone per gather from a rock without a pickaxe", () => {
    const room = new Room(makeTestMap());
    room.addPlayer("p1", "Alice");
    walkPlayerTo(room, "p1", 7.5, 8.5);

    const result = room.interact("p1", "rock-1", "req-1");
    expect(result.ok).toBe(true);
    expect(result.inventory?.stone).toBe(1);
  });

  it(`grants PICKAXE_STONE_YIELD (${PICKAXE_STONE_YIELD}) stone per gather from a rock while holding a pickaxe`, () => {
    const room = new Room(makeTestMap());
    room.addPlayer("p1", "Alice", { ...emptyInventory(), pickaxe: 1 });
    walkPlayerTo(room, "p1", 7.5, 8.5);

    const result = room.interact("p1", "rock-1", "req-1");
    expect(result.ok).toBe(true);
    expect(result.inventory?.stone).toBe(PICKAXE_STONE_YIELD);
  });

  it("an axe gives no bonus when gathering stone, and a pickaxe gives no bonus when gathering wood", () => {
    const room = new Room(makeTestMap());
    room.addPlayer("p1", "Alice", { ...emptyInventory(), axe: 1, pickaxe: 1 });
    walkPlayerTo(room, "p1", 5.5, 5.5);
    const woodResult = room.interact("p1", "tree-1", "req-wood");
    expect(woodResult.inventory?.wood).toBe(AXE_WOOD_YIELD); // axe applies

    walkPlayerTo(room, "p1", 7.5, 8.5);
    const stoneResult = room.interact("p1", "rock-1", "req-stone");
    expect(stoneResult.inventory?.stone).toBe(PICKAXE_STONE_YIELD); // pickaxe applies, not a cross-tool bonus
  });

  it("the axe/pickaxe bonus doesn't apply to berries (no tool gathers berries faster)", () => {
    const room = new Room(makeTestMap());
    room.addPlayer("p1", "Alice", { ...emptyInventory(), axe: 1, pickaxe: 1 });
    walkPlayerTo(room, "p1", 3.5, 3.5);

    const result = room.interact("p1", "bush-1", "req-1");
    expect(result.ok).toBe(true);
    expect(result.inventory?.berries).toBe(1);
  });

  it("a tool-boosted yield still clamps at ITEM_STACK_LIMIT rather than overflowing", () => {
    const room = new Room(makeTestMap());
    const nearFullInventory = { ...emptyInventory(), axe: 1, wood: 98 };
    room.addPlayer("p1", "Alice", nearFullInventory);
    walkPlayerTo(room, "p1", 5.5, 5.5);

    const result = room.interact("p1", "tree-1", "req-1");
    expect(result.ok).toBe(true);
    expect(result.inventory?.wood).toBe(99); // granted only 1, not the full AXE_WOOD_YIELD of 2, since only 1 slot of room remained
  });
});

/** A tree with enough stock for well over TOOL_DURABILITY_USES gathers, for durability tests that need more uses than the default 10-charge tree-1 permits. */
function makeDurabilityTestMap(): WorldMap {
  const map = makeTestMap();
  return {
    ...map,
    objects: map.objects.map((o) =>
      o.id === "tree-1" ? { ...o, resource: { ...o.resource!, remaining: TOOL_DURABILITY_USES * 3, maxRemaining: TOOL_DURABILITY_USES * 3 } } : o,
    ),
  };
}

describe("Room.interact — tool durability", () => {
  it(`breaks the axe after TOOL_DURABILITY_USES (${TOOL_DURABILITY_USES}) boosted gathers, removing it from inventory`, () => {
    const room = new Room(makeDurabilityTestMap());
    room.addPlayer("p1", "Alice", { ...emptyInventory(), axe: 1 });
    walkPlayerTo(room, "p1", 5.5, 5.5);

    for (let i = 0; i < TOOL_DURABILITY_USES - 1; i++) {
      const result = room.interact("p1", "tree-1", `use-${i}`);
      expect(result.ok).toBe(true);
      expect(result.toolBroke).toBeUndefined();
      expect(room.getPlayer("p1")!.inventory.axe).toBe(1); // still intact
    }

    const breaking = room.interact("p1", "tree-1", `use-${TOOL_DURABILITY_USES - 1}`);
    expect(breaking.ok).toBe(true);
    expect(breaking.toolBroke).toBe("axe");
    expect(room.getPlayer("p1")!.inventory.axe).toBe(0);
  });

  it("a freshly crafted replacement axe starts at full durability, not wherever the broken one left off", () => {
    const room = new Room(makeDurabilityTestMap());
    room.addPlayer("p1", "Alice", { ...emptyInventory(), axe: 1 });
    walkPlayerTo(room, "p1", 5.5, 5.5);

    for (let i = 0; i < TOOL_DURABILITY_USES; i++) {
      room.interact("p1", "tree-1", `use-${i}`);
    }
    expect(room.getPlayer("p1")!.inventory.axe).toBe(0);

    // Hand the player a brand-new axe (standing in for a fresh craft) and
    // confirm it survives a full fresh cycle of uses before breaking again,
    // rather than breaking on its very first use.
    room.getPlayer("p1")!.inventory.axe = 1;
    for (let i = 0; i < TOOL_DURABILITY_USES - 1; i++) {
      const result = room.interact("p1", "tree-1", `use-second-${i}`);
      expect(result.toolBroke).toBeUndefined();
    }
    expect(room.getPlayer("p1")!.inventory.axe).toBe(1);
  });

  it("gathering without a tool never wears one down (no tool to wear)", () => {
    const room = new Room(makeDurabilityTestMap());
    room.addPlayer("p1", "Alice");
    walkPlayerTo(room, "p1", 5.5, 5.5);

    for (let i = 0; i < TOOL_DURABILITY_USES + 2; i++) {
      const result = room.interact("p1", "tree-1", `use-${i}`);
      expect(result.toolBroke).toBeUndefined();
    }
  });

  it("gathering stone with a pickaxe wears the pickaxe, not the axe held at the same time", () => {
    const room = new Room(makeTestMap());
    room.addPlayer("p1", "Alice", { ...emptyInventory(), axe: 1, pickaxe: 1 });
    walkPlayerTo(room, "p1", 7.5, 8.5);

    for (let i = 0; i < TOOL_DURABILITY_USES; i++) {
      room.interact("p1", "rock-1", `use-${i}`);
    }
    expect(room.getPlayer("p1")!.inventory.pickaxe).toBe(0);
    expect(room.getPlayer("p1")!.inventory.axe).toBe(1); // untouched — this gather never involved the axe
  });
});
