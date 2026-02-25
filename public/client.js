const socket = io();
let currentGameId = null;
let isHost = false;
const MAX_REGULAR_CARDS = 7;
let activeFreezePopup = null;
let activeDrawThreePopup = null;
let soundEnabled = true;
let currentGameUrl = ""; // New: stores the game URL

// Remove initialization code
const initializeButtons = () => {
    console.log('Initializing buttons...');
    
    // Menu Buttons - Use direct onclick instead of addEventListener to prevent duplicates
    const createGameBtn = document.getElementById('createGame');
    const joinGameBtn = document.getElementById('joinGame');
    const tutorialBtn = document.getElementById('tutorialButton');
    
    if (createGameBtn) createGameBtn.onclick = function(e) {
        e.preventDefault();
        playSound('buttonClick');
        console.log('Create Game clicked');
        createGame();
    };
    
    if (joinGameBtn) joinGameBtn.onclick = function(e) {
        e.preventDefault();
        playSound('buttonClick');
        console.log('Join Game clicked');
        joinGame();
    };
    
    if (tutorialBtn) tutorialBtn.onclick = function(e) {
        e.preventDefault();
        playSound('buttonClick');
        console.log('Tutorial clicked');
        showTutorial();
    };

    // Game Control Buttons - removed startGame button
    const flipCardBtn = document.getElementById('flipCard');
    const standBtn = document.getElementById('standButton');
    const resetBtn = document.getElementById('resetButton');

    if (flipCardBtn) flipCardBtn.onclick = function() {
        if (flipCardBtn.disabled) return;
        playSound('cardFlip');
        flipCard();
    };
    if (standBtn) standBtn.onclick = function() {
        if (standBtn.disabled) return;
        playSound('buttonClick');
        stand();
    };
    if (resetBtn) resetBtn.onclick = function() {
        showResetConfirmation();
    };
    
    const headerTutorialBtn = document.getElementById('headerTutorialBtn');
    if (headerTutorialBtn) headerTutorialBtn.onclick = function() {
        playSound('buttonClick');
        showTutorial();
    };
    
    console.log('Button initialization complete');
};

// Initialize only once when the DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    initializeButtons();
    checkUrlParams();
});

// Socket event listeners
socket.on('game-created', handleGameCreated);
socket.on('game-joined', handleGameJoined);
socket.on('game-update', handleGameUpdate);
socket.on('game-started', handleGameStarted);
socket.on('new-round', handleNewRound);
socket.on('game-over', handleGameOver);
socket.on('all-busted', handleAllBusted);
socket.on('game-reset', handleGameReset);
socket.on('error', handleError);
socket.on('round-summary', handleRoundSummary);
socket.on('cancel-freeze', () => {
  if (activeFreezePopup) {
    activeFreezePopup.remove();
    activeFreezePopup = null;
  }
});

socket.on('select-freeze-target', (gameId, targets) => {
  // Disable action buttons during popup
  document.body.style.overflow = 'hidden';
  toggleActionButtons(false);
  
  // Remove any existing popups
  document.querySelectorAll('.freeze-popup').forEach(p => p.remove());
  
  const popup = document.createElement('div');
  popup.className = 'freeze-popup active';
  popup.innerHTML = `
    <div class="popup-content">
      <h3><span class="emoji">❄️</span> Select player to freeze:</h3>
      <div class="freeze-targets">
        ${targets.map(p => `
          <button class="freeze-target ${p.id === socket.id ? 'self-target' : ''}" data-id="${p.id}">
            ${p.name} ${p.id === socket.id ? '(You)' : ''}
          </button>
        `).join('')}
      </div>
      <button class="view-game-button" id="viewGameButton">
        <span class="icon">👁️</span> Hold to view game
      </button>
    </div>
  `;

  popup.querySelectorAll('.freeze-target').forEach(btn => {
    btn.addEventListener('click', () => {
      socket.emit('freeze-player', currentGameId, btn.dataset.id);
      popup.remove();
    });
  });

  // Add HOLD TO VIEW GAME button functionality
  const viewButton = popup.querySelector('#viewGameButton');
  viewButton.addEventListener('mousedown', (e) => {
    e.preventDefault();
    popup.classList.add('popup-hiding');
  });
  
  viewButton.addEventListener('touchstart', (e) => {
    e.preventDefault();
    popup.classList.add('popup-hiding');
  });
  
  const handleUp = () => {
    if (popup.parentElement) {
      popup.classList.remove('popup-hiding');
    }
  };
  
  document.addEventListener('mouseup', handleUp);
  document.addEventListener('touchend', handleUp);
  
  // Clean up event listeners when popup is removed
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if ([...mutation.removedNodes].includes(popup)) {
        document.removeEventListener('mouseup', handleUp);
        document.removeEventListener('touchend', handleUp);
        observer.disconnect();
      }
    });
  });
  
  document.body.appendChild(popup);
  observer.observe(document.body, { childList: true });
});

// draw-three popup handler (single instance kept earlier in file)

// keep a single connect/disconnect handler
socket.on('connect', () => console.log('Connected to server'));
socket.on('disconnect', () => alert('Lost connection to server!'));

// Add this with the other socket event listeners at the top
socket.on('rematch-started', (game) => {
    const popups = document.querySelectorAll('.winner-popup');
    popups.forEach(popup => popup.remove());
    
    // Clear the board for new game
    document.getElementById('playersContainer').innerHTML = '';
    
    // Update game display
    updateGameDisplay(game);
    
    // Check if it's the current player's turn
    const isCurrentPlayer = game.players[game.currentPlayer]?.id === socket.id;
    toggleActionButtons(isCurrentPlayer && game.status === 'playing');
});

// Add new socket listener for sounds
socket.on('play-sound', (soundId) => {
    playSound(soundId);
});

// Add this new event listener with the other socket listeners
socket.on('game-reset-with-players', (game) => {
    // Clear any existing popups
    const popups = document.querySelectorAll('.winner-popup, .round-summary-popup, .info-popup');
    popups.forEach(popup => popup.remove());
    
    // Clear the board for new game
    document.getElementById('playersContainer').innerHTML = '';
    
    // Update game display
    updateGameDisplay(game);
    
    // Check if it's the current player's turn
    const isCurrentPlayer = game.players[game.currentPlayer]?.id === socket.id;
    toggleActionButtons(isCurrentPlayer && game.status === 'playing');
    
    // Show a notification
    const notification = document.createElement('div');
    notification.className = 'info-popup';
    notification.innerHTML = `
        <h2>⇄ Game Reset!</h2>
        <p class="popup-countdown">Starting new game...</p>
    `;
    document.body.appendChild(notification);
    
    // Remove notification after 2 seconds
    setTimeout(() => {
        notification.remove();
    }, 2000);
});

// Add select-card-from-pile event listener with other socket listeners
socket.on('select-card-from-pile', (gameId, deck, fullDeck) => {
  // Disable action buttons during popup
  document.body.style.overflow = 'hidden';
  toggleActionButtons(false);
  showSelectCardPopup(gameId, deck, fullDeck);
});

// Game actions
function createGame() {
    playSound('buttonClick');
    console.log('createGame function called'); // Debug log
    const name = prompt('Enter your name:')?.trim();
    if (!name) {
        return alert('Please enter a name!');
    }
    if (name.length < 3) {
        return alert('Name must be at least 3 characters!');
    }
    
    // Clear any existing game state
    currentGameId = null;
    document.getElementById('playersContainer').innerHTML = '';
    
    console.log('Emitting create-game event with name:', name); // Debug log
    socket.emit('create-game', name);
}

function joinGame() {
    playSound('buttonClick');
    const gameIdInput = document.getElementById('gameId');
    const code = gameIdInput.value.trim().toUpperCase();
    
    if (!/^[A-Z0-9]{5}$/.test(code)) {
        alert('Game code must be 5 characters!');
        gameIdInput.focus();
        return;
    }
    
    const name = prompt('Enter your name:')?.trim();
    if (!name) return alert('Please enter a name!');
    
    socket.emit('join-game', code, name);
}

function startGame() { 
    playSound('buttonClick');
    socket.emit('start-game', currentGameId); 
}

// Modify flip card function to broadcast flip sound
function flipCard() { 
    playSound('cardFlip');
    socket.emit('play-sound', currentGameId, 'cardFlip');
    socket.emit('flip-card', currentGameId); 
}

// Modify stand function to let server handle sound
function stand() { 
    socket.emit('stand', currentGameId); 
}

// Modify resetGame function to remove the confirmation
function resetGame() {
    playSound('buttonClick');
    socket.emit('reset-game', currentGameId);
}

// Game state handlers
function handleGameCreated({ gameId, gameUrl }) {
    console.log('Game created with URL:', gameUrl);
    currentGameId = gameId;
    currentGameUrl = gameUrl; // Store URL for later copying
    isHost = true;
    
    // Hide lobby screen
    document.querySelector('.lobby-screen').style.display = 'none';
    
    // Show waiting screen instead of game area
    showWaitingScreen({
        players: [{ name: 'You (Host)', id: socket.id }],
        hostId: socket.id
    });
}

