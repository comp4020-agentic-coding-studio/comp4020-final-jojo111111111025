import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RenderEnemy } from "../src/client/render.js";

/**
 * Hit feedback follow-up: drawEnemy() tints an enemy white for a brief
 * window right after it's named as a combat.event target (main.ts derives
 * `flashing` from a per-enemy timestamp, never sent by the server — see
 * RenderEnemy's doc-comment). Same fake-CanvasRenderingContext2D approach as
 * object-sprite-anchoring.spec.ts and terrain-edge.spec.ts: getImage is
 * mocked to return a truthy sentinel so drawEnemy takes its sprite-drawing
 * branch, since the node test environment has no real Image decoder.
 */
vi.mock("../src/client/sprites.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/client/sprites.js")>();
  return { ...actual, getImage: vi.fn(() => ({}) as unknown as HTMLImageElement) };
});

const { drawEnemy } = await import("../src/client/render.js");

function fakeCtx() {
  const fillRectCalls: number[][] = [];
  const compositeOps: string[] = [];
  let savedCompositeOp: GlobalCompositeOperation = "source-over";
  const ctx = {
    globalAlpha: 1,
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    globalCompositeOperation: "source-over",
    save() {
      savedCompositeOp = ctx.globalCompositeOperation;
    },
    restore() {
      ctx.globalCompositeOperation = savedCompositeOp;
    },
    beginPath() {},
    arc() {},
    stroke() {},
    fill() {},
    drawImage() {},
    fillRect(x: number, y: number, w: number, h: number) {
      fillRectCalls.push([x, y, w, h]);
      compositeOps.push(ctx.globalCompositeOperation);
    },
  } as unknown as CanvasRenderingContext2D;
  return { ctx, fillRectCalls, compositeOps };
}

const baseEnemy: RenderEnemy = {
  id: "e1",
  kind: "wanderer",
  x: 0,
  y: 0,
  health: 10,
  maxHealth: 10,
  telegraphing: false,
};

describe("drawEnemy's hit-flash overlay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("draws no extra fillRect for a non-flashing enemy beyond its own health bar", () => {
    const { ctx, compositeOps } = fakeCtx();
    drawEnemy(ctx, baseEnemy, 0, 0);
    // No fillRect should ever run under "source-atop" when not flashing.
    expect(compositeOps).not.toContain("source-atop");
  });

  it("draws a source-atop white tint fillRect over the enemy when flashing", () => {
    const { ctx, compositeOps } = fakeCtx();
    drawEnemy(ctx, { ...baseEnemy, flashing: true }, 0, 0);
    expect(compositeOps).toContain("source-atop");
  });

  it("restores the composite operation after the flash tint (doesn't leak source-atop onto whatever draws next, e.g. the health bar or the next enemy)", () => {
    const { ctx } = fakeCtx();
    drawEnemy(ctx, { ...baseEnemy, flashing: true }, 0, 0);
    expect(ctx.globalCompositeOperation).toBe("source-over");
  });

  it("flashing is false by default (omitted) — an enemy with no flashing field never gets the tint", () => {
    const { ctx, compositeOps } = fakeCtx();
    const enemyWithoutField: RenderEnemy = { ...baseEnemy };
    delete (enemyWithoutField as { flashing?: boolean }).flashing;
    drawEnemy(ctx, enemyWithoutField, 0, 0);
    expect(compositeOps).not.toContain("source-atop");
  });
});
