import { describe, expect, it } from "vitest";
import { computeTimeOfDay } from "../src/shared/daynight.js";
import { DAY_DURATION_MS, DAY_NIGHT_CYCLE_MS, NIGHT_DURATION_MS } from "../src/shared/constants.js";

describe("computeTimeOfDay (pure)", () => {
  it("is day at the moment the world is created", () => {
    const result = computeTimeOfDay(1000, 1000);
    expect(result.isNight).toBe(false);
    expect(result.progress).toBe(0);
  });

  it("stays day for the whole DAY_DURATION_MS window", () => {
    const worldCreatedAt = 0;
    expect(computeTimeOfDay(worldCreatedAt, DAY_DURATION_MS - 1).isNight).toBe(false);
  });

  it("flips to night exactly at DAY_DURATION_MS", () => {
    const worldCreatedAt = 0;
    const result = computeTimeOfDay(worldCreatedAt, DAY_DURATION_MS);
    expect(result.isNight).toBe(true);
    expect(result.progress).toBe(0);
  });

  it("stays night for the whole NIGHT_DURATION_MS window", () => {
    const worldCreatedAt = 0;
    expect(computeTimeOfDay(worldCreatedAt, DAY_DURATION_MS + NIGHT_DURATION_MS - 1).isNight).toBe(true);
  });

  it("loops back to day after a full cycle", () => {
    const worldCreatedAt = 0;
    const result = computeTimeOfDay(worldCreatedAt, DAY_NIGHT_CYCLE_MS);
    expect(result.isNight).toBe(false);
    expect(result.progress).toBe(0);
  });

  it("loops correctly after many cycles", () => {
    const worldCreatedAt = 0;
    const now = DAY_NIGHT_CYCLE_MS * 5 + 1000;
    expect(computeTimeOfDay(worldCreatedAt, now)).toEqual(computeTimeOfDay(worldCreatedAt, 1000));
  });

  it("is a pure function: the same (worldCreatedAt, now) pair always yields the same result", () => {
    const worldCreatedAt = 123456;
    const now = 999999;
    expect(computeTimeOfDay(worldCreatedAt, now)).toEqual(computeTimeOfDay(worldCreatedAt, now));
  });

  it("is correct immediately after a simulated restart (now can be far ahead of worldCreatedAt without drifting)", () => {
    const worldCreatedAt = 0;
    const justBeforeNight = DAY_DURATION_MS - 1;
    const justAfterNight = DAY_DURATION_MS;
    // A "restart" is just evaluating the same pure function again later; there's no state to desync.
    expect(computeTimeOfDay(worldCreatedAt, justBeforeNight).isNight).toBe(false);
    expect(computeTimeOfDay(worldCreatedAt, justAfterNight).isNight).toBe(true);
  });

  it("reports msRemaining decreasing toward zero within a segment", () => {
    const worldCreatedAt = 0;
    const early = computeTimeOfDay(worldCreatedAt, 1000);
    const later = computeTimeOfDay(worldCreatedAt, 2000);
    expect(later.msRemaining).toBeLessThan(early.msRemaining);
  });
});
