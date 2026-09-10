// Bumped by hand whenever something ships that is worth being able to identify from a
// phone. Installed on a home screen, iOS keeps the page suspended rather than reloading
// it, so "is this fixed" and "is this the old page" look identical from the outside.
// It is printed at the bottom of How To Play, which is two taps away on any device.
const BUILD = '2026-09-10.1';

const socket = io();
let currentGameId = null;
let isHost = false;
const MAX_REGULAR_CARDS = 7;
// Mirrors MAX_PLAYERS and MAX_BOTS in lib/rules.js. Only used to work out how many bot
// seats are still going spare; the server clamps the number it is actually sent
// regardless. Bots have their own, lower ceiling - the table grew, the bots did not.
const MAX_PLAYERS = 10;
const MAX_BOTS = 5;
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
        // No playSound here: createGame() plays it. Doing both is two clicks for one tap.
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

    if (flipCardBtn) flipCardBtn.onclick = function() {
        if (flipCardBtn.disabled) return;
        // Same again: flipCard() plays the flip. This was playing it a second time, which
        // is the doubled sound on every hit.
        flipCard();
    };
    if (standBtn) standBtn.onclick = function() {
        if (standBtn.disabled) return;
        playSound('buttonClick');
        stand();
    };

    wireSettingsMenu();

    // The last-action strip is the way into the log now. It replaced a header button
    // that opened the same popup from further away, which is why the header lost one.
    const lastAction = document.getElementById('lastAction');
    if (lastAction) lastAction.onclick = function() {
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

    const wasTargeting = popup.matches(TARGET_POPUPS);
    const done = () => {
        popup.remove();
        if (wasTargeting) toggleActionButtons(lastActionButtonsActive);
    };
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
socket.on('error', handleError);
socket.on('round-summary', handleRoundSummary);
socket.on('rejoined', handleRejoined);
socket.on('rejoin-failed', handleRejoinFailed);
socket.on('round-restarted', handleRoundRestarted);
socket.on('turn-timeout', handleTurnTimeout);
socket.on('returned-to-lobby', handleReturnedToLobby);
socket.on('game-cancelled', handleGameCancelled);
socket.on('left-lobby', () => returnToStartScreen());
socket.on('removed-from-game', handleRemovedFromGame);

// Fires on the first connection and again after every reconnect, so it is the one place
// that can put a returning player back in their seat - whether they reloaded the page or
// just went through a tunnel.
socket.on('connect', () => {
    hideConnectionLostOverlay();
    hideOfflineNotice();
    const session = loadSession();
    if (session) socket.emit('rejoin-game', session.gameId, session.token);
});

// The page is served from the service worker's cache now, so somebody with no
// connection gets a lobby that looks perfectly fine and quietly does nothing when they
// tap it. The browser's own error page used to say so; this has to instead.
socket.on('connect_error', () => {
    // Anyone mid-game already gets the reconnecting overlay. This is for the person who
    // opened a cached page with nothing behind it.
    if (!loadSession()) showOfflineNotice();
});

// socket.io retries on its own; this only tells the player why the game stopped
// responding, so they do not start mashing buttons.
socket.on('disconnect', () => {
    if (loadSession()) showConnectionLostOverlay();
});

// A backgrounded phone has its socket killed and its timers frozen, so socket.io's own
// retry does not fire until the page is awake again - and then only when its backoff
// next comes round, which by then can be several seconds. Coming back to the app is the
// one moment we know for certain the connection is worth trying, so it is tried at once.
// The server holds the seat for a grace period; this is what gets back inside it.
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (socket.connected) return;
    // Clears any backoff still counting down, so this is an immediate attempt rather
    // than one queued behind the wait socket.io had already scheduled.
    socket.connect();
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

// The connect and disconnect handlers that used to sit here were a leftover second set.
// The disconnect one called alert(), which blocks the whole page until it is dismissed -
// and a phone drops its socket every time you switch apps, so glancing at a message came
// back to a modal browser popup. The real handlers are at the top of this file.

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


// ---------------------------------------------------------------------------
// Installability
//
// Registered from here rather than an inline <script> because the page is served under
// script-src 'self'. A failure is not worth telling the player about: the service worker
// only makes the game start faster and lets it be installed, and the game plays exactly
// the same without one.
// ---------------------------------------------------------------------------
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
}

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

// ---------------------------------------------------------------------------
// Game settings
//
// The server owns these and validates every change; this half only draws them and
// sends what the host taps. The card counts are duplicated from lib/deck.js because
// the lobby has to show them before a deck is ever dealt.
// ---------------------------------------------------------------------------

const DECK_MODE_INFO = {
    normal: {
        label: 'Normal',
        size: 94,
        blurb: 'The Flip 7 deck. Numbers, Freeze, Draw Three, Second Chance and the plus cards.'
    },
    extreme: {
        label: 'Extreme',
        size: 108,
        blurb: 'Everything. Adds Remove, Steal, Swap, Select, the minus cards and Halve.'
    }
};

const WIN_SCORE_OPTIONS = [100, 150, 200, 300];

// None up to MAX_BOTS. Built rather than written out, so it follows the cap if that
// ever changes.
const BOT_COUNT_OPTIONS = Array.from({ length: MAX_BOTS + 1 }, (_, n) => n);

const DEFAULT_SETTINGS = { deckMode: 'extreme', winningScore: 200, botCount: 0 };

const settingsOf = game => {
    const settings = { ...DEFAULT_SETTINGS, ...(game && game.settings) };
    if (!DECK_MODE_INFO[settings.deckMode]) settings.deckMode = DEFAULT_SETTINGS.deckMode;
    if (!Number.isInteger(settings.botCount)) settings.botCount = 0;
    return settings;
};

