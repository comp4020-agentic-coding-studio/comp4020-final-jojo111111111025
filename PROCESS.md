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

### Stage 4 — visual asset completion and consistency

Researched filling four known flat-colour gaps (`water`, `tree`, `rock`
object, `bush`) with a supplementary CC0 pack, in two phases: an
inspection-only pass (Phase B1) before any asset entered the repo, then an
integration pass (Phase B2) for whatever survived that inspection.

**Phase B1 — asset research, nothing committed to the repo during this
phase.** Downloaded ansimuz's "Tiny RPG Fantasy" (also listed as "Tiny RPG
Town" — same pack, same author as this project's existing forest/mountain
sheets) via itch.io's legitimate free-download flow (`$0.00`, the pack's
own named-your-own-price tier), to a scratch directory outside this repo.
License confirmed from three independent sources, not inferred from the
author's name alone: itch.io's own structured "Asset license" metadata
field (`Creative Commons Zero v1.0 Universal`), the pack's own bundled
`public-license.pdf`, and the author's most recent direct reply to a
licensing question in the page's comment thread (an older, inconsistent
"CCBy 4" reply from years earlier was superseded by a later, explicit
"CC0" reply to a follow-up question about that exact inconsistency — both
replies read directly from the page, not summarised from memory).

Every candidate was decoded and visually inspected the same way every
sprite in this project has been — pixel-level bounding boxes, rendered
crops, no trust placed in thumbnails or filenames:

- **Water**: a river/pond scene exists in the pack's town tileset, with a
  genuine transparent background. Tiled at this game's 16px grid, though,
  its water-surface noise texture turned out to have a fixed ~10px repeat
  period — not a multiple of 16 — so no 16px crop of it tiles seamlessly.
  Tested three different crop offsets; the best one still produced a
  clearly visible diamond-grid repeat pattern when tiled at a scale
  approximating real gameplay zoom, confirmed by rendering the tiled
  result and viewing it, not estimating from the source texture alone.
  Scanned the rest of the free pack (town, cave, and both tech-lab
  tilesets) for any separate, purpose-built tileable water swatch; none
  exists. **Not used** — this didn't meet the bar for "no visible
  breakage," and the brief for this stage was explicit that failing that
  bar means stopping, not lowering the bar. `water` stays on its
  pre-existing flat-colour fallback.
- **Tree**: two genuinely standalone tree sprites exist (`tree-1.png`,
  `tree-2.png`), each with a real transparent background — unlike anything
  found in the originally-approved packs. But at their native resolution
  they are ~113x119 and ~102x140 px — roughly 7x7 and 6x9 *tiles* at this
  game's 16px grid, 6-7x larger than every other sprited object and the
  player (all 16x32 or smaller). Rendering one at native size would make a
  single tree many times larger than a building; shrinking it to fit the
  game's existing scale would blur hand-placed pixel art rather than show
  a genuine lower-resolution version of the same piece. **Not used** —
  `tree` stays on its pre-existing flat-colour fallback, a deliberate
  decision made after finding a real candidate and rejecting it on scale
  grounds, not a case of no candidate existing.
- **Rock** (the object, distinct from the already-sprited `rock` terrain):
  one standalone rock-like sprite exists in the pack's town tileset, but
  it reads as a warm beige/tan loaf-of-bread or dirt-clump shape, not a
  rock, and clashes with this project's existing grey-toned rock terrain
  (`TERRAIN_SPRITES.rock`, from the mountain sheet). **Not used** — same
  "found a candidate, rejected it on a real, stated ground" category as
  tree.
- **Bush**: two genuinely standalone green bush/conifer sprites exist
  (`bush-2.png`'s conifer shape chosen over `bush-1.png`/`bush-3.png`'s
  fern/vine shapes for a rounder, more conventional bush silhouette),
  unlike any candidate found in the originally-approved packs (which
  turned out to be a flower, or ground-attached dirt patches). At 25x30 px
  opaque bounding box (~1.6x1.9 tiles) its scale is close enough to this
  game's existing object scale not to clash the way the tree candidates
  did. **Used.**

**Phase B2 — integration of the one surviving candidate (`bush`).**