function copyShareLink() {
  // Prefer the visible share input if present
  const shareInput = document.getElementById('shareLinkInput');
  let link = shareInput?.value || currentGameUrl || (currentGameId ? `${window.location.origin}/join/${currentGameId}` : '');
  if (!link) return alert('No share link available');

  const canUseClipboard = !!(navigator.clipboard && window.isSecureContext);
  if (canUseClipboard) {
    navigator.clipboard.writeText(link).then(() => {
      showCopyConfirmationInButton();
    }).catch(err => {
      console.error('Clipboard API failed, falling back:', err);
      fallbackCopyLink(link, shareInput);
    });
    return;
  }

  fallbackCopyLink(link, shareInput);
}

function fallbackCopyLink(link, shareInput) {
  if (shareInput) {
    shareInput.focus();
    shareInput.select();
    shareInput.setSelectionRange(0, link.length);
  }

  const tempInput = document.createElement('textarea');
  tempInput.value = link;
  tempInput.setAttribute('readonly', '');
  tempInput.style.position = 'absolute';
  tempInput.style.left = '-9999px';
  document.body.appendChild(tempInput);
  tempInput.select();

  try {
    const copied = document.execCommand('copy');
    if (!copied) throw new Error('execCommand returned false');
    showCopyConfirmationInButton();
  } catch (err) {
    console.error('Fallback copy failed:', err);
    alert('Failed to copy the link. Please copy it manually.');
  } finally {
    document.body.removeChild(tempInput);
  }
}

function showCopyConfirmationInButton() {
    const copyButton = document.querySelector('.game-button.copy-link-btn');
    if (!copyButton) return;

    const originalText = copyButton.textContent;
    copyButton.textContent = 'Link copied!';

    setTimeout(() => {
        copyButton.textContent = originalText;
    }, 2000);
}

// Remove bust sound from handleGameUpdate since server will handle it
function handleGameUpdate(game) {
    const waitingScreen = document.getElementById('waitingScreen');
    const resetButton = document.getElementById('resetButton');
    
    // Show/hide reset button based on host status
    if (resetButton) {
        resetButton.style.display = socket.id === game.hostId ? 'block' : 'none';
    }
    
    // Update deck count immediately
    document.getElementById('deckCount').textContent = game.deck.length;
    // Update the remaining pile display immediately
    updateRemainingPile(game.deck);
    // Update the last card drawn
    updateLastCardDrawn(game.lastCardDrawn);
    
    if (game.status === 'lobby') {
        // Update waiting screen if it exists
        if (waitingScreen) {
            const playersList = waitingScreen.querySelector('.players-list');
            if (playersList) {
                playersList.innerHTML = game.players.map(player => `
                    <div class="player-item">
                        ${player.name}
                        ${player.id === game.hostId ? 
                            '<span class="host-badge">HOST</span>' : ''}
                    </div>
                `).join('');
            }
            // Always update the start button when we get a game update in lobby
        // Update share link input too
        const shareInput = waitingScreen.querySelector('#shareLinkInput');
        if (shareInput) {
          shareInput.value = currentGameUrl || (window.location.origin + '/join/' + (game.id || currentGameId || ''));
        }
        if (isHost) updateStartButton(game.players.length);
        } else {
            // Show waiting screen if it doesn't exist
            showWaitingScreen(game);
        }
    } else {
        // Remove waiting screen and show game when started
        if (waitingScreen) {
            waitingScreen.remove();
        }
        // Update game display as before
        isHost = socket.id === game.hostId;
        const isCurrentPlayer = game.players[game.currentPlayer]?.id === socket.id;
        const canAct = isCurrentPlayer && game.status === 'playing';
        
        updateGameDisplay(game);
        toggleActionButtons(canAct);
        
        document.getElementById('gameArea').style.display = 'flex';
        document.querySelector('.controls').style.display = 'flex';
    }
}

// Display updates
function updateGameDisplay(game) {
    document.getElementById('deckCount').textContent = game.deck.length;
    updateRemainingPile(game.deck);
    updateLastCardDrawn(game.lastCardDrawn);
    renderPlayers(game);
}

function updateRemainingPile(deck) {
    const cardCounts = deck.reduce((acc, card) => {
        const key = card.toString();
        acc[key] = (acc[key] || 0) + 1;
        return acc;
    }, {});

    const regularCards = [];
    const specialCards = [];

    // Helper function to get sort order for special cards - updated order
    const getSpecialCardOrder = card => {
        const specialOrder = {
            'Select': 1,    // 1. Select Card
            'SC': 2,        // 2. Second Chance
            'Freeze': 3,    // 3. Freeze
            'D3': 4,        // 4. Draw Three
          'RC': 5,        // 5. Remove Card
          'ST': 6,        // 6. Steal Card
          'Swap': 7,      // 7. Swap Card
          '2+': 8,        // 8. 2+
          '4+': 9,        // 9. 4+
          '6+': 10,       // 10. 6+
          '8+': 11,       // 11. 8+
          '10+': 12,      // 12. 10+
          '2x': 13,       // 13. 2x Multiplier
          '2-': 14,       // 14. 2-
          '4-': 15,       // 15. 4-
          '6-': 16,       // 16. 6-
          '8-': 17,       // 17. 8-
          '10-': 18,      // 18. 10-
          '2÷': 19,       // 19. 2÷ Divide
        };
        return specialOrder[card] || 99;  // Default high number for unknown cards
    };

    Object.entries(cardCounts).forEach(([cardStr, count]) => {
        let cardType, displayValue;
        
        if (cardStr === 'SC' || cardStr === 'Freeze' || cardStr === 'D3' || 
          cardStr === 'RC' || cardStr === 'ST' || cardStr === 'Swap' || cardStr === 'Select' || cardStr === '2÷' ||
            cardStr.includes('+') || cardStr.includes('x') || cardStr.includes('-')) {
            cardType = 
                cardStr === 'SC' ? 'second-chance' :
                cardStr === 'Freeze' ? 'freeze' :
                cardStr === 'D3' ? 'draw-three' :
                cardStr === 'RC' ? 'remove-card' :
            cardStr === 'ST' ? 'steal-card' :
                cardStr === 'Swap' ? 'swap-card' :
                cardStr === 'Select' ? 'select-card' :
                cardStr === '2÷' ? 'divide' :
                cardStr.includes('+') ? 'adder' :
                cardStr.includes('-') ? 'minus' :
                'multiplier';
            displayValue = 
                cardStr === 'SC' ? '🛡️' :
                cardStr === 'Freeze' ? '❄️' :
                cardStr === 'D3' ? '🎯' :
                cardStr === 'RC' ? '🗑️' :
            cardStr === 'ST' ? '🥷' :
                cardStr === 'Swap' ? '⇄️' :
                cardStr === 'Select' ? '🃏' :
                cardStr === '2÷' ? '2÷' :
                cardStr;
            specialCards.push({ cardStr, count, cardType, displayValue });
        } else {
            cardType = 'number';
            displayValue = cardStr;
            regularCards.push({ cardStr, count, cardType, displayValue });
        }
    });

    // Sort regular cards by number
    regularCards.sort((a, b) => Number(a.cardStr) - Number(b.cardStr));
    
    // Sort special cards by predefined order
    specialCards.sort((a, b) => {
        const orderA = getSpecialCardOrder(a.cardStr);
        const orderB = getSpecialCardOrder(b.cardStr);
        return orderA - orderB;
    });

    document.getElementById('discard').innerHTML = `
        <div class="regular-cards">
            ${regularCards.map(card => renderCard(card)).join('')}
        </div>
        <div class="special-cards">
            ${specialCards.map(card => renderCard(card)).join('')}
        </div>
    `;
}

// Update the renderCard function to use the new gradient
function renderCard({ cardType, displayValue, count }) {
    let cardStyle = '';
    
    if (cardType !== 'number') {
        if (cardType === 'select-card') {
            // Special gradient for select card - more subtle with fewer colors
            cardStyle = `
                background: linear-gradient(135deg, #e74c3c 0%, #9b59b6 50%, #3498db 100%) !important;
                border-color: #e74c3c !important;
            `;
        } else {
            cardStyle = `
                background: ${
                    cardType === 'adder' ? '#fbb03a' : 
                    cardType === 'minus' ? '#f1624f' :
                    cardType === 'divide' ? '#f1624f' :
                    cardType === 'multiplier' ? '#fbb03a' :
                    cardType === 'second-chance' ? '#e74c3c' :
                    cardType === 'freeze' ? '#3498db' :
                    cardType === 'draw-three' ? '#f1c40f' :
                    cardType === 'remove-card' ? '#9b59b6' :
                    cardType === 'steal-card' ? '#e67e22' :
                    cardType === 'swap-card' ? '#42ae5d' : 'inherit'
                } !important;
                color: ${(cardType === 'minus' || cardType === 'divide' || cardType === 'multiplier' || cardType === 'adder') ? '#fff' : 'inherit'} !important;
            `;
        }
    }

    return `
        <div class="remaining-card ${cardType} ${cardType === 'number' ? 'regular-card' : 'special'}"
             style="${cardStyle}">
            ${displayValue}
            ${count > 1 ? `<span class="card-count">×${count}</span>` : ''}
        </div>
    `;
}

