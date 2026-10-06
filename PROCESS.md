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
