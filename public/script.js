/**
 * БУНКЕР: Поколение Альфа - Многопользовательская игра
 * Клиентская логика с Socket.IO
 */

// ========================================
// GLOBAL STATE
// ========================================
const state = {
    socket: null,
    connected: false,
    
    // Player info
    playerId: null,
    playerName: null,
    playerAvatar: null,
    
    // Room info
    roomCode: null,
    isHost: false,
    isReady: false,
    
    // Game state
    gameMode: 'basic',
    maxPlayers: 6,
    players: [],
    myCards: null,
    revealedCards: [],
    
    // Current game
    gameState: null,
    currentRound: 1,
    currentPhase: 'waiting',
    catastrophe: null,
    
    // Voting
    hasVoted: false,
    votingResults: null
};

// ========================================
// INITIALIZATION
// ========================================
document.addEventListener('DOMContentLoaded', async () => {
    // Initialize Telegram WebApp
    initTelegramWebApp();
    
    // Initialize Socket.IO
    initSocket();
    
    // Setup UI
    setupCodeInputs();
    setupEventListeners();
    
    // Check URL params for room code
    checkUrlParams();
});

function initTelegramWebApp() {
    if (window.Telegram?.WebApp) {
        Telegram.WebApp.ready();
        Telegram.WebApp.expand();
        Telegram.WebApp.enableClosingConfirmation();
        
        // Get user info from Telegram
        const user = Telegram.WebApp.initDataUnsafe?.user;
        if (user) {
            state.playerId = user.id.toString();
            state.playerName = user.first_name + (user.last_name ? ' ' + user.last_name : '');
            state.playerAvatar = '👤';
        }
        
        // Set colors
        Telegram.WebApp.setHeaderColor('#1a1a2e');
        Telegram.WebApp.setBackgroundColor('#1a1a2e');
    }
    
    // Fallback if not in Telegram
    if (!state.playerId) {
        state.playerId = 'local_' + Math.random().toString(36).substr(2, 9);
        state.playerName = 'Игрок';
        state.playerAvatar = '👤';
    }
}

function initSocket() {
    updateConnectionStatus('connecting');
    
    // Connect to Socket.IO server
    state.socket = io({
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: 5,
        reconnectionDelay: 1000
    });
    
    state.socket.on('connect', () => {
        console.log('✅ Connected to server');
        state.connected = true;
        updateConnectionStatus('connected');
    });
    
    state.socket.on('disconnect', () => {
        console.log('❌ Disconnected from server');
        state.connected = false;
        updateConnectionStatus('disconnected');
    });
    
    state.socket.on('connect_error', (error) => {
        console.error('Connection error:', error);
        updateConnectionStatus('error');
    });
    
    // Room events
    state.socket.on('room-update', handleRoomUpdate);
    state.socket.on('player-joined', handlePlayerJoined);
    state.socket.on('game-started', handleGameStarted);
    state.socket.on('game-update', handleGameUpdate);
    state.socket.on('voting-progress', handleVotingProgress);
}

function updateConnectionStatus(status) {
    const indicator = document.querySelector('#connection-status .indicator');
    const text = document.querySelector('#connection-status .text');
    
    if (!indicator || !text) return;
    
    indicator.className = 'indicator ' + status;
    
    const texts = {
        'connecting': 'Подключение...',
        'connected': 'Онлайн',
        'disconnected': 'Нет связи',
        'error': 'Ошибка подключения'
    };
    text.textContent = texts[status] || status;
}

function checkUrlParams() {
    const params = new URLSearchParams(window.location.search);
    const roomCode = params.get('room');
    const action = params.get('action');
    const name = params.get('name');
    const playerId = params.get('playerId');
    
    if (name) state.playerName = decodeURIComponent(name);
    if (playerId) state.playerId = playerId;
    
    if (roomCode) {
        // Auto-join room
        state.roomCode = roomCode.toUpperCase();
        document.querySelectorAll('.code-char').forEach((input, i) => {
            input.value = roomCode[i] || '';
        });
        joinRoom();
    } else if (action === 'create') {
        showScreen('create-room-screen');
    }
}

