# Process overview

## 1. From a shared pixel wall to an authoritative game server

This repository's crit-8/9/10 history belonged to a different project, The Wall — a shared pixel wall where a brick landed in the next empty cell, protected from concurrent double-placement by a `PRIMARY KEY (x, y)` constraint ([crit-8](https://github.com/comp4020-agentic-coding-studio/comp4020-final-jojo111111111025/blob/a32a09853ad77da2cad9826a12011d5543e6826a/reflections/crit-8.md), [crit-9](https://github.com/comp4020-agentic-coding-studio/comp4020-final-jojo111111111025/blob/38c8fa5896e47b9f897d9a0ea6fdee32ebcc6190/reflections/crit-9.md), its [concurrent-placement](https://github.com/comp4020-agentic-coding-studio/comp4020-final-jojo111111111025/blob/54bcdcf975f5c39f3be62b74da563f2fbbeebfd6/docs/adr/001-concurrent-brick-placement.md) and [anonymous-identity](https://github.com/comp4020-agentic-coding-studio/comp4020-final-jojo111111111025/blob/41ddd3fc6135521ba443ca390b5d1479716bca04/docs/adr/002-anonymous-identity.md) ADRs). The final brief asked for something structurally different — several players moving, fighting, and building in one shared world at once — so rather than ask the agent to stretch that one-request-one-row server toward a new shape, it was directed to scaffold Last Shelter as a separate project, phase by phase, each phase's exit criteria stated up front rather than left for the agent to infer. It was integrated onto this repository's preserved history afterward, which is why `main` still opens with The Wall.

## 2. Stack, and why

TypeScript throughout; `ws` for the WebSocket transport; `better-sqlite3` for synchronous, file-backed persistence; `zod` for wire-message validation; Vitest for unit and full wire-protocol integration tests. The client is vanilla TypeScript on Canvas 2D with native HTML UI — no framework, since the real complexity sits server-side, not in client UI state. The deploy target is one shared-cpu-1x Fly machine, 256 MB of memory, one mounted volume, no reachable database server — a budget that rules out anything needing its own process for a routine check.

`better-sqlite3`'s synchronous API over an async driver, and a signed cookie over a server-side session table, were weighed the way The Wall's own identity ADR already had: each alternative trades one guarantee (atomicity, unforgeability) for a round trip or a table to prune, when the in-process alternative gives the same guarantee for free. Concretely, building placement races two players against the same cell:

![Two players place the same building at once; the in-memory Room approves both in the same tick, so SQLite's UNIQUE(x,y) constraint on the second INSERT is what actually picks the winner, rolling the loser back with no disk write and no materials spent](docs/evidence/concurrent-placement.svg)

Both requests pass the in-memory range/materials/occupancy check in the same tick — there is no earlier point at which "the cell's free" could be told apart between them. The constraint, not a re-check step, is what actually decides it, which is why no lock or queue sits in front of placement.

## 3. Where a passing suite described the wrong server

Development ran in four scoped phases, each gated by its own spec files before the next was authorised: Phase A — seeded map, movement, gathering; Phase B — inventory, crafting, building, farming; Phase C — signed identity and reconnect; Phase D — survival, day/night, combat, a dungeon, a beacon win condition. Each phase's suite ran against a real HTTP+WS server, not mocks, so a pass meant the wire protocol worked, not just an internal function — the agent wasn't trusted to self-report "it works."

That discipline still let one phase's suite pass for the wrong reason. Rather than take Phase C's green run at face value, an audit was commissioned of in-memory/SQLite consistency before Phase D began — and it found the integration harness built its `Room` with no persistence hooks at all, unlike production. Every Phase C test had driven a server that silently never wrote a gather/build mutation to disk, and "survives a restart" had never been exercised end-to-end. The correction wasn't a patch to the failing test: persistence wiring was factored into one shared function production and the harness are both required to call, closing the class of bug, confirmed by a new integration spec asserting a full server restart.

A later usability pass was held to the same standard: a controls legend, a toast for every server rejection reason, movement interpolation, and touch controls calling the exact same functions the keyboard handler calls, never a second implementation. Rather than accept the agent's own test run as sufficient, manual testing with two independent cookie jars against the live server confirmed distinct identities, correct real-time propagation, a resolved gather race on a resource node's last unit, and identity/inventory surviving a genuine process restart.

## 4. Where a redesign exposed what a scope cut forgets

Pathfinding broke in a reproducible way: enemies chasing in a straight line could stall against a lake shoreline, or creep toward a cell boundary without crossing it, confirmed with a boss and guardian each stuck for a 500+ simulated-second run. Movement now falls back to a per-target BFS distance field the instant either axis is blocked, committing to one cardinal step rather than re-fighting the still-blocked direct line every tick.

A larger scope cut replaced the beacon/dungeon win condition with "kill every enemy on the map," directed as a deliberate simplification, not a quiet feature add. Farming and the dungeon's coordinate space were deleted outright. That cut left two consequences standing, contradicting the rule they weren't designed against: enemy respawn makes "kill every enemy" permanently unreachable, and night-only extra wanderer spawns were built to make the old beacon fight harder at night, not to coexist with a finite roster. Neither a type error nor a passing test would have caught this — only reading the new rule's implication against what already existed did, which is why the review step explicitly asked "what does this contradict," not just "does it compile." Both were cancelled outright.

Subsequent commits built real consequences on the simpler loop: death wipes a player's inventory and every building they own, and resets every enemy — dead ones included — so a death restarts the shared fight, not just the player. Tools gained real effects and limited durability, and the boss now actively chases rather than waiting at its spawn.

## 5. What's verified and what isn't

Locally, at the current `HEAD`: `pnpm typecheck` passes with no type errors; `pnpm build:client` builds successfully; `pnpm test` passes 274 of 274 tests across 34 test files, run against a real, locally-running server, not mocks. These are local results from this session, not a freshly re-run CI pass.

Not re-verified this session: a deployed live instance; a two-independent-browser-profile session against that instance; production logs. Earlier development history recorded a successful remote deploy and a passing CI Docker build, but neither was re-run here.

Player position does not currently persist across a server restart, though identity and inventory do — a known, documented gap, not an unexpected regression.

Whether the feature set is complete is left to the marker's own pass against the deployed app, not restated here.
