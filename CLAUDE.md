# Last Shelter — Agent Harness

Rules for working on Last Shelter. These are the project's working invariants, derived from [`README.md`](README.md), [`PROCESS.md`](PROCESS.md), [`docs/adr/`](docs/adr/), and [`spec/`](spec/).

Keep this file concise and actionable. Detailed explanations belong in the linked documents. Update these rules when the implementation deliberately changes; never claim guarantees that the code does not provide.

## 1. Course requirements

- **README publication:** `/readme/` must publish the complete, current `README.md`. `renderReadme()` in `src/server/index.ts` reads it on each request. Do not maintain a separate copy.
- **Deployment:** Preserve the Fly.io deployment configuration, persistent volume, and production startup path.
- **Multi-user:** Separate browser sessions must share the same authoritative world and distinguish players by anonymous identity.
- **Real-time:** Shared changes must reach other connected sessions within approximately one second, without reloads.
- **Persistence:** Data promised as persistent must survive sessions, server restarts, and redeployments. Document intentionally transient state.
- **Responsive:** Keep the application usable at both 1920×1080 and 390×844.
- **Checks:** Preserve `spec/invariants.test.ts`. Both `pnpm check` and `pnpm check:evidence` must pass. Never weaken checks to hide regressions.

## 2. Identity and multiplayer

- No accounts or sign-up. Use the anonymous signed identity cookie. See [`docs/adr/001-anonymous-identity.md`](docs/adr/001-anonymous-identity.md).
- Never expose the cookie, signature, or `SESSION_SECRET` to clients or logs. Log `player_id` instead.
- `net.ts` resolves connection identity from the signed cookie. Never trust a client-supplied player ID.
- Every mutating WebSocket handler must verify `isCurrent()` so superseded connections cannot mutate state.
- The server is authoritative for gameplay validation and shared state.
- Resolve concurrent operations atomically. Building placement relies on SQLite's `UNIQUE (x, y)` constraint; do not replace it with an unsafe read-then-write check.

## 3. Persistence and gameplay

- Keep durable database state separate from intentionally transient in-memory simulation state.
- Day/night must remain derived from `computeTimeOfDay(worldCreatedAt, now)`, not a separately persisted phase.
- Enemies, including the boss, are transient and regenerate from the deterministic map seed after restart. Their kill progress does not persist.
- Farming and crop growth are not part of the current design. Do not reintroduce removed mechanics without an explicit design decision.
- Every death must go through `Room.damagePlayer()`. At zero health, `wipePlayerOnDeath()` clears the player's inventory and owned buildings from memory and SQLite.
- Enemy resets must not reset unrelated world or surviving-player state, generate duplicate enemies, or corrupt the existing world. Any connected player may request the reset.
- Collected or depleted resources must remain consistent across clients and reconnects.
- Validate inventory limits and all gameplay actions on the server.

See [`PROCESS.md`](PROCESS.md) and [`docs/adr/`](docs/adr/) for implementation rationale and accepted trade-offs.

## 4. Real-time communication and feedback

- Broadcast shared gameplay changes to all relevant connected clients.
- Reconnecting clients must receive authoritative current state, not rely on stale local state.
- Do not introduce competing sources of truth between client and server.
- Log significant events: session issuance/rejection, joins, reconnects, disconnects, evictions, combat, wins, resets, deaths, and resource resets.
- Do not log every tick or movement input. Never log credentials or signing secrets.
- Important actions must provide understandable feedback, including successful interactions, failures, collection, crafting, combat, death feedback visible to the affected player, and victory.

## 5. Interface and controls

- Keep the established pixel-art visual direction coherent across terrain, characters, resources, buildings, and enemies.
- Make players and important interactive objects recognisable.
- Essential objectives and controls must be discoverable to first-time players.
- Preserve clear local-player and other-player visual distinctions.
- Keyboard and touch controls must call the same action functions. Reuse `performInteract`, `performAttack`, `performToggleChest`, and `performUseBandage` in `main.ts`.
- Movement must combine `touchMove` and keyboard input, clamped to `[-1, 1]`; never let one input overwrite the other.
- Mobile controls must work without hover and must not obscure essential gameplay information.
- Do not sacrifice readability or usability for decoration.

## 6. Scope and development workflow

- Do not add mechanics, items, enemies, recipes, or win conditions outside the current README without an explicit scope decision.
- Significant architectural changes to identity, persistence, concurrency, or world-state authority require an ADR.
- Keep `README.md`, `CLAUDE.md`, `spec/`, and the actual implementation consistent.
- Add tests for new enforceable guarantees. Do not describe untested judgement-based qualities as automated guarantees.
- Preserve commit history and reflection evidence. Never invent commits, test results, or deployment claims.
- Prefer focused changes. Do not rewrite unrelated working systems or introduce dependencies without a clear reason.
- Respect explicit file boundaries in each task. A visual-only task must not silently change gameplay, shared protocols, or server logic.
- Before reporting completion, run relevant checks, inspect the diff, and state what changed and what remains unverified.

## 7. When a rule must change

When a requested change conflicts with an existing invariant:

1. Identify the affected promise.
2. Explain the reason and trade-offs.
3. Update the README and relevant ADR where necessary.
4. Update this harness and `spec/` to reflect the new contract.
5. Update `PROCESS.md` if the decision changes the development rationale.
6. Implement and verify the change.

**The objective is intentional evolution:** every change should preserve or deliberately revise the experience Last Shelter promises.
