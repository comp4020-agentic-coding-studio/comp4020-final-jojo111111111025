import { describe, expect, it } from "vitest";
import { findGainedItem } from "../src/client/net.js";
import { emptyInventory } from "../src/shared/types.js";

/**
 * findGainedItem is the pure logic behind the pickup toast's "Gathered
 * {item}." message (main.ts's onActionResult) — a gather result's
 * `inventory` field never says which resource kind was granted on its
 * own, so the client derives it by diffing against the pre-gather
 * snapshot. Extracted into net.ts (which, unlike main.ts, has no
 * top-level DOM code) so it's testable without a browser/jsdom — same
 * reasoning as applyObjectDepleted's extraction a stage earlier.
 */
describe("findGainedItem", () => {
  it("finds the single item kind whose count increased", () => {
    const before = emptyInventory();
    const after = { ...before, wood: 1 };
    expect(findGainedItem(before, after)).toBe("wood");
  });

  it("returns undefined when nothing increased", () => {
    const before = emptyInventory();
    const after = { ...before };
    expect(findGainedItem(before, after)).toBeUndefined();
  });

  it("returns undefined when a count decreased but nothing increased (e.g. a craft that only consumes)", () => {
    const before = { ...emptyInventory(), wood: 5 };
    const after = { ...before, wood: 3 };
    expect(findGainedItem(before, after)).toBeUndefined();
  });

  it("picks out the one increased kind even when other kinds simultaneously decreased (a craft that consumes wood and grants an axe)", () => {
    const before = { ...emptyInventory(), wood: 5 };
    const after = { ...before, wood: 3, axe: 1 };
    expect(findGainedItem(before, after)).toBe("axe");
  });

  it("is order-stable — ITEM_KINDS's own declared order decides which kind wins if (hypothetically) more than one increased", () => {
    const before = emptyInventory();
    const after = { ...before, stone: 1, wood: 1 };
    // ITEM_KINDS lists "wood" before "stone" (types.ts) — the first match wins.
    expect(findGainedItem(before, after)).toBe("wood");
  });
});
