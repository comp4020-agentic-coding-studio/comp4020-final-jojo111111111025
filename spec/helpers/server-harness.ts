import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import type Database from "better-sqlite3";
import { openDatabase } from "../../src/server/db.js";
import {
  buildSetCookieHeader,
  createAnonymousId,
  loadOrCreateSessionSecret,
  mintCookieValue,
  parseCookie,
  verifyCookieValue,
  IDENTITY_COOKIE_NAME,
} from "../../src/server/identity.js";
import { createRoomPersistence, loadInitialRoomState, loadOrCreateWorld, loadWorldCreatedAt } from "../../src/server/world.js";
import { Room } from "../../src/server/room.js";
import { attachWebSocketServer } from "../../src/server/net.js";
import type { EnemySpawn, WorldMap } from "../../src/shared/types.js";

export interface TestServer {
  httpUrl: string;
  wsUrl: string;
  db: Database.Database;
  room: Room;
  dir: string;
  /** Stops the HTTP/WS server and closes the DB handle. Pass `{ keepData: true }` to leave the temp directory on disk — e.g. to start a second server against the same DB file to simulate a restart. */
  close(opts?: { keepData?: boolean }): Promise<void>;
}

/**
 * Starts a real HTTP+WS server (same wiring as src/server/index.ts) against
 * a fresh temp SQLite file, on an ephemeral port. Used by integration tests
 * that need to exercise identity/room/reconnect logic end-to-end rather than
 * unit-testing Room in isolation.
 *
 * Pass `dbDir` to open an existing directory (e.g. one kept alive via a
 * prior server's `close({ keepData: true })`) instead of creating a fresh
 * one — this is how tests simulate a server restart: a brand-new Room,
 * brand-new DB handle, same on-disk file.
 */
export async function startTestServer(options: {
  roomCode?: string;
  reconnectGraceMs?: number;
  dbDir?: string;
  now?: () => number;
  /** Overrides the generated world map (e.g. a compact test map with a nearby dungeon entrance/beacon) instead of the real seeded one — the dev map's dungeon/beacon sit dozens of tiles from spawn, too far to walk in a test's timeout. */
  map?: WorldMap;
  /** Overrides the deterministic enemy roster derived from the map, so tests can place a low-health enemy within immediate attack range. */
  enemySpawns?: EnemySpawn[];
} = {}): Promise<TestServer> {
  const dir = options.dbDir ?? mkdtempSync(join(tmpdir(), "last-shelter-harness-"));
  const dbPath = join(dir, "world.sqlite");
  const db = openDatabase(dbPath);
  const secret = loadOrCreateSessionSecret(db);
  // loadOrCreateWorld's side effect (inserting the `world` row that
  // loadWorldCreatedAt needs) is required even when options.map overrides
  // the map it returns — a custom test map body, same persisted world row.
  const generated = loadOrCreateWorld(db, "test-seed");
  const map = options.map ?? generated;
  const initialState = loadInitialRoomState(db, map);
  const worldCreatedAt = loadWorldCreatedAt(db);
  const room = new Room(
    map,
    createRoomPersistence(db),
    initialState.buildings,
    initialState.chestItems,
    initialState.farmPlots,
    options.now ?? Date.now,
    worldCreatedAt,
    options.enemySpawns ?? initialState.enemySpawns,
    initialState.bossAlreadyDefeated,
    initialState.beaconMaterials,
    initialState.beaconActivated,
  );

  const server: Server = createServer((req, res) => {
    // Minimal HTTP surface for tests: issue/refresh the identity cookie the
    // same way src/server/index.ts's ensureIdentityCookie does, without
    // needing the public/ static files on disk.
    const raw = parseCookie(req.headers.cookie, IDENTITY_COOKIE_NAME);
    const verified = raw ? verifyCookieValue(secret, raw) : null;
    if (!verified || verified.needsRotation) {
      const id = verified?.id ?? createAnonymousId();
      res.setHeader("Set-Cookie", buildSetCookieHeader(mintCookieValue(secret, id)));
    }
    res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
  });

  const wss = new WebSocketServer({ server, path: "/ws" });
  const attached = attachWebSocketServer(wss, room, {
    db,
    secret,
    roomCode: options.roomCode,
    reconnectGraceMs: options.reconnectGraceMs,
    worldCreatedAt,
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to bind test server");
  const port = address.port;

  let closed = false;
  return {
    httpUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    db,
    room,
    dir,
    close: (opts) => {
      if (closed) return Promise.resolve();
      closed = true;
      return new Promise<void>((resolve, reject) => {
        attached.stop();
        for (const client of wss.clients) client.terminate();
        wss.close();
        server.close((err) => {
          db.close();
          if (!opts?.keepData) rmSync(dir, { recursive: true, force: true });
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}

/**
 * A thin WebSocket client wrapper for integration tests: tracks every
 * received message and exposes a promise-based `waitFor` so tests can assert
 * on specific server messages without hand-rolling event listeners each time.
 */
export class TestClient {
  readonly socket: WebSocket;
  readonly messages: any[] = [];
  private waiters: Array<{ predicate: (m: any) => boolean; resolve: (m: any) => void }> = [];

  constructor(wsUrl: string, cookie?: string) {
    this.socket = new WebSocket(wsUrl, cookie ? { headers: { Cookie: cookie } } : undefined);
    this.socket.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this.messages.push(msg);
      this.waiters = this.waiters.filter((w) => {
        if (w.predicate(msg)) {
          w.resolve(msg);
          return false;
        }
        return true;
      });
    });
  }

  waitOpen(timeoutMs = 5000): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("waitOpen timeout")), timeoutMs);
      this.socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  waitClose(timeoutMs = 5000): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("waitClose timeout")), timeoutMs);
      this.socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  waitFor(predicate: (m: any) => boolean, timeoutMs = 5000): Promise<any> {
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== resolve);
        reject(new Error(`waitFor timeout; messages so far: ${JSON.stringify(this.messages)}`));
      }, timeoutMs);
      this.waiters.push({
        predicate,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  async join(name: string, roomCode: string, requestId = "join-1"): Promise<any> {
    await this.waitOpen();
    this.send({ type: "room.join", requestId, name, roomCode });
    return this.waitFor((m) => (m.type === "room.joined" && m.requestId === requestId) || m.type === "server.error");
  }

  close(): void {
    this.socket.close();
  }
}

/** Performs a plain HTTP GET and returns the raw Set-Cookie header value's `ls_id=...` portion, if present. */
export async function fetchIdentityCookie(httpUrl: string): Promise<string | undefined> {
  const res = await fetch(httpUrl + "/");
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) return undefined;
  const match = /ls_id=[^;]+/.exec(setCookie);
  return match?.[0];
}
