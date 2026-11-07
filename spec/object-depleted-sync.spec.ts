import { afterEach, describe, expect, it } from "vitest";
import { ObjectDepletedMessage } from "../src/shared/messages.js";
import { applyObjectDepleted } from "../src/client/net.js";
import type { WorldMap } from "../src/shared/types.js";
import { TestClient, startTestServer, type TestServer } from "./helpers/server-harness.js";
import { compactIntegrationMap } from "./helpers/test-fixtures.js";

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
});

describe("applyObjectDepleted (client-side state sync)", () => {
  function makeWorld(): WorldMap {
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
    };
  }

  it("updates an object's remaining count in place", () => {
    const world = makeWorld();
    applyObjectDepleted(world, { objectId: "overworld-bush", remaining: 2 });
    expect(world.objects[0]!.resource!.remaining).toBe(2);
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

  it("does nothing when the objectId matches nothing", () => {
    const world = makeWorld();
    applyObjectDepleted(world, { objectId: "does-not-exist", remaining: 0 });
    expect(world.objects[0]!.resource!.remaining).toBe(3);
  });
});
