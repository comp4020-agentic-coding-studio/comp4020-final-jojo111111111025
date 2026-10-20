import { describe, expect, it } from "vitest";
import { Room } from "../src/server/room.js";
import { ZONE_TRANSITION_RANGE_TILES } from "../src/shared/constants.js";
import type { WorldMap } from "../src/shared/types.js";

/** A dungeon fixture that, unlike the bare `emptyDungeon` helper, carries its own dungeon_exit object — needed by the tests here that exercise the dungeon-to-overworld transition. */
function makeTestDungeon() {
  const width = 6;
  const height = 6;
  return {
    width,
    height,
    tiles: Array.from({ length: width * height }, () => ({ terrain: "grass" as const })),
    objects: [{ id: "dungeon-exit-1", kind: "dungeon_exit" as const, x: 1, y: 1, zone: "dungeon" as const }],
    entryPoint: { x: 1, y: 1 },
    beaconLocation: { x: 4, y: 4 },
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
    spawnPoint: { x: 1, y: 1 },
    farmArea: { x: 0, y: 0, width: 0, height: 0 },
    dungeonEntrance: { x: 5, y: 5 },
    dungeon: makeTestDungeon(),
  };
}

describe("Room.enterZone — validation", () => {
  it("rejects a transition for an unknown player", () => {
    const room = new Room(makeTestMap());
    const result = room.enterZone("ghost", "entrance-1", "dungeon", "r1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unknown_player");
  });

  it("rejects a transition for a dead player", () => {
    const room = new Room(makeTestMap());
    room.addPlayer("p1", "Alice", undefined, 0);
    const result = room.enterZone("p1", "entrance-1", "dungeon", "r1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("dead");
  });

  it("rejects a transition through an unknown object id", () => {
    const room = new Room(makeTestMap());
    room.addPlayer("p1", "Alice");
    const result = room.enterZone("p1", "does-not-exist", "dungeon", "r1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unknown_object");
  });

  it("rejects using an object that isn't a zone transition", () => {
    const map = makeTestMap();
    map.objects.push({ id: "tree-1", kind: "tree", x: 1, y: 2, resource: { kind: "wood", remaining: 5, maxRemaining: 5 } });
    const room = new Room(map);
    room.addPlayer("p1", "Alice");
    const result = room.enterZone("p1", "tree-1", "dungeon", "r1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not_a_zone_transition");
  });

  it("rejects entering the dungeon when the player is too far from the entrance", () => {
    const room = new Room(makeTestMap());
    room.addPlayer("p1", "Alice"); // spawns at (1.5, 1.5), entrance at (5, 5)
    const result = room.enterZone("p1", "entrance-1", "dungeon", "r1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("too_far");
  });

  it("rejects requesting the zone the player is already in", () => {
    const room = new Room(makeTestMap());
    room.addPlayer("p1", "Alice");
    const result = room.enterZone("p1", "entrance-1", "overworld", "r1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("already_in_zone");
  });

  it("rejects using an overworld object while the player is in the dungeon", () => {
    const map = makeTestMap();
    map.spawnPoint = { x: 4, y: 5 }; // close enough to walk to the entrance
    const room = new Room(map);
    room.addPlayer("p1", "Alice");
    // Walk within range of the entrance manually by setting input/ticking,
    // or just place the player directly via repeated small ticks toward it.
    for (let i = 0; i < 50; i++) {
      const p = room.getPlayer("p1")!;
      if (Math.hypot(p.x - 5.5, p.y - 5.5) < ZONE_TRANSITION_RANGE_TILES) break;
      room.setInput("p1", 1, 0);
      room.tick(0.1);
    }
    const entered = room.enterZone("p1", "entrance-1", "dungeon", "enter-1");
    expect(entered.ok).toBe(true);
    expect(room.getPlayer("p1")!.zone).toBe("dungeon");

    // Now in the dungeon: the overworld's entrance-1 object is not in the
    // player's current zone, so it must be rejected as wrong_zone even
    // though the object itself exists.
    const wrongZone = room.enterZone("p1", "entrance-1", "overworld", "r2");
    expect(wrongZone.ok).toBe(false);
    expect(wrongZone.reason).toBe("wrong_zone");
  });
});

describe("Room.enterZone — success", () => {
  it("moves the player to the dungeon's own entry point on a successful transition", () => {
    const map = makeTestMap();
    map.spawnPoint = { x: 5, y: 6 }; // one tile from the entrance, in range
    const room = new Room(map);
    room.addPlayer("p1", "Alice");
    const before = room.getPlayer("p1")!;
    expect(Math.hypot(before.x - 5.5, before.y - 5.5)).toBeLessThanOrEqual(ZONE_TRANSITION_RANGE_TILES);

    const result = room.enterZone("p1", "entrance-1", "dungeon", "r1");
    expect(result.ok).toBe(true);

    const after = room.getPlayer("p1")!;
    expect(after.zone).toBe("dungeon");
    expect(after.x).toBeCloseTo(map.dungeon.entryPoint.x + 0.5, 5);
    expect(after.y).toBeCloseTo(map.dungeon.entryPoint.y + 0.5, 5);
  });

  it("moves the player back to the overworld's dungeonEntrance via the dungeon's own exit object", () => {
    const map = makeTestMap();
    map.spawnPoint = { x: 5, y: 6 };
    const room = new Room(map);
    room.addPlayer("p1", "Alice");
    room.enterZone("p1", "entrance-1", "dungeon", "r1");
    expect(room.getPlayer("p1")!.zone).toBe("dungeon");

    // The dungeon's own exit object sits at its entryPoint (see generateDungeon).
    const exitId = map.dungeon.objects.find((o) => o.kind === "dungeon_exit")!.id;
    const result = room.enterZone("p1", exitId, "overworld", "r2");
    expect(result.ok).toBe(true);

    const after = room.getPlayer("p1")!;
    expect(after.zone).toBe("overworld");
    expect(after.x).toBeCloseTo(map.dungeonEntrance.x + 0.5, 5);
    expect(after.y).toBeCloseTo(map.dungeonEntrance.y + 0.5, 5);
  });

  it("resets input on transition so the player doesn't keep drifting in the new zone", () => {
    const map = makeTestMap();
    map.spawnPoint = { x: 5, y: 6 };
    const room = new Room(map);
    room.addPlayer("p1", "Alice");
    room.setInput("p1", 1, 0);
    room.enterZone("p1", "entrance-1", "dungeon", "r1");
    const after = room.getPlayer("p1")!;
    const beforeTickX = after.x;
    room.tick(1); // if input weren't cleared, a full second at full speed would move the player noticeably
    expect(room.getPlayer("p1")!.x).toBeCloseTo(beforeTickX, 5);
  });
});

describe("Room zone isolation — gather/build/chest/farm are overworld-only", () => {
  it("rejects a gather interaction attempted from the dungeon on an overworld object", () => {
    const map = makeTestMap();
    map.objects.push({ id: "tree-1", kind: "tree", x: 2, y: 2, resource: { kind: "wood", remaining: 5, maxRemaining: 5 } });
    map.spawnPoint = { x: 5, y: 6 };
    const room = new Room(map);
    room.addPlayer("p1", "Alice");
    room.enterZone("p1", "entrance-1", "dungeon", "r1");

    const result = room.interact("p1", "tree-1", "r2");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("wrong_zone");
  });

  it("rejects a building placement attempted from the dungeon", () => {
    const map = makeTestMap();
    map.spawnPoint = { x: 5, y: 6 };
    const room = new Room(map);
    const inventory = { wood: 10, stone: 10, berries: 0, seed_berry: 0, axe: 0, pickaxe: 0, sword: 0, bandage: 0, ancient_core: 0 };
    room.addPlayer("p1", "Alice", inventory);
    room.enterZone("p1", "entrance-1", "dungeon", "r1");

    const result = room.build("p1", "floor", 2, 2, "r2");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("wrong_zone");
  });
});
