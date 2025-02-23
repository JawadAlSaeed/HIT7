const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const games = new Map();

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

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('create-game', (playerName) => {
    const gameId = uuidv4().substr(0, 5).toUpperCase();
    const deck = createDeck();
    
    const initialPlayers = [{
      id: socket.id,
      name: playerName,
      cards: [],
      score: 0,
      status: 'waiting'
    }];

    games.set(gameId, {
      players: initialPlayers,
      deck: deck,
      discardPile: [],
      currentPlayer: 0,
      status: 'lobby'
    });
    
    socket.join(gameId);
    socket.emit('game-created', gameId);
  });

  socket.on('join-game', (gameId, playerName) => {
    const game = games.get(gameId);
    if (!game) return socket.emit('error', 'Game not found');
    
    const newPlayer = {
      id: socket.id,
      name: playerName,
      cards: [],
      score: 0,
      status: 'waiting'
    };
    
    game.players.push(newPlayer);
    socket.join(gameId);
    
    socket.emit('game-joined', game);
    io.to(gameId).emit('players-updated', game.players);
    io.to(gameId).emit('game-update', game);
  });

  socket.on('start-game', (gameId) => {
    const game = games.get(gameId);
    if (!game || game.status !== 'lobby') return;
    
    game.status = 'playing';
    game.players.forEach(p => p.status = 'active');
    io.to(gameId).emit('game-started', game);
  });

  socket.on('flip-card', (gameId) => {
    const game = games.get(gameId);
    if (!game || game.status !== 'playing') return;
    
    const currentPlayer = game.players[game.currentPlayer];
    if (socket.id !== currentPlayer.id) {
      socket.emit('error', 'Not your turn!');
      return;
    }

    const card = game.deck.pop();
    game.discardPile.push(card);
    
    const player = game.players.find(p => p.id === socket.id);
    if (player.cards.includes(card)) {
      player.status = 'busted';
    } else {
      player.cards.push(card);
    }

    // Advance turn
    if (player.status !== 'busted') {
      do {
        game.currentPlayer = (game.currentPlayer + 1) % game.players.length;
      } while (game.players[game.currentPlayer].status === 'busted');
    }

    // Check game end
    const activePlayers = game.players.filter(p => p.status !== 'busted');
    if (activePlayers.length === 0) {
      game.status = 'finished';
    }

    io.to(gameId).emit('game-update', game);
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
  });
});

server.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});