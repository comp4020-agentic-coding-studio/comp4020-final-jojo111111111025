import { describe, expect, it } from "vitest";
import { drawPlayerMarker, type RenderPlayer } from "../src/client/render.js";
import { TILE_SIZE } from "../src/shared/constants.js";

/**
 * drawPlayerMarker() is the one piece of Stage 3's follow-up fix that's
 * worth testing directly: it's what restores the isLocal (yellow) vs.
 * remote (blue) distinction the old plain-colour player circles gave for
 * free, now that every player renders as the same PLAYER_SPRITES
 * character. A fake CanvasRenderingContext2D — recording just the calls
 * this function actually makes — is enough to assert the colour and
 * geometry without a real browser/canvas.
 */
function fakeCtx() {
  const calls: { fillStyle?: string; ellipse?: number[]; fillCount: number; globalAlpha: number } = {
    fillCount: 0,
    globalAlpha: 1,
  };
  const ctx = {
    get globalAlpha() {
      return calls.globalAlpha;
    },
    set globalAlpha(v: number) {
      calls.globalAlpha = v;
    },
    get fillStyle() {
      return calls.fillStyle ?? "";
    },
    set fillStyle(v: string) {
      calls.fillStyle = v;
    },
    beginPath() {},
    ellipse(x: number, y: number, rx: number, ry: number) {
      calls.ellipse = [x, y, rx, ry];
    },
    fill() {
      calls.fillCount++;
    },
  } as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

const basePlayer: RenderPlayer = { id: "p1", x: 0, y: 0, isLocal: true, alive: true };

describe("drawPlayerMarker", () => {
  it("fills with the same yellow the pre-sprite local-player circle used, for a local player", () => {
    const { ctx, calls } = fakeCtx();
    drawPlayerMarker(ctx, { ...basePlayer, isLocal: true }, 100, 100);
    expect(calls.fillStyle).toBe("#ffd84a");
    expect(calls.fillCount).toBe(1);
  });

  it("fills with the same blue the pre-sprite remote-player circle used, for a remote player", () => {
    const { ctx, calls } = fakeCtx();
    drawPlayerMarker(ctx, { ...basePlayer, isLocal: false }, 100, 100);
    expect(calls.fillStyle).toBe("#4ac6ff");
  });

  it("positions the marker below the player's feet (py), not above or centred on it", () => {
    const { ctx, calls } = fakeCtx();
    const py = 100;
    drawPlayerMarker(ctx, basePlayer, 50, py);
    expect(calls.ellipse![0]).toBe(50); // centred horizontally on px
    expect(calls.ellipse![1]).toBeGreaterThan(py); // strictly below py, not level with or above it
  });

  it("draws a marker smaller than a full tile in both axes — subtle, not a second full-size object", () => {
    const { ctx, calls } = fakeCtx();
    drawPlayerMarker(ctx, basePlayer, 50, 100);
    const [, , rx, ry] = calls.ellipse!;
    expect(rx * 2).toBeLessThan(TILE_SIZE);
    expect(ry * 2).toBeLessThan(TILE_SIZE);
  });

  it("dims the marker's own alpha rather than drawing fully opaque, so it reads as a ground marking under the character, not a shape competing with it", () => {
    const { ctx, calls } = fakeCtx();
    ctx.globalAlpha = 1;
    drawPlayerMarker(ctx, basePlayer, 50, 100);
    expect(calls.globalAlpha).toBeLessThan(1);
  });
});
