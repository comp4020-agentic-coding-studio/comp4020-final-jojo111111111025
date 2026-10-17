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

## Who is "a visitor" here

A visitor is a browser holding a signed `visitor_id` cookie — there is still
no account, login, username, or password. The server issues a fresh anonymous
id (a UUID) the first time a browser arrives, and the cookie that carries it
is tagged with an HMAC signature the server alone can produce, so a visitor
can't simply set their cookie to someone else's id and be recognised as them.
An unsigned, tampered, or otherwise unverifiable cookie is never trusted as
proof of identity — it's treated exactly like no cookie at all, and a fresh
id is issued. The full reasoning, including why this is enough and an account
system wouldn't add anything The Wall needs, is in
[`docs/adr/002-anonymous-identity.md`](docs/adr/002-anonymous-identity.md).

## What a visitor can see and change

Every visitor sees the same shared wall — there's no private view. A visitor
can place exactly one brick at a time, into the next open cell in reading
order; nobody can choose a cell, edit another visitor's brick, or remove any
brick (there's no route that does either). What's new since crit 10 is that
this is actually enforced against a server-verified identity rather than a
cookie value a client could edit: the server decides whose brick is whose,
and a brick's `visitor_id` always comes from that verified identity, never
from anything the request body, a header, or a query parameter claims.

## Logging

The server prints one JSON line per significant event to stdout: a new
identity issued, an invalid cookie rejected, a brick placed, or a brick
rejected (and why — an occupied cell, an invalid colour, or a full wall).
Each line carries a timestamp, the event name, and the visitor id the server
itself resolved — never a cookie value, a signature, or any other secret.
Locally that's just the terminal `node server.ts` runs in; on the deployed
app it's read with:

```sh
mise exec -- flyctl logs -a comp4020-final-jojo111111111025
```

This is what lets two visitors be told apart during a live demonstration:
the narration comes from these lines, not from watching either browser.

## Limitations

The identity is tied to a browser's cookie jar, not a person: clearing
cookies, or opening a private window, gets a new identity, and there's no way
(by design — see the ADR) to prove two sessions are the same human or
different humans beyond that. `SESSION_SECRET` lives in the same SQLite file
as the wall itself, so a fresh database (a new Fly volume) invalidates every
previously-issued cookie at once; existing visitors are simply treated as new
ones, not locked out or errored. Logging is to stdout only — there's no log
rotation or external log storage beyond what Fly retains.

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
