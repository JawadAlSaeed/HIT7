const socket = io();
let currentGameId = null;
let isHost = false;
const MAX_REGULAR_CARDS = 7;
// Nothing caps how many special cards a hand can hold, so this is only how many
// empty placeholders the special grid draws — enough to keep the box a stable
// shape without padding it out to a full regular row of dead slots.
const SPECIAL_CARD_SLOTS = 4;
let activeFreezePopup = null;
let activeDrawThreePopup = null;
let soundEnabled = true;
let currentGameUrl = ""; // New: stores the game URL
let gameHistory = []; // Latest action log, kept in sync from every game update
let latestGame = null; // Last game state received, for popups that outlive one update

// ---------------------------------------------------------------------------
// Session, so a refresh or a dropped connection does not cost you your seat
// ---------------------------------------------------------------------------

// A socket id lasts exactly as long as one page, so it cannot identify a player who
// reloads. The server issues a token instead and this is where it is kept.
//
// sessionStorage, deliberately not localStorage: localStorage is shared by every tab on
// the origin, so a second tab would read the first tab's token and rejoin as them -
// two people playing on one computer would fight over one seat. sessionStorage is
// per-tab, which covers reloads and dropped connections. The cost is that closing the
// tab outright loses the seat.
const SESSION_KEY = 'hit7-session';

// These two are the opposite: deliberately in localStorage, because they outlive the tab
// on purpose. Neither is a credential - the name is a convenience and the game id only
// prefills the join form, so sharing them across tabs costs nothing.
const LAST_NAME_KEY = 'hit7-last-name';

function saveSession(gameId, token) {
    if (!gameId || !token) return;
    try {
        sessionStorage.setItem(SESSION_KEY, JSON.stringify({ gameId, token }));
    } catch (e) {
        // Private browsing can refuse storage. Reconnecting stops working, nothing else.
        console.warn('Could not save session:', e);
    }
}

function loadSession() {
    try {
        const raw = sessionStorage.getItem(SESSION_KEY);
        if (!raw) return null;
        const session = JSON.parse(raw);
        return (session && session.gameId && session.token) ? session : null;
    } catch (e) {
        return null;
    }
}

function clearSession() {
    try {
        sessionStorage.removeItem(SESSION_KEY);
    } catch (e) {
        /* nothing to clean up */
    }
}

// Every panel that draws a card - the remaining pile, the last card drawn, the
// history log - needs the same class and face for a given card, so they all read it
// from here instead of repeating the lookup.
const SPECIAL_CARD_VISUALS = {
    'SC':     { cardType: 'second-chance', displayValue: '🛡️' },
    'Freeze': { cardType: 'freeze',        displayValue: '❄️' },
    'D3':     { cardType: 'draw-three',    displayValue: '🎯' },
    'RC':     { cardType: 'remove-card',   displayValue: '🗑️' },
    'ST':     { cardType: 'steal-card',    displayValue: '🥷' },
    'Swap':   { cardType: 'swap-card',     displayValue: '⇄️' },
    'Select': { cardType: 'select-card',   displayValue: '🃏' },
    '2÷':     { cardType: 'divide',        displayValue: '2÷' },
    '2x':     { cardType: 'multiplier',    displayValue: '2x' }
};

function getCardVisual(card) {
    const cardStr = String(card);
    if (SPECIAL_CARD_VISUALS[cardStr]) return { ...SPECIAL_CARD_VISUALS[cardStr] };
    if (cardStr.endsWith('+')) return { cardType: 'adder', displayValue: cardStr };
    if (cardStr.endsWith('-')) return { cardType: 'minus', displayValue: cardStr };
    return { cardType: 'number', displayValue: cardStr };
}

// Player names are typed by other people and every panel here is built with
// innerHTML, so anything that came from another player goes through this first.
function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Remove initialization code
const initializeButtons = () => {
    console.log('Initializing buttons...');
    
    // Menu Buttons - Use direct onclick instead of addEventListener to prevent duplicates
    const createGameBtn = document.getElementById('createGame');
    const joinGameBtn = document.getElementById('joinGame');
    const tutorialBtn = document.getElementById('tutorialButton');
    
    if (createGameBtn) createGameBtn.onclick = function(e) {
        e.preventDefault();
        playSound('buttonClick');
        console.log('Create Game clicked');
        createGame();
    };
    
    if (joinGameBtn) joinGameBtn.onclick = function(e) {
        e.preventDefault();
        joinGame();
    };

    const nameInput = document.getElementById('playerName');
    const codeInput = document.getElementById('gameId');

    // Codes are stored and compared uppercase, so the field only ever holds uppercase -
    // otherwise "abc12" looks accepted and then fails.
    if (codeInput) codeInput.addEventListener('input', () => {
        const upper = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (codeInput.value !== upper) codeInput.value = upper;
        clearLobbyError();
    });

    if (nameInput) nameInput.addEventListener('input', clearLobbyError);

    // Enter submits whichever half of the form they are in: a code means join, no code
    // means create.
    document.getElementById('lobbyForm')?.addEventListener('submit', e => {
        e.preventDefault();
        if (codeInput?.value) joinGame(); else createGame();
    });

    if (tutorialBtn) tutorialBtn.onclick = function(e) {
        e.preventDefault();
        playSound('buttonClick');
        console.log('Tutorial clicked');
        showTutorial();
    };

    // Game Control Buttons - removed startGame button
    const flipCardBtn = document.getElementById('flipCard');
    const standBtn = document.getElementById('standButton');
    const resetBtn = document.getElementById('resetButton');

    if (flipCardBtn) flipCardBtn.onclick = function() {
        if (flipCardBtn.disabled) return;
        playSound('cardFlip');
        flipCard();
    };
    if (standBtn) standBtn.onclick = function() {
        if (standBtn.disabled) return;
        playSound('buttonClick');
        stand();
    };
    if (resetBtn) resetBtn.onclick = function() {
        showResetConfirmation();
    };
    
    const headerTutorialBtn = document.getElementById('headerTutorialBtn');
    if (headerTutorialBtn) headerTutorialBtn.onclick = function() {
        playSound('buttonClick');
        showTutorial();
    };

    const historyBtn = document.getElementById('historyButton');
    if (historyBtn) historyBtn.onclick = function() {
        playSound('buttonClick');
        showHistory();
    };
    
    console.log('Button initialization complete');
};

// Initialize only once when the DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    initializeButtons();
    initSound();
    initMobileChrome();
    checkUrlParams();
});

// Popups fade their backdrop and shrink their sheet on the way out rather than
// vanishing. Closing runs faster than opening - getting out of the way should
// never feel slow.
function dismissPopup(popup) {
    if (!popup || !popup.parentElement || popup.classList.contains('popup-closing')) return;

    popup.classList.add('popup-closing');
    popup.style.pointerEvents = 'none';

    const done = () => popup.remove();
    const content = popup.querySelector('.popup-content');

    if (content) {
        content.addEventListener('transitionend', done, { once: true });
    }
    // transitionend never fires with reduced motion or on a hidden tab, and the
    // popup must not be left stranded on screen.
    setTimeout(done, 220);
}

// Peeking at the board from inside a target-picker popup.
//
// With a mouse you hold the button down, look, and let go. A finger cannot do
// that usefully: while it is held down you cannot tap anything you just looked
// at, and a touch that got cancelled (a scroll, a notification) never fired
// touchend, which left the popup invisible *and* click-through-proof for the
// rest of the round. So coarse pointers get a tap toggle instead, and the hold
// path keeps its pointer with setPointerCapture so the release always lands.
function wireViewGameButton(popup) {
    const viewButton = popup.querySelector('#viewGameButton');
    if (!viewButton) return;

    const setLabel = (text) => {
        viewButton.innerHTML = '<span class="icon">\u{1F441}\u{FE0F}</span> ' + text;
    };

    if (window.matchMedia('(pointer: coarse)').matches) {
        setLabel('Tap to view game');
        viewButton.setAttribute('aria-pressed', 'false');

        viewButton.addEventListener('click', (e) => {
            e.preventDefault();
            // popup-peeking keeps this one button lit and tappable while the
            // rest of the sheet steps aside - popup-hiding would take the
            // button with it and there would be no way back.
            const peeking = popup.classList.toggle('popup-peeking');
            viewButton.setAttribute('aria-pressed', peeking ? 'true' : 'false');
            setLabel(peeking ? 'Tap to hide board' : 'Tap to view game');
        });
        return;
    }

    const show = () => popup.classList.remove('popup-hiding');

    viewButton.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        // Capture means the matching pointerup is delivered here even though
        // popup-hiding sets pointer-events: none on the popup.
        try { viewButton.setPointerCapture(e.pointerId); } catch (err) { /* no capture; the listeners below still fire */ }
        popup.classList.add('popup-hiding');
    });

    // Every way a press can end, including the ones that used to strand the
    // popup. All on the button itself, so they die with the popup.
    ['pointerup', 'pointercancel', 'lostpointercapture', 'mouseleave'].forEach(
        (type) => viewButton.addEventListener(type, show)
    );
}

// Socket event listeners
socket.on('game-created', handleGameCreated);
socket.on('game-joined', handleGameJoined);
socket.on('game-update', handleGameUpdate);
socket.on('game-started', handleGameStarted);
socket.on('new-round', handleNewRound);
socket.on('game-over', handleGameOver);
socket.on('all-busted', handleAllBusted);
socket.on('game-reset', handleGameReset);
socket.on('error', handleError);
socket.on('round-summary', handleRoundSummary);
socket.on('rejoined', handleRejoined);
socket.on('rejoin-failed', handleRejoinFailed);
socket.on('round-restarted', handleRoundRestarted);

// Fires on the first connection and again after every reconnect, so it is the one place
// that can put a returning player back in their seat - whether they reloaded the page or
// just went through a tunnel.
socket.on('connect', () => {
    hideConnectionLostOverlay();
    const session = loadSession();
    if (session) socket.emit('rejoin-game', session.gameId, session.token);
});

// socket.io retries on its own; this only tells the player why the game stopped
// responding, so they do not start mashing buttons.
socket.on('disconnect', () => {
    if (loadSession()) showConnectionLostOverlay();
});
socket.on('cancel-freeze', () => {
  if (activeFreezePopup) {
    activeFreezePopup.remove();
    activeFreezePopup = null;
  }
});

socket.on('select-freeze-target', (gameId, targets) => {
  // Disable action buttons during popup
  document.body.style.overflow = 'hidden';
  toggleActionButtons(false);
  
  // Remove any existing popups
  document.querySelectorAll('.freeze-popup').forEach(p => p.remove());
  
  const popup = document.createElement('div');
  popup.className = 'freeze-popup active';
  popup.innerHTML = `
    <div class="popup-content">
      <h3><span class="emoji">❄️</span> Select player to freeze:</h3>
      <div class="freeze-targets">
        ${targets.map(p => `
          <button class="freeze-target ${p.id === socket.id ? 'self-target' : ''}" data-id="${p.id}">
            ${escapeHtml(p.name)} ${p.id === socket.id ? '(You)' : ''}
          </button>
        `).join('')}
      </div>
      <button class="view-game-button" id="viewGameButton">
        <span class="icon">👁️</span> Hold to view game
      </button>
    </div>
  `;

  popup.querySelectorAll('.freeze-target').forEach(btn => {
    btn.addEventListener('click', () => {
      socket.emit('freeze-player', currentGameId, btn.dataset.id);
      dismissPopup(popup);
    });
  });

  wireViewGameButton(popup);

  document.body.appendChild(popup);
});

// draw-three popup handler (single instance kept earlier in file)

// keep a single connect/disconnect handler
socket.on('connect', () => console.log('Connected to server'));
socket.on('disconnect', () => alert('Lost connection to server!'));

// Add this with the other socket event listeners at the top
socket.on('rematch-started', (game) => {
    const popups = document.querySelectorAll('.winner-popup');
    popups.forEach(popup => popup.remove());
    
    // Clear the board for new game
    clearPlayersBoard();
    
    // Update game display
    updateGameDisplay(game);
    
    // Check if it's the current player's turn
    const isCurrentPlayer = game.players[game.currentPlayer]?.id === socket.id;
    toggleActionButtons(isCurrentPlayer && game.status === 'playing');
});

// Add new socket listener for sounds
socket.on('play-sound', (soundId) => {
    playSound(soundId);
});

// Add this new event listener with the other socket listeners
socket.on('game-reset-with-players', (game) => {
    // Clear any existing popups
    const popups = document.querySelectorAll('.winner-popup, .round-summary-popup, .info-popup');
    popups.forEach(popup => popup.remove());
    
    // Clear the board for new game
    clearPlayersBoard();
    
    // Update game display
    updateGameDisplay(game);
    
    // Check if it's the current player's turn
    const isCurrentPlayer = game.players[game.currentPlayer]?.id === socket.id;
    toggleActionButtons(isCurrentPlayer && game.status === 'playing');
    
    // Show a notification
    const notification = document.createElement('div');
    notification.className = 'info-popup';
    notification.innerHTML = `
        <h2>⇄ Game Reset!</h2>
        <p class="popup-countdown">Starting new game...</p>
    `;
    document.body.appendChild(notification);
    
    // Remove notification after 2 seconds
    setTimeout(() => {
        notification.remove();
    }, 2000);
});

