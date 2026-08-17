const socket = io();
let currentGameId = null;
let isHost = false;
const MAX_REGULAR_CARDS = 7;
let activeFreezePopup = null;
let activeDrawThreePopup = null;
let soundEnabled = true;
let currentGameUrl = ""; // New: stores the game URL
let gameHistory = []; // Latest action log, kept in sync from every game update
let latestGame = null; // Last game state received, for popups that outlive one update
let pendingJoinCode = null; // Code awaiting a game-info answer from the server
// gameId -> resolver, for background seat checks that must not touch the form
const seatChecks = new Map();

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
const RECENT_SEATS_KEY = 'hit7-recent-seats';
const RECENT_SEATS_LIMIT = 5;

function saveSession(gameId, token) {
    if (!gameId || !token) return;
    try {
        sessionStorage.setItem(SESSION_KEY, JSON.stringify({ gameId, token }));
    } catch (e) {
        // Private browsing can refuse storage. Reconnecting stops working, nothing else.
        console.warn('Could not save session:', e);
    }
    // Survives the tab closing, which the token does not, so the landing page can still
    // find a way back in. Checked against the server before it is ever offered.
    try {
        rememberSeat(gameId, localStorage.getItem(LAST_NAME_KEY));
    } catch (e) { /* the banner is a nicety, not a requirement */ }
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
    checkUrlParams();
});

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
socket.on('game-info', handleGameInfo);

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
      popup.remove();
    });
  });

  // Add HOLD TO VIEW GAME button functionality
  const viewButton = popup.querySelector('#viewGameButton');
  viewButton.addEventListener('mousedown', (e) => {
    e.preventDefault();
    popup.classList.add('popup-hiding');
  });
  
  viewButton.addEventListener('touchstart', (e) => {
    e.preventDefault();
    popup.classList.add('popup-hiding');
  });
  
  const handleUp = () => {
    if (popup.parentElement) {
      popup.classList.remove('popup-hiding');
    }
  };
  
  document.addEventListener('mouseup', handleUp);
  document.addEventListener('touchend', handleUp);
  
  // Clean up event listeners when popup is removed
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if ([...mutation.removedNodes].includes(popup)) {
        document.removeEventListener('mouseup', handleUp);
        document.removeEventListener('touchend', handleUp);
        observer.disconnect();
      }
    });
  });
  
  document.body.appendChild(popup);
  observer.observe(document.body, { childList: true });
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
    document.getElementById('playersContainer').innerHTML = '';
    
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
    document.getElementById('playersContainer').innerHTML = '';
    
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
    document.getElementById('playersContainer').innerHTML = '';

    socket.emit('create-game', name);
}

// A code can mean three different things depending on what the game is doing, so the
// server is asked before anything is attempted.
function joinGame() {
    playSound('buttonClick');
    clearLobbyError();

    const code = readGameCode();
    if (!code) return;

    pendingJoinCode = code;
    socket.emit('request-game-info', code);
}

function handleGameInfo(info) {
    // A code the player typed takes priority over a background check for the same game,
    // so their click is never swallowed by the banner's housekeeping.
    if (pendingJoinCode !== info.gameId) {
        const check = seatChecks.get(info.gameId);
        if (check) {
            seatChecks.delete(info.gameId);
            check(info);
        }
        return;
    }

    const code = pendingJoinCode;

    if (!info.found) {
        return showLobbyError(`No game called ${code}. Check the code and try again.`, 'gameId');
    }

    if (info.status === 'finished') {
        return showLobbyError('That game has already finished.', 'gameId');
    }

    if (info.canJoin) {
        const name = readPlayerName();
        if (!name) return;
        pendingJoinCode = null;
        socket.emit('join-game', code, name);
        return;
    }

    if (info.status === 'lobby') {
        return showLobbyError(
            `That game is full (${info.playerCount}/${info.maxPlayers} players).`, 'gameId');
    }

    // In progress. The only way in is a seat somebody left behind.
    if (info.reclaimable.length) {
        pendingJoinCode = null;
        showSeatPicker(code, info.reclaimable);
        return;
    }

    showLobbyError(
        'That game is already under way and nobody has dropped out, so there is no seat free.',
        'gameId');
}

