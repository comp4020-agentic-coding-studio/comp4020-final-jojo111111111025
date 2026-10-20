import { afterEach, describe, expect, it } from "vitest";
import { loadPlayerInventory } from "../src/server/world.js";
import { TestClient, fetchIdentityCookie, startTestServer, type TestServer } from "./helpers/server-harness.js";

let server: TestServer;

afterEach(async () => {
  await server?.close();
});

/**
 * Regression coverage for a real gap found while auditing Phase A-C before
 * starting Phase D: the integration test harness constructed its `Room`
 * with no RoomPersistence hooks at all (unlike src/server/index.ts, which
 * wires every hook), so every "full stack" integration test (room-limit,
 * reconnect, duplicate-connection) was exercising a server that looked
 * identical from the outside but never actually wrote gameplay state to
 * SQLite. Phase C's own reconnect/player-persistence tests happened to pass
 * anyway because they called the persistence functions directly rather than
 * going through a live gather/craft/build/farm action on the harness
 * server — so the gap was invisible to the existing suite. These tests
 * exercise the harness server exactly as a real client would and assert the
 * database actually reflects what happened.
 */
describe("in-memory Room state matches SQLite persistence (via the real server, not direct function calls)", () => {
  it("a gather through the live harness server persists the resulting inventory", async () => {
    server = await startTestServer({ roomCode: "TEST" });
    const cookie = await fetchIdentityCookie(server.httpUrl);
    const client = new TestClient(server.wsUrl, cookie);
    const joined = await client.join("Alice", "TEST");
    const playerId = joined.playerId;

    const snapshot = await client.waitFor((m) => m.type === "world.snapshot");
    let pos = snapshot.players.find((p: any) => p.id === playerId);

    const node = nearest(snapshot.objects, pos, "wood");
    await walkTo(client, playerId, node.x + 0.5, node.y + 0.5, (p) => (pos = p), pos);

    client.send({ type: "player.interact", requestId: "gather-1", objectId: node.id });
    const result = await client.waitFor((m) => m.requestId === "gather-1");
    expect(result.ok).toBe(true);
    expect(result.inventory.wood).toBeGreaterThan(0);

    // The database — not just the in-memory Room — must reflect this gather.
    const persisted = loadPlayerInventory(server.db, playerId);
    expect(persisted.wood).toBe(result.inventory.wood);

    client.close();
  });

  it("resource node depletion from a live gather is reflected in the database", async () => {
    server = await startTestServer({ roomCode: "TEST" });
    const client = new TestClient(server.wsUrl);
    const joined = await client.join("Alice", "TEST");
    const playerId = joined.playerId;

    const snapshot = await client.waitFor((m) => m.type === "world.snapshot");
    let pos = snapshot.players.find((p: any) => p.id === playerId);
    const node = nearest(snapshot.objects, pos, "wood");
    await walkTo(client, playerId, node.x + 0.5, node.y + 0.5, (p) => (pos = p), pos);

    client.send({ type: "player.interact", requestId: "gather-1", objectId: node.id });
    const result = await client.waitFor((m) => m.requestId === "gather-1");
    expect(result.ok).toBe(true);

    const row = server.db.prepare("SELECT remaining FROM resource_nodes WHERE object_id = ?").get(node.id) as
      | { remaining: number }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.remaining).toBe(result.objectRemaining);

    client.close();
  });

  it("a building placed through the live harness server is persisted with UNIQUE(x,y) still enforced", async () => {
    server = await startTestServer({ roomCode: "TEST" });
    const client = new TestClient(server.wsUrl);
    const joined = await client.join("Alice", "TEST");
    const playerId = joined.playerId;

    const snapshot = await client.waitFor((m) => m.type === "world.snapshot");
    let pos = snapshot.players.find((p: any) => p.id === playerId);
    const woodNode = nearest(snapshot.objects, pos, "wood");
    await walkTo(client, playerId, woodNode.x + 0.5, woodNode.y + 0.5, (p) => (pos = p), pos);

    // Gather enough wood for a floor (costs 1 wood).
    client.send({ type: "player.interact", requestId: "gather-1", objectId: woodNode.id });
    const gatherResult = await client.waitFor((m) => m.requestId === "gather-1");
    expect(gatherResult.ok).toBe(true);

    const targetX = Math.floor(pos.x);
    const targetY = Math.floor(pos.y) + 1;
    client.send({ type: "building.place", requestId: "build-1", recipeId: "floor", x: targetX, y: targetY });
    const buildResult = await client.waitFor((m) => m.requestId === "build-1");
    expect(buildResult.ok).toBe(true);

    const row = server.db.prepare("SELECT id, kind, x, y FROM buildings WHERE id = ?").get(buildResult.buildingId);
    expect(row).toBeDefined();
    expect((row as any).kind).toBe("floor");

    client.close();
  });

  it("the integration harness's Room is wired with the same persistence hooks as production (regression for the found gap)", async () => {
    server = await startTestServer({ roomCode: "TEST" });
    const client = new TestClient(server.wsUrl);
    const joined = await client.join("Alice", "TEST");
    const playerId = joined.playerId;

    const snapshot = await client.waitFor((m) => m.type === "world.snapshot");
    let pos = snapshot.players.find((p: any) => p.id === playerId);
    const node = nearest(snapshot.objects, pos, "wood");
    await walkTo(client, playerId, node.x + 0.5, node.y + 0.5, (p) => (pos = p), pos);
    client.send({ type: "player.interact", requestId: "gather-1", objectId: node.id });
    await client.waitFor((m) => m.requestId === "gather-1");

    // The whole point: a row must exist in player_inventory keyed by the
    // identity's id, purely from driving the server over the wire — not
    // from calling persistPlayerInventory() directly in the test.
    const row = server.db
      .prepare("SELECT quantity FROM player_inventory WHERE player_id = ? AND item_kind = 'wood'")
      .get(playerId) as { quantity: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.quantity).toBeGreaterThan(0);

    client.close();
  });

  it("gathered inventory and depleted nodes survive a full server restart, driven entirely through the wire protocol", async () => {
    server = await startTestServer({ roomCode: "TEST", reconnectGraceMs: 60_000 });
    const cookie = await fetchIdentityCookie(server.httpUrl);
    const client = new TestClient(server.wsUrl, cookie);
    const joined = await client.join("Alice", "TEST");
    const playerId = joined.playerId;

    const snapshot = await client.waitFor((m) => m.type === "world.snapshot");
    let pos = snapshot.players.find((p: any) => p.id === playerId);
    const node = nearest(snapshot.objects, pos, "wood");
    await walkTo(client, playerId, node.x + 0.5, node.y + 0.5, (p) => (pos = p), pos);
    client.send({ type: "player.interact", requestId: "gather-1", objectId: node.id });
    const gatherResult = await client.waitFor((m) => m.requestId === "gather-1");
    expect(gatherResult.ok).toBe(true);
    client.close();

    // Full restart: close this server (keeping its DB file), start a
    // brand-new server process-equivalent against that same file, and
    // rejoin with the same identity cookie — purely over the wire, no
    // direct calls into world.ts from the test.
    const dir = server.dir;
    await server.close({ keepData: true });

    const restarted = await startTestServer({ roomCode: "TEST", reconnectGraceMs: 60_000, dbDir: dir });
    const client2 = new TestClient(restarted.wsUrl, cookie);
    const rejoined = await client2.join("Alice", "TEST");
    expect(rejoined.playerId).toBe(playerId);

    const snapshot2 = await client2.waitFor((m) => m.type === "world.snapshot");
    const restoredPlayer = snapshot2.players.find((p: any) => p.id === playerId);
    expect(restoredPlayer.inventory.wood).toBe(gatherResult.inventory.wood);

    const restoredNode = snapshot2.objects.find((o: any) => o.id === node.id);
    expect(restoredNode.resource.remaining).toBe(gatherResult.objectRemaining);

    client2.close();
    server = restarted; // let afterEach clean this one up (and its temp dir)
  });
});