// Add select-card-from-pile event listener with other socket listeners
socket.on('select-card-from-pile', (gameId, deck, fullDeck) => {
  // Disable action buttons during popup
  document.body.style.overflow = 'hidden';
  toggleActionButtons(false);
  showSelectCardPopup(gameId, deck, fullDeck);
});

// Game actions
// ---------------------------------------------------------------------------
// Landing page
// ---------------------------------------------------------------------------

const MIN_NAME_LENGTH = 3;

// Errors show under the form rather than in an alert(), which on a phone covers the very
// field the player has to fix.
function showLobbyError(message, focusId) {
    const el = document.getElementById('lobbyError');
    if (el) {
        el.textContent = message;
        el.hidden = false;
    }
    if (focusId) document.getElementById(focusId)?.focus();
}

function clearLobbyError() {
    const el = document.getElementById('lobbyError');
    if (el) {
        el.textContent = '';
        el.hidden = true;
    }
}

function readPlayerName() {
    const input = document.getElementById('playerName');
    const name = (input?.value || '').trim().replace(/\s+/g, ' ');
    if (name.length < MIN_NAME_LENGTH) {
        showLobbyError(`Your name needs at least ${MIN_NAME_LENGTH} characters.`, 'playerName');
        return null;
    }
    // Remembered so a returning player does not retype it, and so the rejoin banner can
    // say who they were.
    try { localStorage.setItem(LAST_NAME_KEY, name); } catch (e) { /* not important */ }
    return name;
}

function readGameCode() {
    const input = document.getElementById('gameId');
    const code = (input?.value || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{5}$/.test(code)) {
        showLobbyError('A game code is 5 letters and numbers, like ABC12.', 'gameId');
        return null;
    }
    return code;
}

function createGame() {
    playSound('buttonClick');
    clearLobbyError();

    const name = readPlayerName();
    if (!name) return;

    // Clear any existing game state
    currentGameId = null;
    clearPlayersBoard();

    socket.emit('create-game', name);
}

// One form, one button. The server decides whether this code means "join this lobby" or
// "give me back the seat I left", because the player has already told it their name -
// which is the only thing that distinguishes those two cases.
function joinGame() {
    playSound('buttonClick');
    clearLobbyError();

    const name = readPlayerName();
    if (!name) return;

    const code = readGameCode();
    if (!code) return;

    socket.emit('join-game', code, name);
}

function startGame() { 
    playSound('buttonClick');
    socket.emit('start-game', currentGameId); 
}

// Modify flip card function to broadcast flip sound
function flipCard() { 
    playSound('cardFlip');
    socket.emit('play-sound', currentGameId, 'cardFlip');
    socket.emit('flip-card', currentGameId); 
}

// Modify stand function to let server handle sound
function stand() { 
    socket.emit('stand', currentGameId); 
}

// Modify resetGame function to remove the confirmation
function resetGame() {
    playSound('buttonClick');
    socket.emit('reset-game', currentGameId);
}

// Game state handlers
function handleGameCreated({ gameId, gameUrl, token }) {
    console.log('Game created with URL:', gameUrl);
    currentGameId = gameId;
    currentGameUrl = gameUrl; // Store URL for later copying
    isHost = true;
    saveSession(gameId, token);

    // Hide lobby screen
    document.querySelector('.lobby-screen').style.display = 'none';

    // Show waiting screen instead of game area
    showWaitingScreen({
        players: [{ name: 'You (Host)', id: socket.id }],
        hostId: socket.id
    });
}

function copyShareLink() {
  // Prefer the visible share input if present
  const shareInput = document.getElementById('shareLinkInput');
  let link = shareInput?.value || currentGameUrl || (currentGameId ? `${window.location.origin}/join/${currentGameId}` : '');
  if (!link) return alert('No share link available');

  const canUseClipboard = !!(navigator.clipboard && window.isSecureContext);
  if (canUseClipboard) {
    navigator.clipboard.writeText(link).then(() => {
      showCopyConfirmationInButton();
    }).catch(err => {
      console.error('Clipboard API failed, falling back:', err);
      fallbackCopyLink(link, shareInput);
    });
    return;
  }

  fallbackCopyLink(link, shareInput);
}

function fallbackCopyLink(link, shareInput) {
  if (shareInput) {
    shareInput.focus();
    shareInput.select();
    shareInput.setSelectionRange(0, link.length);
  }

  const tempInput = document.createElement('textarea');
  tempInput.value = link;
  tempInput.setAttribute('readonly', '');
  tempInput.style.position = 'absolute';
  tempInput.style.left = '-9999px';
  document.body.appendChild(tempInput);
  tempInput.select();

  try {
    const copied = document.execCommand('copy');
    if (!copied) throw new Error('execCommand returned false');
    showCopyConfirmationInButton();
  } catch (err) {
    console.error('Fallback copy failed:', err);
    alert('Failed to copy the link. Please copy it manually.');
  } finally {
    document.body.removeChild(tempInput);
  }
}

function showCopyConfirmationInButton() {
    const copyButton = document.querySelector('.game-button.copy-link-btn');
    if (!copyButton) return;

    const originalText = copyButton.textContent;
    copyButton.textContent = 'Link copied!';

    setTimeout(() => {
        copyButton.textContent = originalText;
    }, 2000);
}

// Remove bust sound from handleGameUpdate since server will handle it
function handleGameUpdate(game) {
    latestGame = game;
    const waitingScreen = document.getElementById('waitingScreen');
    const resetButton = document.getElementById('resetButton');

    // Show/hide reset button based on host status
    if (resetButton) {
        resetButton.style.display = socket.id === game.hostId ? 'block' : 'none';
    }

    // Update deck count immediately
    document.getElementById('deckCount').textContent = game.deck.length;
    // Update the remaining pile display immediately
    updateRemainingPile(game.deck);
    // Update the last card drawn
    updateLastCardDrawn(game.lastCardDrawn);
    // Keep the action log current whether or not the popup is open
    updateHistory(game.history);
    updateDisconnectNotice(game);

    if (game.status === 'lobby') {
        // Update waiting screen if it exists
        if (waitingScreen) {
            const playersList = waitingScreen.querySelector('.players-list');
            if (playersList) {
                playersList.innerHTML = game.players.map(player => `
                    <div class="player-item">
                        ${escapeHtml(player.name)}
                        ${player.id === game.hostId ? 
                            '<span class="host-badge">HOST</span>' : ''}
                    </div>
                `).join('');
            }
            // Always update the start button when we get a game update in lobby
        // Update share link input too
        const shareInput = waitingScreen.querySelector('#shareLinkInput');
        if (shareInput) {
          shareInput.value = currentGameUrl || (window.location.origin + '/join/' + (game.id || currentGameId || ''));
        }
        if (isHost) updateStartButton(game.players.length);
        } else {
            // Show waiting screen if it doesn't exist
            showWaitingScreen(game);
        }
    } else {
        // Remove waiting screen and show game when started
        if (waitingScreen) {
            waitingScreen.remove();
        }
        // Update game display as before
        isHost = socket.id === game.hostId;
        const isCurrentPlayer = game.players[game.currentPlayer]?.id === socket.id;
        // The server refuses every action while someone is missing, so the buttons have
        // to say so rather than looking live and doing nothing.
        const paused = game.players.some(p => !p.connected);
        const canAct = isCurrentPlayer && game.status === 'playing' && !paused;

        updateGameDisplay(game);
        toggleActionButtons(canAct);
        
        document.getElementById('gameArea').style.display = 'flex';
        document.querySelector('.controls').style.display = 'flex';
    }
}

// Display updates
function updateGameDisplay(game) {
    // Kept so the disconnect popup's own timer has something to redraw from between
    // game updates.
    latestGame = game;
    document.getElementById('deckCount').textContent = game.deck.length;
    updateRemainingPile(game.deck);
    updateLastCardDrawn(game.lastCardDrawn);
    updateDeckButton(game.deck, game.lastCardDrawn);
    updateHistory(game.history);
    renderPlayers(game);
}

function updateRemainingPile(deck) {
    const cardCounts = deck.reduce((acc, card) => {
        const key = card.toString();
        acc[key] = (acc[key] || 0) + 1;
        return acc;
    }, {});

    const regularCards = [];
    const specialCards = [];

    // Helper function to get sort order for special cards - updated order
    const getSpecialCardOrder = card => {
        const specialOrder = {
            'Select': 1,    // 1. Select Card
            'SC': 2,        // 2. Second Chance
            'Freeze': 3,    // 3. Freeze
            'D3': 4,        // 4. Draw Three
          'RC': 5,        // 5. Remove Card
          'ST': 6,        // 6. Steal Card
          'Swap': 7,      // 7. Swap Card
          '2+': 8,        // 8. 2+
          '4+': 9,        // 9. 4+
          '6+': 10,       // 10. 6+
          '8+': 11,       // 11. 8+
          '10+': 12,      // 12. 10+
          '2x': 13,       // 13. 2x Multiplier
          '2-': 14,       // 14. 2-
          '4-': 15,       // 15. 4-
          '6-': 16,       // 16. 6-
          '8-': 17,       // 17. 8-
          '10-': 18,      // 18. 10-
          '2÷': 19,       // 19. 2÷ Divide
        };
        return specialOrder[card] || 99;  // Default high number for unknown cards
    };

    Object.entries(cardCounts).forEach(([cardStr, count]) => {
        const { cardType, displayValue } = getCardVisual(cardStr);
        const entry = { cardStr, count, cardType, displayValue };
        if (cardType === 'number') {
            regularCards.push(entry);
        } else {
            specialCards.push(entry);
        }
    });

    // Sort regular cards by number
    regularCards.sort((a, b) => Number(a.cardStr) - Number(b.cardStr));
    
    // Sort special cards by predefined order
    specialCards.sort((a, b) => {
        const orderA = getSpecialCardOrder(a.cardStr);
        const orderB = getSpecialCardOrder(b.cardStr);
        return orderA - orderB;
    });

    document.getElementById('discard').innerHTML = `
        <div class="regular-cards">
            ${regularCards.map(card => renderCard(card)).join('')}
        </div>
        <div class="special-cards">
            ${specialCards.map(card => renderCard(card)).join('')}
        </div>
    `;
}

// Colour comes from the [data-card-type] rules in style.css - see the "Card appearance"
// block at the bottom of that file. Nothing here needs to know what a card looks like.
function renderCard({ cardType, displayValue, count }) {
    return `
        <div class="remaining-card ${cardType} ${cardType === 'number' ? 'regular-card' : 'special'}"
             data-card-type="${cardType}">
            ${displayValue}
            ${count > 1 ? `<span class="card-count">×${count}</span>` : ''}
        </div>
    `;
}

function updateLastCardDrawn(card) {
    const container = document.getElementById('lastCardDrawn');
    if (!container) return;

    const key = card === null || card === undefined ? '' : String(card);

    // Nothing changed, so leave the node alone - rewriting it would replay the
    // entrance animation on every unrelated game update.
    if (container.dataset.value === key) return;

    const outgoing = container.querySelector('.last-card');
    container.dataset.value = key;

    if (!key) {
        container.innerHTML = '<span class="no-card">---</span>';
        return;
    }

    const { cardType, displayValue } = getCardVisual(card);
    const incoming = document.createElement('div');
    incoming.className = `last-card ${cardType} ${cardType === 'number' ? 'regular-card' : 'special'}`;
    // Colour comes from the [data-card-type] rules in style.css.
    incoming.dataset.cardType = cardType;
    incoming.textContent = displayValue;

    // The old card lifts out while the new one deals in, so you can always tell
    // the slot changed even when the two cards look similar.
    if (outgoing && !prefersReducedMotion()) {
        outgoing.classList.add('is-leaving');
        outgoing.addEventListener('animationend', () => outgoing.remove(), { once: true });
        setTimeout(() => outgoing.remove(), 400);
        incoming.classList.add('is-new');
        clearAfter(incoming, 'is-new', 600);
        container.appendChild(incoming);
    } else {
        container.innerHTML = '';
        container.appendChild(incoming);
    }
}

// ---------------------------------------------------------------------------
// Action history log
// ---------------------------------------------------------------------------

const HISTORY_ICONS = {
    'draw': '🎴',
    'select': '🃏',
    'bust': '💥',
    'second-chance': '🛡️',
    'stand': '✋',
    'seven-bonus': '🌟',
    'freeze': '❄️',
    'draw-three': '🎯',
    'remove': '🗑️',
    'steal': '🥷',
    'swap': '⇄️',
    'discard': '♻️',
    'reshuffle': '🔀',
    'round-start': '▶️',
    'round-end': '🏁',
    'round-restart': '🔄',
    'game-over': '🏆',
    'left': '🚪',
    'disconnected': '🔌',
    'reconnected': '🔗',
    'kicked': '🥾'
};