function updateLastCardDrawn(card) {
    const container = document.getElementById('lastCardDrawn');
    if (!container) return;
    
    if (card === null || card === undefined) {
        container.innerHTML = '<span class="no-card">---</span>';
        return;
    }
    
    let cardType, displayValue;
    const cardStr = card.toString();
    
    if (cardStr === 'SC' || cardStr === 'Freeze' || cardStr === 'D3' || 
        cardStr === 'RC' || cardStr === 'ST' || cardStr === 'Swap' || cardStr === 'Select' || cardStr === '2÷' ||
        cardStr.includes('+') || cardStr.includes('x') || cardStr.includes('-')) {
        cardType = 
            cardStr === 'SC' ? 'second-chance' :
            cardStr === 'Freeze' ? 'freeze' :
            cardStr === 'D3' ? 'draw-three' :
            cardStr === 'RC' ? 'remove-card' :
            cardStr === 'ST' ? 'steal-card' :
            cardStr === 'Swap' ? 'swap-card' :
            cardStr === 'Select' ? 'select-card' :
            cardStr === '2÷' ? 'divide' :
            cardStr.includes('+') ? 'adder' :
            cardStr.includes('-') ? 'minus' :
            'multiplier';
        displayValue = 
            cardStr === 'SC' ? '🛡️' :
            cardStr === 'Freeze' ? '❄️' :
            cardStr === 'D3' ? '🎯' :
            cardStr === 'RC' ? '🗑️' :
            cardStr === 'ST' ? '🥷' :
            cardStr === 'Swap' ? '⇄️' :
            cardStr === 'Select' ? '🃏' :
            cardStr === '2÷' ? '2÷' :
            cardStr;
    } else {
        cardType = 'number';
        displayValue = cardStr;
    }
    
    container.innerHTML = `
        <div class="last-card ${cardType} ${cardType === 'number' ? 'regular-card' : 'special'}">
            ${displayValue}
        </div>
    `;
}

