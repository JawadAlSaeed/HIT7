const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const helmet = require('helmet');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Configuration
const createIoServer = (server, port) => {
  return new Server(server, {
    cors: {
      origin: [
        process.env.PRODUCTION_URL || 'https://your-app-name.herokuapp.com',
        ...(process.env.NODE_ENV === 'development' 
          ? [`http://localhost:${port}`] 
          : [])
      ],
      methods: ['GET', 'POST'],
      credentials: true
    },
    transports: ['websocket', 'polling']
  });
};

// Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      connectSrc: ["'self'", ...(process.env.PRODUCTION_URL 
        ? [process.env.PRODUCTION_URL] 
        : ['ws://localhost:3000'])]
    }
  }
}));
app.use(cors());
app.use(express.static('public'));

// Game state
const games = new Map();
const WINNING_SCORE = 200;
const MAX_REGULAR_CARDS = 7;

// Helper functions
const createDeck = () => {
  const deck = [];
  
  // Regular cards (1-12) = 78 cards
  for (let number = 1; number <= 12; number++) {
    for (let i = 0; i < number; i++) deck.push(number);
  }

  // Special cards = 15 cards (total 93)
  ['2+', '4+', '6+', '8+', '10+', '2x', 'SC', 'SC', 'SC', 'Freeze', 'Freeze', 'Freeze', 'D3', 'D3', 'D3'].forEach(c => deck.push(c));
  
  return shuffle(deck);
};

const shuffle = array => {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
};

