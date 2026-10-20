import { describe, expect, it } from "vitest";
import { generateWorldMap } from "../src/shared/map.js";
import { SOLID_TERRAIN } from "../src/shared/types.js";

describe("generateWorldMap", () => {
  it("is deterministic for a given seed", () => {
    const a = generateWorldMap("seed-one");
    const b = generateWorldMap("seed-one");
    expect(a.tiles).toEqual(b.tiles);
    expect(a.objects).toEqual(b.objects);
    expect(a.campsite).toEqual(b.campsite);
    expect(a.dungeonEntrance).toEqual(b.dungeonEntrance);
  });

  it("produces a different map for a different seed", () => {
    const a = generateWorldMap("seed-one");
    const b = generateWorldMap("seed-two");
    expect(a.tiles).not.toEqual(b.tiles);
  });

  it("produces the configured dimensions", () => {
    const map = generateWorldMap("seed-dims", 64, 64);
    expect(map.width).toBe(64);
    expect(map.height).toBe(64);
    expect(map.tiles).toHaveLength(64 * 64);
  });

  it("clears walkable, non-solid ground at the campsite", () => {
    const map = generateWorldMap("seed-camp");
    const tile = map.tiles[map.campsite.y * map.width + map.campsite.x];
    expect(tile).toBeDefined();
    expect(SOLID_TERRAIN.has(tile!.terrain)).toBe(false);
  });

  it("places the dungeon entrance within bounds and away from the campsite", () => {
    const map = generateWorldMap("seed-dungeon");
    expect(map.dungeonEntrance.x).toBeGreaterThanOrEqual(0);
    expect(map.dungeonEntrance.x).toBeLessThan(map.width);
    expect(map.dungeonEntrance.y).toBeGreaterThanOrEqual(0);
    expect(map.dungeonEntrance.y).toBeLessThan(map.height);
    const dist = Math.hypot(
      map.dungeonEntrance.x - map.campsite.x,
      map.dungeonEntrance.y - map.campsite.y,
    );
    expect(dist).toBeGreaterThan(10);
  });

  it("gives every resource-bearing object a positive max yield", () => {
    const map = generateWorldMap("seed-resources");
    const resourceObjects = map.objects.filter((o) => o.resource);
    expect(resourceObjects.length).toBeGreaterThan(0);
    for (const obj of resourceObjects) {
      expect(obj.resource!.maxRemaining).toBeGreaterThan(0);
      expect(obj.resource!.remaining).toBe(obj.resource!.maxRemaining);
    }
  });

  it("generates rock terrain (and therefore stone nodes) on every seed", () => {
    // Regression test: averaging independent random noise with a repeated
    // box blur regresses every cell toward the mean, shrinking the value
    // range on each pass. Without re-stretching the result back to [0, 1],
    // terrainFor's elevation > 0.78 threshold for rock became unreachable on
    // every seed — stone (and anything crafted from it) was unobtainable.
    for (const seed of ["seed-a", "seed-b", "seed-c", "last-shelter-dev-seed"]) {
      const map = generateWorldMap(seed);
      const hasRock = map.tiles.some((t) => t.terrain === "rock");
      expect(hasRock, `seed "${seed}" produced no rock terrain`).toBe(true);
      const hasStoneNode = map.objects.some((o) => o.resource?.kind === "stone");
      expect(hasStoneNode, `seed "${seed}" produced no stone resource node`).toBe(true);
    }
  });

  it("produces all four terrain kinds on a typical seed", () => {
    const map = generateWorldMap("seed-variety");
    const terrains = new Set(map.tiles.map((t) => t.terrain));
    expect(terrains).toEqual(new Set(["grass", "forest", "water", "rock"]));
  });
});
