import { afterEach, describe, expect, it } from "vitest";
import { Room } from "../src/server/room.js";
import { loadOrCreateSessionSecret, mintCookieValue, touchPlayerRecord } from "../src/server/identity.js";
import { loadPlayerHealth, persistPlayerHealth } from "../src/server/world.js";
import { MAX_HEALTH } from "../src/shared/constants.js";
import type { WorldMap } from "../src/shared/types.js";
import { TestClient, fetchIdentityCookie, startTestServer, type TestServer } from "./helpers/server-harness.js";
import { emptyDungeon } from "./helpers/test-fixtures.js";

/** Mints a valid signed identity cookie for a specific id, for tests that need to control the identity ahead of the first join. */
function mintCookieForId(server: TestServer, id: string): string {
  const secret = loadOrCreateSessionSecret(server.db);
  return `ls_id=${mintCookieValue(secret, id)}`;
}

function makeTestMap(): WorldMap {
  const width = 10;
  const height = 10;
  const tiles = Array.from({ length: width * height }, () => ({ terrain: "grass" as const }));
  return {
    seed: "test",
    width,
    height,
    tiles,
    objects: [
      { id: "wood-node", kind: "tree", x: 0, y: 1, resource: { kind: "wood", remaining: 10, maxRemaining: 10 } },
    ],
    campsite: { x: 1, y: 1 },
    spawnPoint: { x: 1, y: 1 },
    farmArea: { x: 0, y: 0, width: 0, height: 0 },
    dungeonEntrance: { x: 9, y: 9 },
    dungeon: emptyDungeon(),
  };
}

describe("Room player health and respawn", () => {
  it("a fresh player starts at full health and alive", () => {
    const room = new Room(makeTestMap());
    const player = room.addPlayer("p1", "Alice");
    expect(player.health).toBe(MAX_HEALTH);
    expect(player.alive).toBe(true);
  });

  it("addPlayer accepts a restored health value (e.g. loaded from persistence)", () => {
    const room = new Room(makeTestMap());
    const player = room.addPlayer("p1", "Alice", undefined, 40);
    expect(player.health).toBe(40);
    expect(player.alive).toBe(true);
  });

  it("a player restored with 0 health starts dead", () => {
    const room = new Room(makeTestMap());
    const player = room.addPlayer("p1", "Alice", undefined, 0);
    expect(player.health).toBe(0);
    expect(player.alive).toBe(false);
  });

  it("respawn fails for a player who is still alive", () => {
    const room = new Room(makeTestMap());
    room.addPlayer("p1", "Alice");
    const result = room.respawn("p1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not_dead");
  });

  it("respawn fails for an unknown player", () => {
    const room = new Room(makeTestMap());
    const result = room.respawn("does-not-exist");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unknown_player");
  });

  it("respawn resets a dead player's health and position but never touches inventory", () => {
    const room = new Room(makeTestMap());
    const player = room.addPlayer("p1", "Alice", undefined, 0); // starts dead
    // Grant some inventory directly to prove it survives respawn untouched.
    for (let i = 0; i < 3; i++) {
      room.interact("p1", "wood-node", `grant-${i}`);
    }
    // interact() rejects a dead player's actions, so inventory stays at 0 here —
    // confirm that rejection, then respawn, then confirm post-respawn gathering works
    // and nothing was silently granted while dead.
    expect(room.getPlayer("p1")!.inventory.wood).toBe(0);

    const result = room.respawn("p1");
    expect(result.ok).toBe(true);
    expect(result.health).toBe(MAX_HEALTH);

    const respawned = room.getPlayer("p1")!;
    expect(respawned.alive).toBe(true);
    expect(respawned.health).toBe(MAX_HEALTH);
    expect(respawned.zone).toBe("overworld");
    expect(respawned.inventory.wood).toBe(0); // untouched, not reset to some other value — still whatever it was
  });

  it("respawn preserves pre-existing inventory (death never erases progress)", () => {
    const room = new Room(makeTestMap());
    room.addPlayer("p1", "Alice"); // starts alive
    const gather = room.interact("p1", "wood-node", "grant-1");
    expect(gather.ok).toBe(true);
    expect(room.getPlayer("p1")!.inventory.wood).toBe(1);

    // Can't actually die without combat (Phase D step 2), so simulate it via
    // a second player constructed pre-dead with the same inventory shape,
    // proving respawn's code path doesn't touch the inventory object at all.
    const room2 = new Room(makeTestMap());
    const dead = room2.addPlayer("p2", "Bob", { ...room.getPlayer("p1")!.inventory }, 0);
    expect(dead.inventory.wood).toBe(1);
    const result = room2.respawn("p2");
    expect(result.ok).toBe(true);
    expect(room2.getPlayer("p2")!.inventory.wood).toBe(1);
  });

  it("a dead player's interact/craft/build/chest/farm actions are all rejected with reason 'dead'", () => {
    const room = new Room(makeTestMap());
    room.addPlayer("p1", "Alice", undefined, 0); // dead on arrival

    expect(room.interact("p1", "wood-node", "r1").reason).toBe("dead");
    expect(room.craft("p1", "axe", "r2").reason).toBe("dead");
    expect(room.build("p1", "wall", 2, 2, "r3").reason).toBe("dead");
    expect(room.chestTransfer("p1", "does-not-exist", "wood", 1, "deposit", "r4").reason).toBe("dead");
    expect(room.farmAction("p1", "does-not-exist", "water", undefined, "r5").reason).toBe("dead");
  });

  it("a dead player does not move even with input set", () => {
    const room = new Room(makeTestMap());
    room.addPlayer("p1", "Alice", undefined, 0);
    room.setInput("p1", 1, 0);
    room.tick(1);
    const player = room.getPlayer("p1")!;
    expect(player.x).toBeCloseTo(1.5, 5);
  });

  it("persists health via the provided callback on respawn", () => {
    const calls: Array<{ playerId: string; health: number }> = [];
    const room = new Room(makeTestMap(), {
      playerHealth: (playerId, health) => calls.push({ playerId, health }),
    });
    room.addPlayer("p1", "Alice", undefined, 0);
    room.respawn("p1");
    expect(calls).toEqual([{ playerId: "p1", health: MAX_HEALTH }]);
  });
});