function updateDiscardPile(discardPile) {
  const discardCounts = discardPile.reduce((acc, card) => {
    const key = card.toString();
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  document.getElementById('discard').innerHTML = Object.entries(discardCounts)
    .map(([cardStr, count]) => {
      let cardType, displayValue;
      
      if (cardStr === 'SC') {
        cardType = 'second-chance';
        displayValue = '🛡️';
      } else if (cardStr === 'Freeze') {
        cardType = 'freeze';
        displayValue = '❄️';
      } else if (cardStr === 'D3') {
        cardType = 'draw-three';
        displayValue = '🎯';
      } else if (cardStr === 'RC') {
        cardType = 'remove-card';
        displayValue = '🗑️';
      } else if (cardStr === 'ST') {
        cardType = 'steal-card';
        displayValue = '🥷';
      } else if (cardStr === 'Swap') {
        cardType = 'swap-card';
        displayValue = '⇄️';
      } else if (cardStr === 'Select') {
        cardType = 'select-card';
        displayValue = '🃏';
      } else if (cardStr.includes('+')) {
        cardType = 'adder';
        displayValue = cardStr;
      } else if (cardStr === '2÷') {
        cardType = 'divide';
        displayValue = '2÷';
      } else if (cardStr.includes('x')) {
        cardType = 'multiplier';
        displayValue = cardStr.replace('x', '×');
      } else if (cardStr.includes('-')) {
        cardType = 'minus';
        displayValue = cardStr;
      } else {
        cardType = 'number';
        displayValue = cardStr;
      }

      const cardStyle = cardType !== 'number' ? `
        background: ${
          cardType === 'adder' ? '#fbb03a' : 
          cardType === 'multiplier' ? '#fbb03a' :
          cardType === 'second-chance' ? '#e74c3c' :
          cardType === 'freeze' ? '#3498db' :
          cardType === 'draw-three' ? '#f1c40f' :
          cardType === 'remove-card' ? '#9b59b6' :
          cardType === 'steal-card' ? '#e67e22' :
          cardType === 'swap-card' ? '#42ae5d' :
          cardType === 'divide' ? '#f1624f' :
          cardType === 'minus' ? '#f1624f' : 'inherit'
        } !important;
      ` : '';

      return {
        html: `
          <div class="discard-card ${cardType} ${cardType === 'number' ? 'regular-card' : 'special'}"
               style="${cardStyle}">
            ${displayValue}
            ${count > 1 ? `<span class="discard-count">x${count}</span>` : ''}
          </div>
        `,
        order: {
          'second-chance': 1,
          'freeze': 2,
          'draw-three': 3,
          'remove-card': 4,
          'steal-card': 5,
          'swap-card': 6,
          'adder': 7,
          'multiplier': 8,
          'divide': 9,
          'minus': 10,
          'number': 11
        }[cardType] || 999
      };
    })
    .sort((a, b) => a.order - b.order)
    .map(item => item.html)
    .join('');
}

function renderPlayers(game) {
    document.getElementById('playersContainer').innerHTML = game.players
        .map((player, index) => playerTemplate(player, index === game.currentPlayer))
        .join('');
}

function playerTemplate(player, isCurrentTurn) {
    const emptyRegularSlots = Array(7 - player.regularCards.length).fill(0)
        .map(() => '<div class="empty-slot"></div>').join('');
    const emptySpecialSlots = Array(7 - player.specialCards.length).fill(0)
        .map(() => '<div class="empty-slot special"></div>').join('');

    return `
        <div class="player ${isCurrentTurn ? 'current-turn' : ''} ${player.status}" data-player-id="${player.id}">
            <div class="player-header">
                <h3>${player.name.toUpperCase()} ${player.id === socket.id ? '<span class="you">(YOU)</span>' : ''}</h3>
                <div class="player-status">
                    ${getStatusIcon(player.status)}
                    ${player.bustedCard ? `<div class="busted-card">BUSTED ON ${player.bustedCard}</div>` : ''}
                    ${player.specialCards.includes('SC') ? `
                        <div class="second-chance-indicator">🛡️ SECOND CHANCE</div>
                    ` : ''}
                </div>
            </div>
            
            <div class="scores">
                ${scoreBox('ROUND SCORE', player.roundScore)}
                ${scoreBox('TOTAL SCORE', player.totalScore)}
                ${scoreBox('CARDS', `${player.regularCards.length}/${MAX_REGULAR_CARDS}`)}
            </div>

            <div class="cards-section">
                <div class="cards-container">
                    <div class="cards-label">REGULAR CARDS</div>
                    <div class="card-grid regular">
                        ${player.regularCards.map(card => `<div class="card">${card}</div>`).join('')}
                        ${emptyRegularSlots}
                    </div>
                </div>

                <div class="cards-container">
                    <div class="cards-label">SPECIAL CARDS</div>
                    <div class="card-grid special">
                        ${player.specialCards.map(card => {
                            const cardClass = getSpecialCardClass(card);
                            const cardDisplay = getSpecialCardDisplay(card);
                            
                            // Add inline style for special cards
                            let cardStyle = '';
                            if (card === 'Select') {
                                cardStyle = 'background: linear-gradient(135deg, #e74c3c 0%, #9b59b6 50%, #3498db 100%) !important; border-color: #e74c3c !important;';
                            } else if (card === 'Swap') {
                                cardStyle = 'background: #42ae5d !important; border-color: #42ae5d !important; color: white !important;';
                            } else if (card.endsWith('+') || card === '2x') {
                              cardStyle = 'background: #fbb03a !important; border-color: #fbb03a !important; color: white !important;';
                            } else if (card === 'ST') {
                              cardStyle = 'background: #e67e22 !important; color: white !important;';
                            } else if (card === '2÷' || card.endsWith('-')) {
                                cardStyle = 'background: #f1624f !important; border-color: #f1624f !important; color: white !important;';
                            }
                            
                            return `<div class="card special ${cardClass}" ${cardStyle ? `style="${cardStyle}"` : ''}>
                                ${cardDisplay}
                            </div>`;
                        }).join('')}
                        ${emptySpecialSlots}
                    </div>
                </div>
            </div>

            ${player.drawThreeRemaining > 0 ? `
                <div class="draw-three-indicator">
                    🎯 DRAW ${player.drawThreeRemaining} MORE CARDS
                </div>
            ` : ''}
        </div>
    `;
}

// Helper functions
function scoreBox(label, value) {
    return `
        <div class="score-box">
            <div>${label}</div>
            <div class="score-value">${value}</div>
        </div>
    `;
}

// Update special card class function to include all special cards
function getSpecialCardClass(card) {
    if (card === 'SC') return 'second-chance';
    if (card === 'Freeze') return 'freeze';
    if (card === 'D3') return 'draw-three';
    if (card === 'RC') return 'remove-card';
  if (card === 'ST') return 'steal-card';
    if (card === 'Swap') return 'swap-card';
    if (card === 'Select') return 'select-card';
    if (card === '2÷') return 'divide';
    if (card.endsWith('+')) return 'adder';
    if (card.endsWith('x')) return 'multiplier';
    if (card.endsWith('-')) return 'minus';
    return '';
}

// Update special card display function to include all special cards
function getSpecialCardDisplay(card) {
    // Special cards with emojis
    if (card === 'SC') return '🛡️';
    if (card === 'Freeze') return '❄️';
    if (card === 'D3') return '🎯';
    if (card === 'RC') return '🗑️';
  if (card === 'ST') return '🥷';
    if (card === 'Swap') return '⇄️';
    if (card === 'Select') return '🃏';
    
    // For numeric modifier cards, format them
    if (card.endsWith('+') || card.endsWith('x') || card.endsWith('-')) {
        const number = card.slice(0, -1);  // Get everything except last character
        const symbol = card.slice(-1);     // Get last character (+ or x or -)
        return `${number}${symbol}`;       // Combine them (e.g., "2+")
    }
    
    // For divide card
    if (card === '2÷') return '2÷';
    
    return card;
}

function getStatusIcon(status) {
    const statusMap = {
        active: ['⭐', 'ACTIVE'],
        stood: ['🛑', 'STOOD'], 
        busted: ['💥', 'BUSTED'],
        waiting: ['⏳', 'WAITING'],
        frozen: ['❄️', 'FROZEN'] // Add frozen status
    };
    return `
        <span class="status-icon">${statusMap[status][0]}</span>
        <span class="status-text">${statusMap[status][1]}</span>
    `;
}

function getStatusText(status) {
    return {
        active: 'ACTIVE',
        stood: 'STOOD', 
        busted: 'BUSTED',
        waiting: 'WAITING',
        frozen: 'FROZEN',
        finished: 'FINISHED' // Add new status
    }[status];
}

// UI controls
function toggleActionButtons(active) {
    const flipCardBtn = document.getElementById('flipCard');
    const standButton = document.getElementById('standButton');
    
    // Always show buttons but disable them when not active
    if (flipCardBtn) {
        flipCardBtn.disabled = !active;
        flipCardBtn.style.display = 'block';
    }
    if (standButton) {
        standButton.disabled = !active;
        standButton.style.display = 'block';
    }
}

// Add this helper function to get current game state
function getCurrentGameState() {
    const container = document.getElementById('playersContainer');
    const players = [...container.querySelectorAll('.player')].map(playerEl => {
        const isCurrentTurn = playerEl.classList.contains('current-turn');
        const drawThreeRemaining = parseInt(playerEl.querySelector('.draw-three-indicator')?.textContent.match(/\d+/) || 0);
        const status = playerEl.classList.contains('busted') ? 'busted' : 
                      playerEl.classList.contains('stood') ? 'stood' : 
                      playerEl.classList.contains('frozen') ? 'frozen' : 'active';
        return {
            id: playerEl.dataset.playerId,
            drawThreeRemaining,
            status
        };
    });
    
    const currentPlayerIndex = players.findIndex(p => 
        p.id === socket.id && document.querySelector(`.player[data-player-id="${p.id}"]`)?.classList.contains('current-turn')
    );

    return {
        players,
        currentPlayer: currentPlayerIndex
    };
}

// Game event handlers
function handleGameJoined(gameId) {
    currentGameId = gameId;
    document.querySelector('.lobby-screen').style.display = 'none';
}

function showWaitingScreen(gameData) {
    const waitingScreen = document.createElement('div');
    waitingScreen.className = 'waiting-screen';
    waitingScreen.id = 'waitingScreen';
    
    const content = `
        <h2>${isHost ? '🎮 Waiting Room' : '⏳ Waiting for Host'}</h2>
        ${isHost ? `
        <div class="share-section">
          <p class="share-text">Share this link with your friends:</p>
          <input id="shareLinkInput" class="share-link-input" readonly value="${currentGameUrl || (window.location.origin + '/join/' + gameData.id || '')}">
          <button id="copyLinkBtn" class="game-button copy-link-btn" type="button">
            Copy Game Link
          </button>
          <div class="copied-message">Link copied!</div>
        </div>
        ` : ''}
        <div class="players-list">
            ${gameData.players.map(player => `
                <div class="player-item">
                    ${player.name}
                    ${player.id === gameData.hostId ? 
                        '<span class="host-badge">HOST</span>' : ''}
                </div>
            `).join('')}
        </div>
        ${isHost ? `
            <div class="button-group">
                <button onclick="startGame()" id="startGameBtn" class="game-button green" 
                    ${gameData.players.length < 2 ? 'disabled' : ''}>
                    ${gameData.players.length < 2 ? 
                        'Waiting for Players <div class="loading-spinner"></div>' : 
                        'Start Game'}
                </button>
            </div>
        ` : `
            <p>Waiting for host to start the game<div class="loading-spinner"></div></p>
        `}
    `;
    
    waitingScreen.innerHTML = content;
    document.body.appendChild(waitingScreen);

    // Ensure start button calls startGame and is wired (in case innerHTML changes later)
    const startBtn = document.getElementById('startGameBtn');
    if (startBtn) {
      startBtn.addEventListener('click', (e) => {
        if (startBtn.disabled) return;
        startGame();
      });
    }

    const copyBtn = document.getElementById('copyLinkBtn');
    if (copyBtn) {
      copyBtn.addEventListener('click', (e) => {
        e.preventDefault();
        copyShareLink();
      });
    }

    // Hide the game area completely while in waiting room
    document.getElementById('gameArea').style.display = 'none';
    document.querySelector('.controls').style.display = 'none';

    // Update start button state when players join/leave
    updateStartButton(gameData.players.length);
}

// Update handleGameStarted to properly transition from waiting screen to game
function handleGameStarted(game) {
    // Remove waiting screen
    const waitingScreen = document.getElementById('waitingScreen');
    if (waitingScreen) {
        waitingScreen.remove();
    }

    // Show game area and controls
    document.getElementById('gameArea').style.display = 'flex';
    document.querySelector('.controls').style.display = 'flex';
    
    // Update game display
    updateGameDisplay(game);
    
    // Check if it's the current player's turn and update controls
    const isCurrentPlayer = game.players[game.currentPlayer]?.id === socket.id;
    toggleActionButtons(isCurrentPlayer && game.status === 'playing');
}

function updateStartButton(playerCount) {
    const startBtn = document.getElementById('startGameBtn');
    if (startBtn) {
        const disabled = playerCount < 2;
        startBtn.disabled = disabled;
        startBtn.innerHTML = disabled ? 
            'Waiting for Players <div class="loading-spinner"></div>' : 
            'Start Game';

        // Also update the button style based on state
        if (disabled) {
            startBtn.classList.add('disabled');
        } else {
            startBtn.classList.remove('disabled');
        }
    }
}

// Update checkUrlParams to handle both paths and search params
function checkUrlParams() {
    // First check for join in the path
    const pathMatch = window.location.pathname.match(/\/join\/([A-Z0-9]{5})/i);
    if (pathMatch) {
        const gameId = pathMatch[1].toUpperCase();
        const name = prompt('Enter your name to join the game:')?.trim();
        if (name) {
            socket.emit('join-game', gameId, name);
            // Clean up URL after emitting join
            window.history.replaceState({}, document.title, '/');
            return; // Exit early
        }
    }
    
    // Check for error params
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('error') === 'game-not-found') {
        alert('Game not found!');
        window.history.replaceState({}, document.title, '/');
    }
}

function handleNewRound(game) {
    // Update game display first
    updateGameDisplay(game);
    
    // Check if it's the current player's turn
    const isCurrentPlayer = game.players[game.currentPlayer]?.id === socket.id;
    
    // Toggle action buttons based on current player
    toggleActionButtons(isCurrentPlayer && game.status === 'playing');
}

function handleAllBusted() {
    const popup = document.createElement('div');
    popup.className = 'info-popup';
    popup.innerHTML = `
        <h2>💥 ALL PLAYERS BUSTED! 💥</h2>
        <p class="popup-countdown">Starting new round in 3...</p>
    `;
    document.body.appendChild(popup);
    
    let count = 2;
    const countdown = setInterval(() => {
        popup.querySelector('.popup-countdown').textContent = 
            `Starting new round in ${count}...`;
        if (count <= 0) {
            clearInterval(countdown);
            popup.remove();
        }
        count--;
    }, 1000);
}

function showWinnerPopup(winner, isHost) {
    // Get all players from the current game state
    const container = document.getElementById('playersContainer');
    const allPlayerElements = container.querySelectorAll('.player');
    const allPlayers = [];
    
    // Extract player data from the DOM
    allPlayerElements.forEach(playerEl => {
        const playerName = playerEl.querySelector('h3').textContent.replace('(YOU)', '').trim();
        const playerTotalScore = parseInt(playerEl.querySelectorAll('.score-value')[1].textContent);
        const playerId = playerEl.dataset.playerId;
        
        allPlayers.push({
            name: playerName,
            totalScore: playerTotalScore,
            id: playerId,
            isWinner: playerId === winner.id
        });
    });
    
    // Sort players by score (descending)
    allPlayers.sort((a, b) => b.totalScore - a.totalScore);
    
    // Create leaderboard HTML
    const topPlayers = allPlayers.slice(0, 3); // Get top 3 players
    const leaderboardHTML = topPlayers.map((player, index) => {
        const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : '🥉';
        const isCurrentPlayer = player.id === socket.id;
        const winnerClass = player.isWinner ? 'winner' : '';
        
        return `
            <div class="leaderboard-row ${winnerClass} ${isCurrentPlayer ? 'current-player' : ''}">
                <div class="rank">${medal}</div>
                <div class="player-name">${player.name} ${isCurrentPlayer ? '(YOU)' : ''}</div>
                <div class="player-score">${player.totalScore}</div>
            </div>
        `;
    }).join('');

    const popup = document.createElement('div');
    popup.className = 'winner-popup';
    popup.innerHTML = `
        <div class="popup-content">
            <div class="trophy-banner">🏆</div>
            <h2>WINNER!</h2>
            <div class="winner-name">${winner.name}</div>
            <div class="winner-score">${winner.totalScore} Points</div>
            
            <div class="leaderboard">
                <h3>Top Players</h3>
                <div class="leaderboard-container">
                    ${leaderboardHTML}
                </div>
            </div>
            
            ${isHost ? `
                <button id="rematchButton" class="game-button green">
                    Rematch?
                </button>
            ` : `
                <div class="waiting-message">
                    Waiting for host to start rematch...
                </div>
            `}
        </div>
    `;
    document.body.appendChild(popup);

    // Only add rematch button listener if host
    if (isHost) {
        document.getElementById('rematchButton').addEventListener('click', () => {
            socket.emit('request-rematch', currentGameId);
            popup.remove();
        });
    }
}

function handleGameOver({ players, winner }) {
    playSound('winSound');
    toggleActionButtons(false);
    showWinnerPopup(winner, isHost); // Pass isHost flag
}

function handleGameReset() {
    alert('Game has been reset by the host!');
    window.location.reload();
}

function handleError(message) {
    alert(message);
}

function showResetConfirmation() {
  const existingPopup = document.querySelector('.reset-confirmation-popup');
  if (existingPopup) existingPopup.remove();

    const popup = document.createElement('div');
    popup.className = 'reset-confirmation-popup';
    popup.innerHTML = `
        <div class="popup-content">
            <h2>Reset Game?</h2>
            <p>Start a new round with all players?</p>
            <div class="button-group">
        <button id="confirmResetBtn" class="game-button red" type="button">
                    Yes, Reset
                </button>
        <button id="cancelResetBtn" class="game-button blue" type="button">
                    Cancel
                </button>
            </div>
        </div>
    `;
    document.body.appendChild(popup);

  const confirmBtn = popup.querySelector('#confirmResetBtn');
  const cancelBtn = popup.querySelector('#cancelResetBtn');

  if (confirmBtn) {
    confirmBtn.addEventListener('click', (e) => {
      e.preventDefault();
      confirmReset();
    });
  }

  if (cancelBtn) {
    cancelBtn.addEventListener('click', (e) => {
      e.preventDefault();
      cancelReset();
    });
  }
}

function confirmReset() {
    const popup = document.querySelector('.reset-confirmation-popup');
    if (popup) popup.remove();
    resetGame();
}

function cancelReset() {
    const popup = document.querySelector('.reset-confirmation-popup');
    if (popup) popup.remove();
}

function handleRoundSummary({ players, allBusted }) {
    playSound(allBusted ? 'bustSound' : 'roundEnd');
    const popup = document.createElement('div');
    popup.className = 'round-summary-popup';
    
    const playerList = players.map(player => {
        const hasBonus = player.regularCards.length === MAX_REGULAR_CARDS;
        const status = hasBonus ? 'finished' : player.status;
        const newTotal = player.status !== 'busted' ? player.totalScore + player.roundScore : player.totalScore;
        
        return `
            <div class="player-summary-row">
                <div class="name">
                    ${player.name}
                    ${hasBonus ? '🌟+15' : ''}
                    ${player.bustedCard ? `(Busted on ${player.bustedCard})` : ''}
                </div>
                <div class="status ${status}">${getStatusText(status)}</div>
                <div class="points-container">
                    <span class="points-label">Round</span>
                    <span class="points">${player.roundScore}</span>
                </div>
                <div class="points-container">
                    <span class="points-label">Total</span>
                    <span class="points">${newTotal}</span>
                </div>
            </div>
        `;
    }).join('');

    popup.innerHTML = `
        <div class="popup-content">
            <h2>${allBusted ? '💥 ALL PLAYERS BUSTED! 💥' : '🏁 ROUND SUMMARY 🏁'}</h2>
            <div class="round-summary-header">
                <span>Player</span>
                <span>Status</span>
                <span>Round Points</span>
                <span>Total Points</span>
            </div>
            <div class="round-summary-list">${playerList}</div>
            <p class="countdown">Next round starting in <span id="countdown">5</span>...</p>
        </div>
    `;

    document.body.appendChild(popup);
    
    let count = 4;
    const countdownElement = popup.querySelector('#countdown');
    const interval = setInterval(() => {
        countdownElement.textContent = count;
        if (count <= 0) {
            clearInterval(interval);
            popup.remove();
        }
        count--;
    }, 1000);
}

function showFreezePopup(gameId, targets) {
  // Cleanup any existing popup
  if (activeFreezePopup) {
    activeFreezePopup.remove();
    activeFreezePopup = null;
  }

  // Create new popup
  activeFreezePopup = document.createElement('div');
  activeFreezePopup.id = 'freezePopup';
  activeFreezePopup.className = 'freeze-popup';
  activeFreezePopup.innerHTML = `
    <div class="popup-content">
      <h3><span class="emoji">❄️</span> Select a player to freeze:</h3>
      <div class="freeze-targets">
        ${targets.map(t => `
          <button class="freeze-target ${t.id === socket.id ? 'self-target' : ''}" data-id="${t.id}">
            ${t.name} ${t.id === socket.id ? '(You)' : ''}
          </button>
        `).join('')}
      </div>
      <button class="view-game-button" id="viewGameButton">
        <span class="icon">👁️</span> Hold to view game
      </button>
    </div>
  `;

  activeFreezePopup.querySelectorAll('.freeze-target').forEach(btn => {
    btn.addEventListener('click', () => {
      socket.emit('freeze-player', currentGameId, btn.dataset.id);
      activeFreezePopup.remove();
      activeFreezePopup = null;
    });
  });

  // Add HOLD TO VIEW GAME button functionality
  const viewButton = activeFreezePopup.querySelector('#viewGameButton');
  viewButton.addEventListener('mousedown', (e) => {
    e.preventDefault();
    activeFreezePopup.classList.add('popup-hiding');
  });
  
  viewButton.addEventListener('touchstart', (e) => {
    e.preventDefault();
    activeFreezePopup.classList.add('popup-hiding');
  });
  
  const handleUp = () => {
    if (activeFreezePopup && activeFreezePopup.parentElement) {
      activeFreezePopup.classList.remove('popup-hiding');
    }
  };
  
  document.addEventListener('mouseup', handleUp);
  document.addEventListener('touchend', handleUp);
  
  document.body.appendChild(activeFreezePopup);

  // Clean up event listeners when popup is removed
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if ([...mutation.removedNodes].includes(activeFreezePopup)) {
        document.removeEventListener('mouseup', handleUp);
        document.removeEventListener('touchend', handleUp);
        observer.disconnect();
      }
    });
  });
  
  observer.observe(document.body, { childList: true });

  // Add auto-removal listeners
  const cleanup = () => {
    if (activeFreezePopup) {
      activeFreezePopup.remove();
      activeFreezePopup = null;
    }
    socket.off('game-update', cleanup);
    socket.off('cancel-freeze', cleanup);
  };

  socket.once('game-update', cleanup);
  socket.once('cancel-freeze', cleanup);
}