// Game logic
const handleSocketConnection = (io) => {
  io.on('connection', socket => {
    console.log(`New connection: ${socket.id}`);

    socket.on('create-game', playerName => {
      if (!playerName || playerName.length < 3) {
        return socket.emit('error', 'Name must be at least 3 characters!');
      }

      const gameId = uuidv4().substr(0, 5).toUpperCase();
      const newGame = {
        id: gameId,
        hostId: socket.id,
        players: [createPlayer(socket.id, playerName)],
        deck: createDeck(),
        discardPile: [],
        currentPlayer: 0,
        status: 'lobby',
        roundNumber: 1
      };
      
      games.set(gameId, newGame);
      socket.join(gameId);
      socket.emit('game-created', gameId);
    });

    socket.on('join-game', (gameId, playerName) => {
      const game = games.get(gameId);
      if (!game) return socket.emit('error', `Game ${gameId} not found!`);

      game.players.push(createPlayer(socket.id, playerName));
      socket.join(gameId);
      io.to(gameId).emit('game-update', game);
      socket.emit('game-joined', gameId);
    });

    socket.on('start-game', gameId => {
      const game = games.get(gameId);
      if (!game || game.status !== 'lobby' || socket.id !== game.hostId) return;

      game.status = 'playing';
      game.players.forEach(p => p.status = 'active');
      io.to(gameId).emit('game-started', game);
    });

    socket.on('flip-card', gameId => {
      const game = games.get(gameId);
      if (!game || game.status !== 'playing') return;

      const player = game.players[game.currentPlayer];
      if (player.id !== socket.id || player.status !== 'active') return;

      // Handle deck replenishment
      if (game.deck.length === 0) {
          if (game.discardPile.length === 0) {
              // Complete reshuffle when both deck and discard are empty
              game.deck = createDeck();
              shuffle(game.deck);
          } else {
              // Normal discard pile reshuffle
              game.deck = shuffle([...game.discardPile]);
              game.discardPile = [];
          }
      }

      const card = game.deck.pop();
      
      // Don't add special cards to discard pile immediately
      if (typeof card === 'number') {
        game.discardPile.push(card);
      }

      // Handle number cards first
      if (typeof card === 'number') {
        handleNumberCard(game, player, card);
        
        // If player busted, clear draw three state and advance turn
        if (player.status === 'busted') {
          player.drawThreeRemaining = 0;
          advanceTurn(game);
        }
        // If player hit max cards
        else if (player.regularCards.length >= MAX_REGULAR_CARDS) {
          player.status = 'stood';
          player.drawThreeRemaining = 0;
          advanceTurn(game);
        } 
        // If player is in draw three state
        else if (player.drawThreeRemaining > 0) {
          player.drawThreeRemaining--;
          if (player.drawThreeRemaining === 0) {
            advanceTurn(game);
          }
        }
        // Normal turn advancement
        else {
          advanceTurn(game);
        }
        
        game.discardPile.push(card);
      }
      // Handle Draw Three card
      else if (card === 'D3') {
        player.specialCards.push(card);
        if (player.drawThreeRemaining === 0) {
          const targets = game.players.filter(p => 
            p.status === 'active' && 
            p.regularCards.length < MAX_REGULAR_CARDS
          );
          socket.emit('select-draw-three-target', game.id, targets);
        } else {
          player.drawThreeRemaining--;
          if (player.drawThreeRemaining === 0) {
            advanceTurn(game);
          }
          game.discardPile.push(card);
        }
        return;
      }
      // Handle Freeze card
      else if (card === 'Freeze') {
        player.specialCards.push(card);
        const targets = game.players.filter(p => p.status === 'active'); // Remove the self-exclusion
        socket.emit('select-freeze-target', game.id, targets);
        return;
      }
      // Handle other special cards
      else {
        player.specialCards.push(card);
        game.discardPile.push(card);
        if (player.drawThreeRemaining === 0) {
          advanceTurn(game);
        }
      }

      updatePlayerScore(player);
      checkGameStatus(game);
      io.to(gameId).emit('game-update', game);
    });

    socket.on('stand', gameId => {
      const game = games.get(gameId);
      if (!game || game.status !== 'playing') return;

      const player = game.players[game.currentPlayer];
      if (player.id !== socket.id || player.status !== 'active' || player.drawThreeRemaining > 0) return;

      player.status = 'stood';
      advanceTurn(game);
      checkGameStatus(game);
      io.to(gameId).emit('game-update', game);
    });

    socket.on('reset-game', gameId => {
      const game = games.get(gameId);
      if (game && socket.id === game.hostId) {
        games.delete(gameId);
        io.to(gameId).emit('game-reset');
      }
    });

    socket.on('freeze-player', (gameId, targetId) => {
      const game = games.get(gameId);
      if (!game || game.status !== 'playing') return;
      
      const player = game.players.find(p => p.id === socket.id);
      const target = game.players.find(p => p.id === targetId);
      
      if (player && target && player.specialCards.includes('Freeze')) {
        player.specialCards = player.specialCards.filter(c => c !== 'Freeze');
        target.status = 'frozen';
        game.discardPile.push('Freeze');
        
        // Advance turn after freezing
        advanceTurn(game);
        checkGameStatus(game);
        io.to(gameId).emit('game-update', game);
      }
    });

  // Update Freeze usage
  socket.on('use-freeze', (gameId, targetId) => {
    const game = games.get(gameId);
    const player = game.players.find(p => p.id === socket.id);
    const target = game.players.find(p => p.id === targetId);

    if (player && target && player.specialCards.includes('Freeze')) {
      player.specialCards = player.specialCards.filter(c => c !== 'Freeze');
      game.discardPile.push('Freeze'); // Add to discard when used
      target.status = 'frozen';
      checkGameStatus(game);
      io.to(gameId).emit('game-update', game);
    }
  });

    socket.on('draw-three-select', (gameId, targetId) => {
      const game = games.get(gameId);
      if (!game || game.status !== 'playing') return;
      
      const player = game.players.find(p => p.id === socket.id);
      const target = game.players.find(p => p.id === targetId);
      
      if (player && target && player.specialCards.includes('D3')) {
        player.specialCards = player.specialCards.filter(c => c !== 'D3');
        
        // Calculate how many cards the target can actually draw
        const remainingSpace = MAX_REGULAR_CARDS - target.regularCards.length;
        target.drawThreeRemaining = Math.min(3, remainingSpace);
        
        game.discardPile.push('D3');
        
        // Make target the current player
        game.currentPlayer = game.players.findIndex(p => p.id === target.id);
        
        io.to(gameId).emit('game-update', game);
      }
    });

    // Game status checking
    const checkGameStatus = game => {
      // Check for instant winner
      const potentialWinner = game.players.find(p => 
        p.status === 'stood' && p.totalScore + p.roundScore >= WINNING_SCORE
      );

      if (potentialWinner) {
        potentialWinner.totalScore += potentialWinner.roundScore;
        endGame(game, potentialWinner);
        return;
      }

      const activePlayers = game.players.filter(p => p.status === 'active');
      const allBusted = game.players.every(p => p.status === 'busted');

      if (activePlayers.length === 0 || game.deck.length === 0) {
        io.to(game.id).emit('round-summary', {
          players: game.players,
          allBusted: allBusted
        });

        setTimeout(() => {
          game.players.forEach(player => {
            if (player.status !== 'busted') {
              player.totalScore += player.roundScore;
            }
          });

          if (allBusted) {
            startNewRound(game);
          } else {
            checkFinalWinner(game);
          }

          io.to(game.id).emit('new-round', game);
        }, 5000);
      }
    };

    const endGame = (game, winner) => {
      game.status = 'finished';
      io.to(game.id).emit('game-over', {
        players: game.players,
        winner: winner
      });
    };

    const checkFinalWinner = game => {
      const winner = game.players.reduce((max, p) => 
        p.totalScore > max.totalScore ? p : max, { totalScore: -1 });

      if (winner.totalScore >= WINNING_SCORE) {
        endGame(game, winner);
      } else {
        startNewRound(game);
      }
    };

    const startNewRound = game => {
      game.roundNumber++;
      // Only reset player states, not the deck/discard
      game.players.forEach(player => {
          player.regularCards = [];
          player.specialCards = [];
          player.status = 'active';
          player.roundScore = 0;
          player.bustedCard = null;
      });
      game.currentPlayer = 0;
    };
  });
};

