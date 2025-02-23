const socket = io();
let currentGameId = null;
let isHost = false;

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('createGame').addEventListener('click', createGame);
    document.getElementById('joinGame').addEventListener('click', joinGame);
    document.getElementById('startGame').addEventListener('click', startGame);
    document.getElementById('flipCard').addEventListener('click', flipCard);
    document.getElementById('standButton').addEventListener('click', stand);
    document.getElementById('resetButton').addEventListener('click', resetGame);
});

// Socket handlers
socket.on('game-created', handleGameCreated);
socket.on('game-joined', handleGameJoined);
socket.on('game-update', handleGameUpdate);
socket.on('game-started', handleGameStarted);
socket.on('new-round', handleNewRound);
socket.on('game-over', handleGameOver);
socket.on('game-reset', handleGameReset);
socket.on('error', handleError);

// Core functions
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

// UI updates
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
    updateGameDisplay(game);
    document.getElementById('resetButton').style.display = isHost ? 'block' : 'none';
}

function updateGameDisplay(game) {
    // Update discard pile
    const discardCounts = game.discardPile.reduce((acc, card) => {
        acc[card] = (acc[card] || 0) + 1;
        return acc;
    }, {});
    
    document.getElementById('discard').innerHTML = Object.entries(discardCounts)
        .map(([number, count]) => `
            <div class="discard-card">
                ${number} <span class="discard-count">[${count}]</span>
            </div>
        `).join('');

    // Update players
    document.getElementById('playersContainer').innerHTML = game.players.map((player, index) => `
        <div class="player ${index === game.currentPlayer ? 'current-turn' : ''} ${player.status}">
            <div class="player-header">
                <h3>${player.name} ${player.id === socket.id ? '<span class="you">(You)</span>' : ''}</h3>
                <div class="player-status">
                    ${getStatusIcon(player.status)}
                    ${player.bustedCard ? `
                        <div class="busted-card">Busted on: ${player.bustedCard}</div>
                    ` : ''}
                </div>
            </div>
            <div class="scores">
                <div>Round: ${player.roundScore}</div>
                <div>Total: ${player.totalScore}</div>
            </div>
            <div class="card-grid">
                ${player.cards.map(card => `
                    <div class="card ${player.cards.filter(c => c === card).length > 1 ? 'bust' : ''}">
                        ${card}
                    </div>
                `).join('')}
            </div>
        </div>
    `).join('');

    document.getElementById('deckCount').textContent = game.deck.length;
}

// Helper functions
function showGameArea() {
    document.querySelector('.lobby-screen').style.display = 'none';
    document.getElementById('gameArea').style.display = 'block';
}

function getStatusIcon(status) {
    const icons = {
        active: '⭐ Playing',
        stood: '🛑 Stood',
        busted: '💥 Busted',
        waiting: '⏳ Waiting'
    };
    return `<span class="status-icon">${icons[status]}</span>`;
}

// Event handlers
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

function handleGameOver({ players, winner }) {
    const container = document.getElementById('playersContainer');
    container.innerHTML = `
        <div class="game-over">
            <h2>🏆 Winner: ${winner.name} (${winner.totalScore} points)</h2>
            <div class="final-scores">
                ${players.map(p => `
                    <div class="player-score ${p.id === socket.id ? 'you' : ''}">
                        ${p.name}: ${p.totalScore} points
                    </div>
                `).join('')}
            </div>
        </div>`;
    toggleActionButtons(false);
}

function handleGameReset() {
    alert('Game has been reset by the host!');
    window.location.reload();
}

function handleError(message) {
    alert(message);
}

function toggleActionButtons(show) {
    document.getElementById('flipCard').style.display = show ? 'block' : 'none';
    document.getElementById('standButton').style.display = show ? 'block' : 'none';
}