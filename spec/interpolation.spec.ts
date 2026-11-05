import { describe, expect, it } from "vitest";
import { InterpolationBuffer, renderTimeFor } from "../src/client/interpolation.js";

describe("InterpolationBuffer", () => {
  it("returns the only sample it has before a second one arrives", () => {
    const buf = new InterpolationBuffer();
    buf.push(5, 5, 1000);
    expect(buf.sample(1000)).toEqual({ x: 5, y: 5 });
    expect(buf.sample(2000)).toEqual({ x: 5, y: 5 });
  });

  it("interpolates linearly between two samples bracketing the render time", () => {
    const buf = new InterpolationBuffer();
    buf.push(0, 0, 1000);
    buf.push(10, 20, 1100);
    expect(buf.sample(1050)).toEqual({ x: 5, y: 10 });
    expect(buf.sample(1000)).toEqual({ x: 0, y: 0 });
    expect(buf.sample(1100)).toEqual({ x: 10, y: 20 });
  });

  it("clamps to the newest sample rather than extrapolating past it", () => {
    const buf = new InterpolationBuffer();
    buf.push(0, 0, 1000);
    buf.push(10, 0, 1100);
    expect(buf.sample(5000)).toEqual({ x: 10, y: 0 });
  });

  it("clamps to the oldest sample rather than extrapolating before it", () => {
    const buf = new InterpolationBuffer();
    buf.push(0, 0, 1000);
    buf.push(10, 0, 1100);
    expect(buf.sample(0)).toEqual({ x: 0, y: 0 });
  });

  it("picks the pair of samples that actually brackets the render time, not just the newest two", () => {
    const buf = new InterpolationBuffer();
    buf.push(0, 0, 1000);
    buf.push(10, 0, 1100);
    buf.push(30, 0, 1300);
    // 1150 falls between the first and second sample, not the second and third.
    expect(buf.sample(1150)).toEqual({ x: 15, y: 0 });
  });

  it("drops the oldest sample once more than maxHistory have been pushed", () => {
    const buf = new InterpolationBuffer(2);
    buf.push(0, 0, 1000);
    buf.push(10, 0, 1100);
    buf.push(20, 0, 1200);
    expect(buf.size).toBe(2);
    // The t=1000 sample is gone, so sampling at 1050 clamps to the oldest remaining (t=1100).
    expect(buf.sample(1050)).toEqual({ x: 10, y: 0 });
  });
});

describe("renderTimeFor", () => {
  it("subtracts the configured delay from the current time", () => {
    expect(renderTimeFor(10_000, 150)).toBe(9850);
  });
});