// Offers the seats nobody is sitting in. If this browser still remembers being one of
// them, that one is marked so the common case is unambiguous.
function showSeatPicker(code, seats) {
    document.querySelectorAll('.seat-picker-popup').forEach(p => p.remove());

    const lastName = (() => {
        try { return localStorage.getItem(LAST_NAME_KEY); } catch (e) { return null; }
    })();

    const popup = document.createElement('div');
    popup.className = 'seat-picker-popup';
    popup.innerHTML = `
        <div class="popup-content">
            <button class="close-button" aria-label="Cancel">×</button>
            <h2>↩️ REJOIN GAME ${escapeHtml(code)}</h2>
            <p class="seat-picker-lead">This game is under way. These players dropped out —
                pick the one that is you and you will get their cards and score back.</p>
            <div class="seat-list">
                ${seats.map(seat => `
                    <button class="seat-option ${seat.name === lastName ? 'likely' : ''}"
                            data-id="${escapeHtml(seat.id)}">
                        <span class="seat-name">${escapeHtml(seat.name)}</span>
                        ${seat.name === lastName ? '<span class="seat-hint">that’s you</span>' : ''}
                    </button>
                `).join('')}
            </div>
        </div>
    `;

    const close = () => {
        popup.remove();
        document.removeEventListener('keydown', onKey);
    };
    const onKey = e => { if (e.key === 'Escape') close(); };

    popup.querySelector('.close-button').addEventListener('click', () => {
        playSound('buttonClick');
        close();
    });
    popup.addEventListener('click', e => { if (e.target === popup) close(); });
    document.addEventListener('keydown', onKey);

    popup.querySelectorAll('.seat-option').forEach(btn => {
        btn.addEventListener('click', () => {
            playSound('buttonClick');
            popup.querySelectorAll('.seat-option').forEach(b => { b.disabled = true; });
            socket.emit('reclaim-seat', code, btn.dataset.id);
            close();
        });
    });

    document.body.appendChild(popup);
}

// Seats this browser has sat in. Remembering them is what makes a closed tab
// recoverable, but a remembered seat is not the same as an available one: the game may be
// long finished, or somebody may have taken the seat back already. So nothing is offered
// until the server confirms the seat is still there and still empty - otherwise the
// landing page would offer to rejoin yesterday's game every morning.
function readRecentSeats() {
    try {
        const raw = localStorage.getItem(RECENT_SEATS_KEY);
        const list = raw ? JSON.parse(raw) : [];
        return Array.isArray(list) ? list.filter(s => s && s.gameId && s.name) : [];
    } catch (e) {
        return [];
    }
}

function rememberSeat(gameId, name) {
    if (!gameId || !name) return;
    // Keyed by game AND name: two people playing in two tabs of one browser share
    // localStorage, and collapsing them by game alone would lose one of the seats.
    const kept = readRecentSeats().filter(s => !(s.gameId === gameId && s.name === name));
    const list = [{ gameId, name }, ...kept].slice(0, RECENT_SEATS_LIMIT);
    try {
        localStorage.setItem(RECENT_SEATS_KEY, JSON.stringify(list));
    } catch (e) { /* the banner is a nicety, not a requirement */ }
}

function forgetSeat(gameId, name) {
    const list = readRecentSeats()
        .filter(s => !(s.gameId === gameId && (!name || s.name === name)));
    try {
        localStorage.setItem(RECENT_SEATS_KEY, JSON.stringify(list));
    } catch (e) { /* fine */ }
}

// Asks the server what a code leads to, without touching the form. Used to check a
// remembered seat is real before offering it.
function checkGameQuietly(gameId) {
    return new Promise(resolve => {
        seatChecks.set(gameId, resolve);
        socket.emit('request-game-info', gameId);
        // A game that never answers is simply not offered.
        setTimeout(() => {
            if (seatChecks.get(gameId) === resolve) {
                seatChecks.delete(gameId);
                resolve(null);
            }
        }, 4000);
    });
}

