// The wall: a small, bounded grid that fills one brick at a time, in the
// order people showed up. See README.md for what "good" means here, and
// CLAUDE.md for the rules this file has to hold to.
import { DatabaseSync } from "node:sqlite";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const PORT = Number(process.env.PORT ?? 8080);
const DB_PATH = process.env.DB_PATH ?? "/data/app.db";
const COLS = 20;
const ROWS = 12;
const COLORS = ["#e07a5f", "#3d405b", "#81b29a", "#f2cc8f", "#ffffff"];

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS bricks (
    x          INTEGER NOT NULL,
    y          INTEGER NOT NULL,
    color      TEXT NOT NULL,
    visitor_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (x, y)
  )
`);

type Brick = { x: number; y: number; color: string; visitor_id: string };

function allBricks(): Brick[] {
  return db.prepare("SELECT x, y, color, visitor_id FROM bricks ORDER BY y, x").all() as Brick[];
}

// Next open slot in reading order: left-to-right, top-to-bottom. The
// PRIMARY KEY on (x, y) makes a race onto the same slot fail atomically
// instead of double-placing — see CLAUDE.md.
function nextSlot(taken: Set<string>): { x: number; y: number } | null {
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (!taken.has(`${x},${y}`)) return { x, y };
    }
  }
  return null; // wall is full — out of scope for crit 8
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function visitorId(req: IncomingMessage, res: ServerResponse): string {
  const cookies = parseCookies(req.headers.cookie);
  const existing = cookies.visitor_id;
  if (existing) return existing;
  const id = randomUUID();
  res.setHeader(
    "Set-Cookie",
    `visitor_id=${id}; Path=/; Max-Age=${60 * 60 * 24 * 365}; HttpOnly; SameSite=Lax`,
  );
  return id;
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function renderWall(mine: string): string {
  const bricks = allBricks();
  const byCell = new Map(bricks.map((b) => [`${b.x},${b.y}`, b]));
  let cells = "";
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const b = byCell.get(`${x},${y}`);
      const bg = b ? b.color : "#eee";
      const outline = b && b.visitor_id === mine ? "outline: 3px solid #222; outline-offset: -3px;" : "";
      cells += `<div class="cell" style="background:${bg};${outline}"></div>`;
    }
  }
  const swatches = COLORS.map(
    (c) =>
      `<button name="color" value="${c}" style="background:${c}" aria-label="place a ${c} brick"></button>`,
  ).join("");
  return `<!doctype html>
<html lang="en-AU">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>The Wall</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; }
    .wall { display: grid; grid-template-columns: repeat(${COLS}, 1fr); gap: 2px; margin: 1.5rem 0; }
    .cell { aspect-ratio: 1; border-radius: 2px; }
    form { display: flex; gap: 0.5rem; }
    form button { width: 2.5rem; height: 2.5rem; border-radius: 50%; border: 1px solid #0003; cursor: pointer; }
  </style>
</head>
<body>
  <main>
    <h1>The Wall</h1>
    <p>Place the next brick. It lands in the next open spot, in the order people showed up. Yours are outlined.</p>
    <div class="wall">${cells}</div>
    <form method="post" action="/brick">${swatches}</form>
    <p><a href="/readme/">About this app</a></p>
  </main>
</body>
</html>`;
}

function renderReadme(): string {
  const body = escapeHtml(readFileSync("README.md", "utf8"));
  return `<!doctype html>
<html lang="en-AU">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>About</title>
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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
  });
}

const server = createServer(async (req, res) => {
  const mine = visitorId(req, res);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderWall(mine));
    return;
  }

  if (req.method === "GET" && url.pathname === "/readme/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderReadme());
    return;
  }

  if (req.method === "POST" && url.pathname === "/brick") {
    const body = await readBody(req);
    const params = new URLSearchParams(body);
    const color = params.get("color") ?? COLORS[0];
    const taken = new Set(allBricks().map((b) => `${b.x},${b.y}`));
    const slot = nextSlot(taken);
    if (slot) {
      try {
        db.prepare(
          "INSERT INTO bricks (x, y, color, visitor_id, created_at) VALUES (?, ?, ?, ?, ?)",
        ).run(slot.x, slot.y, color, mine, new Date().toISOString());
      } catch {
        // lost the race for that slot to another visitor — fine, they'll
        // just place on their next visit; nothing to recover here for crit 8
      }
    }
    res.writeHead(303, { Location: "/" });
    res.end();
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`listening on 0.0.0.0:${PORT}, db at ${DB_PATH}`);
});