// ========================================
// SCREEN NAVIGATION
// ========================================
function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(screen => {
        screen.classList.remove('active');
    });
    
    const target = document.getElementById(screenId);
    if (target) {
        target.classList.add('active');
    }
    
    // Update Telegram back button
    if (window.Telegram?.WebApp) {
        if (screenId === 'main-screen') {
            Telegram.WebApp.BackButton.hide();
        } else {
            Telegram.WebApp.BackButton.show();
        }
    }
}

// ========================================
// ROOM CREATION
// ========================================
function selectMode(mode) {
    state.gameMode = mode;
    document.querySelectorAll('.mode-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    document.querySelector(`[data-mode="${mode}"]`)?.classList.add('active');
}

function changePlayers(delta) {
    const current = parseInt(document.getElementById('players-count').textContent);
    const newCount = Math.max(4, Math.min(10, current + delta));
    
    document.getElementById('players-count').textContent = newCount;
    document.getElementById('bunker-slots').textContent = Math.floor(newCount / 2);
    document.getElementById('exiled-count').textContent = newCount - Math.floor(newCount / 2);
    
    state.maxPlayers = newCount;
}

function createRoom() {
    if (!state.connected) {
        showNotification('Нет подключения к серверу', 'error');
        return;
    }
    
    showLoading(true);
    
    const maxPlayers = parseInt(document.getElementById('players-count').textContent);
    
    state.socket.emit('create-room', {
        playerId: state.playerId,
        playerName: state.playerName,
        avatar: state.playerAvatar,
        maxPlayers: maxPlayers,
        gameMode: state.gameMode
    }, (response) => {
        showLoading(false);
        
        if (response.success) {
            state.roomCode = response.roomCode;
            state.isHost = true;
            state.players = response.players;
            
            showLobby();
        } else {
            showNotification(response.error || 'Ошибка создания комнаты', 'error');
        }
    });
}

// ========================================
// JOIN ROOM
// ========================================
function setupCodeInputs() {
    const inputs = document.querySelectorAll('.code-char');
    
    inputs.forEach((input, index) => {
        input.addEventListener('input', (e) => {
            e.target.value = e.target.value.toUpperCase();
            if (e.target.value && index < inputs.length - 1) {
                inputs[index + 1].focus();
            }
        });
        
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Backspace' && !e.target.value && index > 0) {
                inputs[index - 1].focus();
            }
        });
        
        input.addEventListener('paste', (e) => {
            e.preventDefault();
            const pasted = e.clipboardData.getData('text').toUpperCase().slice(0, 6);
            pasted.split('').forEach((char, i) => {
                if (inputs[i]) inputs[i].value = char;
            });
        });
    });
}

function joinRoom() {
    if (!state.connected) {
        showNotification('Нет подключения к серверу', 'error');
        return;
    }
    
    const inputs = document.querySelectorAll('.code-char');
    const code = Array.from(inputs).map(i => i.value).join('').toUpperCase();
    
    if (code.length !== 6) {
        showNotification('Введите полный код комнаты', 'error');
        return;
    }
    
    showLoading(true);
    
    state.socket.emit('join-room', {
        roomCode: code,
        playerId: state.playerId,
        playerName: state.playerName,
        avatar: state.playerAvatar
    }, (response) => {
        showLoading(false);
        
        if (response.success) {
            state.roomCode = response.roomCode;
            state.isHost = response.player?.isHost || false;
            state.players = response.players;
            state.gameMode = response.gameMode;
            
            if (response.status === 'playing' && response.gameState) {
                // Reconnect to active game
                state.gameState = response.gameState;
                state.myCards = response.myCards;
                state.revealedCards = response.revealedCards || [];
                showGameScreen();
            } else {
                showLobby();
            }
        } else {
            showNotification(response.error || 'Ошибка подключения', 'error');
        }
    });
}

