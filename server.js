const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

// 1. Create server
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 2. Serve static files
app.use(express.static('public'));

// 3. Store active games
const games = new Map();

// 4. Handle connections
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // 5. Create game
  socket.on('create-game', (playerName) => {
    const gameId = Math.random().toString(36).substr(2, 5).toUpperCase();
    games.set(gameId, {
      players: [{ id: socket.id, name: playerName }],
      status: 'waiting'
    });
    socket.join(gameId);
    socket.emit('game-created', gameId);
  });

  // 6. Join game
  socket.on('join-game', (gameId, playerName) => {
    const game = games.get(gameId);
    if (!game) return socket.emit('error', 'Game not found');
    
    game.players.push({ id: socket.id, name: playerName });
    socket.join(gameId);
    io.to(gameId).emit('players-updated', game.players);
  });
});

// 7. Start server
server.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});