async function showRejoinBanner() {
    const banner = document.getElementById('rejoinBanner');
    if (!banner) return;

    const remembered = readRecentSeats();
    if (!remembered.length) return;

    // One request per distinct game, not per seat.
    const gameIds = [...new Set(remembered.map(s => s.gameId))];
    const infos = new Map();
    for (const gameId of gameIds) {
        infos.set(gameId, await checkGameQuietly(gameId));
    }

    const available = [];
    for (const seat of remembered) {
        const info = infos.get(seat.gameId);
        if (!info || !info.found || info.status !== 'playing') {
            // Gone or finished - stop remembering it so this does not run again.
            forgetSeat(seat.gameId, seat.name);
            continue;
        }
        // Only if that particular seat is still sitting empty.
        if (info.reclaimable.some(r => r.name === seat.name)) available.push(seat);
    }

    // The player may have joined a game while these checks were in flight.
    const lobby = document.querySelector('.lobby-screen');
    if (!available.length || !lobby || lobby.style.display === 'none') return;

    renderRejoinBanner(banner, available);
}

function renderRejoinBanner(banner, seats) {
    const textEl = banner.querySelector('.rejoin-text');
    const button = document.getElementById('rejoinButton');

    if (seats.length === 1) {
        const seat = seats[0];
        textEl.textContent = `Your seat in game ${seat.gameId} is still waiting, ${seat.name}.`;
        button.textContent = '↩️ Rejoin';
        button.onclick = () => {
            playSound('buttonClick');
            const codeInput = document.getElementById('gameId');
            if (codeInput) codeInput.value = seat.gameId;
            joinGame();
        };
    } else {
        // Two tabs of one browser can leave two seats behind, so let them pick.
        textEl.textContent = `${seats.length} seats you were in are still waiting.`;
        button.textContent = '↩️ Choose a seat';
        button.onclick = () => {
            playSound('buttonClick');
            const codeInput = document.getElementById('gameId');
            if (codeInput) codeInput.value = seats[0].gameId;
            joinGame();
        };
    }

    banner.hidden = false;

    document.getElementById('dismissRejoin').onclick = () => {
        banner.hidden = true;
        seats.forEach(s => forgetSeat(s.gameId, s.name));
    };
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

// Update the renderCard function to use the new gradient
function renderCard({ cardType, displayValue, count }) {
    let cardStyle = '';
    
    if (cardType !== 'number') {
        if (cardType === 'select-card') {
            // Special gradient for select card - more subtle with fewer colors
            cardStyle = `
                background: linear-gradient(135deg, #e74c3c 0%, #9b59b6 50%, #3498db 100%) !important;
                border-color: #e74c3c !important;
            `;
        } else {
            cardStyle = `
                background: ${
                    cardType === 'adder' ? '#fbb03a' : 
                    cardType === 'minus' ? '#f1624f' :
                    cardType === 'divide' ? '#f1624f' :
                    cardType === 'multiplier' ? '#fbb03a' :
                    cardType === 'second-chance' ? '#e74c3c' :
                    cardType === 'freeze' ? '#3498db' :
                    cardType === 'draw-three' ? '#f1c40f' :
                    cardType === 'remove-card' ? '#9b59b6' :
                    cardType === 'steal-card' ? '#e67e22' :
                    cardType === 'swap-card' ? '#42ae5d' : 'inherit'
                } !important;
                color: ${(cardType === 'minus' || cardType === 'divide' || cardType === 'multiplier' || cardType === 'adder') ? '#fff' : 'inherit'} !important;
            `;
        }
    }

    return `
        <div class="remaining-card ${cardType} ${cardType === 'number' ? 'regular-card' : 'special'}"
             style="${cardStyle}">
            ${displayValue}
            ${count > 1 ? `<span class="card-count">×${count}</span>` : ''}
        </div>
    `;
}

function updateLastCardDrawn(card) {
    const container = document.getElementById('lastCardDrawn');
    if (!container) return;
    
    if (card === null || card === undefined) {
        container.innerHTML = '<span class="no-card">---</span>';
        return;
    }
    
    const { cardType, displayValue } = getCardVisual(card);

    container.innerHTML = `
        <div class="last-card ${cardType} ${cardType === 'number' ? 'regular-card' : 'special'}">
            ${displayValue}
        </div>
    `;
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
    return `<span class="history-card ${cardType}">${escapeHtml(displayValue)}</span>`;
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
        popup.remove();
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

function updateDiscardPile(discardPile) {
  const discardCounts = discardPile.reduce((acc, card) => {
    const key = card.toString();
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  document.getElementById('discard').innerHTML = Object.entries(discardCounts)
    .map(([cardStr, count]) => {
      let cardType, displayValue;
      
      if (cardStr === 'SC') {
        cardType = 'second-chance';
        displayValue = '🛡️';
      } else if (cardStr === 'Freeze') {
        cardType = 'freeze';
        displayValue = '❄️';
      } else if (cardStr === 'D3') {
        cardType = 'draw-three';
        displayValue = '🎯';
      } else if (cardStr === 'RC') {
        cardType = 'remove-card';
        displayValue = '🗑️';
      } else if (cardStr === 'ST') {
        cardType = 'steal-card';
        displayValue = '🥷';
      } else if (cardStr === 'Swap') {
        cardType = 'swap-card';
        displayValue = '⇄️';
      } else if (cardStr === 'Select') {
        cardType = 'select-card';
        displayValue = '🃏';
      } else if (cardStr.includes('+')) {
        cardType = 'adder';
        displayValue = cardStr;
      } else if (cardStr === '2÷') {
        cardType = 'divide';
        displayValue = '2÷';
      } else if (cardStr.includes('x')) {
        cardType = 'multiplier';
        displayValue = cardStr.replace('x', '×');
      } else if (cardStr.includes('-')) {
        cardType = 'minus';
        displayValue = cardStr;
      } else {
        cardType = 'number';
        displayValue = cardStr;
      }

      const cardStyle = cardType !== 'number' ? `
        background: ${
          cardType === 'adder' ? '#fbb03a' : 
          cardType === 'multiplier' ? '#fbb03a' :
          cardType === 'second-chance' ? '#e74c3c' :
          cardType === 'freeze' ? '#3498db' :
          cardType === 'draw-three' ? '#f1c40f' :
          cardType === 'remove-card' ? '#9b59b6' :
          cardType === 'steal-card' ? '#e67e22' :
          cardType === 'swap-card' ? '#42ae5d' :
          cardType === 'divide' ? '#f1624f' :
          cardType === 'minus' ? '#f1624f' : 'inherit'
        } !important;
      ` : '';

      return {
        html: `
          <div class="discard-card ${cardType} ${cardType === 'number' ? 'regular-card' : 'special'}"
               style="${cardStyle}">
            ${displayValue}
            ${count > 1 ? `<span class="discard-count">x${count}</span>` : ''}
          </div>
        `,
        order: {
          'second-chance': 1,
          'freeze': 2,
          'draw-three': 3,
          'remove-card': 4,
          'steal-card': 5,
          'swap-card': 6,
          'adder': 7,
          'multiplier': 8,
          'divide': 9,
          'minus': 10,
          'number': 11
        }[cardType] || 999
      };
    })
    .sort((a, b) => a.order - b.order)
    .map(item => item.html)
    .join('');
}

function renderPlayers(game) {
    document.getElementById('playersContainer').innerHTML = game.players
        .map((player, index) => playerTemplate(player, index === game.currentPlayer))
        .join('');
}

function playerTemplate(player, isCurrentTurn) {
    const emptyRegularSlots = Array(7 - player.regularCards.length).fill(0)
        .map(() => '<div class="empty-slot"></div>').join('');
    const emptySpecialSlots = Array(7 - player.specialCards.length).fill(0)
        .map(() => '<div class="empty-slot special"></div>').join('');

    // connected is absent on the stripped-down player objects some popups pass in, so
    // only an explicit false counts as away.
    const isAway = player.connected === false;

    return `
        <div class="player ${isCurrentTurn ? 'current-turn' : ''} ${player.status} ${isAway ? 'disconnected' : ''}" data-player-id="${player.id}">
            <div class="player-header">
                <h3>${escapeHtml(player.name.toUpperCase())} ${player.id === socket.id ? '<span class="you">(YOU)</span>' : ''}</h3>
                <div class="player-status">
                    ${isAway ? '<div class="away-indicator">🔌 DISCONNECTED</div>' : ''}
                    ${getStatusIcon(player.status)}
                    ${player.bustedCard ? `<div class="busted-card">BUSTED ON ${player.bustedCard}</div>` : ''}
                    ${player.specialCards.includes('SC') ? `
                        <div class="second-chance-indicator">🛡️ SECOND CHANCE</div>
                    ` : ''}
                </div>
            </div>
            
            <div class="scores">
                ${scoreBox('ROUND SCORE', player.roundScore)}
                ${scoreBox('TOTAL SCORE', player.totalScore)}
                ${scoreBox('CARDS', `${player.regularCards.length}/${MAX_REGULAR_CARDS}`)}
            </div>

            <div class="cards-section">
                <div class="cards-container">
                    <div class="cards-label">REGULAR CARDS</div>
                    <div class="card-grid regular">
                        ${player.regularCards.map(card => `<div class="card">${card}</div>`).join('')}
                        ${emptyRegularSlots}
                    </div>
                </div>

                <div class="cards-container">
                    <div class="cards-label">SPECIAL CARDS</div>
                    <div class="card-grid special">
                        ${player.specialCards.map(card => {
                            const cardClass = getSpecialCardClass(card);
                            const cardDisplay = getSpecialCardDisplay(card);
                            
                            // Add inline style for special cards
                            let cardStyle = '';
                            if (card === 'Select') {
                                cardStyle = 'background: linear-gradient(135deg, #e74c3c 0%, #9b59b6 50%, #3498db 100%) !important; border-color: #e74c3c !important;';
                            } else if (card === 'Swap') {
                                cardStyle = 'background: #42ae5d !important; border-color: #42ae5d !important; color: white !important;';
                            } else if (card.endsWith('+') || card === '2x') {
                              cardStyle = 'background: #fbb03a !important; border-color: #fbb03a !important; color: white !important;';
                            } else if (card === 'ST') {
                              cardStyle = 'background: #e67e22 !important; color: white !important;';
                            } else if (card === '2÷' || card.endsWith('-')) {
                                cardStyle = 'background: #f1624f !important; border-color: #f1624f !important; color: white !important;';
                            }
                            
                            return `<div class="card special ${cardClass}" ${cardStyle ? `style="${cardStyle}"` : ''}>
                                ${cardDisplay}
                            </div>`;
                        }).join('')}
                        ${emptySpecialSlots}
                    </div>
                </div>
            </div>

            ${player.drawThreeRemaining > 0 ? `
                <div class="draw-three-indicator">
                    🎯 DRAW ${player.drawThreeRemaining} MORE CARDS
                </div>
            ` : ''}
        </div>
    `;
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
    const statusMap = {
        active: ['⭐', 'ACTIVE'],
        stood: ['🛑', 'STOOD'], 
        busted: ['💥', 'BUSTED'],
        waiting: ['⏳', 'WAITING'],
        frozen: ['❄️', 'FROZEN'] // Add frozen status
    };
    return `
        <span class="status-icon">${statusMap[status][0]}</span>
        <span class="status-text">${statusMap[status][1]}</span>
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

// Add this helper function to get current game state
function getCurrentGameState() {
    const container = document.getElementById('playersContainer');
    const players = [...container.querySelectorAll('.player')].map(playerEl => {
        const isCurrentTurn = playerEl.classList.contains('current-turn');
        const drawThreeRemaining = parseInt(playerEl.querySelector('.draw-three-indicator')?.textContent.match(/\d+/) || 0);
        const status = playerEl.classList.contains('busted') ? 'busted' : 
                      playerEl.classList.contains('stood') ? 'stood' : 
                      playerEl.classList.contains('frozen') ? 'frozen' : 'active';
        return {
            id: playerEl.dataset.playerId,
            drawThreeRemaining,
            status
        };
    });
    
    const currentPlayerIndex = players.findIndex(p => 
        p.id === socket.id && document.querySelector(`.player[data-player-id="${p.id}"]`)?.classList.contains('current-turn')
    );

    return {
        players,
        currentPlayer: currentPlayerIndex
    };
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
    pendingJoinCode = null;
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
                <button onclick="startGame()" id="startGameBtn" class="game-button green" 
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

    showRejoinBanner();
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
            popup.remove();
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
            popup.remove();
        });
    }
}

function handleGameOver({ players, winner }) {
    playSound('winSound');
    toggleActionButtons(false);
    // Nothing left to rejoin, so it stops being offered. A rematch re-remembers it.
    if (currentGameId) forgetSeat(currentGameId);
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
            popup.remove();
        }
        count--;
    }, 1000);
}

function showFreezePopup(gameId, targets) {
  // Cleanup any existing popup
  if (activeFreezePopup) {
    activeFreezePopup.remove();
    activeFreezePopup = null;
  }

  // Create new popup
  activeFreezePopup = document.createElement('div');
  activeFreezePopup.id = 'freezePopup';
  activeFreezePopup.className = 'freeze-popup';
  activeFreezePopup.innerHTML = `
    <div class="popup-content">
      <h3><span class="emoji">❄️</span> Select a player to freeze:</h3>
      <div class="freeze-targets">
        ${targets.map(t => `
          <button class="freeze-target ${t.id === socket.id ? 'self-target' : ''}" data-id="${t.id}">
            ${escapeHtml(t.name)} ${t.id === socket.id ? '(You)' : ''}
          </button>
        `).join('')}
      </div>
      <button class="view-game-button" id="viewGameButton">
        <span class="icon">👁️</span> Hold to view game
      </button>
    </div>
  `;

  activeFreezePopup.querySelectorAll('.freeze-target').forEach(btn => {
    btn.addEventListener('click', () => {
      socket.emit('freeze-player', currentGameId, btn.dataset.id);
      activeFreezePopup.remove();
      activeFreezePopup = null;
    });
  });

  // Add HOLD TO VIEW GAME button functionality
  const viewButton = activeFreezePopup.querySelector('#viewGameButton');
  viewButton.addEventListener('mousedown', (e) => {
    e.preventDefault();
    activeFreezePopup.classList.add('popup-hiding');
  });
  
  viewButton.addEventListener('touchstart', (e) => {
    e.preventDefault();
    activeFreezePopup.classList.add('popup-hiding');
  });
  
  const handleUp = () => {
    if (activeFreezePopup && activeFreezePopup.parentElement) {
      activeFreezePopup.classList.remove('popup-hiding');
    }
  };
  
  document.addEventListener('mouseup', handleUp);
  document.addEventListener('touchend', handleUp);
  
  document.body.appendChild(activeFreezePopup);

  // Clean up event listeners when popup is removed
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if ([...mutation.removedNodes].includes(activeFreezePopup)) {
        document.removeEventListener('mouseup', handleUp);
        document.removeEventListener('touchend', handleUp);
        observer.disconnect();
      }
    });
  });
  
  observer.observe(document.body, { childList: true });

  // Add auto-removal listeners
  const cleanup = () => {
    if (activeFreezePopup) {
      activeFreezePopup.remove();
      activeFreezePopup = null;
    }
    socket.off('game-update', cleanup);
    socket.off('cancel-freeze', cleanup);
  };

  socket.once('game-update', cleanup);
  socket.once('cancel-freeze', cleanup);
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
                    style="background: ${getCardColor(card)}; color: white;"
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
      popup.remove();
    });
  });

  // Add HOLD TO VIEW GAME button functionality
  const viewButton = popup.querySelector('#viewGameButton');
  viewButton.addEventListener('mousedown', (e) => {
    e.preventDefault();
    popup.classList.add('popup-hiding');
  });
  
  viewButton.addEventListener('touchstart', (e) => {
    e.preventDefault();
    popup.classList.add('popup-hiding');
  });
  
  const handleUp = () => {
    if (popup.parentElement) {
      popup.classList.remove('popup-hiding');
    }
  };
  
  document.addEventListener('mouseup', handleUp);
  document.addEventListener('touchend', handleUp);
  
  document.body.appendChild(popup);
  
  // Clean up event listeners when popup is removed
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if ([...mutation.removedNodes].includes(popup)) {
        document.removeEventListener('mouseup', handleUp);
        document.removeEventListener('touchend', handleUp);
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
                      style="background: ${getCardColor(card)}; color: white;"
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
      popup.remove();
    }
  });

  const viewButton = popup.querySelector('#viewGameButton');
  viewButton.addEventListener('mousedown', (e) => {
    e.preventDefault();
    popup.classList.add('popup-hiding');
  });

  viewButton.addEventListener('touchstart', (e) => {
    e.preventDefault();
    popup.classList.add('popup-hiding');
  });

  const handleUp = () => {
    if (popup.parentElement) {
      popup.classList.remove('popup-hiding');
    }
  };

  document.addEventListener('mouseup', handleUp);
  document.addEventListener('touchend', handleUp);

  document.body.appendChild(popup);

  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if ([...mutation.removedNodes].includes(popup)) {
        document.removeEventListener('mouseup', handleUp);
        document.removeEventListener('touchend', handleUp);
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
                    style="background: ${getCardColor(card)}; color: white;"
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
      popup.remove();
    });
  });

  const viewButton = popup.querySelector('#viewGameButton');
  viewButton.addEventListener('mousedown', (e) => {
    e.preventDefault();
    popup.classList.add('popup-hiding');
  });

  viewButton.addEventListener('touchstart', (e) => {
    e.preventDefault();
    popup.classList.add('popup-hiding');
  });

  const handleUp = () => {
    if (popup.parentElement) {
      popup.classList.remove('popup-hiding');
    }
  };

  document.addEventListener('mouseup', handleUp);
  document.addEventListener('touchend', handleUp);

  document.body.appendChild(popup);

  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if ([...mutation.removedNodes].includes(popup)) {
        document.removeEventListener('mouseup', handleUp);
        document.removeEventListener('touchend', handleUp);
        document.body.style.overflow = 'auto';
        observer.disconnect();
      }
    });
  });

  observer.observe(document.body, { childList: true });
}

// Add helper function to get card background color
function getCardColor(card) {
    if (card === 'SC') return '#e74c3c';
    if (card === 'Freeze') return '#3498db';
    if (card === 'D3') return '#f1c40f';
    if (card === 'RC') return '#9b59b6';
  if (card === 'ST') return '#e67e22';
    if (card === 'Swap') return '#42ae5d';
    if (card === 'Select') return 'linear-gradient(135deg, #e74c3c 0%, #9b59b6 50%, #3498db 100%)';
    if (card.endsWith('+')) return '#fbb03a';
    if (card.endsWith('x')) return '#fbb03a';
    if (card === '2÷') return '#f1624f';
    if (card.endsWith('-')) return '#f1624f';
    return 'inherit';
}

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
            const cardStyle = getCardColorStyle(card);
            
            return `
              <button class="card-button special ${cardClass}" 
                     data-card="${card}" 
                     style="${cardStyle}">
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
      popup.remove();
      
      // Handle selected card
      handleSelectedCard(gameId, finalCard);
    });
  });
  
  // Add HOLD TO VIEW GAME button functionality
  const viewButton = popup.querySelector('#viewGameButton');
  viewButton.addEventListener('mousedown', (e) => {
    e.preventDefault(); // Prevent default behavior
    popup.classList.add('popup-hiding');
  });
  
  viewButton.addEventListener('touchstart', (e) => {
    e.preventDefault(); // Prevent default behavior
    popup.classList.add('popup-hiding');
  });
  
  // Handle mouseup and touchend on the button or anywhere on the document
  const handleUp = () => {
    if (popup.parentElement) { // Check if popup is still in the DOM
      popup.classList.remove('popup-hiding');
    }
  };
  
  // Add event listeners for mouseup and touchend
  document.addEventListener('mouseup', handleUp);
  document.addEventListener('touchend', handleUp);
  
  // Add a cleanup function to remove event listeners when popup is removed
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if ([...mutation.removedNodes].includes(popup)) {
        document.removeEventListener('mouseup', handleUp);
        document.removeEventListener('touchend', handleUp);
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

// Add helper function for card color styling
function getCardColorStyle(card) {
  if (card === 'SC') return 'background: #e74c3c !important;';
  if (card === 'Freeze') return 'background: #3498db !important;';
  if (card === 'D3') return 'background: #f1c40f !important; color: #2c3e50 !important;';
  if (card === 'RC') return 'background: #9b59b6 !important; color: white !important;';
  if (card === 'ST') return 'background: #e67e22 !important; color: white !important;';
  if (card === 'Swap') return 'background: #42ae5d !important; color: white !important;';
  if (card === 'Select') return 'background: linear-gradient(135deg, #e74c3c 0%, #9b59b6 50%, #3498db 100%) !important;';
  if (card.endsWith('+')) return 'background: #fbb03a !important; color: white !important;';
  if (card.endsWith('x')) return 'background: #fbb03a !important; color: white !important;';
  if (card === '2÷') return 'background: #f1624f !important; color: white !important;';
  if (card.endsWith('-')) return 'background: #f1624f !important; color: white !important;';
  return '';
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
        popup.remove();
        document.removeEventListener('keydown', handleEscape);
    });

    // Close on escape key
    const handleEscape = (e) => {
        if (e.key === 'Escape') {
            popup.remove();
            document.removeEventListener('keydown', handleEscape);
        }
    };
    document.addEventListener('keydown', handleEscape);

    document.body.appendChild(popup);
}