// ========================================
// LOBBY
// ========================================
function showLobby() {
    showScreen('lobby-screen');
    
    // Update room code display
    document.querySelector('#lobby-room-code .code').textContent = state.roomCode;
    
    // Update game info
    document.getElementById('lobby-mode').textContent = state.gameMode === 'basic' ? 'Базовый' : 'История выживания';
    document.getElementById('lobby-slots').textContent = Math.floor(state.maxPlayers / 2);
    
    renderLobbyPlayers();
    updateLobbyActions();
}

function renderLobbyPlayers() {
    const container = document.getElementById('lobby-players');
    const countEl = document.getElementById('players-count-lobby');
    
    countEl.textContent = `${state.players.length}/${state.maxPlayers}`;
    
    container.innerHTML = '';
    
    state.players.forEach(player => {
        const div = document.createElement('div');
        div.className = `lobby-player ${player.isConnected ? '' : 'disconnected'}`;
        div.innerHTML = `
            <div class="avatar">${player.avatar}</div>
            <div class="info">
                <span class="name">${player.name} ${player.isHost ? '👑' : ''}</span>
                <span class="status">${player.isReady ? '✅ Готов' : player.isConnected ? 'Ожидание...' : 'Отключен'}</span>
            </div>
        `;
        container.appendChild(div);
    });
}

function updateLobbyActions() {
    const btnReady = document.getElementById('btn-ready');
    const btnStart = document.getElementById('btn-start-game');
    
    if (state.isHost) {
        btnReady.classList.add('hidden');
        
        // Show start button only if enough players
        const connectedPlayers = state.players.filter(p => p.isConnected).length;
        if (connectedPlayers >= 4) {
            btnStart.classList.remove('hidden');
        } else {
            btnStart.classList.add('hidden');
        }
    } else {
        btnReady.classList.remove('hidden');
        btnStart.classList.add('hidden');
        
        btnReady.innerHTML = state.isReady 
            ? '<span class="icon">⏸️</span><span>Не готов</span>'
            : '<span class="icon">✅</span><span>Готов</span>';
    }
}

function toggleReady() {
    state.isReady = !state.isReady;
    
    state.socket.emit('player-ready', { isReady: state.isReady }, (response) => {
        if (response.success) {
            updateLobbyActions();
        }
    });
}

function startGame() {
    if (!state.isHost) return;
    
    const connectedPlayers = state.players.filter(p => p.isConnected).length;
    if (connectedPlayers < 4) {
        showNotification('Нужно минимум 4 игрока', 'error');
        return;
    }
    
    showLoading(true);
    
    state.socket.emit('start-game', {}, (response) => {
        showLoading(false);
        
        if (!response.success) {
            showNotification(response.error || 'Ошибка запуска игры', 'error');
        }
    });
}

function leaveRoom() {
    if (state.roomCode) {
        state.socket.emit('leave-room', { roomCode: state.roomCode, playerId: state.playerId });
    }
    
    // Reset state
    state.roomCode = null;
    state.isHost = false;
    state.isReady = false;
    state.players = [];
    state.gameState = null;
    state.myCards = null;
    
    showScreen('main-screen');
}

function copyRoomCode() {
    if (state.roomCode) {
        navigator.clipboard.writeText(state.roomCode).then(() => {
            showNotification('Код скопирован!', 'success');
        });
    }
}

// ========================================
// SOCKET EVENT HANDLERS
// ========================================
function handleRoomUpdate(data) {
    state.players = data.players;
    state.maxPlayers = data.maxPlayers;
    state.gameMode = data.gameMode;
    
    if (document.getElementById('lobby-screen').classList.contains('active')) {
        renderLobbyPlayers();
        updateLobbyActions();
    }
}

function handlePlayerJoined(data) {
    showNotification(`${data.player.name} присоединился!`, 'success');
}

function handleGameStarted(data) {
    state.gameState = data.gameState;
    state.myCards = data.myCards;
    state.players = data.players;
    state.revealedCards = [];
    state.currentRound = 1;
    state.hasVoted = false;
    
    showGameScreen();
    showNotification('Игра началась!', 'success');
}

