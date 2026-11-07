# Last Shelter

A browser-based, top-down 2D cooperative survival/crafting game. One to four
players share one authoritative world over WebSockets: gather resources,
craft tools and buildings, farm, fight off wanderers and a boss, and
activate a beacon together to win.

## Run it

```sh
pnpm install
pnpm approve-builds --all   # allows better-sqlite3's native build + esbuild
pnpm build:client
pnpm dev                    # starts the server on :8080
```

Open `http://localhost:8080`. You'll land on a join screen — enter a name
and the room code shown (defaults to `LAST-SHELTER`; override with the
`ROOM_CODE` env var). Refreshing the page or closing/reopening the tab
within 5 minutes reconnects you as the same player with your inventory,
health, and position intact, via a signed, httpOnly identity cookie the
server issues on first load.

- WASD/arrow keys move; `E` gathers from a nearby resource node or
  interacts with a dungeon entrance/exit, depending on what's in range;
  `Space` attacks the nearest adjacent enemy.
- The crafting panel (bottom right) lists every recipe with its cost; the
  "Craft" button is disabled client-side when you can't afford it, but the
  server re-validates every request regardless.
- The building section of the same panel places a building directly in
  front of you; `C` opens the nearest shared storage chest.
- Standing near a farm plot shows plant/water/harvest buttons for its
  current stage.
- A day/night cycle (derived from elapsed wall-clock time, never a stored
  "current phase") brings out aggressive wanderers at night; a dungeon
  holds a telegraphed boss fight. Defeating the boss and depositing enough
  wood, stone, and the boss's ancient core at the beacon activates it —
  the room's shared win condition.
- The player list at the top shows everyone in the room and whether
  they're connected or just holding their slot during a reconnect grace
  window.

## Identity and authorization

A player is a browser holding a signed `ls_id` cookie (httpOnly,
`SameSite=Lax`, 30-day expiry, rotated after 7 days, HMAC-SHA256 tagged
with a secret generated once and persisted server-side) — there is no
account, login, or password. A missing, tampered, expired, or revoked
cookie is never partially trusted: it's treated like no cookie at all,
and a fresh anonymous identity is minted instead. Every mutating action
(gather, craft, build, farm, attack, deposit, activate) is revalidated
server-side against that verified identity — range, cooldown, zone, and
ownership are never taken on the client's word. See
[`docs/adr/001-anonymous-identity.md`](docs/adr/001-anonymous-identity.md)
for the full reasoning and verification evidence.

## Check it

```sh
pnpm typecheck
pnpm test
```

## Architecture

- `src/shared/` — types, constants, the map generator, the recipe
  registry, the pure day/night and crop-growth functions, and the
  Zod-validated WebSocket message schemas shared by client and server.
- `src/server/` — `db.ts` (SQLite + migrations), `identity.ts`
  (signed-cookie minting/verification, revocation), `world.ts`
  (state load-and-persist, pending-reward claiming), `room.ts` (the
  authoritative simulation — movement, combat, dungeon, beacon), `net.ts`
  (WebSocket dispatch, room/player-cap enforcement, reconnect handling,
  rate limiting, structured logging), `index.ts` (HTTP server: identity
  cookie, static files, `/readme/`, the `/ws` upgrade).
- `src/client/` — vanilla TypeScript, Canvas 2D rendering, native HTML UI.
- `spec/` — Vitest unit and full wire-protocol integration tests (`spec/
  helpers/server-harness.ts` spins up a real HTTP+WS server per test
  against a temp SQLite file) covering movement, gathering, crafting,
  building, farming, combat, day/night, dungeon zoning, beacon victory,
  reconnect, room limits, and cross-room isolation.

## Art

The overworld's grass and water use LimeZu's Serene Village - revamped
(CC-BY 4.0); its forest ground and mountain terrain use ansimuz's Tiny RPG
Forest and Mountain tilesets (CC0); the dungeon uses Calciumtrice's Dungeon
Tileset (CC-BY 3.0); bushes use a sprite from ansimuz's separate Tiny RPG
Town pack (CC0). Full credits and license text are in
[`public/assets/CREDITS.md`](public/assets/CREDITS.md). Terrain and most
objects (campfires, the ancient beacon, dungeon entrances/exits, bushes)
are sprited; trees and the rock object render as flat colour — not because
no candidate asset was ever found, but because every one found was
rejected on a concrete ground: a scale mismatch 6-7x this game's existing
objects for trees, a colour/style mismatch for the rock. A grass tile next
to water draws a soft, rotated edge sprite instead of a hard colour cut;
every other terrain boundary (grass/rock, grass/forest, rock/water) still
draws as a hard edge, and even the water/grass edge stops at a straight
line — there's no rounded-corner variant, because none exists in the
source art (confirmed by a full programmatic scan, not just unsearched).
See `PROCESS.md`'s Stage 2, Stage 4, and Stage 5 sections for the full
per-asset reasoning. The player and all three enemy
kinds also use sprites from the dungeon tileset. These are single static
poses with no walk/attack animation and no facing variation — a moving
character doesn't visibly animate or turn. The local player is still told
apart from everyone else the same way it always was — by colour — via a
small yellow/blue marker on the ground beneath each player's feet, since
the shared character sprite itself carries no colour of its own; see
`PROCESS.md`'s Stage 3 section for the full reasoning.

Landing a hit flashes the enemy white and shakes the screen; taking damage
flashes the screen red and shakes it too. Seven CC0 sound effects (combat,
gathering, crafting, chest, errors, and a beacon-activation victory
fanfare) play at their matching moments — see `PROCESS.md`'s Stage 6
section for which clip plays on which event and why two evaluated clips
(a sword-clash sound with no mechanic to attach to, and a footstep-loop
set) aren't used yet.

## Persistence

Everything survives a restart: the world seed and resource depletion,
buildings, chest contents, farm plot timestamps, each identity's
inventory and health, boss-defeated/beacon state, and any pending reward
owed to a player who was evicted before a reward landed.
