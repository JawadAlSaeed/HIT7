const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
const games = new Map();

// Game logic functions
const createDeck = () => {
  const deck = [];
  for (let number = 1; number <= 12; number++) {
    for (let i = 0; i < number; i++) deck.push(number);
  }
  return shuffle(deck);
};

const shuffle = (array) => {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
};

const calculateScores = (players) => players.map(player => ({
  ...player,
  score: [...new Set(player.cards)].reduce((sum, card) => sum + card, 0)
}));

const checkGameEnd = (game) => {
  if (game.status !== 'playing') return;

  const activePlayers = game.players.filter(p => p.status === 'active');
  const allBusted = game.players.every(p => p.status === 'busted');
  const allStood = game.players.every(p => p.status === 'stood' || p.status === 'busted');

  if (game.deck.length === 0 || allBusted || allStood) {
    const scoredPlayers = calculateScores(game.players);
    const winner = scoredPlayers.reduce((a, b) => a.score > b.score ? a : b);
    game.status = 'finished';
    io.to(game.id).emit('game-over', { players: scoredPlayers, winner });
  }
};

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Create game handler
  socket.on('create-game', (playerName) => {
    const gameId = uuidv4().substr(0, 5).toUpperCase();
    const newGame = {
      id: gameId,
      players: [{
        id: socket.id,
        name: playerName,
        cards: [],
        status: 'waiting',
        position: 0
      }],
      deck: createDeck(),
      discardPile: [],
      currentPlayer: 0,
      status: 'lobby'
    };
    
    games.set(gameId, newGame);
    socket.join(gameId);
    socket.emit('game-created', gameId);
    console.log(`Game ${gameId} created by ${playerName}`);
  });

  // Join game handler
  socket.on('join-game', (gameId, playerName) => {
    const game = games.get(gameId);
    if (!game) return socket.emit('error', 'Game not found');
    
    game.players.push({
      id: socket.id,
      name: playerName,
      cards: [],
      status: 'waiting',
      position: game.players.length
    });
    
    socket.join(gameId);
    io.to(gameId).emit('game-update', game);
    socket.emit('game-joined', gameId);
    console.log(`${playerName} joined game ${gameId}`);
  });

  // Start game handler
  socket.on('start-game', (gameId) => {
    const game = games.get(gameId);
    if (!game || game.status !== 'lobby') return;
    
    game.status = 'playing';
    game.players.forEach(p => p.status = 'active');
    io.to(gameId).emit('game-started', game);
    console.log(`Game ${gameId} started`);
  });

  // Gameplay handlers
  socket.on('flip-card', (gameId) => {
    const game = games.get(gameId);
    if (!game || game.status !== 'playing') return;

    const player = game.players[game.currentPlayer];
    if (player.id !== socket.id || player.status !== 'active') return;

    const card = game.deck.pop();
    game.discardPile.push(card);
    
    player.cards.includes(card) 
      ? player.status = 'busted'
      : player.cards.push(card);

    advanceTurn(game);
    io.to(gameId).emit('game-update', game);
    checkGameEnd(game);
  });

  socket.on('stand', (gameId) => {
    const game = games.get(gameId);
    if (!game || game.status !== 'playing') return;

    const player = game.players[game.currentPlayer];
    if (player.id !== socket.id || player.status !== 'active') return;

    player.status = 'stood';
    advanceTurn(game);
    io.to(gameId).emit('game-update', game);
    checkGameEnd(game);
  });

  // Helper functions
  const advanceTurn = (game) => {
    let nextPlayer = (game.currentPlayer + 1) % game.players.length;
    let attempts = 0;
    
    while (attempts < game.players.length) {
      if (game.players[nextPlayer].status === 'active') break;
      nextPlayer = (nextPlayer + 1) % game.players.length;
      attempts++;
    }
    
    game.currentPlayer = nextPlayer;
  };

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
  });
});

server.listen(3000, () => console.log('Server running on http://localhost:3000'));