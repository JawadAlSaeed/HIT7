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
  
  // Zero card (1 card)
  deck.push(0);
  
  // Regular cards (1-12) = 78 cards
  for (let number = 1; number <= 12; number++) {
    for (let i = 0; i < number; i++) deck.push(number);
  }

  // Special cards = 15 cards (total 94)
  const specialCards = [
    '2+', '4+', '6+', '8+', '10+',  // 5 adder cards
    '2x',                            // 1 multiplier card
    'SC', 'SC', 'SC',               // 3 second chance cards
    'Freeze', 'Freeze', 'Freeze',    // 3 freeze cards
    'D3', 'D3', 'D3'                // 3 draw three cards
  ];
  deck.push(...specialCards);
  
  // Verify deck size
  if (deck.length !== 94) {
    console.error(`Invalid deck size: ${deck.length}. Expected 94 cards.`);
  }
  
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
        // Log the state before reshuffling
        console.log(`Before reshuffle - Discard pile size: ${game.discardPile.length}`);
        
        if (game.discardPile.length === 0) {
          // If both deck and discard are empty, create a new deck
          game.deck = createDeck();
        } else {
          // Move ALL cards from discard pile back to deck and shuffle
          game.deck = shuffle([...game.discardPile]);
          game.discardPile = [];
        }
        
        // Log the state after reshuffling
        console.log(`After reshuffle - New deck size: ${game.deck.length}`);
        
        // Notify clients about the reshuffle
        io.to(gameId).emit('game-update', game);
      }

      const card = game.deck.pop();
      
      // If player is under draw three effect, any card counts towards the three cards
      if (player.drawThreeRemaining > 0) {
        if (typeof card === 'number') {
          handleNumberCard(game, player, card);
          game.discardPile.push(card);
          
          if (player.status === 'busted') {
            player.drawThreeRemaining = 0;
            advanceTurn(game);
          }
          else if (player.regularCards.length >= MAX_REGULAR_CARDS) {
            player.status = 'stood';
            player.drawThreeRemaining = 0;
            advanceTurn(game);
          }
        } else {
          // Special cards count towards draw three but are kept
          player.specialCards.push(card);
        }
        
        // Decrease remaining draws and check if done
        player.drawThreeRemaining--;
        if (player.drawThreeRemaining === 0) {
          // If player has pending special cards (Freeze/D3), let them use them
          if (player.specialCards.some(c => c === 'Freeze' || c === 'D3')) {
            // Don't advance turn, let player use their special cards
            handlePendingSpecialCards(socket, game, player);
          } else {
            advanceTurn(game);
          }
        }
      } else {
        // Normal card handling when not under draw three effect
        if (typeof card === 'number') {
          handleNumberCard(game, player, card);
          game.discardPile.push(card);
          
          if (player.status === 'busted' || player.regularCards.length >= MAX_REGULAR_CARDS) {
            advanceTurn(game);
          }
        }
        else if (card === 'D3') {
          player.specialCards.push(card);
          const targets = game.players.filter(p => 
            p.status === 'active' && 
            p.regularCards.length < MAX_REGULAR_CARDS
          );
          socket.emit('select-draw-three-target', game.id, targets);
        }
        else if (card === 'Freeze') {
          player.specialCards.push(card);
          const targets = game.players.filter(p => p.status === 'active');
          socket.emit('select-freeze-target', game.id, targets);
        }
        else {
          player.specialCards.push(card);
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
        // Add Freeze to discard only when used
        game.discardPile.push('Freeze');
        
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
        game.discardPile.push('D3');
        
        const remainingSpace = MAX_REGULAR_CARDS - target.regularCards.length;
        target.drawThreeRemaining = Math.min(3, remainingSpace);
        
        // Change turn to target player
        game.currentPlayer = game.players.findIndex(p => p.id === target.id);
        
        // If the original player has more special cards to use, don't advance turn yet
        if (!player.specialCards.some(c => c === 'Freeze' || c === 'D3')) {
          advanceTurn(game);
        }
        
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

      // Check if round should end (all players are either busted or stood)
      const activePlayers = game.players.filter(p => p.status === 'active');
      const allBusted = game.players.every(p => p.status === 'busted');

      if (activePlayers.length === 0) {
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
      // Reset player states, but keep total scores
      game.players.forEach(player => {
          player.regularCards = [];
          player.specialCards = [];
          player.status = 'active';
          player.roundScore = 0;
          player.bustedCard = null;
          player.drawThreeRemaining = 0;
      });
      
      // Set starting player based on round number (cycling through players)
      game.currentPlayer = (game.roundNumber - 1) % game.players.length;
      game.status = 'playing'; // Ensure game status is set to playing
      
      // Immediately emit game update to ensure clients get the new state
      io.to(game.id).emit('game-update', game);
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
  const playerCount = game.players.length;
  
  do {
    nextPlayer = (nextPlayer + 1) % playerCount;
    attempts++;
    
    // If we've checked all players and found no active ones, break
    if (attempts >= playerCount) {
      nextPlayer = game.currentPlayer; // Keep current player if no active players found
      break;
    }
  } while (game.players[nextPlayer].status !== 'active');
  
  game.currentPlayer = nextPlayer;
};

const handleNumberCard = (game, player, card) => {
  if (card === 0) {
    // Zero card can't cause a bust and can be held multiple times
    player.regularCards.push(card);
    // Add 15 bonus points if player reaches 7 cards in one turn
    if (player.regularCards.length === MAX_REGULAR_CARDS) {
      player.status = 'stood';
      player.totalScore += 15; // Add bonus points
    }
  } else if (player.regularCards.includes(card)) {
    const scIndex = player.specialCards.indexOf('SC');
    if (scIndex > -1) {
      player.specialCards.splice(scIndex, 1);
      game.discardPile.push('SC'); // Add SC to discard only when used
    } else {
      player.status = 'busted';
      player.bustedCard = card;
      player.roundScore = 0;
    }
  } else {
    player.regularCards.push(card);
    // Add 15 bonus points if player reaches 7 cards in one turn
    if (player.regularCards.length === MAX_REGULAR_CARDS) {
      player.status = 'stood';
      player.totalScore += 15; // Add bonus points
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

// Add this new helper function
const handlePendingSpecialCards = (socket, game, player) => {
  // First check for Freeze cards
  if (player.specialCards.includes('Freeze')) {
    const targets = game.players.filter(p => p.status === 'active');
    socket.emit('select-freeze-target', game.id, targets);
  }
  // Then check for Draw Three cards
  else if (player.specialCards.includes('D3')) {
    const targets = game.players.filter(p => 
      p.status === 'active' && 
      p.regularCards.length < MAX_REGULAR_CARDS
    );
    socket.emit('select-draw-three-target', game.id, targets);
  }
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