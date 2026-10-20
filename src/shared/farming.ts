import { CROP_GROWING_MS, CROP_MATURE_MS, CROP_WATER_VALID_MS } from "./constants.js";
import type { CropStage, FarmPlotState, ItemKind } from "./types.js";

/** Which item a seed grows into when harvested. */
export const SEED_TO_CROP: Partial<Record<ItemKind, ItemKind>> = {
  seed_berry: "berries",
};

/**
 * Pure function of the plot's state and the current time — no ticking, no
 * side effects. The same (plot, now) pair always yields the same stage, so a
 * restart or a long-closed browser changes nothing about how a crop reads;
 * only wall-clock time elapsed and whether it was watered matter.
 */
export function computeCropStage(plot: FarmPlotState, now: number): CropStage {
  if (plot.plantedAt === null) return "empty";

  const wateredRecently =
    plot.wateredAt !== null && plot.wateredAt >= plot.plantedAt && now - plot.wateredAt <= CROP_WATER_VALID_MS;
  if (!wateredRecently) return "planted";

  const elapsed = now - plot.plantedAt;
  if (elapsed >= CROP_MATURE_MS) return "mature";
  if (elapsed >= CROP_GROWING_MS) return "growing";
  return "planted";
}
