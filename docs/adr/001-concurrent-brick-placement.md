# 1. Concurrent brick placement

## Status

Accepted (crit 9, 2026-10-10).

## Context and problem

The Wall assigns each new brick to the next empty cell in reading order
(left-to-right, top-to-bottom) — a visitor never picks a cell. Two visitors
can submit a placement at close to the same instant. The app has to decide,
atomically, what happens when two requests could both believe the same cell
is free, so the wall never ends up with two bricks in one cell, and a
placement is never silently dropped without telling the visitor who sent it.

## Options considered

1. **First successful placement wins.** The database decides the winner
   atomically; the loser is told plainly and can try again.
2. **Last write wins.** A later request overwrites an earlier one in the same
   cell.
3. **Lock a cell while someone is mid-placement.** Reserve a cell for the
   duration of a request.

## Decision

Option 1. It's already mostly in place: the `bricks` table has had
`PRIMARY KEY (x, y)` since crit 8 (see `CLAUDE.md`), so a duplicate insert is
rejected by SQLite itself, not by application logic re-checking "is this
taken?" as a separate, racy step. What crit 9 adds is the visitor-facing half:
the server computes the next empty cell and attempts one `INSERT`; if that
insert is rejected because the cell was just taken, the request redirects to
`/?conflict=1`, which renders a plain-language notice on the current wall and
invites the visitor to pick a colour and try again — instead of the previous
behaviour, which silently swallowed the failure and gave no sign the
placement hadn't happened.

## Why it fits "what good means" here

`README.md`'s "Small and constrained" and "Shared but personal" criteria rule
out option 3 immediately: a lock turns a small, instant, no-signup
interaction into something with waiting and timeouts — exactly the
"chat-room-with-the-nouns-swapped" complexity the project exists to avoid.
Option 2 would let a second visitor silently erase a first visitor's
committed brick, which contradicts "Persistent" — a placed brick must remain
unless the visitor who placed it is told otherwise. Option 1 is the only one
that keeps every committed brick permanent, keeps the interaction instant,
and gives a losing visitor an honest answer instead of silence.

## Consequences and trade-offs

- A visitor who loses a race has to resubmit; this is more friction than
  last-write-wins, but it's the friction of correctness rather than the
  friction of accounts or locks.
- There is no cell-picking UI, so the generic framing of this decision
  ("choose a different cell") becomes, concretely, "submit the form again" —
  the server computes whatever is then the true next empty cell. This is a
  deliberate reading of a general concurrent-placement problem onto this
  app's specific, cell-less placement model.
- The `PRIMARY KEY` constraint, not the application code, is the final
  authority on uniqueness; even a bug in how `nextSlot` reads "what's taken"
  can't corrupt the wall, only cause an avoidable, user-visible conflict.

## Failure modes and how they are handled

- **Two requests compute the same next-empty cell.** The second `INSERT` is
  rejected by `PRIMARY KEY (x, y)`; that visitor is redirected with
  `?conflict=1` instead of silently losing their brick.
- **A write is rejected, for this or any other reason.** No row is committed,
  so nothing is broadcast over `/events` — `broadcastBrick` is only ever
  called after a successful `.run()` in the `POST /brick` handler, never from
  the `catch` branch (`server.ts`).
- **The wall is completely full.** Out of scope for this decision, unchanged
  since crit 8: the request silently redirects to `/`. Noted here for
  completeness, not addressed by crit 9's spec.

## Verification evidence

- `flyctl scale show -a comp4020-final-jojo111111111025` confirms the
  deployed app runs exactly one machine (`shared-cpu-1x`, `256mb`, region
  `syd`), and `.github/workflows/checks.yml`'s deploy step pins `--ha=false`.
  One process, one SQLite connection.
- In that one process, `POST /brick`'s handler has no `await` between reading
  what's taken and writing the insert (the one earlier `await` is for reading
  the request body, before either step). Node's run-to-completion scheduling
  means one request's whole read-decide-write sequence finishes before the
  next one starts — so, concretely, two concurrent HTTP requests to this
  specific process cannot interleave inside that window today.
  `spec/concurrency.test.ts`'s "N concurrent placements" test fires 8 at once
  and finds zero collisions, consistently (run locally more than ten times
  while building this).
- Because of that, the constraint's rejection branch cannot currently be
  triggered through the live HTTP app — it is defense-in-depth for a
  condition this process can't produce on its own (a second app instance, or
  a database driver that introduces an `await` between the read and the
  write, would reopen the window; neither exists here). `spec/
  concurrency.test.ts` also has a direct test against a disposable SQLite
  connection, using the same schema, that inserts the same `(x, y)` twice and
  asserts the second insert throws — proving the constraint itself does what
  this decision relies on, independent of whether the HTTP layer can
  currently reach it.
- `spec/realtime.test.ts`'s `GET /?conflict=1` test (and a manual `curl`
  before the test existed) confirms the notice renders correctly. What's
  *not* exercised, by either method, is the redirect's real trigger — an
  actual rejected insert reaching the `catch` branch in `POST /brick` — since
  there's no way to produce that condition through the live HTTP app without
  temporarily breaking the constraint the whole decision rests on.
