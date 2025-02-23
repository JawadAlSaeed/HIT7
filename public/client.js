const socket = io();
let currentGameId = null;

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
socket.on('game-over', handleGameOver);
socket.on('error', showError);

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

// Event handlers
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

function handleGameOver({ players, winner }) {
  toggleActionButtons(false);
  
  const statusMessage = `
    <div class="game-over">
      <h2>🏆 Game Over! 🏆</h2>
      <div class="winner">Winner: ${winner.name} (${winner.score} points)</div>
      <div class="scores">
        ${players.map(p => `
          <div class="player-score ${p.id === socket.id ? 'you' : ''}">
            ${p.name}${p.id === socket.id ? ' (You)' : ''}: 
            ${p.score} points 
            ${p.status === 'busted' ? '💥 BUSTED' : '🛑 STOOD'}
          </div>
        `).join('')}
      </div>
    </div>`;
  
  document.getElementById('playersContainer').innerHTML = statusMessage;
}

function updateGameDisplay(game) {
  document.getElementById('deckCount').textContent = game.deck.length;
  document.getElementById('discard').innerHTML = 
    game.discardPile.map(card => `<div class="card">${card}</div>`).join('');

  const container = document.getElementById('playersContainer');
  container.innerHTML = game.players.map((player, index) => {
    const uniqueCards = [...new Set(player.cards)];
    const score = uniqueCards.reduce((sum, card) => sum + card, 0);
    const isCurrent = index === game.currentPlayer;
    const isYou = player.id === socket.id;

    return `
      <div class="player ${isCurrent ? 'current-turn' : ''} ${player.status}">
        <h3>${player.name} ${isYou ? '<span class="you">(You)</span>' : ''}</h3>
        <div class="score">Score: ${score}</div>
        <div class="card-grid">
          ${player.cards.map(card => `
            <div class="card ${player.cards.filter(c => c === card).length > 1 ? 'bust' : ''}">
              ${card}
            </div>
          `).join('')}
        </div>
      </div>`;
  }).join('');

  const isCurrentPlayer = game.players[game.currentPlayer]?.id === socket.id;
  toggleActionButtons(isCurrentPlayer && game.status === 'playing');
}

function showGameArea() {
  document.querySelector('.lobby-screen').style.display = 'none';
  document.getElementById('gameArea').style.display = 'block';
}

function toggleActionButtons(show) {
  document.getElementById('flipCard').style.display = show ? 'block' : 'none';
  document.getElementById('standButton').style.display = show ? 'block' : 'none';
}

function showError(message) {
  const errorDiv = document.createElement('div');
  errorDiv.className = 'error-message';
  errorDiv.textContent = message;
  document.body.appendChild(errorDiv);
  setTimeout(() => errorDiv.remove(), 3000);
}