function handleGameUpdate(data) {
    state.gameState = data.gameState;
    state.players = data.players;
    state.revealedCards = data.myRevealedCards || state.revealedCards;
    
    updateGameUI();
}

function handleVotingProgress(data) {
    const progressEl = document.getElementById('voting-progress-fill');
    if (progressEl) {
        const percent = (data.votedCount / data.totalCount) * 100;
        progressEl.style.width = percent + '%';
    }
    
    const textEl = document.querySelector('.voting-progress .progress-text');
    if (textEl) {
        textEl.textContent = `Голосование... ${data.votedCount}/${data.totalCount}`;
    }
}

// ========================================
// GAME SCREEN
// ========================================
function showGameScreen() {
    showScreen('game-screen');
    updateGameUI();
}

function updateGameUI() {
    if (!state.gameState) return;
    
    const gs = state.gameState;
    
    // Update round and phase
    document.getElementById('current-round').textContent = gs.currentRound;
    document.getElementById('current-phase').textContent = getPhaseName(gs.currentPhase);
    
    // Update catastrophe
    if (gs.catastrophe) {
        const catBanner = document.getElementById('game-catastrophe');
        catBanner.querySelector('.icon').textContent = gs.catastrophe.icon;
        catBanner.querySelector('.name').textContent = gs.catastrophe.name;
    }
    
    // Update bunker and threat cards
    updateBunkerThreatCards(gs);
    
    // Render my cards
    renderMyCards();
    
    // Render players
    renderGamePlayers();
    
    // Render actions
    renderGameActions();
}

function getPhaseName(phase) {
    const names = {
        'waiting': 'Ожидание',
        'exploration': 'Исследование',
        'reveal': 'Открытие карт',
        'discussion': 'Обсуждение',
        'voting': 'Голосование',
        'finished': 'Игра окончена'
    };
    return names[phase] || phase;
}

function updateBunkerThreatCards(gs) {
    const bunkerCard = document.getElementById('bunker-card');
    const threatCard = document.getElementById('threat-card');
    
    if (gs.revealedBunker && gs.revealedBunker.length >= gs.currentRound) {
        const bunker = gs.revealedBunker[gs.currentRound - 1];
        bunkerCard.querySelector('.name').textContent = bunker.name;
        bunkerCard.querySelector('.icon').textContent = bunker.icon;
        bunkerCard.classList.add('revealed');
    } else {
        bunkerCard.querySelector('.name').textContent = '???';
        bunkerCard.classList.remove('revealed');
    }
    
    if (gs.revealedThreats && gs.revealedThreats.length >= gs.currentRound) {
        const threat = gs.revealedThreats[gs.currentRound - 1];
        threatCard.querySelector('.name').textContent = threat.name;
        threatCard.querySelector('.icon').textContent = threat.icon;
        threatCard.classList.add('revealed');
    } else {
        threatCard.querySelector('.name').textContent = '???';
        threatCard.classList.remove('revealed');
    }
}

function renderMyCards() {
    const container = document.getElementById('my-cards');
    if (!container || !state.myCards) return;
    
    container.innerHTML = '';
    
    const cardTypes = [
        { key: 'superpowers', name: 'Суперсила' },
        { key: 'phobias', name: 'Фобия' },
        { key: 'character', name: 'Характер' },
        { key: 'hobbies', name: 'Хобби' },
        { key: 'luggage', name: 'Багаж' },
        { key: 'facts', name: 'Факт' }
    ];
    
    cardTypes.forEach(type => {
        const card = state.myCards[type.key];
        const isRevealed = state.revealedCards.includes(type.key);
        
        const div = document.createElement('div');
        div.className = `my-card ${isRevealed ? 'revealed' : 'hidden'}`;
        div.onclick = () => isRevealed && showCardModal(card);
        
        div.innerHTML = `
            <div class="card-inner">
                <div class="card-front">
                    <span class="icon">${isRevealed ? card.icon : '?'}</span>
                    <span class="name">${isRevealed ? card.name : type.name}</span>
                    <span class="type">${type.name}</span>
                </div>
            </div>
        `;
        
        container.appendChild(div);
    });
}

