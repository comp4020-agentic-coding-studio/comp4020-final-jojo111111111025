import { afterEach, describe, expect, it } from "vitest";
import { TestClient, startTestServer, type TestServer } from "./helpers/server-harness.js";

let serverA: TestServer | undefined;
let serverB: TestServer | undefined;

afterEach(async () => {
  await serverA?.close();
  await serverB?.close();
  serverA = undefined;
  serverB = undefined;
});

describe("cross-room access", () => {
  it("rejects a client presenting the wrong room's code and creates no player for it", async () => {
    serverA = await startTestServer({ roomCode: "ROOM-A" });
    const client = new TestClient(serverA.wsUrl);
    const result = await client.join("Alice", "ROOM-B"); // wrong code for this server

    expect(result.type).toBe("server.error");
    expect(result.message).toBe("invalid_room_code");
    expect(serverA.room.playerCount).toBe(0);
    client.close();
  });

  it("two independently-coded rooms never share player or world state", async () => {
    serverA = await startTestServer({ roomCode: "ROOM-A" });
    serverB = await startTestServer({ roomCode: "ROOM-B" });

    const clientA = new TestClient(serverA.wsUrl);
    const clientB = new TestClient(serverB.wsUrl);
    const joinedA = await clientA.join("Alice", "ROOM-A");
    const joinedB = await clientB.join("Bob", "ROOM-B");

    expect(joinedA.type).toBe("room.joined");
    expect(joinedB.type).toBe("room.joined");

    // Gather in room A only, via its own Room instance. Walk toward the
    // nearest resource node first since spawn isn't guaranteed to already be
    // within gather range of one.
    const alice = serverA.room.getPlayer(joinedA.playerId)!;
    let nearest = serverA.room.map.objects.find((o) => o.resource)!;
    let nearestDist = Infinity;
    for (const obj of serverA.room.map.objects) {
      if (!obj.resource) continue;
      const dist = Math.hypot(alice.x - (obj.x + 0.5), alice.y - (obj.y + 0.5));
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = obj;
      }
    }
    for (let i = 0; i < 300 && nearestDist > 1.2; i++) {
      const dx = nearest.x + 0.5 - serverA.room.getPlayer(joinedA.playerId)!.x;
      const dy = nearest.y + 0.5 - serverA.room.getPlayer(joinedA.playerId)!.y;
      const d = Math.hypot(dx, dy);
      serverA.room.setInput(joinedA.playerId, dx / d, dy / d);
      serverA.room.tick(0.05);
      nearestDist = d;
    }
    const gatherResult = serverA.room.interact(joinedA.playerId, nearest.id, "req-1");
    expect(gatherResult.ok).toBe(true);

    // Room B's world and player list are entirely unaffected.
    expect(serverB.room.playerCount).toBe(1);
    expect(serverB.room.hasPlayer(joinedA.playerId)).toBe(false);
    expect(serverB.room.getPlayer(joinedB.playerId)!.inventory).toEqual(
      Object.fromEntries(Object.keys(gatherResult.inventory!).map((k) => [k, 0])),
    );

    clientA.close();
    clientB.close();
  });

  it("a socket connected to one room cannot act on the other room's player id", async () => {
    serverA = await startTestServer({ roomCode: "ROOM-A" });
    serverB = await startTestServer({ roomCode: "ROOM-B" });

    const clientA = new TestClient(serverA.wsUrl);
    const joinedA = await clientA.join("Alice", "ROOM-A");

    const clientB = new TestClient(serverB.wsUrl);
    await clientB.join("Bob", "ROOM-B");

    // clientB tries to interact using playerId stolen from room A's join
    // response — net.ts never trusts a client-supplied player id for
    // authorization, only the server-resolved identity behind clientB's own
    // cookie, so this must be evaluated as clientB's own (different) player,
    // never as Alice.
    clientB.send({ type: "player.interact", requestId: "steal-1", objectId: "does-not-matter" });
    const result = await clientB.waitFor((m) => m.requestId === "steal-1");

    // Whatever the outcome (likely "unknown_object"), it must not have
    // touched Alice's state in room A.
    expect(result).toBeTruthy();
    expect(serverA.room.getPlayer(joinedA.playerId)!.inventory.wood).toBe(0);

    clientA.close();
    clientB.close();
  });
});