function nearest(objects: any[], pos: { x: number; y: number }, kind: string): any {
  let best: any = null;
  let bestDist = Infinity;
  for (const o of objects) {
    if (o.resource?.kind !== kind || o.resource.remaining <= 0) continue;
    const d = Math.hypot(pos.x - (o.x + 0.5), pos.y - (o.y + 0.5));
    if (d < bestDist) {
      bestDist = d;
      best = o;
    }
  }
  if (!best) throw new Error(`no ${kind} node found`);
  return best;
}

let seqCounter = 0;

/** Steers `playerId` toward (tx, ty), calling onMove with each updated position. `initialPos` seeds the walk before the first player.state arrives. */
function walkTo(
  client: TestClient,
  playerId: string,
  tx: number,
  ty: number,
  onMove: (pos: { x: number; y: number }) => void,
  initialPos: { x: number; y: number },
  timeoutMs = 20000,
): Promise<void> {
  let pos = initialPos;
  client.socket.on("message", (raw) => {
    try {
      const m = JSON.parse(raw.toString());
      if (m.type === "player.state") {
        const me = m.players.find((p: any) => p.id === playerId);
        if (me) {
          pos = me;
          onMove(me);
        }
      }
    } catch {
      /* ignore */
    }
  });

  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    let lastDist = Infinity;
    let stall = 0;
    const iv = setInterval(() => {
      const dx = tx - pos.x;
      const dy = ty - pos.y;
      const d = Math.hypot(dx, dy);
      if (d < 1.0) {
        clearInterval(iv);
        client.send({ type: "player.input", seq: seqCounter++, dx: 0, dy: 0 });
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        clearInterval(iv);
        reject(new Error(`walkTo timed out, dist=${d}`));
        return;
      }
      if (Math.abs(d - lastDist) < 0.01) stall++;
      else stall = 0;
      lastDist = d;
      if (stall > 6) {
        const side = stall % 24 < 12 ? 1 : -1;
        client.send({ type: "player.input", seq: seqCounter++, dx: (-dy / d) * side, dy: (dx / d) * side });
      } else {
        client.send({ type: "player.input", seq: seqCounter++, dx: dx / d, dy: dy / d });
      }
    }, 50);
  });
}
