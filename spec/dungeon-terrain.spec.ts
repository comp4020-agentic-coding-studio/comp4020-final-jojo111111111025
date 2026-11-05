import { describe, expect, it } from "vitest";
import { Room } from "../src/server/room.js";
import { generateWorldMap } from "../src/shared/map.js";
import { SOLID_TERRAIN } from "../src/shared/types.js";

/**
 * Regression test for a real pre-existing bug found while auditing the
 * renderer ahead of giving the dungeon its own tileset: SOLID_TERRAIN only
 * ever listed "water", so a player could walk straight through the
 * dungeon's rock-terrain border — the array-bounds check was the only thing
 * stopping them, not the wall tiles themselves. Fixed by giving the dungeon
 * its own "dungeon_wall"/"dungeon_floor" terrain, distinct from the
 * overworld's "rock"/"grass" (which must stay walkable — stone resource
 * nodes sit on overworld rock terrain).
 */
describe("dungeon wall collision", () => {
  it("dungeon_wall is solid and dungeon_floor is not", () => {
    expect(SOLID_TERRAIN.has("dungeon_wall")).toBe(true);
    expect(SOLID_TERRAIN.has("dungeon_floor")).toBe(false);
  });

  it("overworld rock terrain remains walkable (must not regress stone gathering)", () => {
    expect(SOLID_TERRAIN.has("rock")).toBe(false);
  });

  it("generateWorldMap's dungeon uses dungeon_wall for its border and dungeon_floor for its interior", () => {
    const map = generateWorldMap("terrain-test-seed");
    const { tiles, width, height } = map.dungeon;
    // Every border cell (the dungeon is a rectangle with a 1-tile border).
    for (let x = 0; x < width; x++) {
      expect(tiles[0 * width + x]!.terrain).toBe("dungeon_wall");
      expect(tiles[(height - 1) * width + x]!.terrain).toBe("dungeon_wall");
    }
    for (let y = 0; y < height; y++) {
      expect(tiles[y * width + 0]!.terrain).toBe("dungeon_wall");
      expect(tiles[y * width + (width - 1)]!.terrain).toBe("dungeon_wall");
    }
    // The interior (away from the border) is the walkable floor.
    expect(tiles[Math.floor(height / 2) * width + Math.floor(width / 2)]!.terrain).toBe("dungeon_floor");
  });

  it("a player cannot walk past the dungeon's border wall, driven entirely through Room.tick", () => {
    const map = generateWorldMap("wall-collision-test-seed");
    const room = new Room(map);
    room.addPlayer("p1", "Alice");

    // Walk to the dungeon's entry point (one tile inside the border, per
    // generateDungeon), then keep pushing further into the wall.
    const player = room.getPlayer("p1")!;
    const entered = room.enterZone(
      "p1",
      // The overworld-side entrance object always exists in a real generated map.
      map.objects.find((o) => o.kind === "dungeon_entrance")!.id,
      "dungeon",
      "r1",
    );
    // Walk close enough to the entrance first if the spawn point isn't already in range.
    if (!entered.ok) {
      const entrance = map.objects.find((o) => o.kind === "dungeon_entrance")!;
      for (let i = 0; i < 2000; i++) {
        const p = room.getPlayer("p1")!;
        if (Math.hypot(p.x - (entrance.x + 0.5), p.y - (entrance.y + 0.5)) < 1.4) break;
        const dx = Math.sign(entrance.x + 0.5 - p.x);
        const dy = Math.sign(entrance.y + 0.5 - p.y);
        room.setInput("p1", dx, dy);
        room.tick(0.05);
      }
      room.setInput("p1", 0, 0);
      const retry = room.enterZone("p1", entrance.id, "dungeon", "r2");
      expect(retry.ok).toBe(true);
    }
    expect(room.getPlayer("p1")!.zone).toBe("dungeon");

    // Now in the dungeon, at entryPoint (x=1, y=height/2) + 0.5. Push hard
    // toward x=0 (straight into the border wall) for a long time.
    room.setInput("p1", -1, 0);
    for (let i = 0; i < 400; i++) room.tick(0.05);

    const after = room.getPlayer("p1")!;
    // The wall occupies the cell [0,1); a player with PLAYER_RADIUS 0.3
    // should never get closer than x=1.0 to the border once it's solid.
    expect(after.x).toBeGreaterThanOrEqual(1.0);
  });
});
