import { describe, expect, it } from "vitest";
import { Room } from "../src/server/room.js";
import { CROP_GROWING_MS, CROP_MATURE_MS, CROP_WATER_VALID_MS } from "../src/shared/constants.js";
import { computeCropStage } from "../src/shared/farming.js";
import type { FarmPlotState, MapObject, WorldMap } from "../src/shared/types.js";
import { emptyDungeon } from "./helpers/test-fixtures.js";

function makeNode(id: string, kind: "wood" | "berries", remaining: number, x: number, y: number): MapObject {
  const objectKind = kind === "wood" ? "tree" : "bush";
  return { id, kind: objectKind, x, y, resource: { kind, remaining, maxRemaining: remaining } };
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
    objects: [makeNode("wood-node", "wood", 1000, 0, 1), makeNode("berries-node", "berries", 1000, 0, 2)],
    campsite: { x: 1, y: 1 },
    spawnPoint: { x: 1, y: 1 },
    farmArea: { x: 0, y: 0, width: 0, height: 0 },
    dungeonEntrance: { x: 9, y: 9 },
    dungeon: emptyDungeon(),
  };
}

let grantCounter = 0;
function grantResource(room: Room, playerId: string, kind: "wood" | "berries", qty: number): void {
  const objectId = `${kind}-node`;
  for (let i = 0; i < qty; i++) {
    const result = room.interact(playerId, objectId, `grant-${objectId}-${grantCounter++}`);
    if (!result.ok) throw new Error(`grantResource failed: ${result.reason}`);
  }
}

/** A controllable clock for deterministic farm-growth tests without real sleeps. */
class FakeClock {
  private current = 1_000_000;
  now = () => this.current;
  advance(ms: number): void {
    this.current += ms;
  }
}

function placePlotAndSeed(room: Room, playerId: string): { plotId: string } {
  grantResource(room, playerId, "wood", 2);
  const build = room.build(playerId, "farm_plot", 2, 2, `plot-${grantCounter++}`);
  if (!build.ok || !build.buildingId) throw new Error("failed to place farm plot");
  grantResource(room, playerId, "berries", 1);
  room.craft(playerId, "seed_berry", `seed-${grantCounter++}`); // 1 berry -> 2 seeds
  return { plotId: build.buildingId };
}

describe("computeCropStage (pure)", () => {
  it("is empty when never planted", () => {
    const plot: FarmPlotState = { buildingId: "p", seedKind: null, plantedAt: null, wateredAt: null };
    expect(computeCropStage(plot, 1_000_000)).toBe("empty");
  });

  it("stays planted (no growth) if never watered, regardless of elapsed time", () => {
    const plot: FarmPlotState = { buildingId: "p", seedKind: "seed_berry", plantedAt: 0, wateredAt: null };
    expect(computeCropStage(plot, CROP_MATURE_MS * 10)).toBe("planted");
  });

  it("progresses planted -> growing -> mature once watered, as time passes", () => {
    const plot: FarmPlotState = { buildingId: "p", seedKind: "seed_berry", plantedAt: 0, wateredAt: 0 };
    expect(computeCropStage(plot, 0)).toBe("planted");
    expect(computeCropStage(plot, CROP_GROWING_MS + 1)).toBe("growing");
    expect(computeCropStage(plot, CROP_MATURE_MS + 1)).toBe("mature");
  });

  it("stops progressing (falls back to planted) if the watering goes stale", () => {
    const plot: FarmPlotState = { buildingId: "p", seedKind: "seed_berry", plantedAt: 0, wateredAt: 0 };
    expect(computeCropStage(plot, CROP_WATER_VALID_MS + 1)).toBe("planted");
  });

  it("is a pure function: the same (plot, now) pair always yields the same stage", () => {
    const plot: FarmPlotState = { buildingId: "p", seedKind: "seed_berry", plantedAt: 1000, wateredAt: 1000 };
    const now = 1000 + CROP_GROWING_MS + 500;
    expect(computeCropStage(plot, now)).toBe(computeCropStage(plot, now));
  });
});

