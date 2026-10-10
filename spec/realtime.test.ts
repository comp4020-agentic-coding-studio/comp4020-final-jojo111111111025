import { expect, inject, it } from "vitest";

// Crit 9: "a change one person makes appears in every other open session
// within about a second, with no reload." These tests open /events as a
// second, idle session would, then place a brick as a different visitor, and
// check the idle connection receives it — without ever reloading it.
const baseUrl = inject("baseUrl");

function cookieFrom(res: Response): string {
  const set = res.headers.get("set-cookie");
  if (!set) throw new Error("expected a Set-Cookie header");
  return set.split(";")[0];
}

// Reads chunks off an SSE stream until a line matching `pattern` has fully
// arrived, buffering across reads (a field can be split across TCP chunks).
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  pattern: RegExp,
  bufRef: { buf: string },
  timeoutMs = 5000,
): Promise<RegExpMatchArray> {
  const deadline = Date.now() + timeoutMs;
  const decoder = new TextDecoder();
  let match = bufRef.buf.match(pattern);
  while (!match) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${pattern}`);
    const { value, done } = await reader.read();
    if (done) throw new Error(`stream closed before ${pattern} arrived`);
    bufRef.buf += decoder.decode(value, { stream: true });
    match = bufRef.buf.match(pattern);
  }
  return match;
}

// Other spec files share this same live app and vitest runs test files in
// parallel by default, so an idle stream can see other tests' brick events
// too. This keeps consuming "brick" events, skipping ones that aren't ours,
// identified by visitor_id (unique per cookie, so unambiguous).
async function readBrickFor(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  visitorId: string,
  bufRef: { buf: string },
  timeoutMs = 2000,
): Promise<{ x: number; y: number; color: string; visitor_id: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (Date.now() > deadline) throw new Error("timed out waiting for our brick event");
    const match = await readUntil(reader, /event: brick\ndata: (\{.*\})\n/, bufRef, timeoutMs);
    const brick = JSON.parse(match[1]) as { x: number; y: number; color: string; visitor_id: string };
    bufRef.buf = bufRef.buf.slice((match.index ?? 0) + match[0].length);
    if (brick.visitor_id === visitorId) return brick;
    // not ours — another test's placement; keep waiting
  }
}

it("an open session receives a snapshot immediately on connecting", async () => {
  const res = await fetch(new URL("/events", baseUrl));
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");

  const reader = res.body!.getReader();
  const bufRef = { buf: "" };
  const match = await readUntil(reader, /event: snapshot\ndata: (\{.*\})\n/, bufRef);
  const snap = JSON.parse(match[1]) as { cols: number; rows: number; bricks: unknown[] };
  expect(snap.cols).toBe(20);
  expect(snap.rows).toBe(12);
  expect(Array.isArray(snap.bricks)).toBe(true);
  await reader.cancel();
});

it("an idle, already-open session receives a newly committed brick without reloading", async () => {
  // Open the stream first, as an idle second session would, and consume its
  // snapshot before anyone places anything new.
  const stream = await fetch(new URL("/events", baseUrl));
  const reader = stream.body!.getReader();
  const bufRef = { buf: "" };
  await readUntil(reader, /event: snapshot\n/, bufRef);
  bufRef.buf = ""; // only care about what arrives from here on

  // A different visitor places a brick. visitor_id is the cookie's value, and
  // it is what identifies "our" event below, since other spec files run
  // concurrently against this same stream of broadcasts.
  const first = await fetch(new URL("/", baseUrl));
  const cookie = cookieFrom(first);
  const visitorId = cookie.split("=")[1];
  const placed = await fetch(new URL("/brick", baseUrl), {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
    body: "color=%23f2cc8f",
  });
  expect(placed.status).toBe(303);
  expect(placed.headers.get("location")).toBe("/");

  // The idle stream — never reloaded — sees it, well within the ~1s budget.
  const start = Date.now();
  const brick = await readBrickFor(reader, visitorId, bufRef, 2000);
  const elapsedMs = Date.now() - start;
  expect(brick.color).toBe("#f2cc8f");
  expect(elapsedMs).toBeLessThan(1000);
  await reader.cancel();
});

it("GET /?conflict=1 renders the friendly retry notice", async () => {
  // Exercises the rendering of the conflict path directly. The redirect that
  // triggers it (a rejected insert) cannot currently be produced through the
  // live HTTP app — see docs/adr/001-concurrent-brick-placement.md — but the
  // page it redirects to is fully testable on its own.
  const res = await fetch(new URL("/?conflict=1", baseUrl));
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("Someone placed a brick in that spot just before you");
});
