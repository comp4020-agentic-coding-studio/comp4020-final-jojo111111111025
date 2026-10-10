# The Wall

## What it is

The Wall is a small shared wall where visitors add one brick at a time.
A visitor chooses a colour and their brick is placed into the next available
space.

The wall is intentionally bounded and fills from left to right, then top to
bottom. There is no account, chat, likes, or infinite scroll.

Since crit 9, the wall updates live: a brick placed by one visitor appears for
everyone else who has the page open, without a reload. How two visitors
placing at once is resolved is written down in
[`docs/adr/001-concurrent-brick-placement.md`](docs/adr/001-concurrent-brick-placement.md).

## What good means

For this first version, I think a good version of The Wall should be:

### Easy to understand

A stranger should be able to understand what to do from the page itself,
without needing an explanation from me.

### Small and constrained

The wall should feel like a small shared object rather than another social
media feed. The fixed 20×12 grid and one-brick-per-visit rule give the
interaction a clear boundary.

### Persistent

An action should have a consequence that remains after the page is refreshed
or the visitor returns. A visitor should be able to recognise the bricks they
placed without creating an account.

### Shared but personal

Different visitors should see the same wall, while each visitor can still
recognise their own contribution.

## What informed this

I used the COMP4020 final-project brief and the Crit 8 brief as the main
starting points. In particular, the discussion of the small web, games for a
handful of friends, and tools built for one workshop influenced my decision
to keep the project small and focused rather than building a general-purpose
social application.

I also looked at [Robin Sloan's "Home-Cooked App"](https://www.robinsloan.com/notes/home-cooked-app/)
as an example of thinking about small, personal web projects.

This is a first version of what I think makes the project good. I expect
these criteria to change as the project develops.