// Update showRemoveCardPopup function to properly display special cards
function showRemoveCardPopup(gameId, players) {
  // Disable action buttons during popup
  document.body.style.overflow = 'hidden';
  toggleActionButtons(false);
  
  const popup = document.createElement('div');
  popup.className = 'remove-card-popup';
  
  const content = `
    <div class="popup-content">
      <h3><span class="emoji">🗑️</span> Select a card to remove:</h3>
      <div class="players-list">
        ${players.map(player => {
          const isDisabled = player.status === 'busted';
          return `
            <div class="player-section ${isDisabled ? 'disabled' : ''}" data-status="${player.status}">
              <h4>${player.name} ${player.id === socket.id ? '(You)' : ''} 
                  ${isDisabled ? `<span class="status-badge ${player.status}">${getStatusText(player.status)}</span>` : ''}
              </h4>
              <div class="cards-list">
                ${player.regularCards.map((card, index) => `
                  <button class="card-button regular" 
                    data-player="${player.id}" 
                    data-index="${index}"
                    data-special="false"
                    ${isDisabled ? 'disabled' : ''}>
                    ${card}
                  </button>
                `).join('')}
                ${player.specialCards.map((card, index) => {
                  const isRemoveCard = card === 'RC';
                  return `
                  <button class="card-button special ${getSpecialCardClass(card)}"
                    style="background: ${getCardColor(card)}; color: white;"
                    data-player="${player.id}" 
                    data-index="${index}"
                    data-special="true"
                    ${isDisabled || isRemoveCard ? 'disabled' : ''}>
                    ${getSpecialCardDisplay(card)}
                  </button>
                  `;
                }).join('')}
              </div>
              ${isDisabled ? `
                <div class="status-overlay">
                  <span class="status-message">Player is ${player.status.toUpperCase()}</span>
                </div>
              ` : ''}
            </div>
          `;
        }).join('')}
      </div>
      <button class="view-game-button" id="viewGameButton">
        <span class="icon">👁️</span> Hold to view game
      </button>
    </div>
  `;
  
  popup.innerHTML = content;

  // Add event listeners - only for enabled buttons
  popup.querySelectorAll('.card-button:not([disabled])').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.player;
      const cardIndex = parseInt(btn.dataset.index);
      const isSpecial = btn.dataset.special === 'true';
      
      socket.emit('remove-card', gameId, targetId, cardIndex, isSpecial);
      popup.remove();
    });
  });

  // Add HOLD TO VIEW GAME button functionality
  const viewButton = popup.querySelector('#viewGameButton');
  viewButton.addEventListener('mousedown', (e) => {
    e.preventDefault();
    popup.classList.add('popup-hiding');
  });
  
  viewButton.addEventListener('touchstart', (e) => {
    e.preventDefault();
    popup.classList.add('popup-hiding');
  });
  
  const handleUp = () => {
    if (popup.parentElement) {
      popup.classList.remove('popup-hiding');
    }
  };
  
  document.addEventListener('mouseup', handleUp);
  document.addEventListener('touchend', handleUp);
  
  document.body.appendChild(popup);
  
  // Clean up event listeners when popup is removed
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if ([...mutation.removedNodes].includes(popup)) {
        document.removeEventListener('mouseup', handleUp);
        document.removeEventListener('touchend', handleUp);
        document.body.style.overflow = 'auto';
        observer.disconnect();
      }
    });
  });
  
  observer.observe(document.body, { childList: true });
}

