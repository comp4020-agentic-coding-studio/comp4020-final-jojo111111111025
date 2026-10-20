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
  gather/craft/build/chest/farm/attack/deposit/activate/zone methods all
  take that resolved id as a parameter, not something read back out of the
  message.
- **Every authoritative action is zone-checked.** The overworld and the
  dungeon are disjoint coordinate spaces that can share numeric `(x, y)`.
  Gather/build/chest/farm are overworld-only; combat/beacon/zone-transition
  checks validate the acting player's `zone` against the target/object's
  zone. A new action that touches world state needs its own `wrong_zone`
  check, not an assumption that the overworld check elsewhere covers it.
- **A superseded connection can never mutate state.** A second connection
  for the same identity bumps `nextGeneration`; `isCurrent()` must gate any
  handler that mutates room state on behalf of a connection, the same way
  `room.join`'s own supersede logic and the `socket.on("close")` handler
  already do. Don't add a new message handler that skips this check.
- **Atomic placement/activation races are resolved by the database, not
  application logic re-checking state as a separate step.** Building
  placement (`UNIQUE(x, y)`), boss-defeated-once, and beacon activation
  (`UPDATE ... WHERE completed_at IS NULL`) all rely on SQLite's own
  constraint/atomic-update enforcement. Don't replace one of these with a
  read-then-write pair that isn't backed by the same guarantee.
- **A reward or mutation only ever commits with its bookkeeping, never
  separately.** `claimAndApplyPendingRewards` claims a pending reward,
  merges it into inventory, and marks it settled inside one SQLite
  transaction — a crash or thrown error between those steps rolls all of
  it back. Any new durable, multi-step state change should follow the same
  pattern rather than leaving a window where one side committed and the
  other didn't.
- **Day/night and crop growth are pure functions of elapsed wall-clock
  time, never a ticked or persisted "current phase."** `computeTimeOfDay`
  and crop-stage computation take `(createdAt/plantedAt, now)` and derive
  the answer fresh every time, so a server restart can't desync them. Don't
  introduce a stored phase/stage field that could drift from this
  derivation.
- **Log identity and gameplay outcomes that matter after the fact, not
  every internal step.** `log()` in `src/server/log.ts` is for session
  issuance/rejection, join/reconnect/disconnect/eviction, and
  identity-attributed gameplay events (combat, boss defeat, beacon
  deposit/activation) — enough to tell two players apart in a live session
  afterward, not a line per tick or per movement input.
- **Don't add features that aren't part of the current `README.md`.** A
  new mechanic, item, or win condition is a `README.md` (and likely ADR)
  decision first, not a quiet addition to `room.ts`.
