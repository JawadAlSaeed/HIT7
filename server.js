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
        'https://hit7.click',
        'http://localhost:3000'
      ],
      methods: ['GET', 'POST'],
      credentials: true
    },
    transports: ['websocket', 'polling']
  });
};

// Middleware
// Build allowed connect-src list (include ws/wss for production)
const allowedConnect = ["'self'"];
if (process.env.PRODUCTION_URL) {
  allowedConnect.push(process.env.PRODUCTION_URL);
  // Allow websocket origin for production URL (replace http(s) with ws(s))
  try {
    const wsUrl = process.env.PRODUCTION_URL.replace(/^http/, 'ws');
    allowedConnect.push(wsUrl);
  } catch (e) {
    // ignore
  }
} else {
  allowedConnect.push('http://localhost:3000', 'ws://localhost:3000');
}

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      connectSrc: allowedConnect
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
    for (let i = 0; i < number; i++) {
      deck.push(number); // Add missing line to actually push the cards to the deck
    }
  }

  // Special cards = 20 cards (total 99 cards)
  const specialCards = [
    '2+', '6+', '10+',                  // 3 adder cards
    '2-', '6-', '10-',                  // 3 minus cards
    '2x',                               // 1 multiplier card (removed 3x)
    'SC', 'SC', 'SC',                   // 3 second chance cards
    'Freeze', 'Freeze', 'Freeze',       // 3 freeze cards
    'D3', 'D3', 'D3',                   // 3 draw three cards
    'RC', 'RC', 'RC',                   // 3 remove card cards
    'Select'                            // 1 select card
  ];
  deck.push(...specialCards);
  
  // Verify deck size
  if (deck.length !== 99) {
    console.error(`Invalid deck size: ${deck.length}. Expected 99 cards.`);
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

    // Use the module-level BASE_URL (calculated at startup) instead of hardcoding here

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

    // Update the flip-card event handler to handle Select as the last card
    socket.on('flip-card', gameId => {
      const game = games.get(gameId);
      if (!game || game.status !== 'playing') return;
  
      const player = game.players[game.currentPlayer];
      if (player.id !== socket.id || player.status !== 'active') return;
  
      // Handle deck replenishment - Special handling for the last card being Select
      if (game.deck.length === 1) {
        const lastCard = game.deck[0];
        
        // If the last card is Select, we need special handling
        if (lastCard === 'Select') {
          // Create a new full deck but don't assign it yet
          const newDeck = createDeck();
          
          // Pop the Select card from the current deck
          game.deck.pop();

          if (!player.specialCards.includes('Select')) {
            player.specialCards.push('Select');
          }

          // Update the game's deck with the new deck
          game.deck = newDeck;

          handleSelectCard(game, player, socket, io, [], newDeck);

          updatePlayerScore(player);
          checkGameStatus(game);
          io.to(gameId).emit('game-update', game);

          // No need for further processing - we'll handle the card selection in the select-card-choice event
          return;
        }
      }
      
      // Regular empty deck handling
      if (game.deck.length === 0) {
        console.log('Reshuffling deck...');
        game.deck = createDeck();
        game.discardPile = [];
        console.log(`Deck reshuffled. New size: ${game.deck.length}`);
      }
  
      const card = game.deck.pop();
      
      // Send game update to all clients to refresh deck count immediately
      io.to(gameId).emit('game-update', game);
      
      // Continue with regular card handling
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
      else if (card === 'D3' || card === 'Freeze' || card === 'RC') {  // Add RC here
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
      // Handle Select Card
      else if (card === 'Select') {
        if (player.drawThreeRemaining > 0) {
          // Store the special card as pending and continue with D3 sequence
          player.pendingSpecialCard = card;
          if (!player.specialCards.includes('Select')) {
            player.specialCards.push('Select');
          }
          player.drawThreeRemaining--;
          if (player.drawThreeRemaining === 0) {
            handlePendingSpecialCard(game, player, socket, io);
          }
        } else {
          if (!player.specialCards.includes('Select')) {
            player.specialCards.push('Select');
          }
          // Emit game-update so clients see Select in special cards before popup shows
          io.to(gameId).emit('game-update', game);
          handleSelectCard(game, player, socket, io);
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
        // Force the target to stand for the rest of the round
        target.status = 'stood';
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
      // Force the target to stand for the rest of the round
      target.status = 'stood';
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
        // Remove D3 from player's special cards
        player.specialCards = player.specialCards.filter(c => c !== 'D3');
        
        // Add D3 to discard pile
        game.discardPile.push('D3');
        
        // Set draw three remaining on target
        target.drawThreeRemaining = 3;
        
        // Set current player to target
        game.currentPlayer = game.players.findIndex(p => p.id === target.id);
        
        // Update game state
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

    // Add this with other socket events in handleSocketConnection
    socket.on('remove-card', (gameId, targetPlayerId, cardIndex, isSpecial) => {
      const game = games.get(gameId);
      if (!game || game.status !== 'playing') return;
      
      const player = game.players.find(p => p.id === socket.id);
      const target = game.players.find(p => p.id === targetPlayerId);
      
      // Check if both player and target exist and player has RC card
      if (!player || !target || !player.specialCards.includes('RC')) return;
      
      // Check if target is in active status - only allow removing cards from active players
      if (target.status !== 'active') {
        socket.emit('error', 'You can only remove cards from active players.');
        return;
      }
      
      // Validate card index bounds
      const cardArray = isSpecial ? target.specialCards : target.regularCards;
      if (cardIndex < 0 || cardIndex >= cardArray.length) {
        socket.emit('error', 'Invalid card index.');
        return;
      }
    
      // Remove RC from player's special cards
      player.specialCards = player.specialCards.filter(c => c !== 'RC');
      game.discardPile.push('RC');
    
      // Remove the selected card from target player
      if (isSpecial) {
        const removedCard = target.specialCards[cardIndex];
        target.specialCards.splice(cardIndex, 1);
        game.discardPile.push(removedCard); // Add removed card to discard pile
      } else {
        const removedCard = target.regularCards[cardIndex];
        target.regularCards.splice(cardIndex, 1);
        game.discardPile.push(removedCard); // Add removed card to discard pile
      }
    
      // Recalculate target's score after card removal
      updatePlayerScore(target);
      
      advanceTurn(game);
      checkGameStatus(game);
      io.to(gameId).emit('game-update', game);
    });

    // Update the select-card-from-pile event handling for better deck management
    socket.on('select-card-choice', (gameId, selectedCard) => {
      const game = games.get(gameId);
      if (!game || game.status !== 'playing') return;
      
      const player = game.players[game.currentPlayer];
      if (player.id !== socket.id || player.status !== 'active') return;

      player.specialCards = player.specialCards.filter(c => c !== 'Select');
    
      // Find and remove the selected card from the deck (with safety checks)
      let cardFound = false;
      const cardIndex = game.deck.findIndex(card => card === selectedCard);
      
      if (cardIndex !== -1) {
        // Card found in the regular deck
        game.deck.splice(cardIndex, 1);
        cardFound = true;
      } 
      
      // If card not found, it might mean we're in the special empty-deck scenario
      if (!cardFound) {
        // No need to remove the card, it will be in the new deck
        console.log(`Card ${selectedCard} selected from regenerated deck`);
      }
      
      // Process the selected card
      if (typeof selectedCard === 'number') {
        handleNumberCard(game, player, selectedCard, io);
        game.discardPile.push(selectedCard);
        
        if (player.status === 'busted') {
          player.drawThreeRemaining = 0;
          player.pendingSpecialCard = null;
          advanceTurn(game);
        }
        else if (player.regularCards.length >= MAX_REGULAR_CARDS) {
          player.status = 'stood';
          player.drawThreeRemaining = 0;
          player.pendingSpecialCard = null;
          advanceTurn(game);
        }
        else {
          advanceTurn(game);
        }
      }
      else if (selectedCard === 'D3' || selectedCard === 'Freeze' || selectedCard === 'RC') {
        // For special cards that need targeting, add to hand but don't advance turn yet
        player.specialCards.push(selectedCard);
        // The client will request targets immediately
        // Turn will advance when the special card effect is applied
      }
      else {
        // For other special cards, add to player's hand
        player.specialCards.push(selectedCard);
        advanceTurn(game);
      }
      
      updatePlayerScore(player);
      checkGameStatus(game);
      
      // Always emit game update to refresh the deck display
      io.to(gameId).emit('game-update', game);
    });

    // Game status checking
    const checkGameStatus = game => {
      // Check if round should end (all players are either busted, stood, or frozen)
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
            // Find highest scoring player among non-busted players
            const nonBustedPlayers = game.players.filter(p => p.status !== 'busted');
            const highestScore = Math.max(...nonBustedPlayers.map(p => p.totalScore));
            const winners = nonBustedPlayers.filter(p => p.totalScore === highestScore);

            // End game if any winner has 200+ points, otherwise start new round
            if (highestScore >= 200) {
              // In case of a tie, winner is the one who reached it first
              endGame(game, winners[0]);
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
        players: game.players.map(p => ({
          ...p,
          status: p.id === winner.id ? 'winner' : p.status
        })),
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

    // Inside handleSocketConnection function, add these new event handlers
    socket.on('request-draw-three-targets', (gameId) => {
      const game = games.get(gameId);
      if (!game || game.status !== 'playing') return;
    
      const player = game.players.find(p => p.id === socket.id);
      if (!player || player.status !== 'active') return;
    
      // Find valid targets (active players with room for cards)
      const targets = game.players.filter(p => 
        p.status === 'active' && // Only active players
        p.regularCards.length < MAX_REGULAR_CARDS // Must have room for cards
      );
      
      if (targets.length > 0) {
        socket.emit('select-draw-three-target', game.id, targets);
      }
    });
    
    socket.on('request-freeze-targets', (gameId) => {
      const game = games.get(gameId);
      if (!game || game.status !== 'playing') return;
    
      const player = game.players.find(p => p.id === socket.id);
      if (!player || player.status !== 'active') return;
    
      // Find valid targets (active players)
      const targets = game.players.filter(p => p.status === 'active');
      
      if (targets.length > 0) {
        socket.emit('select-freeze-target', game.id, targets);
      }
    });
    
    socket.on('request-remove-card-targets', (gameId) => {
      const game = games.get(gameId);
      if (!game || game.status !== 'playing') return;
    
      const player = game.players.find(p => p.id === socket.id);
      if (!player || player.status !== 'active') return;
    
      // NEW: Only send active players as potential targets
      const activePlayers = game.players.filter(p => p.status === 'active');
      
      // If there are no active players besides the current player, send all players
      // This prevents empty target list if player is the only active one
      const targets = activePlayers.length > 1 ? activePlayers : game.players;
      
      socket.emit('select-remove-card-target', game.id, targets);
    });
    
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
  drawThreeRemaining: 0,  // Track how many more cards player must draw
  pendingSpecialCard: null  // Track pending special cards during D3 sequences
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
    player.regularCards.push(card);
    // Add 15 bonus points if player reaches 7 cards in one turn
    if (player.regularCards.length === MAX_REGULAR_CARDS) {
      player.status = 'stood';
      player.totalScore += 15; // Add bonus points
      // Don't immediately end game, let round finish
      updatePlayerScore(player);
    }
  } else if (player.regularCards.includes(card)) {
    const scIndex = player.specialCards.indexOf('SC');
    if (scIndex > -1) {
      player.specialCards.splice(scIndex, 1);
      game.discardPile.push('SC');
      io.to(game.id).emit('play-sound', 'secondChanceSound');
    } else {
      player.status = 'busted';
      player.bustedCard = card;
      player.roundScore = 0;
      io.to(game.id).emit('play-sound', 'bustCardSound');
    }
  } else {
    player.regularCards.push(card);
    if (player.regularCards.length === MAX_REGULAR_CARDS) {
      player.status = 'stood';
      player.totalScore += 15; // Add bonus points
      // Don't immediately end game, let round finish
      updatePlayerScore(player);
    }
  }
};

const updatePlayerScore = player => {
  const base = [...new Set(player.regularCards)].reduce((a, b) => a + b, 0);
  const add = player.specialCards
    .filter(c => c.endsWith('+'))
    .reduce((a, c) => a + parseInt(c), 0);
  const minus = player.specialCards
    .filter(c => c.endsWith('-'))
    .reduce((a, c) => a + parseInt(c), 0);
  
  // Updated to handle only 2x multiplier
  let multiplier = 1;
  if (player.specialCards.includes('2x'))
    multiplier *= 2;

  player.roundScore = (base + add - minus) * multiplier;
};

// Add these new helper functions
const handlePendingSpecialCard = (game, player, socket, io) => {
  const card = player.pendingSpecialCard;
  player.pendingSpecialCard = null; // Clear the pending card
  if (card === 'Select') {
    handleSelectCard(game, player, socket, io);
    return;
  }
  handleSpecialCard(game, player, card, socket, io);
};

const handleSpecialCard = (game, player, card, socket, io) => {
  if (card === 'D3') {
    // Allow targeting any active player (including self) with room for cards
    const targets = game.players.filter(p => 
      p.status === 'active' && // Only active players
      p.regularCards.length < MAX_REGULAR_CARDS // Must have room for cards
    );
    
    if (targets.length > 0) {
      player.specialCards.push(card);
      socket.emit('select-draw-three-target', game.id, targets);
    } else {
      game.discardPile.push(card);
      advanceTurn(game);
    }
  } 
  else if (card === 'Freeze') {
    // Allow targeting any active player (including self)
    const targets = game.players.filter(p => 
      p.status === 'active'
    );
    if (targets.length > 0) {
      player.specialCards.push(card);
      socket.emit('select-freeze-target', game.id, targets);
    } else {
      game.discardPile.push(card);
      advanceTurn(game);
    }
  }
  else if (card === 'RC') {
    player.specialCards.push(card);
    socket.emit('select-remove-card-target', game.id, game.players);
  }
};

const handleSelectCard = (game, player, socket, io, deckForPopup = null, fullDeck = null) => {
  const popupDeck = Array.isArray(deckForPopup) ? deckForPopup : game.deck;
  socket.emit('select-card-from-pile', game.id, popupDeck, fullDeck);
  game.discardPile.push('Select');

  const playerId = player.id;
  const gameId = game.id;

  setTimeout(() => {
    const currentGame = games.get(gameId);
    if (currentGame && currentGame.status === 'playing') {
      const currentPlayer = currentGame.players[currentGame.currentPlayer];
      if (currentPlayer && currentPlayer.id === playerId) {
        currentPlayer.specialCards = currentPlayer.specialCards.filter(c => c !== 'Select');
        console.log(`Player ${playerId} timed out on Select Card, auto-advancing`);
        advanceTurn(currentGame);
        checkGameStatus(currentGame);
        io.to(gameId).emit('game-update', currentGame);
      }
    }
  }, 30000);
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
  res.sendFile(__dirname + '/public/index.html');
});

// Initialize Express app and create HTTP server
const server = http.createServer(app);

// Update port configuration for production
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.NODE_ENV === 'production' 
  ? 'https://hit7.click'
  : `http://localhost:${PORT}`;

// Initialize Socket.IO with the server
const io = createIoServer(server);

// Handle socket connections
handleSocketConnection(io);

// Start server
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV}`);
  console.log(`Base URL: ${BASE_URL}`);
});

// Cleanup empty games every minute
setInterval(() => {
  games.forEach((game, id) => {
    if (game.players.length === 0) games.delete(id);
  });
}, 60000);