function renderGamePlayers() {
    const container = document.getElementById('game-players');
    if (!container) return;
    
    container.innerHTML = '';
    
    state.players.forEach((player, index) => {
        const isMe = player.id === state.playerId;
        const isActive = index === state.gameState?.activePlayerIndex && !player.isExiled;
        
        const div = document.createElement('div');
        div.className = `game-player ${isMe ? 'me' : ''} ${isActive ? 'active' : ''} ${player.isExiled ? 'exiled' : ''}`;
        
        let revealedHTML = '';
        if (player.revealedCards) {
            player.revealedCards.forEach(cardType => {
                // Показываем только иконку, без деталей
                revealedHTML += `<span class="mini-revealed">✓</span>`;
            });
        }
        
        div.innerHTML = `
            <div class="avatar">${player.avatar}</div>
            <div class="info">
                <span class="name">${player.name} ${isMe ? '(Вы)' : ''}</span>
                <div class="revealed-count">${revealedHTML}</div>
            </div>
            ${player.isExiled ? '<span class="status">❌ Изгнан</span>' : ''}
        `;
        
        container.appendChild(div);
    });
}

function renderGameActions() {
    const container = document.getElementById('game-actions');
    if (!container || !state.gameState) return;
    
    container.innerHTML = '';
    
    const gs = state.gameState;
    const players = state.players.filter(p => !p.isExiled);
    const activePlayer = players[gs.activePlayerIndex];
    const isMyTurn = activePlayer?.id === state.playerId;
    
    if (gs.currentPhase === 'exploration') {
        if (isMyTurn) {
            container.innerHTML = `
                <button class="btn btn-primary" onclick="exploreBunker()">
                    <span class="icon">🔍</span>
                    <span>Исследовать бункер</span>
                </button>
            `;
        } else {
            container.innerHTML = `
                <div class="waiting-message">
                    <span>⏳ ${activePlayer?.name || 'Игрок'} исследует бункер...</span>
                </div>
            `;
        }
    } else if (gs.currentPhase === 'reveal') {
        if (isMyTurn) {
            container.innerHTML = `
                <button class="btn btn-primary" onclick="showRevealDialog()">
                    <span class="icon">🃏</span>
                    <span>Открыть карту</span>
                </button>
            `;
        } else {
            container.innerHTML = `
                <div class="waiting-message">
                    <span>⏳ Ход ${activePlayer?.name || 'игрока'}...</span>
                </div>
            `;
        }
    } else if (gs.currentPhase === 'voting') {
        if (!state.hasVoted) {
            container.innerHTML = `
                <button class="btn btn-primary" onclick="showVotingScreen()">
                    <span class="icon">🗳️</span>
                    <span>Голосовать</span>
                </button>
            `;
        } else {
            container.innerHTML = `
                <div class="waiting-message">
                    <span>⏳ Ожидание голосов...</span>
                </div>
            `;
        }
    } else if (gs.currentPhase === 'finished') {
        showFinalScreen();
    }
}

// ========================================
// GAME ACTIONS
// ========================================
function exploreBunker() {
    showLoading(true);
    
    state.socket.emit('explore-bunker', {}, (response) => {
        showLoading(false);
        
        if (response.success) {
            showNotification(`Обнаружено: ${response.bunker.name}!`, 'success');
        }
    });
}

