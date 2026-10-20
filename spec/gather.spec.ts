import { describe, expect, it } from "vitest";
import { Room } from "../src/server/room.js";
import type { WorldMap } from "../src/shared/types.js";
import { emptyDungeon } from "./helpers/test-fixtures.js";

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
    ],
    campsite: { x: 1, y: 1 },
    spawnPoint: { x: 1, y: 2 },
    farmArea: { x: 0, y: 0, width: 0, height: 0 },
    dungeonEntrance: { x: 9, y: 9 },
    dungeon: emptyDungeon(),
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
