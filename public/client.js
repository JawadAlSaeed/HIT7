const socket = io();
let currentGameId = null;

// Initialize DOM event listeners
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('createGame').addEventListener('click', createGame);
    document.getElementById('joinGame').addEventListener('click', joinGame);
    document.getElementById('startGame').addEventListener('click', startGame);
    document.getElementById('flipCard').addEventListener('click', flipCard);
    document.getElementById('standButton').addEventListener('click', stand);
    document.getElementById('resetButton').addEventListener('click', resetGame);
});

// Socket event handlers
socket.on('game-created', handleGameCreated);
socket.on('game-joined', handleGameJoined);
socket.on('game-update', updateGameDisplay);
socket.on('game-started', handleGameStarted);
socket.on('new-round', handleNewRound);
socket.on('game-over', handleGameOver);
socket.on('error', showError);

// Core game functions
function createGame() {
    const playerName = prompt('Enter your name:');
    if (playerName) socket.emit('create-game', playerName);
}

function joinGame() {
    const gameId = document.getElementById('gameId').value.trim().toUpperCase();
    const playerName = prompt('Enter your name:');
    if (gameId && playerName) socket.emit('join-game', gameId, playerName);
}

function startGame() {
    socket.emit('start-game', currentGameId);
}

function flipCard() {
    socket.emit('flip-card', currentGameId);
}

function stand() {
    socket.emit('stand', currentGameId);
}

function resetGame() {
    window.location.reload();
}

// Game state handlers
function handleGameCreated(gameId) {
    currentGameId = gameId;
    document.getElementById('gameCode').textContent = gameId;
    showGameArea();
    document.getElementById('startGame').style.display = 'block';
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
    document.getElementById('flipCard').style.display = 'block';
    document.getElementById('standButton').style.display = 'block';
    updateGameDisplay(game);
}

function handleGameOver({ players, winner }) {
    toggleActionButtons(false);
    const container = document.getElementById('playersContainer');
    container.innerHTML = `
        <div class="game-over">
            <h2>🏆 Total Winner: ${winner.name} 🏆</h2>
            <div class="final-scores">
                ${players.map(p => `
                    <div class="player-score ${p.id === socket.id ? 'you' : ''}">
                        ${p.name}${p.id === socket.id ? ' (You)' : ''} 
                        - Total: ${p.totalScore}
                    </div>
                `).join('')}
            </div>
        </div>`;
}

// UI update functions
function updateGameDisplay(game) {
    document.getElementById('deckCount').textContent = game.deck.length;
    document.getElementById('discard').innerHTML = 
        game.discardPile.map(card => `<div class="card">${card}</div>`).join('');

    const container = document.getElementById('playersContainer');
    container.innerHTML = game.players.map((player, index) => `
        <div class="player ${index === game.currentPlayer ? 'current-turn' : ''} ${player.status}">
            <div class="player-header">
                <h3>${player.name} ${player.id === socket.id ? '<span class="you">(You)</span>' : ''}</h3>
                <div class="player-status">
                    ${getStatusIcon(player.status)}
                    ${player.bustedCard ? `<div class="busted-card">Busted on: ${player.bustedCard}</div>` : ''}
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

    const isCurrentPlayer = game.players[game.currentPlayer]?.id === socket.id;
    toggleActionButtons(isCurrentPlayer && game.status === 'playing');
}

// Helper functions
function showGameArea() {
    document.querySelector('.lobby-screen').style.display = 'none';
    document.getElementById('gameArea').style.display = 'block';
}

function toggleActionButtons(show) {
    document.getElementById('flipCard').style.display = show ? 'block' : 'none';
    document.getElementById('standButton').style.display = show ? 'block' : 'none';
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

function showError(message) {
    const errorDiv = document.createElement('div');
    errorDiv.className = 'error-message';
    errorDiv.textContent = message;
    document.body.appendChild(errorDiv);
    setTimeout(() => errorDiv.remove(), 3000);
}