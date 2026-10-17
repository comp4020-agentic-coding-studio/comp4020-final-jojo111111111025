# 2. Anonymous identity and server-side authorisation

## Status

Accepted (crit 10, 2026-10-17).

## Context and problem

The Wall has used an anonymous `visitor_id` cookie since crit 8 to let a
visitor recognise their own bricks. Crit 10 asks for two things that cookie
didn't yet guarantee:

- **what counts as a person** has to be a server-recognised identity, not
  merely a client-asserted one
- the server has to be the one deciding what each person may see and change,
  and that decision has to hold even if a visitor edits their own cookie

Until now, `visitorId` trusted whatever value arrived in the `visitor_id`
cookie outright. A visitor who copied another visitor's id into their own
cookie — trivial, since `visitor_id` is plain text and travels in a broadcast
`brick` event to every open `/events` connection, as `visitor_id` on each
brick — would be treated by the server as that other visitor: their outline
would show as that visitor's, and any future action gated on `visitor_id`
would run as them. Nothing before this crit's spec actually required
authorisation beyond "recognise your own bricks," so this gap existed but
didn't yet matter; crit 10 is the point at which it does.

## What counts as a user here

A **user** is a browser holding a valid signed `visitor_id` cookie — there is
no account, login, or durable identity beyond the browser session (`CLAUDE.md`:
"no accounts, no sign-up, ever"). This fits The Wall's own "what good means"
criteria (`README.md`): "Persistent" and "Shared but personal" both describe
*recognising a visitor's own contribution*, not authenticating a real-world
person. An account system would add friction and complexity the project was
deliberately scoped against (`docs/adr/001`), for a guarantee ("this is really
the same human") the app has never needed — only "this is really the same
browser session that was issued this id" does.

## Options considered

1. **Sign the existing cookie (HMAC-SHA256 over the id).** Keep the
   `randomUUID()` id and the cookie-based model entirely; add a tag the server
   can verify but a client can't forge, keyed by a secret that never leaves
   the server.
2. **Server-side session store** (a `sessions` table keyed by an opaque token,
   looked up on every request). Stronger if sessions ever need revoking or
   expiring server-side, but adds a database round-trip per request and a
   table to prune, for a guarantee (unforgeability) that signing already gives
   here.
3. **A full auth library/framework** (e.g. a sessions middleware package).
   Unnecessary dependency weight for one cookie and one check; the project has
   had zero runtime npm dependencies since crit 8, and nothing about this
   requirement needs what such a library adds (password hashing, OAuth flows,
   multi-provider login) over plain `node:crypto`.

## Decision

Option 1. The cookie's value changes from a bare id (`<uuid>`) to a signed
pair (`<uuid>.<hmac-sha256-hex>`). `SESSION_SECRET` is generated once with
`randomBytes(32)` on first boot and persisted in the same SQLite file as
`bricks` (a new `meta` table), so it survives restarts and redeploys on the
one Fly volume without being hand-managed as a secret alongside
`FLY_API_TOKEN`. `visitorId` (`server.ts`) now:

- accepts an existing cookie only if `verifySignedId` confirms its tag matches
  what `SESSION_SECRET` would produce for that id (constant-time comparison,
  via `timingSafeEqual`)
- issues a fresh id, exactly as before crit 8, whenever the cookie is absent
  **or present but unverifiable** — a forged, tampered, or otherwise invalid
  cookie is never adopted as someone else's identity, only replaced

This is the smallest change that makes "the server decides who you are"
actually true: the id itself, the no-accounts model, and every other
behaviour of the cookie (`HttpOnly`, `SameSite=Lax`, one-year `Max-Age`) are
unchanged. The cookie also gained `Secure` when the request arrives over
HTTPS (detected via `X-Forwarded-Proto`, which Fly's edge sets after
terminating TLS — `fly.toml`'s `force_https = true`), so the signed cookie
isn't sent in the clear in production; local HTTP development is unaffected,
since there's no `X-Forwarded-Proto` header to trigger it.

## Why it fits "what good means" here

Signing is invisible to a legitimate visitor — same cookie shape, same
no-account experience, same one-click placement — so it doesn't touch "Easy to
understand" or "Small and constrained." It directly serves "Shared but
personal": a visitor's recognition of *their own* contribution now actually
depends on being that visitor, not on knowing or guessing an id. Option 2 or 3
would have added infrastructure (a sessions table to query and prune, or a
dependency and its own configuration surface) disproportionate to what the
spec asks for, which is squarely in tension with "Small and constrained."

## What each visitor can see and change

Unchanged by this crit, and already enforced server-side before it:

- **See:** the whole wall — every placed brick, from every visitor. The Wall
  has no private or per-visitor view (it's a shared, public wall by design).
- **Change:** place exactly one brick at a time, into the next open cell. A
  visitor cannot choose a cell, edit another visitor's brick, or remove any
  brick (there is no edit/delete route at all — `server.ts` only ever
  `INSERT`s into `bricks`).

What crit 10 changes is *how reliably* "a visitor's own bricks are theirs": the
signed cookie is what makes that outline, and any future authorisation
decision keyed on `visitor_id`, trustworthy rather than merely presentational.

## Consequences and trade-offs

- The cookie is slightly longer (a 64-character hex tag added to the 36-byte
  UUID) — immaterial at this scale.
- `SESSION_SECRET` is generated per-process-lifetime-of-the-database: because
  it's stored in the same SQLite file as `bricks`, it survives ordinary
  restarts and redeploys (the volume persists), but a fresh database (a brand
  new volume) would generate a new secret, silently invalidating every
  previously-issued cookie — those visitors are simply treated as new ones on
  their next request (the "invalid or malformed session" case, not an error).
  This is the same characteristic the `bricks` table itself already has: wall
  state and identity validity both live and die with the one volume.
- Verifying a cookie is now one HMAC computation per request instead of a
  dictionary lookup — negligible at The Wall's scale (`shared-cpu-1x`,
  256MB), and strictly server-side CPU, no new I/O.
- A client still receives and can read the cookie's *shape* (`HttpOnly` blocks
  JavaScript access, but the raw `Set-Cookie` header is visible in browser
  devtools, as it always has been) — this was never about hiding the id, only
  about preventing a *different* client from presenting it as proof of
  ownership. That distinction is the actual security property: confidentiality
  of the id was never the goal, unforgeability of the tag is.

## Failure modes and how they are handled

- **A visitor presents no cookie.** Treated as a brand-new visitor; a fresh
  signed id is issued (`session_issued`, logged).
- **A visitor presents another visitor's bare id, with no tag or the wrong
  tag.** `verifySignedId` fails (no `.` to split on, or the HMAC doesn't
  match); the id is never adopted. A fresh id is issued instead
  (`session_rejected` then `session_issued`, logged) — the attempted
  impersonation never succeeds, and the attacker is simply handed a new,
  unrelated identity.
- **A visitor presents a well-formed but incorrect tag** (right length and
  hex shape, wrong value — e.g. guessed, or signed with a different secret).
  Same outcome: `timingSafeEqual` returns false, rejected, fresh id issued.
  Constant-time comparison means the rejection takes the same time whether the
  guess was close or wildly wrong, so response timing can't be used to narrow
  down a correct tag.
- **The database (and so `SESSION_SECRET`) is lost or reset.** Every
  previously-issued cookie fails verification on its next use and its holder
  is silently treated as a new visitor — handled the same way as any other
  invalid cookie, not as a crash or error state.
- **A brick's `color` field is tampered with.** Unrelated to identity, but the
  same crit surfaced it during review: `color` is the one client-submitted
  value a placement carries, and it was being interpolated unchecked into an
  HTML `style` attribute. It's now validated against the server's own
  `COLORS` palette before any read or write; an invalid value is rejected with
  `400` and logged (`brick_rejected`, `reason: "invalid_color"`), never
  reaching the database or the page.

## Verification evidence

- `spec/identity.test.ts`: a fresh request is issued a cookie matching the
  `<uuid>.<64-hex>` shape; the same cookie round-trips to the same id across
  requests; two independent requests (no shared cookie jar) get different
  ids; a request presenting another visitor's bare id, or that id with a
  wrong tag, is issued a *different* fresh id rather than being treated as
  that visitor; a malformed cookie value is handled without error (still
  `200`, still issued a valid cookie).
- `spec/brick.test.ts`: a `color` value crafted to break out of the `style`
  attribute (`"><script>...`) is rejected with `400` and never appears on the
  rendered page.
- Manually, against a local run: a forged `Cookie: visitor_id=<real-id>`
  (bare, no tag) and a forged `Cookie: visitor_id=<real-id>.<wrong-tag>` both
  produced a `Set-Cookie` response issuing a *new*, different id — confirmed
  by inspecting the returned cookie value in each case, not merely the status
  code. Simulating `X-Forwarded-Proto: https` produced a cookie with `Secure`
  set; a plain HTTP request did not. Server stdout showed `session_issued`,
  `session_rejected`, `brick_placed`, and `brick_rejected` lines for the
  corresponding requests, each carrying a `visitor_id` and never a cookie
  value or tag.
