const socket = io();
let currentGameId = null;
let isHost = false;
const MAX_REGULAR_CARDS = 7;
let activeFreezePopup = null;
let activeDrawThreePopup = null;
let soundEnabled = true;
let currentGameUrl = ""; // New: stores the game URL

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
        playSound('buttonClick');
        console.log('Join Game clicked');
        joinGame();
    };
    
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
        playSound('cardFlip');
        flipCard();
    };
    if (standBtn) standBtn.onclick = function() {
        playSound('buttonClick');
        stand();
    };
    if (resetBtn) resetBtn.onclick = function() {
        if (confirm('Reset game and start a new round with all players?')) {
            resetGame();
        }
    };
    
    const headerTutorialBtn = document.getElementById('headerTutorialBtn');
    if (headerTutorialBtn) headerTutorialBtn.onclick = function() {
        playSound('buttonClick');
        showTutorial();
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
socket.on('select-freeze-target', showFreezePopup);
socket.on('cancel-freeze', () => {
  if (activeFreezePopup) {
    activeFreezePopup.remove();
    activeFreezePopup = null;
  }
});

socket.on('game-update', () => {
  if (activeFreezePopup) {
    activeFreezePopup.remove();
    activeFreezePopup = null;
  }
});

socket.on('select-freeze-target', (gameId, targets) => {
  // Remove any existing popups
  document.querySelectorAll('.freeze-popup').forEach(p => p.remove());
  
  const popup = document.createElement('div');
  popup.className = 'freeze-popup active';
  popup.innerHTML = `
    <div class="popup-content">
      <h3>❄️ Select player to freeze:</h3>
      <div class="freeze-targets">
        ${targets.map(p => `
          <button class="freeze-target" data-id="${p.id}">
            ${p.name} ${p.id === socket.id ? '(You)' : ''}
          </button>
        `).join('')}
      </div>
    </div>
  `;

  popup.querySelectorAll('.freeze-target').forEach(btn => {
    btn.addEventListener('click', () => {
      socket.emit('freeze-player', currentGameId, btn.dataset.id);
      popup.remove();
    });
  });

  document.body.appendChild(popup);
});

socket.on('select-draw-three-target', (gameId, targets) => {
  if (activeDrawThreePopup) {
    activeDrawThreePopup.remove();
    activeDrawThreePopup = null;
  }

  const popup = document.createElement('div');
  popup.className = 'draw-three-popup active';
  popup.innerHTML = `
    <div class="popup-content">
      <h3>🎯 Select player to draw three cards:</h3>
      <div class="draw-three-targets">
        ${targets.map(p => `
          <button class="draw-three-target ${p.id === socket.id ? 'self-target' : ''}" data-id="${p.id}">
            ${p.name} ${p.id === socket.id ? '(You)' : ''}
          </button>
        `).join('')}
      </div>
    </div>
  `;

  popup.querySelectorAll('.draw-three-target').forEach(btn => {
    btn.addEventListener('click', () => {
      socket.emit('draw-three-select', currentGameId, btn.dataset.id);
      popup.remove();
      activeDrawThreePopup = null;
    });
  });

  document.body.appendChild(popup);
  activeDrawThreePopup = popup;
});

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
        <h2>🔄 Game Reset!</h2>
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
  showSelectCardPopup(gameId, deck, fullDeck);
});

// Game actions
function createGame() {
    playSound('buttonClick');
    console.log('createGame function called'); // Debug log
    const name = prompt('Enter your name:')?.trim();
    if (!name) {
        return alert('Please enter a name!');
    }
    if (name.length < 3) {
        return alert('Name must be at least 3 characters!');
    }
    
    // Clear any existing game state
    currentGameId = null;
    document.getElementById('playersContainer').innerHTML = '';
    
    console.log('Emitting create-game event with name:', name); // Debug log
    socket.emit('create-game', name);
}