function renderHistoryCard(card) {
    const { cardType, displayValue } = getCardVisual(card);
    return `<span class="history-card ${cardType}" data-card-type="${cardType}">${escapeHtml(displayValue)}</span>`;
}

// The server logs only what happened; the wording lives here so the log reads the
// same way the rest of the UI talks about cards.
function formatHistoryEntry(entry) {
    const name = value => `<span class="history-player">${escapeHtml(value || '')}</span>`;
    const player = name(entry.player);
    const target = name(entry.target);
    const target2 = name(entry.target2);
    const cards = (entry.cards || []).map(renderHistoryCard);

    switch (entry.action) {
        case 'draw':          return `${player} drew ${cards[0] || ''}`;
        case 'select':        return `${player} picked ${cards[0] || ''} out of the deck`;
        case 'bust':          return `${player} <span class="history-bad">BUSTED</span> on ${cards[0] || ''}`;
        case 'second-chance': return `${player} burned 🛡️ to survive ${cards[0] || ''}`;
        case 'stand':         return `${player} stood`;
        case 'seven-bonus':   return `${player} filled all 7 cards <span class="history-good">+15</span>`;
        case 'freeze':        return `${player} froze ${target}`;
        case 'draw-three':    return `${player} made ${target} draw three`;
        case 'remove':        return `${player} removed ${cards[0] || ''} from ${target}`;
        case 'steal':         return `${player} stole ${cards[0] || ''} from ${target}`;
        case 'swap': {
            // The swapper is usually one of the two sides, and "Alice swapped Alice's
            // card" reads badly.
            const owner1 = entry.target === entry.player ? 'their own' : `${target}'s`;
            const owner2 = entry.target2 === entry.player ? 'their own' : `${target2}'s`;
            return `${player} swapped ${owner1} ${cards[0] || ''} with ${owner2} ${cards[1] || ''}`;
        }
        case 'discard':       return `${player} discarded ${cards[0] || ''} — no valid target`;
        case 'reshuffle':     return `The deck ran out and was reshuffled`;
        case 'round-start':   return `Round ${entry.round} started`;
        case 'round-end':     return `Round ${entry.round} ended`;
        case 'round-restart': return `Round ${entry.round} <span class="history-bad">restarted</span> from the beginning`;
        case 'game-over':     return `${player} <span class="history-good">won the game!</span>`;
        case 'left':          return `${player} left the game`;
        case 'disconnected':  return `${player} <span class="history-bad">lost connection</span> — round paused`;
        case 'reconnected':   return `${player} <span class="history-good">is back</span>`;
        case 'kicked':        return `${player} was removed by the host`;
        default:              return `${player} ${escapeHtml(entry.action || '')}`;
    }
}

function renderHistoryList(listEl) {
    if (!listEl) return;

    if (!gameHistory.length) {
        listEl.innerHTML = '<p class="history-empty">Nothing has happened yet — flip a card!</p>';
        return;
    }

    // Newest first, so the last thing that happened is the first thing you read.
    let lastRound = null;
    listEl.innerHTML = [...gameHistory].reverse().map(entry => {
        const divider = entry.round !== lastRound
            ? `<div class="history-round-divider">Round ${entry.round}</div>`
            : '';
        lastRound = entry.round;
        return `
            ${divider}
            <div class="history-entry action-${entry.action}">
                <span class="history-icon">${HISTORY_ICONS[entry.action] || '•'}</span>
                <span class="history-text">${formatHistoryEntry(entry)}</span>
            </div>
        `;
    }).join('');
}

function updateHistory(history) {
    gameHistory = Array.isArray(history) ? history : [];

    const openPopup = document.querySelector('.history-popup');
    if (!openPopup) return;

    // Re-rendering in place resets the scroll box, which would yank the log out from
    // under anyone reading back through an earlier round.
    const scroller = openPopup.querySelector('.history-content');
    const previousScroll = scroller ? scroller.scrollTop : 0;
    renderHistoryList(openPopup.querySelector('.history-list'));
    if (scroller) scroller.scrollTop = previousScroll;
}

function showHistory() {
    const existingPopup = document.querySelector('.history-popup');
    if (existingPopup) existingPopup.remove();

    const popup = document.createElement('div');
    popup.className = 'history-popup';
    popup.innerHTML = `
        <div class="popup-content">
            <button class="close-button">×</button>
            <h2 class="history-title">GAME HISTORY</h2>
            <div class="history-content">
                <div class="history-list"></div>
            </div>
        </div>
    `;

    renderHistoryList(popup.querySelector('.history-list'));

    const closePopup = () => {
        dismissPopup(popup);
        document.removeEventListener('keydown', handleEscape);
    };

    const handleEscape = (e) => {
        if (e.key === 'Escape') closePopup();
    };

    popup.querySelector('.close-button').addEventListener('click', () => {
        playSound('buttonClick');
        closePopup();
    });

    // Tapping the backdrop closes too - the log is read-only, so there is nothing to lose.
    popup.addEventListener('click', (e) => {
        if (e.target === popup) closePopup();
    });

    document.addEventListener('keydown', handleEscape);
    document.body.appendChild(popup);
}

// ---------------------------------------------------------------------------
// Disconnects: holding the round open until everyone is back
// ---------------------------------------------------------------------------

// disconnectedAt comes off the server clock, which is not this browser's clock, so how
// long somebody has been gone is measured from when this page first saw it instead.
const disconnectSeenAt = new Map();
let disconnectTicker = null;

function formatElapsed(ms) {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ${seconds % 60}s`;
}

function renderDisconnectRows(popup, game) {
    const missing = game.players.filter(p => !p.connected);
    const listEl = popup.querySelector('.disconnect-list');
    if (!listEl) return;

    // The host may be a stand-in while the original host is the one who dropped.
    const amHost = socket.id === game.hostId;

    listEl.innerHTML = missing.map(player => {
        const since = disconnectSeenAt.get(player.id);
        const elapsed = since ? formatElapsed(Date.now() - since) : '';
        return `
            <div class="disconnect-row">
                <span class="disconnect-name">${escapeHtml(player.name)}</span>
                <span class="disconnect-elapsed">${elapsed ? `away ${elapsed}` : 'away'}</span>
                ${amHost ? `
                    <button class="game-button red kick-button" data-id="${escapeHtml(player.id)}">
                        Remove &amp; restart round
                    </button>
                ` : ''}
            </div>
        `;
    }).join('');

    const hintEl = popup.querySelector('.disconnect-hint');
    if (hintEl) {
        hintEl.textContent = amHost
            ? 'Removing a player replays this round from the start. Scores from earlier rounds are kept.'
            : 'The host can remove them and restart the round.';
    }

    listEl.querySelectorAll('.kick-button').forEach(btn => {
        btn.addEventListener('click', () => {
            const name = missing.find(p => p.id === btn.dataset.id)?.name || 'this player';
            // Kicking throws away the round everyone is part-way through, so it is worth
            // one confirmation.
            if (!confirm(`Remove ${name} and restart round ${game.roundNumber}?`)) return;
            playSound('buttonClick');
            btn.disabled = true;
            socket.emit('kick-player', currentGameId, btn.dataset.id);
        });
    });
}

function updateDisconnectNotice(game) {
    const missing = game.players.filter(p => !p.connected);

    // Stamp arrivals and forget anyone who came back or was removed.
    const missingIds = new Set(missing.map(p => p.id));
    missing.forEach(p => {
        if (!disconnectSeenAt.has(p.id)) disconnectSeenAt.set(p.id, Date.now());
    });
    [...disconnectSeenAt.keys()].forEach(id => {
        if (!missingIds.has(id)) disconnectSeenAt.delete(id);
    });

    const existing = document.querySelector('.disconnect-popup');

    // Only a round in progress has anything to hold open. In the lobby a missing player
    // is simply gone.
    if (!missing.length || game.status !== 'playing') {
        if (existing) existing.remove();
        if (disconnectTicker) {
            clearInterval(disconnectTicker);
            disconnectTicker = null;
        }
        return;
    }

    let popup = existing;
    if (!popup) {
        popup = document.createElement('div');
        popup.className = 'disconnect-popup';
        popup.innerHTML = `
            <div class="popup-content">
                <div class="loading-spinner"></div>
                <h2>⏳ WAITING FOR PLAYERS</h2>
                <p class="disconnect-lead">Someone lost their connection. The round is
                    paused so nobody loses their cards.</p>
                <div class="disconnect-list"></div>
                <p class="disconnect-hint"></p>
            </div>
        `;
        document.body.appendChild(popup);

        // Redrawn on a timer as well as on updates, because the elapsed time keeps
        // moving while the game state sits still.
        disconnectTicker = setInterval(() => {
            const live = document.querySelector('.disconnect-popup');
            if (live && latestGame) renderDisconnectRows(live, latestGame);
        }, 1000);
    }

    renderDisconnectRows(popup, game);
}

// This player's own connection, which is a different problem: there is no game state
// arriving to drive a popup, so it is put up and taken down by the socket events.
function showConnectionLostOverlay() {
    if (document.querySelector('.connection-lost-popup')) return;

    const popup = document.createElement('div');
    popup.className = 'connection-lost-popup';
    popup.innerHTML = `
        <div class="popup-content">
            <div class="loading-spinner"></div>
            <h2>🔌 RECONNECTING</h2>
            <p>You lost your connection. Your cards and score are being held —
                this will pick up where you left off.</p>
        </div>
    `;
    document.body.appendChild(popup);
}

function hideConnectionLostOverlay() {
    document.querySelectorAll('.connection-lost-popup').forEach(p => p.remove());
}

function showRoundRestartedNotice(roundNumber) {
    document.querySelectorAll('.restart-notice').forEach(n => n.remove());

    const notice = document.createElement('div');
    notice.className = 'restart-notice';
    notice.innerHTML = `
        <strong>Round ${roundNumber} restarted</strong>
        <span>A player was removed. Hands are cleared; earlier scores are kept.</span>
    `;
    document.body.appendChild(notice);
    setTimeout(() => notice.remove(), 5000);
}

// ---------------------------------------------------------------------------
// Player rendering
//
// This reconciles the existing DOM instead of replacing playersContainer's
// innerHTML. Two reasons: a card that was already on the table must not
// re-run its entrance animation every time anything else changes, and
// rebuilding the whole board on every update was already causing a visible
// flicker.
// ---------------------------------------------------------------------------

// What each player looked like on the previous update, so we can tell which
// cards are new and which status changes deserve a reaction.
const lastPlayerState = new Map();

// Wiping the board has to drop the remembered state too, otherwise the next
// render compares fresh panels against a dead game's scores.
function clearPlayersBoard() {
    ['playersContainer', 'opponentRail', 'myHand'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = '';
    });
    lastPlayerState.clear();
}

// Phones get a different shape entirely: your own hand fills the screen, the
// other players compress into a tap-to-open rail. Anything wider keeps the
// board where every panel is equal.
// Must stay identical to the media query mobile.css opens with, or the rail and
// hand get styled but never filled. A landscape phone is wide but short, so
// width alone would misread it as a desktop.
const PHONE_QUERY = window.matchMedia(
    '(max-width: 767px), (orientation: landscape) and (max-height: 500px) and (pointer: coarse)'
);

function isPhoneLayout() {
    return PHONE_QUERY.matches;
}

function renderPlayers(game) {
    // Panels left in the container the other layout owns would sit there
    // forever, so every render evicts them rather than trusting the
    // breakpoint listener to have fired. Rotating a phone mid-game, or any
    // missed change event, self-corrects on the next update.
    const phone = isPhoneLayout();
    const stale = phone
        ? ['playersContainer']
        : ['opponentRail', 'myHand'];

    stale.forEach(id => {
        const el = document.getElementById(id);
        if (el && el.children.length) {
            el.innerHTML = '';
            lastPlayerState.clear();
        }
    });

    if (phone) {
        renderPlayersPhone(game);
    } else {
        renderPlayersBoard(game);
    }
    updateTurnStrip(game);
    refreshOpenPlayerSheet(game);
}

// Desktop / tablet: one equal panel per player, in seat order.
function renderPlayersBoard(game) {
    const container = document.getElementById('playersContainer');
    if (!container) return;

    const seen = new Set();

    game.players.forEach((player, index) => {
        seen.add(player.id);

        let panel = container.querySelector(`.player[data-player-id="${cssEscape(player.id)}"]`);
        const isNewPanel = !panel;
        if (isNewPanel) {
            panel = buildPlayerPanel(player);
            container.appendChild(panel);
        }

        // Put the panel at its seat. Only touch the DOM when it is actually in
        // the wrong place — moving a node restarts its animations.
        if (container.children[index] !== panel) {
            container.insertBefore(panel, container.children[index] || null);
        }

        syncPlayerPanel(panel, player, index === game.currentPlayer, isNewPanel);
    });

    // Drop players who left.
    [...container.querySelectorAll('.player')].forEach(panel => {
        const id = panel.dataset.playerId;
        if (!seen.has(id)) {
            panel.remove();
            lastPlayerState.delete(id);
        }
    });
}

// Phone: my panel goes in #myHand at full size, everyone else becomes a tile.
function renderPlayersPhone(game) {
    const hand = document.getElementById('myHand');
    const rail = document.getElementById('opponentRail');
    if (!hand || !rail) return;

    const meIndex = game.players.findIndex(p => p.id === socket.id);
    const me = meIndex >= 0 ? game.players[meIndex] : null;

    if (me) {
        let panel = hand.querySelector(`.player[data-player-id="${cssEscape(me.id)}"]`);
        const isNewPanel = !panel;
        if (isNewPanel) {
            hand.innerHTML = '';
            panel = buildPlayerPanel(me);
            panel.classList.add('is-me');
            hand.appendChild(panel);
        }
        syncPlayerPanel(panel, me, meIndex === game.currentPlayer, isNewPanel);
    } else {
        // Spectator, or the seat is gone: fall back to showing everyone.
        hand.innerHTML = '';
    }

    const opponents = game.players.filter(p => p.id !== socket.id);
    const seen = new Set();

    opponents.forEach((player, index) => {
        seen.add(player.id);

        let tile = rail.querySelector(`.opp-tile[data-player-id="${cssEscape(player.id)}"]`);
        if (!tile) {
            tile = buildOpponentTile(player);
            rail.appendChild(tile);
        }
        if (rail.children[index] !== tile) {
            rail.insertBefore(tile, rail.children[index] || null);
        }

        const isTheirTurn = game.players[game.currentPlayer]?.id === player.id;
        syncOpponentTile(tile, player, isTheirTurn);
    });

    [...rail.querySelectorAll('.opp-tile')].forEach(tile => {
        if (!seen.has(tile.dataset.playerId)) tile.remove();
    });
}

function buildOpponentTile(player) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'opp-tile';
    tile.dataset.playerId = player.id;
    tile.innerHTML = `
        <span class="opp-name"></span>
        <span class="opp-score"></span>
        <span class="opp-status"></span>
        <span class="opp-pips">${Array.from({ length: MAX_REGULAR_CARDS }, () => '<i></i>').join('')}</span>
    `;
    tile.addEventListener('click', () => openPlayerSheet(player.id));
    return tile;
}

function syncOpponentTile(tile, player, isTheirTurn) {
    tile.classList.toggle('turn-now', isTheirTurn);
    tile.classList.toggle('is-out', player.status === 'busted' || player.status === 'stood');
    tile.classList.toggle('is-away', player.connected === false);

    setText(tile.querySelector('.opp-name'), player.name);
    setText(tile.querySelector('.opp-score'), player.roundScore);

    const [icon, label] = STATUS_PARTS[player.status] || ['', ''];
    setText(tile.querySelector('.opp-status'), `${icon} ${label}`);

    const pips = tile.querySelectorAll('.opp-pips i');
    pips.forEach((pip, i) => pip.classList.toggle('on', i < player.regularCards.length));

    tile.setAttribute('aria-label',
        `${player.name}, ${label.toLowerCase()}, ${player.roundScore} points, ${player.regularCards.length} cards. Tap to see their hand.`);
}

const STATUS_PARTS = {
    active: ['⭐', 'ACTIVE'],
    stood: ['🛑', 'STOOD'],
    busted: ['💥', 'BUSTED'],
    waiting: ['⏳', 'WAITING'],
    frozen: ['❄️', 'FROZEN']
};

// ---------------------------------------------------------------------------
// Opponent sheet — the full hand behind a tap
// ---------------------------------------------------------------------------

function openPlayerSheet(playerId) {
    playSound('buttonClick');
    document.querySelectorAll('.player-sheet').forEach(s => s.remove());

    const game = latestGame;
    const player = game?.players.find(p => p.id === playerId);
    if (!player) return;

    const sheet = document.createElement('div');
    sheet.className = 'player-sheet';
    sheet.dataset.playerId = playerId;
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-label', `${player.name}'s hand`);
    sheet.innerHTML = `
        <div class="popup-content">
            <div class="sheet-grab"></div>
            <button class="close-button" aria-label="Close">✕</button>
            <div class="sheet-body"></div>
        </div>
    `;

    const body = sheet.querySelector('.sheet-body');
    const panel = buildPlayerPanel(player);
    body.appendChild(panel);
    // trackState:false — the rail and hand own lastPlayerState; a sheet render
    // must not overwrite it or the next real update loses its "what's new" diff.
    syncPlayerPanel(panel, player, false, true, false);

    const close = () => dismissPopup(sheet);
    sheet.querySelector('.close-button').addEventListener('click', close);
    sheet.addEventListener('click', e => { if (e.target === sheet) close(); });

    const onKey = e => {
        if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
    };
    document.addEventListener('keydown', onKey);

    document.body.appendChild(sheet);
}

