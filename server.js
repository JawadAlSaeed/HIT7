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
const MAX_PLAYERS = 6;
const MIN_NAME_LENGTH = 3;
const MAX_NAME_LENGTH = 20;
const SEVEN_CARD_BONUS = 15;

// Every non-number card the deck can contain, used to validate anything a client
// claims to have picked out of the deck.
const SPECIAL_CARD_TYPES = [
  '2+', '4+', '6+', '8+', '10+',
  '2-', '4-', '6-', '8-', '10-',
  '2÷', '2x',
  'SC', 'Freeze', 'D3', 'RC', 'ST', 'Swap', 'Select'
];

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

  // Special cards = 29 cards (total 108 cards)
  const specialCards = [
    '2+', '4+', '6+', '8+', '10+',      // 5 adder cards
    '2-', '4-', '6-', '8-', '10-',      // 5 minus cards
    '2÷',                               // 1 divide card
    '2x',                               // 1 multiplier card
    'SC', 'SC', 'SC',                   // 3 second chance cards
    'Freeze', 'Freeze', 'Freeze',       // 3 freeze cards
    'D3', 'D3', 'D3',                   // 3 draw three cards
    'RC', 'RC', 'RC',                   // 3 remove card cards
    'ST', 'ST',                         // 2 steal card cards
    'Swap', 'Swap',                     // 2 swap cards
    'Select'                            // 1 select card
  ];
  deck.push(...specialCards);
  
  // Verify deck size
  if (deck.length !== 108) {
    console.error(`Invalid deck size: ${deck.length}. Expected 108 cards.`);
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

const isValidCard = card =>
  (typeof card === 'number' && Number.isInteger(card) && card >= 0 && card <= 12) ||
  SPECIAL_CARD_TYPES.includes(card);

const sanitizeName = name =>
  typeof name === 'string' ? name.trim().replace(/\s+/g, ' ').slice(0, MAX_NAME_LENGTH) : '';

// Clients render the remaining-pile display straight from the deck, so they need to
// know what is left in it - but never the draw order. Sorting the copy that goes out
// over a broadcast keeps that display working while hiding the next card.
const sortDeckForDisplay = deck => [...deck].sort((a, b) => {
  const aIsNumber = typeof a === 'number';
  const bIsNumber = typeof b === 'number';
  if (aIsNumber && bIsNumber) return a - b;
  if (aIsNumber) return -1;
  if (bIsNumber) return 1;
  return String(a).localeCompare(String(b));
});

const publicGame = game => ({ ...game, deck: sortDeckForDisplay(game.deck) });

// A hand can legitimately hold two copies of the same special card, because Steal and
// Swap move them between players. Playing one card must only ever discard that one.
const removeOneCard = (cards, card) => {
  const index = cards.indexOf(card);
  if (index === -1) return false;
  cards.splice(index, 1);
  return true;
};

const isCurrentTurn = (game, socketId) =>
  game.players[game.currentPlayer] && game.players[game.currentPlayer].id === socketId;

// Swap only moves cards that score points. Targeting cards (Freeze, D3, RC, ST,
// Swap, Select) are played the moment they are drawn, so a hand has no way to use
// one that arrives later.
const isSwappableSpecial = card =>
  card === 'SC' || card === '2x' || card === '2÷' ||
  card.endsWith('+') || card.endsWith('-');

const countSwappableCards = player =>
  player.regularCards.length + player.specialCards.filter(isSwappableSpecial).length;

// Game logic
const handleSocketConnection = (io) => {
  io.on('connection', socket => {
    console.log(`New connection: ${socket.id}`);

    // Use the module-level BASE_URL (calculated at startup) instead of hardcoding here

    // Update game creation to include full URL
    socket.on('create-game', playerName => {
      const name = sanitizeName(playerName);
      if (name.length < MIN_NAME_LENGTH) {
        return socket.emit('error', `Name must be at least ${MIN_NAME_LENGTH} characters!`);
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
        players: [createPlayer(socket.id, name)],
        deck: createDeck(),
        discardPile: [],
        currentPlayer: 0,
        status: 'lobby',
        roundNumber: 1,
        lastCardDrawn: null,
        roundEnding: false
      };
      
      games.set(gameId, newGame);
      socket.join(gameId);
      socket.emit('game-created', { gameId, gameUrl });
    });

    socket.on('join-game', (gameId, playerName) => {
      const game = games.get(gameId);
      if (!game) return socket.emit('error', `Game ${gameId} not found!`);

      const name = sanitizeName(playerName);
      if (name.length < MIN_NAME_LENGTH) {
        return socket.emit('error', `Name must be at least ${MIN_NAME_LENGTH} characters!`);
      }

      // Joining is lobby-only: a player added mid-round would sit at 'waiting' forever,
      // since only startNewRound flips players back to 'active'.
      if (game.status !== 'lobby') {
        return socket.emit('error', 'That game has already started!');
      }

      if (game.players.length >= MAX_PLAYERS) {
        return socket.emit('error', `Game is full (${MAX_PLAYERS} players max)!`);
      }

      if (game.players.some(p => p.id === socket.id)) {
        return socket.emit('error', 'You are already in this game!');
      }

      game.players.push(createPlayer(socket.id, name));
      socket.join(gameId);
      io.to(gameId).emit('game-update', publicGame(game));
      socket.emit('game-joined', gameId);
    });

    socket.on('start-game', gameId => {
      const game = games.get(gameId);
      if (!game || game.status !== 'lobby' || socket.id !== game.hostId) return;

      game.status = 'playing';
      game.players.forEach(p => p.status = 'active');
      io.to(gameId).emit('game-started', publicGame(game));
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
          // Create a new full deck for the popup only
          const fullDeck = createDeck();
          
          // Pop the Select card from the current deck
          game.deck.pop();
          
          // Track the last card drawn
          game.lastCardDrawn = 'Select';

          player.specialCards.push('Select');

          handleSelectCard(game, player, socket, io, [], fullDeck);

          updatePlayerScore(player);
          checkGameStatus(game, io);
          io.to(gameId).emit('game-update', publicGame(game));

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
      
      // Track the last card drawn
      game.lastCardDrawn = card;
      
      // Send game update to all clients to refresh deck count immediately
      io.to(gameId).emit('game-update', publicGame(game));

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
      else if (card === 'D3' || card === 'Freeze' || card === 'RC' || card === 'ST' || card === 'Swap') {
        if (player.drawThreeRemaining > 0) {
          // Add the special card to hand and continue with D3 sequence
          player.specialCards.push(card);
          player.pendingSpecialCard = card;
          player.drawThreeRemaining--;
          if (player.drawThreeRemaining === 0) {
            handlePendingSpecialCard(game, player, socket, io);
          }
        } else {
          player.specialCards.push(card);
          handleSpecialCard(game, player, card, socket, io);
        }
      }
      // Handle Select Card
      else if (card === 'Select') {
        player.specialCards.push(card);
        if (player.drawThreeRemaining > 0) {
          // Store the special card as pending and continue with D3 sequence
          player.pendingSpecialCard = card;
          player.drawThreeRemaining--;
          if (player.drawThreeRemaining === 0) {
            handlePendingSpecialCard(game, player, socket, io);
          }
        } else {
          // Emit game-update so clients see Select in special cards before popup shows
          io.to(gameId).emit('game-update', publicGame(game));
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
      checkGameStatus(game, io);
      io.to(gameId).emit('game-update', publicGame(game));
    });

    socket.on('stand', gameId => {
      const game = games.get(gameId);
      if (!game || game.status !== 'playing') return;

      const player = game.players[game.currentPlayer];
      if (player.id !== socket.id || player.status !== 'active' || player.drawThreeRemaining > 0) return;

      player.status = 'stood';
      io.to(gameId).emit('play-sound', 'standSound'); // Broadcast stand sound
      advanceTurn(game);
      checkGameStatus(game, io);
      io.to(gameId).emit('game-update', publicGame(game));
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
          roundNumber: 1,
          lastCardDrawn: null,
          roundEnding: false
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
        io.to(gameId).emit('game-reset-with-players', publicGame(resetGame));
      }
    });

    socket.on('freeze-player', (gameId, targetId) => {
      const game = games.get(gameId);
      if (!game || game.status !== 'playing') return;

      // Targeting cards are always played on the holder's own turn, so anything
      // arriving out of turn is a client that is not playing by the rules.
      if (!isCurrentTurn(game, socket.id)) return;

      const player = game.players.find(p => p.id === socket.id);
      const target = game.players.find(p => p.id === targetId);

      if (!player || !target || !player.specialCards.includes('Freeze')) return;
      if (target.status !== 'active') {
        return socket.emit('error', 'You can only freeze active players.');
      }

      removeOneCard(player.specialCards, 'Freeze');
      // Force the target to stand for the rest of the round
      target.status = 'stood';
      // Add Freeze to discard only when used
      game.discardPile.push('Freeze');

      advanceTurn(game);
      checkGameStatus(game, io);
      io.to(gameId).emit('game-update', publicGame(game));
    });

    socket.on('draw-three-select', (gameId, targetId) => {
      const game = games.get(gameId);
      if (!game || game.status !== 'playing') return;

      if (!isCurrentTurn(game, socket.id)) return;

      const player = game.players.find(p => p.id === socket.id);
      const target = game.players.find(p => p.id === targetId);

      if (!player || !target || !player.specialCards.includes('D3')) return;

      // The turn is handed to the target, so they have to be able to take it -
      // otherwise the round stalls on a player who can never flip a card.
      if (target.status !== 'active' || target.regularCards.length >= MAX_REGULAR_CARDS) {
        return socket.emit('error', 'That player cannot draw three cards.');
      }

      // Remove D3 from player's special cards
      removeOneCard(player.specialCards, 'D3');

      // Add D3 to discard pile
      game.discardPile.push('D3');

      // Set draw three remaining on target
      target.drawThreeRemaining = 3;

      // Set current player to target
      game.currentPlayer = game.players.findIndex(p => p.id === target.id);

      // Update game state
      io.to(gameId).emit('game-update', publicGame(game));
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
          roundNumber: 1,
          lastCardDrawn: null,
          roundEnding: false
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
          drawThreeRemaining: 0,
          pendingSpecialCard: null
      }));

      // Update the game in the map
      games.set(gameId, rematchGame);

      // Notify all players about the rematch
      io.to(gameId).emit('rematch-started', publicGame(rematchGame));
      io.to(gameId).emit('game-update', publicGame(rematchGame));
    });

    // Add this with other socket events in handleSocketConnection
    socket.on('remove-card', (gameId, targetPlayerId, cardIndex, isSpecial) => {
      const game = games.get(gameId);
      if (!game || game.status !== 'playing') return;

      if (!isCurrentTurn(game, socket.id)) return;

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
      if (!Number.isInteger(cardIndex) || cardIndex < 0 || cardIndex >= cardArray.length) {
        socket.emit('error', 'Invalid card index.');
        return;
      }

      // Disallow removing the remove-card (RC) itself
      if (isSpecial && target.specialCards[cardIndex] === 'RC') {
        socket.emit('error', 'You cannot remove a Remove Card.');
        return;
      }

      // Take the chosen card out first: when a player aims RC at their own hand,
      // discarding the RC first would shift every index after it.
      const removedCard = cardArray.splice(cardIndex, 1)[0];
      game.discardPile.push(removedCard);

      // Remove RC from player's special cards
      removeOneCard(player.specialCards, 'RC');
      game.discardPile.push('RC');

      // Recalculate target's score after card removal
      updatePlayerScore(target);

      advanceTurn(game);
      checkGameStatus(game, io);
      io.to(gameId).emit('game-update', publicGame(game));
    });

    socket.on('steal-card', (gameId, targetPlayerId, cardIndex, isSpecial) => {
      const game = games.get(gameId);
      if (!game || game.status !== 'playing') return;

      if (!isCurrentTurn(game, socket.id)) return;

      const player = game.players.find(p => p.id === socket.id);
      const target = game.players.find(p => p.id === targetPlayerId);

      if (!player || !target || !player.specialCards.includes('ST')) return;

      if (target.id === player.id) {
        socket.emit('error', 'You cannot steal from yourself.');
        return;
      }

      if (target.status === 'busted') {
        socket.emit('error', 'You cannot steal from busted players.');
        return;
      }

      const cardArray = isSpecial ? target.specialCards : target.regularCards;
      if (!Number.isInteger(cardIndex) || cardIndex < 0 || cardIndex >= cardArray.length) {
        socket.emit('error', 'Invalid card index.');
        return;
      }

      const stolenCard = cardArray.splice(cardIndex, 1)[0];

      // Consume Steal Card
      removeOneCard(player.specialCards, 'ST');
      game.discardPile.push('ST');

      if (isSpecial) {
        player.specialCards.push(stolenCard);
      } else {
        // Stealing a number you already hold can still bust you.
        handleNumberCard(game, player, stolenCard, io);
      }

      updatePlayerScore(player);
      updatePlayerScore(target);
      advanceTurn(game);
      checkGameStatus(game, io);
      io.to(gameId).emit('game-update', publicGame(game));
    });

    socket.on('swap-cards', (gameId, card1Data, card2Data) => {
      const game = games.get(gameId);
      if (!game || game.status !== 'playing') return;

      if (!isCurrentTurn(game, socket.id)) return;

      const player = game.players.find(p => p.id === socket.id);
      if (!player || !player.specialCards.includes('Swap')) return;

      if (!card1Data || !card2Data) {
        socket.emit('error', 'Invalid card selection.');
        return;
      }

      const player1 = game.players.find(p => p.id === card1Data.playerId);
      const player2 = game.players.find(p => p.id === card2Data.playerId);

      if (!player1 || !player2) {
        socket.emit('error', 'Invalid players selected.');
        return;
      }

      if (player1.id === player2.id) {
        socket.emit('error', 'Must swap cards from different players.');
        return;
      }

      if (player1.status === 'busted' || player2.status === 'busted') {
        socket.emit('error', 'Cannot swap cards with busted players.');
        return;
      }

      // Get the card arrays
      const array1 = card1Data.isSpecial ? player1.specialCards : player1.regularCards;
      const array2 = card2Data.isSpecial ? player2.specialCards : player2.regularCards;

      if (!Number.isInteger(card1Data.index) || !Number.isInteger(card2Data.index) ||
          card1Data.index < 0 || card1Data.index >= array1.length ||
          card2Data.index < 0 || card2Data.index >= array2.length) {
        socket.emit('error', 'Invalid card selection.');
        return;
      }

      // Extract both card values
      const card1Value = array1[card1Data.index];
      const card2Value = array2[card2Data.index];

      // Only point-scoring specials can change hands - the targeting cards would
      // otherwise land in a hand with no way left to play them.
      if ((card1Data.isSpecial && !isSwappableSpecial(card1Value)) ||
          (card2Data.isSpecial && !isSwappableSpecial(card2Value))) {
        socket.emit('error', 'That card cannot be swapped.');
        return;
      }

      // Remove both cards from their original arrays before the Swap card is
      // discarded, so the indices still line up when the swapper trades one of
      // their own special cards.
      array1.splice(card1Data.index, 1);
      array2.splice(card2Data.index, 1);

      // Consume Swap Card
      removeOneCard(player.specialCards, 'Swap');
      game.discardPile.push('Swap');

      // Place each card into the correct array on the receiving player
      // Numbers go to regularCards, strings go to specialCards
      if (typeof card2Value === 'number') {
        player1.regularCards.push(card2Value);
      } else {
        player1.specialCards.push(card2Value);
      }

      if (typeof card1Value === 'number') {
        player2.regularCards.push(card1Value);
      } else {
        player2.specialCards.push(card1Value);
      }

      const findDuplicateValue = (regularCards) => {
        const seen = new Set();
        for (const value of regularCards) {
          if (seen.has(value)) {
            return value;
          }
          seen.add(value);
        }
        return null;
      };

      const resolveSwapDuplicate = (targetPlayer, swappedValue) => {
        const duplicateValue = findDuplicateValue(targetPlayer.regularCards);
        if (duplicateValue === null) return;

        const scIndex = targetPlayer.specialCards.indexOf('SC');
        if (scIndex > -1) {
          targetPlayer.specialCards.splice(scIndex, 1);
          game.discardPile.push('SC');
          io.to(game.id).emit('play-sound', 'secondChanceSound');

          if (typeof swappedValue === 'number') {
            const removeIndex = targetPlayer.regularCards.findIndex(v => v === swappedValue);
            if (removeIndex !== -1) {
              targetPlayer.regularCards.splice(removeIndex, 1);
            }
          }
          return;
        }

        targetPlayer.status = 'busted';
        targetPlayer.bustedCard = duplicateValue;
        targetPlayer.roundScore = 0;
        io.to(game.id).emit('play-sound', 'bustCardSound');
      };

      // Check for duplicates when a number was placed into regularCards
      if (typeof card2Value === 'number') {
        resolveSwapDuplicate(player1, card2Value);
      }
      if (typeof card1Value === 'number') {
        resolveSwapDuplicate(player2, card1Value);
      }

      // Update scores and check for busts
      updatePlayerScore(player1);
      updatePlayerScore(player2);

      // Notify all players about the swap
      io.to(gameId).emit('swap-notification', {
        swapper: player.name,
        player1: player1.name,
        card1: card1Value,
        player2: player2.name,
        card2: card2Value
      });

      advanceTurn(game);
      checkGameStatus(game, io);
      io.to(gameId).emit('game-update', publicGame(game));
    });

    // Update the select-card-from-pile event handling for better deck management
    socket.on('select-card-choice', (gameId, selectedCard) => {
      const game = games.get(gameId);
      if (!game || game.status !== 'playing') return;
      
      const player = game.players[game.currentPlayer];
      if (player.id !== socket.id || player.status !== 'active') return;

      // Only a player actually holding a Select card may pick out of the deck.
      if (!player.specialCards.includes('Select')) return;

      if (!isValidCard(selectedCard)) {
        return socket.emit('error', 'That is not a valid card.');
      }

      // Find and remove the selected card from the deck (with safety checks)
      const cardIndex = game.deck.findIndex(card => card === selectedCard);

      if (cardIndex !== -1) {
        // Card found in the regular deck
        game.deck.splice(cardIndex, 1);
      } else if (game.deck.length === 0) {
        // Select was the last card in the deck, so the popup offered a fresh one
        const newDeck = createDeck();
        removeOneCard(newDeck, selectedCard);
        game.deck = newDeck;
      } else {
        // The card is not available - the deck the popup was built from is still intact,
        // so this can only be a client asking for a card the deck does not hold.
        return socket.emit('error', 'That card is no longer in the deck.');
      }

      removeOneCard(player.specialCards, 'Select');

      // Track the last card drawn (selected)
      game.lastCardDrawn = selectedCard;
      console.log('Last card drawn (via Select) set to:', selectedCard);
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
      else if (selectedCard === 'D3' || selectedCard === 'Freeze' || selectedCard === 'RC' || selectedCard === 'ST' || selectedCard === 'Swap') {
        // For special cards that need targeting, add to hand but don't advance turn yet
        player.specialCards.push(selectedCard);
        // The client will request targets immediately
        // Turn will advance when the special card effect is applied
      }
      else if (selectedCard === 'Select') {
        // Picking another Select just hands them a fresh choice
        player.specialCards.push(selectedCard);
        handleSelectCard(game, player, socket, io);
      }
      else {
        // For other special cards, add to player's hand
        player.specialCards.push(selectedCard);
        advanceTurn(game);
      }

      updatePlayerScore(player);
      checkGameStatus(game, io);

      // Always emit game update to refresh the deck display
      io.to(gameId).emit('game-update', publicGame(game));
    });

    // Inside handleSocketConnection function, add these new event handlers
    socket.on('request-draw-three-targets', (gameId) => {
      const game = games.get(gameId);
      if (!game || game.status !== 'playing') return;

      if (!isCurrentTurn(game, socket.id)) return;

      const player = game.players.find(p => p.id === socket.id);
      if (!player || player.status !== 'active' || !player.specialCards.includes('D3')) return;

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

      if (!isCurrentTurn(game, socket.id)) return;

      const player = game.players.find(p => p.id === socket.id);
      if (!player || player.status !== 'active' || !player.specialCards.includes('Freeze')) return;

      // Find valid targets (active players)
      const targets = game.players.filter(p => p.status === 'active');
      
      if (targets.length > 0) {
        socket.emit('select-freeze-target', game.id, targets);
      }
    });
    
    socket.on('request-remove-card-targets', (gameId) => {
      const game = games.get(gameId);
      if (!game || game.status !== 'playing') return;

      if (!isCurrentTurn(game, socket.id)) return;

      const player = game.players.find(p => p.id === socket.id);
      if (!player || player.status !== 'active' || !player.specialCards.includes('RC')) return;

      const hasRemovableCard = p =>
        p.regularCards.length > 0 || p.specialCards.some(c => c !== 'RC');

      // Only allow targets that are active and have at least one removable card
      const targets = game.players.filter(p => 
        p.status === 'active' &&
        hasRemovableCard(p)
      );

      if (targets.length === 0) {
        // No valid targets: discard RC and skip turn
        removeOneCard(player.specialCards, 'RC');
        game.discardPile.push('RC');
        socket.emit('error', 'No cards to remove. Turn skipped.');
        advanceTurn(game);
        checkGameStatus(game, io);
        io.to(gameId).emit('game-update', publicGame(game));
        return;
      }
      
      socket.emit('select-remove-card-target', game.id, targets);
    });

    socket.on('request-steal-card-targets', (gameId) => {
      const game = games.get(gameId);
      if (!game || game.status !== 'playing') return;

      if (!isCurrentTurn(game, socket.id)) return;

      const player = game.players.find(p => p.id === socket.id);
      if (!player || player.status !== 'active' || !player.specialCards.includes('ST')) return;

      const targets = game.players.filter(p =>
        p.status !== 'busted' &&
        p.id !== player.id &&
        (p.regularCards.length > 0 || p.specialCards.length > 0)
      );

      if (targets.length === 0) {
        removeOneCard(player.specialCards, 'ST');
        game.discardPile.push('ST');
        socket.emit('error', 'No cards to steal. Turn skipped.');
        advanceTurn(game);
        checkGameStatus(game, io);
        io.to(gameId).emit('game-update', publicGame(game));
        return;
      }

      socket.emit('select-steal-card-target', game.id, targets);
    });

    socket.on('request-swap-targets', (gameId) => {
      const game = games.get(gameId);
      if (!game || game.status !== 'playing') return;

      if (!isCurrentTurn(game, socket.id)) return;

      const player = game.players.find(p => p.id === socket.id);
      if (!player || player.status !== 'active' || !player.specialCards.includes('Swap')) return;

      const playersWithCards = game.players.filter(p =>
        p.status !== 'busted' && countSwappableCards(p) > 0
      );

      if (playersWithCards.length >= 2) {
        socket.emit('select-swap-cards', game.id, game.players);
      } else {
        removeOneCard(player.specialCards, 'Swap');
        game.discardPile.push('Swap');
        socket.emit('error', 'Not enough players with cards to swap. Turn skipped.');
        advanceTurn(game);
        checkGameStatus(game, io);
        io.to(gameId).emit('game-update', publicGame(game));
      }
    });
    
    // Inside handleSocketConnection function, add these socket events
    socket.on('play-sound', (gameId, soundId) => {
      // Broadcast sound to all players in the game except sender
      socket.to(gameId).emit('play-sound', soundId);
    });

    socket.on('disconnect', () => {
      console.log(`Disconnected: ${socket.id}`);

      games.forEach((game, gameId) => {
        const index = game.players.findIndex(p => p.id === socket.id);
        if (index === -1) return;

        const leavingPlayerHadTurn = isCurrentTurn(game, socket.id);
        const currentPlayerId = game.players[game.currentPlayer]
          ? game.players[game.currentPlayer].id
          : null;

        game.players.splice(index, 1);

        if (game.players.length === 0) {
          games.delete(gameId);
          return;
        }

        // The host controls start/reset, so the game would be stuck without one.
        if (game.hostId === socket.id) {
          game.hostId = game.players[0].id;
        }

        // currentPlayer is an index into the players array, so it has to be
        // re-derived after the splice or the turn silently jumps to someone else.
        if (leavingPlayerHadTurn) {
          game.currentPlayer = index % game.players.length;
          if (game.status === 'playing' &&
              game.players[game.currentPlayer].status !== 'active') {
            advanceTurn(game);
          }
        } else {
          const currentIndex = game.players.findIndex(p => p.id === currentPlayerId);
          game.currentPlayer = currentIndex === -1 ? 0 : currentIndex;
        }

        // Losing the last active player ends the round like any other action would.
        if (game.status === 'playing') {
          checkGameStatus(game, io);
        }

        io.to(gameId).emit('game-update', publicGame(game));
      });
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
  // 0 is a number card like any other: a second one is still a duplicate.
  if (player.regularCards.includes(card)) {
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
    return;
  }

  player.regularCards.push(card);
  // A full set of 7 ends that player's round. The +15 bonus is part of the round
  // score (see updatePlayerScore) so it is banked with the rest at round end.
  if (player.regularCards.length === MAX_REGULAR_CARDS) {
    player.status = 'stood';
    updatePlayerScore(player);
  }
};

const updatePlayerScore = player => {
  // A bust scores nothing, and the cards stay in hand for the round summary.
  if (player.status === 'busted') {
    player.roundScore = 0;
    return;
  }

  const uniqueRegularCards = [...new Set(player.regularCards)];
  const base = uniqueRegularCards.reduce((a, b) => a + b, 0);
  const add = player.specialCards
    .filter(c => c.endsWith('+'))
    .reduce((a, c) => a + parseInt(c), 0);
  const minus = player.specialCards
    .filter(c => c.endsWith('-'))
    .reduce((a, c) => a + parseInt(c), 0);

  // Handle divide card (2÷)
  let divide = 1;
  if (player.specialCards.includes('2÷')) {
    divide = 2;
  }

  // Handle multiplier (2x)
  let multiplier = 1;
  if (player.specialCards.includes('2x'))
    multiplier *= 2;

  // Calculate: (base + add - minus) * multiplier / divide
  let score = (base + add - minus) * multiplier;
  if (divide > 1) {
    score = Math.round(score / divide);
  }

  // Flat bonus for a full set of 7, applied after the modifiers so it is worth the
  // same 15 points however the rest of the hand scores.
  if (uniqueRegularCards.length === MAX_REGULAR_CARDS) {
    score += SEVEN_CARD_BONUS;
  }

  // Keep score at 0 if it's already 0
  player.roundScore = Math.max(0, score);
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

// The card is already in the player's hand by the time this runs - it is either
// discarded unused (no legal target) or held until the player picks one.
const handleSpecialCard = (game, player, card, socket, io) => {
  const discardUnplayable = message => {
    removeOneCard(player.specialCards, card);
    game.discardPile.push(card);
    if (message) socket.emit('error', message);
    advanceTurn(game);
    checkGameStatus(game, io);
    io.to(game.id).emit('game-update', publicGame(game));
  };

  if (card === 'D3') {
    // Allow targeting any active player (including self) with room for cards
    const targets = game.players.filter(p =>
      p.status === 'active' && // Only active players
      p.regularCards.length < MAX_REGULAR_CARDS // Must have room for cards
    );

    if (targets.length > 0) {
      socket.emit('select-draw-three-target', game.id, targets);
    } else {
      discardUnplayable('No one can draw three cards. Turn skipped.');
    }
  }
  else if (card === 'Freeze') {
    // Allow targeting any active player (including self)
    const targets = game.players.filter(p =>
      p.status === 'active'
    );
    if (targets.length > 0) {
      socket.emit('select-freeze-target', game.id, targets);
    } else {
      discardUnplayable('No one left to freeze. Turn skipped.');
    }
  }
  else if (card === 'RC') {
    const hasRemovableCard = p =>
      p.regularCards.length > 0 || p.specialCards.some(c => c !== 'RC');
    const targets = game.players.filter(p =>
      p.status === 'active' &&
      hasRemovableCard(p)
    );

    if (targets.length > 0) {
      socket.emit('select-remove-card-target', game.id, targets);
    } else {
      discardUnplayable('No cards to remove. Turn skipped.');
    }
  }
  else if (card === 'ST') {
    const targets = game.players.filter(p =>
      p.status !== 'busted' &&
      p.id !== player.id &&
      (p.regularCards.length > 0 || p.specialCards.length > 0)
    );

    if (targets.length > 0) {
      socket.emit('select-steal-card-target', game.id, targets);
    } else {
      discardUnplayable('No cards to steal. Turn skipped.');
    }
  }
  else if (card === 'Swap') {
    // Check if there are at least 2 players with swappable cards
    const playersWithCards = game.players.filter(p =>
      p.status !== 'busted' && countSwappableCards(p) > 0
    );

    if (playersWithCards.length >= 2) {
      // Emit game-update so clients see Swap in special cards before popup shows
      io.to(game.id).emit('game-update', publicGame(game));
      socket.emit('select-swap-cards', game.id, game.players);
    } else {
      discardUnplayable('Not enough players with cards to swap. Turn skipped.');
    }
  }
};

const handleSelectCard = (game, player, socket, io, deckForPopup = null, fullDeck = null) => {
  const popupDeck = Array.isArray(deckForPopup) ? deckForPopup : game.deck;
  // Sorted, so the popup does not double as a look at the draw order.
  socket.emit(
    'select-card-from-pile',
    game.id,
    sortDeckForDisplay(popupDeck),
    fullDeck ? sortDeckForDisplay(fullDeck) : fullDeck
  );
  game.discardPile.push('Select');
};

// Game status checking and round management functions
const checkGameStatus = (game, io) => {
  // Several actions end a round and then have their caller check again, so the
  // scoring below must only ever be scheduled once per round.
  if (game.roundEnding) return;

  // Check if round should end (all players are either busted, stood, or frozen)
  const activePlayers = game.players.filter(p => p.status === 'active');
  const allBusted = game.players.every(p => p.status === 'busted');

  if (activePlayers.length === 0) {
    game.roundEnding = true;

    io.to(game.id).emit('round-summary', {
      players: game.players,
      allBusted: allBusted
    });

    setTimeout(() => {
      // The game can be reset, rematched or abandoned while the summary is showing,
      // and reset/rematch replace the object this closure captured.
      if (games.get(game.id) !== game) return;
      game.roundEnding = false;

      // Update total scores for non-busted players
      game.players.forEach(player => {
        if (player.status !== 'busted') {
          player.totalScore += player.roundScore;
        }
      });

      if (allBusted) {
        startNewRound(game, io);
      } else {
        // Find highest scoring player among non-busted players
        const nonBustedPlayers = game.players.filter(p => p.status !== 'busted');
        const highestScore = Math.max(...nonBustedPlayers.map(p => p.totalScore));
        const winners = nonBustedPlayers.filter(p => p.totalScore === highestScore);

        // End game if any winner is at the winning score, otherwise start new round
        if (highestScore >= WINNING_SCORE) {
          // In case of a tie, winner is the one who reached it first
          endGame(game, winners[0], io);
        } else {
          startNewRound(game, io);
        }
      }

      io.to(game.id).emit('new-round', publicGame(game));
    }, 5000);
  }
};

const endGame = (game, winner, io) => {
  game.status = 'finished';
  io.to(game.id).emit('game-over', {
    players: game.players.map(p => ({
      ...p,
      status: p.id === winner.id ? 'winner' : p.status
    })),
    winner: winner
  });
};

const startNewRound = (game, io) => {
  game.roundNumber++;
  
  // Don't reset deck - it persists across rounds and reshuffles when empty during gameplay
  // Only reset discard pile
  game.discardPile = [];
  
  // Reset player states, but keep total scores, lastCardDrawn, and deck
  game.players.forEach(player => {
      player.regularCards = [];
      player.specialCards = [];
      player.status = 'active';
      player.roundScore = 0;
      player.bustedCard = null;
      player.drawThreeRemaining = 0;
      player.pendingSpecialCard = null;
  });

  // Set starting player based on round number (cycling through players)
  game.currentPlayer = (game.roundNumber - 1) % game.players.length;
  game.status = 'playing'; // Ensure game status is set to playing

  // Immediately emit game update to ensure clients get the new state
  io.to(game.id).emit('game-update', publicGame(game));
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
server.on('error', err => {
  console.error('Server error:', err);
  process.exit(1);
});

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