describe("health persistence through the real server and a restart", () => {
  let server: TestServer;

  afterEach(async () => {
    await server?.close();
  });

  it("a player.respawn through the wire persists health, and it survives a full server restart", async () => {
    server = await startTestServer({ roomCode: "TEST", reconnectGraceMs: 60_000 });

    // Simulate "joined once already, died, and the server restarted" by
    // seeding a players row at 0 health before this identity's first join
    // on this server instance — loadPlayerHealth will hand that back to
    // addPlayer exactly as a real reconnect-after-death would.
    const deadPlayerId = "dddddddd-0000-0000-0000-000000000000";
    touchPlayerRecord(server.db, deadPlayerId, "Alice");
    persistPlayerHealth(server.db, deadPlayerId, 0);

    const cookieValue = mintCookieForId(server, deadPlayerId);
    const client = new TestClient(server.wsUrl, cookieValue);
    const joined = await client.join("Alice", "TEST");
    expect(joined.playerId).toBe(deadPlayerId);

    const snapshot = await client.waitFor((m) => m.type === "world.snapshot");
    const me = snapshot.players.find((p: any) => p.id === deadPlayerId);
    expect(me.alive).toBe(false);
    expect(me.health).toBe(0);

    client.send({ type: "player.respawn", requestId: "respawn-1" });
    const result = await client.waitFor((m) => m.requestId === "respawn-1");
    expect(result.ok).toBe(true);
    expect(result.health).toBe(MAX_HEALTH);

    const persisted = loadPlayerHealth(server.db, deadPlayerId);
    expect(persisted).toBe(MAX_HEALTH);

    client.close();

    const dir = server.dir;
    await server.close({ keepData: true });
    const restarted = await startTestServer({ roomCode: "TEST", dbDir: dir });
    const restoredHealth = loadPlayerHealth(restarted.db, deadPlayerId);
    expect(restoredHealth).toBe(MAX_HEALTH);
    server = restarted;
  });
});
