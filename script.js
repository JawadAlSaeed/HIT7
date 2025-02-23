document.addEventListener('DOMContentLoaded', () => {
    let deck = [];
    let discardPile = [];
    let players = [];
    let currentPlayerIndex = 0;
    let gameOver = false;
    let roundActive = true;

    // DOM Elements
    const setupScreen = document.querySelector('.setup-screen');
    const gameContainer = document.querySelector('.game-container');
    const playerCountInput = document.getElementById('playerCount');
    const nameInputsContainer = document.getElementById('nameInputs');
    const startGameButton = document.getElementById('startGame');
    const flipButton = document.getElementById('flipButton');
    const standButton = document.getElementById('standButton');
    const resetButton = document.getElementById('resetButton');

    class Player {
        constructor(id, name) {
            this.id = id;
            this.name = name;
            this.collectedNumbers = new Set();
            this.busted = false;
            this.stood = false;
            this.roundScore = 0;
            this.totalScore = 0;
            this.cardsElement = document.createElement('div');
        }
    }

    // Event Listeners
    playerCountInput.addEventListener('change', createNameInputs);
    startGameButton.addEventListener('click', startGame);
    flipButton.addEventListener('click', flipCard);
    standButton.addEventListener('click', stand);
    resetButton.addEventListener('click', resetGame);
    document.getElementById('deck').addEventListener('click', flipCard);

    function createNameInputs() {
        const count = parseInt(playerCountInput.value);
        nameInputsContainer.innerHTML = '';
        
        for (let i = 1; i <= count; i++) {
            const input = document.createElement('input');
            input.className = 'player-name-input';
            input.placeholder = `Player ${i} Name`;
            nameInputsContainer.appendChild(input);
        }
    }

    function startGame() {
        const playerCount = parseInt(playerCountInput.value);
        const nameInputs = Array.from(document.querySelectorAll('.player-name-input'));
        const playerNames = nameInputs.map(input => input.value || `Player ${input.placeholder.match(/\d+/)[0]}`);
        
        setupScreen.style.display = 'none';
        gameContainer.style.display = 'block';
        initializeGame(playerCount, playerNames);
    }

    function initializeGame(playerCount, playerNames) {
        deck = createDeck();
        discardPile = [];
        updateDeckCounter();
        
        players = [];
        const container = document.getElementById('playersContainer');
        container.innerHTML = '';
        
        for (let i = 0; i < playerCount; i++) {
            const player = new Player(i+1, playerNames[i]);
            const playerDiv = document.createElement('div');
            playerDiv.className = 'player';
            playerDiv.innerHTML = `
                <h3>${player.name}</h3>
                <div class="score-display">Round: 0 | Total: 0</div>
            `;
            player.cardsElement = document.createElement('div');
            player.cardsElement.className = 'card-grid';
            playerDiv.appendChild(player.cardsElement);
            container.appendChild(playerDiv);
            players.push(player);
        }
        
        startNewRound();
    }

    function createDeck() {
        let deck = [];
        for (let number = 1; number <= 12; number++) {
            for (let i = 0; i < number; i++) {
                deck.push(number);
            }
        }
        return shuffleArray(deck);
    }

    function shuffleArray(array) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
        return array;
    }

    function updateDeckCounter() {
        document.getElementById('deckCounter').textContent = `Cards left: ${deck.length}`;
    }

    function flipCard() {
        if (!roundActive || gameOver) return;
        
        if (deck.length === 0) {
            deck = shuffleArray(discardPile);
            discardPile = [];
        }

        const currentPlayer = players[currentPlayerIndex];
        if (currentPlayer.busted || currentPlayer.stood) return;

        const drawnCard = deck.pop();
        discardPile.push(drawnCard);
        updateDeckCounter();
        
        if (currentPlayer.collectedNumbers.has(drawnCard)) {
            currentPlayer.busted = true;
            updatePlayerDisplay(currentPlayer, drawnCard, true);
            checkRoundEnd();
            return;
        }

        currentPlayer.collectedNumbers.add(drawnCard);
        updatePlayerDisplay(currentPlayer, drawnCard, false);

        if (currentPlayer.collectedNumbers.size === 7) {
            endRound();
            return;
        }

        advanceTurn();
    }

    function stand() {
        if (!roundActive || gameOver) return;
        const currentPlayer = players[currentPlayerIndex];
        currentPlayer.stood = true;
        checkRoundEnd();
    }

    function updatePlayerDisplay(player, newCard, isBust) {
        const cardElement = document.createElement('div');
        cardElement.className = `card ${isBust ? 'bust' : ''}`;
        cardElement.textContent = newCard;
        player.cardsElement.appendChild(cardElement);

        const scoreDiv = player.cardsElement.parentElement.querySelector('.score-display');
        scoreDiv.textContent = `Round: ${player.roundScore} | Total: ${player.totalScore}`;

        player.cardsElement.classList.toggle('bust', isBust);
    }

    function startNewRound() {
        roundActive = true;
        currentPlayerIndex = 0;
        
        players.forEach(player => {
            player.collectedNumbers.clear();
            player.busted = false;
            player.stood = false;
            player.roundScore = 0;
            player.cardsElement.innerHTML = '';
            player.cardsElement.classList.remove('bust');
        });
        
        updateTurnDisplay();
    }

    function resetGame() {
        if (confirm("Are you sure you want to reset the game? All progress will be lost!")) {
            gameOver = false;
            deck = [];
            discardPile = [];
            players = [];
            setupScreen.style.display = 'block';
            gameContainer.style.display = 'none';
            nameInputsContainer.innerHTML = '';
            createNameInputs();
        }
    }

    function advanceTurn() {
        let originalIndex = currentPlayerIndex;
        let attempts = 0;
        
        do {
            currentPlayerIndex = (currentPlayerIndex + 1) % players.length;
            attempts++;
            
            if (attempts > players.length) {
                checkRoundEnd();
                return;
            }
        } while (!isPlayerActive(players[currentPlayerIndex]));
        
        updateTurnDisplay();
    }

    function isPlayerActive(player) {
        return !player.busted && !player.stood && !gameOver;
    }

    function checkRoundEnd() {
        const activePlayers = players.filter(p => !p.busted && !p.stood);
        
        if (activePlayers.length === 0 || players.some(p => p.collectedNumbers.size === 7)) {
            endRound();
        } else {
            advanceTurn();
        }
    }

    function endRound() {
        roundActive = false;
        players.forEach(player => {
            if (!player.busted) {
                player.roundScore = Array.from(player.collectedNumbers).reduce((a, b) => a + b, 0);
                player.totalScore += player.roundScore;
            }
        });

        players.forEach(player => {
            const scoreDiv = player.cardsElement.parentElement.querySelector('.score-display');
            scoreDiv.textContent = `Round: ${player.roundScore} | Total: ${player.totalScore}`;
        });

        const winner = players.find(p => p.totalScore >= 200);
        if (winner) {
            gameOver = true;
            document.getElementById('status').textContent = `${winner.name} Wins the Game!`;
        } else {
            setTimeout(startNewRound, 2000);
        }
    }

    function updateTurnDisplay() {
        players.forEach((player, index) => {
            const playerDiv = player.cardsElement.parentElement;
            playerDiv.classList.toggle('current-turn', index === currentPlayerIndex);
        });
        document.getElementById('status').textContent = 
            `${players[currentPlayerIndex].name}'s Turn`;
    }

    // Initialize the game
    createNameInputs();
});