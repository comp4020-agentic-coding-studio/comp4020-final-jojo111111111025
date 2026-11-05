/**
 * Smooths how remote players and enemies are drawn between network updates.
 *
 * The server ticks physics at 20Hz but only broadcasts positions at 10Hz
 * (`SNAPSHOT_MS` in `src/shared/constants.ts`), while the client renders at
 * up to 60fps. Drawing each entity at its last-received position makes it
 * visibly step once per snapshot instead of gliding. This buffers the last
 * few received positions per entity and, at render time, interpolates
 * between the two that bracket a render timestamp held slightly behind the
 * client's own clock — never ahead of it, so it never has to guess (and
 * potentially overshoot past a wall) where an entity is going next.
 *
 * This only changes what the client *draws*. The server remains the sole
 * authority on where anything actually is; no gather/attack/build range
 * check or any other validation reads from this buffer.
 */

export interface TimedPosition {
  /** Client-local monotonic time (e.g. `performance.now()`) this sample was received at. */
  t: number;
  x: number;
  y: number;
}

export class InterpolationBuffer {
  private history: TimedPosition[] = [];

  constructor(private readonly maxHistory = 4) {}

  /** Records a newly received position. Must be called with non-decreasing `t`. */
  push(x: number, y: number, t: number): void {
    this.history.push({ x, y, t });
    if (this.history.length > this.maxHistory) this.history.shift();
  }

  /** How many samples are currently buffered (exposed for tests). */
  get size(): number {
    return this.history.length;
  }

  /**
   * The position to draw at client time `renderT`. Interpolates between the
   * two buffered samples that bracket `renderT`; clamps to the nearest
   * endpoint rather than extrapolating past it when `renderT` falls outside
   * the buffered range (too old, or newer than anything received yet).
   */
  sample(renderT: number): { x: number; y: number } {
    if (this.history.length === 0) return { x: 0, y: 0 };
    if (this.history.length === 1) {
      const only = this.history[0];
      return { x: only.x, y: only.y };
    }

    for (let i = this.history.length - 1; i > 0; i--) {
      const a = this.history[i - 1];
      const b = this.history[i];
      if (renderT >= a.t && renderT <= b.t) {
        const span = b.t - a.t;
        const alpha = span <= 0 ? 1 : (renderT - a.t) / span;
        return { x: a.x + (b.x - a.x) * alpha, y: a.y + (b.y - a.y) * alpha };
      }
    }

    const first = this.history[0];
    const last = this.history[this.history.length - 1];
    return renderT <= first.t ? { x: first.x, y: first.y } : { x: last.x, y: last.y };
  }
}

/**
 * The render timestamp to sample buffers at: deliberately behind the
 * client's own clock by roughly one snapshot interval, so `sample()` is
 * almost always interpolating between two already-received points instead
 * of being asked to predict past the newest one.
 */
export function renderTimeFor(nowMs: number, delayMs: number): number {
  return nowMs - delayMs;
}
