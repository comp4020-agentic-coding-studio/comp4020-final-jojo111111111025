import { afterEach, describe, expect, it } from "vitest";
import { TestClient, startTestServer, type TestServer } from "./helpers/server-harness.js";
import { compactIntegrationMap } from "./helpers/test-fixtures.js";

let server: TestServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("resource nodes restock once no player is connected", () => {
  it("restores a gathered node's remaining to maxRemaining the instant the last connected player disconnects", async () => {
    server = await startTestServer({ roomCode: "TEST", reconnectGraceMs: 60_000, map: compactIntegrationMap() });
    const client = new TestClient(server.wsUrl);
    await client.join("Alice", "TEST");

    client.send({ type: "player.interact", requestId: "g1", objectId: "wood-node-1" });
    const result = await client.waitFor((m) => m.requestId === "g1");
    expect(result.ok).toBe(true);
    expect(result.objectRemaining).toBe(999);

    client.close();
    await client.waitClose();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // The player's own room slot is still held (reconnect grace window is
    // long), but nobody is connected right now, so the node should already
    // be restocked in memory.
    const node = server.room.map.objects.find((o) => o.id === "wood-node-1");
    expect(node?.resource?.remaining).toBe(1000);

    // And persisted — object-depletion rows go through the same
    // persistNodeRemaining upsert a normal gather uses.
    const row = server.db
      .prepare("SELECT remaining FROM resource_nodes WHERE object_id = ?")
      .get("wood-node-1") as { remaining: number } | undefined;
    expect(row?.remaining).toBe(1000);
  });

  it("does not reset resources while at least one player is still connected", async () => {
    server = await startTestServer({ roomCode: "TEST", reconnectGraceMs: 60_000, map: compactIntegrationMap() });
    const alice = new TestClient(server.wsUrl);
    const bob = new TestClient(server.wsUrl);
    await alice.join("Alice", "TEST");
    await bob.join("Bob", "TEST");

    alice.send({ type: "player.interact", requestId: "g1", objectId: "wood-node-1" });
    const result = await alice.waitFor((m) => m.requestId === "g1");
    expect(result.ok).toBe(true);
    expect(result.objectRemaining).toBe(999);

    alice.close();
    await alice.waitClose();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Bob is still connected, so nothing should have reset.
    const node = server.room.map.objects.find((o) => o.id === "wood-node-1");
    expect(node?.resource?.remaining).toBe(999);

    bob.close();
    await bob.waitClose();
  });
});
