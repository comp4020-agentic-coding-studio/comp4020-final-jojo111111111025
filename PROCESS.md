# Process overview

## Starting point and why a new repo-within-the-repo

This repository's `main` previously held a different crit-8/9/10 project
("The Wall"). For C10, "Fly by instruments," the redesigned game — Last
Shelter — was built and verified as its own project
(`/home/fangzhou/comp4020/last-shelter`) before being integrated into this
repository's history on a branch, rather than developed directly against
The Wall's `server.ts`/SQLite-grid architecture, which shares no meaningful
structure with a real-time multiplayer game server. The integration
preserves this repository's original Git history rather than replacing it,
removes The Wall's application code and crit-8/9 documentation (superseded,
not relevant to a project that no longer exists in this working tree), and
keeps the course scaffolding — CI workflow, pre-commit secret hook,
`scripts/check-evidence.ts`, and the mandatory `spec/invariants.test.ts` —
unchanged.

## Concept and scope

Last Shelter is a browser-based, top-down 2D cooperative survival/crafting
game for one to four players sharing one authoritative world over
WebSockets. The brief's exit criteria were built in four phases, each
committed as a complete, tested slice:

- **Phase A** ([`b7e6a7f`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-jojo111111111025/commit/b7e6a7fbbe03d64e4029b128c8a09f9e303aca94)):
  a deterministic, seeded 64×64 map, movement/collision, and
  server-validated resource gathering — the minimum vertical slice, stood
  up with TypeScript, `ws`, `better-sqlite3`, `zod`, and Vitest.
- **Phase B** ([`869abcd`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-jojo111111111025/commit/869abcd45142f872627e3f3b22a0542b681fb9e3)):
  a stackable inventory, data-driven crafting, building placement (with a
  `UNIQUE(x, y)` constraint giving the same atomic-placement guarantee The
  Wall's `bricks` table used), shared storage chests, and timestamp-based
  farming.
- **Phase C** ([`6910052`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-jojo111111111025/commit/6910052829aa67267c6434fa6041fde15578ae73)):
  replaced the per-connection throwaway id with a stable, server-verified
  anonymous identity — a signed, httpOnly cookie (HMAC-SHA256, timing-safe
  comparison, 30-day expiry, 7-day rotation, revocation) — plus
  room/player-limit enforcement and reconnect/duplicate-connection
  handling.
- **Phase D** ([`86bf6a8`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-jojo111111111025/commit/86bf6a8b637b091f1312ac13baaa834bf764b92d)):
  survival (health/death/respawn), a wall-clock-derived day/night cycle,
  server-validated melee combat against AI-driven enemies, a structurally
  separate dungeon coordinate space, and the beacon win condition, with
  activation races resolved by the database's own atomic
  `UPDATE ... WHERE completed_at IS NULL`.

## A real regression found and fixed mid-project

Between Phase C and Phase D, auditing in-memory/SQLite consistency before
starting Phase D turned up a real gap
([`90aa88a`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-jojo111111111025/commit/90aa88a4cb030ea359819eb4495ff9c67c01a190)):
the integration test harness (`spec/helpers/server-harness.ts`) built its
`Room` with no `RoomPersistence` hooks at all, unlike production
(`src/server/index.ts`), which wires every hook. Every "full stack"
integration test added in Phase C — room-limit, reconnect,
duplicate-connection, cross-room-access — therefore drove a server that
looked identical from the outside but silently never wrote gather/craft/
build/farm/inventory mutations to disk; the "survives a restart" guarantee
those tests implied was never actually exercised end-to-end, only
unit-tested via direct calls into `world.ts`'s persistence functions. The
fix addressed the root cause rather than patching the harness: the
`RoomPersistence` wiring and initial-state loading were factored out of
`index.ts` into `createRoomPersistence`/`loadInitialRoomState` in `world.ts`,
so production and the test harness build a `Room` from the exact same code
path and can no longer drift apart silently. A new integration spec
(`spec/state-consistency.spec.ts`) asserts gather/build actions driven
purely over the WebSocket wire appear in the database, including a full
server-restart test.

## Integrating into this repository (C10)

C10's integration work itself: the original `main` snapshot (preserved in
this course's own backup bundle, commit
[`6978692`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-jojo111111111025/commit/69786920b175d350d5ef15962eccb60c2ea0f056))
was used as the base of a new branch rather than replacing `main` outright,
since the two projects' histories are unrelated and the repository's prior
commits should not be discarded. Last Shelter's `src/`, `public/`, and
`*.spec.ts` suite were added; The Wall's `*.test.ts` suite (which asserted
on endpoints — `POST /brick`, `/events` — this app doesn't have),
crit-8/9/10 reflections, both Wall-specific ADRs, `server.ts`, and the
starter `placeholder/` pages were removed as genuinely obsolete. Colliding
configuration files (`package.json`, `tsconfig.json`, `vitest.config.ts`,
`pnpm-workspace.yaml`, `.gitignore`) were merged rather than overwritten,
keeping the `prepare` (Git hooks) and `check:evidence` scripts from the
original project alongside Last Shelter's own build/dev/test scripts and
dependencies.

