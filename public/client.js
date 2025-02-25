const socket = io();
let currentGameId = null;
let isHost = false;
const MAX_REGULAR_CARDS = 7;

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('createGame').addEventListener('click', createGame);
    document.getElementById('joinGame').addEventListener('click', joinGame);
    document.getElementById('startGame').addEventListener('click', startGame);
    document.getElementById('flipCard').addEventListener('click', flipCard);
    document.getElementById('standButton').addEventListener('click', stand);
    document.getElementById('resetButton').addEventListener('click', resetGame);
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
  const popup = document.getElementById('freezePopup');
  if (popup) popup.remove();
});

socket.on('select-freeze-target', (gameId, targets) => {
  const popup = document.createElement('div');
  popup.className = 'freeze-popup';
  popup.innerHTML = `
    <div class="popup-content">
      <h3>❄️ Select player to freeze:</h3>
      ${targets.map(p => `
        <button class="freeze-target" data-id="${p.id}">
          ${p.name}
        </button>
      `).join('')}
      <button class="cancel-freeze">Cancel</button>
    </div>
  `;

  popup.querySelectorAll('.freeze-target').forEach(btn => {
    btn.addEventListener('click', () => {
      socket.emit('use-freeze', gameId, btn.dataset.id);
      popup.remove();
    });
  });

  popup.querySelector('.cancel-freeze').addEventListener('click', () => {
    popup.remove();
  });

  document.body.appendChild(popup);
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
    document.querySelectorAll('.freeze-popup').forEach(p => p.remove());
}

// Display updates
function updateGameDisplay(game) {
    document.getElementById('deckCount').textContent = game.deck.length;
    updateDiscardPile(game.discardPile);
    renderPlayers(game);
}

function updateDiscardPile(discardPile) {
    const discardCounts = discardPile.reduce((acc, card) => {
        acc[card] = (acc[card] || 0) + 1;
        return acc;
    }, {});

    document.getElementById('discard').innerHTML = Object.entries(discardCounts)
        .map(([cardStr, count]) => {
            const isNumber = !isNaN(cardStr);
            const isSC = cardStr === 'SC';

            if (isNumber) {
                return `
                    <div class="discard-card">
                        ${cardStr}
                        ${count > 1 ? `<span class="discard-count">x${count}</span>` : ''}
                    </div>
                `;
            }

            const typeMap = {
                '+': 'adder',
                'x': 'multiplier',
                'SC': 'second-chance'
            };
            const cardType = Object.entries(typeMap).find(([key]) => cardStr.includes(key))?.[1];
            const displayValue = isSC ? '🛡️' : cardStr.replace(/[^0-9]/g, '');

            return `
                <div class="discard-card special ${cardType}">
                    ${displayValue}
                    ${count > 1 ? `<span class="discard-count">x${count}</span>` : ''}
                </div>
            `;
        }).join('');
}

function renderPlayers(game) {
    document.getElementById('playersContainer').innerHTML = game.players
        .map((player, index) => playerTemplate(player, index === game.currentPlayer))
        .join('');
}

function playerTemplate(player, isCurrentTurn) {
    return `
        <div class="player ${isCurrentTurn ? 'current-turn' : ''} ${player.status}">
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
  return card === 'SC' ? 'second-chance' :
    card === 'Freeze' ? 'freeze' :
    card.endsWith('x') ? 'multiplier' : 'adder';
}

function getSpecialCardDisplay(card) {
  return card === 'SC' ? '🛡️' :
    card === 'Freeze' ? '❄️' :
    card.replace(/[^0-9]/g, '');
}

function getStatusIcon(status) {
    const statusMap = {
        active: ['⭐', 'ACTIVE'],
        stood: ['🛑', 'STOOD'], 
        busted: ['💥', 'BUSTED'],
        waiting: ['⏳', 'WAITING']
    };
    return `
        <span class="status-icon">${statusMap[status][0]}</span>
        <span class="status-text">${statusMap[status][1]}</span>
    `;
}

function getStatusText(status) {
    const statusMap = {
        active: 'ACTIVE',
        stood: 'STOOD', 
        busted: 'BUSTED',
        waiting: 'WAITING'
    };
    return statusMap[status];
}

// UI controls
function showGameArea() {
    document.querySelector('.lobby-screen').style.display = 'none';
    document.getElementById('gameArea').style.display = 'block';
}

function toggleActionButtons(active) {
    document.getElementById('flipCard').style.display = active ? 'block' : 'none';
    document.getElementById('standButton').style.display = active ? 'block' : 'none';
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
  const popup = document.createElement('div');
  popup.id = 'freezePopup';
  popup.className = 'freeze-popup';
  popup.innerHTML = `
    <div class="popup-content">
      <h3>Select a player to freeze:</h3>
      ${targets.map(t => `
        <button class="freeze-target" data-id="${t.id}">
          ${t.name}
        </button>
      `).join('')}
      <button class="cancel-freeze">Cancel</button>
    </div>
  `;

  popup.querySelectorAll('.freeze-target').forEach(btn => {
    btn.addEventListener('click', () => {
      socket.emit('freeze-player', currentGameId, btn.dataset.id);
      popup.remove();
    });
  });

  popup.querySelector('.cancel-freeze').addEventListener('click', () => {
    socket.emit('cancel-freeze', currentGameId);
    popup.remove();
  });

  document.body.appendChild(popup);
}