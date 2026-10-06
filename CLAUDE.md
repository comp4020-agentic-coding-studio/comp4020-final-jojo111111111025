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
