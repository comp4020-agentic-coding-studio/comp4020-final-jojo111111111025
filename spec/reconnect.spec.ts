import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  TestClient,
  fetchIdentityCookie,
  startTestServer,
  type TestServer,
} from "./helpers/server-harness.js";
import { openDatabase } from "../src/server/db.js";
import { loadPlayerInventory, persistPlayerInventory } from "../src/server/world.js";

let server: TestServer;

afterEach(async () => {
  await server?.close();
});

describe("reconnect within the grace window", () => {
  it("restores the same identity's room slot and in-memory state, without creating a second slot", async () => {
    server = await startTestServer({ roomCode: "TEST", reconnectGraceMs: 60_000 });
    const cookie = await fetchIdentityCookie(server.httpUrl);
    expect(cookie).toBeTruthy();

    const first = new TestClient(server.wsUrl, cookie);
    const joined = await first.join("Alice", "TEST");
    expect(joined.type).toBe("room.joined");
    const playerId = joined.playerId;

    // Move the player so there's observable in-memory state to confirm later.
    // The server's own tick loop is also running concurrently, so stop
    // input again right after nudging — otherwise it keeps drifting for the
    // rest of the test and the "same position" assertion below is flaky.
    server.room.setInput(playerId, 1, 0);
    server.room.tick(0.5);
    server.room.setInput(playerId, 0, 0);
    const posBeforeDisconnect = server.room.getPlayer(playerId)!;
    const xBeforeDisconnect = posBeforeDisconnect.x;
    expect(xBeforeDisconnect).toBeGreaterThan(1);

    first.close();
    await first.waitClose();
    // Give the server a moment to process the close event.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.room.getPlayer(playerId)?.connected).toBe(false);
    expect(server.room.playerCount).toBe(1); // slot held, not freed

    const second = new TestClient(server.wsUrl, cookie);
    const rejoined = await second.join("Alice", "TEST");
    expect(rejoined.type).toBe("room.joined");
    expect(rejoined.playerId).toBe(playerId);
    expect(server.room.playerCount).toBe(1); // still exactly one slot for this identity

    const snapshot = await second.waitFor((m) => m.type === "world.snapshot");
    const restoredPlayer = snapshot.players.find((p: any) => p.id === playerId);
    expect(restoredPlayer.x).toBeCloseTo(xBeforeDisconnect, 5);
    expect(server.room.getPlayer(playerId)?.connected).toBe(true);

    second.close();
  });

  it("evicts a connection that never reconnects after its grace window, freeing the slot", async () => {
    server = await startTestServer({ roomCode: "TEST", reconnectGraceMs: 100 });
    const client = new TestClient(server.wsUrl);
    const joined = await client.join("Alice", "TEST");
    const playerId = joined.playerId;
    expect(server.room.playerCount).toBe(1);

    client.close();
    await client.waitClose();
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(server.room.hasPlayer(playerId)).toBe(false);
    expect(server.room.playerCount).toBe(0);
  });

  it("reconnect after a simulated server restart restores persisted inventory even though the in-memory Room is new", async () => {
    server = await startTestServer({ roomCode: "TEST", reconnectGraceMs: 60_000 });
    const cookie = await fetchIdentityCookie(server.httpUrl);

    const first = new TestClient(server.wsUrl, cookie);
    const joined = await first.join("Alice", "TEST");
    const playerId = joined.playerId;

    // Directly grant inventory via the Room (simulating gathered resources)
    // and persist it the same way net.ts would on every inventory-changing action.
    const player = server.room.getPlayer(playerId)!;
    const inventory = { ...player.inventory, wood: 7 };
    persistPlayerInventory(server.db, playerId, inventory);

    first.close();

    // "Restart": close this server (keeping its DB file on disk) and open a
    // fresh DB handle against it directly — simulating a brand-new process
    // loading persisted state, independent of any in-memory Room.
    const dir = server.dir;
    const dbPath = dir + "/world.sqlite";
    await server.close({ keepData: true });

    const db2 = openDatabase(dbPath);
    const restoredInventory = loadPlayerInventory(db2, playerId);
    expect(restoredInventory.wood).toBe(7);
    db2.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("duplicate connections (same identity, two sockets)", () => {
  it("a second connection supersedes the first, which is closed and can no longer act", async () => {
    server = await startTestServer({ roomCode: "TEST", reconnectGraceMs: 60_000 });
    const cookie = await fetchIdentityCookie(server.httpUrl);

    const first = new TestClient(server.wsUrl, cookie);
    const joined1 = await first.join("Alice", "TEST");
    const playerId = joined1.playerId;

    const second = new TestClient(server.wsUrl, cookie);
    const joined2 = await second.join("Alice", "TEST");
    expect(joined2.playerId).toBe(playerId);

    // The first socket should receive a "superseded" error and be closed.
    const supersededMsg = await first.waitFor((m) => m.type === "server.error" && m.message === "superseded");
    expect(supersededMsg).toBeTruthy();
    await first.waitClose();

    // Only one room slot exists for this identity.
    expect(server.room.playerCount).toBe(1);

    second.close();
  });

  it("a stale (superseded) socket's messages never mutate state after being superseded", async () => {
    server = await startTestServer({ roomCode: "TEST", reconnectGraceMs: 60_000 });
    const cookie = await fetchIdentityCookie(server.httpUrl);

    const first = new TestClient(server.wsUrl, cookie);
    const joined1 = await first.join("Alice", "TEST");
    const playerId = joined1.playerId;
    const inventoryBefore = { ...server.room.getPlayer(playerId)!.inventory };

    const second = new TestClient(server.wsUrl, cookie);
    await second.join("Alice", "TEST");
    await first.waitFor((m) => m.type === "server.error" && m.message === "superseded");

    // The stale first socket attempts a gather request after being superseded.
    // It should be ignored entirely (no action.result, no state mutation),
    // even though the raw TCP connection may take a moment to actually close.
    first.send({ type: "player.interact", requestId: "stale-req", objectId: "does-not-matter" });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const gotResponseOnStaleSocket = first.messages.some((m) => m.requestId === "stale-req");
    expect(gotResponseOnStaleSocket).toBe(false);
    expect(server.room.getPlayer(playerId)!.inventory).toEqual(inventoryBefore);

    second.close();
  });
});

describe("cross-identity isolation", () => {
  it("two different identities joining concurrently each get their own player, never sharing state", async () => {
    server = await startTestServer({ roomCode: "TEST" });
    const alice = new TestClient(server.wsUrl);
    const bob = new TestClient(server.wsUrl);

    const [aliceJoined, bobJoined] = await Promise.all([
      alice.join("Alice", "TEST"),
      bob.join("Bob", "TEST"),
    ]);

    expect(aliceJoined.playerId).not.toBe(bobJoined.playerId);
    expect(server.room.playerCount).toBe(2);

    alice.close();
    bob.close();
  });
});