// Keeps an open sheet live as the game moves on underneath it.
function refreshOpenPlayerSheet(game) {
    const sheet = document.querySelector('.player-sheet:not(.popup-closing)');
    if (!sheet) return;

    const player = game.players.find(p => p.id === sheet.dataset.playerId);
    if (!player) { dismissPopup(sheet); return; }

    const panel = sheet.querySelector('.player');
    if (panel) syncPlayerPanel(panel, player, false, false, false);
}

// ---------------------------------------------------------------------------
// Turn strip and deck button
// ---------------------------------------------------------------------------

function updateTurnStrip(game) {
    const strip = document.getElementById('turnStrip');
    const text = document.getElementById('turnStripText');
    if (!strip || !text) return;

    const current = game.players[game.currentPlayer];
    const mine = current?.id === socket.id;

    if (game.status !== 'playing' || !current) {
        strip.classList.remove('is-mine');
        setText(text, game.status === 'finished' ? 'Game over' : 'Waiting…');
        return;
    }

    strip.classList.toggle('is-mine', mine);
    setText(text, mine ? 'Your turn' : `${current.name} is playing`);
}

function updateDeckButton(deck, lastCard) {
    const count = document.getElementById('deckButtonCount');
    const last = document.getElementById('deckButtonLast');
    if (count) setText(count, deck.length);
    if (last) {
        const { displayValue } = lastCard === null || lastCard === undefined
            ? { displayValue: '—' }
            : getCardVisual(lastCard);
        setText(last, displayValue);
    }
}

// The remaining-deck grid is 94% of a phone screen, so on phones it lives
// behind this button instead of on the board.
function toggleDeckSheet(open) {
    const btn = document.getElementById('deckButton');
    document.body.classList.toggle('deck-sheet-open', open);
    if (btn) btn.setAttribute('aria-expanded', String(open));
}

function initMobileChrome() {
    const deckBtn = document.getElementById('deckButton');
    if (deckBtn) {
        deckBtn.addEventListener('click', () => {
            playSound('buttonClick');
            toggleDeckSheet(!document.body.classList.contains('deck-sheet-open'));
        });
    }

    // Tapping the dimmed area behind the deck sheet closes it.
    const deckArea = document.querySelector('.deck-area');
    if (deckArea) {
        deckArea.addEventListener('click', e => {
            if (e.target === deckArea) toggleDeckSheet(false);
        });
    }

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && document.body.classList.contains('deck-sheet-open')) {
            toggleDeckSheet(false);
        }
    });

    // Rotating the phone or resizing across the breakpoint swaps layouts, so
    // panels have to be emptied out of the container they no longer belong in.
    const onBreakpoint = () => {
        document.getElementById('playersContainer').innerHTML = '';
        document.getElementById('opponentRail').innerHTML = '';
        document.getElementById('myHand').innerHTML = '';
        lastPlayerState.clear();
        toggleDeckSheet(false);
        if (latestGame) renderPlayers(latestGame);
    };

    if (PHONE_QUERY.addEventListener) PHONE_QUERY.addEventListener('change', onBreakpoint);
    else PHONE_QUERY.addListener(onBreakpoint);
}

