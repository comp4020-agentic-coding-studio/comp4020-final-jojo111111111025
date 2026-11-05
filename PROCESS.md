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
WebSockets. The brief's exit criteria were built and tested in four phases:

- **Phase A**:
  a deterministic, seeded 64×64 map, movement/collision, and
  server-validated resource gathering — the minimum vertical slice, stood
  up with TypeScript, `ws`, `better-sqlite3`, `zod`, and Vitest.
- **Phase B**:
  a stackable inventory, data-driven crafting, building placement (with a
  `UNIQUE(x, y)` constraint giving the same atomic-placement guarantee The
  Wall's `bricks` table used), shared storage chests, and timestamp-based
  farming.
- **Phase C**:
  replaced the per-connection throwaway id with a stable, server-verified
  anonymous identity — a signed, httpOnly cookie (HMAC-SHA256, timing-safe
  comparison, 30-day expiry, 7-day rotation, revocation) — plus
  room/player-limit enforcement and reconnect/duplicate-connection
  handling.
- **Phase D**:
  survival (health/death/respawn), a wall-clock-derived day/night cycle,
  server-validated melee combat against AI-driven enemies, a structurally
  separate dungeon coordinate space, and the beacon win condition, with
  activation races resolved by the database's own atomic
  `UPDATE ... WHERE completed_at IS NULL`.

## A real regression found and fixed mid-project

Between Phase C and Phase D, auditing in-memory/SQLite consistency before
starting Phase D turned up a real gap
(during the Phase C-to-D regression audit):
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

## Post-integration usability pass

After C10's integration landed, a separate staged pass addressed real
usability gaps in the shipped game — a new first-time player had no stated
goal or control legend, no feedback on why an action failed, movement for
remote players/enemies looked choppy at the client's lower snapshot rate,
and there was no mobile input or narrow-viewport layout at all. This was
scoped explicitly as polish on the existing game, not new gameplay: no
server message schema, movement/combat/gather validation, or win condition
changed in any of the three stages below. None of this work has been
committed yet — it sits as uncommitted changes in this working tree,
pending review; nothing has been pushed or deployed.

### Stage 1 — core usability

A join-screen goal blurb and controls summary, plus a persistent in-game
controls legend, were added to `public/index.html`. `src/client/main.ts`
gained an exhaustive `ACTION_REASON_MESSAGES` map (every `reason` string
`room.ts`/`net.ts` can emit) wired through one `showActionFeedback()` call,
so a rejected action always surfaces a readable toast instead of silently
doing nothing. The nearest-interactable/attackable/chest helpers `main.ts`
already computed for E/Space/C behaviour are now also used to compute a
highlight ring around whatever a key press would currently act on, drawn by
a new optional `highlights` parameter on `render()`
(`src/client/render.ts`). A `window.blur` handler clears all held keys, so
switching tabs/windows mid-move no longer leaves a key "stuck" down. A new
`InterpolationBuffer` class (`src/client/interpolation.ts`, pure, no DOM/
network dependency) smooths remote players' and enemies' rendered position
between the server's 10Hz snapshots; the local player and every server-side
range/validation check still use raw authoritative positions, never
interpolated ones. `spec/interpolation.spec.ts` adds 7 unit tests covering
single-sample behaviour, interpolation, clamping at both ends, correct
bracket-pair selection with 3+ samples, and history eviction.

**Verification:** `pnpm typecheck` clean; `pnpm build:client` succeeds
(43.8kb, up from 35.1kb pre-change); `pnpm test` — 211/211 passing across
23 spec files (204 pre-existing + 7 new), 0 regressions. Every DOM id
`main.ts` queries was cross-checked against the shipped `index.html`
programmatically (`comm` on two sorted id lists) — no missing element.
**Not independently re-verified by rendering a browser in this pass**
(see below) — Stage 1's visual claims (ring placement, smoothness) rest on
code reading and the automated tests, not a screenshot.

### Stage 2 — mobile and responsive layout

A touch joystick (`#touch-joystick`) and four action buttons
(`#touch-actions`) were added to `public/index.html`, shown only under a
`(pointer: coarse)` media query so a desktop mouse/keyboard session never
sees them. The joystick and buttons use Pointer Events (not
`touchstart`/`touchmove`), so the same code path also responds to a mouse
for manual testing without real touch hardware. In `main.ts`, the four
action buttons call the exact same `performInteract`/`performAttack`/
`performToggleChest`/`performToggleBeacon` functions the keyboard handler
calls — touch and keyboard can never diverge in what a given action does.
Movement is summed, not overwritten: the joystick's `touchMove` and the
keyboard's `keys` both feed `sendInputFromKeys()`, clamped to `[-1, 1]` the
same way the server already clamps `setInput`, so a touch drag and a held
key can coexist without fighting.

Layout: a `--bottom-safe` CSS custom property (0 on desktop, 160px under
`(pointer: coarse)`) raises every bottom-anchored prompt/panel clear of the
joystick/buttons. `#hud` wraps and shrinks font at `≤480px` so its 9
resource counters no longer run off the right edge. `#health-bar` and
`#craft-panel` — which overlap by a computed 46px at 390px width when both
stay anchored to their own corner at full size — stack vertically instead
below `≤460px`. The join screen, chest panel, and beacon panel all got
`max-width: calc(100vw - Npx)` safety margins so they can't overflow a
390px-wide viewport.

**Verification method and its limit, stated plainly:** this environment has
no working browser (Playwright's Chromium needs `libnspr4`/`libnss3`,
installing them needs `sudo apt-get`, and no password is available
non-interactively here) and no `docker` binary, so none of Stage 2's
layout claims were confirmed by actually rendering the page. What was
checked instead:
- `pnpm typecheck` clean, `pnpm build:client` succeeds (43.8kb), `pnpm test`
  — 211/211 passing, 0 regressions.
- Every DOM id `main.ts` queries (including the five new touch-control ids)
  exists in the shipped `index.html` — checked programmatically, not by
  eye.
- Static CSS arithmetic against the two required viewports: at 390×844,
  `--bottom-safe: 160px` pushes bottom-anchored panels' effective floor to
  roughly y≈684, while the joystick (bottom:20px, 120px tall) and action
  buttons (bottom:20px, 56px tall, in a 2×2 grid) occupy roughly y≈702–824
  — no computed overlap between the two groups at that width. At 1920×1080
  a mouse pointer is not `coarse`, so the touch controls stay `display:
  none` and the pre-existing desktop layout (unchanged by this stage) is
  what renders.
- This is static analysis, not a pixel-level visual check. Real rendering
  behaviour — font metrics, actual element box sizes, whether the two
  groups genuinely don't overlap once the browser lays everything out —
  has **not** been visually confirmed, and is not claimed as such.

### Stage 3 — concurrency, reconnect, and persistence acceptance testing

Tested with two independent HTTP cookie jars and `ws` WebSocket clients
driving the real, already-running dev server (`localhost:8080`, real
`node:http`/`WebSocketServer`, real SQLite file) — genuine network I/O and
process state, no browser, no test-harness shortcuts, no mocked server.
Each test script was written, run once against a freshly-started server,
and then deleted — it isn't part of the repo, since the same scenarios are
already covered by `spec/`'s own integration suite; what follows is this
pass's own observed results, not a re-statement of `spec/`'s.

| Scenario | Result | Evidence |
|---|---|---|
| Two independent cookie jars get distinct identities | PASS | different `ls_id` cookies → different `playerId`s |
| Both players appear in `room.roster` after independently joining | PASS | roster array contained both ids |
| Real-time propagation: one player's movement reaches the other over the wire | PASS | `player.state` broadcast observed carrying the mover's id |
| Concurrent gather race on a resource node with multiple units left | Both requests legitimately succeeded, draining the node 3→2→1 — **this is correct behaviour, not a bug**: a node with >1 remaining has no single-winner invariant to violate | `objectRemaining` decremented once per successful grant, no double-decrement, no crash |
| Concurrent gather race on the **last** remaining unit (drained to 1 first, then both clients fired `player.interact` on it simultaneously) | PASS — exactly one request succeeded (`ok: true`), the other failed with `reason: "depleted"` | no double-grant of the same unit |
| Reconnect within the grace window, same server process | PASS | same cookie → same `playerId` on `room.joined` |
| A genuinely new cookie never collides with an existing identity | PASS | third client's `playerId` distinct from the first two |
| Persistence across a **real** process kill (`kill -9`) + restart on the same DB file (confirmed by a new PID in `ps`) | **Identity: PASS. Inventory: PASS. Position: does not persist** | same `playerId` and byte-identical `inventory` object before/after; position reset to spawn (32.5, 33.5) rather than the pre-restart coordinate |

**What "restart persistence" does and doesn't cover, precisely:** this
pass's own `kill -9` + new-process test (table row above) checked identity
and inventory only — it did not touch health or any broader world state
(resource depletion, buildings, boss-defeated/beacon progress). Those are
instead covered by `spec/`'s own automated suite
(`spec/survival.spec.ts`'s health test, `spec/state-consistency.spec.ts`'s
resource-depletion test, `spec/phase-d-integration.spec.ts`'s beacon/boss
test) — but that suite's "restart" (`spec/helpers/server-harness.ts`)
closes a DB handle and opens a new one with a new `Room` object **inside
the same test process**, never a real OS-level process kill. So: identity
and inventory have now been verified across a genuine OS-level restart;
health and broader world state have only been verified across the
automated suite's in-process-simulated restart, not yet across a genuine
OS-level one. No test was added or changed in this pass to close that gap
— extending the manual `kill -9` probe to also gather/take damage/deposit
materials before killing the process is a straightforward follow-up, not
something this review did.

On the position-after-restart result: this is the same finding this
project's own C8/C9 history already recorded for its prior concept, and it
is not a regression against anything this README promises — the
`## Persistence` section lists world seed/resource depletion, buildings,
chests, farm timestamps, "each identity's inventory and health," and
boss/beacon state; it does not list per-player position. Position lives
only in the in-memory `Room` (survives a reconnect within the same process,
as the grace-window test above confirms) and is not part of `world.ts`'s
persisted schema. No code change was made to address this in this pass —
it wasn't in Stage 3's brief, which was acceptance testing, not a fix for
whatever that testing found; if persisted position becomes a requirement,
that's a schema change for a future stage, not this one.

**What this did not test:** an actually-deployed instance (this ran against
localhost only, matching the explicit instruction not to deploy without
approval), network-throttling / flaky-connection behaviour beyond what
`spec/reconnect.spec.ts` already covers, health/world-state persistence
across a genuine OS-level restart (see above — only identity/inventory got
that level of test), and anything requiring a real rendered browser (two
genuinely separate browser profiles, as a human reviewer would run
manually) — all of this remains the reviewer's or a future stage's job.

## Visual asset integration

A separate research pass (asset packs downloaded and evaluated only in a
`/tmp` staging area, never this repo, until each stage below was explicitly
approved) replaced the game's flat-color placeholder rendering with real
sprite art: ansimuz's Tiny RPG Forest and Mountain tilesets (CC0) for the
overworld, and Calciumtrice's Dungeon Tileset (CC-BY 3.0) for the dungeon.
Full license text and required attribution are in
`public/assets/CREDITS.md`. Calciumtrice's character/monster sprites are
single static poses with no walk/attack/hurt/death animation — this is a
property of the source pack, confirmed by decoding the actual downloaded
PNG pixels rather than assumed from its description, and is not something
later stages invent frames to paper over.

### Stage 1 — terrain rendering

`src/client/sprites.ts` is new: it loads the three tileset PNGs once at
startup and maps each `TerrainKind` to a source rect on one of them
(`TERRAIN_SPRITES`), replacing `render.ts`'s old `TERRAIN_COLORS` hex-string
lookup one-for-one in shape. `render.ts`'s tile-drawing loop now calls a new
`drawTile()` helper that tries the sprite first and falls back to the old
flat-color fill when there's no sprite for a terrain (today: `"water"`
only — neither approved pack includes open water) or the sheet hasn't
finished loading yet, so the map is never blank during the brief
image-load window. `imageSmoothingEnabled = false` is set on the canvas
context so pixel art isn't bilinear-blurred; since resizing the canvas's
backing store resets all 2D context state, this is set from inside
`resize()` itself, not just once at startup, or it would silently revert on
the first window resize.

