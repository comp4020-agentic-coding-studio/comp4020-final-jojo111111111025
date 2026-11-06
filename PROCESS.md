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

### Stage 2 — environmental props

Gave `drawObject()` the same sprite-then-fallback treatment Stage 1 gave
`drawTile()`, for the seven `ObjectKind`s (`tree`, `rock`, `bush`,
`campfire`, `dungeon_entrance`, `dungeon_exit`, `ancient_beacon`) — but only
where the already-committed packs actually contain a genuinely identifiable
match, not one sprite per kind regardless of fit. No new asset files and no
new license obligations: every sprite below comes from the three PNGs
Stage 1 already added, already covered by `public/assets/CREDITS.md`.

**Inspection method, before any coordinate was chosen:** a scratch,
never-committed pure-Node PNG decoder (zlib `inflateSync` + the standard
PNG filter-byte unfiltering, no dependency) read each tileset's raw RGBA
pixels directly — not a guess from a thumbnail. For every candidate region,
alpha-channel bounding boxes were computed pixel-by-pixel to find exact
sprite edges, then the crop was rendered back out as its own upscaled PNG
(with a transparency checkerboard) and viewed before any coordinate was
accepted. This caught real mistakes before they became code: an initial
pass misread a 544×512 forest canopy mass as containing individual
tree/bush sprites, until adjacent 16px-wide slices of it were cropped
side-by-side and turned out to be a near-identical repeating edge pattern —
terrain-style autotile art, not discrete objects. An initial altar-sprite
height of 33px (from a looser bounding-box scan) was also caught and
corrected to the true 32px by re-scanning alpha values row-by-row near the
boundary.

**What got a sprite, and why:**

- `campfire` → Calciumtrice dungeon tileset's "FIRE 16×6" section, a single
  16×16 flame frame on a transparent background. Unambiguous.
- `ancient_beacon` → the same sheet's "ALTARS" section: a statue on a stone
  pedestal, 16×32 (2 tile-rows), bottom-anchored like Stage 1's
  `dungeon_wall`. Chosen over the pack's wider 2-tile altar variant because
  every `MapObject` occupies one tile cell, and over the plain stone-block
  pedestal-only tiles because the statue reads unambiguously as something
  significant, which a flat pedestal wouldn't.
- `dungeon_entrance` → the same sheet's "DOORS+FENCES" section: one 16×32
  panel of a wooden double-door, complete with its handle, cropped from the
  pack's wider 4-tile-wide door art down to the single tile width every
  object actually occupies.
- `dungeon_exit` → the same sheet's "FLOOR STAIRS" section: a 16×32 stone
  staircase, visually and thematically distinct from the entrance's door
  (stairs out, vs. a door in) rather than reusing the same shape for both.

**What stayed on the existing flat-color fallback, and why — not a gap,
a documented decision:**

- `tree`: the ansimuz forest sheet paints its canopy as one continuous,
  overlapping mass across a ~544×512 region. Verified directly: cropping
  three adjacent 16px-wide vertical slices of it and viewing them
  side-by-side showed a near-identical repeating leaf-edge pattern, the
  signature of area-painted autotile art, not a discrete single-tree
  shape. No standalone tree sprite with its own transparent-background
  silhouette exists anywhere in either overworld sheet.