function showRevealDialog() {
    const modal = document.getElementById('reveal-modal');
    const options = document.getElementById('reveal-options');
    
    options.innerHTML = '';
    
    const cardTypes = [
        { key: 'superpowers', name: 'Суперсила', icon: '💪' },
        { key: 'phobias', name: 'Фобия', icon: '😨' },
        { key: 'character', name: 'Характер', icon: '🎭' },
        { key: 'hobbies', name: 'Хобби', icon: '🎯' },
        { key: 'luggage', name: 'Багаж', icon: '🎒' },
        { key: 'facts', name: 'Факт', icon: '📋' }
    ];
    
    // В первом раунде можно открыть только суперсилу
    const isFirstRound = state.gameState?.currentRound === 1;
    
    cardTypes.forEach(type => {
        const isRevealed = state.revealedCards.includes(type.key);
        const canReveal = !isRevealed && (!isFirstRound || type.key === 'superpowers');
        
        const btn = document.createElement('button');
        btn.className = `reveal-option ${canReveal ? '' : 'disabled'}`;
        btn.innerHTML = `
            <span class="icon">${type.icon}</span>
            <span class="name">${type.name}</span>
            ${isRevealed ? '<span class="status">✓ Открыта</span>' : ''}
            ${isFirstRound && type.key !== 'superpowers' ? '<span class="status">Раунд 1</span>' : ''}
        `;
        
        if (canReveal) {
            btn.onclick = () => revealCard(type.key);
        }
        
        options.appendChild(btn);
    });
    
    modal.classList.remove('hidden');
}

function revealCard(cardType) {
    showLoading(true);
    closeRevealModal();
    
    state.socket.emit('reveal-card', { cardType }, (response) => {
        showLoading(false);
        
        if (response.success) {
            state.revealedCards.push(cardType);
            showNotification(`Вы открыли: ${response.revealedCard.name}`, 'success');
        } else {
            showNotification(response.error || 'Ошибка', 'error');
        }
    });
}

// ========================================
// VOTING
// ========================================
function showVotingScreen() {
    showScreen('voting-screen');
    
    const container = document.getElementById('voting-players');
    container.innerHTML = '';
    
    const activePlayers = state.players.filter(p => !p.isExiled && p.id !== state.playerId);
    
    activePlayers.forEach(player => {
        const btn = document.createElement('button');
        btn.className = 'vote-btn';
        btn.innerHTML = `
            <div class="avatar">${player.avatar}</div>
            <div class="name">${player.name}</div>
        `;
        btn.onclick = () => castVote(player.id);
        container.appendChild(btn);
    });
    
    // Reset voting UI
    document.getElementById('voting-results').classList.add('hidden');
    document.getElementById('voting-players').classList.remove('hidden');
    document.querySelector('.voting-progress').classList.remove('hidden');
    
    state.hasVoted = false;
}

function castVote(targetId) {
    if (state.hasVoted) return;
    
    state.hasVoted = true;
    showLoading(true);
    
    state.socket.emit('cast-vote', { targetId }, (response) => {
        showLoading(false);
        
        if (response.complete) {
            showVotingResults(response.results);
        }
    });
}

function showVotingResults(results) {
    document.getElementById('voting-players').classList.add('hidden');
    document.querySelector('.voting-progress').classList.add('hidden');
    
    const resultsContainer = document.getElementById('results-list');
    resultsContainer.innerHTML = '';
    
    // Sort by votes
    const sortedPlayers = [...state.players]
        .filter(p => !p.isExiled)
        .sort((a, b) => (results.voteCounts[b.id] || 0) - (results.voteCounts[a.id] || 0));
    
    sortedPlayers.forEach(player => {
        const votes = results.voteCounts[player.id] || 0;
        const div = document.createElement('div');
        div.className = 'result-item';
        div.innerHTML = `
            <div class="player">
                <div class="avatar">${player.avatar}</div>
                <span>${player.name}</span>
            </div>
            <div class="votes">
                <span>🗳️</span>
                <span>${votes}</span>
            </div>
        `;
        resultsContainer.appendChild(div);
    });
    
    // Show exiled announcement
    const exiledPlayer = state.players.find(p => p.id === results.exiledId);
    const announcement = document.getElementById('exiled-announcement');
    announcement.innerHTML = `
        <div class="label">Изгнан</div>
        <div class="name">${exiledPlayer?.name || 'Неизвестно'}</div>
        <button class="btn btn-primary" onclick="continueAfterVote()">Продолжить</button>
    `;
    
    document.getElementById('voting-results').classList.remove('hidden');
}

