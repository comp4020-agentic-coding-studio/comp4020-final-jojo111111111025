# Process overview

## Starting point

The repo arrived as the course starter: a busybox `Dockerfile` serving a
placeholder page, `spec/invariants.test.ts` checking only that the running
app answers at `/` and publishes `README.md`'s headings at `/readme/`, and
empty `CLAUDE.md`/`PROCESS.md`/`README.md` templates
([`98fc07a`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-jojo111111111025/commit/98fc07a)).
`mise install` and `pnpm install` ran clean; `pnpm check` failed with
"nothing is answering at `http://localhost:8080`", which is the expected
pre-app state, not an inherited bug — the spec checks a running app, and
there wasn't one yet.

## Concept and scope

I asked the agent to read the final-project brief, the crit 8 brief, and
`spec/invariants.test.ts`, then propose the smallest viable concept and plan
before writing any code, and told it explicitly not to add optional features
yet — get one complete vertical slice working, deploy it, and verify
persistence, nothing more. It proposed The Wall in plan mode: a bounded
20×12 grid that fills one brick at a time, in the order visitors arrive,
with a visitor's own bricks outlined via a cookie. The reasoning was that
crit 8 only requires single-visitor persistence (multi-user and real-time
are crit 9's job), and a bounded, order-only interaction avoids the median
"chat room with the nouns swapped" the brief warns against, while still
setting up cleanly for crit 9's real-time layer. I approved that plan before
anything was built.

## Stack

The agent chose plain Node: `node:http` for the three routes, and the
built-in `node:sqlite` (`DatabaseSync`) for the one `bricks` table, with no
runtime npm dependencies at all. The trade-off it gave: this avoids a
framework/ORM that would add nothing at this scale, and avoids the native
build step a package like `better-sqlite3` usually needs inside Alpine,
while comfortably fitting the course's one-machine, 256MB limit. The
Dockerfile was rewritten to `node:24-alpine` running `server.ts` directly,
no build step
([`7263d03`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-jojo111111111025/commit/7263d03)),
on top of the server itself
([`ae9a0ec`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-jojo111111111025/commit/ae9a0ec)).

## Making the persistence promise checkable

Crit 8's spec line — "a stranger can visit, do the core thing, and find
their trace still there when they come back" — had no automated check yet.
The agent turned it into `spec/brick.test.ts`: a fresh request gets a
visitor cookie, posts a brick with it, then requests the page again with
the same cookie and asserts that brick is still rendered and still outlined
as theirs
([`c5914dc`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-jojo111111111025/commit/c5914dc)).

## Verification

Locally: the agent ran the server directly (`DB_PATH` pointed at a scratch
SQLite file, `PORT=8080`) and ran `pnpm check` against it — typecheck plus
all three spec tests passed. It also checked by hand with `curl` and a
cookie jar: place a brick, reload with the same cookie, confirm it's
outlined.

Docker itself could not be built or run locally — there's no `docker`
binary in this environment — so the Dockerfile was never tested on this
machine before it went anywhere. The actual verification of the Docker path
was `flyctl deploy --remote-only`, which builds that same Dockerfile on
Fly's remote builders; that build succeeded and produced a 54MB image.

After deploying, the agent checked the live URL directly: `/` and
`/readme/` both returned 200, and two different visitors were tried against
the live app — one cookie jar that placed a brick and saw it outlined on
return, and a second, cookie-less request that saw the same brick on the
wall but nothing outlined for it. A later redeploy (to push a README
change) used the same machine and volume, and the earlier brick was still
there afterward, confirming persistence survives a redeploy, not just a
reload.

## README

The agent drafted a first-pass `README.md` to unblock the deploy, including
a pointer to Robin Sloan's ["Home-Cooked
App"](https://www.robinsloan.com/notes/home-cooked-app/) essay as a fit for
the brief's own pointers toward small-web, small-group software — that is
the one source looked at so far, not yet weighed against alternatives. I
then rewrote the file myself in my own words
([`43455e7`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-jojo111111111025/commit/43455e7)),
on top of the agent's draft
([`04aba53`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-jojo111111111025/commit/04aba53)),
keeping that same source and the brief's framing of small, bounded, personal
software as what informed "what good means" for this first pass.

## Crit 9: real-time

### Direction

I gave the agent a detailed upfront brief for this crit: inspect the
repository before changing anything, prefer SSE if it fits the existing
`node:http` server, use "first successful placement wins" as the starting
concurrency decision unless inspection gave a strong reason to change it,
write the decision up as an ADR, add tests for persistence/concurrency/
real-time without weakening what's there, and not claim anything works
without having tested it. I told it explicitly not to rebuild the app and to
treat the repository as the source of truth over my own description of it.

### Inspection, before anything changed

The agent read `server.ts`, `CLAUDE.md`, `README.md`, `fly.toml`, the
Dockerfile, the spec and its `global-setup.ts`, `vitest.config.ts`, the CI
workflow, and `reflections/crit-8.md`, then reported back before writing any
code. Two things that inspection found shaped everything after it:

- `flyctl scale show -a comp4020-final-jojo111111111025` showed exactly one
  machine (`shared-cpu-1x`, `256mb`, `syd`), and `.github/workflows/
  checks.yml`'s deploy step pins `--ha=false` — so the classic "SSE client
  list doesn't survive multiple instances" problem the brief warned about
  doesn't apply here. I didn't have to ask it to verify this; it checked
  before assuming.
- Reading `POST /brick`'s handler, the agent noticed the read-decide-write
  sequence has no `await` in it, which — given Node's single-threaded,
  run-to-completion scheduling — means two concurrent HTTP requests to this
  one process can't actually interleave inside that window today. It flagged
  this as something that changes how the concurrency tests should be written
  (testing the real, reachable guarantee, not performing a race that can't
  happen here) rather than quietly building tests around an assumption the
  codebase doesn't actually have.

It also flagged, before implementing, that the brief's language about a
losing visitor "choosing another empty cell" doesn't literally apply — this
app has no cell-picking UI, placement is always "next open slot." I agreed
with its reading: a rejected placement just means "submit the form again."

### What got built

`server.ts`
([`fe6421f`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-jojo111111111025/commit/fe6421f)):
`GET /events` (SSE) holds a live `Set` of open responses, sends a full
snapshot on connect, and broadcasts a `brick` event right after each
successful `INSERT` — never before, and never from the `catch` branch. A
rejected insert now redirects to `/?conflict=1`, which renders a plain
notice, instead of silently dropping the visitor's placement (the crit 8
behaviour). The page grew `data-x`/`data-y` on each cell and a small inline
script (no new dependency) that listens for `snapshot` and `brick` events and
repaints the grid in place, plus a one-line live/reconnecting status.

