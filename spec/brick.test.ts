import { expect, inject, it } from "vitest";

// The crit 8 promise, made mechanical: a stranger places a brick, and it's
// still there — theirs — when they come back. The template's own two checks
// (GET / is 200, /readme/ serves README.md) stay in invariants.test.ts;
// everything else in spec/ is ours.
const baseUrl = inject("baseUrl");

function cookieFrom(res: Response): string {
  const set = res.headers.get("set-cookie");
  if (!set) throw new Error("expected a Set-Cookie header");
  return set.split(";")[0];
}

it("a placed brick is still there, as mine, on the next visit", async () => {
  // First visit: no cookie yet, the server hands us a visitor id.
  const first = await fetch(new URL("/", baseUrl));
  expect(first.status).toBe(200);
  const cookie = cookieFrom(first);

  // Place a brick as that visitor.
  const placed = await fetch(new URL("/brick", baseUrl), {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookie,
    },
    body: "color=%23e07a5f",
  });
  expect(placed.status).toBe(303);

  // Come back later, same cookie: the wall still renders, with content
  // outlined for this visitor (an inline `outline:` style on a cell).
  const again = await fetch(new URL("/", baseUrl), { headers: { Cookie: cookie } });
  expect(again.status).toBe(200);
  const html = await again.text();
  expect(html).toContain("outline: 3px solid");
});