function continueAfterVote() {
    showLoading(true);
    
    state.socket.emit('continue-after-vote', {}, (response) => {
        showLoading(false);
        state.hasVoted = false;
        
        if (response.gameFinished) {
            showFinalScreen();
        } else {
            showGameScreen();
            showNotification(`Раунд ${response.nextRound || state.gameState?.currentRound}!`, 'success');
        }
    });
}

// ========================================
// FINAL SCREEN
// ========================================
function showFinalScreen() {
    showScreen('final-screen');
    
    const survivors = state.players.filter(p => !p.isExiled);
    const exiled = state.players.filter(p => p.isExiled);
    
    const container = document.getElementById('final-content');
    
    container.innerHTML = `
        <div class="winners-section">
            <div class="section-title">
                <span>✅</span>
                <span>Попали в бункер (${survivors.length})</span>
            </div>
            <div class="survivors-list">
                ${survivors.map(p => `
                    <div class="survivor-item">
                        <div class="avatar">${p.avatar}</div>
                        <div class="name">${p.name}</div>
                    </div>
                `).join('')}
            </div>
        </div>
        
        <div class="exiled-section">
            <div class="section-title">
                <span>❌</span>
                <span>Изгнаны (${exiled.length})</span>
            </div>
            <div class="exiled-list">
                ${exiled.map(p => `
                    <div class="exiled-item">
                        <div class="avatar">${p.avatar}</div>
                        <div class="name">${p.name}</div>
                    </div>
                `).join('')}
            </div>
        </div>
    `;
}

function playAgain() {
    leaveRoom();
}

// ========================================
// MODALS
// ========================================
function showCardModal(card) {
    const modal = document.getElementById('card-modal');
    const modalCard = document.getElementById('modal-card');
    
    modalCard.innerHTML = `
        <div class="type">${getCardTypeName(card.type).toUpperCase()}</div>
        <span class="icon">${card.icon}</span>
        <div class="name">${card.name}</div>
        <div class="description">${card.description}</div>
    `;
    
    modal.classList.remove('hidden');
}

function closeModal() {
    document.getElementById('card-modal').classList.add('hidden');
}

function closeRevealModal() {
    document.getElementById('reveal-modal').classList.add('hidden');
}

function getCardTypeName(type) {
    const names = {
        'superpowers': 'Суперсила',
        'phobias': 'Фобия',
        'character': 'Характер',
        'hobbies': 'Хобби',
        'luggage': 'Багаж',
        'facts': 'Факт',
        'special': 'Особое условие'
    };
    return names[type] || type;
}

// ========================================
// UTILITY
// ========================================
function showNotification(message, type = 'info') {
    const notification = document.getElementById('notification');
    notification.className = `notification ${type}`;
    notification.querySelector('.icon').textContent = 
        type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️';
    notification.querySelector('.message').textContent = message;
    
    notification.classList.remove('hidden');
    
    setTimeout(() => {
        notification.classList.add('hidden');
    }, 3000);
}

function showLoading(show) {
    const overlay = document.getElementById('loading-overlay');
    if (show) {
        overlay.classList.remove('hidden');
    } else {
        overlay.classList.add('hidden');
    }
}

function confirmExit() {
    if (confirm('Выйти из игры? Вы потеряете прогресс.')) {
        leaveRoom();
    }
}

function setupEventListeners() {
    // Close modals on backdrop click
    document.querySelectorAll('.modal').forEach(modal => {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.classList.add('hidden');
            }
        });
    });
    
    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
        }
    });
    
    // Telegram back button
    if (window.Telegram?.WebApp) {
        Telegram.WebApp.BackButton.onClick(() => {
            const activeScreen = document.querySelector('.screen.active');
            if (activeScreen?.id === 'main-screen') {
                Telegram.WebApp.close();
            } else if (activeScreen?.id === 'game-screen') {
                confirmExit();
            } else {
                showScreen('main-screen');
            }
        });
    }
}
