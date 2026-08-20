# HIT7 Code Audit

Current known issues in `server.js` / `public/client.js`. Everything listed as fixed is
recorded in [FIXES_APPLIED.md](FIXES_APPLIED.md).

> The previous version of this file was written against a codebase that no longer
> matches this one - it referenced line numbers, a `frozen` player status and a
> Select-card timeout that are not in the shipped server. It has been rewritten
> against the current code.

---

## Open issues

### Targeting cards can only be played on the turn they are drawn
**Severity**: MEDIUM
Freeze, Draw Three, Remove Card, Steal and Swap open their target popup the moment
they are drawn and are consumed there. A copy that arrives another way - a Steal or a
second draw during a Draw Three sequence - lands in the hand with no way to play it,
and is cleared at the end of the round.
The `request-draw-three-targets` / `request-freeze-targets` / … events already exist
server-side and would support playing a held card; the client has no button to send
them outside the Select flow.
In practice this is close to unreachable: each of these cards opens its popup the
instant it is drawn and `pendingTarget` holds the turn until it is aimed, so no other
player can act in the gap. Steal is the one way a copy can land in a hand that cannot
use it.

### The client reconstructs game state from the DOM
**Severity**: MEDIUM
`getCurrentGameState()` reads statuses, scores and card counts back out of rendered
HTML, and `showWinnerPopup` parses player names out of `<h3>` text. Any change to the
markup silently changes the parsed state. The server sends the full game object on
every update - that should be cached and read instead.

### Round-end delay is a fixed 5s `setTimeout`
**Severity**: LOW
Nothing cancels it if every player leaves during the summary. The timer checks that its
game is still the live one before scoring, so this is inert - just untidy.

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
| No reconnect after a refresh | A closed tab lost its seat; join was lobby-only |
| Reshuffling built a brand new deck | The same card could exist twice inside a round |
| A stalled turn hung the table | Nothing resolved the turn of a player who walked away |
| No rate limiting on socket events | One socket could emit as fast as it liked |

---

## Testing

`npm test` runs the suite in `test/`, built on `node:test` - no extra dependencies.
It currently covers `lib/deck.js`: deck composition, and the invariant that a reshuffle
can never put a card back in play while a copy is sitting in somebody's hand.

Everything still living in `server.js` is untested, because requiring it starts a
server. Extracting more of the rules the way `lib/deck.js` was extracted is the way in.

Earlier fixes were verified by driving a
real server with scripted socket.io clients - full games to 200 points asserting
per-update invariants (hand size, no duplicate cards, busted players at 0, deck never
in draw order, totals growing by exactly one round score), plus targeted checks for
validation, out-of-turn actions, disconnects and host migration.

Worth automating next, as they are the paths hardest to reason about:
1. A Draw Three sequence that itself draws a targeting card.
2. Select as the last card in the deck.
3. Second Chance consumed by a Swap-induced duplicate.
4. Every player busting in the same round.
5. A turn timing out while a target popup is open.