// document.querySelector needs socket ids escaped; CSS.escape is not in every
// browser we support.
function cssEscape(value) {
    if (window.CSS && typeof CSS.escape === 'function') return CSS.escape(value);
    return String(value).replace(/["\\]/g, '\\$&');
}

// Builds the parts of a panel that never change shape, so syncPlayerPanel only
// ever has to write text and reconcile the two card grids.
function buildPlayerPanel(player) {
    const panel = document.createElement('div');
    panel.className = 'player';
    panel.dataset.playerId = player.id;
    panel.innerHTML = `
        <div class="player-header">
            <h3></h3>
            <div class="player-status"></div>
        </div>

        <div class="scores">
            ${scoreBox('ROUND SCORE', 0)}
            ${scoreBox('TOTAL SCORE', 0)}
            ${scoreBox('CARDS', `0/${MAX_REGULAR_CARDS}`)}
        </div>

        <div class="cards-section">
            <div class="cards-container">
                <div class="cards-label">REGULAR CARDS</div>
                <div class="card-grid regular"></div>
            </div>

            <div class="cards-container">
                <div class="cards-label">SPECIAL CARDS</div>
                <div class="card-grid special"></div>
            </div>
        </div>

        <div class="draw-three-slot"></div>
    `;
    return panel;
}

// track=false renders a read-only copy (the opponent sheet) without touching
// lastPlayerState, which the live rail and hand depend on for their diffs.
function syncPlayerPanel(panel, player, isCurrentTurn, isNewPanel, track = true) {
    const previous = lastPlayerState.get(player.id);

    // connected is absent on the stripped-down player objects some popups pass
    // in, so only an explicit false counts as away.
    const isAway = player.connected === false;

    panel.classList.toggle('current-turn', isCurrentTurn);
    panel.classList.toggle('disconnected', isAway);
    ['active', 'stood', 'busted', 'waiting', 'frozen'].forEach(s => {
        panel.classList.toggle(s, player.status === s);
    });

    const nameEl = panel.querySelector('.player-header h3');
    const nameHtml = `${escapeHtml(player.name.toUpperCase())} ${player.id === socket.id ? '<span class="you">(YOU)</span>' : ''}`;
    if (nameEl.innerHTML !== nameHtml) nameEl.innerHTML = nameHtml;

    const statusEl = panel.querySelector('.player-status');
    const statusHtml = `
        ${isAway ? '<div class="away-indicator">🔌 DISCONNECTED</div>' : ''}
        ${getStatusIcon(player.status)}
        ${player.bustedCard ? `<div class="busted-card">BUSTED ON ${player.bustedCard}</div>` : ''}
        ${player.specialCards.includes('SC') ? '<div class="second-chance-indicator">🛡️ SECOND CHANCE</div>' : ''}
    `;
    if (statusEl.innerHTML !== statusHtml) statusEl.innerHTML = statusHtml;

    const scoreEls = panel.querySelectorAll('.score-value');
    setScore(scoreEls[0], player.roundScore, isNewPanel);
    setScore(scoreEls[1], player.totalScore, isNewPanel);
    setText(scoreEls[2], `${player.regularCards.length}/${MAX_REGULAR_CARDS}`);

    // A brand new panel should not fire seven entrance animations at once —
    // that happens when you rejoin a game already in progress.
    const animate = !isNewPanel;

    syncCardGrid(panel.querySelector('.card-grid.regular'), player.regularCards, false, animate);
    syncCardGrid(panel.querySelector('.card-grid.special'), player.specialCards, true, animate);

    const drawSlot = panel.querySelector('.draw-three-slot');
    const drawHtml = player.drawThreeRemaining > 0
        ? `<div class="draw-three-indicator">🎯 DRAW ${player.drawThreeRemaining} MORE CARDS</div>`
        : '';
    if (drawSlot.innerHTML !== drawHtml) drawSlot.innerHTML = drawHtml;

    // Busting is the one moment worth reacting to, so shake the card that did it
    // — but only on the update where the bust actually happened.
    if (animate && player.status === 'busted' && previous && previous.status !== 'busted') {
        shakeBustedCard(panel, player.bustedCard);
    }

    if (track) {
        lastPlayerState.set(player.id, {
            status: player.status,
            roundScore: player.roundScore,
            totalScore: player.totalScore
        });
    }
}

// Reconciles one grid against the card list the server sent. Cards that are
// still in hand keep their existing element (and so never re-animate); only
// genuinely new values get .is-new.
function syncCardGrid(grid, cards, isSpecial, animate) {
    if (!grid) return;

    // Cards mid-exit are already on their way out; ignore them entirely.
    const live = [...grid.children].filter(el => !el.classList.contains('is-leaving'));
    const existing = live.filter(el => el.classList.contains('card'));
    const slots = live.filter(el => !el.classList.contains('card'));

    // Match by value, consuming each element once, so a hand holding two "3+"
    // cards keeps both rather than collapsing them.
    const pool = new Map();
    existing.forEach(el => {
        const key = el.dataset.value;
        if (!pool.has(key)) pool.set(key, []);
        pool.get(key).push(el);
    });

    const ordered = cards.map(card => {
        const key = String(card);
        const bucket = pool.get(key);
        if (bucket && bucket.length) return { el: bucket.shift(), fresh: false };
        return { el: buildCard(card, isSpecial), fresh: true };
    });

    // Anything left in the pool was played, stolen, or discarded.
    pool.forEach(bucket => bucket.forEach(el => removeCard(el, animate)));

    // Reuse the empty slots we already have and top the grid up to its capacity.
    const slotQueue = slots.slice();
    const capacity = isSpecial ? SPECIAL_CARD_SLOTS : MAX_REGULAR_CARDS;
    const needed = Math.max(0, capacity - cards.length);
    const finalSlots = [];
    for (let i = 0; i < needed; i++) {
        finalSlots.push(slotQueue.shift() || buildSlot(isSpecial));
    }
    slotQueue.forEach(el => el.remove());

    // Write the final order, moving nodes only when they are out of place.
    const target = [...ordered.map(o => o.el), ...finalSlots];
    target.forEach((el, i) => {
        if (grid.children[i] !== el) {
            grid.insertBefore(el, grid.children[i] || null);
        }
    });

    if (animate) {
        ordered.forEach(o => {
            if (o.fresh) playCardEntrance(o.el);
        });
    }
}

function buildCard(card, isSpecial) {
    const el = document.createElement('div');
    el.dataset.value = String(card);

    if (!isSpecial) {
        el.className = 'card';
        // Colour comes from the [data-card-type] rules in style.css; without
        // this attribute the card renders with no fill at all.
        el.dataset.cardType = 'number';
        el.textContent = card;
        return el;
    }

    const cardClass = getSpecialCardClass(card);
    el.className = `card special ${cardClass}`;
    el.dataset.cardType = cardClass;
    el.textContent = getSpecialCardDisplay(card);
    return el;
}

function buildSlot(isSpecial) {
    const el = document.createElement('div');
    el.className = isSpecial ? 'empty-slot special' : 'empty-slot';
    return el;
}

// Entrance classes are always cleared on a timer as well as on animationend.
// A backgrounded or non-compositing tab can leave an animation running forever,
// and .is-new holds the card at opacity 0 - so without this a player who tabs
// away mid-draw comes back to invisible cards.
function clearAfter(el, className, ms) {
    const strip = () => el.classList.remove(className);
    el.addEventListener('animationend', strip, { once: true });
    setTimeout(strip, ms);
}

function playCardEntrance(el) {
    el.classList.add('is-new');
    clearAfter(el, 'is-new', 600);
}

function removeCard(el, animate) {
    if (!animate) {
        el.remove();
        return;
    }
    el.classList.add('is-leaving');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    // animationend never fires when the tab is hidden or motion is reduced.
    setTimeout(() => el.remove(), 400);
}

function shakeBustedCard(panel, bustedCard) {
    const grid = panel.querySelector('.card-grid.regular');
    if (!grid) return;
    const card = bustedCard != null
        ? grid.querySelector(`.card[data-value="${cssEscape(String(bustedCard))}"]`)
        : null;
    const target = card || grid.querySelector('.card:last-of-type');
    if (!target) return;
    target.classList.add('is-bust');
    clearAfter(target, 'is-bust', 800);
}

function setText(el, value) {
    if (el && el.textContent !== String(value)) el.textContent = value;
}

// Rolls the number instead of snapping to it. Falls back to a plain write when
// either end is not a number, or when the player asked for less motion.
function setScore(el, value, immediate) {
    if (!el) return;

    const from = Number(el.textContent);
    const to = Number(value);

    // A hidden tab pauses requestAnimationFrame, which would freeze the roll
    // partway and leave a stale number on screen. A score is information, not
    // decoration, so anything other than a clean animated path snaps instead.
    const canAnimate = !immediate
        && Number.isFinite(from) && Number.isFinite(to) && from !== to
        && !prefersReducedMotion()
        && document.visibilityState === 'visible';

    stopRoll(el);

    if (!canAnimate) {
        setText(el, value);
        return;
    }

    const duration = 380;
    const start = performance.now();
    el.classList.add('is-rolling');

    const finish = () => {
        stopRoll(el);
        el.textContent = to;
        el.classList.remove('is-rolling');
    };

    const step = now => {
        const p = Math.min(1, (now - start) / duration);
        const eased = 1 - Math.pow(1 - p, 3);
        el.textContent = Math.round(from + (to - from) * eased);
        if (p < 1) {
            el._rollFrame = requestAnimationFrame(step);
        } else {
            finish();
        }
    };

    el._rollFrame = requestAnimationFrame(step);
    // Backstop: if the frames stop coming, land on the real number anyway.
    el._rollTimer = setTimeout(finish, duration + 200);
}

function stopRoll(el) {
    if (el._rollFrame) {
        cancelAnimationFrame(el._rollFrame);
        el._rollFrame = null;
    }
    if (el._rollTimer) {
        clearTimeout(el._rollTimer);
        el._rollTimer = null;
    }
}

function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Helper functions
function scoreBox(label, value) {
    return `
        <div class="score-box">
            <div>${label}</div>
            <div class="score-value">${value}</div>
        </div>
    `;
}

// Update special card class function to include all special cards
function getSpecialCardClass(card) {
    if (card === 'SC') return 'second-chance';
    if (card === 'Freeze') return 'freeze';
    if (card === 'D3') return 'draw-three';
    if (card === 'RC') return 'remove-card';
  if (card === 'ST') return 'steal-card';
    if (card === 'Swap') return 'swap-card';
    if (card === 'Select') return 'select-card';
    if (card === '2÷') return 'divide';
    if (card.endsWith('+')) return 'adder';
    if (card.endsWith('x')) return 'multiplier';
    if (card.endsWith('-')) return 'minus';
    return '';
}

// Update special card display function to include all special cards
function getSpecialCardDisplay(card) {
    // Regular cards are numbers and have no symbol to look up
    if (typeof card === 'number') return String(card);

    // Special cards with emojis
    if (card === 'SC') return '🛡️';
    if (card === 'Freeze') return '❄️';
    if (card === 'D3') return '🎯';
    if (card === 'RC') return '🗑️';
  if (card === 'ST') return '🥷';
    if (card === 'Swap') return '⇄️';
    if (card === 'Select') return '🃏';
    
    // For numeric modifier cards, format them
    if (card.endsWith('+') || card.endsWith('x') || card.endsWith('-')) {
        const number = card.slice(0, -1);  // Get everything except last character
        const symbol = card.slice(-1);     // Get last character (+ or x or -)
        return `${number}${symbol}`;       // Combine them (e.g., "2+")
    }
    
    // For divide card
    if (card === '2÷') return '2÷';
    
    return card;
}

function getStatusIcon(status) {
    const [icon, label] = STATUS_PARTS[status] || ['', ''];
    return `
        <span class="status-icon">${icon}</span>
        <span class="status-text">${label}</span>
    `;
}

function getStatusText(status) {
    return {
        active: 'ACTIVE',
        stood: 'STOOD', 
        busted: 'BUSTED',
        waiting: 'WAITING',
        frozen: 'FROZEN',
        finished: 'FINISHED' // Add new status
    }[status];
}

// UI controls
function toggleActionButtons(active) {
    const flipCardBtn = document.getElementById('flipCard');
    const standButton = document.getElementById('standButton');
    
    // Always show buttons but disable them when not active
    if (flipCardBtn) {
        flipCardBtn.disabled = !active;
        flipCardBtn.style.display = 'block';
    }
    if (standButton) {
        standButton.disabled = !active;
        standButton.style.display = 'block';
    }
}

// Game event handlers
function handleGameJoined({ gameId, token }) {
    currentGameId = gameId;
    saveSession(gameId, token);
    document.querySelector('.lobby-screen').style.display = 'none';
}

// Accepted back into a game in progress: everything about the seat is server state, so
// this is just a matter of catching the page up to it.
function handleRejoined({ game, token }) {
    currentGameId = game.id;
    currentGameUrl = game.url || currentGameUrl;
    saveSession(game.id, token);
    hideConnectionLostOverlay();
    clearLobbyError();

    document.querySelectorAll('.seat-picker-popup').forEach(p => p.remove());
    const banner = document.getElementById('rejoinBanner');
    if (banner) banner.hidden = true;

    document.querySelector('.lobby-screen').style.display = 'none';

    const waitingScreen = document.getElementById('waitingScreen');
    if (waitingScreen && game.status !== 'lobby') waitingScreen.remove();

    handleGameUpdate(game);
}

// The token is no good - the game finished, was reset, or the host kicked this player.
// Nothing to return to, so drop it and show the lobby like a first visit.
function handleRejoinFailed(message) {
    clearSession();
    hideConnectionLostOverlay();

    // Only worth interrupting someone who is actually sitting at a game screen. On a
    // fresh page load with a stale token there is nothing to explain.
    const inGame = document.getElementById('gameArea')?.style.display === 'flex';
    if (inGame) {
        alert(message || 'You are no longer in that game.');
        window.location.href = '/';
        return;
    }

    currentGameId = null;
    latestGame = null;
    const lobby = document.querySelector('.lobby-screen');
    if (lobby) lobby.style.display = '';
}

function handleRoundRestarted(game) {
    // Anything still on screen belongs to the round that was just thrown away.
    document.querySelectorAll(
        '.round-summary-popup, .freeze-popup, .draw-three-popup, .remove-card-popup, ' +
        '.steal-card-popup, .swap-card-popup, .select-card-popup, .info-popup'
    ).forEach(p => p.remove());
    activeFreezePopup = null;
    activeDrawThreePopup = null;
    document.body.style.overflow = 'auto';

    showRoundRestartedNotice(game.roundNumber);
    handleGameUpdate(game);
}

function showWaitingScreen(gameData) {
    const waitingScreen = document.createElement('div');
    waitingScreen.className = 'waiting-screen';
    waitingScreen.id = 'waitingScreen';
    
    const content = `
        <h2>${isHost ? '🎮 Waiting Room' : '⏳ Waiting for Host'}</h2>
        ${isHost ? `
        <div class="share-section">
          <p class="share-text">Share this link with your friends:</p>
          <input id="shareLinkInput" class="share-link-input" readonly value="${currentGameUrl || (window.location.origin + '/join/' + gameData.id || '')}">
          <button id="copyLinkBtn" class="game-button copy-link-btn" type="button">
            Copy Game Link
          </button>
          <div class="copied-message">Link copied!</div>
        </div>
        ` : ''}
        <div class="players-list">
            ${gameData.players.map(player => `
                <div class="player-item">
                    ${escapeHtml(player.name)}
                    ${player.id === gameData.hostId ? 
                        '<span class="host-badge">HOST</span>' : ''}
                </div>
            `).join('')}
        </div>
        ${isHost ? `
            <div class="button-group">
                <button id="startGameBtn" class="game-button green" 
                    ${gameData.players.length < 2 ? 'disabled' : ''}>
                    ${gameData.players.length < 2 ? 
                        'Waiting for Players <div class="loading-spinner"></div>' : 
                        'Start Game'}
                </button>
            </div>
        ` : `
            <p>Waiting for host to start the game<div class="loading-spinner"></div></p>
        `}
    `;
    
    waitingScreen.innerHTML = content;
    document.body.appendChild(waitingScreen);

    // Ensure start button calls startGame and is wired (in case innerHTML changes later)
    const startBtn = document.getElementById('startGameBtn');
    if (startBtn) {
      startBtn.addEventListener('click', (e) => {
        if (startBtn.disabled) return;
        startGame();
      });
    }

    const copyBtn = document.getElementById('copyLinkBtn');
    if (copyBtn) {
      copyBtn.addEventListener('click', (e) => {
        e.preventDefault();
        copyShareLink();
      });
    }

    // Hide the game area completely while in waiting room
    document.getElementById('gameArea').style.display = 'none';
    document.querySelector('.controls').style.display = 'none';

    // Update start button state when players join/leave
    updateStartButton(gameData.players.length);
}

// Update handleGameStarted to properly transition from waiting screen to game
function handleGameStarted(game) {
    // Remove waiting screen
    const waitingScreen = document.getElementById('waitingScreen');
    if (waitingScreen) {
        waitingScreen.remove();
    }

    // Show game area and controls
    document.getElementById('gameArea').style.display = 'flex';
    document.querySelector('.controls').style.display = 'flex';
    
    // Update game display
    updateGameDisplay(game);
    
    // Check if it's the current player's turn and update controls
    const isCurrentPlayer = game.players[game.currentPlayer]?.id === socket.id;
    toggleActionButtons(isCurrentPlayer && game.status === 'playing');
}

function updateStartButton(playerCount) {
    const startBtn = document.getElementById('startGameBtn');
    if (startBtn) {
        const disabled = playerCount < 2;
        startBtn.disabled = disabled;
        startBtn.innerHTML = disabled ? 
            'Waiting for Players <div class="loading-spinner"></div>' : 
            'Start Game';

        // Also update the button style based on state
        if (disabled) {
            startBtn.classList.add('disabled');
        } else {
            startBtn.classList.remove('disabled');
        }
    }
}

// A shared link now fills the form in and waits, rather than firing a browser prompt at
// someone the moment the page opens. Same number of taps, and it works on the phones
// where prompt() is suppressed.
function checkUrlParams() {
    const nameInput = document.getElementById('playerName');
    const codeInput = document.getElementById('gameId');

    // Saves retyping it every game.
    try {
        const lastName = localStorage.getItem(LAST_NAME_KEY);
        if (lastName && nameInput) nameInput.value = lastName;
    } catch (e) { /* nothing remembered */ }

    const pathMatch = window.location.pathname.match(/\/join\/([A-Z0-9]{5})/i);
    if (pathMatch) {
        const gameId = pathMatch[1].toUpperCase();
        if (codeInput) codeInput.value = gameId;
        window.history.replaceState({}, document.title, '/');

        // Everything is ready except the one thing only they can supply.
        if (nameInput && !nameInput.value) {
            nameInput.focus();
        } else {
            joinGame();
        }
        return;
    }

    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('error') === 'game-not-found') {
        showLobbyError('That game link is no longer valid — ask for the code instead.', 'gameId');
        window.history.replaceState({}, document.title, '/');
    }

}

function handleNewRound(game) {
    // Update game display first
    updateGameDisplay(game);
    
    // Check if it's the current player's turn
    const isCurrentPlayer = game.players[game.currentPlayer]?.id === socket.id;
    
    // Toggle action buttons based on current player
    toggleActionButtons(isCurrentPlayer && game.status === 'playing');
}

function handleAllBusted() {
    const popup = document.createElement('div');
    popup.className = 'info-popup';
    popup.innerHTML = `
        <h2>💥 ALL PLAYERS BUSTED! 💥</h2>
        <p class="popup-countdown">Starting new round in 3...</p>
    `;
    document.body.appendChild(popup);
    
    let count = 2;
    const countdown = setInterval(() => {
        popup.querySelector('.popup-countdown').textContent = 
            `Starting new round in ${count}...`;
        if (count <= 0) {
            clearInterval(countdown);
            dismissPopup(popup);
        }
        count--;
    }, 1000);
}

function showWinnerPopup(winner, isHost) {
    // Get all players from the current game state
    const container = document.getElementById('playersContainer');
    const allPlayerElements = container.querySelectorAll('.player');
    const allPlayers = [];
    
    // Extract player data from the DOM
    allPlayerElements.forEach(playerEl => {
        const playerName = playerEl.querySelector('h3').textContent.replace('(YOU)', '').trim();
        const playerTotalScore = parseInt(playerEl.querySelectorAll('.score-value')[1].textContent);
        const playerId = playerEl.dataset.playerId;
        
        allPlayers.push({
            name: playerName,
            totalScore: playerTotalScore,
            id: playerId,
            isWinner: playerId === winner.id
        });
    });
    
    // Sort players by score (descending)
    allPlayers.sort((a, b) => b.totalScore - a.totalScore);
    
    // Create leaderboard HTML
    const topPlayers = allPlayers.slice(0, 3); // Get top 3 players
    const leaderboardHTML = topPlayers.map((player, index) => {
        const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : '🥉';
        const isCurrentPlayer = player.id === socket.id;
        const winnerClass = player.isWinner ? 'winner' : '';
        
        return `
            <div class="leaderboard-row ${winnerClass} ${isCurrentPlayer ? 'current-player' : ''}">
                <div class="rank">${medal}</div>
                <div class="player-name">${escapeHtml(player.name)} ${isCurrentPlayer ? '(YOU)' : ''}</div>
                <div class="player-score">${player.totalScore}</div>
            </div>
        `;
    }).join('');

    const popup = document.createElement('div');
    popup.className = 'winner-popup';
    popup.innerHTML = `
        <div class="popup-content">
            <div class="trophy-banner">🏆</div>
            <h2>WINNER!</h2>
            <div class="winner-name">${escapeHtml(winner.name)}</div>
            <div class="winner-score">${winner.totalScore} Points</div>
            
            <div class="leaderboard">
                <h3>Top Players</h3>
                <div class="leaderboard-container">
                    ${leaderboardHTML}
                </div>
            </div>
            
            ${isHost ? `
                <button id="rematchButton" class="game-button green">
                    Rematch?
                </button>
            ` : `
                <div class="waiting-message">
                    Waiting for host to start rematch...
                </div>
            `}
        </div>
    `;
    document.body.appendChild(popup);

    // Only add rematch button listener if host
    if (isHost) {
        document.getElementById('rematchButton').addEventListener('click', () => {
            socket.emit('request-rematch', currentGameId);
            dismissPopup(popup);
        });
    }
}

function handleGameOver({ players, winner }) {
    playSound('winSound');
    toggleActionButtons(false);
    showWinnerPopup(winner, isHost); // Pass isHost flag
}

function handleGameReset() {
    alert('Game has been reset by the host!');
    window.location.reload();
}

function handleError(message) {
    // On the landing page an alert() covers the field the player has to fix, and errors
    // there are all about the form anyway.
    const lobby = document.querySelector('.lobby-screen');
    const onLandingPage = lobby && lobby.style.display !== 'none';
    if (onLandingPage) {
        showLobbyError(message);
        return;
    }
    alert(message);
}

function showResetConfirmation() {
  const existingPopup = document.querySelector('.reset-confirmation-popup');
  if (existingPopup) existingPopup.remove();

    const popup = document.createElement('div');
    popup.className = 'reset-confirmation-popup';
    popup.innerHTML = `
        <div class="popup-content">
            <h2>Reset Game?</h2>
            <p>Start a new round with all players?</p>
            <div class="button-group">
        <button id="confirmResetBtn" class="game-button red" type="button">
                    Yes, Reset
                </button>
        <button id="cancelResetBtn" class="game-button blue" type="button">
                    Cancel
                </button>
            </div>
        </div>
    `;
    document.body.appendChild(popup);

  const confirmBtn = popup.querySelector('#confirmResetBtn');
  const cancelBtn = popup.querySelector('#cancelResetBtn');

  if (confirmBtn) {
    confirmBtn.addEventListener('click', (e) => {
      e.preventDefault();
      confirmReset();
    });
  }

  if (cancelBtn) {
    cancelBtn.addEventListener('click', (e) => {
      e.preventDefault();
      cancelReset();
    });
  }
}

function confirmReset() {
    const popup = document.querySelector('.reset-confirmation-popup');
    if (popup) popup.remove();
    resetGame();
}

function cancelReset() {
    const popup = document.querySelector('.reset-confirmation-popup');
    if (popup) popup.remove();
}

function handleRoundSummary({ players, allBusted }) {
    playSound(allBusted ? 'bustSound' : 'roundEnd');
    const popup = document.createElement('div');
    popup.className = 'round-summary-popup';
    
    const playerList = players.map(player => {
        const hasBonus = player.regularCards.length === MAX_REGULAR_CARDS;
        const status = hasBonus ? 'finished' : player.status;
        const newTotal = player.status !== 'busted' ? player.totalScore + player.roundScore : player.totalScore;
        
        return `
            <div class="player-summary-row">
                <div class="name">
                    ${escapeHtml(player.name)}
                    ${hasBonus ? '🌟+15' : ''}
                    ${player.bustedCard ? `(Busted on ${player.bustedCard})` : ''}
                </div>
                <div class="status ${status}">${getStatusText(status)}</div>
                <div class="points-container">
                    <span class="points-label">Round</span>
                    <span class="points">${player.roundScore}</span>
                </div>
                <div class="points-container">
                    <span class="points-label">Total</span>
                    <span class="points">${newTotal}</span>
                </div>
            </div>
        `;
    }).join('');

    popup.innerHTML = `
        <div class="popup-content">
            <h2>${allBusted ? '💥 ALL PLAYERS BUSTED! 💥' : '🏁 ROUND SUMMARY 🏁'}</h2>
            <div class="round-summary-header">
                <span>Player</span>
                <span>Status</span>
                <span>Round Points</span>
                <span>Total Points</span>
            </div>
            <div class="round-summary-list">${playerList}</div>
            <p class="countdown">Next round starting in <span id="countdown">5</span>...</p>
        </div>
    `;

    document.body.appendChild(popup);
    
    let count = 4;
    const countdownElement = popup.querySelector('#countdown');
    const interval = setInterval(() => {
        countdownElement.textContent = count;
        if (count <= 0) {
            clearInterval(interval);
            dismissPopup(popup);
        }
        count--;
    }, 1000);
}

// Update showRemoveCardPopup function to properly display special cards
function showRemoveCardPopup(gameId, players) {
  // Disable action buttons during popup
  document.body.style.overflow = 'hidden';
  toggleActionButtons(false);
  
  const popup = document.createElement('div');
  popup.className = 'remove-card-popup';
  
  const content = `
    <div class="popup-content">
      <h3><span class="emoji">🗑️</span> Select a card to remove:</h3>
      <div class="players-list">
        ${players.map(player => {
          const isDisabled = player.status === 'busted';
          return `
            <div class="player-section ${isDisabled ? 'disabled' : ''}" data-status="${player.status}">
              <h4>${escapeHtml(player.name)} ${player.id === socket.id ? '(You)' : ''} 
                  ${isDisabled ? `<span class="status-badge ${player.status}">${getStatusText(player.status)}</span>` : ''}
              </h4>
              <div class="cards-list">
                ${player.regularCards.map((card, index) => `
                  <button class="card-button regular" 
                    data-player="${player.id}" 
                    data-index="${index}"
                    data-special="false"
                    ${isDisabled ? 'disabled' : ''}>
                    ${card}
                  </button>
                `).join('')}
                ${player.specialCards.map((card, index) => {
                  const isRemoveCard = card === 'RC';
                  return `
                  <button class="card-button special ${getSpecialCardClass(card)}"
                    data-card-type="${getSpecialCardClass(card)}"
                    data-player="${player.id}" 
                    data-index="${index}"
                    data-special="true"
                    ${isDisabled || isRemoveCard ? 'disabled' : ''}>
                    ${getSpecialCardDisplay(card)}
                  </button>
                  `;
                }).join('')}
              </div>
              ${isDisabled ? `
                <div class="status-overlay">
                  <span class="status-message">Player is ${player.status.toUpperCase()}</span>
                </div>
              ` : ''}
            </div>
          `;
        }).join('')}
      </div>
      <button class="view-game-button" id="viewGameButton">
        <span class="icon">👁️</span> Hold to view game
      </button>
    </div>
  `;
  
  popup.innerHTML = content;

  // Add event listeners - only for enabled buttons
  popup.querySelectorAll('.card-button:not([disabled])').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.player;
      const cardIndex = parseInt(btn.dataset.index);
      const isSpecial = btn.dataset.special === 'true';
      
      socket.emit('remove-card', gameId, targetId, cardIndex, isSpecial);
      dismissPopup(popup);
    });
  });

  wireViewGameButton(popup);
  
  document.body.appendChild(popup);
  
  // Clean up event listeners when popup is removed
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if ([...mutation.removedNodes].includes(popup)) {
        document.body.style.overflow = 'auto';
        observer.disconnect();
      }
    });
  });
  
  observer.observe(document.body, { childList: true });
}

