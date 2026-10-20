import { describe, expect, it } from "vitest";
import { Room } from "../src/server/room.js";
import type { MapTile, WorldMap } from "../src/shared/types.js";
import { emptyDungeon } from "./helpers/test-fixtures.js";

function makeTestMap(): WorldMap {
  const width = 10;
  const height = 10;
  const tiles: MapTile[] = Array.from({ length: width * height }, () => ({ terrain: "grass" }));
  // A vertical wall of water at x=5, blocking east-west movement across it.
  for (let y = 0; y < height; y++) {
    tiles[y * width + 5] = { terrain: "water" };
  }
  return {
    seed: "test",
    width,
    height,
    tiles,
    objects: [
      { id: "rock-1", kind: "rock", x: 2, y: 2, resource: { kind: "stone", remaining: 3, maxRemaining: 3 } },
    ],
    campsite: { x: 1, y: 1 },
    spawnPoint: { x: 1, y: 1 },
    farmArea: { x: 0, y: 0, width: 0, height: 0 },
    dungeonEntrance: { x: 9, y: 9 },
    dungeon: emptyDungeon(),
  };
}

describe("Room movement", () => {
  it("moves a player each tick in the input direction", () => {
    const room = new Room(makeTestMap());
    room.addPlayer("p1", "Alice");
    room.setInput("p1", 1, 0);
    room.tick(0.1);
    const player = room.getPlayer("p1")!;
    expect(player.x).toBeGreaterThan(1.5);
  });

  it("does not move a player with zero input", () => {
    const room = new Room(makeTestMap());
    const spawn = room.addPlayer("p1", "Alice");
    room.tick(0.5);
    const player = room.getPlayer("p1")!;
    expect(player.x).toBe(spawn.x);
    expect(player.y).toBe(spawn.y);
  });

  it("blocks movement into solid terrain (water)", () => {
    const room = new Room(makeTestMap());
    room.addPlayer("p1", "Alice");
    room.setInput("p1", 1, 0);
    // Run enough ticks to reach the water wall at x=5 if unblocked.
    for (let i = 0; i < 200; i++) room.tick(0.05);
    const player = room.getPlayer("p1")!;
    expect(player.x).toBeLessThan(5);
  });

  it("blocks movement into a solid object (rock)", () => {
    const room = new Room(makeTestMap());
    room.addPlayer("p1", "Alice");
    room.setInput("p1", 1, 1);
    for (let i = 0; i < 200; i++) room.tick(0.05);
    const player = room.getPlayer("p1")!;
    const distToRock = Math.hypot(player.x - 2.5, player.y - 2.5);
    expect(distToRock).toBeGreaterThanOrEqual(0.3);
  });

  it("keeps a player within map bounds", () => {
    const room = new Room(makeTestMap());
    room.addPlayer("p1", "Alice");
    room.setInput("p1", -1, -1);
    for (let i = 0; i < 100; i++) room.tick(0.1);
    const player = room.getPlayer("p1")!;
    expect(player.x).toBeGreaterThanOrEqual(0);
    expect(player.y).toBeGreaterThanOrEqual(0);
  });
});

export { makeTestMap };
