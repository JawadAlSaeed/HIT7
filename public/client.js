const socket = io();
let currentGameId = null;
let isHost = false;
const MAX_REGULAR_CARDS = 7;
let activeFreezePopup = null;
let activeDrawThreePopup = null;
let soundEnabled = true;

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

    // Game Control Buttons
    const startGameBtn = document.getElementById('startGame');
    const flipCardBtn = document.getElementById('flipCard');
    const standBtn = document.getElementById('standButton');
    const resetBtn = document.getElementById('resetButton');

    if (startGameBtn) startGameBtn.onclick = function() {
        playSound('buttonClick');
        startGame();
    };
    if (flipCardBtn) flipCardBtn.onclick = function() {
        playSound('cardFlip');
        flipCard();
    };
    if (standBtn) standBtn.onclick = function() {
        playSound('buttonClick');
        stand();
    };
    if (resetBtn) resetBtn.onclick = function() {
        if (confirm('Reset game for all players?')) {
            playSound('buttonClick');
            resetGame();
        }
    };
    
    console.log('Button initialization complete');
};

// Initialize only once when the DOM is ready
document.addEventListener('DOMContentLoaded', initializeButtons);

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
          <button class="draw-three-target" data-id="${p.id}">
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

function flipCard() { 
    playSound('cardFlip');
    socket.emit('flip-card', currentGameId); 
}

function stand() { 
    playSound('buttonClick');
    socket.emit('stand', currentGameId); 
}

function resetGame() {
    if (confirm('Reset game for all players?')) {
        playSound('buttonClick');
        socket.emit('reset-game', currentGameId);
    }
}

// Game state handlers
function handleGameCreated(gameId) {
    console.log('Game created with ID:', gameId); // Debug log
    
    currentGameId = gameId;
    isHost = true;
    
    // Update all displays in the correct order
    document.querySelector('.lobby-screen').style.display = 'none';
    document.getElementById('gameArea').style.display = 'flex'; // Change to flex
    document.getElementById('hostCodeDisplay').style.display = 'block';
    document.getElementById('startGame').style.display = 'block';
    document.getElementById('hostCode').textContent = gameId;
    document.getElementById('gameCode').textContent = gameId;
    
    // Ensure the game area is visible
    document.getElementById('gameArea').classList.add('active');
}