function showSwapCardPopup(gameId, players) {
  // Disable action buttons during popup
  document.body.style.overflow = 'hidden';
  toggleActionButtons(false);

  const popup = document.createElement('div');
  popup.className = 'swap-card-popup';

  let selectedCards = [];

  const isSwappable = (card) => {
    const cardStr = card.toString();
    return typeof card === 'number' || 
           cardStr === 'SC' || 
           cardStr === '2x' || 
           cardStr.includes('+') || 
           cardStr.includes('-') || 
           cardStr.includes('÷');
  };

  const content = `
    <div class="popup-content">
      <h3><span class="emoji">⇄️</span> Select 2 cards to swap (from different players):</h3>
      <div class="players-list">
        ${players.map(player => {
          const isDisabled = player.status === 'busted';
          const showStatusBadge = player.status !== 'active';
          const swappableRegular = player.regularCards.filter(isSwappable);
          const swappableSpecial = player.specialCards.filter(isSwappable);
          
          return `
            <div class="player-section ${isDisabled ? 'disabled' : ''}" data-status="${player.status}" data-player-id="${player.id}">
              <h4>${escapeHtml(player.name)} ${player.id === socket.id ? '(You)' : ''}
                  ${showStatusBadge ? `<span class="status-badge ${player.status}">${getStatusText(player.status)}</span>` : ''}
              </h4>
              <div class="cards-list">
                ${swappableRegular.map((card, index) => {
                  const actualIndex = player.regularCards.indexOf(card);
                  return `
                    <button class="card-button regular swap-selectable"
                      data-player="${player.id}"
                      data-index="${actualIndex}"
                      data-special="false"
                      data-initial-disabled="${isDisabled}"
                      ${isDisabled ? 'disabled' : ''}>
                      ${card}
                    </button>
                  `;
                }).join('')}
                ${swappableSpecial.map((card, index) => {
                  const actualIndex = player.specialCards.indexOf(card);
                  return `
                    <button class="card-button special ${getSpecialCardClass(card)} swap-selectable"
                      data-card-type="${getSpecialCardClass(card)}"
                      data-player="${player.id}"
                      data-index="${actualIndex}"
                      data-special="true"
                      data-initial-disabled="${isDisabled}"
                      ${isDisabled ? 'disabled' : ''}>
                      ${getSpecialCardDisplay(card)}
                    </button>
                  `;
                }).join('')}
              </div>
              ${isDisabled ? `
                <div class="status-overlay">
                  <span class="status-message">Player is ${player.status.toUpperCase()}</span>
                </div>
              ` : ''}
            </div>
          `;
        }).join('')}
      </div>
      <button class="confirm-swap-button" id="confirmSwapButton" disabled>
        <span class="icon">✓</span> Confirm Swap
      </button>
      <button class="view-game-button" id="viewGameButton">
        <span class="icon">👁️</span> Hold to view game
      </button>
    </div>
  `;

  popup.innerHTML = content;

  const confirmButton = popup.querySelector('#confirmSwapButton');

  const updateSwapSelectionState = () => {
    const selectedPlayerId = selectedCards.length === 1 ? selectedCards[0].playerId : null;
    popup.querySelectorAll('.swap-selectable').forEach(btn => {
      if (btn.dataset.initialDisabled === 'true') {
        return;
      }

      const isSelected = btn.classList.contains('selected');
      if (selectedPlayerId && btn.dataset.player === selectedPlayerId && !isSelected) {
        btn.dataset.tempDisabled = 'true';
        btn.setAttribute('disabled', '');
        btn.classList.add('same-player-disabled');
      } else if (btn.dataset.tempDisabled === 'true') {
        btn.removeAttribute('disabled');
        btn.dataset.tempDisabled = 'false';
        btn.classList.remove('same-player-disabled');
      }
    });
  };

  popup.querySelectorAll('.swap-selectable:not([disabled])').forEach(btn => {
    btn.addEventListener('click', () => {
      const playerId = btn.dataset.player;
      const cardIndex = parseInt(btn.dataset.index);
      const isSpecial = btn.dataset.special === 'true';

      // Check if card is already selected
      const alreadySelected = selectedCards.findIndex(c => 
        c.playerId === playerId && 
        c.index === cardIndex && 
        c.isSpecial === isSpecial
      );

      if (alreadySelected !== -1) {
        // Deselect
        selectedCards.splice(alreadySelected, 1);
        btn.classList.remove('selected');
      } else {
        // Check if already have 2 cards selected
        if (selectedCards.length >= 2) {
          // Remove first selection's highlight
          const firstCard = selectedCards.shift();
          const firstBtn = popup.querySelector(
            `.swap-selectable[data-player="${firstCard.playerId}"][data-index="${firstCard.index}"][data-special="${firstCard.isSpecial}"]`
          );
          if (firstBtn) firstBtn.classList.remove('selected');
        }

        // Prevent selecting a second card from the same player
        if (selectedCards.length === 1 && selectedCards[0].playerId === playerId) {
          return;
        }

        // Add new selection
        selectedCards.push({ playerId, index: cardIndex, isSpecial });
        btn.classList.add('selected');
      }

      // Enable confirm button only if 2 cards from different players are selected
      const canConfirm = selectedCards.length === 2 && 
                         selectedCards[0].playerId !== selectedCards[1].playerId;
      confirmButton.disabled = !canConfirm;
      updateSwapSelectionState();
    });
  });

  confirmButton.addEventListener('click', () => {
    if (selectedCards.length === 2 && selectedCards[0].playerId !== selectedCards[1].playerId) {
      socket.emit('swap-cards', gameId, {
        playerId: selectedCards[0].playerId,
        index: selectedCards[0].index,
        isSpecial: selectedCards[0].isSpecial
      }, {
        playerId: selectedCards[1].playerId,
        index: selectedCards[1].index,
        isSpecial: selectedCards[1].isSpecial
      });
      dismissPopup(popup);
    }
  });

  wireViewGameButton(popup);

  document.body.appendChild(popup);

  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if ([...mutation.removedNodes].includes(popup)) {
        document.body.style.overflow = 'auto';
        observer.disconnect();
      }
    });
  });

  observer.observe(document.body, { childList: true });
}