The ADR
([`54bcdcf`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-jojo111111111025/commit/54bcdcf))
at `docs/adr/001-concurrent-brick-placement.md` records "first successful
placement wins" against the two alternatives, why README.md's criteria rule
the alternatives out, and the verification evidence above.

`CLAUDE.md` and `README.md`
([`525fe7d`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-jojo111111111025/commit/525fe7d))
got the smallest honest updates: new rules for the harness to hold to
(broadcast-after-commit, a visible answer on conflict, `/events` stays a bare
`Set`), and one factual sentence in the README that the wall is now live,
with a pointer to the ADR. Neither "what it is" nor "what good means" was
rewritten beyond that.

### Tests, and a real failure along the way

`spec/concurrency.test.ts` and `spec/realtime.test.ts`
([`2aa19dd`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-jojo111111111025/commit/2aa19dd)).
The first version of the concurrency test compared a before/after snapshot of
occupied cells around 8 concurrent placements. Running `pnpm check` against a
local server, it failed once: 9 new cells instead of 8. The cause was
vitest's default parallel-file execution — `spec/realtime.test.ts` was
placing its own brick in the same window, and the before/after diff couldn't
tell the two apart. The agent fixed this by identifying "my" bricks by
visitor cookie instead of counting cells, in both test files, which is
immune to whatever else is running at the same time. After the fix, `pnpm
check` passed cleanly more than ten times in a row locally before anything
was committed.

