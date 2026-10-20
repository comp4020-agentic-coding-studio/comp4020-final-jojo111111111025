import type { DungeonMap, WorldMap } from "../../src/shared/types.js";

/**
 * A minimal, empty dungeon fixture for unit tests that don't exercise
 * dungeon/boss/beacon behaviour and just need a structurally valid WorldMap.
 * Tests that do exercise the dungeon build their own DungeonMap explicitly.
 */
export function emptyDungeon(): DungeonMap {
  const width = 4;
  const height = 4;
  return {
    width,
    height,
    tiles: Array.from({ length: width * height }, () => ({ terrain: "grass" as const })),
    objects: [],
    entryPoint: { x: 1, y: 1 },
    beaconLocation: { x: 2, y: 2 },
  };
}

/**
 * A compact WorldMap for end-to-end harness tests that need to drive a
 * player all the way through gather -> dungeon -> combat -> beacon over the
 * real wire protocol within a test timeout. The real seeded dev map (used by
 * startTestServer's default) places its dungeon/beacon dozens of tiles from
 * spawn — walkable, but far too slow for a test. Everything here sits within
 * a few tiles of spawn (1.5, 1.5): the dungeon entrance at (3, 1), the
 * dungeon's own exit/beacon both near its entry point, and one each of a
 * wood/stone/berries node so a player can gather every beacon material
 * without leaving the small overworld room.
 */
export function compactIntegrationMap(): WorldMap {
  const width = 12;
  const height = 12;
  const tiles = Array.from({ length: width * height }, () => ({ terrain: "grass" as const }));
  const dungeon: DungeonMap = {
    width: 8,
    height: 8,
    tiles: Array.from({ length: 8 * 8 }, () => ({ terrain: "grass" as const })),
    objects: [
      { id: "dungeon-exit-1", kind: "dungeon_exit", x: 1, y: 1, zone: "dungeon" },
      { id: "beacon-1", kind: "ancient_beacon", x: 2, y: 1, zone: "dungeon" },
    ],
    entryPoint: { x: 1, y: 1 },
    beaconLocation: { x: 2, y: 1 },
  };
  return {
    seed: "compact-integration-test",
    width,
    height,
    tiles,
    objects: [
      { id: "entrance-1", kind: "dungeon_entrance", x: 3, y: 1, zone: "overworld" },
      { id: "wood-node-1", kind: "tree", x: 0, y: 1, resource: { kind: "wood", remaining: 1000, maxRemaining: 1000 } },
      { id: "stone-node-1", kind: "rock", x: 0, y: 2, resource: { kind: "stone", remaining: 1000, maxRemaining: 1000 } },
      { id: "berries-node-1", kind: "bush", x: 0, y: 3, resource: { kind: "berries", remaining: 1000, maxRemaining: 1000 } },
    ],
    campsite: { x: 5, y: 5 },
    spawnPoint: { x: 1, y: 1 },
    farmArea: { x: 0, y: 0, width: 0, height: 0 },
    dungeonEntrance: { x: 3, y: 1 },
    dungeon,
  };
}
