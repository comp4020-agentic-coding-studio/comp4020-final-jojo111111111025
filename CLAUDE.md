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
