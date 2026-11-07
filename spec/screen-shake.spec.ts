import { describe, expect, it } from "vitest";
import { render, type RenderEnemy, type RenderPlayer, type RenderZone } from "../src/client/render.js";

/**
 * Hit feedback follow-up: render()'s new shakeOffset parameter nudges the
 * camera origin by a screen-space pixel amount, so a short decaying shake
 * (main.ts's triggerShake/currentShakeOffset) makes the whole scene visibly
 * judder around a hit instead of just a number on a health bar changing. No
 * sprite loading is exercised here — getImage isn't mocked, so every draw
 * call takes its flat-colour fallback branch; this only checks where things
 * land, which the fallback path is enough for (it goes through the exact
 * same originX/originY math as the sprite path).
 */
function fakeCtx() {
  const arcCalls: number[][] = [];
  const ctx = {
    globalAlpha: 1,
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    globalCompositeOperation: "source-over",
    save() {},
    restore() {},
    translate() {},
    rotate() {},
    beginPath() {},
    arc(x: number, y: number) {
      arcCalls.push([x, y]);
    },
    stroke() {},
    fill() {},
    drawImage() {},
    fillRect() {},
    ellipse() {},
  } as unknown as CanvasRenderingContext2D;
  return { ctx, arcCalls };
}

function emptyZone(): RenderZone {
  return { width: 4, height: 4, tiles: Array.from({ length: 16 }, () => ({ terrain: "grass" as const })), objects: [] };
}

const player: RenderPlayer = { id: "p1", x: 2, y: 2, isLocal: true, alive: true };

describe("render()'s shakeOffset", () => {
  it("draws the local player at the unshifted position when shakeOffset is omitted (the default {x:0,y:0})", () => {
    const { ctx, arcCalls } = fakeCtx();
    render(ctx, emptyZone(), [player], [], [], { x: 2, y: 2 }, { width: 100, height: 100 }, false);
    // Camera is centred on the player, so with no shake the player's fallback circle draws at the viewport centre.
    expect(arcCalls[0]).toEqual([50, 50]);
  });

  it("shifts every drawn position by shakeOffset — the player's fallback circle moves off-centre by exactly the offset", () => {
    const { ctx, arcCalls } = fakeCtx();
    render(ctx, emptyZone(), [player], [], [], { x: 2, y: 2 }, { width: 100, height: 100 }, false, [], { x: 5, y: -3 });
    // originX/Y subtract shakeOffset, and px/py subtract originX/Y, so the
    // net effect on-screen is "+shakeOffset" relative to the no-shake case.
    expect(arcCalls[0]).toEqual([55, 47]);
  });

  it("applies the same offset to enemies as to the player (the whole scene shakes together, not just one entity)", () => {
    const { ctx, arcCalls } = fakeCtx();
    const enemy: RenderEnemy = { id: "e1", kind: "wanderer", x: 2, y: 2, health: 10, maxHealth: 10, telegraphing: false };
    render(ctx, emptyZone(), [], [], [enemy], { x: 2, y: 2 }, { width: 100, height: 100 }, false, [], { x: 5, y: -3 });
    // The enemy's own fallback-circle arc call is the first one recorded (before the player loop, which is empty here).
    expect(arcCalls[0]).toEqual([55, 47]);
  });
});