function showSwapCardPopup(gameId, players) {
  // Disable action buttons during popup
  document.body.style.overflow = 'hidden';
  toggleActionButtons(false);

  const popup = document.createElement('div');
  popup.className = 'swap-card-popup';

  let selectedCards = [];

  const isSwappable = (card) => {
    const cardStr = card.toString();
    return typeof card === 'number' || 
           cardStr === 'SC' || 
           cardStr === '2x' || 
           cardStr.includes('+') || 
           cardStr.includes('-') || 
           cardStr.includes('÷');
  };

  const content = `
    <div class="popup-content">
      <h3><span class="emoji">⇄️</span> Select 2 cards to swap (from different players):</h3>
      <div class="players-list">
        ${players.map(player => {
          const isDisabled = player.status === 'busted';
          const showStatusBadge = player.status !== 'active';
          const swappableRegular = player.regularCards.filter(isSwappable);
          const swappableSpecial = player.specialCards.filter(isSwappable);
          
          return `
            <div class="player-section ${isDisabled ? 'disabled' : ''}" data-status="${player.status}" data-player-id="${player.id}">
              <h4>${player.name} ${player.id === socket.id ? '(You)' : ''}
                  ${showStatusBadge ? `<span class="status-badge ${player.status}">${getStatusText(player.status)}</span>` : ''}
              </h4>
              <div class="cards-list">
                ${swappableRegular.map((card, index) => {
                  const actualIndex = player.regularCards.indexOf(card);
                  return `
                    <button class="card-button regular swap-selectable"
                      data-player="${player.id}"
                      data-index="${actualIndex}"
                      data-special="false"
                      data-initial-disabled="${isDisabled}"
                      ${isDisabled ? 'disabled' : ''}>
                      ${card}
                    </button>
                  `;
                }).join('')}
                ${swappableSpecial.map((card, index) => {
                  const actualIndex = player.specialCards.indexOf(card);
                  return `
                    <button class="card-button special ${getSpecialCardClass(card)} swap-selectable"
                      style="background: ${getCardColor(card)}; color: white;"
                      data-player="${player.id}"
                      data-index="${actualIndex}"
                      data-special="true"
                      data-initial-disabled="${isDisabled}"
                      ${isDisabled ? 'disabled' : ''}>
                      ${getSpecialCardDisplay(card)}
                    </button>
                  `;
                }).join('')}
              </div>
              ${isDisabled ? `
                <div class="status-overlay">
                  <span class="status-message">Player is ${player.status.toUpperCase()}</span>
                </div>
              ` : ''}
            </div>
          `;
        }).join('')}
      </div>
      <button class="confirm-swap-button" id="confirmSwapButton" disabled>
        <span class="icon">✓</span> Confirm Swap
      </button>
      <button class="view-game-button" id="viewGameButton">
        <span class="icon">👁️</span> Hold to view game
      </button>
    </div>
  `;

  popup.innerHTML = content;

  const confirmButton = popup.querySelector('#confirmSwapButton');

  const updateSwapSelectionState = () => {
    const selectedPlayerId = selectedCards.length === 1 ? selectedCards[0].playerId : null;
    popup.querySelectorAll('.swap-selectable').forEach(btn => {
      if (btn.dataset.initialDisabled === 'true') {
        return;
      }

      const isSelected = btn.classList.contains('selected');
      if (selectedPlayerId && btn.dataset.player === selectedPlayerId && !isSelected) {
        btn.dataset.tempDisabled = 'true';
        btn.setAttribute('disabled', '');
        btn.classList.add('same-player-disabled');
      } else if (btn.dataset.tempDisabled === 'true') {
        btn.removeAttribute('disabled');
        btn.dataset.tempDisabled = 'false';
        btn.classList.remove('same-player-disabled');
      }
    });
  };

  popup.querySelectorAll('.swap-selectable:not([disabled])').forEach(btn => {
    btn.addEventListener('click', () => {
      const playerId = btn.dataset.player;
      const cardIndex = parseInt(btn.dataset.index);
      const isSpecial = btn.dataset.special === 'true';

      // Check if card is already selected
      const alreadySelected = selectedCards.findIndex(c => 
        c.playerId === playerId && 
        c.index === cardIndex && 
        c.isSpecial === isSpecial
      );

      if (alreadySelected !== -1) {
        // Deselect
        selectedCards.splice(alreadySelected, 1);
        btn.classList.remove('selected');
      } else {
        // Check if already have 2 cards selected
        if (selectedCards.length >= 2) {
          // Remove first selection's highlight
          const firstCard = selectedCards.shift();
          const firstBtn = popup.querySelector(
            `.swap-selectable[data-player="${firstCard.playerId}"][data-index="${firstCard.index}"][data-special="${firstCard.isSpecial}"]`
          );
          if (firstBtn) firstBtn.classList.remove('selected');
        }

        // Prevent selecting a second card from the same player
        if (selectedCards.length === 1 && selectedCards[0].playerId === playerId) {
          return;
        }

        // Add new selection
        selectedCards.push({ playerId, index: cardIndex, isSpecial });
        btn.classList.add('selected');
      }

      // Enable confirm button only if 2 cards from different players are selected
      const canConfirm = selectedCards.length === 2 && 
                         selectedCards[0].playerId !== selectedCards[1].playerId;
      confirmButton.disabled = !canConfirm;
      updateSwapSelectionState();
    });
  });

  confirmButton.addEventListener('click', () => {
    if (selectedCards.length === 2 && selectedCards[0].playerId !== selectedCards[1].playerId) {
      socket.emit('swap-cards', gameId, {
        playerId: selectedCards[0].playerId,
        index: selectedCards[0].index,
        isSpecial: selectedCards[0].isSpecial
      }, {
        playerId: selectedCards[1].playerId,
        index: selectedCards[1].index,
        isSpecial: selectedCards[1].isSpecial
      });
      popup.remove();
    }
  });

  const viewButton = popup.querySelector('#viewGameButton');
  viewButton.addEventListener('mousedown', (e) => {
    e.preventDefault();
    popup.classList.add('popup-hiding');
  });

  viewButton.addEventListener('touchstart', (e) => {
    e.preventDefault();
    popup.classList.add('popup-hiding');
  });

  const handleUp = () => {
    if (popup.parentElement) {
      popup.classList.remove('popup-hiding');
    }
  };

  document.addEventListener('mouseup', handleUp);
  document.addEventListener('touchend', handleUp);

  document.body.appendChild(popup);

  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if ([...mutation.removedNodes].includes(popup)) {
        document.removeEventListener('mouseup', handleUp);
        document.removeEventListener('touchend', handleUp);
        document.body.style.overflow = 'auto';
        observer.disconnect();
      }
    });
  });

  observer.observe(document.body, { childList: true });
}

