import { DAY_DURATION_MS, DAY_NIGHT_CYCLE_MS, NIGHT_DURATION_MS } from "./constants.js";

export interface TimeOfDay {
  isNight: boolean;
  /** 0..1 progress through the current day or night segment. */
  progress: number;
  /** Milliseconds remaining in the current segment. */
  msRemaining: number;
}

/**
 * Pure function of the world's creation timestamp and the current time — no
 * ticking, no persisted "current phase" field. The same (worldCreatedAt, now)
 * pair always yields the same result, so a restart can't desync day/night:
 * the cycle simply continues exactly where wall-clock time says it should be,
 * the same derivation style computeCropStage already established.
 */
export function computeTimeOfDay(worldCreatedAt: number, now: number): TimeOfDay {
  const elapsed = Math.max(0, now - worldCreatedAt);
  const cyclePos = elapsed % DAY_NIGHT_CYCLE_MS;

  if (cyclePos < DAY_DURATION_MS) {
    return {
      isNight: false,
      progress: cyclePos / DAY_DURATION_MS,
      msRemaining: DAY_DURATION_MS - cyclePos,
    };
  }

  const nightPos = cyclePos - DAY_DURATION_MS;
  return {
    isNight: true,
    progress: nightPos / NIGHT_DURATION_MS,
    msRemaining: NIGHT_DURATION_MS - nightPos,
  };
}