function showStealCardPopup(gameId, players) {
  // Disable action buttons during popup
  document.body.style.overflow = 'hidden';
  toggleActionButtons(false);

  const popup = document.createElement('div');
  popup.className = 'steal-card-popup';

  const content = `
    <div class="popup-content">
      <h3><span class="emoji">🥷</span> Select a card to steal:</h3>
      <div class="players-list">
        ${players.map(player => {
          const isDisabled = player.status === 'busted';
          const showStatusBadge = player.status !== 'active';
          return `
            <div class="player-section ${isDisabled ? 'disabled' : ''}" data-status="${player.status}">
              <h4>${escapeHtml(player.name)} ${player.id === socket.id ? '(You)' : ''}
                  ${showStatusBadge ? `<span class="status-badge ${player.status}">${getStatusText(player.status)}</span>` : ''}
              </h4>
              <div class="cards-list">
                ${player.regularCards.map((card, index) => `
                  <button class="card-button regular"
                    data-player="${player.id}"
                    data-index="${index}"
                    data-special="false"
                    ${isDisabled ? 'disabled' : ''}>
                    ${card}
                  </button>
                `).join('')}
                ${player.specialCards.map((card, index) => `
                  <button class="card-button special ${getSpecialCardClass(card)}"
                    data-card-type="${getSpecialCardClass(card)}"
                    data-player="${player.id}"
                    data-index="${index}"
                    data-special="true"
                    ${isDisabled ? 'disabled' : ''}>
                    ${getSpecialCardDisplay(card)}
                  </button>
                `).join('')}
              </div>
              ${isDisabled ? `
                <div class="status-overlay">
                  <span class="status-message">Player is ${player.status.toUpperCase()}</span>
                </div>
              ` : ''}
            </div>
          `;
        }).join('')}
      </div>
      <button class="view-game-button" id="viewGameButton">
        <span class="icon">👁️</span> Hold to view game
      </button>
    </div>
  `;

  popup.innerHTML = content;

  popup.querySelectorAll('.card-button:not([disabled])').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.player;
      const cardIndex = parseInt(btn.dataset.index);
      const isSpecial = btn.dataset.special === 'true';

      socket.emit('steal-card', gameId, targetId, cardIndex, isSpecial);
      dismissPopup(popup);
    });
  });

  wireViewGameButton(popup);

  document.body.appendChild(popup);

  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if ([...mutation.removedNodes].includes(popup)) {
        document.body.style.overflow = 'auto';
        observer.disconnect();
      }
    });
  });

  observer.observe(document.body, { childList: true });
}

// Add helper function to get card background color

socket.on('select-remove-card-target', (gameId, players) => {
  showRemoveCardPopup(gameId, players);
});

socket.on('select-steal-card-target', (gameId, players) => {
  showStealCardPopup(gameId, players);
});

socket.on('select-swap-cards', (gameId, players) => {
  showSwapCardPopup(gameId, players);
});

socket.on('swap-notification', (data) => {
  const message = `${data.swapper} swapped ${data.player1}'s ${getSpecialCardDisplay(data.card1)} with ${data.player2}'s ${getSpecialCardDisplay(data.card2)}`;
  showNotification(message, 'info');
});

// Toast used for events a player needs to see but that should not interrupt them.
// The message carries player names, so it is set as text rather than markup.
function showNotification(message, type = 'info') {
  const notification = document.createElement('div');
  notification.className = `game-notification ${type}`;
  notification.textContent = message;
  document.body.appendChild(notification);

  setTimeout(() => {
    notification.classList.add('fade-out');
    setTimeout(() => notification.remove(), 500);
  }, 4000);
}

// Add this function to show the Select Card popup
function showSelectCardPopup(gameId, deck, fullDeck = null) {
  // If deck is empty but we have a fullDeck parameter (for last card scenario)
  // use the full deck instead
  const cardsToShow = (deck.length === 0 && fullDeck) ? fullDeck : deck;
  
  // Group cards by type
  const regularCards = [];
  const specialCards = [];
  
  // Count occurrence of each card
  const cardCounts = cardsToShow.reduce((acc, card) => {
    const cardStr = card.toString();
    acc[cardStr] = (acc[cardStr] || 0) + 1;
    return acc;
  }, {});

  // Sort card groups
  Object.entries(cardCounts).forEach(([cardStr, count]) => {
    if (cardStr === 'SC' || cardStr === 'Freeze' || cardStr === 'D3' || 
        cardStr === 'RC' || cardStr === 'ST' || cardStr === 'Swap' || cardStr === 'Select' ||
        cardStr.includes('+') || cardStr.includes('x') || cardStr.includes('-')) {
      specialCards.push({ card: cardStr, count });
    } else {
      regularCards.push({ card: parseInt(cardStr), count });
    }
  });
  
  // Sort regular cards numerically
  regularCards.sort((a, b) => a.card - b.card);
  
  // Sort special cards by same order as remaining pile
  const getSpecialCardOrder = card => {
    const specialOrder = {
        'Select': 1,    // 1. Select Card
        'SC': 2,        // 2. Second Chance
        'Freeze': 3,    // 3. Freeze
        'D3': 4,        // 4. Draw Three
        'RC': 5,        // 5. Remove Card
        'ST': 6,        // 6. Steal Card
        'Swap': 7,      // 7. Swap Card
        '2+': 8,        // 8. 2+
        '4+': 9,        // 9. 4+
        '6+': 10,       // 10. 6+
        '8+': 11,       // 11. 8+
        '10+': 12,      // 12. 10+
        '2x': 13,       // 13. 2x Multiplier
        '2-': 14,       // 14. 2-
        '4-': 15,       // 15. 4-
        '6-': 16,       // 16. 6-
        '8-': 17,       // 17. 8-
        '10-': 18,      // 18. 10-
        '2÷': 19,       // 19. 2÷ Divide
    };
    return specialOrder[card] || 99;
  };
  specialCards.sort((a, b) => getSpecialCardOrder(a.card) - getSpecialCardOrder(b.card));
  
  // Create popup
  const popup = document.createElement('div');
  popup.className = 'select-card-popup';
  popup.id = 'selectCardPopup';
  
  popup.innerHTML = `
    <div class="popup-content">
      <h3><span class="emoji">🃏</span> Select Any Card From The Deck</h3>
      
      <div class="card-section">
        <div class="section-title">Regular Cards</div>
        <div class="cards-list">
          ${regularCards.map(({ card, count }) => `
            <button class="card-button regular" data-card="${card}">
              ${card}
              ${count > 1 ? `<span class="card-count">×${count}</span>` : ''}
            </button>
          `).join('')}
        </div>
      </div>
      
      <div class="card-section">
        <div class="section-title">Special Cards</div>
        <div class="cards-list">
          ${specialCards.map(({ card, count }) => {
            const cardClass = getSpecialCardClass(card);
            const cardDisplay = getSpecialCardDisplay(card);

            // data-card carries the raw server value and is read back by the click
            // handler below; data-card-type is the styling hook.
            return `
              <button class="card-button special ${cardClass}"
                     data-card="${card}"
                     data-card-type="${cardClass}">
                ${cardDisplay}
                ${count > 1 ? `<span class="card-count">×${count}</span>` : ''}
              </button>
            `;
          }).join('')}
        </div>
      </div>
      
      <button class="view-game-button" id="viewGameButton">
        <span class="icon">👁️</span> Hold to view game
      </button>
    </div>
  `;
  
  // Add event listeners to card options
  popup.querySelectorAll('.card-button').forEach(button => {
    button.addEventListener('click', () => {
      const selectedCard = button.dataset.card;
      // For regular cards, convert to number
      const finalCard = isNaN(selectedCard) ? selectedCard : parseInt(selectedCard);
      
      // Close the popup first
      dismissPopup(popup);
      
      // Handle selected card
      handleSelectedCard(gameId, finalCard);
    });
  });
  
  wireViewGameButton(popup);
  
  // Add a cleanup function to remove event listeners when popup is removed
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if ([...mutation.removedNodes].includes(popup)) {
        document.body.style.overflow = 'auto';
        observer.disconnect();
      }
    });
  });
  
  document.body.appendChild(popup);
  
  // Start observing the popup for removal
  observer.observe(document.body, { childList: true });
}

