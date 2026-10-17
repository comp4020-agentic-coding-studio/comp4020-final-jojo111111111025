# Your harness

Rules for working on The Wall, derived from `README.md`'s first pass at what
"good" means here. Rewrite these as that argument changes.

- **Slot assignment must stay atomic.** Two visitors posting at once must
  never drop a brick or double-place one into the same cell. The `PRIMARY KEY
  (x, y)` on `bricks` is what enforces this — don't add a code path that
  reads "is this slot free?" and writes to it as two separate steps without
  that constraint backing it up.
- **Every row written to `bricks` carries `visitor_id` and `created_at`.**
  Trace is the point of the app; a row without them is a bug, not an
  omission.
- **`/readme/` always reflects the current `README.md`, verbatim, in full.**
  No summarising, no truncating. If `README.md` changes, `/readme/` changes
  with it — there's no separate copy to keep in sync.
- **No accounts, no sign-up, ever — only the anonymous visitor cookie.** If a
  future week wants to tell people apart more durably than a cookie, that's a
  decision for `README.md` and an ADR first, not a quiet addition to the
  server.
- **Don't add features that aren't part of the current `README.md`.** More
  colours, undo, a bigger grid, rate limiting — all legitimate later
  decisions, none of them are this week's.
- **A commit only ever broadcasts after it commits.** `broadcastBrick` is
  called from exactly one place: right after a successful `INSERT` in
  `POST /brick`, never from its `catch` branch. If you touch that handler,
  keep it that way — see `docs/adr/001-concurrent-brick-placement.md`.
- **A rejected placement gets a visible answer, not silence.** A duplicate
  insert (the `PRIMARY KEY (x, y)` constraint firing) redirects to
  `/?conflict=1`, which renders a plain notice. Don't quietly swallow that
  error again.
- **`/events` holds a live `Set` of open connections, nothing more.** No
  event log, no replay buffer — a reconnecting client gets a fresh snapshot
  instead. Keep it that way unless the deployment stops being one process
  (it is one, by course design — `fly.toml`'s one volume and the course's
  `--ha=false` deploy both assume it).
- **The visitor cookie is signed, and only a verified id is ever trusted as
  `mine`.** `visitorId` in `server.ts` checks the HMAC tag before accepting a
  cookie's id; an unsigned or mistagged value is never used for ownership or
  authorisation, only replaced with a fresh one. Don't add a code path that
  reads `visitor_id` straight off the cookie or a request body/query/header —
  go through `visitorId`'s verified value. See
  `docs/adr/002-anonymous-identity.md`.
- **`SESSION_SECRET` never leaves the server.** Not logged, not sent to a
  client, not embedded in the HTML the client renders from. If you add a log
  line or response field that touches a cookie or signature, log the
  `visitor_id` it resolved to, never the raw cookie value or tag.
- **Log session and brick outcomes, not everything.** `log()` in `server.ts`
  is for `session_issued`, `session_rejected`, `brick_placed`, and
  `brick_rejected` (with why). Keep it to events useful for telling two
  visitors apart at a crit, not a line per internal step.
- **A brick's `color` is validated against the server's own `COLORS` palette
  before anything is read or written.** It's the one client-submitted value a
  placement carries and it's interpolated into an HTML attribute in
  `renderWall` — an unchecked value could break out of that attribute. x/y are
  never client-supplied (`nextSlot` computes them), so there's no client
  coordinate to validate, only this one field.
