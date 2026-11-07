import { beforeEach, describe, expect, it, vi } from "vitest";
import { TILE_SIZE } from "../src/shared/constants.js";
import type { MapObject } from "../src/shared/types.js";

/**
 * Stage 4 Phase B2 added `bush` (25x30, wider than one tile) to
 * OBJECT_SPRITES, which forced drawObject() to grow a horizontal-centring
 * step — every sprite before it happened to be exactly TILE_SIZE wide, so
 * this path never ran until now. This exercises that new math directly
 * against a fake CanvasRenderingContext2D, since the node test
 * environment has no real Image decoder to make getImage() return a
 * loaded image the ordinary way (see spec/sprites.spec.ts's note) — so
 * sprites.js's getImage is mocked to return a truthy sentinel instead,
 * letting drawObject take its sprite-drawing branch under test.
 */
vi.mock("../src/client/sprites.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/client/sprites.js")>();
  return { ...actual, getImage: vi.fn(() => ({}) as unknown as HTMLImageElement) };
});

// Imported after the mock so drawObject's module-level `import { getImage }` binds to the mocked version.
const { drawObject } = await import("../src/client/render.js");
const { OBJECT_SPRITES } = await import("../src/client/sprites.js");

function fakeCtx() {
  const calls: { drawImage?: number[]; globalAlpha: number } = { globalAlpha: 1 };
  const ctx = {
    get globalAlpha() {
      return calls.globalAlpha;
    },
    set globalAlpha(v: number) {
      calls.globalAlpha = v;
    },
    fillStyle: "",
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
      calls.drawImage = [dx, dy, dw, dh];
    },
    fillRect() {},
  } as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

const baseObj: MapObject = { id: "o1", kind: "bush", x: 0, y: 0 };

describe("drawObject's sprite-drawing branch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("horizontally centres a sprite wider than one tile (bush, 25px) on the object's cell", () => {
    const { ctx, calls } = fakeCtx();
    drawObject(ctx, baseObj, 0, 0);
    const rect = OBJECT_SPRITES.bush!;
    // obj.x=0, originX=0 => tile-left x = 0; centred destX = 0 - (rect.w - TILE_SIZE)/2
    const expectedDestX = 0 - (rect.w - TILE_SIZE) / 2;
    expect(calls.drawImage![0]).toBeCloseTo(expectedDestX);
    expect(calls.drawImage![2]).toBe(rect.w);
  });

  it("bottom-anchors a sprite taller than one tile the same way drawTile/drawEnemy already do", () => {
    const { ctx, calls } = fakeCtx();
    drawObject(ctx, baseObj, 0, 0);
    const rect = OBJECT_SPRITES.bush!;
    const expectedDestY = 0 - (rect.h - TILE_SIZE);
    expect(calls.drawImage![1]).toBeCloseTo(expectedDestY);
    expect(calls.drawImage![3]).toBe(rect.h);
  });

  it("does not horizontally offset a sprite that is exactly TILE_SIZE wide (every pre-Stage-4 sprite) — the centring math is a no-op for them", () => {
    const { ctx, calls } = fakeCtx();
    const campfireObj: MapObject = { id: "o3", kind: "campfire", x: 2, y: 0 };
    drawObject(ctx, campfireObj, 0, 0);
    const rect = OBJECT_SPRITES.campfire!;
    expect(rect.w).toBe(TILE_SIZE); // precondition: campfire is exactly one tile wide
    const expectedDestX = 2 * TILE_SIZE; // unchanged from obj.x*TILE_SIZE - originX
    expect(calls.drawImage![0]).toBeCloseTo(expectedDestX);
  });
});
