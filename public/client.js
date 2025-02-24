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

socket.on('game-created', handleGameCreated);
socket.on('game-joined', handleGameJoined);
socket.on('game-update', handleGameUpdate);
socket.on('game-started', handleGameStarted);
socket.on('new-round', handleNewRound);
socket.on('game-over', handleGameOver);
socket.on('all-busted', handleAllBusted);
socket.on('game-reset', handleGameReset);
socket.on('error', handleError);

function createGame() {
    const name = prompt('Enter your name:');
    if (name) socket.emit('create-game', name);
}

function joinGame() {
    const code = document.getElementById('gameId').value.trim().toUpperCase();
    const name = prompt('Enter your name:');
    if (code && name) socket.emit('join-game', code, name);
}

function startGame() { socket.emit('start-game', currentGameId); }
function flipCard() { socket.emit('flip-card', currentGameId); }
function stand() { socket.emit('stand', currentGameId); }

function resetGame() {
    if (confirm('Reset game for all players?')) {
        socket.emit('reset-game', currentGameId);
    }
}

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
    
    // Fix start button visibility
    const startBtn = document.getElementById('startGame');
    startBtn.style.display = isHost && game.status === 'lobby' ? 'block' : 'none';
    document.getElementById('resetButton').style.display = isHost ? 'block' : 'none';
}

function updateGameDisplay(game) {
    const discardCounts = game.discardPile.reduce((acc, card) => {
        acc[card] = (acc[card] || 0) + 1;
        return acc;
    }, {});
    
    document.getElementById('discard').innerHTML = Object.entries(discardCounts).map(([cardStr, count]) => {
        const isNumber = !isNaN(cardStr);
        return `
            <div class="card ${isNumber ? '' : (cardStr.endsWith('x') ? 'special multiplier' : 'special adder')}">
                ${isNumber ? parseInt(cardStr, 10) : cardStr}
                ${isNumber ? `<small class="discard-count">x${count}</small>` : ''}
            </div>
        `;
    }).join('');

    document.getElementById('playersContainer').innerHTML = game.players.map((player, index) => `
        <div class="player ${index === game.currentPlayer ? 'current-turn' : ''} ${player.status}">
            <div class="player-header">
                <h3>${player.name} ${player.id === socket.id ? '<span class="you">(You)</span>' : ''}</h3>
                <div class="player-status">
                    ${getStatusIcon(player.status)}
                    ${player.bustedCard ? `
                        <div class="busted-card">BUSTED ON ${player.bustedCard}</div>
                    ` : ''}
                </div>
            </div>
            <div class="scores">
                <div class="score-box">
                    <div>Round Score</div>
                    <div class="score-value">${player.roundScore}</div>
                </div>
                <div class="score-box">
                    <div>Total Score</div>
                    <div class="score-value">${player.totalScore}</div>
                </div>
                <div class="score-box">
                    <div>Cards</div>
                    <div class="score-value">${player.regularCards.length}/${MAX_REGULAR_CARDS}</div>
                </div>
            </div>
            <div class="card-grid">
                ${player.regularCards.map(card => `
                    <div class="card">${card}</div>
                `).join('')}
            </div>
            ${player.specialCards.length > 0 ? `
                <div class="special-cards-container">
                    ${player.specialCards.map(card => `
                        <div class="card special ${card.endsWith('x') ? 'multiplier' : 'adder'}">
                            ${card.replace('+', '')}${card.endsWith('x') ? '✕' : '+'}
                        </div>
                    `).join('')}
                </div>
            ` : ''}
        </div>
    `).join('');

    document.getElementById('deckCount').textContent = game.deck.length;
}

function showGameArea() {
    document.querySelector('.lobby-screen').style.display = 'none';
    document.getElementById('gameArea').style.display = 'block';
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

function toggleActionButtons(active) {
    const flipBtn = document.getElementById('flipCard');
    const standBtn = document.getElementById('standButton');
    
    if (active) {
        flipBtn.style.display = 'block';
        standBtn.style.display = 'block';
    } else {
        flipBtn.style.display = 'none';
        standBtn.style.display = 'none';
    }
}

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