import { afterEach, describe, expect, it } from "vitest";
import { ObjectDepletedMessage } from "../src/shared/messages.js";
import { applyObjectDepleted } from "../src/client/net.js";
import type { DungeonMap, WorldMap } from "../src/shared/types.js";
import { TestClient, startTestServer, type TestServer } from "./helpers/server-harness.js";
import { compactIntegrationMap, emptyDungeon } from "./helpers/test-fixtures.js";

let server: TestServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("ObjectDepletedMessage schema", () => {
  it("accepts a well-formed message", () => {
    const result = ObjectDepletedMessage.safeParse({
      type: "object.depleted",
      objectId: "bush-1",
      remaining: 3,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a message missing remaining", () => {
    const result = ObjectDepletedMessage.safeParse({
      type: "object.depleted",
      objectId: "bush-1",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a message with the wrong type literal", () => {
    const result = ObjectDepletedMessage.safeParse({
      type: "action.result",
      objectId: "bush-1",
      remaining: 3,
    });
    expect(result.success).toBe(false);
  });
});

describe("object.depleted — full wire path", () => {
  it("a successful gather is broadcast as object.depleted to every connected client, carrying the gathered object's id and its new remaining count", async () => {
    server = await startTestServer({ roomCode: "TEST", map: compactIntegrationMap(), enemySpawns: [] });
    const gatherer = new TestClient(server.wsUrl);
    const observer = new TestClient(server.wsUrl);
    await gatherer.join("Alice", "TEST");
    await observer.join("Bob", "TEST");

    // wood-node-1 sits at (0,1) with remaining:1000 — within GATHER_RANGE_TILES
    // of spawn (1.5,1.5), no walk needed.
    gatherer.send({ type: "player.interact", requestId: "g1", objectId: "wood-node-1" });
    const result = await gatherer.waitFor((m) => m.requestId === "g1");
    expect(result.ok).toBe(true);
    expect(result.objectRemaining).toBe(999);

    const broadcastToObserver = await observer.waitFor((m) => m.type === "object.depleted");
    expect(broadcastToObserver.objectId).toBe("wood-node-1");
    expect(broadcastToObserver.remaining).toBe(999);

    // The gatherer itself also receives the broadcast (it's room-wide, not
    // "every connection except the actor" like combat.event's pattern).
    const broadcastToGatherer = await gatherer.waitFor((m) => m.type === "object.depleted");
    expect(broadcastToGatherer.remaining).toBe(999);
  });

  it("a failed gather (too far) is never broadcast", async () => {
    server = await startTestServer({ roomCode: "TEST", map: compactIntegrationMap(), enemySpawns: [] });
    const client = new TestClient(server.wsUrl);
    const observer = new TestClient(server.wsUrl);
    await client.join("Alice", "TEST");
    await observer.join("Bob", "TEST");

    // berries-node-1 is at (0,3) — out of GATHER_RANGE_TILES from spawn (1.5,1.5).
    client.send({ type: "player.interact", requestId: "g1", objectId: "berries-node-1" });
    const result = await client.waitFor((m) => m.requestId === "g1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("too_far");

    // Give any erroneous broadcast a moment to arrive, then confirm nothing did.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(observer.messages.some((m) => m.type === "object.depleted")).toBe(false);
  });

  it("a gather on a dungeon resource node is broadcast and synced the same as an overworld one", async () => {
    const dungeon: DungeonMap = {
      width: 6,
      height: 6,
      tiles: Array.from({ length: 6 * 6 }, () => ({ terrain: "grass" as const })),
      objects: [
        { id: "dungeon-exit-1", kind: "dungeon_exit", x: 1, y: 1, zone: "dungeon" },
        {
          id: "dungeon-berries-1",
          kind: "bush",
          x: 1,
          y: 2,
          zone: "dungeon",
          resource: { kind: "berries", remaining: 5, maxRemaining: 5 },
        },
      ],
      entryPoint: { x: 1, y: 1 },
      beaconLocation: { x: 2, y: 1 },
    };
    const map: WorldMap = {
      seed: "test-dungeon-gather",
      width: 10,
      height: 10,
      tiles: Array.from({ length: 100 }, () => ({ terrain: "grass" as const })),
      objects: [{ id: "entrance-1", kind: "dungeon_entrance", x: 2, y: 2, zone: "overworld" }],
      campsite: { x: 1, y: 1 },
      spawnPoint: { x: 1, y: 1 },
      farmArea: { x: 0, y: 0, width: 0, height: 0 },
      dungeonEntrance: { x: 2, y: 2 },
      dungeon,
    };
    server = await startTestServer({ roomCode: "TEST", map, enemySpawns: [] });
    const client = new TestClient(server.wsUrl);
    const observer = new TestClient(server.wsUrl);
    const joined = await client.join("Alice", "TEST");
    await observer.join("Bob", "TEST");

    // Walk to the dungeon entrance (within ZONE_TRANSITION_RANGE_TILES of (2,2)), then enter.
    await walkTo(client, joined.playerId, 2.5, 2.5);
    client.send({ type: "zone.enter", requestId: "zone-1", objectId: "entrance-1", target: "dungeon" });
    await client.waitFor((m) => m.requestId === "zone-1");

    // dungeon-berries-1 sits at (1,2), within range of the dungeon's own entry point (1,1).
    client.send({ type: "player.interact", requestId: "g1", objectId: "dungeon-berries-1" });
    const result = await client.waitFor((m) => m.requestId === "g1");
    expect(result.ok).toBe(true);
    expect(result.objectRemaining).toBe(4);

    const broadcastToObserver = await observer.waitFor((m) => m.type === "object.depleted");
    expect(broadcastToObserver.objectId).toBe("dungeon-berries-1");
    expect(broadcastToObserver.remaining).toBe(4);
  });
});

/** Steers `playerId` toward (tx, ty) via player.input, the same way a real client would — see phase-d-integration.spec.ts for the original. */
function walkTo(client: TestClient, playerId: string, tx: number, ty: number, timeoutMs = 10000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const iv = setInterval(() => {
      const latest = [...client.messages].reverse().find((m) => m.type === "player.state");
      const pos = latest?.players.find((p: any) => p.id === playerId);
      if (!pos) return;
      const dx = tx - pos.x;
      const dy = ty - pos.y;
      const d = Math.hypot(dx, dy);
      if (d < 0.5) {
        clearInterval(iv);
        client.send({ type: "player.input", seq: 999999, dx: 0, dy: 0 });
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        clearInterval(iv);
        reject(new Error("walkTo timeout"));
        return;
      }
      client.send({ type: "player.input", seq: Date.now(), dx, dy });
    }, 20);
  });
}

describe("applyObjectDepleted (client-side state sync)", () => {
  function makeWorld(): WorldMap & { dungeon: DungeonMap } {
    return {
      seed: "test",
      width: 4,
      height: 4,
      tiles: Array.from({ length: 16 }, () => ({ terrain: "grass" as const })),
      objects: [
        {
          id: "overworld-bush",
          kind: "bush",
          x: 1,
          y: 1,
          resource: { kind: "berries", remaining: 3, maxRemaining: 3 },
        },
      ],
      campsite: { x: 0, y: 0 },
      spawnPoint: { x: 0, y: 0 },
      farmArea: { x: 0, y: 0, width: 0, height: 0 },
      dungeonEntrance: { x: 0, y: 0 },
      dungeon: {
        ...emptyDungeon(),
        objects: [
          {
            id: "dungeon-rock",
            kind: "rock",
            x: 1,
            y: 1,
            zone: "dungeon",
            resource: { kind: "stone", remaining: 2, maxRemaining: 2 },
          },
        ],
      },
    };
  }

  it("updates an overworld object's remaining count in place", () => {
    const world = makeWorld();
    applyObjectDepleted(world, { objectId: "overworld-bush", remaining: 2 });
    expect(world.objects[0]!.resource!.remaining).toBe(2);
  });

  it("updates a dungeon object's remaining count in place", () => {
    const world = makeWorld();
    applyObjectDepleted(world, { objectId: "dungeon-rock", remaining: 1 });
    expect(world.dungeon.objects[0]!.resource!.remaining).toBe(1);
  });

  it("keeps the object (does not remove it) when remaining reaches 0", () => {
    const world = makeWorld();
    applyObjectDepleted(world, { objectId: "overworld-bush", remaining: 0 });
    expect(world.objects).toHaveLength(1);
    expect(world.objects[0]!.id).toBe("overworld-bush");
    expect(world.objects[0]!.resource!.remaining).toBe(0);
  });

  it("does nothing when world is null (not yet snapshotted)", () => {
    expect(() => applyObjectDepleted(null, { objectId: "overworld-bush", remaining: 0 })).not.toThrow();
  });

  it("does nothing when the objectId matches nothing in either zone", () => {
    const world = makeWorld();
    applyObjectDepleted(world, { objectId: "does-not-exist", remaining: 0 });
    expect(world.objects[0]!.resource!.remaining).toBe(3);
    expect(world.dungeon.objects[0]!.resource!.remaining).toBe(2);
  });
});