A real pre-existing bug was found and fixed while doing this, not
introduced by it: `SOLID_TERRAIN` only ever listed `"water"`, so a player
could walk straight through the dungeon's rock-terrain border — only the
array-bounds check stopped them, not the wall tiles themselves. Reproduced
first with a standalone scratch script (deleted after use, not committed)
driving `Room.tick` directly, confirming a player's x-position passed from
1.5 down to 0.3 — through the wall — before any fix. The fix doesn't touch
`SOLID_TERRAIN`'s existing `"rock"` entry (overworld mountain-biome terrain,
which also hosts stone resource nodes and must stay walkable — confirmed by
reading `terrainFor()`'s elevation thresholds and `spec/map.spec.ts`'s own
regression test for rock-terrain reachability before touching anything).
Instead, the dungeon's own border and floor got two new, dungeon-specific
terrain kinds — `"dungeon_wall"` (added to `SOLID_TERRAIN`) and
`"dungeon_floor"` — so the dungeon can have its own solid walls and its own
stone-tileset rendering without changing what `"rock"`/`"grass"` mean
anywhere in the overworld. `spec/dungeon-terrain.spec.ts` is a new
regression test: it confirms the terrain kinds' solidity directly, confirms
`generateWorldMap()`'s real dungeon generator places them correctly, and
drives a player into the border through the real `Room.tick` path (the same
scenario the scratch repro used) to confirm the fix holds end-to-end, not
just at the data level. `spec/sprites.spec.ts` checks the sprite
manifest's own data shape (every rect has sane dimensions, every solid
dungeon terrain has a sprite, `"water"`'s missing sprite is intentional) —
it cannot exercise actual image loading, since that needs a real browser
and jsdom has no image decoder.

