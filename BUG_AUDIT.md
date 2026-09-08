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
| A leftover `alert()` on every disconnect | A blocking browser popup fired on every connection blip, and a phone drops its socket every time you switch apps |
| A lobby seat was freed the instant the socket dropped | Switching apps while waiting for players lost you your place, with a token pointing at a seat that no longer existed - and if you were the only human there, the game was deleted |
| Any disconnect paused the table instantly | Glancing at a message stopped the round for everybody, with no grace period between a blip and an absence |
| No rate limiting on socket events | One socket could emit as fast as it liked |
| The client rebuilt game state from the DOM | `getCurrentGameState()` is gone and the winner popup reads the server's payload |
| A dropped player froze the table | The host can hand the seat to a bot instead of restarting the round |

---

## Testing

`npm test` runs the suite in `test/`, built on `node:test`. Every pull request runs it on
GitHub Actions.

The rules now live in `lib/`, so they can be tested by calling a function rather than by
playing a game:

- `lib/deck.js` - deck composition, and the invariant that a reshuffle can never put a
  card back in play while a copy is sitting in somebody's hand.
- `lib/bot.js` - every personality, on both decks, in every position.
- `lib/presence.js` - the difference between a dropped socket and an absent player.
- `lib/rules.js` - scoring, busts, Second Chances, turn order, who a targeting card may
  be aimed at, and what ends a round or a game.

`test/game-flow.test.js` covers what none of those can: sequences that span several
socket handlers. It starts a real `server.js` on a free port and drives it with socket.io
clients, stacking the deck through test-only events that exist only when
`HIT7_TEST_HOOKS=1` is set. All five paths the previous version of this file listed as
worth automating are now covered there:

1. A Draw Three sequence that itself draws a targeting card.
2. Select as the last card in the deck.
3. Second Chance consumed by a Swap-induced duplicate.
4. Every player busting in the same round.
5. A turn timing out while a target popup is open.

Still untested: the lobby, reconnects and host migration, the bot puppet-socket loop, and
the Remove Card and Steal handlers. Those are the next ones to extract.