- `rock`: the mountain sheet's one boulder-shaped sprite sits on a fully
  opaque brown cave-floor background — confirmed by sampling its alpha
  channel directly — meaning it's one element of a painted interior scene,
  not a droppable prop with its own transparent silhouette. The sheet's
  cliff-face tiles are diagonal terrain-edge autotile pieces (same
  category as Stage 1's existing terrain use of this sheet), not a
  freestanding rock shape either.
- `bush`: the one cleanly isolated small plant sprite in either overworld
  sheet is a rose/flower pair (forest sheet, ~16×12, transparent
  background) — visually a flower, not a bush. Every other "bush-shaped"
  region found during inspection turned out, on close crop, to be either
  a fully-opaque dirt-patch ground tile with vegetation painted directly
  into it (not usable as a separate overlay) or the same repeating
  edge-autotile pattern found for `tree`. Labelling a flower sprite
  `bush` would misrepresent what it depicts, which the brief for this
  stage explicitly ruled out ("never force a sprite assignment just to
  satisfy coverage").

`src/client/sprites.ts`'s `OBJECT_SPRITES` doc-comment states this same
reasoning next to the code, so a future reader doesn't need to rediscover
it from this history.

**Files changed:** `src/client/sprites.ts` (new `OBJECT_SPRITES` export,
alongside Stage 1's `TERRAIN_SPRITES`), `src/client/render.ts`
(`drawObject()` tries a sprite first, falls back to the existing
`OBJECT_COLORS`, bottom-anchors anything taller than one tile the same way
`drawTile()` already does), `spec/object-sprites.spec.ts` (new).
`ObjectKind`, `SOLID_OBJECTS`, and every file under `src/server/` are
untouched — this stage is rendering-only, same separation Stage 1 kept
between terrain's visual sprite and `SOLID_TERRAIN`'s independent
collision set.

**Verification:** `pnpm typecheck` and `pnpm build:client` both clean.
`pnpm test` — 225/225 passing across 26 spec files (220 from before this
stage + 5 new in `spec/object-sprites.spec.ts`), 0 regressions. The built
`public/main.js` was grepped to confirm all four sprited kinds
(`ancient_beacon`, `campfire`, `dungeon_entrance`, `dungeon_exit`) are
actually present in the shipped bundle, not just the source file.
`node scripts/check-evidence.ts` passes. The dungeon tileset — the sheet
every Stage 2 sprite draws from — was re-confirmed serving
`200`/`image/png` from a locally-running instance, same check Stage 1 ran.

**Not yet verified — stated plainly, same caveat as Stage 1:** no real
browser is available in this environment, so none of this stage's actual
rendered pixel output has been visually confirmed — not the bottom-anchor
positioning of the three 32px-tall object sprites relative to the player
and surrounding tiles, not foreground/background layering against moving
players or enemies, not whether the chosen crops read correctly at actual
in-game scale rather than in an isolated upscaled crop. Everything stated
as "confirmed" or "verified" above is pixel-level data verification against
the source PNGs (alpha-channel bounding boxes, rendered-and-viewed crops of
the exact coordinates used) and automated test/build/HTTP checks — not a
screenshot of the running game. This distinction matters more for Stage 2
than Stage 1: Stage 1's sprites were ground-level tiles with little room for
a wrong read, while Stage 2 introduces this integration's first
taller-than-one-tile *object* sprites, where bottom-anchor math and
draw-order relative to the player are exactly the kind of thing only an
actual rendered frame can confirm.

### Stage 3 — player and enemy sprites

Gave the player and all three `EnemyKind`s (`wanderer`, `guardian`, `boss`)
a real sprite, replacing their plain coloured circles, using the same
sprite-then-fallback architecture Stages 1–2 already established. No new
asset files: every sprite comes from `dungeon/tileset.png`'s "CHARACTERS"
and "MONSTERS" sections, already covered by `public/assets/CREDITS.md`'s
existing CC-BY 3.0 block (one license for the whole file, not scoped to
specific regions — verified by re-reading that file's wording before
assuming it still applied).

**What got a sprite, with the exact verified coordinates:**

- Player → the "CHARACTERS" section's gray-armoured, unarmed character,
  `x=0, y=416, 16×32`.
- `wanderer` → the "MONSTERS 16×16" section's green slime, `x=48, y=464,
  16×16` — matched to its role as the weak, roaming trash mob
  (`WANDERER_MAX_HEALTH` is the lowest of the three).
- `guardian` → the "MONSTERS 16×32" section's leather-armoured orc/zombie,
  `x=208, y=464, 16×32` — matched to its tougher, mid-tier role.
- `boss` → the "MONSTERS 32×32" section's armed horned ogre, `x=320, y=464,
  32×32` — the largest, most visually distinct sprite in the pack, matching
  its role as the single beacon-guarding threat.

All four coordinates were independently re-verified against the source PNG
(alpha-channel bounding box per sprite, rendered as an upscaled
checkerboard crop, visually confirmed) before being written into
`sprites.ts` — not re-typed from a prior report without re-checking.

**What stayed exactly as planned, with no code-level surprises:**

- `ObjectKind`, `SOLID_OBJECTS`, `EnemyKind`'s three values, every file
  under `src/server/`, and all combat/movement/collision calculations are
  byte-for-byte untouched — confirmed by `git diff` showing zero changes
  outside `src/client/sprites.ts`, `src/client/render.ts`, and the new spec
  file. This stage is rendering-only, same separation Stages 1–2 kept.

**One real visual regression, found during review and fixed before
committing:** the previous player rendering used colour (`#ffd84a` yellow
for the local player, `#4ac6ff` blue for everyone else) as the only visual
cue for "which one is you." Switching every player to the same static
sprite silently dropped that distinction — flagged during this stage's
review rather than committed as-is. The fix, `drawPlayerMarker()` in
`render.ts`, draws a small flattened ellipse ("shadow") on the ground just
below each player's feet, filled with the same yellow/blue the old circles
used, keyed off the same `RenderPlayer.isLocal` field the fallback-colour
code already reads. The character sprite itself is completely unchanged —
the marker is a separate, deliberately subtle shape (roughly a third of a
tile wide, an eighth of a tile tall, drawn at 60% of the player's own
alpha) drawn on the ground after the character, so it reads as a ground
marking under the character rather than a second competing shape or
anything that could be mistaken for a new game object. `RenderPlayer`'s
field shape, `main.ts`'s data flow into it, and every other player-facing
behaviour (movement, networking, controls) are untouched — this is a
rendering-only fix to a rendering-only regression.

**Known limitations — documented here, not silently accepted:**

- **Every character/monster sprite is front-facing only.** The pack's
  "CHARACTERS" section has 15 variants; pixel-diffing every pair confirmed
  all 15 face the viewer, with no back/side art anywhere. A player moving
  up, down, left, or right still renders facing forward.
- **No walking, idle, attack, or death animation frames exist anywhere in
  this pack**, for the player or any monster — confirmed directly by
  pixel-diffing every visually-similar pair found during inspection (e.g.
  the two 32×32 ogre variants, the two 16×32 hooded-figure variants): every
  difference found was confined to a held-weapon region, never a pose or
  limb change. `CREDITS.md`'s pre-existing claim ("single static pose...no
  animation included") is independently confirmed at the pixel level by
  this stage, not merely cited.
- **Player and enemy sprites are therefore visually static** — a moving
  character glides without any leg or limb motion, matching the
  constraints above rather than a missed integration step.
- **The local-vs-remote player colour cue is preserved**, via
  `drawPlayerMarker()`'s small ground marker rather than the sprite itself
  — see above. Not a gap; the one thing this stage's review did require a
  code change for.
- **The pre-existing fixed render order (terrain → objects → buildings →
  enemies → highlights → players, no y-sort) remains completely
  unresolved**, exactly as flagged during Stage 2's review. This stage does
  not touch `render()`'s draw-order loop at all — confirmed by `git diff`
  showing no changes to that function's structure, only to `drawEnemy()`'s
  and the player loop's internals.
- **Larger, more detailed sprites make this layering gap more noticeable,
  not less.** The player is now a visually distinct 16×32 figure and the
  boss a 32×32 ogre — both occupy real screen space a flat 16–35px-diameter
  circle used to leave implicit. A player standing on the tile just above a
  guardian or the boss will now visibly, obviously render in front of it
  regardless of which one should be "in front" at that position — this was
  true in principle with circles too, but a human reviewer is far more
  likely to actually notice it with real character art. No renderer
  refactor (a y-sort pass) was attempted this stage, per the approved
  scope — this is a known, carried-forward limitation for a future stage
  to address, not something this one silently worked around.

**Files changed:** `src/client/sprites.ts` (new `PLAYER_SPRITES` and
`ENEMY_SPRITES` exports, alongside Stages 1–2's `TERRAIN_SPRITES`/
`OBJECT_SPRITES`), `src/client/render.ts` (the player-draw loop and
`drawEnemy()` both try a sprite first, fall back to the pre-existing
colour/circle code, bottom-anchor taller-than-one-tile sprites the same way
`drawTile()`/`drawObject()` already do; the player loop also calls the new
exported `drawPlayerMarker()` to restore the isLocal/remote colour cue),
`spec/character-sprites.spec.ts` (new) and `spec/player-marker.spec.ts`
(new — exercises `drawPlayerMarker()` directly against a minimal fake
`CanvasRenderingContext2D`, asserting the yellow/blue colour split, the
marker's below-the-feet position, its sub-tile size, and its reduced
alpha). No change to `src/client/main.ts`, `RenderPlayer`/`RenderEnemy`'s
field shape, `ObjectKind`, `SOLID_OBJECTS`, `EnemyKind`, or anything under
`src/server/`.

**Verification:** `pnpm typecheck` and `pnpm build:client` both clean.
`pnpm test` passing, 0 regressions (exact count in the commit message).
`node scripts/check-evidence.ts` passes. The built `public/main.js` was
grepped to confirm the new sprite coordinates are present in the shipped
bundle, not just the source file. `spec/player-marker.spec.ts`'s
colour-assertion tests were sanity-checked by deliberately swapping the
yellow/blue mapping in `drawPlayerMarker()` and confirming the suite
actually fails (2 of 5 tests red), then reverting — not just written and
trusted to be meaningful.

**Not yet verified — stated plainly, same caveat as Stages 1–2:** no real
browser is available in this environment, so none of this stage's actual
rendered pixel output has been visually confirmed — not whether the player
sprite's bottom-anchor position looks correct standing on actual terrain,
not whether the three enemy sprites read clearly at real gameplay zoom
alongside moving players, and most importantly, not how visually
disruptive the known render-order/occlusion gap actually looks once real
character art is on screen together. Everything stated as "confirmed" or
"verified" above is pixel-level data verification against the source PNG
(alpha-channel bounding boxes, rendered-and-viewed crops of the exact
coordinates used) and automated test/build/HTTP/bundle checks — not a
screenshot of the running game. This distinction matters most for this
stage of the three: Stage 3 is the first time this integration has
introduced sprites for entities that move and interact with each other in
real time, where facing, layering, and animation (or their absence) are
exactly the kind of thing only an actual rendered, interactive frame can
confirm.
