# Your harness

Rules for working on Last Shelter, derived from `README.md` and the ADRs in
`docs/adr/`. Rewrite these as the app's own invariants change — don't let
this drift from what the code actually guarantees.

## Course-wide requirements (unchanged across deliverables)

- **`/readme/` always reflects the current `README.md`, verbatim, in full.**
  `renderReadme()` in `src/server/index.ts` reads `README.md` fresh on every
  request — no cached or separate copy to keep in sync. If `README.md`
  changes, `/readme/` changes with it.
- **No accounts, no sign-up, ever — only the anonymous signed identity
  cookie.** If a future phase wants to tell players apart more durably than
  a cookie, that's a decision for an ADR first, not a quiet addition to the
  server. See `docs/adr/001-anonymous-identity.md`.
- **The identity cookie's signing secret never leaves the server.** Not
  logged, not sent to a client, not embedded in anything the client
  renders. `src/server/log.ts`'s `log()` calls carry `player_id`, never a
  cookie value, signature, or `SESSION_SECRET`.
- **Keep `spec/invariants.test.ts` green.** It checks the two things the
  course relies on against the running app: `/` answers `200`, and
  `/readme/` publishes every one of `README.md`'s headings, in order. Don't
  delete or weaken it to make the suite pass — fix the app instead.

## Last Shelter's own invariants

- **Every mutating action is validated server-side against the connection's
  resolved identity, never a client-claimed one.** `net.ts` resolves
  `conn.id` once, from the signed cookie, when a WebSocket connects; no
  client message carries or can override an identity field. `room.ts`'s
  interact/craft/build/chestTransfer/attack/useBandage/respawn/playAgain
  methods all take that resolved id as a parameter, not something read back
  out of the message.
- **A superseded connection can never mutate state.** A second connection
  for the same identity bumps `nextGeneration`; `isCurrent()` must gate any
  handler that mutates room state on behalf of a connection, the same way
  `room.join`'s own supersede logic and the `socket.on("close")` handler
  already do. Don't add a new message handler that skips this check.
- **Atomic placement races are resolved by the database, not application
  logic re-checking state as a separate step.** Building placement
  (`UNIQUE (x, y)` in `src/server/db.ts`) relies on SQLite's own constraint
  enforcement — a losing placement is treated exactly like any other
  occupied-cell rejection. Don't replace this with a read-then-write pair
  that isn't backed by the same guarantee.
- **Day/night is a pure function of elapsed wall-clock time, never a
  ticked or persisted "current phase."** `computeTimeOfDay` takes
  `(worldCreatedAt, now)` and derives the answer fresh every time, so a
  server restart can't desync it. Don't introduce a stored phase field
  that could drift from this derivation. There is no farming or crop
  growth in the current design — that mechanic was removed; don't
  reintroduce it without a README/ADR decision first.
- **Enemies are in-memory-only, transient simulation state — never
  persisted, not even the boss.** A server restart regenerates the full
  roster from the deterministic map seed, resetting any in-progress kill
  count; this is a known, accepted limitation (see `PROCESS.md`), not a
  gap to quietly patch with new persistence.
- **Log identity and gameplay outcomes that matter after the fact, not
  every internal step.** `log()` in `src/server/log.ts` is for session
  issuance/rejection, join/reconnect/disconnect/eviction, and
  identity-attributed gameplay events (combat attack, game won, game reset,
  player died, resources reset) — enough to tell two players apart in a
  live session afterward, not a line per tick or per movement input.
- **Don't add features that aren't part of the current `README.md`.** A
  new mechanic, item, or win condition is a `README.md` (and likely ADR)
  decision first, not a quiet addition to `room.ts`.
- **Death wipes inventory and every building the player owns, in that one
  server-side place.** `Room.damagePlayer` is the only path to `alive =
  false`; the instant health reaches 0 it calls `wipePlayerOnDeath`, which
  empties the inventory and removes (in memory and in SQLite) every building
  with that player's `ownerId`, then queues a `PlayerDeathEvent`. `net.ts`
  drains that queue after every `tick()` and broadcasts `player.died` so
  every client (not just the victim's) drops the removed buildings. A new
  way for a player to take damage must still go through `damagePlayer` —
  don't add a second place that can flip `alive` without the same wipe.
- **Touch and keyboard input must call the same client-side action
  functions, never duplicate the logic.** `performInteract`/
  `performAttack`/`performToggleChest`/`performUseBandage` in `main.ts` are
  each called from both the keyboard handler and a touch button; a new
  input method or action needs to share that one function, not grow a
  second implementation that can drift from it. Movement is summed
  (`touchMove` + `keys`, clamped to `[-1, 1]`), never one input
  overwriting the other.