// Only the host gets buttons. Everyone else gets exactly the same information as plain
// text, so nobody has to ask what they are about to play.
function renderLobbySettings(gameData) {
    const panel = document.getElementById('lobbySettings');
    if (!panel) return;

    const settings = settingsOf(gameData);

    const option = (isSelected, attrs, inner) => isHost
        ? `<button type="button" class="setting-option${isSelected ? ' selected' : ''}" ${attrs}>${inner}</button>`
        : `<span class="setting-option${isSelected ? ' selected' : ''}">${inner}</span>`;

    const deckOptions = Object.entries(DECK_MODE_INFO).map(([id, info]) => option(
        id === settings.deckMode,
        `data-setting="deckMode" data-value="${id}"`,
        `${info.label}<span class="setting-sub">${info.size} cards</span>`
    )).join('');

    const scoreOptions = WIN_SCORE_OPTIONS.map(score => option(
        score === settings.winningScore,
        `data-setting="winningScore" data-value="${score}"`,
        String(score)
    )).join('');

    // Bots take real seats, so anything above the number going spare is not on
    // offer. The server clamps it too; this is only so the lobby does not lie.
    const players = (gameData && gameData.players) || [];
    const humans = players.filter(p => !p.isBot).length;
    const roomFor = Math.min(MAX_BOTS, Math.max(0, MAX_PLAYERS - humans));

    const botOptions = BOT_COUNT_OPTIONS.map(count => option(
        count === settings.botCount,
        `data-setting="botCount" data-value="${count}"${count > roomFor ? ' disabled' : ''}`,
        String(count)
    )).join('');

    const bots = players.filter(p => p.isBot);
    const botBlurb = bots.length
        ? `Playing: ${bots.map(p => `${escapeHtml(p.name)} (${escapeHtml(botLabel(p))})`).join(', ')}.`
        : 'Add a bot or two to fill the table. One bot is enough for a game.';

    panel.innerHTML = `
        <div class="setting-group">
            <div class="setting-label">Deck</div>
            <div class="setting-options">${deckOptions}</div>
            <p class="setting-blurb">${escapeHtml(DECK_MODE_INFO[settings.deckMode].blurb)}</p>
        </div>
        <div class="setting-group">
            <div class="setting-label">First to</div>
            <div class="setting-options">${scoreOptions}</div>
        </div>
        <div class="setting-group">
            <div class="setting-label">Bots</div>
            <div class="setting-options">${botOptions}</div>
            <p class="setting-blurb">${botBlurb}</p>
        </div>
        ${isHost ? '' : '<p class="setting-blurb">The host picks these.</p>'}
    `;
}

// Bots come down with the personality they were built with, so the lobby can say
// who it is you are about to play. Falls back rather than showing a blank.
function botLabel(player) {
    return (player && player.bot && player.bot.label) || 'Bot';
}

// One row of the lobby list. Kept in one place because two different renderers
// draw this list, and the badge has to be on both of them.
function lobbyPlayerRow(player, hostId) {
    // Their seat is held rather than freed now, so a lobby that just showed them present
    // would have everyone waiting on somebody who has walked off. `connected` and not
    // `away` on purpose: the popup needs the grace period, a quiet badge does not.
    const isAway = player.connected === false;

    // A shared link is open to anyone who has it, so the host needs a way to clear a
    // seat before the deal. Never on a bot - the number of those is a setting, and the
    // server refuses it - and never on the host's own row, which is what the cancel
    // button below the list is for.
    const canKick = isHost && !player.isBot && player.id !== hostId;

    return `
        <div class="player-item${player.isBot ? ' is-bot' : ''}${isAway ? ' is-away' : ''}">
            <span class="player-item-name">${escapeHtml(player.name)}</span>
            ${player.isBot ? `<span class="bot-badge">🤖 ${escapeHtml(botLabel(player))}</span>` : ''}
            ${isAway ? '<span class="away-badge">📵 away</span>' : ''}
            ${player.id === hostId ? '<span class="host-badge">HOST</span>' : ''}
            ${canKick ? `
                <button type="button" class="lobby-kick-button"
                    data-kick-id="${escapeHtml(player.id)}"
                    data-kick-name="${escapeHtml(player.name)}"
                    aria-label="Remove ${escapeHtml(player.name)}">×</button>
            ` : ''}
        </div>
    `;
}

// Delegated, so re-rendering the panel's contents never loses the handler.
function wireLobbySettings() {
    const panel = document.getElementById('lobbySettings');
    if (!panel || panel.dataset.wired) return;
    panel.dataset.wired = 'true';

    panel.addEventListener('click', event => {
        const button = event.target.closest('button[data-setting]');
        if (!button || !isHost || button.disabled) return;
        const { setting, value } = button.dataset;
        const numeric = setting === 'winningScore' || setting === 'botCount';
        socket.emit('update-settings', currentGameId, {
            [setting]: numeric ? Number(value) : value
        });
    });
}

// The target score is the one rule a player cannot work out from the board.
function updateSettingsDisplay(game) {
    const settings = settingsOf(game);

    const target = document.getElementById('targetScore');
    if (target) target.textContent = settings.winningScore;

    // Lives at the top of the settings menu now rather than in the header. It says what
    // everybody agreed to play, which is worth being able to check and not worth a
    // permanent slot in a row that has to fit on a phone.
    const mode = document.getElementById('settingsMode');
    if (mode) {
        const info = DECK_MODE_INFO[settings.deckMode];
        mode.textContent = `${info.label} deck · first to ${settings.winningScore}`;
        mode.hidden = false;
    }
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

    // Was only assigned in the 'playing' branch below, so a lobby never recomputed it:
    // the stand-in who takes over when a host drops kept seeing a non-host waiting room,
    // and returning to the lobby carried whatever the last round happened to leave here.
    // hostId is a live socket id the server re-derives on every connection change, so
    // this is simply true wherever it is asked.
    isHost = socket.id === game.hostId;

    // Which is also why the host-only half of the settings menu is re-derived on every
    // update rather than set once when the game starts.
    syncSettingsHostItems(game);

    // Update deck count immediately
    document.getElementById('deckCount').textContent = game.deck.length;
    updateSettingsDisplay(game);
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
                playersList.innerHTML = game.players
                    .map(player => lobbyPlayerRow(player, game.hostId)).join('');
            }
            // Always update the start button when we get a game update in lobby
        // Update share link input too
        const shareInput = waitingScreen.querySelector('#shareLinkInput');
        if (shareInput) {
          shareInput.value = currentGameUrl || (window.location.origin + '/join/' + (game.id || currentGameId || ''));
        }
        renderLobbySettings(game);
        updateLobbyExitButton();
        wireLobbyExit(waitingScreen);
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
        const isCurrentPlayer = game.players[game.currentPlayer]?.id === socket.id;
        // The server refuses every action while someone is missing, so the buttons have
        // to say so rather than looking live and doing nothing. `away` and not
        // `!connected`: the server gives a dropped socket a few seconds to come back
        // before it counts, and locking the table during those seconds is the thing this
        // is here to avoid.
        const paused = game.players.some(p => p.away);
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
    updateSettingsDisplay(game);
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
    'timeout': '⏰',
    'deck-empty': '📭',
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
    'ended-early': '🏁',
    'left': '🚪',
    'disconnected': '🔌',
    'reconnected': '🔗',
    'kicked': '🥾',
    'botified': '🤖'
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
        case 'timeout':       return `${player} <span class="history-bad">ran out of time</span> and busted`;
        case 'deck-empty':    return `${player} could not draw — every card is in a hand`;
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
        case 'ended-early':  return `the host <span class="history-bad">ended the game early</span> — ${player} was ahead`;
        case 'left':          return `${player} left the game`;
        case 'disconnected':  return `${player} <span class="history-bad">lost connection</span> — round paused`;
        case 'reconnected':   return `${player} <span class="history-good">is back</span>`;
        case 'kicked':        return `${player} was removed by the host`;
        case 'botified':      return `${player} dropped — a bot took over their seat`;
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