function joinGame() {
    playSound('buttonClick');
    const gameIdInput = document.getElementById('gameId');
    const code = gameIdInput.value.trim().toUpperCase();
    
    if (!/^[A-Z0-9]{5}$/.test(code)) {
        alert('Game code must be 5 characters!');
        gameIdInput.focus();
        return;
    }
    
    const name = prompt('Enter your name:')?.trim();
    if (!name) return alert('Please enter a name!');
    
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
function handleGameCreated({ gameId, gameUrl }) {
    console.log('Game created with URL:', gameUrl);
    currentGameId = gameId;
    currentGameUrl = gameUrl; // Store URL for later copying
    isHost = true;
    
    // Hide lobby screen
    document.querySelector('.lobby-screen').style.display = 'none';
    
    // Show waiting screen instead of game area
    showWaitingScreen({
        players: [{ name: 'You (Host)', id: socket.id }],
        hostId: socket.id
    });
}

function copyShareLink() {
    if (!currentGameUrl) return;
    navigator.clipboard.writeText(currentGameUrl).then(() => {
        const btn = document.querySelector('.copy-link-btn');
        const originalText = btn.textContent;
        btn.textContent = 'Link Copied!';
        setTimeout(() => btn.textContent = originalText, 2000);
    }).catch(err => {
        console.error('Copy failed:', err);
    });
}

// Remove bust sound from handleGameUpdate since server will handle it
function handleGameUpdate(game) {
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
    
    if (game.status === 'lobby') {
        // Update waiting screen if it exists
        if (waitingScreen) {
            const playersList = waitingScreen.querySelector('.players-list');
            if (playersList) {
                playersList.innerHTML = game.players.map(player => `
                    <div class="player-item">
                        ${player.name}
                        ${player.id === game.hostId ? 
                            '<span class="host-badge">HOST</span>' : ''}
                    </div>
                `).join('');
            }
            // Always update the start button when we get a game update in lobby
            if (isHost) {
                updateStartButton(game.players.length);
            }
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
        const canAct = isCurrentPlayer && game.status === 'playing';
        
        updateGameDisplay(game);
        toggleActionButtons(canAct);
        
        document.getElementById('gameArea').style.display = 'flex';
        document.querySelector('.controls').style.display = 'flex';
    }
}

// Display updates
function updateGameDisplay(game) {
    document.getElementById('deckCount').textContent = game.deck.length;
    updateRemainingPile(game.deck);
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
            '2x': 6,        // 6. 2x Multiplier
            '3x': 7,        // 7. 3x Multiplier (new)
            '2+': 8,        // 8. 2+
            '6+': 9,        // 9. 6+
            '10+': 10,      // 10. 10+
            '2-': 11,       // 11. 2-
            '6-': 12,       // 12. 6-
            '10-': 13,      // 13. 10-
        };
        return specialOrder[card] || 99;  // Default high number for unknown cards
    };

    Object.entries(cardCounts).forEach(([cardStr, count]) => {
        let cardType, displayValue;
        
        if (cardStr === 'SC' || cardStr === 'Freeze' || cardStr === 'D3' || 
            cardStr === 'RC' || cardStr === 'Select' ||  // Add Select to the check
            cardStr.includes('+') || cardStr.includes('x') || cardStr.includes('-')) {
            cardType = 
                cardStr === 'SC' ? 'second-chance' :
                cardStr === 'Freeze' ? 'freeze' :
                cardStr === 'D3' ? 'draw-three' :
                cardStr === 'RC' ? 'remove-card' :
                cardStr === 'Select' ? 'select-card' :  // Add select-card type
                cardStr.includes('+') ? 'adder' :
                cardStr.includes('-') ? 'minus' :
                'multiplier';
            displayValue = 
                cardStr === 'SC' ? '🛡️' :
                cardStr === 'Freeze' ? '❄️' :
                cardStr === 'D3' ? '🎯' :
                cardStr === 'RC' ? '🗑️' :
                cardStr === 'Select' ? '🃏' :  // Add joker emoji
                cardStr;
            specialCards.push({ cardStr, count, cardType, displayValue });
        } else {
            cardType = 'number';
            displayValue = cardStr;
            regularCards.push({ cardStr, count, cardType, displayValue });
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
                    cardType === 'adder' ? '#27ae60' : 
                    cardType === 'minus' ? '#2c3e50' :
                    cardType === 'multiplier' ? '#f1c40f' :
                    cardType === 'second-chance' ? '#e74c3c' :
                    cardType === 'freeze' ? '#3498db' :
                    cardType === 'draw-three' ? '#9b59b6' :
                    cardType === 'remove-card' ? '#7f8c8d' : 'inherit'
                } !important;
                color: ${cardType === 'minus' ? '#fff' : 'inherit'} !important;
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
      } else if (cardStr.includes('+')) {
        cardType = 'adder';
        displayValue = cardStr;
      } else if (cardStr.includes('x')) {
        cardType = 'multiplier';
        displayValue = cardStr.replace('x', '×');
      } else {
        cardType = 'number';
        displayValue = cardStr;
      }

      const cardStyle = cardType !== 'number' ? `
        background: ${
          cardType === 'adder' ? '#27ae60' : 
          cardType === 'multiplier' ? '#f1c40f' :
          cardType === 'second-chance' ? '#e74c3c' :
          cardType === 'freeze' ? '#3498db' :
          cardType === 'draw-three' ? '#9b59b6' : 'inherit'
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
          'adder': 4,
          'multiplier': 5,
          'number': 6
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

    return `
        <div class="player ${isCurrentTurn ? 'current-turn' : ''} ${player.status}" data-player-id="${player.id}">
            <div class="player-header">
                <h3>${player.name.toUpperCase()} ${player.id === socket.id ? '<span class="you">(YOU)</span>' : ''}</h3>
                <div class="player-status">
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
                        ${player.specialCards.map(card => `
                            <div class="card special ${getSpecialCardClass(card)}">
                                ${getSpecialCardDisplay(card)}
                            </div>
                        `).join('')}
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

// Update special card class function to include "Select" card
function getSpecialCardClass(card) {
    if (card === 'SC') return 'second-chance';
    if (card === 'Freeze') return 'freeze';
    if (card === 'D3') return 'draw-three';
    if (card === 'RC') return 'remove-card';
    if (card === 'Select') return 'select-card';
    if (card.endsWith('+')) return 'adder';
    if (card.endsWith('x')) return 'multiplier';
    if (card.endsWith('-')) return 'minus';
    return '';
}

// Update special card display function to include "Select" card
function getSpecialCardDisplay(card) {
    // Special cards with emojis
    if (card === 'SC') return '🛡️';
    if (card === 'Freeze') return '❄️';
    if (card === 'D3') return '🎯';
    if (card === 'RC') return '🗑️';
    if (card === 'Select') return '🃏';
    
    // For adder and multiplier cards, extract the number and symbol
    if (card.endsWith('+') || card.endsWith('x') || card.endsWith('-')) {
        const number = card.slice(0, -1);  // Get everything except last character
        const symbol = card.slice(-1);     // Get last character (+ or x or -)
        return `${number}${symbol}`;       // Combine them (e.g., "2+")
    }
    
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
    
    // Get current player object from container
    const game = getCurrentGameState();
    const currentPlayer = game?.players.find(p => p.id === socket.id);
    
    // Show buttons only if:
    // 1. It's the player's turn (active is true)
    // 2. Player exists
    // 3. Game is in playing state
    const showButtons = active && currentPlayer;
    
    if (flipCardBtn) flipCardBtn.style.display = showButtons ? 'block' : 'none';
    if (standButton) standButton.style.display = 
        (showButtons && (!currentPlayer || currentPlayer.drawThreeRemaining === 0)) 
        ? 'block' 
        : 'none';
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
function handleGameJoined(gameId) {
    currentGameId = gameId;
    document.querySelector('.lobby-screen').style.display = 'none';
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
            <button class="game-button copy-link-btn" onclick="copyShareLink()">
                Copy Game Link
            </button>
            <div class="copied-message">Link copied!</div>
        </div>
        ` : ''}
        <div class="players-list">
            ${gameData.players.map(player => `
                <div class="player-item">
                    ${player.name}
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

// Update checkUrlParams to handle both paths and search params
function checkUrlParams() {
    // First check for join in the path
    const pathMatch = window.location.pathname.match(/\/join\/([A-Z0-9]{5})/i);
    if (pathMatch) {
        const gameId = pathMatch[1].toUpperCase();
        const name = prompt('Enter your name to join the game:')?.trim();
        if (name) {
            socket.emit('join-game', gameId, name);
            // Clean up URL after emitting join
            window.history.replaceState({}, document.title, '/');
            return; // Exit early
        }
    }
    
    // Check for error params
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('error') === 'game-not-found') {
        alert('Game not found!');
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
            popup.remove();
        }
        count--;
    }, 1000);
}

function showWinnerPopup(winner, isHost) {
    const popup = document.createElement('div');
    popup.className = 'winner-popup';
    popup.innerHTML = `
        <h2>🏆 TOTAL WINNER! 🏆</h2>
        <div class="winner-name">${winner.name}</div>
        <div class="winner-score">${winner.totalScore} Points</div>
        ${isHost ? `
            <button id="rematchButton" class="game-button green">
                Rematch?
            </button>
        ` : `
            <div class="waiting-message">
                Waiting for host to start rematch...
            </div>
        `}
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
    showWinnerPopup(winner, isHost); // Pass isHost flag
    const container = document.getElementById('playersContainer');
    container.innerHTML = '';
}

function handleGameReset() {
    alert('Game has been reset by the host!');
    window.location.reload();
}

function handleError(message) {
    alert(message);
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
                    ${player.name}
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
            ${t.name} ${t.id === socket.id ? '(You)' : ''}
          </button>
        `).join('')}
      </div>
    </div>
  `;

  activeFreezePopup.querySelectorAll('.freeze-target').forEach(btn => {
    btn.addEventListener('click', () => {
      socket.emit('freeze-player', currentGameId, btn.dataset.id);
      activeFreezePopup.remove();
      activeFreezePopup = null;
    });
  });

  document.body.appendChild(activeFreezePopup);

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
  const popup = document.createElement('div');
  popup.className = 'remove-card-popup';
  
  const content = `
    <div class="popup-content">
      <h3><span class="emoji">🗑️</span> Select a card to remove:</h3>
      <div class="players-list">
        ${players.map(player => `
          <div class="player-section">
            <h4>${player.name} ${player.id === socket.id ? '(You)' : ''}</h4>
            <div class="cards-list">
              ${player.regularCards.map((card, index) => `
                <button class="card-button regular" 
                  data-player="${player.id}" 
                  data-index="${index}"
                  data-special="false">
                  ${card}
                </button>
              `).join('')}
              ${player.specialCards.map((card, index) => `
                <button class="card-button special ${getSpecialCardClass(card)}"
                  style="background: ${getCardColor(card)}; color: ${card.endsWith('-') || card.includes('x') ? (card.includes('x') ? 'var(--text-dark)' : '#fff') : ''}"
                  data-player="${player.id}" 
                  data-index="${index}"
                  data-special="true">
                  ${getSpecialCardDisplay(card)}
                </button>
              `).join('')}
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
  
  popup.innerHTML = content;

  // Add event listeners
  popup.querySelectorAll('.card-button').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.player;
      const cardIndex = parseInt(btn.dataset.index);
      const isSpecial = btn.dataset.special === 'true';
      
      socket.emit('remove-card', gameId, targetId, cardIndex, isSpecial);
      popup.remove();
    });
  });

  document.body.appendChild(popup);
}

// Add helper function to get card background color
function getCardColor(card) {
    if (card === 'SC') return '#e74c3c';
    if (card === 'Freeze') return '#3498db';
    if (card === 'D3') return '#9b59b6';
    if (card === 'RC') return '#7f8c8d'; // Changed to a lighter gray
    if (card === 'Select') return 'linear-gradient(135deg, #e74c3c 0%, #9b59b6 50%, #3498db 100%)';
    if (card.endsWith('+')) return '#27ae60';
    if (card.endsWith('x')) return '#f1c40f';
    if (card.endsWith('-')) return '#2c3e50'; // New dark color for minus cards
    return 'inherit';
}

socket.on('select-remove-card-target', (gameId, players) => {
  showRemoveCardPopup(gameId, players);
});

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
        cardStr === 'RC' || cardStr === 'Select' ||
        cardStr.includes('+') || cardStr.includes('x') || cardStr.includes('-')) {
      specialCards.push({ card: cardStr, count });
    } else {
      regularCards.push({ card: parseInt(cardStr), count });
    }
  });
  
  // Sort regular cards numerically
  regularCards.sort((a, b) => a.card - b.card);
  
  // Create popup
  const popup = document.createElement('div');
  popup.className = 'select-card-popup';
  
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
  
  document.body.appendChild(popup);
}

// New function to handle selected cards
function handleSelectedCard(gameId, selectedCard) {
  // First send the selection to the server
  socket.emit('select-card-choice', gameId, selectedCard);
  
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
  }
  // For other cards, no immediate action needed
}

// Add helper function for card color styling - update gradient
function getCardColorStyle(card) {
  if (card === 'SC') return 'background: #e74c3c !important;';
  if (card === 'Freeze') return 'background: #3498db !important;';
  if (card === 'D3') return 'background: #9b59b6 !important;';
  if (card === 'RC') return 'background: #7f8c8d !important;';
  if (card === 'Select') return 'background: linear-gradient(135deg, #e74c3c 0%, #9b59b6 50%, #3498db 100%) !important;';
  if (card.endsWith('+')) return 'background: #27ae60 !important;';
  if (card.endsWith('x')) return 'background: #f1c40f !important; color: var(--text-dark) !important;';
  if (card.endsWith('-')) return 'background: #2c3e50 !important; color: white !important;';
  return '';
}

function showTutorial() {
    const existingPopup = document.querySelector('.tutorial-popup');
    if (existingPopup) existingPopup.remove();

    const popup = document.createElement('div');
    popup.className = 'tutorial-popup';
    popup.innerHTML = `
        <button class="close-button">×</button>
        <div class="tutorial-content">
            <div class="tutorial-tabs">
                <button class="tab-button active" data-tab="basics">Basics</button>
                <button class="tab-button" data-tab="cards">Cards</button>
                <button class="tab-button" data-tab="special">Special Cards</button>
                <button class="tab-button" data-tab="scoring">Scoring</button>
            </div>

            <div class="tab-content active" id="basics-tab">
                <div class="tutorial-section">
                    <h2>Game Basics</h2>
                    <ul class="rules-list">
                        <li>Players take turns drawing cards to collect points</li>
                        <li>Each player can hold up to 7 regular number cards</li>
                        <li>Drawing a duplicate number will bust you (unless you have a Second Chance)</li>
                        <li>You can 'Stand' to bank your points at any time</li>
                        <li>First player to reach 200 points wins!</li>
                        <li>If all players bust, the round restarts</li>
                        <li>Special cards don't count toward your 7-card limit</li>
                    </ul>
                </div>
            </div>

            <div class="tab-content" id="cards-tab">
                <div class="tutorial-section">
                    <h2>Regular Cards</h2>
                    <div class="cards-grid">
                        <div class="card-example">
                            <div class="card">0</div>
                            <div class="card-explanation">
                                Zero Card: Appears once, worth 0 points
                            </div>
                        </div>
                        <div class="card-example">
                            <div class="card">7</div>
                            <div class="card-explanation">
                                Number Cards: Each number (1-12) appears as many times as its value
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div class="tab-content" id="special-tab">
                <div class="tutorial-section">
                    <h2>Special Cards</h2>
                    <div class="cards-grid">
                        <div class="card-example">
                            <div class="card special second-chance">🛡️</div>
                            <div class="card-explanation">
                                <strong>Second Chance</strong><br>
                                Protects you once from busting when drawing a duplicate
                            </div>
                        </div>
                        <div class="card-example">
                            <div class="card special freeze">❄️</div>
                            <div class="card-explanation">
                                <strong>Freeze</strong><br>
                                Forces any player to skip their next turn
                            </div>
                        </div>
                        <div class="card-example">
                            <div class="card special draw-three">🎯</div>
                            <div class="card-explanation">
                                <strong>Draw Three</strong><br>
                                Forces any player to draw 3 cards in a row
                            </div>
                        </div>
                        <div class="card-example">
                            <div class="card special remove-card">🗑️</div>
                            <div class="card-explanation">
                                <strong>Remove Card</strong><br>
                                Remove any card from any player's collection
                            </div>
                        </div>
                        <div class="card-example">
                            <div class="card special adder">4+</div>
                            <div class="card-explanation">
                                <strong>Add Cards</strong><br>
                                Adds points to your score (2+, 4+, 6+, 8+, 10+)
                            </div>
                        </div>
                        <div class="card-example">
                            <div class="card special minus" style="color: white">6-</div>
                            <div class="card-explanation">
                                <strong>Minus Cards</strong><br>
                                Subtracts points from your score (2-, 6-, 10-)
                            </div>
                        </div>
                        <div class="card-example">
                            <div class="card special multiplier">2×</div>
                            <div class="card-explanation">
                                <strong>Multiply Cards</strong><br>
                                Multiply your total round score (2× or 3×)
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div class="tab-content" id="scoring-tab">
                <div class="tutorial-section">
                    <h2>Scoring System</h2>
                    <ul class="rules-list">
                        <li>Your score is the sum of all unique regular cards</li>
                        <li>Add Cards (+) increase your score by their value</li>
                        <li>Minus Cards (-) decrease your score by their value</li>
                        <li>Multiply Cards (×) double your total round score</li>
                        <li>BONUS: Get 15 extra points for collecting all 7 regular cards!</li>
                        <li>Example: With cards [3,5,7] + 4+ - 2- × 2 = (15 + 4 - 2) × 2 = 34 points</li>
                    </ul>
                </div>
            </div>
        </div>
    `;

    // Add event listeners for tabs
    popup.querySelectorAll('.tab-button').forEach(button => {
        button.addEventListener('click', () => {
            popup.querySelectorAll('.tab-button').forEach(b => b.classList.remove('active'));
            popup.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            
            button.classList.add('active');
            popup.querySelector(`#${button.dataset.tab}-tab`).classList.add('active');
        });
    });

    // Close button functionality
    popup.querySelector('.close-button').addEventListener('click', () => {
        popup.remove();
    });

    // Close on clicking outside
    popup.addEventListener('click', (e) => {
        if (e.target === popup) {
            popup.remove();
        }
    });

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
            ${p.name} ${p.id === socket.id ? '(You)' : ''}
          </button>
        `).join('')}
      </div>
    </div>
  `;

  popup.querySelectorAll('.draw-three-target').forEach(btn => {
    btn.addEventListener('click', () => {
      socket.emit('draw-three-select', currentGameId, btn.dataset.id);
      popup.remove();
    });
  });

  document.body.appendChild(popup);
  activeDrawThreePopup = popup;
});