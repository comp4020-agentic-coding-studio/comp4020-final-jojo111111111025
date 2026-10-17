import { expect, inject, it } from "vitest";

// Crit 10: "Fly by instruments" — the app has to tell two people apart, and
// the server, not the client, is the one deciding who's who. The Wall has
// carried a visitor_id cookie since crit 8; what's new here is that the
// cookie is signed, so a visitor can't just set Cookie: visitor_id=<someone
// else's id> and be treated as them. See
// docs/adr/002-anonymous-identity.md for the decision and why.
const baseUrl = inject("baseUrl");

function cookieFrom(res: Response): string {
  const set = res.headers.get("set-cookie");
  if (!set) throw new Error("expected a Set-Cookie header");
  return set.split(";")[0];
}

it("a new session (no cookie) is issued a signed anonymous identity", async () => {
  const res = await fetch(new URL("/", baseUrl));
  expect(res.status).toBe(200);
  const cookie = cookieFrom(res);
  const value = cookie.split("=")[1];
  // id.tag — a UUID, a literal ".", then a hex HMAC tag. This is a black-box
  // shape check (this file doesn't know SESSION_SECRET); forgery is what the
  // next two tests actually exercise.
  expect(value).toMatch(/^[0-9a-f-]{36}\.[0-9a-f]{64}$/);
});

it("the same browser's cookie keeps the same identity across requests", async () => {
  const first = await fetch(new URL("/", baseUrl));
  const cookie = cookieFrom(first);

  const again = await fetch(new URL("/", baseUrl), { headers: { Cookie: cookie } });
  expect(again.status).toBe(200);
  const html = await again.text();
  // The id half of the cookie is rendered into data-visitor-id (renderWall);
  // if the server had re-verified and found it valid, it's threaded through
  // unchanged rather than silently replaced.
  const id = cookie.split("=")[1].split(".")[0];
  expect(html).toContain(`data-visitor-id="${id}"`);
});

it("two independent sessions (no shared cookie jar) get different identities", async () => {
  const a = await fetch(new URL("/", baseUrl));
  const b = await fetch(new URL("/", baseUrl));
  const idA = cookieFrom(a).split("=")[1].split(".")[0];
  const idB = cookieFrom(b).split("=")[1].split(".")[0];
  expect(idA).not.toBe(idB);
});

it("a client cannot impersonate another visitor by submitting their id", async () => {
  // Real visitor A places a brick, establishing an owned row.
  const a = await fetch(new URL("/", baseUrl));
  const cookieA = cookieFrom(a);
  const idA = cookieA.split("=")[1].split(".")[0];
  const placedA = await fetch(new URL("/brick", baseUrl), {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookieA },
    body: "color=%233d405b",
  });
  expect(placedA.status).toBe(303);

  // An attacker who has seen A's id (e.g. in a broadcasted brick's
  // visitor_id, which is not secret) tries to act as A by sending that bare
  // id as a cookie, with no valid tag at all.
  const forgedCookie = `visitor_id=${idA}`;
  const asForgedA = await fetch(new URL("/", baseUrl), { headers: { Cookie: forgedCookie } });
  expect(asForgedA.status).toBe(200);
  const forgedSetCookie = asForgedA.headers.get("set-cookie");
  expect(forgedSetCookie, "an unsigned/invalid cookie must be rejected, not accepted as-is").not.toBeNull();
  const newId = cookieFrom(asForgedA).split("=")[1].split(".")[0];
  // The server refused to treat the bare id as proof of identity: it issued a
  // fresh id rather than adopting A's.
  expect(newId).not.toBe(idA);

  // A forged tag (right shape, wrong signature) is rejected the same way.
  const wrongTag = "0".repeat(64);
  const asWrongTag = await fetch(new URL("/", baseUrl), {
    headers: { Cookie: `visitor_id=${idA}.${wrongTag}` },
  });
  const wrongTagId = cookieFrom(asWrongTag).split("=")[1].split(".")[0];
  expect(wrongTagId).not.toBe(idA);
});

it("a missing or malformed cookie is handled safely, not treated as an error", async () => {
  const res = await fetch(new URL("/", baseUrl), { headers: { Cookie: "visitor_id=garbage" } });
  expect(res.status).toBe(200);
  expect(cookieFrom(res)).toMatch(/^visitor_id=/);
});