// The strip under the header. Deliberately built from the same entry and the same
// formatter the log popup uses, so the two can never word the same move differently -
// and so a new action type only has to be taught to formatHistoryEntry once.
let lastActionId = null;

function updateLastAction(history) {
    const strip = document.getElementById('lastAction');
    const icon = document.getElementById('lastActionIcon');
    const text = document.getElementById('lastActionText');
    if (!strip || !icon || !text) return;

    const entry = Array.isArray(history) && history.length ? history[history.length - 1] : null;
    if (!entry) {
        lastActionId = null;
        icon.textContent = '▶️';
        text.textContent = 'Waiting for the first move…';
        return;
    }

    // Every broadcast carries the whole log, so this runs constantly with nothing new
    // in it. Only an entry we have not shown before is worth redrawing or flashing.
    if (entry.id === lastActionId) return;
    const isFirst = lastActionId === null;
    lastActionId = entry.id;

    icon.textContent = HISTORY_ICONS[entry.action] || '•';
    text.innerHTML = formatHistoryEntry(entry);

    // Nothing to announce on the first paint - that is the state of the game, not a
    // move somebody just made.
    if (isFirst) return;

    // Restarted rather than added: two moves in quick succession should flash twice,
    // and a class that is already on the element will not replay its animation.
    strip.classList.remove('is-new');
    void strip.offsetWidth;
    strip.classList.add('is-new');
}

function updateHistory(history) {
    gameHistory = Array.isArray(history) ? history : [];
    updateLastAction(gameHistory);

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
    const missing = game.players.filter(p => p.away);
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
                    <button class="game-button green botify-button" data-id="${escapeHtml(player.id)}">
                        Let a bot take over
                    </button>
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
            ? 'A bot can take their seat and keep their cards and score, and this round carries on. '
              + 'Removing them instead replays the round from the start.'
            : 'The host can wait, hand their seat to a bot, or remove them and restart the round.';
    }

    listEl.querySelectorAll('.botify-button').forEach(btn => {
        btn.addEventListener('click', () => {
            // Nothing is lost by doing this, so it does not need a confirmation the way
            // removing somebody does.
            playSound('buttonClick');
            btn.disabled = true;
            socket.emit('replace-with-bot', currentGameId, btn.dataset.id);
        });
    });

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
    // `away`, not `!connected` - a socket that dropped a second ago is given a grace
    // period by the server before the table stops, and this popup is the table stopping.
    const missing = game.players.filter(p => p.away);

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
let offlineNotice = null;

function showOfflineNotice() {
    if (offlineNotice || socket.connected) return;

    offlineNotice = document.createElement('div');
    offlineNotice.className = 'restart-notice offline-notice';
    offlineNotice.innerHTML = `
        <strong>📡 No connection</strong>
        <span>HIT 7 needs the internet to play. This clears itself the moment you are back.</span>
    `;
    document.body.appendChild(offlineNotice);
}

function hideOfflineNotice() {
    if (offlineNotice) offlineNotice.remove();
    offlineNotice = null;
}

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
            ${scoreBox('ROUND', 0)}
            ${scoreBox('TOTAL', 0)}
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
    panel.classList.toggle('bot', Boolean(player.isBot));
    ['active', 'stood', 'busted', 'waiting', 'frozen'].forEach(s => {
        panel.classList.toggle(s, player.status === s);
    });

    const nameEl = panel.querySelector('.player-header h3');
    const botMark = player.isBot ? '<span class="bot-mark" title="Bot">🤖</span> ' : '';
    const nameHtml = `${botMark}${escapeHtml(player.name.toUpperCase())} ${player.id === socket.id ? '<span class="you">(YOU)</span>' : ''}`;
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
            <div class="score-label">${label}</div>
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

// Every popup that holds the turn until it is aimed at somebody.
const TARGET_POPUPS =
    '.freeze-popup, .draw-three-popup, .remove-card-popup, ' +
    '.steal-card-popup, .swap-card-popup, .select-card-popup';

// The last state handleGameUpdate asked for, so the buttons can be recomputed
// when a picker closes without a fresh update arriving behind it.
let lastActionButtonsActive = false;

