# Last Shelter

A browser-based, top-down 2D cooperative survival/crafting game. One to four
players share one authoritative world over WebSockets: gather resources,
craft tools and buildings, and fight off wanderers, guardians, and a boss.
**The goal is to kill every enemy on the map** — once the last one falls,
the room wins together.

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

- Dying costs everything you'd built up: the instant your health reaches
  zero, your inventory is emptied and every building you placed (walls,
  floors, campfires, workbenches, chests — chest contents included) is
  removed from the shared map for good. Respawning at the campsite restores
  full health, and also resets every enemy on the map — including any
  you'd already killed — back to full health at its spawn point: a death
  sends the whole shared fight back to the start, not just you. There's no
  grace period and no way to recover what was lost. This applies however
  you died — a wanderer's bite, the boss's slam, anything that brings your
  health to 0.

- WASD/arrow keys move; `E` gathers from a nearby resource node; `Space`
  attacks the nearest adjacent enemy; `H` uses a bandage from your
  inventory.
- Crafted tools aren't equipped — holding one in your inventory is enough
  for its effect to apply automatically. A sword adds `SWORD_BONUS_DAMAGE`
  to every attack; an axe doubles wood yield per gather (from a tree); a
  pickaxe doubles stone yield per gather (from a rock). Every tool has
  limited durability: each gather/attack it actually boosts counts as one
  use, and after `TOOL_DURABILITY_USES` (10) it breaks and is removed from
  your inventory — craft another to keep the bonus going. A bandage (made
  from berries) is a consumable: pressing `H` with at least one in your
  inventory spends it to restore `BANDAGE_HEAL_AMOUNT` health, capped at
  full health.
- The crafting panel (bottom right) lists every recipe with its cost; the
  "Craft" button is disabled client-side when you can't afford it, but the
  server re-validates every request regardless.
- The building section of the same panel places a building directly in
  front of you, with a coloured ring on the map showing exactly which cell
  before you click — green if it's free, orange if something's already
  there; `C` opens the nearest shared storage chest.
- A day/night cycle (derived from elapsed wall-clock time, never a stored
  "current phase") darkens the screen and, since enemies chase
  unconditionally from the moment they exist, gives wanderers (not
  guardians or the boss) a real edge at night: they move 50% faster for
  the night's duration, then drop back to their normal speed at dawn.
- The boss chases like any other enemy, but plants itself the instant it
  starts telegraphing: it holds still through the windup, then hits every
  player within range when the hit lands, and only resumes the chase once
  its cooldown ends.
- Killing every enemy on the map wins the room. The victory screen's "Play
  Again" button (any connected player can press it) revives every enemy —
  dead or alive — back to full health at its spawn point and clears the
  victory screen for everyone in the room, so a won room can be replayed
  without a server restart. It doesn't touch players: health, position, and
  inventory are left exactly as they were at the win.
- The player list at the top shows everyone in the room and whether
  they're connected or just holding their slot during a reconnect grace
  window.
- A toast near the top of the screen confirms a gather ("Gathered
  wood.") or a craft/build ("Crafted axe.") — green for a success, red for
  a rejection.
- Background music plays continuously: a calm overworld ambience, the only
  track since there's a single shared map, not separate zones.

## Identity and authorization

A player is a browser holding a signed `ls_id` cookie (httpOnly,
`SameSite=Lax`, 30-day expiry, rotated after 7 days, HMAC-SHA256 tagged
with a secret generated once and persisted server-side) — there is no
account, login, or password. A missing, tampered, expired, or revoked
cookie is never partially trusted: it's treated like no cookie at all,
and a fresh anonymous identity is minted instead. Every mutating action
(gather, craft, build, chest transfer, attack, bandage use, respawn) is
revalidated server-side against that verified identity — range, cooldown,
and ownership are never taken on the client's word. See
[`docs/adr/001-anonymous-identity.md`](docs/adr/001-anonymous-identity.md)
for the full reasoning and verification evidence.

## Check it

```sh
pnpm typecheck
pnpm test
```

## Architecture

- `src/shared/` — types, constants, the map generator, the recipe
  registry, the pure day/night function, and the Zod-validated WebSocket
  message schemas shared by client and server.
- `src/server/` — `db.ts` (SQLite + migrations), `identity.ts`
  (signed-cookie minting/verification, revocation), `world.ts`
  (state load-and-persist), `room.ts` (the authoritative simulation —
  movement, gathering, crafting, building, combat, enemy AI, death/respawn,
  the win condition), `net.ts` (WebSocket dispatch, room/player-cap
  enforcement, reconnect handling, rate limiting, structured logging),
  `index.ts` (HTTP server: identity cookie, static files, `/readme/`, the
  `/ws` upgrade).
- `src/client/` — vanilla TypeScript, Canvas 2D rendering, native HTML UI.
- `spec/` — Vitest unit and full wire-protocol integration tests (`spec/
  helpers/server-harness.ts` spins up a real HTTP+WS server per test
  against a temp SQLite file) covering movement, gathering, crafting,
  building, chest transfer, combat, enemy pathfinding, day/night, death and
  respawn, the victory/play-again cycle, reconnect, room limits, and
  cross-room isolation.

## Art

The overworld's grass and water use LimeZu's Serene Village - revamped
(CC-BY 4.0); its forest ground, mountain terrain, and the `rock` object use
ansimuz's Tiny RPG Forest and Mountain tilesets (CC0); enemy, player,
chest, and workbench sprites come from Calciumtrice's Dungeon Tileset
(CC-BY 3.0, used here purely as an art source — the game has no separate
dungeon zone); bushes use a sprite from ansimuz's separate Tiny RPG Town
pack (CC0). Full credits and license text are in
[`public/assets/CREDITS.md`](public/assets/CREDITS.md). Terrain and most
objects (campfires, rocks, bushes) and all four non-campfire building
kinds (wall, floor, workbench, chest) are sprited; the tree object alone
still renders as flat colour — every candidate asset found was rejected on
a concrete ground (a scale mismatch 6-7x this game's existing objects). A
grass tile next to water draws a soft, rotated edge sprite instead of a
hard colour cut; every other terrain boundary (grass/rock, grass/forest,
rock/water) still draws as a hard edge, and even the water/grass edge
stops at a straight line — there's no rounded-corner variant, because none
exists in the source art. See `PROCESS.md` for the full per-asset
reasoning. The player and all three enemy sprites are single static poses
with no walk/attack animation and no facing variation — a moving character
doesn't visibly animate or turn. The local player is still told apart from
everyone else the same way it always was — by colour — via a small
yellow/blue marker on the ground beneath each player's feet, since the
shared character sprite itself carries no colour of its own.

Landing a hit flashes the enemy white and shakes the screen; taking damage
flashes the screen red and shakes it too. Seven CC0 sound effects (attack,
death, gathering, crafting, chest, errors, and a victory fanfare on
killing the last enemy) play at their matching moments — see
`PROCESS.md` for which clip plays on which event.

## Persistence

Everything survives a restart: the world seed and resource depletion,
buildings and chest contents, and each identity's inventory and health.
A building removed by its owner's death is deleted from storage the same
instant it's removed in memory, not just hidden client-side — a restart
right after a death never brings it back.

The instant the last connected player disconnects, every gatherable node
on the map restocks back to its max yield — a shared map nobody's actively
playing on doesn't stay picked over for whoever joins next. Players who
are mid-reconnect (still holding their room slot through the grace window)
don't count as connected for this check; only an open socket does.
