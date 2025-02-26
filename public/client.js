const socket = io();
let currentGameId = null;
let isHost = false;
const MAX_REGULAR_CARDS = 7;
let activeFreezePopup = null;
let activeDrawThreePopup = null;

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('createGame').addEventListener('click', createGame);
    document.getElementById('joinGame').addEventListener('click', joinGame);
    document.getElementById('startGame').addEventListener('click', startGame);
    document.getElementById('flipCard').addEventListener('click', flipCard);
    document.getElementById('standButton').addEventListener('click', stand);
    document.getElementById('resetButton').addEventListener('click', resetGame);
    document.getElementById('tutorialButton').addEventListener('click', showTutorial);
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

// Game actions
function createGame() {
    const name = prompt('Enter your name:');
    if (name) socket.emit('create-game', name);
}

function joinGame() {
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

function startGame() { socket.emit('start-game', currentGameId); }
function flipCard() { socket.emit('flip-card', currentGameId); }
function stand() { socket.emit('stand', currentGameId); }

function resetGame() {
    if (confirm('Reset game for all players?')) socket.emit('reset-game', currentGameId);
}

// Game state handlers
function handleGameCreated(gameId) {
    currentGameId = gameId;
    document.getElementById('hostCode').textContent = gameId;
    document.getElementById('hostCodeDisplay').style.display = 'block';
    document.getElementById('gameCode').textContent = gameId;
    document.getElementById('startGame').style.display = 'block';
    isHost = true;
    showGameArea();
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
    updateDiscardPile(game.discardPile);
    renderPlayers(game);
}

function updateDiscardPile(discardPile) {
  const discardCounts = discardPile.reduce((acc, card) => {
    const key = card.toString();
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  const typeMap = {
    'SC': { type: 'second-chance', display: '🛡️' },
    'Freeze': { type: 'freeze', display: '❄️' },
    'D3': { type: 'draw-three', display: '🎯' },
    '+': { type: 'adder', display: '' },
    'x': { type: 'multiplier', display: '' }
  };

  const sortOrder = {
    'second-chance': 1,
    'freeze': 2,
    'draw-three': 3,
    'adder': 4,
    'multiplier': 5,
    'number': 6
  };

  document.getElementById('discard').innerHTML = Object.entries(discardCounts)
    .map(([cardStr, count]) => {
      // Determine card type and display
      let cardType, displayValue;
      
      // Check if it's a special card
      const specialCard = typeMap[cardStr] || 
                         (cardStr.endsWith('+') ? typeMap['+'] : 
                          cardStr.endsWith('x') ? typeMap['x'] : null);
      
      if (specialCard) {
        cardType = specialCard.type;
        displayValue = specialCard.display || cardStr;
      } else {
        cardType = 'number';
        displayValue = cardStr;
      }

      return {
        html: `
          <div class="discard-card ${cardType} ${!specialCard ? 'regular-card' : 'special'}">
            ${displayValue}
            ${count > 1 ? `<span class="discard-count">x${count}</span>` : ''}
          </div>
        `,
        order: sortOrder[cardType] || 999
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
  return card === 'SC' ? '🛡️' :
    card === 'Freeze' ? '❄️' :
    card === 'D3' ? '🎯' :
    card.replace(/[^0-9]/g, '');
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
        frozen: 'FROZEN'
    }[status];
}

// UI controls
function showGameArea() {
    document.querySelector('.lobby-screen').style.display = 'none';
    document.getElementById('gameArea').style.display = 'block';
}

function toggleActionButtons(active) {
    const flipCardBtn = document.getElementById('flipCard');
    const standButton = document.getElementById('standButton');
    
    // Get current player object
    const game = getCurrentGameState();
    const currentPlayer = game?.players[game.currentPlayer];
    const isCurrentPlayersTurn = currentPlayer?.id === socket.id;
    
    // Show flip card button if it's player's turn and they're active
    flipCardBtn.style.display = active ? 'block' : 'none';
    
    // Show stand button if:
    // 1. It's player's turn
    // 2. They're active
    // 3. They're not in the middle of a Draw Three
    standButton.style.display = (active && (!currentPlayer || currentPlayer.drawThreeRemaining === 0)) ? 'block' : 'none';
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
    showGameArea();
}

function handleGameStarted(game) {
    document.getElementById('startGame').style.display = 'none';
    toggleActionButtons(true);
    updateGameDisplay(game);
}

function handleNewRound(game) {
    toggleActionButtons(true);
    updateGameDisplay(game);
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
        <button onclick="window.location.reload()" class="game-button green">
            Play Again
        </button>
    `;
    document.body.appendChild(popup);
}

function handleGameOver({ players, winner }) {
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
    const popup = document.createElement('div');
    popup.className = 'round-summary-popup';
    
    const playerList = players.map(player => `
        <div class="player-summary ${player.status}">
            <span class="player-name">${player.name}</span>
            <div class="status-info">
                <div class="status-badge">${getStatusText(player.status)}</div>
                ${player.bustedCard ? `
                    <div class="busted-card">Busted on ${player.bustedCard}</div>
                ` : ''}
            </div>
            <div class="scores">
                <span class="score">Round: ${player.roundScore}</span>
                <span class="score">Total: ${player.totalScore}</span>
            </div>
        </div>
    `).join('');

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