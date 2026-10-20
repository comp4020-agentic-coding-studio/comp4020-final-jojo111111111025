# 1. Anonymous identity and server-side authorisation

## Status

Accepted (C10, 2026-10-21).

## Context and problem

Last Shelter is a shared, authoritative multiplayer world: several players
move, gather, fight, and build in the same room at once, and the server has
to reliably tell them apart — a player's own inventory, health, and position
must stay theirs no matter what any client claims — while still requiring no
account, login, or sign-up (the course's anonymous-identity model, already
used by this course's earlier "The Wall" project).

Phase A/B used a throwaway per-WebSocket-connection random id, which cannot
survive a reconnect: closing and reopening a tab, or a dropped connection
retrying, produced a brand-new identity with no inventory, defeating both
persistence and the four-player cap (a player could occupy a new slot every
reconnect). Phase C's actual problem was narrower than "add accounts" — it
was "give the server a way to recognise the same browser across connections
without trusting whatever a client asserts."

## Options considered

1. **Sign a cookie (HMAC-SHA256) minted on first HTTP load, verified on every
   WebSocket connection.** Same anonymous-cookie shape the course's prior
   project already validated, extended with an id + issue-timestamp pair so
   expiry/rotation don't need a database round trip to check.
2. **Server-side session store**, looked up on every request/connection.
   Adds a table to prune and a DB round trip per connection for a guarantee
   (unforgeability) signing already gives.
3. **A full auth library** (passwords, email, OAuth). Unneeded dependency
   weight and UX friction for a brief that explicitly wants no sign-up.

## Decision

Option 1. `src/server/identity.ts`: the server mints `<uuid>.<issuedAt>.<hmac>`
on first HTTP load (`index.ts`'s `ensureIdentityCookie`) and verifies it
(`verifyCookieValue`, constant-time comparison via `timingSafeEqual`) when a
WebSocket connects (`resolveIdentity` in `net.ts`). An invalid cookie — absent,
malformed, mistagged, expired (30 days), or belonging to a revoked player — is
never partially trusted: it is handled exactly like no cookie at all, and a
fresh anonymous identity is minted. `SESSION_SECRET` is generated once with
`randomBytes(32)` and persisted in the same SQLite file as game state, so it
survives restarts without separate secret management. A cookie older than 7
days is reissued with a fresh timestamp on next use (`needsRotation`), without
changing the id or losing any state.

This is the smallest change that makes "the server decides who you are" true
for a stateful multiplayer session, not just a single request: the identity
established once at connection time (`Connection.id` in `net.ts`) is the only
id ever used for the rest of that socket's lifetime — no incoming message can
claim to act as anyone else, because no message carries an identity field at
all; it's resolved once, server-side, before any message is processed.

## What each player can see and change

- **See:** the whole room's shared state — every player's position/health,
  every building, chest, and farm plot, and the beacon's shared progress.
  There is no private or per-player view; this is a cooperative shared
  world by design.
- **Change:** only actions attributed to their own resolved identity.
  Concretely, every mutating action — `player.interact` (gather),
  `craft.request`, `building.place`, `chest.transfer`, `farm.action`,
  `combat.attack`, `beacon.deposit`, `beacon.activate`, `zone.enter` — is
  validated in `room.ts` against `conn.id`, never a client-supplied player
  id, and every one of them also checks the acting player's current `zone`
  (`overworld` vs `dungeon`) before applying: gather/build/chest/farm are
  rejected with `wrong_zone` from the dungeon, combat/beacon-adjacent
  actions are rejected with `wrong_zone` if the target or object isn't in
  the player's own zone, and `zone.enter` itself is range- and
  object-validated so a player can't teleport by naming an arbitrary
  `dungeon_entrance`/`dungeon_exit` id (`spec/zone.spec.ts`).
- A superseded connection (a second tab/reconnect for the same identity)
  cannot act at all: its messages are silently ignored the instant a newer
  connection for that id is admitted (`isCurrent()` in `net.ts`), so a stale
  socket can never mutate state on behalf of an identity actively controlled
  elsewhere.

## Logging

`src/server/log.ts` emits one structured JSON line per event to stdout
(captured by `flyctl logs`/`docker logs` as-is): `session_issued`/
`session_rejected` (cookie issuance/verification outcomes), `player_joined`/
`player_reconnected`/`player_disconnected`/`player_evicted`, `join_rejected`
(wrong room code or full room), and the gameplay-identifying events
`combat_attack`, `boss_defeated`, `beacon_deposit`, `beacon_activated` — each
carrying the server-resolved `player_id`, never a cookie value, signature, or
`SESSION_SECRET`. This is enough to tell two players apart in a live session
after the fact, without logging a line per tick or per movement input.

## Consequences and trade-offs

- A reconnect within the 5-minute grace window (`RECONNECT_GRACE_MS`) is
  seamless — same identity, same inventory/health/position — but a cookie
  that expires or a database reset invalidates every previously-issued
  identity; those players are simply treated as new ones, not an error.
- Verifying a cookie is one HMAC computation, no database I/O — only a game
  action calls into SQLite, at whatever rate that action is actually taken.
- As with the course's prior anonymous-identity project, the signed cookie
  prevents a *different* browser from presenting someone else's id as proof
  of ownership; it was never meant to hide the id's existence from its own
  holder (visible in devtools), only to make forging someone else's
  unforgeable.

## Verification evidence

- `spec/identity.spec.ts`, `spec/expired-credential.spec.ts`: a fresh
  request is issued a cookie matching the signed shape; the same cookie
  round-trips to the same id; an expired, tampered, or wrong-secret-signed
  cookie is rejected and a *different* fresh id is issued rather than the
  presented one being trusted; a revoked player's cookie is rejected the
  same way.
- `spec/room-limit.spec.ts`, `spec/reconnect.spec.ts`: concurrent joins
  respect the four-player cap for new identities only; a reconnecting
  identity within its grace window regains its slot and inventory; past the
  grace window the slot is freed; a duplicate connection for the same
  identity supersedes the earlier one, whose subsequent messages are
  verified to have no effect.
- `spec/cross-room-access.spec.ts`: two room codes produce fully isolated
  `Room` instances; an identity or action in one is unreachable from the
  other.
- `spec/zone.spec.ts`, `spec/phase-d-integration.spec.ts`: gather/build/
  chest/farm rejected with `wrong_zone` from the dungeon; combat and beacon
  actions rejected across zone boundaries; `zone.enter` rejected for an
  out-of-range or wrong-zone transition object.
- `pnpm test`: 204 tests pass (202 Last Shelter + the course's 2 invariant
  checks), including full wire-protocol integration tests run with real
  file-backed SQLite connections rather than mocks.
