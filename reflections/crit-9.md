# Crit 9 reflection

**What was the breakthrough that moved the work forward?**

I expected the hard part of this crit to be wiring up SSE. It wasn't — the
harder, more useful moment was when the agent read `POST /brick` closely
enough to notice there's no `await` between reading what's taken and writing
the insert, which means Node's single-threaded scheduling already stops two
requests from racing onto the same cell on this one process. That could have
been a shortcut to skip the concurrency work. Instead it became the reason
the testing got more honest: rather than writing a test that pretends to
force a race, I asked for a test of the actual guarantee the constraint
provides (a direct insert-the-same-cell-twice check) separately from a test
of the actual guarantee the live app provides (concurrent load, no
collisions) — and for the ADR to say plainly that the conflict redirect's
real trigger isn't reachable through the HTTP layer here. "It's rare, so I
didn't test it" and "I checked, and here's exactly why it can't happen on
this deployment" are very different sentences, and I want the second one in
my repos.

**What did this work change about who I want to be as a software developer?**

Watching the first version of the concurrency test fail — 9 new cells
instead of 8, caused by another test file running in parallel against the
same live app — was a small, concrete reminder that "it passed" only means
something once you understand why it could have failed. I want to keep
asking "could this pass for the wrong reason?" before I trust a green check.
