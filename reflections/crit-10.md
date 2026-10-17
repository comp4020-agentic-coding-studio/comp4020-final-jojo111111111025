# Crit 10 reflection

**What was the breakthrough that moved the work forward?**

I expected this crit to be about adding something — a login, a new table, a
bigger feature. Inspecting the repo first showed the opposite: The Wall has
been multi-user and live-updating since crit 8/9, and every brick already
carried its creator's `visitor_id`. The actual gap was one specific,
narrow thing — the cookie carrying that id was never verified, just trusted.
A visitor could set their own cookie to someone else's id (visible already,
since it's broadcast on every SSE event) and the server would treat them as
that person. Finding the precise, small defect rather than assuming a large
rebuild was needed is what made the fix small: sign the id, verify it, and
never accept it otherwise, nothing more. The same close reading also surfaced
an unrelated real bug — `color` interpolated unescaped into an HTML attribute
— that I would have missed if I'd gone straight to "implement authentication"
instead of reading what was actually there.

**What did this work change about who I want to be as a software developer?**

Running the full test suite after the change, not just the new tests, caught
a real regression: two existing tests broke because they parsed the cookie
format directly, which I'd changed. It would have been easy to only run the
new file and call it done. I want to keep treating "did the new thing pass"
and "did I just break something that used to pass" as two different
questions, because a green `pnpm check` only means something once you've
checked both.