One static-file-serving gap was also fixed: `src/server/index.ts`'s
`CONTENT_TYPES` map had no `.png` entry, so any image placed in `public/`
would have been served as `application/octet-stream` — harmless for how
`<img>`/canvas loading actually behaves, but wrong, and now fixed.

**Verification:** `pnpm typecheck` and `pnpm build:client` both clean.
`pnpm test` — 220/220 passing across 25 spec files (211 from before this
stage + 9 new: 4 in `spec/dungeon-terrain.spec.ts`, 5 in
`spec/sprites.spec.ts`), 0 regressions. `pnpm check:evidence` passes.
Checked by hand: the server was started against a fresh DB and
`curl -I http://localhost:8080/assets/{forest,mountain,dungeon}/tileset.png`
confirmed all three assets serve `200` with `Content-Type: image/png`; the
built `public/main.js` was grepped to confirm it actually references
`/assets/*/tileset.png`, not just that the source file does. The exact
sprite-sheet pixel coordinates `sprites.ts` uses were re-cropped from the
files as committed (not from the original research download) and visually
confirmed to be the intended clean grass/dirt/rock/floor/wall tiles, not
guessed from a thumbnail.

**Not yet verified — stated plainly:** no real browser is available in this
environment (same constraint noted in this repository's earlier usability
pass), so the actual rendered pixel output — whether `drawImage`'s bottom-
anchor math looks right, whether the forest/dungeon tiles read as coherent
once laid out across the full map rather than as isolated 16×16 crops —
has not been visually confirmed. Everything above is static/data-level
verification (coordinates, dimensions, test assertions, HTTP responses),
not a screenshot.
