import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { openDatabase } from "./db.js";
import { createRoomPersistence, loadInitialRoomState, loadOrCreateWorld, loadWorldCreatedAt } from "./world.js";
import {
  buildSetCookieHeader,
  createAnonymousId,
  mintCookieValue,
  parseCookie,
  verifyCookieValue,
  IDENTITY_COOKIE_NAME,
  loadOrCreateSessionSecret,
} from "./identity.js";
import { Room } from "./room.js";
import { attachWebSocketServer } from "./net.js";
import { DEFAULT_ROOM_CODE } from "../shared/constants.js";
import { log } from "./log.js";

const PORT = Number(process.env.PORT ?? 8080);
const DB_PATH = process.env.DB_PATH ?? join(process.cwd(), "data", "world.sqlite");
const PUBLIC_DIR = join(fileURLToPath(new URL("../../public", import.meta.url)));
const README_PATH = join(fileURLToPath(new URL("../../README.md", import.meta.url)));
const ROOM_CODE = process.env.ROOM_CODE ?? DEFAULT_ROOM_CODE;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
};

const db = openDatabase(DB_PATH);
const secret = loadOrCreateSessionSecret(db);
const map = loadOrCreateWorld(db);
const initialState = loadInitialRoomState(db, map);
const worldCreatedAt = loadWorldCreatedAt(db);

const room = new Room(
  map,
  createRoomPersistence(db),
  initialState.buildings,
  initialState.chestItems,
  initialState.farmPlots,
  Date.now,
  worldCreatedAt,
  initialState.enemySpawns,
  initialState.bossAlreadyDefeated,
  initialState.beaconMaterials,
  initialState.beaconActivated,
);

const server = createServer((req, res) => {
  void handleHttp(req, res);
});

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Renders README.md verbatim, in full, at /readme/ — the course's invariant
 * check (spec/invariants.test.ts) reads this page's headings against
 * README.md's own and requires every one present, in order. No summarising
 * or truncating: if README.md changes, this changes with it, since it reads
 * the file fresh on every request rather than caching its content.
 */
function renderReadme(): string {
  const body = escapeHtml(readFileSync(README_PATH, "utf8"));
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>About Last Shelter</title>
</head>
<body>
  <main>
    <h1>About</h1>
    <pre>
${body}
    </pre>
  </main>
</body>
</html>`;
}

/**
 * Ensures the response carries a valid, signed identity cookie: reissues one
 * if missing, tampered, expired, or due for rotation. The cookie's raw value
 * is never logged — only ever written to the Set-Cookie header.
 */
function ensureIdentityCookie(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
  const raw = parseCookie(req.headers.cookie, IDENTITY_COOKIE_NAME);
  const verified = raw ? verifyCookieValue(secret, raw) : null;

  if (verified && !verified.needsRotation) return; // already have a good, fresh cookie

  const id = verified?.id ?? createAnonymousId();
  if (raw && !verified) log("session_rejected", { reason: "invalid_or_expired_cookie" });
  const cookieValue = mintCookieValue(secret, id);
  res.setHeader("Set-Cookie", buildSetCookieHeader(cookieValue));
  log("session_issued", { player_id: id, rotated: Boolean(verified) });
}

async function handleHttp(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "GET" && url.pathname === "/readme/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(renderReadme());
    return;
  }

  let pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(400).end("bad request");
    return;
  }

  ensureIdentityCookie(req, res);

  try {
    let body: Buffer | string = await readFile(filePath);
    const type = CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream";
    if (filePath.endsWith("index.html")) {
      body = body.toString("utf8").replace("__ROOM_CODE__", ROOM_CODE);
    }
    res.writeHead(200, { "Content-Type": type }).end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}

const wss = new WebSocketServer({ server, path: "/ws" });
attachWebSocketServer(wss, room, { db, secret, roomCode: ROOM_CODE, worldCreatedAt });

server.listen(PORT, "0.0.0.0", () => {
  console.log(JSON.stringify({ event: "server_started", port: PORT, seed: map.seed }));
});