The one thing this repo cannot test automatically — honestly, not just
"didn't get to it" — is the `/?conflict=1` redirect's actual trigger. Given
the finding above, a real rejected insert can't be produced through the live
HTTP app on this one process. `spec/realtime.test.ts` instead tests that
`GET /?conflict=1` renders its notice correctly (also checked by hand with
`curl` before the test existed), and the ADR says plainly that the trigger
itself is unverified for that reason.

### Verification

Locally: `pnpm check` against `node server.ts` pointed at a scratch
`DB_PATH`, all 8 tests passing, repeated runs with no flakiness. By hand:
opened `/events` with `curl -sN` and watched a `snapshot` event arrive
immediately, containing a brick placed moments earlier by a different cookie
jar; opened it again, placed a brick from a second cookie jar while the first
stream stayed open and unreloaded, and watched the `brick` event arrive
within about half a second; fetched `/?conflict=1` directly and confirmed the
notice text.

Deployed with `flyctl deploy --remote-only --ha=false -a
comp4020-final-jojo111111111025`: the build succeeded (54MB image, same as
crit 8's), the one existing machine updated with a rolling strategy and
reached a good state. (Fly's own DNS-propagation check failed with a local
UDP timeout in this environment — unrelated to the app, and `curl` against
the live URL immediately afterward returned 200.)

Then verified against the **live, deployed** app, not localhost: two separate
cookie jars (`curl -c`) as two independent visitors. Session B opened
`/events` and sat idle. Session A then posted a brick. Session B's
already-open, never-reloaded stream captured:

```
id: 2
event: brick
data: {"x":4,"y":0,"color":"#ffffff","visitor_id":"535ca088-3dbe-4cd7-8991-50381472fd8a"}
```

`535ca088-…` is exactly session A's cookie value, confirmed separately
against session B's own, different cookie — so this was genuinely one
visitor's placement reaching a second, idle visitor's open connection. The
local automated test measures this precisely (`elapsedMs < 1000`, passing
consistently); the live check confirms the same behaviour qualitatively —
the event was already sitting in B's captured output within the 3-second
window the check used, with no reload. `GET /?conflict=1` was also checked
directly against the live app and rendered the same notice as locally.

What's still outside what either the automated tests or this manual check
cover: a true two-visitor race reaching the `PRIMARY KEY` constraint's reject
branch on the live app — the ADR explains why that's not reachable through
the HTTP layer on this one-process deployment, not merely untested.

## Crit 10: fly by instruments

### Direction

I gave the agent the full crit 10 requirements up front (telling two visitors
apart server-side, authorisation, logging, tests, docs) and told it explicitly
to inspect the existing repository before changing anything, not to assume any
file path or framework detail, not to discard existing work, and to report
back honestly on what was already satisfied versus genuinely missing, rather
than rebuilding anything that already worked.

### Inspection, before anything changed

The agent read `server.ts`, `CLAUDE.md`, `README.md`, both existing ADRs, all
four spec files and `spec/README.md`, `PROCESS.md`, both reflections,
`package.json`, `fly.toml`, the `Dockerfile`, and the CI workflow, then ran
`pnpm check` against a locally-running instance to confirm the starting state
was green (8/8 tests passing) before writing anything.

That inspection found the real gap wasn't "no multi-user support" — the wall
has been multi-user and live-updating since crit 8/9, and every brick already
records its creator's `visitor_id`. The actual gap was narrower and more
specific: the `visitor_id` cookie was **unsigned**. The server trusted
whatever value arrived in that cookie outright, so a visitor could set
`Cookie: visitor_id=<someone-else's-id>` — an id visible to them already,
since it's broadcast in plain text on every SSE `brick` event — and be treated
by the server as that visitor. Nothing before crit 10's spec actually required
authorisation beyond "recognise your own bricks," so this had been a latent
gap since crit 8, not a regression. The agent also noticed, while reading the
`POST /brick` handler, that `color` is the one client-submitted value a
placement carries, and it was being interpolated unescaped into an HTML
`style` attribute — a real injection path, separate from the identity work but
found during the same close reading.

### What got built

`server.ts`
([`c05f132`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-jojo111111111025/commit/c05f132)):
the cookie's value changed from a bare `randomUUID()` to a signed pair,
`<uuid>.<hmac-sha256-hex>`, verified with `timingSafeEqual` so a forged or
guessed tag can't be distinguished from a correct one by timing. The signing
key (`SESSION_SECRET`) is generated once with `randomBytes(32)` and persisted
in a new `meta` table in the same SQLite file as `bricks`, so it survives
restarts and redeploys on the one volume without separate secret management.
An invalid, tampered, or unsigned cookie is never adopted as someone else's
identity — it's handled exactly like no cookie at all, and a fresh identity is
issued. The cookie also gained `Secure` when the request arrives over HTTPS
(detected via `X-Forwarded-Proto`, which Fly's edge sets). The `color` field
is now validated against the server's own `COLORS` palette before any read or
write, closing the injection path. Structured JSON logging (`log()`) was
added for `session_issued`, `session_rejected`, `brick_placed`, and
`brick_rejected`, each carrying the server-resolved `visitor_id` and never a
cookie value or signature.

The full reasoning — options considered, why signing over a session-store
table or an auth library, what counts as "a user" here, and what each visitor
can see and change — is written up in the ADR
([`41ddd3f`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-jojo111111111025/commit/41ddd3f))
at
[`docs/adr/002-anonymous-identity.md`](docs/adr/002-anonymous-identity.md).
`CLAUDE.md` and `README.md` got the corresponding rules and documentation in
that same commit: never trust an unverified `visitor_id`, never log a cookie
value or the signing secret, and what the identity model and logging actually
guarantee.

### Tests, and a real regression caught along the way

`spec/identity.test.ts` and a new test in `spec/brick.test.ts`
([`899f84c`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-jojo111111111025/commit/899f84c)):
a fresh request is issued a cookie matching the signed shape; the same cookie
keeps the same identity across requests; two independent requests get
different identities; a request presenting another visitor's bare id, or that
id with a wrong tag, is issued a *different* fresh identity rather than being
treated as that visitor; a malformed cookie is handled without error; a
`color` value crafted to break out of the `style` attribute is rejected with
`400` and never appears on the page.

Running the full suite after writing these caught a real regression: changing
the cookie's format from a bare id to `id.tag`
([`c05f132`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-jojo111111111025/commit/c05f132))
broke two **existing** tests (`spec/concurrency.test.ts` and
`spec/realtime.test.ts`), which had been parsing the cookie's value directly
as the visitor id to compare against `bricks.visitor_id` and SSE payloads. The
fix, in that same commit, was to extract the id half
(`cookie.split("=")[1].split(".")[0]`) rather than weaken what either test
checks — both still assert exactly the same claims about concurrent placement
and real-time delivery as before. `pnpm check` was run five times in a row
afterward with all 14 tests passing every time.

### Verification

Locally: `pnpm check` against `node server.ts` pointed at a scratch `DB_PATH`
— typecheck and all 14 tests passing, repeated five times with no flakiness.
By hand, against the same local run: a forged `Cookie: visitor_id=<real-id>`
(no tag) and a forged `Cookie: visitor_id=<real-id>.<wrong-tag>` both produced
a `Set-Cookie` response issuing a *different*, new id — confirmed by reading
the returned cookie value, not just the status code, so the impersonation
attempt genuinely failed rather than coincidentally looking fine. Simulating
`X-Forwarded-Proto: https` produced a cookie with `Secure` set; a plain HTTP
request did not. A `color` value containing `"><script>` was rejected with
`400` and confirmed absent from the page on reload. The server's stdout showed
the expected `session_issued`, `session_rejected`, `brick_placed`, and
`brick_rejected` lines for each of these, with a `visitor_id` field and never
a cookie value.

What this crit's verification does **not** cover: a genuine two-person,
two-Chrome-profile demonstration against the **deployed** app, which happens
at the crit itself — the two users and their separate profiles aren't
something this environment can produce. The local, single-process checks
above establish that the mechanism works correctly; the live crit is where it
gets exercised by two actual people.
