const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files
app.use(express.static('public'));

// Store active games
const games = new Map();

// Deck functions
function createDeck() {
  const deck = [];
  for (let number = 1; number <= 12; number++) {
    for (let i = 0; i < number; i++) {
      deck.push(number);
    }
  }
  return shuffle(deck);
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

// Socket.io handlers
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Create game
  socket.on('create-game', (playerName) => {
    const gameId = uuidv4().substr(0, 5).toUpperCase();
    const deck = createDeck();
    
    games.set(gameId, {
      players: [{
        id: socket.id,
        name: playerName,
        cards: [],
        score: 0,
        status: 'waiting'
      }],
      deck: deck,
      discardPile: [],
      currentPlayer: 0,
      status: 'lobby'
    });
    
    socket.join(gameId);
    socket.emit('game-created', gameId);
  });

  // Join game
  socket.on('join-game', (gameId, playerName) => {
    const game = games.get(gameId);
    if (!game) return socket.emit('error', 'Game not found');
    
    game.players.push({
      id: socket.id,
      name: playerName,
      cards: [],
      score: 0,
      status: 'waiting'
    });
    
    socket.join(gameId);
    io.to(gameId).emit('players-updated', game.players);
    io.to(gameId).emit('game-update', game);
  });

  // Start game
  socket.on('start-game', (gameId) => {
    const game = games.get(gameId);
    if (!game || game.status !== 'lobby') return;
    
    game.status = 'playing';
    io.to(gameId).emit('game-started', game);
  });

  // Flip card
  socket.on('flip-card', (gameId) => {
    const game = games.get(gameId);
    if (!game || game.status !== 'playing') return;
    
    const currentPlayer = game.players[game.currentPlayer];
    if (socket.id !== currentPlayer.id) return;

    const card = game.deck.pop();
    game.discardPile.push(card);
    
    const player = game.players.find(p => p.id === socket.id);
    if (player.cards.includes(card)) {
      player.status = 'busted';
    } else {
      player.cards.push(card);
    }

    // Update current player
    game.currentPlayer = (game.currentPlayer + 1) % game.players.length;
    
    io.to(gameId).emit('game-update', game);
  });

  // Disconnect handler
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
  });
});

server.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});