function showStealCardPopup(gameId, players) {
  // Disable action buttons during popup
  document.body.style.overflow = 'hidden';
  toggleActionButtons(false);

  const popup = document.createElement('div');
  popup.className = 'steal-card-popup';

  const content = `
    <div class="popup-content">
      <h3><span class="emoji">🥷</span> Select a card to steal:</h3>
      <div class="players-list">
        ${players.map(player => {
          const isDisabled = player.status === 'busted';
          const showStatusBadge = player.status !== 'active';
          return `
            <div class="player-section ${isDisabled ? 'disabled' : ''}" data-status="${player.status}">
              <h4>${player.name} ${player.id === socket.id ? '(You)' : ''}
                  ${showStatusBadge ? `<span class="status-badge ${player.status}">${getStatusText(player.status)}</span>` : ''}
              </h4>
              <div class="cards-list">
                ${player.regularCards.map((card, index) => `
                  <button class="card-button regular"
                    data-player="${player.id}"
                    data-index="${index}"
                    data-special="false"
                    ${isDisabled ? 'disabled' : ''}>
                    ${card}
                  </button>
                `).join('')}
                ${player.specialCards.map((card, index) => `
                  <button class="card-button special ${getSpecialCardClass(card)}"
                    style="background: ${getCardColor(card)}; color: white;"
                    data-player="${player.id}"
                    data-index="${index}"
                    data-special="true"
                    ${isDisabled ? 'disabled' : ''}>
                    ${getSpecialCardDisplay(card)}
                  </button>
                `).join('')}
              </div>
              ${isDisabled ? `
                <div class="status-overlay">
                  <span class="status-message">Player is ${player.status.toUpperCase()}</span>
                </div>
              ` : ''}
            </div>
          `;
        }).join('')}
      </div>
      <button class="view-game-button" id="viewGameButton">
        <span class="icon">👁️</span> Hold to view game
      </button>
    </div>
  `;

  popup.innerHTML = content;

  popup.querySelectorAll('.card-button:not([disabled])').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.player;
      const cardIndex = parseInt(btn.dataset.index);
      const isSpecial = btn.dataset.special === 'true';

      socket.emit('steal-card', gameId, targetId, cardIndex, isSpecial);
      popup.remove();
    });
  });

  const viewButton = popup.querySelector('#viewGameButton');
  viewButton.addEventListener('mousedown', (e) => {
    e.preventDefault();
    popup.classList.add('popup-hiding');
  });

  viewButton.addEventListener('touchstart', (e) => {
    e.preventDefault();
    popup.classList.add('popup-hiding');
  });

  const handleUp = () => {
    if (popup.parentElement) {
      popup.classList.remove('popup-hiding');
    }
  };

  document.addEventListener('mouseup', handleUp);
  document.addEventListener('touchend', handleUp);

  document.body.appendChild(popup);

  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if ([...mutation.removedNodes].includes(popup)) {
        document.removeEventListener('mouseup', handleUp);
        document.removeEventListener('touchend', handleUp);
        document.body.style.overflow = 'auto';
        observer.disconnect();
      }
    });
  });

  observer.observe(document.body, { childList: true });
}

// Add helper function to get card background color
function getCardColor(card) {
    if (card === 'SC') return '#e74c3c';
    if (card === 'Freeze') return '#3498db';
    if (card === 'D3') return '#f1c40f';
    if (card === 'RC') return '#9b59b6';
  if (card === 'ST') return '#e67e22';
    if (card === 'Swap') return '#42ae5d';
    if (card === 'Select') return 'linear-gradient(135deg, #e74c3c 0%, #9b59b6 50%, #3498db 100%)';
    if (card.endsWith('+')) return '#fbb03a';
    if (card.endsWith('x')) return '#fbb03a';
    if (card === '2÷') return '#f1624f';
    if (card.endsWith('-')) return '#f1624f';
    return 'inherit';
}

socket.on('select-remove-card-target', (gameId, players) => {
  showRemoveCardPopup(gameId, players);
});

socket.on('select-steal-card-target', (gameId, players) => {
  showStealCardPopup(gameId, players);
});

socket.on('select-swap-cards', (gameId, players) => {
  showSwapCardPopup(gameId, players);
});

socket.on('swap-notification', (data) => {
  const message = `${data.swapper} swapped ${data.player1}'s ${data.card1} with ${data.player2}'s ${data.card2}`;
  showNotification(message, 'info');
});

// Add this function to show the Select Card popup
function showSelectCardPopup(gameId, deck, fullDeck = null) {
  // If deck is empty but we have a fullDeck parameter (for last card scenario)
  // use the full deck instead
  const cardsToShow = (deck.length === 0 && fullDeck) ? fullDeck : deck;
  
  // Group cards by type
  const regularCards = [];
  const specialCards = [];
  
  // Count occurrence of each card
  const cardCounts = cardsToShow.reduce((acc, card) => {
    const cardStr = card.toString();
    acc[cardStr] = (acc[cardStr] || 0) + 1;
    return acc;
  }, {});

  // Sort card groups
  Object.entries(cardCounts).forEach(([cardStr, count]) => {
    if (cardStr === 'SC' || cardStr === 'Freeze' || cardStr === 'D3' || 
        cardStr === 'RC' || cardStr === 'ST' || cardStr === 'Swap' || cardStr === 'Select' ||
        cardStr.includes('+') || cardStr.includes('x') || cardStr.includes('-')) {
      specialCards.push({ card: cardStr, count });
    } else {
      regularCards.push({ card: parseInt(cardStr), count });
    }
  });
  
  // Sort regular cards numerically
  regularCards.sort((a, b) => a.card - b.card);
  
  // Sort special cards by same order as remaining pile
  const getSpecialCardOrder = card => {
    const specialOrder = {
        'Select': 1,    // 1. Select Card
        'SC': 2,        // 2. Second Chance
        'Freeze': 3,    // 3. Freeze
        'D3': 4,        // 4. Draw Three
        'RC': 5,        // 5. Remove Card
        'ST': 6,        // 6. Steal Card
        'Swap': 7,      // 7. Swap Card
        '2+': 8,        // 8. 2+
        '4+': 9,        // 9. 4+
        '6+': 10,       // 10. 6+
        '8+': 11,       // 11. 8+
        '10+': 12,      // 12. 10+
        '2x': 13,       // 13. 2x Multiplier
        '2-': 14,       // 14. 2-
        '4-': 15,       // 15. 4-
        '6-': 16,       // 16. 6-
        '8-': 17,       // 17. 8-
        '10-': 18,      // 18. 10-
        '2÷': 19,       // 19. 2÷ Divide
    };
    return specialOrder[card] || 99;
  };
  specialCards.sort((a, b) => getSpecialCardOrder(a.card) - getSpecialCardOrder(b.card));
  
  // Create popup
  const popup = document.createElement('div');
  popup.className = 'select-card-popup';
  popup.id = 'selectCardPopup';
  
  popup.innerHTML = `
    <div class="popup-content">
      <h3><span class="emoji">🃏</span> Select Any Card From The Deck</h3>
      
      <div class="card-section">
        <div class="section-title">Regular Cards</div>
        <div class="cards-list">
          ${regularCards.map(({ card, count }) => `
            <button class="card-button regular" data-card="${card}">
              ${card}
              ${count > 1 ? `<span class="card-count">×${count}</span>` : ''}
            </button>
          `).join('')}
        </div>
      </div>
      
      <div class="card-section">
        <div class="section-title">Special Cards</div>
        <div class="cards-list">
          ${specialCards.map(({ card, count }) => {
            const cardClass = getSpecialCardClass(card);
            const cardDisplay = getSpecialCardDisplay(card);
            const cardStyle = getCardColorStyle(card);
            
            return `
              <button class="card-button special ${cardClass}" 
                     data-card="${card}" 
                     style="${cardStyle}">
                ${cardDisplay}
                ${count > 1 ? `<span class="card-count">×${count}</span>` : ''}
              </button>
            `;
          }).join('')}
        </div>
      </div>
      
      <button class="view-game-button" id="viewGameButton">
        <span class="icon">👁️</span> Hold to view game
      </button>
    </div>
  `;
  
  // Add event listeners to card options
  popup.querySelectorAll('.card-button').forEach(button => {
    button.addEventListener('click', () => {
      const selectedCard = button.dataset.card;
      // For regular cards, convert to number
      const finalCard = isNaN(selectedCard) ? selectedCard : parseInt(selectedCard);
      
      // Close the popup first
      popup.remove();
      
      // Handle selected card
      handleSelectedCard(gameId, finalCard);
    });
  });
  
  // Add HOLD TO VIEW GAME button functionality
  const viewButton = popup.querySelector('#viewGameButton');
  viewButton.addEventListener('mousedown', (e) => {
    e.preventDefault(); // Prevent default behavior
    popup.classList.add('popup-hiding');
  });
  
  viewButton.addEventListener('touchstart', (e) => {
    e.preventDefault(); // Prevent default behavior
    popup.classList.add('popup-hiding');
  });
  
  // Handle mouseup and touchend on the button or anywhere on the document
  const handleUp = () => {
    if (popup.parentElement) { // Check if popup is still in the DOM
      popup.classList.remove('popup-hiding');
    }
  };
  
  // Add event listeners for mouseup and touchend
  document.addEventListener('mouseup', handleUp);
  document.addEventListener('touchend', handleUp);
  
  // Add a cleanup function to remove event listeners when popup is removed
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if ([...mutation.removedNodes].includes(popup)) {
        document.removeEventListener('mouseup', handleUp);
        document.removeEventListener('touchend', handleUp);
        document.body.style.overflow = 'auto';
        observer.disconnect();
      }
    });
  });
  
  document.body.appendChild(popup);
  
  // Start observing the popup for removal
  observer.observe(document.body, { childList: true });
}