// UI controls
function toggleActionButtons(active) {
    lastActionButtonsActive = active;
    const flipCardBtn = document.getElementById('flipCard');
    const standButton = document.getElementById('standButton');

    // A targeting card that has not been aimed yet still owns the turn: the
    // server drops `flip-card` and `stand` outright while pendingTarget is set
    // (server.js). Without this the buttons stay lit underneath the picker, and
    // stay lit while peeking at the board with it - so they look live, take the
    // tap, and do nothing. Same reasoning as the paused-table check in
    // handleGameUpdate: a button that cannot act has to say so.
    const aiming = [...document.querySelectorAll(TARGET_POPUPS)]
        .some(popup => !popup.classList.contains('popup-closing'));
    const enabled = active && !aiming;

    // Always show buttons but disable them when not active
    if (flipCardBtn) {
        flipCardBtn.disabled = !enabled;
        flipCardBtn.style.display = 'block';
    }
    if (standButton) {
        standButton.disabled = !enabled;
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

// Every way out of a game that leaves nothing to go back to: the host cancelled the
// lobby, the host cleared your seat, or you left it yourself. The token is dead in all
// three, so it goes - otherwise the next 'connect' would try to rejoin a seat that is
// not there and land on the rejoin-failed path instead of a clean start screen.
function returnToStartScreen(message) {
    clearSession();
    hideConnectionLostOverlay();
    closeSettingsMenu();

    currentGameId = null;
    currentGameUrl = "";
    latestGame = null;
    isHost = false;

    document.querySelectorAll(
        '.winner-popup, .round-summary-popup, .info-popup, .disconnect-popup, ' +
        '.settings-confirm-popup, .seat-picker-popup'
    ).forEach(popup => popup.remove());

    document.getElementById('waitingScreen')?.remove();
    clearPlayersBoard();
    toggleActionButtons(false);

    document.getElementById('gameArea').style.display = 'none';
    const controls = document.querySelector('.controls');
    if (controls) controls.style.display = 'none';

    const lobby = document.querySelector('.lobby-screen');
    if (lobby) lobby.style.display = '';

    // Said under the form rather than in an alert(), so the code field they are about to
    // retype is still on screen and still tappable. No focus() with it: on a phone that
    // throws the keyboard up over the message explaining why they are back here.
    if (message) showLobbyError(message); else clearLobbyError();
}

function handleGameCancelled(message) {
    returnToStartScreen(message || 'The host cancelled that game.');
}

function handleRemovedFromGame(message) {
    returnToStartScreen(message || 'The host removed you from that game.');
}

// The server has already busted them and moved the turn on. All this has to do is take
// down a popup that is now aimed at nothing, and tell the table why the turn jumped.
function handleTurnTimeout({ playerId, playerName }) {
    if (playerId === socket.id) {
        document.querySelectorAll(TARGET_POPUPS).forEach(p => p.remove());
        activeFreezePopup = null;
        activeDrawThreePopup = null;
        document.body.style.overflow = 'auto';
        toggleActionButtons(false);
    }

    document.querySelectorAll('.timeout-notice').forEach(n => n.remove());
    const notice = document.createElement('div');
    notice.className = 'restart-notice timeout-notice';
    const who = playerId === socket.id ? 'You' : escapeHtml(playerName || 'A player');
    notice.innerHTML = `
        <strong>⏰ Out of time</strong>
        <span>${who} took too long, so the turn busted automatically.</span>
    `;
    document.body.appendChild(notice);
    setTimeout(() => notice.remove(), 5000);
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
        <div class="lobby-settings" id="lobbySettings"></div>
        <div class="players-list">
            ${gameData.players.map(player => lobbyPlayerRow(player, gameData.hostId)).join('')}
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
        <div class="button-group lobby-exit-group">
            <button id="leaveLobbyBtn" class="game-button red" type="button"></button>
        </div>
    `;
    
    waitingScreen.innerHTML = content;
    document.body.appendChild(waitingScreen);

    updateLobbyExitButton();
    wireLobbyExit(waitingScreen);

    renderLobbySettings(gameData);
    wireLobbySettings();

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

// The host can change while the waiting room is open - if the host's phone drops, the
// server hands the role to somebody else - and the two doors are not the same door. So
// the label is re-derived on every update rather than baked in when the screen is drawn.
function updateLobbyExitButton() {
    const button = document.getElementById('leaveLobbyBtn');
    if (!button) return;
    button.textContent = isHost ? 'Cancel Game' : 'Leave Game';
}

// Delegated on the waiting screen itself, because the players list is re-rendered from
// scratch on every update and a handler bound to a row would go with it.
function wireLobbyExit(waitingScreen) {
    if (!waitingScreen || waitingScreen.dataset.exitWired) return;
    waitingScreen.dataset.exitWired = 'true';

    waitingScreen.addEventListener('click', event => {
        const kick = event.target.closest('.lobby-kick-button');
        if (kick) {
            playSound('buttonClick');
            confirmSettingsAction({
                title: `Remove ${kick.dataset.kickName}?`,
                body: 'They go back to the start screen. They can join again with the code, so this is for clearing a seat, not for locking anybody out.',
                confirmLabel: 'Yes, remove them',
                confirmClass: 'red',
                onConfirm: () => socket.emit('kick-player', currentGameId, kick.dataset.kickId)
            });
            return;
        }

        if (!event.target.closest('#leaveLobbyBtn')) return;
        playSound('buttonClick');

        // A guest is only giving up their own seat, and one tap is the right price for
        // that. The host is closing the table on everybody else, which is not.
        if (!isHost) {
            socket.emit('leave-lobby', currentGameId);
            return;
        }

        confirmSettingsAction({
            title: 'Cancel this game?',
            body: 'The waiting room closes and everybody in it goes back to the start screen. The code stops working.',
            confirmLabel: 'Yes, cancel it',
            confirmClass: 'red',
            onConfirm: () => socket.emit('leave-lobby', currentGameId)
        });
    });
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

// Superlatives, in the order they are worth reading. Each one is won by whoever has the
// highest value for that stat; anything nobody actually did is left out entirely, so a
// quiet game shows a short list rather than a column of zeroes.
const AWARDS = [
    { key: 'bestRound',     icon: '🔥',  title: 'Best Round',    unit: 'points in one round' },
    { key: 'sevens',        icon: '🌟',  title: 'Perfect Sevens', unit: 'full hands' },
    { key: 'busts',         icon: '💥',  title: 'Most Busts',    unit: 'busts' },
    { key: 'powerPlays',    icon: '🥷',  title: 'Most Ruthless', unit: 'cards played at somebody' },
    { key: 'timesTargeted', icon: '🎯',  title: 'Most Picked On', unit: 'times targeted' },
    { key: 'cardsDrawn',    icon: '🎴',  title: 'Most Greedy',   unit: 'cards drawn' },
    { key: 'secondChances', icon: '🛡️', title: 'Most Saves',    unit: 'second chances burned' },
    { key: 'timeouts',      icon: '⏰',  title: 'Most Absent',   unit: 'turns run out of time' }
];

const MAX_AWARDS_SHOWN = 4;

function buildAwards(players) {
    const statOf = player => player.stats || {};

    return AWARDS.map(award => {
        const best = Math.max(0, ...players.map(p => statOf(p)[award.key] || 0));
        if (best === 0) return null;

        const holders = players.filter(p => (statOf(p)[award.key] || 0) === best);
        return { ...award, value: best, holders: holders.map(p => p.name) };
    }).filter(Boolean).slice(0, MAX_AWARDS_SHOWN);
}

function showWinnerPopup(winner, isHost, players = []) {
    // The server sends every player on game-over, so nothing here has to read the board
    // back out of the DOM the way this used to.
    const ranked = [...players].sort((a, b) => b.totalScore - a.totalScore);

    const leaderboardHTML = ranked.map((player, index) => {
        const medal = ['🥇', '🥈', '🥉'][index] || `${index + 1}.`;
        const isCurrentPlayer = player.id === socket.id;
        const winnerClass = player.id === winner.id ? 'winner' : '';

        return `
            <div class="leaderboard-row ${winnerClass} ${isCurrentPlayer ? 'current-player' : ''}">
                <div class="rank">${medal}</div>
                <div class="player-name">${escapeHtml(player.name)} ${isCurrentPlayer ? '(YOU)' : ''}</div>
                <div class="player-score">${player.totalScore}</div>
            </div>
        `;
    }).join('');

    const awards = buildAwards(ranked);
    const awardsHTML = awards.map(award => `
        <div class="award-row">
            <div class="award-icon">${award.icon}</div>
            <div class="award-body">
                <div class="award-title">${award.title}</div>
                <div class="award-holder">${escapeHtml(award.holders.join(' & '))}</div>
            </div>
            <div class="award-value">
                <strong>${award.value}</strong>
                <span>${award.unit}</span>
            </div>
        </div>
    `).join('');

    const popup = document.createElement('div');
    popup.className = 'winner-popup';
    popup.innerHTML = `
        <div class="popup-content">
            <div class="trophy-banner">🏆</div>
            <h2>WINNER!</h2>
            <div class="winner-name">${escapeHtml(winner.name)}</div>
            <div class="winner-score">${winner.totalScore} Points</div>

            <div class="leaderboard">
                <h3>Final Scores</h3>
                <div class="leaderboard-container">
                    ${leaderboardHTML}
                </div>
            </div>

            ${awards.length ? `
            <div class="awards">
                <h3>Highlights</h3>
                <div class="awards-container">
                    ${awardsHTML}
                </div>
            </div>
            ` : ''}

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
    showWinnerPopup(winner, isHost, players);
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

// ---------------------------------------------------------------------------
// Settings menu
//
// Replaces the standalone Reset, Sound and How to Play buttons that used to sit in the
// header. Reset itself is gone: "Return to lobby" does everything it did and lets the
// deck, the target score and the bots be changed on the way past, which nothing could
// do before without abandoning the game and making everybody rejoin.
//
// The two host-only items are the ones that end or unwind the game, and they live below
// a divider so that neither is ever the neighbour of a harmless one. Non-hosts do not
// see them at all rather than seeing them greyed out - there is nothing to explain and
// nothing to poke at.
// ---------------------------------------------------------------------------

function settingsMenuIsOpen() {
    const menu = document.getElementById('settingsMenu');
    return Boolean(menu) && !menu.hidden;
}

// The menu is position: fixed, so it has to be told where to go. See the note on
// .settings-menu in style.css for why it cannot simply hang off the button.
function placeSettingsMenu() {
    const menu = document.getElementById('settingsMenu');
    const button = document.getElementById('settingsButton');
    if (!menu || !button || menu.hidden) return;

    const anchor = button.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const GAP = 8;

    // Right-aligned under the gear, but never off the left edge of a narrow phone.
    const left = Math.max(GAP, Math.min(anchor.right - width, window.innerWidth - width - GAP));

    // Clamped on both edges as well. The anchor is only ever read from a live layout,
    // and a rect measured mid-reflow - rotating a phone, the address bar sliding away -
    // can put the menu above the top of the screen or off the bottom of it, where there
    // is no scrolling to it and no way to tell it is even open.
    const top = Math.max(GAP, Math.min(anchor.bottom + GAP, window.innerHeight - height - GAP));

    menu.style.top = `${Math.round(top)}px`;
    menu.style.left = `${Math.round(left)}px`;
}

function setSettingsMenuOpen(open) {
    const menu = document.getElementById('settingsMenu');
    const button = document.getElementById('settingsButton');
    if (!menu || !button) return;
    menu.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    button.classList.toggle('is-open', open);
    // After unhiding, or offsetWidth is 0 and the menu lands in the wrong place.
    if (open) placeSettingsMenu();
}

function closeSettingsMenu() {
    setSettingsMenuOpen(false);
}

// Called on every game update, because who is host can change mid-game: the original
// host dropping hands the powers to a stand-in, and getting them back moves them again.
function syncSettingsHostItems(game) {
    const group = document.getElementById('settingsHostGroup');
    if (!group) return;
    group.hidden = !game || socket.id !== game.hostId;
}

function wireSettingsMenu() {
    const button = document.getElementById('settingsButton');
    const menu = document.getElementById('settingsMenu');
    if (!button || !menu) return;

    // The menu is written next to its button, which is where it belongs in the source,
    // and then moved to the end of <body>. `position: fixed` is only viewport-relative
    // while no ancestor has a transform, a filter or a backdrop-filter: any one of those
    // makes that ancestor the containing block instead, and a fixed child stops escaping
    // its overflow. `.game-header` grew a backdrop-filter when it was made to look like
    // glass, and from then on the menu was positioned inside a header that is
    // `overflow: hidden` and one button tall - it measured the right size, reported
    // itself open, and painted nothing. Parented to <body> there is no ancestor left to
    // do that to it, whatever the header wears next.
    if (menu.parentElement !== document.body) document.body.appendChild(menu);

    button.onclick = event => {
        event.stopPropagation();
        playSound('buttonClick');
        setSettingsMenuOpen(!settingsMenuIsOpen());
    };

    // A menu that only closes by its own button is a menu people leave open. Clicking
    // the board, or Escape, is what everybody tries first. Both selectors are needed:
    // the menu no longer sits inside the wrap, so the wrap alone would count a click on
    // the menu's own rows as a click outside it and shut it on the way past. Sound is
    // the one row that deliberately stays open to be toggled twice.
    document.addEventListener('click', event => {
        if (!settingsMenuIsOpen()) return;
        if (event.target.closest('.settings-menu-wrap, .settings-menu')) return;
        closeSettingsMenu();
    });

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && settingsMenuIsOpen()) closeSettingsMenu();
    });

    // Rotating a phone with the menu open moves the button out from under it.
    window.addEventListener('resize', placeSettingsMenu);
    window.addEventListener('orientationchange', placeSettingsMenu);

    const sound = document.getElementById('settingsSound');
    if (sound) sound.onclick = () => {
        setSoundEnabled(!soundEnabled);
        // Played after the flip, so unmuting confirms itself audibly.
        if (soundEnabled) playSound('buttonClick');
    };

    const tutorial = document.getElementById('settingsTutorial');
    if (tutorial) tutorial.onclick = () => {
        playSound('buttonClick');
        closeSettingsMenu();
        showTutorial();
    };

    const toLobby = document.getElementById('settingsToLobby');
    if (toLobby) toLobby.onclick = () => {
        playSound('buttonClick');
        closeSettingsMenu();
        confirmSettingsAction({
            title: 'Back to the lobby?',
            body: 'Everyone goes back to the waiting room and the scores are wiped. You can change the deck, the target score and the bots before starting again.',
            confirmLabel: 'Yes, back to lobby',
            confirmClass: 'blue',
            onConfirm: () => socket.emit('return-to-lobby', currentGameId)
        });
    };

    const endGame = document.getElementById('settingsEndGame');
    if (endGame) endGame.onclick = () => {
        playSound('buttonClick');
        closeSettingsMenu();

        const leader = leadingPlayerName();
        confirmSettingsAction({
            title: 'End the game now?',
            body: leader
                ? `The game stops here and ${leader} wins on points. Everyone sees the end screen.`
                : 'The game stops here and whoever is ahead on points wins.',
            confirmLabel: 'Yes, end it',
            confirmClass: 'red',
            onConfirm: () => socket.emit('end-game', currentGameId)
        });
    };
}