- `public/assets/tiny-rpg-town/bush-2.png` added — the original 30x32
  canvas from the free pack's `Assets/Environments/Vegetation
  props/bush-2.png`, copied byte-for-byte (MD5-verified identical to the
  downloaded source) with no re-encoding or pre-cropping; `sprites.ts`
  draws only this file's own opaque sub-region.
- `src/client/sprites.ts`: `SpriteRect.sheet` gained a fourth value,
  `"tiny-rpg-town"`; `OBJECT_SPRITES.bush` added at
  `{ sheet: "tiny-rpg-town", x: 3, y: 1, w: 25, h: 30 }` — this is the
  source file's own alpha-channel bounding box (found by scanning, not
  guessed), not the full 30x32 canvas, so no transparent padding is drawn.
- `src/client/render.ts`: `drawObject()` gained a horizontal-centring step
  (`destX = x - (rect.w - TILE_SIZE) / 2`), the one rendering change this
  stage made, because it was strictly necessary — bush is the first
  object sprite wider than `TILE_SIZE` (25px vs. every prior object
  sprite's exactly 16px), and without this, bush would render flush
  against the cell's left edge and visibly overflow past its right edge
  rather than sit centred in it (confirmed by simulating the pre-fix
  formula directly — not assumed). The existing vertical bottom-anchor
  formula was untouched; it already generalises to any height correctly
  (a fact this stage's own test suite update now states explicitly,
  correcting an earlier test that had over-stated it as "must be exactly
  32px").
- `spec/object-sprites.spec.ts` updated: the existing "has a sprite for
  the four kinds" test became five; the existing "tree/rock/bush all
  undefined" test dropped `bush`; a new exact-coordinate assertion and a
  new "wider than one tile" assertion were added for `bush`; the
  "every tall sprite is exactly 32px" test was corrected (not just
  patched to pass) to state the real constraint — the bottom-anchor
  formula works for any height, 32px was a coincidence of which sprites
  existed before bush, not an actual requirement — with bush's real 30px
  height asserted explicitly rather than excluded silently.
- `spec/object-sprite-anchoring.spec.ts` (new): exercises `drawObject()`'s
  sprite-drawing branch directly against a fake
  `CanvasRenderingContext2D`, with `sprites.ts`'s `getImage` mocked to
  return a truthy sentinel (the node test environment has no real `Image`
  decoder, so this is the only way to make `drawObject` actually take its
  `drawImage` branch under test, rather than silently fall through to the
  flat-colour path untested). Asserts: bush's horizontal centring lands at
  the exact expected offset; a tall sprite (`ancient_beacon`) still
  bottom-anchors correctly; an exactly-`TILE_SIZE`-wide sprite
  (`campfire`) gets no horizontal offset, confirming the new centring math
  is a true no-op for every sprite that predates bush. Sanity-checked by
  deliberately reverting the centring formula to `destX = x` and
  confirming the first test goes red, then restoring it — the same
  mutation-and-revert discipline every prior stage's new tests used.
- `public/assets/CREDITS.md`: new section for ansimuz's "Tiny RPG Town",
  documenting the source, the exact file and sub-region used, the
  three-source license verification above, and — explicitly — which of
  this same pack's other sprites (trees, the rock, the water scene) were
  evaluated and rejected, and why, so a future reader doesn't have to
  redo this research to find out those were considered and declined, not
  missed.

**Scale/placement verification without a browser.** This environment has
no headless browser available: `npx playwright install` succeeds in
downloading the Chromium binary, but launching it fails —
`chrome-headless-shell: error while loading shared libraries: libnspr4.so:
cannot open shared object file`, `libnss3.so`, `libnssutil3.so`, and
`libasound.so.2` are all missing. Installing them requires root
(`apt-get install`), and no passwordless `sudo` is available in this
container — attempting a password prompt or any system-level install was
out of this stage's approved scope, so this was not attempted. A
filesystem-wide search also confirmed no existing copy of these libraries
is present anywhere else on the machine to borrow instead. This is stated
plainly rather than worked around or silently skipped: **no real browser
screenshot of the running game exists for this stage.**

As a substitute (explicitly not equivalent to a browser screenshot, and
not claimed to be one), a scratch, dependency-free Python PNG
decoder/compositor replicated `render()`'s and `drawObject()`'s exact
pixel formulas — the same bottom-anchor and new horizontal-centring
arithmetic the real TypeScript code uses, not approximated — against the
actual committed asset files, to produce a composited frame showing bush
next to the player sprite, the wanderer (slime) enemy sprite, and the
campfire object sprite at their true relative scale. This confirmed: bush
renders centred in its cell (no left/right overflow bias), bottom-anchors
correctly (no floating), and sits in a visually coherent size class next
to the player and the game's other already-approved small sprites —
without claiming this is what the actual canvas-based renderer will
produce pixel-for-pixel, since it is a separate reimplementation of the
same formulas, not an execution of `render.ts` itself.

**Gameplay invariance.** `git diff --stat -- src/shared/ src/server/
src/client/main.ts src/client/net.ts` is empty — nothing under those paths
changed. `ObjectKind`, `SOLID_OBJECTS`, movement, collision, combat, AI,
and networking are untouched; `SOLID_OBJECTS.has("bush")` is asserted
`false` (unchanged) in the updated test suite. This stage's one
`render.ts` change (bush's horizontal centring) is additive to the
existing sprite-drawing branch and has no effect on any sprite that was
already exactly `TILE_SIZE` wide — confirmed by a dedicated test for
exactly that case, not assumed from reading the diff alone.

### Stage 5 — map ground tiles and a water/grass edge

Replaced the overworld's flat, low-saturation `grass` tile and the
long-standing flat-colour `water` fallback with sprites from a new pack,
then added a single verified edge-transition sprite so grass next to water
reads as a soft boundary rather than a hard colour cut.

**Asset research.** The brief asked for a brighter, more detailed,
"Stardew-Valley-adjacent" ground look, not the muted autumn palette
Stages 1–4's ansimuz/Calciumtrice packs share. Re-inspected the three
already-approved sheets first — confirmed (by decoding, not assuming) that
none contains a second grass tone or any open-water tile; the closest
candidate, ansimuz's own separate "Tiny RPG Adventure" pack (the upstream
source of this project's existing `forest/tileset.png`, confirmed
byte-identical by MD5), turned out to have only a hand-painted
pond/waterfall scene and oversized standalone objects, the same
Stage-4-documented problem repeating in a sibling pack. Chose LimeZu's
"Serene Village - revamped" (CC-BY 4.0, free, 16x16 grid) instead: a
brighter palette, a genuine RPG-Maker-style terrain sheet, and the same
"attribution required" licence category this project already handles for
Calciumtrice's pack.

**What got replaced, and what deliberately didn't:**

- `grass` → a textured interior cell from the new pack's terrain sheet,
  `x=48,y=0`. The old ansimuz tile is a flat, uniform olive-green; the new
  one has a two-tone checkerboard micro-texture, confirmed fully opaque
  (safe to tile with no transparency gaps) before being accepted.
- `water` → `x=224,y=224` from the same sheet — a genuinely solid interior
  water cell, unlike every water candidate evaluated in Stages 1 and 4
  (ansimuz forest/mountain had none at all; Calciumtrice's dungeon sheet
  had none; Tiny RPG Town's pond was a hand-painted scene fragment that
  produced a visible ~10px repeat when tiled). This is a genuine RPG-Maker
  autotile sheet, so its interior cells tile cleanly by construction —
  confirmed directly (opacity check, no transparency holes) rather than
  assumed from the sheet's format alone.
- `forest` and `rock` deliberately **kept their existing sprites**. The new
  pack has only one grass tone, with no separate darker "forest floor"
  variant — moving `grass` alone and leaving `forest` on the old tile keeps
  the two overworld biomes visually distinct, which was Stage 1's original
  design intent; mixing a bright new grass with an old sprite for `forest`
  would read as an inconsistent reskin, not a matched pair. `rock` wasn't
  evaluated against this new pack in this pass at all — no claim is made
  that no candidate exists there, only that none was looked for.

**A real technical limit found, not glossed over: hard edges everywhere
except one verified pair.** Placing the new grass and water tiles directly
adjacent (as the existing map generator already does, with no transition
tiles) produces a visible hard colour-to-colour cut at every terrain
boundary — confirmed by rendering an actual adjacency test, not assumed.
Addressing this took three attempts, the first two of which are recorded
here because they produced real, verified negative results, not because
they "almost worked":

1. **By-eye coordinate hunting on the terrain sheet.** Produced repeated,
   self-contradicting judgements about the same coordinates — a region
   confirmed as a clean edge tile in one crop looked wrong in the next
   because the sheet mixes genuine terrain boundaries with decorative
   details (a narrow dirt path cuts across several rows of the
   grass/sand region) that are easy to mistake for parts of the boundary
   shape itself when eyeballing a red-gridded crop. Abandoned as
   unreliable, not merely difficult.
2. **Full RPG-Maker A2 "47-shape blob autotile" support.** Researched the
   actual public format spec (a 16-tile-wide-by-12-tile-tall sheet of 32
   fixed "kind" blocks, each a quarter-tile composition of up to 48
   shapes). Checked this project's sheet against that geometry
   first — it does **not** match any valid tile size (`768×768` isn't
   `12×T` for any sheet width that's also `16×T`) — confirming the file is
   a hand-arranged "preview sheet" of scene fragments, not a
   standards-compliant A2 autotile grid. The public formula therefore
   cannot locate shapes in it; a full 47-shape implementation would mean
   manually identifying every corner/edge variant in a non-standard
   layout, repeating the same by-eye unreliability at far larger scale. A
   programmatic full-sheet scan (sampling all four 8x8 quadrants of every
   16x16 cell, classifying each quadrant by colour-distance to a grass/
   water/sand reference) found that **water/grass has exactly one
   quarter-pattern in the entire 768x768 sheet** — the single edge tile
   this stage uses — with zero corner variants anywhere. The same scan
   found six quarter-patterns for grass/sand, which looked promising, but
   every one was confirmed by direct visual crop to include stray
   decorative detail (the same dirt path, isolated patches) rather than a
   clean geometric corner shape. This is a verified property of the
   source art, not a search failure: the sheet is a hand-painted
   collection of scene fragments, and quarter-pattern matching alone
   cannot distinguish a genuine corner shape from decoration that happens
   to sit across a quadrant boundary.
3. **One verified direct-edge sprite, rotated four ways.** Accepted the
   single confirmed-clean water/grass sprite (`x=64,y=512`, a fully-opaque
   water-above/grass-below 16x16 split with no decorative noise) as the
   only transition this stage would ship, and made it cover all four
   compass directions with a single asset: `drawTile()` now checks a
   grass tile's four orthogonal neighbours (reading directly from the
   existing flat `zone.tiles` row-major array `render()` already has — no
   new data fetched) and, where a neighbour is water, draws the edge
   sprite rotated 0/90/180/-90 degrees to face that side, using the
   standard canvas translate-to-centre/rotate/restore recipe. Verified
   safe to rotate (the sprite has no asymmetric detail that a rotation
   would visibly mangle) by checking all four rotations against the
   source pixels with an independent script before trusting the browser
   code to do the same transform.

**What this does and does not fix, stated plainly:** a grass tile directly
adjacent to water now gets a soft, textured edge instead of a flat colour
cut, in whichever of the four directions the water actually is (including
multiple directions on the same tile, e.g. a narrow grass peninsula with
water on three sides). It does **not** produce a rounded corner where two
edges meet at a right angle — confirmed above that no corner asset exists
in this source file to draw there, so two rotated straight edges simply
meet at a hard right angle, visually better than a flat cut on two sides
but still a corner, not a curve. It does **not** cover any other terrain
pair — grass/rock, grass/forest, and rock/water all still draw a hard
edge; this one pair was the only one with a usable sprite, not a sample of
a larger planned set. Only grass tiles draw the overlay (checked
explicitly) — water tiles never draw it on their own side, so a boundary
is never double-painted from both tiles meeting there.

**Files changed:** `public/assets/serene-village/terrains.png` (new —
original 768x768 canvas, byte-identical to the downloaded source,
confirmed by MD5), `src/client/sprites.ts` (`TERRAIN_SPRITES.grass`/
`.water` repointed; new `WATER_GRASS_EDGE_SPRITE` export), `src/client/
render.ts` (`drawTile()` gained the `zone`/`row`/`col` parameters it needs
to read neighbours, plus the new `drawWaterGrassEdge()` helper and
`EDGE_ROTATION_FOR_NEIGHBOR` lookup; its one caller in `render()` updated
to match), `spec/sprites.spec.ts` (the stale "water has no sprite"
assertion corrected to its opposite, plus exact-coordinate checks for
`grass`/`water`), `spec/terrain-edge.spec.ts` (new), `public/assets/
CREDITS.md`, `README.md`.

**Verification:** `pnpm typecheck` and `pnpm build:client` both clean.
`pnpm test` — 252/252 passing across 30 spec files (245 from before this
stage + 7 new in `spec/terrain-edge.spec.ts`), 0 regressions. `node
scripts/check-evidence.ts` passes. The built `public/main.js` was grepped
to confirm the new asset path and sprite coordinates are present in the
shipped bundle. `curl -I` against a locally-running instance confirmed
`serene-village/terrains.png` serves `200`/`image/png`.
`spec/terrain-edge.spec.ts`'s bounds-check test was sanity-checked by
deliberately removing the neighbour bounds check in `drawTile()` and
confirming the suite actually fails (1 of 7 tests red, the bounds-check
test specifically), then restoring it — the same mutation-and-revert
discipline every prior stage's new tests used; the rotation math itself
was independently verified by simulating the exact
translate/rotate/sample transform in a separate script and visually
confirming all four directions before trusting the in-browser canvas
calls to do the same thing.

**Not yet verified — stated plainly, same caveat as every prior stage:**
no real browser is available in this environment (confirmed again this
stage: `npx playwright install` downloads a working Chromium binary, but
launching it fails on this container with missing system libraries —
`libnspr4.so`, `libnss3.so`, `libnssutil3.so`, `libasound.so.2` — and
fixing that needs root, which this environment doesn't grant
non-interactively; a filesystem-wide search confirmed no existing copy of
these libraries to borrow instead). So none of this stage's claims about
*in-game* appearance are a screenshot of the running game: every image
referenced during this stage's design process was produced by a
scratch, dependency-free Python PNG decoder/compositor replicating
`render()`'s and `drawTile()`'s exact pixel and rotation formulas against
the actual committed asset files — the same technique Stage 4 used for
the same reason — not an execution of `render.ts` itself. This matters
most for the one new thing this stage adds that no prior stage touched:
a runtime decision (which rotation to draw, if any) made per-tile from
neighbouring map data, rather than a fixed sprite-to-kind lookup — correct
behaviour here depends on the real map generator's actual terrain
layout meeting this logic at render time, which only an actual rendered,
interactive frame can confirm.

### Stage 6 — hit feedback and sound effects

Asked directly what would move this project closer to a commercial
game's feel, the single most-cited gap was that combat and action
outcomes read as pure number changes — a health bar ticking down, an
inventory count updating — with no other visible or felt reaction. This
stage closes that gap in two parts: client-side hit feedback (no new
assets, no protocol change) and a first pass of sound effects (new CC0
audio assets, wired to specific events).

**Hit feedback.** `drawEnemy()` tints an enemy white for a short window
right after a `combat.event` names it as the target (`RenderEnemy`'s new
optional `flashing` field, set from a per-enemy timestamp in `main.ts`,
never sent by the server). `render()` takes an optional screen-space
`shakeOffset`, applied to the camera origin so the whole scene — terrain,
objects, enemies, players, highlights — judders together; `main.ts` drives
it from a short decaying trigger: landing a hit shakes a little, a kill
shakes more, taking damage shakes a little too. The existing red
damage-flash overlay, previously triggered only on the instant a player
died, now fires on any health drop — dying is one instance of taking
damage, not a separate category of feedback.

**Sound effects.** New `src/client/audio.ts` module, same load-once,
fail-silently shape as `sprites.ts`'s image loading: a clip that hasn't
finished loading (or never loads) just doesn't play, nothing else in the
game blocks on it. `playSound()` clones the loaded `HTMLAudioElement`
before playing it, so two overlapping triggers of the same sound (e.g.
two gather hits landing close together) are both heard rather than the
second cutting the first off.

Eight CC0-licensed clips were downloaded and evaluated; seven are used:

- Combat: a sword-attack hit (StarNinjas) on landing a melee hit, a death
  sound (MrGrs) on the local player dying.
- Gathering and crafting: a coin-pickup sound (StarNinjas) on a successful
  gather, an interface confirmation chime (Kenney) on a successful craft
  or build, an interface open sound (Kenney) on opening a chest.
- Feedback: an interface error sound (Kenney) at the single place every
  rejected action already funnels through (`showActionFeedback`), so no
  rejection reason needs its own call site.
- Victory: an orchestral fanfare (cynicmusic, ~12s) on beacon activation.
  A second CC0 candidate — a shorter NES/chiptune-style fanfare
  (congusbongus) — was downloaded and compared directly (a local listening
  page serving both files) before this one was chosen.

Not used: the same sword pack's 10-variant "clash" sound effect (intended
for a block/parry mechanic this game doesn't have — downloaded and
evaluated, but nothing in the game's combat model gives it a place to
attach to) and a 10-sample footstep-loop set from Kenney's RPG Audio pack
(looping footsteps on a fixed cadence as the player moves is a real
feature, just a materially more complex one — timing a loop interval off
movement rather than firing once per discrete event — deliberately left
for a later pass rather than implemented half-way).

Every clip's licence was confirmed from the OpenGameArt page's own
structured "License(s)" field (all state CC0), with two packs (Kenney's
Interface Sounds, mirrored via OpenGameArt, and the original RPG Audio
pack also downloaded during this stage's research but not used) carrying
a second, independent confirmation: their own bundled `License.txt`
states the same thing in its own words. See `public/assets/CREDITS.md`
for the full per-file source, author, and licence text.

**Testing.** `spec/enemy-flash.spec.ts` and `spec/screen-shake.spec.ts`
exercise the new `drawEnemy`/`render()` branches against a fake
`CanvasRenderingContext2D`, the same technique every prior rendering
stage's tests use. `spec/audio.spec.ts` stubs the global `Audio`
constructor (`vi.stubGlobal`) with a fake class that records every
instance created and every `play()` call, rather than mocking
`src/client/audio.js` itself — this exercises `loadSounds()`/`playSound()`
as real code paths (which path maps to which clip, cloning before
playing, swallowing a rejected `play()` from a browser's
no-user-gesture-yet restriction) instead of asserting against a mock of
its own logic.

**Not yet verified:** the same browser limitation as every prior stage
(no working Chromium in this environment — see Stage 5's note for the
exact missing libraries) means none of this stage's audio or feedback
claims were confirmed by actually hearing/seeing them in a running
browser tab; they're confirmed by unit tests against fake
contexts/constructors instead, the same standard of evidence Stage 5
used for its rendering math.

### Stage 7 — a bigger overworld

Asked for a bigger ("infinite") map. A genuinely unbounded/streamed map
is a substantially larger change — the terrain generator's noise-and-blur
algorithm only works over a fixed, fully-materialised grid (its smoothing
pass reads every neighbouring cell, so it can't sample an arbitrary
far-off coordinate on demand the way a raw Perlin/Simplex function could);
the movement/collision code hard-clamps players to a fixed-size tile
array; resource-node depletion persistence assumes a known, finite set of
objects generated once at world creation; and the full tile grid is sent
to the client as one `world.snapshot` message on join/reconnect, with no
chunked/paginated loading. All four would need to change together for a
true streaming world. Asked which to do, the answer was the simplest
option: keep the existing fixed-grid architecture entirely as-is, just
make the fixed grid itself bigger — no new systems, same generation
algorithm, same wire protocol shape.

`MAP_WIDTH`/`MAP_HEIGHT` went from 64x64 to 128x128 (4x the area). Checked
before committing to the new size: generation time barely moves (11ms at
64x64, 11ms at 128x128 — the algorithm is linear in cell count, not
exponential), and the full `world.snapshot` payload — the thing that
actually scales with map size, since it's sent whole on every join/
reconnect — grows from ~113KB to a measured 430KB over a real connection,
still a reasonable one-time payload for a message sent only on join or
reconnect, not per tick. Dungeon size, enemy spawn positions, dungeon
entrance placement, and every other system are unaffected — they're
either already computed relative to the map's own dimensions
(`findDungeonEntrance`'s "pick the furthest rock tile from the campsite"
heuristic) or structurally independent of overworld size (the dungeon is
always a fixed 16x16 regardless of overworld dimensions).

**A real test bug this exposed, not a game bug.**
`spec/dungeon-terrain.spec.ts`'s border-wall-collision test used to walk a
player from spawn to the dungeon entrance with a deliberately naive
walker — "always step toward the target," no obstacle-avoidance, driven
entirely through real `Room.tick()` calls to exercise genuine
collision. At the old 64x64 size this always happened to find a clear-
enough path; at 128x128, the real seeded terrain generator produced a
large enough contiguous rock/water formation between spawn and a
far-flung dungeon entrance that the naive walker could wedge itself into
a concave pocket — blocked on every tried axis at once — and never
escape, confirmed by letting it run for 10,000+ ticks with no progress.
This is a limitation of the test's own toy walker, not of the actual
collision logic (`isBlocked`/`isCellBlocked`), which was never in
question — every other test in this file, including the one that
positively asserts the wall actually blocks movement, still passed. Fixed
by giving this one test the same kind of small, synthetic, all-grass
overworld fixture `zone.spec.ts`'s tests already use instead of the real
procedurally-generated terrain, with the dungeon entrance placed right
next to spawn — it still exercises the real generated dungeon (pulled
from a throwaway tiny `generateWorldMap()` call, since the dungeon's
dimensions don't depend on the overworld's), just without depending on a
specific seed's terrain layout being navigable by a non-pathfinding
walker.

### Stage 8 — pickup/craft/visit toasts and a fuller intro

Asked for a visible toast when the player picks something up, crafts
something, or visits a new zone (the dungeon/overworld), and a proper
game introduction on the join screen.

**Unified toast.** `showActionFeedback` was already the one place every
rejected action surfaces a message (a small toast near the top of the
screen, auto-dismissing after 2.2s) — it just never fired for anything
that succeeded. Rather than building a second notification system, it
now takes success messages too: a green-tinted variant (`.ok`, alongside
the existing red `.err`) for a positive confirmation, so a success and a
rejection are visually distinct at a glance without needing separate
styling.

Three events now route through it:

- **Gather.** The server's gather result doesn't say which resource kind
  was granted — `objectRemaining` is the only signal that this was a
  gather at all (see Stage 6's object-depleted-sync work for how that
  signal was established). The specific item is derived client-side by
  diffing the post-gather inventory against a pre-update snapshot
  (`findGainedItem`, extracted into `net.ts` — the same "pure logic out
  of main.ts's DOM-bound closure, into the one client module with no
  top-level DOM code" move Stage 6 used for `applyObjectDepleted`, for
  the same reason: `main.ts` can't be imported in this project's node
  test environment).
- **Craft/build.** Already had its own message in the crafting panel's
  own small text line (`craftFeedbackEl`); now also surfaces the same
  "Crafted/Placed {name}." line as a toast, so the confirmation isn't
  only visible to someone looking at the crafting panel specifically.
- **Zone transition (dungeon entrance/exit).** Unlike gather and craft,
  a successful `zone.enter` carries no distinguishing field at all in its
  `action.result` — not even an echo of which zone it entered. Rather
  than add a new server field for this, the client tracks the one
  zone-transition request it has in flight (`pendingZoneEnter`: the
  `requestId` it just sent and which zone it was headed to) and matches
  the result's `requestId` against it when the reply arrives, clearing
  the pending state either way (success or rejection) so a failed
  attempt doesn't leave a stale pending transition around to falsely
  match a later, unrelated result.

**Game introduction.** The join screen's one-line summary became a short
paragraph: the two-to-four-player premise, the day/night gather-craft-farm
loop, and the dungeon-boss-beacon win condition — matching what
`README.md`'s own opening paragraph already says, so the in-game and
repository descriptions of the game stay consistent with each other.

**Testing.** `spec/pickup-feedback.spec.ts` covers `findGainedItem`
directly (which kind wins when exactly one increases, when nothing
increases, when a count decreases without anything increasing, when a
craft's consumed input and granted output change in the same inventory).
The toast's own DOM behaviour (CSS class toggling, the show/hide timer)
isn't separately unit-tested — `main.ts` can't be imported in this
project's test environment for the same browser/DOM reasons recorded in
Stage 6's testing note, and `showActionFeedback`'s class-toggle logic is
a few straightforward lines already covered by the project's standing
"no real browser available" caveat below, not a new testing gap this
stage introduced.

**Not yet verified:** the same browser limitation as every prior stage —
neither the toast's actual on-screen appearance (timing, color, overlap
with other HUD elements) nor the join screen's new paragraph's text
wrapping at the box's fixed width were confirmed in a real rendered
browser tab.

### Stage 9 — a more visible action toast, and continuous background music

Asked for two things: the pickup/craft/visit toast from Stage 8 wasn't
visible enough, and the game needed background music playing continuously.

**More visible toast.** Stage 8's toast had no border/shadow, a 13px font,
centred text with the default `translateX` transform, and a 2.2s
auto-dismiss — easy to miss against the busy game canvas behind it. Made
it a genuinely separate object from the HUD clutter around it: larger
text (18px, semi-bold), a visible border and drop shadow so it reads as
a popup rather than a label, a short pop-in animation (scale + fade,
0.18s) on every new message rather than an instant opacity snap, and a
longer 3.2s dismiss. Re-showing the same element while a previous message
is still visible now forces a reflow between removing and re-adding the
`show` class, so a second message in quick succession still visibly
"lands" with its own animation instead of silently swapping text on an
already-fully-opaque element.

**Continuous background music.** `audio.ts` grew `startBgm()`/
`setBgmZone()` alongside the existing one-shot `playSound()`: one
long-lived, looping `<audio>` element per zone (overworld, dungeon)
rather than cloning a node per play the way SFX do, since there's only
ever one BGM track playing at a time. `startBgm()` is called from the
join button's click handler — the page's first guaranteed user
gesture, which is what the browser's autoplay-after-gesture restriction
requires before `play()` will actually produce sound (the same
restriction `playSound` already works around by simply swallowing a
rejected `play()` before that point).

Two tracks, both CC0, chosen after downloading and directly comparing
three overworld candidates on a local listening page: a calm ambience
(TinyWorlds' Forest Ambience) for the overworld — chosen over a dreamier
synth-pad option and an upbeat chiptune option specifically because it's
meant to loop for an entire play session and shouldn't become
attention-grabbing or wearing — and a cave/wind atmosphere (JaggedStone's
Loopable Dungeon Ambience) for the dungeon, switched in and out as the
player crosses the zone boundary.

**A real pre-existing bug found and fixed while wiring zone-based
playback, not something this stage set out to look for.** Implementing
"switch BGM when the player's zone changes" required knowing, client-
side, when the local player's zone actually changes — and tracing that
turned up a genuine gap: after a successful `zone.enter`, nothing in the
wire protocol ever told the client its own zone had changed.
`action.result` for a `zone.enter` carries no zone field at all (just
`ok`/`reason`), and the periodic `player.state` tick (the only other
per-player update after the initial join) doesn't send a `zone` field
either (confirmed against both `messages.ts`'s schema and a live
connection's actual message stream). `localZone` was only ever set once,
in `onSnapshot` — which only fires on join or reconnect. In a real
browser, a player who walked into the dungeon would keep seeing (and
server-side range checks would keep validating against) the overworld's
objects and terrain until they happened to disconnect and rejoin; this
had been masked because every existing automated test for zone
transitions checks `server.room.getPlayer(...).zone` directly, never the
browser client's own `localZone`. Fixed by having the zone-transition
success handler (which already has the target zone on hand via
`pendingZoneEnter`, added in Stage 8 for the toast message) update
`localZone` and the local player's own entry in the `remotePlayers` map
directly — the same place that now also triggers the BGM zone switch.

**Testing.** `spec/audio.spec.ts` gained a `startBgm`/`setBgmZone`
section (one looping instance per zone, idempotent on repeated
`startBgm()` calls, switching pauses the old track and resets its
position to the start, switching to the already-playing zone is a no-op,
a rejected `play()` is swallowed) — the fake `Audio` class gained `loop`,
`currentTime`, and a real `paused` flag toggled by `play()`/`pause()` to
support these assertions, the same incremental-extension approach the
fake has had since Stage 6.

**Not yet verified:** the same browser limitation as every prior stage —
neither the toast's new visual prominence nor the music's actual audible
handoff between zones were confirmed in a real browser tab; both are
confirmed by code review and the unit tests above.

### Stage 10 — nightfall spawns extra, tougher wanderers

Asked to make night actually harder. Before this stage, "night" only ever
meant one thing: the map's fixed four wanderers, who are passive and
don't aggro at all by day, start chasing players after dark — their
count, speed, aggro range, and respawn time were otherwise identical to
the (non-existent) daytime behaviour. Everything else — guardians, the
boss, resource nodes, the map itself — was and remains completely
unaffected by time of day.

Picked, from several options, the specific combination of: more
wanderers, a wider aggro/leash range once already engaged, and faster
respawns, with exact numbers given directly rather than proposed and
confirmed (10 extra wanderers; 2x aggro/leash range; a near-player
movement speed of 3.5 tiles/sec, just under the player's own 4;
15-second respawn instead of the standard 30).

**Mechanism.** `Room.tick()` now tracks `wasNight` (a plain boolean field,
compared each tick against the freshly-computed `isNight()`) to detect
the dusk/dawn *edge*, not just the current state — spawning/despawning
exactly once per transition rather than every tick. At the dusk edge,
`spawnNightWanderers()` adds `NIGHT_WANDERER_COUNT` (10) extra wanderers
in a deterministic ring 12 tiles around the campsite (the same
fixed-offset-ring approach `map.ts`'s `enemySpawnsFor` already uses for
the base roster, just computed at runtime instead of world-gen time,
since these are transient, in-memory-only enemies that are never
persisted — see `EnemyState`'s existing persistence note). At the dawn
edge, `despawnNightWanderers()` removes every one of them outright —
dead or alive, win or lose, no loot or kill credit either way — rather
than letting them linger as another set of permanently-present enemies.
A new `nightOnly` flag on `EnemyState` is what makes an enemy eligible
for this removal and for the faster `WANDERER_NIGHT_RESPAWN_MS` (never
set on the map's original fixed roster, which keeps the standard
`ENEMY_RESPAWN_MS` even at night).

The speed/aggro/leash boost applies to every wanderer, fixed-roster and
night-only alike, for as long as it's night — `tickEnemy`'s existing
`isWanderer`/day-passivity branch gained a `wandererNight` flag that
swaps in `WANDERER_NIGHT_SPEED_TILES_PER_SEC` /
`WANDERER_NIGHT_AGGRO_RANGE_TILES` / `WANDERER_NIGHT_LEASH_RANGE_TILES`
in place of the day constants; by day, or for guardians/the boss, nothing
changes. The existing campfire safe-radius check (`isNearSafeCampfire`)
still applies uniformly to every wanderer the same way it always did —
night-spawned wanderers get no special exemption from it, and no special
bypass either.

No protocol, persistence, or client change was needed: enemies have
always been purely in-memory simulation state (`EnemyState` is explicit
about never being persisted per-tick), and the client already reconciles
its own enemy list against the server's current roster every
`player.state` tick (adding new IDs, dropping ones that vanished) —
exactly the mechanism a dead enemy already used, now also covering one
that was removed outright rather than killed. `EnemyView` (what actually
crosses the wire) gained no new field; `nightOnly` is a server-internal
implementation detail the client has no reason to know about.

**A real risk checked for, not assumed away: existing tests that advance
a fake clock by large amounts.** Several pre-existing combat tests
advance an injected clock by multiples of `ENEMY_RESPAWN_MS` (30s) to
test respawn timing — nowhere close to `DAY_DURATION_MS` (5 minutes), so
none of them accidentally cross into a night this stage's new spawn
logic would react to. Checked directly rather than assumed, since a
silent night-transition partway through an unrelated test would have
been exactly the kind of flaky, hard-to-diagnose failure worth ruling
out up front.

**Testing.** `spec/night-difficulty.spec.ts` (new) covers: the exact
count of wanderers added at the dusk edge; that they land within map
bounds and aren't all stacked on one point; that spawning only happens
once per night, not every tick; that every night-only wanderer vanishes
at the dawn edge whether still alive or already dead (confirmed by
actually killing one via the real `attack()` path, then advancing past
dawn); that a wanderer's measured movement speed during a one-second
night-time chase matches `WANDERER_NIGHT_SPEED_TILES_PER_SEC`, not the
day constant; and that `maxHealth` is untouched (only
speed/range/respawn-time scale, never raw health or damage). Three of
these tests were deliberately run against a mutated (broken) version of
the spawn/despawn/speed logic first, confirming each one actually fails
when the feature is broken, not just when asked to pass — the same
mutation-and-revert discipline every prior stage's new tests have used.

**Not yet verified:** the same browser limitation as every prior stage —
whether a real player actually perceives the extra wanderers, the wider
aggro range, and the faster respawns as "night is harder" (as opposed to
each number independently being correct, which the tests above do
confirm) was not observed in a running client.