function handleGameUpdate(game) {
    isHost = socket.id === game.hostId;
    const isCurrentPlayer = game.players[game.currentPlayer]?.id === socket.id;
    const canAct = isCurrentPlayer && game.status === 'playing';
    
    updateGameDisplay(game);
    toggleActionButtons(canAct);
    
    document.getElementById('startGame').style.display = 
        isHost && game.status === 'lobby' ? 'block' : 'none';
    document.getElementById('resetButton').style.display = isHost ? 'block' : 'none';

    // Remove any existing freeze popups when game updates
    if (activeFreezePopup) {
      activeFreezePopup.remove();
      activeFreezePopup = null;
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

    // Helper function to get sort order for special cards
    const getSpecialCardOrder = card => {
        const specialOrder = {
            'SC': 1,
            'Freeze': 2,
            'D3': 3,
            '2x': 4,
            '2+': 5,
            '4+': 6,
            '6+': 7,
            '8+': 8,
            '10+': 9
        };
        return specialOrder[card] || 10;
    };

    Object.entries(cardCounts).forEach(([cardStr, count]) => {
        let cardType, displayValue;
        
        if (cardStr === 'SC' || cardStr === 'Freeze' || cardStr === 'D3' || 
            cardStr.includes('+') || cardStr.includes('x')) {
            cardType = 
                cardStr === 'SC' ? 'second-chance' :
                cardStr === 'Freeze' ? 'freeze' :
                cardStr === 'D3' ? 'draw-three' :
                cardStr.includes('+') ? 'adder' :
                'multiplier';
            displayValue = 
                cardStr === 'SC' ? '🛡️' :
                cardStr === 'Freeze' ? '❄️' :
                cardStr === 'D3' ? '🎯' :
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
    specialCards.sort((a, b) => getSpecialCardOrder(a.cardStr) - getSpecialCardOrder(b.cardStr));

    document.getElementById('discard').innerHTML = `
        <div class="regular-cards">
            ${regularCards.map(card => renderCard(card)).join('')}
        </div>
        <div class="special-cards">
            ${specialCards.map(card => renderCard(card)).join('')}
        </div>
    `;
}

function renderCard({ cardType, displayValue, count }) {
    const cardStyle = cardType !== 'number' ? `
        background: ${
            cardType === 'adder' ? '#27ae60' : 
            cardType === 'multiplier' ? '#f1c40f' :
            cardType === 'second-chance' ? '#e74c3c' :
            cardType === 'freeze' ? '#3498db' :
            cardType === 'draw-three' ? '#9b59b6' : 'inherit'
        } !important;
    ` : '';

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
    return `
        <div class="player ${isCurrentTurn ? 'current-turn' : ''} ${player.status}" data-player-id="${player.id}">
            <div class="player-header">
                <h3>${player.name} ${player.id === socket.id ? '<span class="you">(You)</span>' : ''}</h3>
                <div class="player-status">
                    ${getStatusIcon(player.status)}
                    ${player.bustedCard ? `<div class="busted-card">BUSTED ON ${player.bustedCard}</div>` : ''}
                    ${player.specialCards.includes('SC') ? `
                        <div class="second-chance-indicator">🛡️ SECOND CHANCE</div>
                    ` : ''}
                </div>
            </div>
            <div class="scores">
                ${scoreBox('Round Score', player.roundScore)}
                ${scoreBox('Total Score', player.totalScore)}
                ${scoreBox('Cards', `${player.regularCards.length}/${MAX_REGULAR_CARDS}`)}
            </div>
            <div class="card-grid">
                ${player.regularCards.map(card => `<div class="card">${card}</div>`).join('')}
            </div>
            ${player.specialCards.length > 0 ? `
                <div class="special-cards-container">
                    ${player.specialCards.map(card => `
                        <div class="card special ${getSpecialCardClass(card)}">
                            ${getSpecialCardDisplay(card)}
                        </div>
                    `).join('')}
                </div>
            ` : ''}
            ${player.drawThreeRemaining > 0 ? `
                <div class="draw-three-indicator">
                  🎯 Draw ${player.drawThreeRemaining} more cards
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

function getSpecialCardClass(card) {
    if (card === 'SC') return 'second-chance';
    if (card === 'Freeze') return 'freeze';
    if (card === 'D3') return 'draw-three';
    if (card.endsWith('x')) return 'multiplier';
    if (card.endsWith('+')) return 'adder';
    return '';
}

function getSpecialCardDisplay(card) {
    // Special cards with emojis
    if (card === 'SC') return '🛡️';
    if (card === 'Freeze') return '❄️';
    if (card === 'D3') return '🎯';
    
    // For adder and multiplier cards, extract the number and symbol
    if (card.endsWith('+') || card.endsWith('x')) {
        const number = card.slice(0, -1);  // Get everything except last character
        const symbol = card.slice(-1);     // Get last character (+ or x)
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
    
    flipCardBtn.style.display = showButtons ? 'block' : 'none';
    standButton.style.display = 
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
        return {
            id: playerEl.dataset.playerId,
            drawThreeRemaining
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
    document.getElementById('gameCode').textContent = gameId;
    document.querySelector('.lobby-screen').style.display = 'none';
    document.getElementById('gameArea').style.display = 'block';
}

function handleGameStarted(game) {
    document.getElementById('startGame').style.display = 'none';
    // Only show buttons for the first player (current player)
    const isCurrentPlayer = game.players[game.currentPlayer]?.id === socket.id;
    toggleActionButtons(isCurrentPlayer && game.status === 'playing');
    updateGameDisplay(game);
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

function showWinnerPopup(winner) {
    const popup = document.createElement('div');
    popup.className = 'winner-popup';
    popup.innerHTML = `
        <h2>🏆 TOTAL WINNER! 🏆</h2>
        <div class="winner-name">${winner.name}</div>
        <div class="winner-score">${winner.totalScore} Points</div>
        <button id="rematchButton" class="game-button green">
            Play Again with Same Players
        </button>
    `;
    document.body.appendChild(popup);

    // Add rematch button listener
    document.getElementById('rematchButton').addEventListener('click', () => {
        socket.emit('request-rematch', currentGameId);
        popup.remove();
    });
}

// Add new socket event listener near the top with other socket.on events
socket.on('rematch-started', (game) => {
    const popups = document.querySelectorAll('.winner-popup');
    popups.forEach(popup => popup.remove());
    handleGameStarted(game);
});

function handleGameOver({ players, winner }) {
    playSound('winSound');
    toggleActionButtons(false);
    showWinnerPopup(winner);
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
            <div class="player-summary ${status}">
                <div class="summary-left">
                    <span class="player-name">${player.name}</span>
                    <div class="status-info">
                        <div class="status-badge ${status}">${getStatusText(status)}</div>
                        ${hasBonus ? `<div class="bonus-badge">+15 BONUS</div>` : ''}
                        ${player.bustedCard ? `
                            <div class="busted-card">Busted on ${player.bustedCard}</div>
                        ` : ''}
                    </div>
                </div>
                <div class="summary-scores">
                    <div class="score-item">
                        <span class="score-label">Round Score:</span>
                        <span class="score-value">${player.roundScore}</span>
                    </div>
                    <div class="score-item">
                        <span class="score-label">New Total:</span>
                        <span class="score-value">${newTotal}</span>
                    </div>
                </div>
            </div>
        `;
    }).join('');

    popup.innerHTML = `
        <div class="popup-content">
            <h2>${allBusted ? '💥 ALL PLAYERS BUSTED! 💥' : '🏁 ROUND SUMMARY 🏁'}</h2>
            <div class="player-list">${playerList}</div>
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
      <h3>Select a player to freeze:</h3>
      ${targets.map(t => `
        <button class="freeze-target" data-id="${t.id}">
          ${t.name}
        </button>
      `).join('')}
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

function showTutorial() {
    // Remove any existing popup first
    const existingPopup = document.querySelector('.tutorial-popup');
    if (existingPopup) existingPopup.remove();

    const popup = document.createElement('div');
    popup.className = 'tutorial-popup';
    popup.innerHTML = `
        <button class="close-button">×</button>
        <div class="tutorial-content">
            <div class="tutorial-tabs">
                <button class="tab-button active" data-tab="cards">Cards</button>
                <button class="tab-button" data-tab="rules">Rules</button>
            </div>

            <div class="tab-content active" id="cards-tab">
                <div class="tutorial-section">
                    <h2>Regular Cards (1-12)</h2>
                    <p>Regular cards from 1 to 12, each appearing as many times as its value.</p>
                    <div class="cards-grid">
                        <div class="card-example">
                            <div class="card">7</div>
                            <div class="card-explanation">
                                Example: Number 7 appears 7 times in the deck
                            </div>
                        </div>
                    </div>
                    <p>(except for 0 it appears once and has 0 points)</p>
                </div>

                <div class="tutorial-section">
                    <h2>Special Cards</h2>
                    <div class="cards-grid">
                        <div class="card-example">
                            <div class="card special second-chance">🛡️</div>
                            <div class="card-explanation">
                                Second Chance: Protects you from busting once
                            </div>
                        </div>
                        <div class="card-example">
                            <div class="card special freeze">❄️</div>
                            <div class="card-explanation">
                                Freeze: Skip a player's turn
                            </div>
                        </div>
                        <div class="card-example">
                            <div class="card special draw-three">🎯</div>
                            <div class="card-explanation">
                                Draw Three: Force a player to draw 3 cards
                            </div>
                        </div>
                        <div class="card-example">
                            <div class="card special adder">4+</div>
                            <div class="card-explanation">
                                Add Card: Adds value to your total score
                            </div>
                        </div>
                        <div class="card-example">
                            <div class="card special multiplier">2×</div>
                            <div class="card-explanation">
                                Multiply Card: Multiplies your total score
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div class="tab-content" id="rules-tab">
                <div class="tutorial-section">
                    <h2>Game Rules</h2>
                    <ul class="rules-list">
                        <li>Players take turns drawing cards</li>
                        <li>Each player can hold up to 7 regular number cards</li>
                        <li>Drawing a duplicate number card will bust you unless you have a Second Chance</li>
                        <li>Special cards don't count toward the 7-card limit</li>
                        <li>First player to reach 200 points wins</li>
                        <li>If all players bust, the round is restarted</li>
                        <li>Your score is calculated as: (Sum of unique numbers + Adder cards) × Multiplier cards</li>
                        <li>Bonus: Get 15 extra points for reaching 7 cards in one turn!</li>
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