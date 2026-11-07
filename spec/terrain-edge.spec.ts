import { beforeEach, describe, expect, it, vi } from "vitest";
import { TILE_SIZE } from "../src/shared/constants.js";
import type { MapTile } from "../src/shared/types.js";

/**
 * Stage 5 gave drawTile() a neighbour-aware overlay step: a grass tile next
 * to a water tile draws WATER_GRASS_EDGE_SPRITE, rotated to face the water,
 * on top of its own base sprite — see sprites.ts's WATER_GRASS_EDGE_SPRITE
 * doc-comment for why only this one terrain pair has this, and why there's
 * no corner variant. This exercises that logic directly against a fake
 * CanvasRenderingContext2D (same reason as object-sprite-anchoring.spec.ts:
 * the node test environment has no real Image decoder, so getImage is
 * mocked to return a truthy sentinel, letting drawTile take its
 * sprite-drawing branches under test instead of silently falling through
 * to the flat-colour path).
 */
vi.mock("../src/client/sprites.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/client/sprites.js")>();
  return { ...actual, getImage: vi.fn(() => ({}) as unknown as HTMLImageElement) };
});

const { drawTile } = await import("../src/client/render.js");
const { WATER_GRASS_EDGE_SPRITE } = await import("../src/client/sprites.js");

function fakeCtx() {
  const drawImageCalls: number[][] = [];
  const transformCalls: string[] = [];
  const ctx = {
    globalAlpha: 1,
    fillStyle: "",
    save() {
      transformCalls.push("save");
    },
    restore() {
      transformCalls.push("restore");
    },
    translate(x: number, y: number) {
      transformCalls.push(`translate(${x},${y})`);
    },
    rotate(theta: number) {
      transformCalls.push(`rotate(${theta.toFixed(4)})`);
    },
    drawImage(
      _img: unknown,
      _sx: number,
      _sy: number,
      _sw: number,
      _sh: number,
      dx: number,
      dy: number,
      dw: number,
      dh: number,
    ) {
      drawImageCalls.push([dx, dy, dw, dh]);
    },
    fillRect() {},
  } as unknown as CanvasRenderingContext2D;
  return { ctx, drawImageCalls, transformCalls };
}

function zoneOf(grid: string[]): { width: number; height: number; tiles: MapTile[]; objects: [] } {
  const height = grid.length;
  const width = grid[0]!.length;
  const tiles: MapTile[] = [];
  for (const row of grid) {
    for (const ch of row) {
      tiles.push({ terrain: ch === "W" ? "water" : "grass" });
    }
  }
  return { width, height, tiles, objects: [] };
}

describe("drawTile's water/grass edge overlay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("draws no edge overlay for a grass tile with only grass neighbours", () => {
    const zone = zoneOf(["GGG", "GGG", "GGG"]);
    const { ctx, drawImageCalls } = fakeCtx();
    drawTile(ctx, zone, 1, 1, 16, 16);
    expect(drawImageCalls.length).toBe(1); // base tile only, no overlay
  });

  it("draws exactly one rotated overlay for a grass tile with water directly north", () => {
    // row0="GWG", row1="GGG": the grass tile at (row1,col1) has water at
    // (row0,col1) directly above it, i.e. to its north.
    const zone = zoneOf(["GWG", "GGG", "GGG"]);
    const { ctx, drawImageCalls, transformCalls } = fakeCtx();
    drawTile(ctx, zone, 1, 1, 16, 16);
    expect(drawImageCalls.length).toBe(2); // base grass tile + one edge overlay
    // North rotation is 0 radians (no-op rotate, but still issued)
    expect(transformCalls).toContain("rotate(0.0000)");
  });

  it("draws no overlay on a water tile even when adjacent to grass (only the grass side draws, to avoid double-stacking the same seam)", () => {
    const zone = zoneOf(["GWG", "GGG", "GGG"]);
    const { ctx, drawImageCalls } = fakeCtx();
    drawTile(ctx, zone, 0, 1, 16, 16); // the water tile itself
    expect(drawImageCalls.length).toBe(1); // base water tile only, no overlay
  });

  it("rotates to face east when water is to the east, and west when water is to the west", () => {
    const zone = zoneOf(["GWG"]);
    // Tile (0,0): water neighbour to the east (0,1) -> rotate PI/2.
    const east = fakeCtx();
    drawTile(east.ctx, zone, 0, 0, 0, 0);
    expect(east.transformCalls).toContain(`rotate(${(Math.PI / 2).toFixed(4)})`);

    // Tile (0,2): water neighbour to the west (0,1) -> rotate -PI/2.
    const west = fakeCtx();
    drawTile(west.ctx, zone, 0, 2, 32, 0);
    expect(west.transformCalls).toContain(`rotate(${(-Math.PI / 2).toFixed(4)})`);
  });

  it("draws a separate overlay per differing neighbour — a grass tile wedged between water on two sides gets two overlays", () => {
    const zone = zoneOf(["GWG", "WGW", "GWG"]);
    const { ctx, drawImageCalls } = fakeCtx();
    // Centre tile (1,1) is grass, with water north (0,1), south (2,1), east (1,2), west (1,0) — all four sides.
    drawTile(ctx, zone, 1, 1, 16, 16);
    expect(drawImageCalls.length).toBe(5); // base tile + 4 overlays (one per side)
  });

  it("never reads out of bounds at the map's own edge — a grass tile at col 0 checking its west neighbour finds none, not the previous row's last cell", () => {
    // Flat row-major layout: ["GGW","GGG","GGG"] is tiles[0..8] =
    // [G,G,W, G,G,G, G,G,G]. The tile under test is (row=1,col=0) = tiles[3]
    // — every one of its REAL neighbours (N=tiles[0]=G, S=tiles[6]=G,
    // E=tiles[4]=G) is grass. Its west neighbour is genuinely out of
    // bounds (col-1 = -1). The bug this guards against is computing
    // `tiles[row*width + col - 1]` without a bounds check: for row=1,
    // width=3, col=0, that's `tiles[3 - 1]` = `tiles[2]`, which is the
    // WATER tile at the end of row 0 — a cell that is not adjacent to
    // (1,0) at all (it's one row up and two columns over). Any overlay
    // drawn here proves that wraparound read happened.
    const zone = zoneOf(["GGW", "GGG", "GGG"]);
    const { ctx, drawImageCalls } = fakeCtx();
    drawTile(ctx, zone, 1, 0, 0, 16);
    expect(drawImageCalls.length).toBe(1); // base tile only — no phantom west overlay
  });

  it("the edge sprite is exactly one tile in size, drawn centred on the tile being edged", () => {
    const zone = zoneOf(["GWG", "GGG"]);
    const { ctx, drawImageCalls } = fakeCtx();
    drawTile(ctx, zone, 1, 1, 16, 16);
    const overlayCall = drawImageCalls[1]!; // [0] is the base tile, [1] is the overlay
    expect(overlayCall[2]).toBe(WATER_GRASS_EDGE_SPRITE.w);
    expect(overlayCall[3]).toBe(WATER_GRASS_EDGE_SPRITE.h);
    expect(WATER_GRASS_EDGE_SPRITE.w).toBe(TILE_SIZE);
    expect(WATER_GRASS_EDGE_SPRITE.h).toBe(TILE_SIZE);
  });
});
