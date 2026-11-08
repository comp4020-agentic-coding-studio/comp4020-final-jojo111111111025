# Crit 8 reflection

**What was the breakthrough that moved the work forward?**

Deciding on the smallest possible thing counted for more than any single line
of code. I told the agent not to add anything beyond one working vertical
slice, then deploy it and prove persistence — not a feature list. That's why
The Wall ended up being one bounded 20×12 grid, one brick per visit, no
accounts: it's small enough that "a stranger's trace survives a reload" is
actually checkable, which is all crit 8 asks for. The real breakthrough was
turning that one spec line into an actual test (`spec/brick.test.ts`) instead
of just eyeballing it, and then proving it twice more by hand: as two
different visitors on the live URL (one whose brick stayed outlined, one
who saw it but it wasn't theirs), and again after a redeploy, where the
earlier brick was still sitting on the same volume. Docker itself wasn't
available to test locally, so the Fly remote build was the first time the
real deploy path ran at all — that gap made me realise how much I'd been
trusting the Dockerfile rather than verifying it.

**What did this work change about who I want to be as a software developer?**

I want to keep directing scope this tightly rather than letting "while we're
here" features creep in — the small grid is more defensible than a bigger
one would have been. Next week I want the real-time layer (crit 9) to be
something I can verify the same way: watch two sessions side by side, not
just assume it works.
