import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, inject, it } from "vitest";

// docs/adr/001-concurrent-brick-placement.md: "first successful placement
// wins", enforced by the PRIMARY KEY (x, y) on `bricks`. Two things are
// checked here, separately, because they test different claims:
//
//  1. The constraint itself actually rejects a duplicate (x, y) — a direct,
//     deterministic test against a disposable connection, independent of the
//     live app or any timing.
//  2. The live app, under real concurrent HTTP load, never double-places or
//     drops a brick — exercised against the running app, not simulated.
//
// What this file does NOT claim to test: a live two-request race that
// reaches the constraint's rejection branch through the HTTP API. In this
// server, the read-decide-write sequence in POST /brick has no `await`
// between reading what's taken and writing the insert, so Node's
// single-threaded, run-to-completion scheduling already serialises one
// request's whole decision before the next one starts — confirmed by test
// 2 below finding zero collisions across many concurrent requests, every
// run. See the ADR's "Verification evidence" for the full reasoning.

const baseUrl = inject("baseUrl");

it("the PRIMARY KEY (x, y) constraint rejects a duplicate cell", () => {
  // Same schema as server.ts's `bricks` table, duplicated deliberately: this
  // is a unit test of the SQL-level guarantee the ADR relies on, kept
  // intentionally independent of the running app and its DB file.
  const dir = mkdtempSync(join(tmpdir(), "wall-constraint-"));
  const db = new DatabaseSync(join(dir, "test.db"));
  db.exec(`
    CREATE TABLE bricks (
      x INTEGER NOT NULL, y INTEGER NOT NULL, color TEXT NOT NULL,
      visitor_id TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY (x, y)
    )
  `);
  const insert = db.prepare(
    "INSERT INTO bricks (x, y, color, visitor_id, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  insert.run(0, 0, "#e07a5f", "visitor-a", "2026-01-01T00:00:00.000Z");
  expect(() => insert.run(0, 0, "#3d405b", "visitor-b", "2026-01-01T00:00:01.000Z")).toThrow();
  // The first write stands, untouched, and nothing else was corrupted.
  const rows = db.prepare("SELECT * FROM bricks").all();
  expect(rows).toHaveLength(1);
  expect((rows[0] as { visitor_id: string }).visitor_id).toBe("visitor-a");
  db.close();
});

function cookieFrom(res: Response): string {
  const set = res.headers.get("set-cookie");
  if (!set) throw new Error("expected a Set-Cookie header");
  return set.split(";")[0];
}

async function snapshotBricks(): Promise<{ x: number; y: number; visitor_id: string }[]> {
  // The /events endpoint's first message is always a full snapshot — reused
  // here just to read current occupancy without scraping rendered HTML.
  // SSE fields can arrive across more than one chunk, so keep reading until
  // a complete "data: {...}" line for the snapshot event is in hand rather
  // than assuming the first read() has it all.
  const res = await fetch(new URL("/events", baseUrl));
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let match: RegExpMatchArray | null = null;
  while (!match) {
    const { value, done } = await reader.read();
    if (done) throw new Error("stream closed before the snapshot event completed");
    buf += decoder.decode(value, { stream: true });
    match = buf.match(/data: (\{.*\})\n/);
  }
  await reader.cancel();
  const snap = JSON.parse(match[1]) as { bricks: { x: number; y: number; visitor_id: string }[] };
  return snap.bricks;
}

it("N concurrent placements each land on a distinct cell, with none lost or duplicated", async () => {
  const N = 8;

  // Other spec files run against this same live app and database, and
  // vitest runs test files in parallel by default — so this identifies
  // "mine" by visitor cookie rather than by a before/after cell-count diff,
  // which a concurrently-running file placing its own bricks would throw off.
  const placements = await Promise.all(
    Array.from({ length: N }, async () => {
      const first = await fetch(new URL("/", baseUrl));
      const cookie = cookieFrom(first);
      const visitorId = cookie.split("=")[1];
      const res = await fetch(new URL("/brick", baseUrl), {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
        body: "color=%2381b29a",
      });
      return { res, visitorId };
    }),
  );

  // Every concurrent request succeeded (redirected to "/", not "/?conflict=1").
  for (const { res } of placements) {
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
  }

  const bricks = await snapshotBricks();
  const myVisitorIds = new Set(placements.map((p) => p.visitorId));
  const mine = bricks.filter((b) => myVisitorIds.has(b.visitor_id));
  const myCells = new Set(mine.map((b) => `${b.x},${b.y}`));

  // Each of the N concurrent, distinctly-cookied requests got exactly one
  // committed brick, and no two of them landed on the same cell.
  expect(mine).toHaveLength(N);
  expect(myCells.size).toBe(N);
});