// New function to handle selected cards
function handleSelectedCard(gameId, selectedCard) {
  // First send the selection to the server
  socket.emit('select-card-choice', gameId, selectedCard);
  
  // Remove the select card popup if it exists
  const selectCardPopup = document.getElementById('selectCardPopup');
  if (selectCardPopup) {
    selectCardPopup.remove();
  }
  
  // Then immediately show appropriate popup for special cards
  if (selectedCard === 'D3') {
    // No need to wait for server response - we can show the D3 popup right away
    socket.emit('request-draw-three-targets', gameId);
  } else if (selectedCard === 'Freeze') {
    // Show freeze popup immediately
    socket.emit('request-freeze-targets', gameId);
  } else if (selectedCard === 'RC') {
    // Show remove card popup immediately
    socket.emit('request-remove-card-targets', gameId);
  } else if (selectedCard === 'ST') {
    // Show steal card popup immediately
    socket.emit('request-steal-card-targets', gameId);
  } else if (selectedCard === 'Swap') {
    // Show swap card popup immediately
    socket.emit('request-swap-targets', gameId);
  }
  // For other cards, no immediate action needed
}

// Add helper function for card color styling
function getCardColorStyle(card) {
  if (card === 'SC') return 'background: #e74c3c !important;';
  if (card === 'Freeze') return 'background: #3498db !important;';
  if (card === 'D3') return 'background: #f1c40f !important; color: #2c3e50 !important;';
  if (card === 'RC') return 'background: #9b59b6 !important; color: white !important;';
  if (card === 'ST') return 'background: #e67e22 !important; color: white !important;';
  if (card === 'Swap') return 'background: #42ae5d !important; color: white !important;';
  if (card === 'Select') return 'background: linear-gradient(135deg, #e74c3c 0%, #9b59b6 50%, #3498db 100%) !important;';
  if (card.endsWith('+')) return 'background: #fbb03a !important; color: white !important;';
  if (card.endsWith('x')) return 'background: #fbb03a !important; color: white !important;';
  if (card === '2÷') return 'background: #f1624f !important; color: white !important;';
  if (card.endsWith('-')) return 'background: #f1624f !important; color: white !important;';
  return '';
}

function showTutorial() {
    const existingPopup = document.querySelector('.tutorial-popup');
    if (existingPopup) existingPopup.remove();

    const popup = document.createElement('div');
    popup.className = 'tutorial-popup';
    popup.innerHTML = `
        <div class="popup-content">
            <button class="close-button">×</button>
            <h2 class="tutorial-title">HOW TO PLAY</h2>
            
            <div class="tutorial-content">
                <section class="tutorial-section">
                    <h3>🎮 OBJECTIVE</h3>
                    <p>Be the first to reach 200 points!</p>
                </section>

                <section class="tutorial-section">
                    <h3>📋 GAME FLOW</h3>
                    <ul>
                        <li>Draw cards to collect points</li>
                        <li>Max 7 regular cards per hand</li>
                        <li>Duplicate number = BUST</li>
                        <li>Stand to bank your points</li>
                        <li>7 cards filled = +15 bonus!</li>
                    </ul>
                </section>

                <section class="tutorial-section">
                    <h3>🃏 REGULAR CARDS</h3>
                    <p><strong>Zero:</strong> Worth 0, can't bust you (1 copy)</p>
                    <p><strong>1-12:</strong> Worth face value (e.g., 7 copies of "7")</p>
                    <p><strong>Rule:</strong> Drawing a duplicate = Lose all round points!</p>
                </section>

                <section class="tutorial-section">
                    <h3>⭐ SPECIAL CARDS</h3>
                    <table class="card-table">
                        <tr>
                            <td><strong>🃏 Select</strong></td>
                            <td>Pick any card from deck</td>
                        </tr>
                        <tr>
                            <td><strong>🛡️ 2nd Chance</strong></td>
                            <td>Undo one bust</td>
                        </tr>
                        <tr>
                            <td><strong>❄️ Freeze</strong></td>
                            <td>Skip opponent's turn</td>
                        </tr>
                        <tr>
                            <td><strong>🎯 Draw 3</strong></td>
                            <td>Force 3 draws</td>
                        </tr>
                        <tr>
                            <td><strong>🗑️ Remove</strong></td>
                            <td>Delete opponent card</td>
                        </tr>
                        <tr>
                          <td><strong>🥷 Steal</strong></td>
                          <td>Steal a card from another player</td>
                        </tr>
                        <tr>
                            <td><strong>2+ / 4+ / 6+ / 8+ / 10+</strong></td>
                            <td>Add points</td>
                        </tr>
                        <tr>
                            <td><strong>2- / 4- / 6- / 8- / 10-</strong></td>
                            <td>Lose points</td>
                        </tr>
                        <tr>
                            <td><strong>2×</strong></td>
                            <td>Double score</td>
                        </tr>
                        <tr>
                            <td><strong>2÷</strong></td>
                            <td>Halve score (rounded)</td>
                        </tr>
                    </table>
                </section>

                <section class="tutorial-section">
                    <h3>🧮 SCORING EXAMPLE</h3>
                    <p><strong>Your hand:</strong> [3, 5, 7] + 2+ + 2×</p>
                    <p>3 + 5 + 7 = 15</p>
                    <p>15 + 2 = 17</p>
                    <p>17 × 2 = <strong>34 points!</strong></p>
                </section>

                <section class="tutorial-section">
                    <h3>💡 PRO TIPS</h3>
                    <ul>
                        <li>Save 2nd Chance for high scores</li>
                        <li>Go for 7 cards = +15 bonus</li>
                        <li>Grab multipliers early</li>
                        <li>Use Freeze on leaders</li>
                        <li>Balance risk vs. reward</li>
                    </ul>
                </section>
            </div>
        </div>
    `;

    // Close button functionality
    popup.querySelector('.close-button').addEventListener('click', () => {
        playSound('buttonClick');
        popup.remove();
        document.removeEventListener('keydown', handleEscape);
    });

    // Close on escape key
    const handleEscape = (e) => {
        if (e.key === 'Escape') {
            popup.remove();
            document.removeEventListener('keydown', handleEscape);
        }
    };
    document.addEventListener('keydown', handleEscape);

    document.body.appendChild(popup);
}

function playSound(soundId) {
    if (!soundEnabled) return;
    const sound = document.getElementById(soundId);
    if (sound) {
        sound.volume = 0.5; // Set volume to 50%
        sound.currentTime = 0; // Reset sound to start
        sound.play().catch(e => console.log('Sound play failed:', e));
    }
}

// Add sound toggle functionality
function toggleSound() {
    soundEnabled = !soundEnabled;
    const icon = document.querySelector('.sound-toggle i');
    icon.textContent = soundEnabled ? '🔊' : '🔇';
    playSound('buttonClick');
}

// Remove sound from handleNumberCard since server will handle it
function handleNumberCard(game, player, card) {
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
            game.discardPile.push('SC');
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
}

socket.on('select-draw-three-target', (gameId, targets) => {
  // Disable action buttons during popup
  document.body.style.overflow = 'hidden';
  toggleActionButtons(false);
  
  if (activeDrawThreePopup) {
    activeDrawThreePopup.remove();
    activeDrawThreePopup = null;
  }

  const popup = document.createElement('div');
  popup.className = 'draw-three-popup active';
  popup.innerHTML = `
    <div class="popup-content">
      <h3><span class="emoji">🎯</span> Select player to draw three cards:</h3>
      <div class="draw-three-targets">
        ${targets.map(p => `
          <button class="draw-three-target ${p.id === socket.id ? 'self-target' : ''}" data-id="${p.id}">
            ${p.name} ${p.id === socket.id ? '(You)' : ''}
          </button>
        `).join('')}
      </div>
      <button class="view-game-button" id="viewGameButton">
        <span class="icon">👁️</span> Hold to view game
      </button>
    </div>
  `;

  popup.querySelectorAll('.draw-three-target').forEach(btn => {
    btn.addEventListener('click', () => {
      socket.emit('draw-three-select', currentGameId, btn.dataset.id);
      popup.remove();
    });
  });

  // Add HOLD TO VIEW GAME button functionality
  const viewButton = popup.querySelector('#viewGameButton');
  viewButton.addEventListener('mousedown', (e) => {
    e.preventDefault();
    popup.classList.add('popup-hiding');
  });
  
  viewButton.addEventListener('touchstart', (e) => {
    e.preventDefault();
    popup.classList.add('popup-hiding');
  });
  
  const handleUp = () => {
    if (popup.parentElement) {
      popup.classList.remove('popup-hiding');
    }
  };
  
  document.addEventListener('mouseup', handleUp);
  document.addEventListener('touchend', handleUp);

  document.body.appendChild(popup);
  activeDrawThreePopup = popup;
  
  // Clean up event listeners when popup is removed
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if ([...mutation.removedNodes].includes(popup)) {
        document.removeEventListener('mouseup', handleUp);
        document.removeEventListener('touchend', handleUp);
        document.body.style.overflow = 'auto';
        observer.disconnect();
      }
    });
  });
  
  observer.observe(document.body, { childList: true });
});