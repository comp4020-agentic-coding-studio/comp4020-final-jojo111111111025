import type { WorldMap } from "../../src/shared/types.js";

/**
 * A compact WorldMap for end-to-end harness tests that need to drive a
 * player all the way through gather -> craft -> combat over the real wire
 * protocol within a test timeout. The real seeded dev map (used by
 * startTestServer's default) is far too large to walk across in a test.
 * Everything here sits within a few tiles of spawn (1.5, 1.5): one each of
 * a wood/stone/berries node so a player can gather every material they
 * need without walking far, and nearby enemy spawns for combat tests.
 */
export function compactIntegrationMap(): WorldMap {
  const width = 12;
  const height = 12;
  const tiles = Array.from({ length: width * height }, () => ({ terrain: "grass" as const }));
  return {
    seed: "compact-integration-test",
    width,
    height,
    tiles,
    objects: [
      { id: "wood-node-1", kind: "tree", x: 0, y: 1, resource: { kind: "wood", remaining: 1000, maxRemaining: 1000 } },
      { id: "stone-node-1", kind: "rock", x: 0, y: 2, resource: { kind: "stone", remaining: 1000, maxRemaining: 1000 } },
      { id: "berries-node-1", kind: "bush", x: 0, y: 3, resource: { kind: "berries", remaining: 1000, maxRemaining: 1000 } },
    ],
    campsite: { x: 5, y: 5 },
    spawnPoint: { x: 1, y: 1 },
  };
}