// New function to handle selected cards
function handleSelectedCard(gameId, selectedCard) {
  // First send the selection to the server
  socket.emit('select-card-choice', gameId, selectedCard);
  
  // Remove the select card popup if it exists
  const selectCardPopup = document.getElementById('selectCardPopup');
  if (selectCardPopup) {
    selectCardPopup.remove();
  }
  
  // Then immediately show appropriate popup for special cards
  if (selectedCard === 'D3') {
    // No need to wait for server response - we can show the D3 popup right away
    socket.emit('request-draw-three-targets', gameId);
  } else if (selectedCard === 'Freeze') {
    // Show freeze popup immediately
    socket.emit('request-freeze-targets', gameId);
  } else if (selectedCard === 'RC') {
    // Show remove card popup immediately
    socket.emit('request-remove-card-targets', gameId);
  } else if (selectedCard === 'ST') {
    // Show steal card popup immediately
    socket.emit('request-steal-card-targets', gameId);
  } else if (selectedCard === 'Swap') {
    // Show swap card popup immediately
    socket.emit('request-swap-targets', gameId);
  }
  // For other cards, no immediate action needed
}

function showTutorial() {
    const existingPopup = document.querySelector('.tutorial-popup');
    if (existingPopup) existingPopup.remove();

    const popup = document.createElement('div');
    popup.className = 'tutorial-popup';
    popup.innerHTML = `
        <div class="popup-content">
            <button class="close-button">×</button>
            <h2 class="tutorial-title">HOW TO PLAY</h2>
            
            <div class="tutorial-content">
                <section class="tutorial-section">
                    <h3>🎮 OBJECTIVE</h3>
                    <p>The game is played over as many rounds as it takes. Bank points each
                       round, and the first player to <strong>200 total points</strong> wins.</p>
                </section>

                <section class="tutorial-section">
                    <h3>🔄 YOUR TURN</h3>
                    <p>On your turn you do exactly one of two things:</p>
                    <ul>
                        <li><strong>HIT</strong> — flip the top card of the deck. It goes
                            straight into your hand and takes effect immediately.</li>
                        <li><strong>STAND</strong> — end your round and keep everything you
                            have. Your points are banked when the round finishes.</li>
                    </ul>
                    <p class="tutorial-note">The turn then passes to the next player who is
                       still in the round.</p>
                </section>

                <section class="tutorial-section">
                    <h3>🃏 NUMBER CARDS</h3>
                    <p><strong>0–12:</strong> worth their face value. The deck holds one
                       <strong>0</strong>, one <strong>1</strong>, two <strong>2</strong>s,
                       and so on up to twelve <strong>12</strong>s — 79 cards in total.</p>
                    <p><strong>You may hold at most 7 of them.</strong> Action cards and score
                       modifiers do not count towards that limit.</p>
                    <p>Fill all 7 and your round ends right there with a
                       <strong>+15 bonus</strong>.</p>
                </section>

                <section class="tutorial-section">
                    <h3>💥 BUSTING</h3>
                    <p>Take a number you already hold and you <strong>BUST</strong>: your whole
                       round score is gone and you are out until the next round. Points you
                       banked in earlier rounds are safe.</p>
                    <p class="tutorial-note">⚠️ <strong>0 is a number like any other</strong> —
                       a second 0 busts you just the same.</p>
                    <p>Holding a 🛡️ <strong>Second Chance</strong> when it happens? The 🛡️ is
                       burned instead, the duplicate is discarded, and you play on.</p>
                    <p class="tutorial-note">Stealing and swapping can hand you a duplicate too,
                       so they can bust you the same way a flip can.</p>
                </section>

                <section class="tutorial-section">
                    <h3>⭐ ACTION CARDS</h3>
                    <p>These are played the moment you draw them, and are then discarded.</p>
                    <table class="card-table">
                        <tr>
                            <td><strong>🛡️ Second Chance</strong></td>
                            <td>Kept in hand. Automatically cancels your next bust (3 in deck)</td>
                        </tr>
                        <tr>
                            <td><strong>❄️ Freeze</strong></td>
                            <td>Force any player still in the round — including yourself — to
                                stand. They keep the points they already have (3)</td>
                        </tr>
                        <tr>
                            <td><strong>🎯 Draw Three</strong></td>
                            <td>Pick a player with room left. They must flip three cards in a
                                row, busts and all (3)</td>
                        </tr>
                        <tr>
                            <td><strong>🗑️ Remove Card</strong></td>
                            <td>Delete one card from any player still in the round, yourself
                                included. A 🗑️ cannot be removed (3)</td>
                        </tr>
                        <tr>
                            <td><strong>🥷 Steal Card</strong></td>
                            <td>Take any one card from another player and add it to your hand (2)</td>
                        </tr>
                        <tr>
                            <td><strong>⇄️ Swap Card</strong></td>
                            <td>Trade one card between two different players. Only scoring cards
                                move — numbers, 🛡️ and modifiers (2)</td>
                        </tr>
                        <tr>
                            <td><strong>🃏 Select Card</strong></td>
                            <td>Look through the whole deck and take whatever you want (1)</td>
                        </tr>
                    </table>
                    <p class="tutorial-note">If a card has no legal target it is discarded and
                       your turn ends.</p>
                </section>

                <section class="tutorial-section">
                    <h3>🔢 SCORE MODIFIERS</h3>
                    <p>These stay in your hand and change your round score. They never bust you.</p>
                    <table class="card-table">
                        <tr>
                            <td><strong>2+ 4+ 6+ 8+ 10+</strong></td>
                            <td>Add that many points</td>
                        </tr>
                        <tr>
                            <td><strong>2- 4- 6- 8- 10-</strong></td>
                            <td>Subtract that many points</td>
                        </tr>
                        <tr>
                            <td><strong>2x</strong></td>
                            <td>Double your round score</td>
                        </tr>
                        <tr>
                            <td><strong>2÷</strong></td>
                            <td>Halve your round score, rounded</td>
                        </tr>
                    </table>
                </section>

                <section class="tutorial-section">
                    <h3>🧮 SCORING</h3>
                    <p>Your round score is worked out in this order:</p>
                    <ul>
                        <li>Add up your number cards</li>
                        <li>Apply every <strong>+</strong> and <strong>−</strong> card</li>
                        <li>Then <strong>2x</strong>, then <strong>2÷</strong></li>
                        <li>Finally <strong>+15</strong> if you hold all 7 numbers</li>
                    </ul>
                    <p class="tutorial-note">A round score can never drop below 0.</p>
                    <p><strong>Example:</strong> [3, 5, 7] with 2+ and 2x</p>
                    <p>3 + 5 + 7 = 15 → 15 + 2 = 17 → 17 × 2 = <strong>34 points</strong></p>
                </section>

                <section class="tutorial-section">
                    <h3>🏁 ENDING A ROUND</h3>
                    <p>The round ends as soon as nobody is left drawing — everyone has stood,
                       been frozen, filled 7 cards, or busted.</p>
                    <p>Everyone who did not bust banks their round score. Hands are cleared,
                       totals are kept, and the next round begins.</p>
                    <p>The deck carries over between rounds and is reshuffled from scratch when
                       it runs out. Check <strong>CARDS LEFT</strong> to see exactly what is
                       still in it.</p>
                </section>

                <section class="tutorial-section">
                    <h3>💡 TIPS</h3>
                    <ul>
                        <li>Low numbers are the safe ones — there is only one 1, but twelve 12s</li>
                        <li>Watch the remaining pile before you hit; it tells you the real odds</li>
                        <li>Hold 🛡️ while you push for the +15, not while you are on 10 points</li>
                        <li>❄️ is best aimed at whoever is closest to 200</li>
                        <li>2÷ hurts most on a big hand — pass it on with ⇄️ if you can</li>
                        <li>📜 History shows every card played so far</li>
                    </ul>
                </section>
            </div>
        </div>
    `;

    // Close button functionality
    popup.querySelector('.close-button').addEventListener('click', () => {
        playSound('buttonClick');
        dismissPopup(popup);
        document.removeEventListener('keydown', handleEscape);
    });

    // Close on escape key
    const handleEscape = (e) => {
        if (e.key === 'Escape') {
            dismissPopup(popup);
            document.removeEventListener('keydown', handleEscape);
        }
    };
    document.addEventListener('keydown', handleEscape);

    document.body.appendChild(popup);
}

// ---------------------------------------------------------------------------
// Sound
//
// Each cue plays from a small pool of clones. With a single <audio> element a
// second draw restarted the first one mid-note, so fast play sounded clipped.
// Levels are mixed per cue: clicks sit under the table, wins sit on top.
// ---------------------------------------------------------------------------

const SOUND_LEVELS = {
    buttonClick: 0.25,
    cardFlip: 0.45,
    standSound: 0.45,
    secondChanceSound: 0.6,
    bustCardSound: 0.6,
    bustSound: 0.7,
    roundEnd: 0.6,
    winSound: 0.8
};

const SOUND_POOL_SIZE = 3;
const soundPools = new Map();

function getSoundPool(soundId) {
    if (soundPools.has(soundId)) return soundPools.get(soundId);

    const source = document.getElementById(soundId);
    if (!source) return null;

    const volume = SOUND_LEVELS[soundId] ?? 0.5;
    const pool = [source];
    for (let i = 1; i < SOUND_POOL_SIZE; i++) {
        const clone = source.cloneNode();
        clone.removeAttribute('id');
        pool.push(clone);
    }
    pool.forEach(el => { el.volume = volume; });

    const entry = { pool, next: 0 };
    soundPools.set(soundId, entry);
    return entry;
}

function playSound(soundId) {
    if (!soundEnabled) return;

    const entry = getSoundPool(soundId);
    if (!entry) return;

    const el = entry.pool[entry.next];
    entry.next = (entry.next + 1) % entry.pool.length;

    el.currentTime = 0;
    // Autoplay policy rejects until the first gesture; that is expected, not a bug.
    el.play().catch(() => {});
}

function setSoundEnabled(enabled) {
    soundEnabled = enabled;
    try {
        localStorage.setItem('hit7-sound', enabled ? 'on' : 'off');
    } catch (e) {
        // Private browsing can refuse storage; the toggle still works for this session.
    }
    if (!enabled) {
        soundPools.forEach(({ pool }) => pool.forEach(el => { el.pause(); el.currentTime = 0; }));
    }
    syncSoundButton();
}

function syncSoundButton() {
    const btn = document.getElementById('soundToggle');
    if (!btn) return;
    btn.textContent = soundEnabled ? '🔊' : '🔇';
    btn.title = soundEnabled ? 'Mute sound' : 'Unmute sound';
    btn.setAttribute('aria-label', btn.title);
    btn.setAttribute('aria-pressed', String(!soundEnabled));
}

function initSound() {
    try {
        soundEnabled = localStorage.getItem('hit7-sound') !== 'off';
    } catch (e) {
        soundEnabled = true;
    }

    const btn = document.getElementById('soundToggle');
    if (btn) {
        btn.addEventListener('click', () => {
            setSoundEnabled(!soundEnabled);
            // Play after the flip so unmuting confirms itself audibly.
            if (soundEnabled) playSound('buttonClick');
        });
    }
    syncSoundButton();
}

socket.on('select-draw-three-target', (gameId, targets) => {
  // Disable action buttons during popup
  document.body.style.overflow = 'hidden';
  toggleActionButtons(false);
  
  if (activeDrawThreePopup) {
    activeDrawThreePopup.remove();
    activeDrawThreePopup = null;
  }

  const popup = document.createElement('div');
  popup.className = 'draw-three-popup active';
  popup.innerHTML = `
    <div class="popup-content">
      <h3><span class="emoji">🎯</span> Select player to draw three cards:</h3>
      <div class="draw-three-targets">
        ${targets.map(p => `
          <button class="draw-three-target ${p.id === socket.id ? 'self-target' : ''}" data-id="${p.id}">
            ${escapeHtml(p.name)} ${p.id === socket.id ? '(You)' : ''}
          </button>
        `).join('')}
      </div>
      <button class="view-game-button" id="viewGameButton">
        <span class="icon">👁️</span> Hold to view game
      </button>
    </div>
  `;

  popup.querySelectorAll('.draw-three-target').forEach(btn => {
    btn.addEventListener('click', () => {
      socket.emit('draw-three-select', currentGameId, btn.dataset.id);
      dismissPopup(popup);
    });
  });

  wireViewGameButton(popup);

  document.body.appendChild(popup);
  activeDrawThreePopup = popup;
  
  // Clean up event listeners when popup is removed
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if ([...mutation.removedNodes].includes(popup)) {
        document.body.style.overflow = 'auto';
        observer.disconnect();
      }
    });
  });
  
  observer.observe(document.body, { childList: true });
});