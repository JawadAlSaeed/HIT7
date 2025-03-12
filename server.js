const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const helmet = require('helmet');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Configuration
const createIoServer = (server) => {
  return new Server(server, {
    cors: {
      origin: [
        'https://hit7.xyz',
        'http://localhost:3000'
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

    const BASE_URL = process.env.NODE_ENV === 'production' 
      ? 'https://hit7.xyz'
      : 'http://localhost:3000';

    // Update game creation to include full URL
    socket.on('create-game', playerName => {
      if (!playerName || playerName.length < 3) {
        return socket.emit('error', 'Name must be at least 3 characters!');
      }

      // Leave any existing game room first
      if (socket.rooms) {
        [...socket.rooms].forEach(room => {
          if (room !== socket.id) {
            socket.leave(room);
          }
        });
      }

      const gameId = uuidv4().substr(0, 5).toUpperCase();
      const gameUrl = `${BASE_URL}/join/${gameId}`;
      const newGame = {
        id: gameId,
        url: gameUrl,
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
      socket.emit('game-created', { gameId, gameUrl });
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

      // Handle deck replenishment - FIXED
      if (game.deck.length === 0) {
        console.log('Reshuffling deck...');
        
        // Simply create a new deck instead of combining with discard
        game.deck = createDeck();
        
        // Clear the discard pile
        
        game.discardPile = [];
        
        console.log(`Deck reshuffled. New size: ${game.deck.length}`);
        io.to(gameId).emit('game-update', game);
      }

      const card = game.deck.pop();
      
      // Handle number cards
      if (typeof card === 'number') {
          handleNumberCard(game, player, card, io);
          game.discardPile.push(card);
          
          if (player.status === 'busted') {
              player.drawThreeRemaining = 0;
              player.pendingSpecialCard = null; // Clear any pending special cards
              advanceTurn(game);
          }
          else if (player.regularCards.length >= MAX_REGULAR_CARDS) { // Changed: Only count regular cards
              player.status = 'stood';
              player.drawThreeRemaining = 0;
              player.pendingSpecialCard = null; // Clear any pending special cards
              advanceTurn(game);
          } 
          else if (player.drawThreeRemaining > 0) {
              player.drawThreeRemaining--;
              if (player.drawThreeRemaining === 0 && player.pendingSpecialCard) {
                // Handle pending special card after D3 sequence completes
                handlePendingSpecialCard(game, player, socket, io);
              } else if (player.drawThreeRemaining === 0) {
                advanceTurn(game);
              }
          }
          else {
              advanceTurn(game);
          }
      }
      // Handle special cards - don't add to discard pile until they're used
      else if (card === 'D3' || card === 'Freeze') {
        if (player.drawThreeRemaining > 0) {
          // Store the special card as pending and continue with D3 sequence
          player.pendingSpecialCard = card;
          player.drawThreeRemaining--;
          if (player.drawThreeRemaining === 0) {
            handlePendingSpecialCard(game, player, socket, io);
          }
        } else {
          handleSpecialCard(game, player, card, socket, io);
        }
      }
      // Handle other special cards
      else {
        player.specialCards.push(card);
        if (player.drawThreeRemaining > 0) {
          player.drawThreeRemaining--;
          if (player.drawThreeRemaining === 0) {
            advanceTurn(game);
          }
        } else {
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
      io.to(gameId).emit('play-sound', 'standSound'); // Broadcast stand sound
      advanceTurn(game);
      checkGameStatus(game);
      io.to(gameId).emit('game-update', game);
    });

    // Update reset-game event handling
    socket.on('reset-game', gameId => {
      const game = games.get(gameId);
      if (game && socket.id === game.hostId) {
        // Reset the game state but keep players
        const resetGame = {
          ...game,
          deck: createDeck(),
          discardPile: [],
          currentPlayer: 0,
          status: 'playing',
          roundNumber: 1
        };

        // Reset all players
        resetGame.players = resetGame.players.map(player => ({
          ...player,
          regularCards: [],
          specialCards: [],
          status: 'active',
          roundScore: 0,
          totalScore: 0,
          bustedCard: null,
          drawThreeRemaining: 0,
          pendingSpecialCard: null
        }));

        // Update the game in the map
        games.set(gameId, resetGame);

        // Notify all players about the reset
        io.to(gameId).emit('game-reset-with-players', resetGame);
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
        
        const remainingSpace = MAX_REGULAR_CARDS - (target.regularCards.length + target.specialCards.length);
        target.drawThreeRemaining = Math.min(3, remainingSpace);
        
        // Add Draw Three to discard only when used
        game.discardPile.push('D3');
        
        game.currentPlayer = game.players.findIndex(p => p.id === target.id);
        
        io.to(gameId).emit('game-update', game);
      }
    });

    // Add rematch handling
    socket.on('request-rematch', (gameId) => {
      const game = games.get(gameId);
      if (!game) return;

      // Reset the game state but keep players
      const rematchGame = {
          ...game,
          deck: createDeck(),
          discardPile: [],
          currentPlayer: 0,
          status: 'playing',
          roundNumber: 1
      };

      // Reset all players
      rematchGame.players = rematchGame.players.map(player => ({
          ...player,
          regularCards: [],
          specialCards: [],
          status: 'active',
          roundScore: 0,
          totalScore: 0,
          bustedCard: null,
          drawThreeRemaining: 0
      }));

      // Update the game in the map
      games.set(gameId, rematchGame);

      // Notify all players about the rematch
      io.to(gameId).emit('rematch-started', rematchGame);
      io.to(gameId).emit('game-update', rematchGame);
    });

    // Game status checking
    const checkGameStatus = game => {
      // Remove the instant winner check as we want the round to continue
      
      // Check if round should end (all players are either busted or stood)
      const activePlayers = game.players.filter(p => p.status === 'active');
      const allBusted = game.players.every(p => p.status === 'busted');

      if (activePlayers.length === 0) {
        io.to(game.id).emit('round-summary', {
          players: game.players,
          allBusted: allBusted
        });

        setTimeout(() => {
          // Update total scores for non-busted players
          game.players.forEach(player => {
            if (player.status !== 'busted') {
              player.totalScore += player.roundScore;
            }
          });

          if (allBusted) {
            startNewRound(game);
          } else {
            // Find the winner among stood players
            const stoodPlayers = game.players.filter(p => p.status === 'stood');
            const winner = stoodPlayers.reduce((max, p) => 
              p.totalScore > max.totalScore ? p : max
            , { totalScore: -1 });

            // End game if winner has 200+ points, otherwise start new round
            if (winner.totalScore >= 200) {
              endGame(game, winner);
            } else {
              startNewRound(game);
            }
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

    // Inside handleSocketConnection function, add these socket events
    socket.on('play-sound', (gameId, soundId) => {
      // Broadcast sound to all players in the game except sender
      socket.to(gameId).emit('play-sound', soundId);
    });
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
  drawThreeRemaining: 0,  // Add this property
  pendingSpecialCard: null  // Add this to track pending special cards
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

const handleNumberCard = (game, player, card, io) => {
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
      io.to(game.id).emit('play-sound', 'secondChanceSound');
    } else {
      player.status = 'busted';
      player.bustedCard = card;
      player.roundScore = 0;
      io.to(game.id).emit('play-sound', 'bustCardSound');
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

// Add these new helper functions
const handlePendingSpecialCard = (game, player, socket, io) => {
  const card = player.pendingSpecialCard;
  player.pendingSpecialCard = null; // Clear the pending card
  handleSpecialCard(game, player, card, socket, io);
};

const handleSpecialCard = (game, player, card, socket, io) => {
  player.specialCards.push(card);
  
  if (card === 'D3') {
    const targets = game.players.filter(p => 
      p.status === 'active' && 
      p.regularCards.length + p.specialCards.length < MAX_REGULAR_CARDS
    );
    socket.emit('select-draw-three-target', game.id, targets);
  } 
  else if (card === 'Freeze') {
    const targets = game.players.filter(p => p.status === 'active');
    socket.emit('select-freeze-target', game.id, targets);
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

// Move this BEFORE the catch-all route above
app.get('/join/:gameId', (req, res) => {
  const gameId = req.params.gameId;
  const game = games.get(gameId);
  
  if (!game) {
    res.redirect('/?error=game-not-found');
    return;
  }
  
  res.sendFile(__dirname + '/public/index.html');
});

// Update route handling to serve index.html for all routes
app.get('*', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');Heroku
});
rocess.env.NODE_ENV === 'production' 
// Start server with initial port  ? 'https://hit7-64b15d0a58f7.herokuapp.com'  // Update this with your Heroku URL
const PORT = process.env.PORT || 3000;3000';
startServer(PORT);

// Cleanup empty games
setInterval(() => {st server = http.createServer(app);
  games.forEach((game, id) => {isten(port, () => {



}, 60000);  });    if (game.players.length === 0) games.delete(id);    console.log(`Server running on port ${port}`);
    console.log(`Environment: ${process.env.NODE_ENV}`);
    console.log(`Base URL: ${BASE_URL}`);
  });

  // Attach Socket.IO to this server instance
  const io = createIoServer(server);
  handleSocketConnection(io);
};

// Update port configuration for GitHub deployment
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.NODE_ENV === 'production' 
  ? 'https://' + process.env.HEROKU_APP_NAME + '.herokuapp.com'
  : 'http://localhost:3000';

startServer(PORT);

// Cleanup empty games
setInterval(() => {
  games.forEach((game, id) => {
    if (game.players.length === 0) games.delete(id);
  });
}, 60000);