// Helper functions
const createPlayer = (id, name) => ({
  id,
  name,
  regularCards: [],
  specialCards: [],
  status: 'waiting',
  roundScore: 0,
  totalScore: 0,
  bustedCard: null,
  drawThreeRemaining: 0  // Add this property
});

const advanceTurn = game => {
  let nextPlayer = game.currentPlayer;
  let attempts = 0;
  
  do {
    nextPlayer = (nextPlayer + 1) % game.players.length;
    attempts++;
  } while (
    attempts <= game.players.length && 
    game.players[nextPlayer].status !== 'active'
  );
  
  game.currentPlayer = nextPlayer;
};

const handleNumberCard = (game, player, card) => {
  if (player.regularCards.includes(card)) {
    const scIndex = player.specialCards.indexOf('SC');
    if (scIndex > -1) {
      player.specialCards.splice(scIndex, 1);
      game.discardPile.push('SC'); // Only add to discard when used
    } else {
      player.status = 'busted';
      player.bustedCard = card;
      player.roundScore = 0;
    }
  } else {
    player.regularCards.push(card);
    if (player.regularCards.length >= MAX_REGULAR_CARDS) {
      player.status = 'stood';
    }
  }
};

const updatePlayerScore = player => {
  const base = [...new Set(player.regularCards)].reduce((a, b) => a + b, 0);
  const add = player.specialCards
    .filter(c => c.endsWith('+'))
    .reduce((a, c) => a + parseInt(c), 0);
  const multiply = player.specialCards
    .filter(c => c.endsWith('x'))
    .reduce((a, c) => a * parseInt(c), 1);

  player.roundScore = (base + add) * (multiply || 1);
};

// Server startup
const startServer = (initialPort) => {
  const server = http.createServer(app);
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`Port ${initialPort} is busy, trying ${initialPort + 1}...`);
      startServer(initialPort + 1);
    } else {
      console.error('Server error:', err);
    }
  });

  server.listen(initialPort, () => {
    console.log(`Server running on port ${initialPort}`);
  });

  // Attach Socket.IO to this server instance
  const io = createIoServer(server, initialPort);

  // Move the Socket.IO connection handling here
  handleSocketConnection(io);
};

// Start server with initial port
const PORT = process.env.PORT || 3000;
startServer(PORT);

// Cleanup empty games
setInterval(() => {
  games.forEach((game, id) => {
    if (game.players.length === 0) games.delete(id);
  });
}, 60000);