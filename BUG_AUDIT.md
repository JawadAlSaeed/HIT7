# HIT7 Code Audit - Bug Report

## CRITICAL BUGS

### ✅ BUG #1: FIXED - Triple Card Duplication (Select Card)
**Status**: RESOLVED  
**Issue**: Three duplicate `select-card-choice` socket event listeners at lines 466, 529, and 709 caused special cards to be added 3 times instead of 1 when selected through the Select Card popup.  
**Fix Applied**: Removed the second and third duplicate handlers. Now only one handler exists.

---

## HIGH PRIORITY BUGS

### BUG #2: Missing Unfreeze Logic
**Severity**: HIGH  
**File**: [server.js](server.js#L338-L360)  
**Issue**: When a player is frozen using the Freeze card, their status is set to 'frozen' and advanceTurn() skips them (line 701). However, there is no logic to unfreeze them DURING a round - they remain frozen indefinitely until the next round starts (startNewRound resets status to 'active').  
**Expected Behavior**: Frozen players should only skip ONE turn, then unfreeze automatically OR a separate event should handle unfreezing.  
**Current Impact**: Frozen players cannot act for the entire rest of the round.  
**Recommendation**: Add a mechanism to track which turn a player was frozen, then unfreeze them after N turns, OR change game design to only freeze for one turn.

---

### BUG #3: D3 (Draw Three) Pending Card Not Handled with SC (Second Chance)
**Severity**: HIGH  
**File**: [server.js](server.js#L225-L229)  
**Issue**: When a player has `drawThreeRemaining > 0` and draws a D3/Freeze/RC card, it's stored as `pendingSpecialCard` rather than immediately handled. But Second Chance (SC) cards drawn during D3 sequence are added directly to `player.specialCards` in handleNumberCard, then discarded immediately when checking for duplicates. This means their Second Chance won't be available when needed.  
**Code Path**:  
1. Player has D3 active
2. Draws SC card → handleNumberCard adds it to specialCards
3. Next turn, it's stored as pending... but SC was already processed
**Recommendation**: Verify SC interaction with D3 sequences; currently unclear if this causes data loss.

---

### BUG #4: Player Gets Stuck in Select Card Mode
**Severity**: HIGH  
**File**: [server.js](server.js#L250-L264), [client.js](client.js#L1285-1450)  
**Issue**: When a player draws the Select card:
- The flip-card handler emits 'select-card-from-pile' with the deck
- The turn does NOT advance
- The player is still marked as currentPlayer
- But they're forced to select a card through a popup

If the player closes the popup or something goes wrong, the game hangs because:
- The current player is frozen in "Select Card Mode"
- No other players can take their turn
- No timeout mechanism to auto-advance if no selection is made

**Recommendation**: 
1. Add a timeout (e.g., 30 seconds) to auto-advance if player doesn't select
2. Disable flip/stand buttons while Select popup is active
3. Add error handling for socket disconnection during Select mode

---

### BUG #5: Deck Reshuffling Race Condition
**Severity**: MEDIUM  
**File**: [server.js](server.js#L165-L187)  
**Issue**: When Select is the LAST card in the deck:
```javascript
// Line 171-187: Server creates new deck and sends it
socket.emit('select-card-from-pile', gameId, [], newDeck);
game.discardPile.push('Select');
game.deck = newDeck;  // Updates deck AFTER emit
```

Between the emit and deck update, if another message comes in, it might reference the old empty deck state. The client also receives both empty deck and new deck to handle this edge case.

**Additional Issue**: When Select is NOT the last card (line 261), the normal path sends:
```javascript
socket.emit('select-card-from-pile', gameId, game.deck);
```
But the client listener expects 3 parameters: `(gameId, deck, fullDeck=null)`. While this works (fullDeck is undefined), it's inconsistent with the special case.

**Recommendation**: Always send consistent 3 parameters for clarity.

---

## MEDIUM PRIORITY BUGS

### BUG #6: Remove Card (RC) Can Target Inactive Players
**Severity**: MEDIUM  
**File**: [server.js](server.js#L426-L463)  
**Status**: PARTIALLY FIXED - Code checks for 'active' status at line 436  
**Issue**: The check exists but the error is just sent to the socket, not validated before removal. However, looking at the current code, this appears to be properly handled.

---

### BUG #7: Multiplier Logic Issue
**Severity**: MEDIUM  
**File**: [server.js](server.js#L737-L750)  
**Issue**: Score calculation only checks for '2x' multiplier:
```javascript
if (player.specialCards.includes('2x'))
  multiplier *= 2;
```

The code comments mention "3x" was removed, but if somehow a "3x" card gets into specialCards (via old save data or client-side bug), it will be silently ignored and not contribute to score.

**Recommendation**: Add a check/warning for unexpected multiplier values.

---

### BUG #8: SC (Second Chance) Display But Not Always Usable
**Severity**: MEDIUM  
**File**: [server.js](server.js#L710-L722), [client.js](client.js#L631)  
**Issue**: When a player draws a duplicate card and has Second Chance, the SC is immediately consumed and removed. But the client shows SC as a special card while the round is ongoing. If the data gets out of sync somehow, the client UI might show SC when it's not actually available.

---

### BUG #9: Score Calculation Uses Wrong Bonus
**Severity**: LOW  
**File**: [server.js](server.js#L704-L712)  
**Issue**: When a player reaches 7 regular cards by drawing a 0, they get +15 bonus points added directly to totalScore (line 712). But when they reach 7 by other means, the +15 is only added to totalScore after the round summary (line 544). This inconsistency could cause score tracking issues.

**Code**:
```javascript
if (player.regularCards.length === MAX_REGULAR_CARDS) {
  player.status = 'stood';
  player.totalScore += 15;  // ← Added immediately on hit 0
```

But in handleNumberCard for non-0 cards, no immediate bonus is added - only at round end.

---

### BUG #10: No Validation of Removed Card Count
**Severity**: LOW  
**File**: [server.js](server.js#L426-L463)  
**Issue**: The remove-card handler doesn't validate that both cardIndex bounds check or that the card actually exists before removing. If cardIndex is out of range, splice will just remove nothing silently. Could cause desync between client and server state.

**Recommendation**: Add bounds checking:
```javascript
if (isSpecial) {
  if (cardIndex < 0 || cardIndex >= target.specialCards.length) return;
  const removedCard = target.specialCards[cardIndex];
```

---

### BUG #11: Client-Side Game State Reconstruction is Fragile
**Severity**: LOW  
**File**: [client.js](client.js#L723-L765)  
**Issue**: The `getCurrentGameState()` function tries to reconstruct game state from DOM elements:
```javascript
const players = [...container.querySelectorAll('.player')].map(playerEl => {
  const status = playerEl.classList.contains('busted') ? 'busted' : ...
```

If the DOM gets out of sync with server state, or if rendering is buggy, this will return wrong data. Should rely on server state instead.

---

### BUG #12: Draw Three Logic with Special Cards Unclear
**Severity**: LOW  
**File**: [server.js](server.js#L238-L248)  
**Issue**: When a player has drawThreeRemaining > 0 and draws D3/Freeze/RC, they're stored as pending. But the flow is:
1. Draw number card → decrement drawThreeRemaining
2. Draw D3 → store as pending, decrement drawThreeRemaining  
3. When drawThreeRemaining === 0 → call handlePendingSpecialCard

But what if they draw a regular card that makes them bust or stand? The pending card is cleared. This might be intentional but it's not documented.

---

## LOW PRIORITY / RECOMMENDATIONS

### SUGGESTION #1: Add Input Validation
Consider adding validation for player names, card indices, game state before processing socket events.

### SUGGESTION #2: Add Event Logging
For debugging, log all significant events (freeze, special card use, deck reshuffle, etc.) with timestamps.

### SUGGESTION #3: Add Heartbeat/Keepalive
Monitor for disconnected players and clean up their game state automatically.

### SUGGESTION #4: Client-Server State Sync
Consider periodic server → client game state syncs to catch desync issues before they become visible bugs.

---

## TESTING RECOMMENDATIONS

1. **Test Freeze Card**: Freeze a player, verify they skip turn, unfreeze next round
2. **Test Select Card**: Draw Select, let timer expire without selecting, verify game recovers
3. **Test D3 Sequence**: Draw D3, then draw special cards in sequence, verify pending cards work
4. **Test Score Calculation**: Draw 0 to fill hand, verify +15 bonus applied; draw other cards to fill hand, verify bonus still applied
5. **Test RC on Special Cards**: Remove special cards from other players, verify UI and state sync
6. **Test Second Chance**: Get duplicate card with SC, verify SC is consumed and unavailable later

---

## SUMMARY

**CRITICAL**: 1 fixed (duplicate select-card-choice handlers)  
**HIGH**: 5 issues  
**MEDIUM**: 3 issues  
**LOW**: 4+ issues/suggestions  

**KEY BLOCKS**:  
- Frozen players can't unfreeze mid-round
- Select Card mode can hang game
- Race condition in deck reshuffling edge case