describe("Room.farmAction", () => {
  it("planting consumes a seed and requires an empty plot", () => {
    const clock = new FakeClock();
    const room = new Room(makeTestMap(), {}, [], new Map(), [], clock.now);
    room.addPlayer("p1", "Alice");
    const { plotId } = placePlotAndSeed(room, "p1");
    const seedsBefore = room.getPlayer("p1")!.inventory.seed_berry;

    const result = room.farmAction("p1", plotId, "plant", "seed_berry", "req-1");
    expect(result.ok).toBe(true);
    expect(room.getPlayer("p1")!.inventory.seed_berry).toBe(seedsBefore - 1);
    expect(room.getCropStage(plotId)).toBe("planted");

    // Planting again on an occupied plot is rejected.
    const second = room.farmAction("p1", plotId, "plant", "seed_berry", "req-2");
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("plot_occupied");
  });

  it("planting without the seed in inventory is rejected", () => {
    const clock = new FakeClock();
    const room = new Room(makeTestMap(), {}, [], new Map(), [], clock.now);
    room.addPlayer("p1", "Alice");
    grantResource(room, "p1", "wood", 2);
    const build = room.build("p1", "farm_plot", 2, 2, "plot-req");
    const plotId = build.buildingId!;

    const result = room.farmAction("p1", plotId, "plant", "seed_berry", "req-1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("insufficient_materials");
  });

  it("watering requires an existing (non-empty) crop", () => {
    const clock = new FakeClock();
    const room = new Room(makeTestMap(), {}, [], new Map(), [], clock.now);
    room.addPlayer("p1", "Alice");
    grantResource(room, "p1", "wood", 2);
    const build = room.build("p1", "farm_plot", 2, 2, "plot-req");
    const plotId = build.buildingId!;

    const result = room.farmAction("p1", plotId, "water", undefined, "req-1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("plot_empty");
  });

  it("harvesting before maturity is rejected", () => {
    const clock = new FakeClock();
    const room = new Room(makeTestMap(), {}, [], new Map(), [], clock.now);
    room.addPlayer("p1", "Alice");
    const { plotId } = placePlotAndSeed(room, "p1");
    room.farmAction("p1", plotId, "plant", "seed_berry", "req-plant");
    room.farmAction("p1", plotId, "water", undefined, "req-water");

    clock.advance(CROP_GROWING_MS / 2);
    const result = room.farmAction("p1", plotId, "harvest", undefined, "req-harvest");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not_mature");
  });

  it("harvesting a mature, watered crop grants the item exactly once and resets the plot", () => {
    const clock = new FakeClock();
    const room = new Room(makeTestMap(), {}, [], new Map(), [], clock.now);
    room.addPlayer("p1", "Alice");
    const { plotId } = placePlotAndSeed(room, "p1");
    room.farmAction("p1", plotId, "plant", "seed_berry", "req-plant");
    room.farmAction("p1", plotId, "water", undefined, "req-water");

    clock.advance(CROP_MATURE_MS + 1);
    const berriesBefore = room.getPlayer("p1")!.inventory.berries;

    const result = room.farmAction("p1", plotId, "harvest", undefined, "req-harvest");
    expect(result.ok).toBe(true);
    expect(room.getPlayer("p1")!.inventory.berries).toBe(berriesBefore + 1);
    expect(room.getCropStage(plotId)).toBe("empty");
  });

  it("harvesting twice in a row only succeeds once (second attempt sees an empty plot)", () => {
    const clock = new FakeClock();
    const room = new Room(makeTestMap(), {}, [], new Map(), [], clock.now);
    room.addPlayer("p1", "Alice");
    const { plotId } = placePlotAndSeed(room, "p1");
    room.farmAction("p1", plotId, "plant", "seed_berry", "req-plant");
    room.farmAction("p1", plotId, "water", undefined, "req-water");
    clock.advance(CROP_MATURE_MS + 1);

    const first = room.farmAction("p1", plotId, "harvest", undefined, "req-harvest-a");
    const second = room.farmAction("p1", plotId, "harvest", undefined, "req-harvest-b");

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("not_mature"); // plot is "empty", which is also not "mature"
  });

  it("is idempotent for a repeated request ID on the same action", () => {
    const clock = new FakeClock();
    const room = new Room(makeTestMap(), {}, [], new Map(), [], clock.now);
    room.addPlayer("p1", "Alice");
    const { plotId } = placePlotAndSeed(room, "p1");

    const first = room.farmAction("p1", plotId, "plant", "seed_berry", "req-dup");
    const second = room.farmAction("p1", plotId, "plant", "seed_berry", "req-dup");

    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    // Only one seed consumed, not two.
    expect(room.getPlayer("p1")!.inventory.seed_berry).toBe(1);
  });

  it("rejects actions on a plot too far from the player", () => {
    const clock = new FakeClock();
    const room = new Room(makeTestMap(), {}, [], new Map(), [], clock.now);
    room.addPlayer("p1", "Alice");
    grantResource(room, "p1", "wood", 2);
    room.setInput("p1", 1, 1);
    for (let i = 0; i < 150; i++) room.tick(0.05);
    const build = room.build("p1", "farm_plot", Math.floor(room.getPlayer("p1")!.x), Math.floor(room.getPlayer("p1")!.y), "far-plot-req");
    const plotId = build.buildingId!;

    room.addPlayer("p2", "Bob"); // stays at spawn, far from the plot
    const result = room.farmAction("p2", plotId, "water", undefined, "req-1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("too_far");
  });

  it("persists each state transition via the provided callback", () => {
    const clock = new FakeClock();
    const calls: FarmPlotState[] = [];
    const room = new Room(makeTestMap(), { farmPlot: (plot) => calls.push(plot) }, [], new Map(), [], clock.now);
    room.addPlayer("p1", "Alice");
    const { plotId } = placePlotAndSeed(room, "p1");

    room.farmAction("p1", plotId, "plant", "seed_berry", "req-plant");
    room.farmAction("p1", plotId, "water", undefined, "req-water");
    clock.advance(CROP_MATURE_MS + 1);
    room.farmAction("p1", plotId, "harvest", undefined, "req-harvest");

    expect(calls).toHaveLength(3);
    expect(calls[0]!.plantedAt).not.toBeNull();
    expect(calls[1]!.wateredAt).not.toBeNull();
    expect(calls[2]!.plantedAt).toBeNull(); // reset to empty after harvest
  });
});