The one genuine gap this integration had to close, not just carry over:
`spec/invariants.test.ts` is course-required and checks that the running
app serves `/readme/` with `README.md`'s headings — a route Last Shelter
never had, since it only ever served a static client bundle. A `/readme/`
route was added to `src/server/index.ts`, rendering `README.md` verbatim on
every request (no cached copy to drift out of sync), matching the contract
the course's own test already enforces.

C10 also asked for server-side logging that identifies who did what. Last
Shelter's WebSocket layer (`net.ts`) previously logged nothing beyond
server startup; `src/server/log.ts` and calls at every session, join/
reconnect/disconnect/eviction, and identity-attributed gameplay event
(combat, boss defeat, beacon deposit/activation) were added, each carrying
the server-resolved `player_id` and never a cookie value or signing secret
— see `docs/adr/001-anonymous-identity.md` for the full authorization model
and verification evidence.

The repository's `Dockerfile` and `fly.toml` also needed deliberate changes,
not just a file copy: the original `Dockerfile` built and ran The Wall's
`server.ts` directly with no build step and no runtime dependencies; Last
Shelter needs `pnpm install`, a client bundle step (`pnpm build:client`),
and starts `src/server/index.ts` instead. `fly.toml`'s one-machine,
256MB, one-volume shape (`primary_region`, `[http_service]`, `[[vm]]`,
`[mounts]`) is unchanged — Last Shelter fits the same course-managed
deploy target — but `DB_PATH` now points at the mounted `/data` volume
instead of Last Shelter's local-dev default of `./data/world.sqlite`, so
game state actually persists across a redeploy the way `fly.toml`'s
comments describe.

## Verification

Locally: `pnpm typecheck` and `pnpm build:client` both run clean on the
integrated tree. `pnpm check` (the full suite, run against the built app
with `APP_URL` set, matching how CI's `checks.yml` invokes it) passes 204
tests across 22 spec files — the 202 tests Last Shelter's own phases
accumulated, plus the course's 2 invariant checks against the live
`/readme/` route added for this integration. By hand against the same
locally running server: `curl` against `/` returns `200`; `curl` against
`/readme/` returns the rendered `README.md`, headings intact and in order;
the server's stdout showed `session_issued`, `player_joined`,
`beacon_deposit`, and `beacon_activated` lines during a manual playthrough,
each carrying a `player_id` and never a cookie value. `pnpm check:evidence`
passes: `CLAUDE.md` is present and rewritten for this project,
`reflections/crit-10.md` exists, PROCESS.md carries no template text, and
every commit cited above resolves in this repository's object store.

Not yet verified, and explicitly out of scope for this local integration
pass: a live, two-person, two-Chrome-profile session against the actually
*deployed* app (two browser profiles acting on shared state, reliably told
apart by the server) — that is what the crit itself exercises, once this
branch is reviewed, merged, and shipped. The Docker build itself was not
run locally in this environment (no `docker` binary available here,
matching the constraint noted in this repository's own prior crit-8
history); it was last verified to build and deploy by `flyctl deploy
--remote-only`, which this integration has not yet re-run, by design —
deployment waits for explicit approval.
