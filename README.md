# The Wall

A small, bounded wall that fills one brick at a time, in the order people show
up. Pick a colour, it lands in the next open spot — reading order, left to
right, top to bottom. There's no free placement and no redo. Your own bricks
are outlined when you look at the wall; no account, just a cookie.

## What good means here (first pass)

This is a first version, written before the app exists properly, and it's
meant to be rough. It'll change as the project does.

- **Small and finite beats infinite.** The wall is one 20×12 grid, not an
  endless canvas. It's done when it's full, the same way a real wall would be.
- **Anonymous, but still yours.** No sign-up, no profile — just a quiet cookie
  so you can find your own bricks again. Nobody else needs to know which ones
  are yours.
- **Legible at a glance.** A stranger should be able to look at the wall for
  five seconds and understand the whole rule: one brick each, in order, no
  take-backs.

## What I read

Still reading. The brief points at the small web, games built for a handful of
friends, and tools built for one workshop — [Robin Sloan's "Home-Cooked
App"](https://www.robinsloan.com/notes/home-cooked-app/) is the closest match
to that and the first thing on the list, not yet a citation I can properly
defend. The real argument, with sources actually weighed against each other,
comes with the next rewrite of this file.

## What's enforced vs. judged

- **Enforced** (see `spec/`): a brick you place is still there, outlined as
  yours, when you come back.
- **Judged** (nobody's written a check for this yet): whether the order-only
  rule actually reads as "a wall," and not just a worse guestbook.