function playSound(soundId) {
    if (!soundEnabled) return;
    const sound = document.getElementById(soundId);
    if (sound) {
        sound.volume = 0.5; // Set volume to 50%
        sound.currentTime = 0; // Reset sound to start
        sound.play().catch(e => console.log('Sound play failed:', e));
    }
}

// Add sound toggle functionality
function toggleSound() {
    soundEnabled = !soundEnabled;
    const icon = document.querySelector('.sound-toggle i');
    icon.textContent = soundEnabled ? '🔊' : '🔇';
    playSound('buttonClick');
}

// Remove sound from handleNumberCard since server will handle it
function handleNumberCard(game, player, card) {
    if (card === 0) {
        // Zero card can't cause a bust and can be held multiple times
        player.regularCards.push(card);
        // Add 15 bonus points if player reaches 7 cards in one turn
        if (player.regularCards.length === MAX_REGULAR_CARDS) {
            player.status = 'stood';
            player.totalScore += 15; // Add bonus points
        }
    } else if (player.regularCards.includes(card)) {
        const scIndex = player.specialCards.indexOf('SC');
        if (scIndex > -1) {
            player.specialCards.splice(scIndex, 1);
            game.discardPile.push('SC');
        } else {
            player.status = 'busted';
            player.bustedCard = card;
            player.roundScore = 0;
        }
    } else {
        player.regularCards.push(card);
        // Add 15 bonus points if player reaches 7 cards in one turn
        if (player.regularCards.length === MAX_REGULAR_CARDS) {
            player.status = 'stood';
            player.totalScore += 15; // Add bonus points
        }
    }
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
      popup.remove();
    });
  });

  // Add HOLD TO VIEW GAME button functionality
  const viewButton = popup.querySelector('#viewGameButton');
  viewButton.addEventListener('mousedown', (e) => {
    e.preventDefault();
    popup.classList.add('popup-hiding');
  });
  
  viewButton.addEventListener('touchstart', (e) => {
    e.preventDefault();
    popup.classList.add('popup-hiding');
  });
  
  const handleUp = () => {
    if (popup.parentElement) {
      popup.classList.remove('popup-hiding');
    }
  };
  
  document.addEventListener('mouseup', handleUp);
  document.addEventListener('touchend', handleUp);

  document.body.appendChild(popup);
  activeDrawThreePopup = popup;
  
  // Clean up event listeners when popup is removed
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if ([...mutation.removedNodes].includes(popup)) {
        document.removeEventListener('mouseup', handleUp);
        document.removeEventListener('touchend', handleUp);
        document.body.style.overflow = 'auto';
        observer.disconnect();
      }
    });
  });
  
  observer.observe(document.body, { childList: true });
});