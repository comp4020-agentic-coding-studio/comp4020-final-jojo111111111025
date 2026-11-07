import { describe, expect, it } from "vitest";
import { isBuildCellFree } from "../src/client/net.js";
import type { Building, MapObject, MapTile, WorldMap } from "../src/shared/types.js";

/**
 * isBuildCellFree is the pure logic behind the build-target preview ring
 * (main.ts's frame() loop) going green or orange before the player commits
 * to a "Place" click — mirrors Room.doBuild's own occupancy check
 * (isCellBlocked's terrain/world-object rule, plus the separate
 * buildingsByCell "any building blocks a new one" rule) so the preview
 * agrees with what the server will actually accept or reject, without
 * being the thing that actually enforces it. Extracted into net.ts (no
 * top-level DOM code) for the same reason findGainedItem/
 * applyObjectDepleted were — testable without a browser/jsdom.
 */
function makeWorld(objects: MapObject[] = [], waterAt: Array<[number, number]> = []): WorldMap {
  const width = 10;
  const height = 10;
  const tiles: MapTile[] = Array.from({ length: width * height }, () => ({ terrain: "grass" }));
  for (const [x, y] of waterAt) {
    tiles[y * width + x] = { terrain: "water" };
  }
  return {
    seed: "test",
    width,
    height,
    tiles,
    objects,
    campsite: { x: 1, y: 1 },
    spawnPoint: { x: 1, y: 1 },
  };
}

function makeBuilding(x: number, y: number, kind: Building["kind"] = "wall"): Building {
  return { id: `b-${x}-${y}`, kind, x, y, ownerId: "p1", placedAt: 0 };
}

describe("isBuildCellFree", () => {
  it("is free on plain, empty grass", () => {
    const world = makeWorld();
    expect(isBuildCellFree(world, new Map(), 5, 5)).toBe(true);
  });

  it("is not free when world is null (no snapshot yet)", () => {
    expect(isBuildCellFree(null, new Map(), 5, 5)).toBe(false);
  });

  it("is not free out of bounds in any direction", () => {
    const world = makeWorld();
    expect(isBuildCellFree(world, new Map(), -1, 5)).toBe(false);
    expect(isBuildCellFree(world, new Map(), 5, -1)).toBe(false);
    expect(isBuildCellFree(world, new Map(), 10, 5)).toBe(false);
    expect(isBuildCellFree(world, new Map(), 5, 10)).toBe(false);
  });

  it("is not free on solid terrain (water)", () => {
    const world = makeWorld([], [[5, 5]]);
    expect(isBuildCellFree(world, new Map(), 5, 5)).toBe(false);
  });

  it("is not free on a solid world object (a tree)", () => {
    const world = makeWorld([{ id: "tree-1", kind: "tree", x: 5, y: 5 }]);
    expect(isBuildCellFree(world, new Map(), 5, 5)).toBe(false);
  });

  it("is free next to (but not on) a solid world object", () => {
    const world = makeWorld([{ id: "tree-1", kind: "tree", x: 5, y: 5 }]);
    expect(isBuildCellFree(world, new Map(), 6, 5)).toBe(true);
  });

  it("is free on a non-solid world object's cell — a bush, not being in SOLID_OBJECTS, doesn't block placement", () => {
    const world = makeWorld([
      { id: "bush-1", kind: "bush", x: 5, y: 5, resource: { kind: "berries", remaining: 3, maxRemaining: 3 } },
    ]);
    expect(isBuildCellFree(world, new Map(), 5, 5)).toBe(true);
  });

  it("is not free on an existing building, even a non-solid one (floor)", () => {
    const world = makeWorld();
    const buildings = new Map([["b1", makeBuilding(5, 5, "floor")]]);
    // doBuild's buildingsByCell check blocks ANY existing building,
    // stricter than isCellBlocked's SOLID_BUILDINGS-only rule — floor is
    // not in SOLID_BUILDINGS but still occupies its cell against a second placement.
    expect(isBuildCellFree(world, buildings, 5, 5)).toBe(false);
  });

  it("is not free on an existing solid building (wall)", () => {
    const world = makeWorld();
    const buildings = new Map([["b1", makeBuilding(5, 5, "wall")]]);
    expect(isBuildCellFree(world, buildings, 5, 5)).toBe(false);
  });

  it("is free next to (but not on) an existing building", () => {
    const world = makeWorld();
    const buildings = new Map([["b1", makeBuilding(5, 5, "wall")]]);
    expect(isBuildCellFree(world, buildings, 6, 5)).toBe(true);
  });
});
