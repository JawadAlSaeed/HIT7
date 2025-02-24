const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const helmet = require('helmet');
const cors = require('cors');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

// Heroku-specific WebSocket configuration
const io = new Server(server, {
  cors: {
    origin: [
      process.env.PRODUCTION_URL || 'https://your-app-name.herokuapp.com',
      ...(process.env.NODE_ENV === 'development' 
        ? ['http://localhost:3000'] 
        : [])
    ],
    methods: ['GET', 'POST'],
    credentials: true
  },
  transports: ['websocket', 'polling'] // Required for Heroku
});

// Security middleware
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
const games = new Map();
const WINNING_SCORE = 200;
const MAX_REGULAR_CARDS = 7;

// WebSocket keep-alive for Heroku
setInterval(() => {
  io.emit('ping', Date.now());
}, 55000);

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy', 
    timestamp: Date.now(),
    activeGames: games.size
  });
});

// Existing game logic
const createDeck = () => {
    const deck = [];
    // Regular cards (1-12)
    for (let number = 1; number <= 12; number++) {
        for (let i = 0; i < number; i++) deck.push(number);
    }
    // Special cards (6 total)
    ['2+', '4+', '6+', '8+', '10+', '2x'].forEach(card => deck.push(card));
    return shuffle(deck);
};

const shuffle = array => {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
};

io.on('connection', socket => {
    console.log(`User connected: ${socket.id}`);

    // Existing game event handlers
    socket.on('create-game', playerName => {
        const gameId = uuidv4().substr(0, 5).toUpperCase();
        const newGame = {
            id: gameId,
            hostId: socket.id,
            players: [{
                id: socket.id,
                name: playerName,
                regularCards: [],
                specialCards: [],
                status: 'waiting',
                roundScore: 0,
                totalScore: 0,
                bustedCard: null
            }],
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
        if (!game) return socket.emit('error', 'Game not found');
        
        game.players.push({
            id: socket.id,
            name: playerName,
            regularCards: [],
            specialCards: [],
            status: 'waiting',
            roundScore: 0,
            totalScore: 0,
            bustedCard: null
        });
        socket.join(gameId);
        io.to(gameId).emit('game-update', game);
        socket.emit('game-joined', gameId);
    });

    socket.on('start-game', gameId => {
        const game = games.get(gameId);
        if (!game || game.status !== 'lobby') return;
        
        game.status = 'playing';
        game.players.forEach(p => p.status = 'active');
        io.to(gameId).emit('game-started', game);
    });

    socket.on('flip-card', gameId => {
        const game = games.get(gameId);
        if (!game || game.status !== 'playing') return;

        const player = game.players[game.currentPlayer];
        if (player.id !== socket.id || player.status !== 'active') return;

        if (game.deck.length === 0) {
            game.deck = shuffle([...game.discardPile]);
            game.discardPile = [];
        }

        const card = game.deck.pop();
        game.discardPile.push(card);

        if (typeof card === 'number') {
            if (player.regularCards.includes(card)) {
                player.status = 'busted';
                player.bustedCard = card;
                player.roundScore = 0;
            } else {
                player.regularCards.push(card);
                if (player.regularCards.length >= MAX_REGULAR_CARDS) {
                    player.status = 'stood';
                }
            }
        } else {
            player.specialCards.push(card);
        }

        // Calculate scores
        const base = [...new Set(player.regularCards)].reduce((a, b) => a + b, 0);
        const add = player.specialCards
            .filter(c => c.endsWith('+'))
            .map(c => parseInt(c))
            .reduce((a, b) => a + b, 0);
        const multiply = player.specialCards
            .filter(c => c.endsWith('x'))
            .map(c => parseInt(c))
            .reduce((a, b) => a * b, 1);

        player.roundScore = (base + add) * (multiply || 1);

        advanceTurn(game);
        checkGameStatus(game);
        io.to(gameId).emit('game-update', game);
    });

    socket.on('stand', gameId => {
        const game = games.get(gameId);
        if (!game || game.status !== 'playing') return;

        const player = game.players[game.currentPlayer];
        if (player.id !== socket.id || player.status !== 'active') return;

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

    const advanceTurn = game => {
        let nextPlayer = (game.currentPlayer + 1) % game.players.length;
        let attempts = 0;
        while (attempts++ < game.players.length) {
            if (game.players[nextPlayer].status === 'active') break;
            nextPlayer = (nextPlayer + 1) % game.players.length;
        }
        game.currentPlayer = nextPlayer;
    };

    const checkGameStatus = game => {
        // Check for instant win condition first
        const potentialWinner = game.players.find(p => 
            p.status === 'stood' && p.totalScore + p.roundScore >= WINNING_SCORE
        );

        if (potentialWinner) {
            potentialWinner.totalScore += potentialWinner.roundScore;
            io.to(game.id).emit('game-over', { 
                players: game.players,
                winner: potentialWinner
            });
            game.status = 'finished';
            return;
        }

        // Original game flow
        const activePlayers = game.players.filter(p => p.status === 'active');
        const allBusted = game.players.every(p => p.status === 'busted');

        if (activePlayers.length > 0 && game.deck.length > 0) return;

        // Replace the existing players.forEach with:
        game.players.forEach(player => {
            if (player.status !== 'busted') {
                player.totalScore += player.roundScore;
            } else {
                player.roundScore = 0; // Clear busted round score
            }
        });

        // Check for final winner after round ends
        const winner = game.players.reduce((max, p) => 
            p.totalScore > max.totalScore ? p : max, { totalScore: -1 });

        if (winner.totalScore >= WINNING_SCORE) {
            io.to(game.id).emit('game-over', { 
                players: game.players,
                winner: winner
            });
            game.status = 'finished';
        } else {
            if (allBusted) {
                io.to(game.id).emit('all-busted');
                setTimeout(() => {
                    startNewRound(game);
                    io.to(game.id).emit('new-round', game);
                }, 3000);
            } else {
                startNewRound(game);
                io.to(game.id).emit('new-round', game);
            }
        }
    };

    const startNewRound = game => {
        game.roundNumber++;
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

// Heroku port configuration
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running in ${process.env.NODE_ENV || 'development'} mode on port ${PORT}`);
});