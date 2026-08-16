# HIT7 Code Audit

Current known issues in `server.js` / `public/client.js`. Everything listed as fixed is
recorded in [FIXES_APPLIED.md](FIXES_APPLIED.md).

> The previous version of this file was written against a codebase that no longer
> matches this one - it referenced line numbers, a `frozen` player status and a
> Select-card timeout that are not in the shipped server. It has been rewritten
> against the current code.

---

## Open issues

### No reconnect after a refresh
**Severity**: HIGH
Disconnecting now removes you from the game cleanly, but there is no way back in:
joining is lobby-only, and a returning socket has a new id. Refreshing mid-game costs
you your seat and your banked score.
**Fix**: issue a token on join, store it against the player, and let a socket
presenting a known token reclaim that seat instead of creating a new player.

### Targeting cards can only be played on the turn they are drawn
**Severity**: MEDIUM
Freeze, Draw Three, Remove Card, Steal and Swap open their target popup the moment
they are drawn and are consumed there. A copy that arrives another way - a Steal or a
second draw during a Draw Three sequence - lands in the hand with no way to play it,
and is cleared at the end of the round.
The `request-draw-three-targets` / `request-freeze-targets` / … events already exist
server-side and would support playing a held card; the client has no button to send
them outside the Select flow.

### The client reconstructs game state from the DOM
**Severity**: MEDIUM
`getCurrentGameState()` reads statuses, scores and card counts back out of rendered
HTML, and `showWinnerPopup` parses player names out of `<h3>` text. Any change to the
markup silently changes the parsed state. The server sends the full game object on
every update - that should be cached and read instead.

### Reshuffling builds a brand new deck
**Severity**: LOW - by design, but worth stating
When the deck runs out, `createDeck()` makes a fresh 108-card deck and the discard pile
is cleared, rather than reshuffling the discards. Cards currently in players' hands are
not accounted for, so the same card can exist twice across a reshuffle, and the
remaining-pile display resets to a full deck. This is fine for the game as designed;
it just means the pile is not a reliable count of what is truly left.

### Round-end delay is a fixed 5s `setTimeout`
**Severity**: LOW
Nothing cancels it if every player leaves during the summary. The timer checks that its
game is still the live one before scoring, so this is inert - just untidy.

### No rate limiting on socket events
**Severity**: LOW
A client can emit `flip-card` as fast as it likes. Turn and status checks mean this
cannot corrupt a game, but nothing stops one socket from generating load.

---

## Fixed

Full detail in [FIXES_APPLIED.md](FIXES_APPLIED.md).

| Issue | Was |
|---|---|
| No disconnect handler | Games hung on a departed player's turn and leaked forever |
| Double round scoring | Two `checkGameStatus` calls banked the round twice |
| `checkGameStatus(game)` missing `io` | Crashed the process if a round ended on a Select |
| Deck broadcast in draw order | Devtools showed the next card |
| Special cards playable out of turn | Anyone holding an RC could act on another player's turn |
| `select-card-choice` unguarded | Any card could be taken without holding a Select |
| Player names rendered unescaped | Stored XSS on every client in the room |
| No join validation | No name check, no player cap, joinable mid-round |
| Duplicate `0` never busted | `handleNumberCard` skipped the check for `0` |
| +15 bonus written to `totalScore` | Kept even after a Steal broke the set of 7 |
| Busted players kept a round score | Display only; totals were correct |
| `filter(c => c !== card)` | Playing one card discarded every copy of it |
| RC/Swap consumed before using indices | Removed the wrong card from your own hand |
| Draw Three could target a stuck player | Parked the turn on someone who could not act |
| `showNotification` undefined | Every swap threw instead of announcing |
| Dead code | `startServer`, `use-freeze`, `checkFinalWinner` |

---

## Testing

`server.js` has no test suite in the repo. The fixes above were verified by driving a
real server with scripted socket.io clients - full games to 200 points asserting
per-update invariants (hand size, no duplicate cards, busted players at 0, deck never
in draw order, totals growing by exactly one round score), plus targeted checks for
validation, out-of-turn actions, disconnects and host migration.

Worth automating next, as they are the paths hardest to reason about:
1. A Draw Three sequence that itself draws a targeting card.
2. Select as the last card in the deck.
3. Second Chance consumed by a Swap-induced duplicate.
4. Every player busting in the same round.