// Named in the confirmation so nobody ends a game without seeing who it hands it to.
// Undecided when nothing has been scored yet, which is exactly when it is worth saying
// nothing rather than naming whoever happens to be sitting first.
function leadingPlayerName() {
    const players = latestGame && latestGame.players;
    if (!players || !players.length) return null;

    const best = players.reduce((a, b) => (b.totalScore > a.totalScore ? b : a), players[0]);
    const tied = players.filter(p => p.totalScore === best.totalScore);
    return tied.length === 1 ? best.name : null;
}

// Both of these throw away a game in progress, so neither happens on one tap.
function confirmSettingsAction({ title, body, confirmLabel, confirmClass, onConfirm }) {
    document.querySelectorAll('.settings-confirm-popup').forEach(p => p.remove());

    const popup = document.createElement('div');
    popup.className = 'settings-confirm-popup';
    popup.innerHTML = `
        <div class="popup-content">
            <h2>${escapeHtml(title)}</h2>
            <p>${escapeHtml(body)}</p>
            <div class="button-group">
                <button class="game-button ${confirmClass}" type="button" data-role="confirm">
                    ${escapeHtml(confirmLabel)}
                </button>
                <button class="game-button" type="button" data-role="cancel">Cancel</button>
            </div>
        </div>
    `;

    popup.querySelector('[data-role="confirm"]').addEventListener('click', () => {
        popup.remove();
        onConfirm();
    });
    popup.querySelector('[data-role="cancel"]').addEventListener('click', () => popup.remove());

    document.body.appendChild(popup);
}

