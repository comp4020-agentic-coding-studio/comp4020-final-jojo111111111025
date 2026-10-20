import { afterEach, describe, expect, it } from "vitest";
import { TestClient, startTestServer, type TestServer } from "./helpers/server-harness.js";

let server: TestServer;

afterEach(async () => {
  await server?.close();
});

describe("room code validation", () => {
  it("rejects a wrong room code and never creates a player", async () => {
    server = await startTestServer({ roomCode: "RIGHT-CODE" });
    const client = new TestClient(server.wsUrl);
    const result = await client.join("Alice", "WRONG-CODE");

    expect(result.type).toBe("server.error");
    expect(result.message).toBe("invalid_room_code");
    expect(server.room.playerCount).toBe(0);
    client.close();
  });

  it("accepts the correct room code", async () => {
    server = await startTestServer({ roomCode: "RIGHT-CODE" });
    const client = new TestClient(server.wsUrl);
    const result = await client.join("Alice", "RIGHT-CODE");

    expect(result.type).toBe("room.joined");
    expect(server.room.playerCount).toBe(1);
    client.close();
  });
});

describe("four-player cap", () => {
  it("admits exactly four distinct identities and rejects a fifth", async () => {
    server = await startTestServer({ roomCode: "TEST" });
    const clients = [1, 2, 3, 4].map(() => new TestClient(server.wsUrl));

    for (const [i, client] of clients.entries()) {
      const result = await client.join(`Player${i}`, "TEST");
      expect(result.type).toBe("room.joined");
    }
    expect(server.room.playerCount).toBe(4);

    const fifth = new TestClient(server.wsUrl);
    const fifthResult = await fifth.join("Player5", "TEST");
    expect(fifthResult.type).toBe("server.error");
    expect(fifthResult.message).toBe("room_full");
    expect(server.room.playerCount).toBe(4);

    for (const client of clients) client.close();
    fifth.close();
  });

  it("rejects concurrent fifth-player joins fired back-to-back on already-open sockets", async () => {
    server = await startTestServer({ roomCode: "TEST" });
    const clients = [1, 2, 3, 4].map(() => new TestClient(server.wsUrl));
    for (const [i, client] of clients.entries()) {
      await client.join(`Player${i}`, "TEST");
    }
    expect(server.room.playerCount).toBe(4);

    // Open two more sockets and fire room.join on both without awaiting
    // between them, to exercise the same synchronous capacity-check path
    // concurrent requests would hit.
    const fifth = new TestClient(server.wsUrl);
    const sixth = new TestClient(server.wsUrl);
    await Promise.all([fifth.waitOpen(), sixth.waitOpen()]);
    fifth.send({ type: "room.join", requestId: "r5", name: "Five", roomCode: "TEST" });
    sixth.send({ type: "room.join", requestId: "r6", name: "Six", roomCode: "TEST" });

    const [fifthResult, sixthResult] = await Promise.all([
      fifth.waitFor((m) => m.requestId === "r5" || m.type === "server.error"),
      sixth.waitFor((m) => m.requestId === "r6" || m.type === "server.error"),
    ]);

    expect(fifthResult.type).toBe("server.error");
    expect(sixthResult.type).toBe("server.error");
    expect(server.room.playerCount).toBe(4);

    for (const client of clients) client.close();
    fifth.close();
    sixth.close();
  });

  it("after a disconnected player's grace window lapses, a new fifth identity can join", async () => {
    server = await startTestServer({ roomCode: "TEST", reconnectGraceMs: 100 });
    const clients = [1, 2, 3, 4].map(() => new TestClient(server.wsUrl));
    for (const [i, client] of clients.entries()) {
      await client.join(`Player${i}`, "TEST");
    }
    expect(server.room.playerCount).toBe(4);

    // Player 0 disconnects and never comes back.
    clients[0]!.close();
    await new Promise((resolve) => setTimeout(resolve, 300)); // past the 100ms grace window

    const fifth = new TestClient(server.wsUrl);
    const fifthResult = await fifth.join("NewPlayer", "TEST");
    expect(fifthResult.type).toBe("room.joined");
    expect(server.room.playerCount).toBe(4);

    for (const client of clients.slice(1)) client.close();
    fifth.close();
  });
});
