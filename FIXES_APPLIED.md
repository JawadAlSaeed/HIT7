# HIT7 Bug Fixes - Implementation Summary

> This file records fixes that are actually present in `server.js` / `public/client.js`.
> An earlier version of this document described freeze-duration tracking
> (`frozenUntilTurn`, `turnNumber`) and a Select-card timeout. None of that code was
> ever in the shipped server - the timeout was removed in commit `a86788c` - so those
> entries have been dropped rather than left to mislead.

## Stability

### Players who disconnect are removed from their game
`socket.on('disconnect')` had no handler at all, so a player who closed their tab
stayed in the players array forever. If it was their turn the round could never
advance, and because players were never removed the "delete empty games" interval
never fired, leaking every game ever created.

The handler now removes the player, re-derives `currentPlayer` (it is an **index**,
so a splice silently shifts the turn to someone else), migrates the host if the host
left, ends the round if the last active player is gone, and deletes the game once it
is empty.

### A round can only be scored once
Several actions ended a round and then let their caller check again - for example
`flip-card` drawing an unplayable RC would run `checkGameStatus` inside
`handleSpecialCard` and again on the way out. Both calls scheduled the 5s round-end
timer, so every player banked their round score twice and two new rounds started.
`game.roundEnding` now guards the scheduling.

### `checkGameStatus` is always given `io`
The call in `select-card-choice` passed only the game. Any round that happened to end
on a Select play hit `io.to(...)` on `undefined` and crashed the process.

### Round-end timer no longer fires into a replaced game
Reset and rematch build a **new** game object and swap it into the map, but the
pending timer still closed over the old one. It now checks that the game it captured
is still the live one before scoring.

## Rules and scoring

### A duplicate `0` busts like any other duplicate
`handleNumberCard` special-cased `0` and skipped the duplicate check, so a player
holding two zeros never busted. `0` is a number card - it now takes the same path as
1-12 (Second Chance still saves you).

### The 7-card bonus belongs to the round score
`+15` was written straight into `totalScore` the moment a hand filled up, while every
other point went through `roundScore` at round end. That let a player keep the bonus
after a Steal took one of the seven cards away. It is now part of `updatePlayerScore`,
derived from the hand, and applied after the multiplier/divide so it is still worth
exactly 15.

### A busted player scores 0
`updatePlayerScore` recomputed a bust back to a non-zero round score straight after
`handleNumberCard` had zeroed it. Totals were unaffected (busted players are skipped
when banking) but the number on screen was wrong.

### Playing a card discards one copy, not all of them
Every handler used `filter(c => c !== card)`, which removes *all* copies. Steal and
Swap can leave you holding two Freezes, and playing one destroyed both. Replaced with
`removeOneCard`, which splices a single copy.

Related: drawing a second copy of a targeting card you already held used to be
silently dropped, because the card was only added `if (!includes(card))`.

### Card indices stay valid while a card is being played
`remove-card` and `swap-cards` discarded the RC/Swap card *before* using the index the
client had sent. Aiming Remove Card at your own hand, or swapping one of your own
special cards, shifted every index after it and removed the wrong card. The chosen
cards are now taken out first.

### Draw Three cannot strand the turn
`draw-three-select` moved `currentPlayer` to the target without checking the target
could act. Targeting a busted or full-handed player parked the turn on someone who can
never flip, hanging the round.

### Swap only moves scoring cards
The client only ever offered number cards and point modifiers, but the server accepted
anything - so a crafted client could hand someone a Freeze they had no way to play.

## Anti-cheat

Every `game-update` broadcast the whole game object, **including `deck` in draw
order**. Opening devtools showed the next card. Broadcasts now go through
`publicGame`, which sorts the deck copy: the remaining-pile display still works
(it counts card types) but the order is gone. The Select popup is sorted too.

Targeting cards (`freeze-player`, `draw-three-select`, `remove-card`, `steal-card`,
`swap-cards`) and the `request-*-targets` events only checked that the sender was *a*
player, never that it was their turn - so anyone holding an RC could fire it during
someone else's turn and drag the turn over. They now require the sender to hold the
turn and the card.

`select-card-choice` never checked that the player actually held a Select card, and
handed over any card name it was sent even when the deck did not contain it. It now
requires the card, validates the value, and rejects cards that are not in the deck.

## Input validation

- Names are trimmed, collapsed and capped at 20 characters; the 3-character minimum
  now applies to **join** as well as create.
- Player names are HTML-escaped on render. Every panel is built with `innerHTML`, so
  a name like `<img src=x onerror=...>` previously ran on every client in the room.
- Games are capped at 6 players (the README's stated maximum) and can only be joined
  from the lobby. Joining mid-round used to insert a player stuck at `waiting` forever.
- Card indices must be integers.

## Client

- `showNotification` was called on every swap but never defined anywhere, so the swap
  announcement threw `ReferenceError` instead of displaying. Implemented as a toast
  (`.game-notification` in `style.css`) that sets the message as text, not markup.
- `getSpecialCardDisplay` now handles number cards, which the swap message passes in.

## Dead code removed

- `startServer` - never called; the live server is created at the bottom of the file.
  Its EADDRINUSE retry was replaced with an error handler on the real server.
- `use-freeze` - superseded by `freeze-player` (what the client actually emits), and
  it skipped `advanceTurn`, so it would have hung the turn if it were reachable.
- `checkFinalWinner` - never called.
- `checkGameStatus` used a hardcoded `200` next to the unused `WINNING_SCORE`.

## Testing

Driven with bot clients against a real server: full games to 200 points, asserting on
every update that no hand exceeds 7 cards, no hand holds duplicates, busted players
score 0, the broadcast deck is never in draw order, and totals grow by exactly one
round score per round. Plus targeted checks for name/cap/lobby validation, out-of-turn
actions, disconnect turn handover and host migration.

## Known gaps

- **No reconnect.** A refresh drops you from the game for good. Before this change a
  refresh hung the game instead, so this is an improvement, but a proper fix needs a
  session token so a returning socket can reclaim its seat.
- **Held targeting cards have no UI.** They are played the instant they are drawn. If
  a Steal leaves you holding a second Freeze, it sits in your hand until the round
  ends. The `request-*-targets` events look like they were meant to support this.