// The host has taken everyone back to the waiting room. The board is torn down rather
// than left underneath, because showWaitingScreen draws over the top of it and a stale
// board would still be sitting there when the next game starts.
function handleReturnedToLobby(game) {
    document.querySelectorAll(
        '.winner-popup, .round-summary-popup, .info-popup, .disconnect-popup, .settings-confirm-popup'
    ).forEach(popup => popup.remove());

    closeSettingsMenu();
    clearPlayersBoard();
    toggleActionButtons(false);

    document.getElementById('gameArea').style.display = 'none';
    const controls = document.querySelector('.controls');
    if (controls) controls.style.display = 'none';

    // showWaitingScreen appends a fresh element every time it is called and dedupes
    // nothing, so a stale one has to go before handleGameUpdate puts the new one up.
    document.getElementById('waitingScreen')?.remove();

    // Draws the waiting room itself, because that is what it already does for a game
    // whose status is 'lobby' with no screen on the page.
    handleGameUpdate(game);
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

// ---------------------------------------------------------------------------
// How to play
//
// A walkthrough of pages rather than one long scroll. Each page carries a single
// idea, a hero built out of real game cards, and nothing else. Chapters across
// the top let a player who came back for one rule jump straight to it; Back and
// Next walk the pages either way, and the strip can be dragged directly.
//
// Motion follows the pointer. The strip tracks the finger 1:1 while dragging,
// and on release a spring takes over from wherever the finger left it, aimed at
// the page the throw was heading for rather than the nearest one.
// ---------------------------------------------------------------------------

// Hero art. Each entry is [data-card-type, face] - the colour comes from the
// [data-card-type] rules in style.css, exactly as it does for a card in hand.
function htpArt(cards, small) {
    return cards
        .map(([type, face]) =>
            `<div class="htp-c${small ? ' sm' : ''}" data-card-type="${type}">${face}</div>`)
        .join('');
}

const HTP_CHAPTERS = [
    {
        name: 'Basics',
        pages: [
            {
                art: [['number', '7'], ['adder', '2+'], ['multiplier', '2x']],
                pill: 'The goal',
                title: 'First to 200 wins',
                body: `Every round you bank points. Rounds keep coming until somebody
                       reaches <b>200</b> — that player wins the game.`
            },
            {
                art: [['number', '3'], ['number', '9'], ['number', '12']],
                pill: 'Your turn',
                title: 'Hit, or stand',
                body: `<b>HIT</b> flips the top card straight into your hand and it takes
                       effect at once. <b>STAND</b> ends your round and keeps everything
                       you are holding. Then the turn moves on.`
            },
            {
                art: [['number', '0'], ['number', '1'], ['number', '12']],
                pill: 'Number cards',
                title: 'Seven is the ceiling',
                body: `Numbers run <b>0–12</b> and are worth their face value. You may hold
                       seven of them at most. Fill all seven and your round stops there
                       with a <b>+15 bonus</b>.`,
                note: `The deck holds one 0, one 1, two 2s, and so on up to twelve 12s —
                       79 number cards in all.`
            },
            {
                art: [['number', '5'], ['number', '5']],
                pill: 'The risk',
                title: 'Doubles wipe the round',
                body: `Take a number you already hold and you <b>BUST</b>. The whole round
                       score is gone and you sit out until the next one. Points banked in
                       earlier rounds stay safe.`,
                note: `0 is a number like any other, and stealing or swapping can hand you
                       a duplicate just as easily as a flip can.`
            },
            {
                art: [['second-chance', '🛡️']],
                pill: 'The save',
                title: 'Second chance',
                body: `Holding a <b>🛡️</b> when you would bust? It burns instead, the
                       duplicate is binned, and you carry on. Three of them are in the
                       deck.`
            }
        ]
    },
    {
        name: 'Cards',
        pages: [
            {
                art: [['freeze', '❄️'], ['draw-three', '🎯']],
                pill: 'Action cards',
                title: 'Cards that hit back',
                body: `<b>❄️ Freeze</b> forces any player still in the round to stand,
                       keeping the points they have. <b>🎯 Draw Three</b> makes a player
                       flip three cards in a row — busts and all.`,
                note: 'Three of each are in the deck. You may aim either one at yourself.'
            },
            {
                art: [['remove-card', '🗑️'], ['steal-card', '🥷'], ['swap-card', '⇄️']],
                pill: 'Action cards',
                title: 'Take, bin and trade',
                body: `<b>🗑️ Remove</b> deletes one card from anyone still in the round.
                       <b>🥷 Steal</b> takes a card from a rival into your hand.
                       <b>⇄️ Swap</b> trades one card between two other players.`,
                note: `Three 🗑️, two 🥷 and two ⇄️. A 🗑️ can never be removed, and only
                       scoring cards can be swapped.`
            },
            {
                art: [['select-card', '🃏']],
                pill: 'Action cards',
                title: 'Pick anything you like',
                body: `<b>🃏 Select Card</b> opens the whole deck and lets you take whatever
                       you want. There is exactly one in the game.`,
                note: 'An action card with no legal target is binned and your turn ends.'
            }
        ]
    },
    {
        name: 'Scoring',
        pages: [
            {
                art: [['adder', '2+'], ['multiplier', '2x'], ['minus', '4-'], ['divide', '2÷']],
                pill: 'Modifiers',
                title: 'Bend your score',
                body: `These stay in your hand and change what the round is worth.
                       <b>2+ … 10+</b> add, <b>2- … 10-</b> subtract, <b>2x</b> doubles and
                       <b>2÷</b> halves. None of them can bust you.`
            },
            {
                art: [['number', '3'], ['number', '5'], ['number', '7']],
                pill: 'The maths',
                title: 'Always in this order',
                body: `Add your numbers, apply every <b>+</b> and <b>−</b>, then <b>2x</b>,
                       then <b>2÷</b>, and finally <b>+15</b> if you hold all seven.`,
                note: `Example: 3 + 5 + 7 = 15, then 2+ makes 17, then 2x makes
                       <b>34 points</b>. A round can never score below 0.`
            },
            {
                art: [['freeze', '❄️'], ['number', '7']],
                pill: 'Round end',
                title: 'When nobody is left',
                body: `The round ends once everyone has stood, been frozen, filled seven
                       cards or busted. Everyone still standing banks their score, hands
                       are cleared, and the next round starts.`,
                note: `The deck carries over and is reshuffled only when it runs dry. CARDS
                       LEFT shows exactly what is still in it.`
            }
        ]
    },
    {
        name: 'Tips',
        pages: [
            {
                art: [['number', '1'], ['number', '12']],
                pill: 'Tips',
                title: 'How to win more',
                body: `<ul class="htp-list">
                         <li>Low numbers are the safe ones — one 1, but twelve 12s</li>
                         <li>Read CARDS LEFT before you hit; it is the real odds</li>
                         <li>Spend 🛡️ pushing for the +15, not sitting on 10 points</li>
                         <li>Aim ❄️ at whoever is closest to 200</li>
                         <li>2÷ hurts most on a big hand — pass it on with ⇄️</li>
                         <li>📜 History shows every card played so far</li>
                       </ul>`
            }
        ]
    }
];

// Flattened once, so a page index is all the rest of the code has to carry.
const HTP_PAGES = HTP_CHAPTERS.flatMap((chapter, ci) =>
    chapter.pages.map(page => ({ ...page, chapter: ci })));

function showTutorial() {
    const existing = document.querySelector('.htp');
    if (existing) existing.remove();

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const popup = document.createElement('div');
    popup.className = 'htp';
    popup.innerHTML = `
        <div class="htp-card" role="dialog" aria-modal="true" aria-label="How to play">
            <div class="htp-bar">
                <button class="htp-back" type="button" aria-label="Previous page">‹</button>
                <div class="htp-chapters" role="tablist">
                    ${HTP_CHAPTERS.map((c, i) => `
                        <button class="htp-chapter" type="button" role="tab" data-chapter="${i}">
                            ${escapeHtml(c.name)}
                        </button>`).join('')}
                </div>
                <button class="htp-close" type="button" aria-label="Close">×</button>
            </div>

            <div class="htp-hero" aria-hidden="true"></div>

            <div class="htp-track">
                <div class="htp-strip">
                    ${HTP_PAGES.map(p => `
                        <section class="htp-page">
                            <div class="htp-page-inner">
                                <span class="htp-pill">${escapeHtml(p.pill)}</span>
                                <h3 class="htp-title">${escapeHtml(p.title)}</h3>
                                <div class="htp-body">${p.body}</div>
                                ${p.note ? `<p class="htp-note">${p.note}</p>` : ''}
                            </div>
                        </section>`).join('')}
                </div>
            </div>

            <div class="htp-foot">
                <div class="htp-dots"></div>
                <button class="htp-next" type="button"></button>
            </div>

            <p class="htp-build">Build ${escapeHtml(BUILD)}</p>
        </div>
    `;

    const hero = popup.querySelector('.htp-hero');
    const track = popup.querySelector('.htp-track');
    const strip = popup.querySelector('.htp-strip');
    const dotsEl = popup.querySelector('.htp-dots');
    const backBtn = popup.querySelector('.htp-back');
    const nextBtn = popup.querySelector('.htp-next');
    const chapterBtns = [...popup.querySelectorAll('.htp-chapter')];

    let index = -1;
    let x = 0;              // live strip offset, px
    let vx = 0;             // strip velocity, px/s
    let goal = 0;           // where the spring is pulling to
    let frame = null;
    let dragging = false;
    let grabX = 0;
    let grabOffset = 0;
    let lastX = 0;
    let lastT = 0;
    let heroTimer = null;

    const pageWidth = () => track.clientWidth || 1;
    const minOffset = () => -(HTP_PAGES.length - 1) * pageWidth();

    function setStrip(px) {
        x = px;
        strip.style.transform = `translate3d(${px}px, 0, 0)`;
    }

    // Critically damped: the pages settle without wobbling. Bounce is reserved
    // for the flick, where the momentum came from the hand rather than the UI.
    function runSpring() {
        cancelAnimationFrame(frame);
        if (reduced) { setStrip(goal); vx = 0; return; }

        let last = performance.now();
        const step = now => {
            // A backgrounded tab hands back a huge dt, which would fling the
            // strip across the screen on return.
            const dt = Math.min((now - last) / 1000, 0.032);
            last = now;
            vx += ((goal - x) * 170 - vx * 26) * dt;
            setStrip(x + vx * dt);

            if (Math.abs(goal - x) > 0.4 || Math.abs(vx) > 0.4) {
                frame = requestAnimationFrame(step);
            } else {
                setStrip(goal);
                vx = 0;
            }
        };
        frame = requestAnimationFrame(step);
    }

    function paintHero(page) {
        clearTimeout(heroTimer);
        hero.classList.add('is-swapping');
        const draw = () => {
            hero.innerHTML = htpArt(page.art, page.art.length > 3);
            hero.classList.remove('is-swapping');
            if (reduced) return;
            [...hero.children].forEach((card, n) => {
                card.style.animationDelay = `${n * 60}ms`;
                card.classList.add('htp-deal');
            });
        };
        if (reduced) draw(); else heroTimer = setTimeout(draw, 120);
    }

    function paintDots(chapterIndex, pageInChapter) {
        // A chapter of one page has nowhere to go, and a lone dot reads as a
        // progress bar that is broken rather than finished.
        const count = HTP_CHAPTERS[chapterIndex].pages.length;
        if (count < 2) { dotsEl.innerHTML = ''; return; }
        if (dotsEl.children.length !== count) {
            dotsEl.innerHTML = Array.from({ length: count }, () => '<i class="htp-dot"></i>').join('');
        }
        [...dotsEl.children].forEach((dot, n) => dot.classList.toggle('is-on', n === pageInChapter));
    }

    function go(next, silent) {
        const n = Math.max(0, Math.min(HTP_PAGES.length - 1, next));
        // A chapter jump is a switch, not a scroll: sliding eight pages past the
        // eye says the chapters sit in a row, which is not what the row means.
        const jump = index >= 0 && Math.abs(n - index) > 1;

        if (n !== index) {
            index = n;
            const page = HTP_PAGES[n];
            const chapterStart = HTP_PAGES.findIndex(p => p.chapter === page.chapter);

            paintHero(page);
            paintDots(page.chapter, n - chapterStart);
            chapterBtns.forEach((b, ci) => {
                b.classList.toggle('is-on', ci === page.chapter);
                b.setAttribute('aria-selected', ci === page.chapter ? 'true' : 'false');
            });

            // The chapter row scrolls on a narrow phone. Centre the live chip by
            // hand rather than with scrollIntoView, which is free to scroll the
            // sheet and the page behind it as well.
            const chip = chapterBtns[page.chapter];
            const row = chip.parentElement;
            row.scrollTo({
                left: chip.offsetLeft - (row.clientWidth - chip.offsetWidth) / 2,
                behavior: reduced ? 'auto' : 'smooth'
            });

            backBtn.disabled = n === 0;
            nextBtn.textContent = n === HTP_PAGES.length - 1 ? 'Got it' : 'Next  ›';
            if (!silent) playSound('buttonClick');
        }

        goal = -index * pageWidth();
        if (jump) { cancelAnimationFrame(frame); vx = 0; setStrip(goal); }
        else runSpring();
    }

    nextBtn.addEventListener('click', () => {
        if (index === HTP_PAGES.length - 1) close();
        else go(index + 1);
    });
    backBtn.addEventListener('click', () => go(index - 1));
    chapterBtns.forEach(btn => btn.addEventListener('click', () => {
        go(HTP_PAGES.findIndex(p => p.chapter === Number(btn.dataset.chapter)));
    }));

    // Drag. The strip is glued to the finger, softening past either end so the
    // boundary reads as "nothing more here" rather than "frozen".
    track.addEventListener('pointerdown', e => {
        if (e.target.closest('button, a')) return;
        dragging = true;
        track.setPointerCapture(e.pointerId);
        grabX = e.clientX;
        grabOffset = x;
        lastX = e.clientX;
        lastT = performance.now();
        cancelAnimationFrame(frame);
    });

    track.addEventListener('pointermove', e => {
        if (!dragging) return;
        let next = grabOffset + (e.clientX - grabX);
        const min = minOffset();
        if (next > 0) next *= 0.35;
        else if (next < min) next = min + (next - min) * 0.35;
        setStrip(next);

        const now = performance.now();
        if (now > lastT) {
            vx = (e.clientX - lastX) / ((now - lastT) / 1000);
            lastX = e.clientX;
            lastT = now;
        }
    });

    // Land on the page the throw was heading for, not the nearest one - the same
    // exponential projection scroll deceleration uses. Clamped to one page
    // either side, because a hard flick should turn the page, not the chapter.
    const release = () => {
        if (!dragging) return;
        dragging = false;
        const projected = x + (vx / 1000) * 0.998 / (1 - 0.998);
        const aimed = Math.round(-projected / pageWidth());
        go(Math.max(index - 1, Math.min(index + 1, aimed)), true);
    };
    track.addEventListener('pointerup', release);
    track.addEventListener('pointercancel', release);

    const onResize = () => { goal = -index * pageWidth(); setStrip(goal); };
    window.addEventListener('resize', onResize);

    const onKey = e => {
        if (e.key === 'Escape') close();
        else if (e.key === 'ArrowRight') go(index + 1);
        else if (e.key === 'ArrowLeft') go(index - 1);
    };
    document.addEventListener('keydown', onKey);

    function close() {
        playSound('buttonClick');
        cancelAnimationFrame(frame);
        clearTimeout(heroTimer);
        document.removeEventListener('keydown', onKey);
        window.removeEventListener('resize', onResize);
        dismissPopup(popup);
    }

    popup.querySelector('.htp-close').addEventListener('click', close);
    popup.addEventListener('click', e => { if (e.target === popup) close(); });

    document.body.appendChild(popup);
    go(0, true);
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

// The speaker used to be its own header button, where its icon said whether the game was
// muted. It lives inside the settings menu now, so with the menu shut the gear carries a
// dot instead - otherwise a muted game looks exactly like a working one.
function syncSoundButton() {
    const item = document.getElementById('settingsSound');
    if (item) {
        const label = soundEnabled ? 'Sound on' : 'Sound off';
        item.setAttribute('aria-checked', String(soundEnabled));
        item.title = soundEnabled ? 'Mute sound' : 'Unmute sound';
        item.setAttribute('aria-label', label);

        const icon = document.getElementById('settingsSoundIcon');
        if (icon) icon.textContent = soundEnabled ? '🔊' : '🔇';

        const state = document.getElementById('settingsSoundState');
        if (state) {
            state.textContent = soundEnabled ? 'On' : 'Off';
            state.classList.toggle('is-off', !soundEnabled);
        }
    }

    const button = document.getElementById('settingsButton');
    if (button) button.classList.toggle('is-muted', !soundEnabled);
}

function initSound() {
    try {
        soundEnabled = localStorage.getItem('hit7-sound') !== 'off';
    } catch (e) {
        soundEnabled = true;
    }

    // The toggle itself is wired in wireSettingsMenu, with the rest of the menu.
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