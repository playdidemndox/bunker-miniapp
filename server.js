/**
 * БУНКЕР: Поколение Альфа - Многопользовательский сервер
 * Node.js + Express + Socket.IO для real-time игры
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    transports: ['websocket', 'polling']
});

const PORT = process.env.PORT || 3000;

// Telegram Bot Configuration
const BOT_TOKEN = process.env.BOT_TOKEN || '8505568581:AAFqPR_VNPVFp4FK7-JZm_IRinQ2NjR3y-M';
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ========================================
// GAME STATE MANAGEMENT
// ========================================

// Хранилище комнат в памяти
const rooms = new Map();
const playerSessions = new Map(); // socketId -> { roomCode, playerId }

// Таблица раундов: [количество игроков] => [голосования в каждом раунде]
const ROUNDS_TABLE = {
    4:  [0, 0, 0, 1, 1],
    5:  [0, 0, 1, 1, 1],
    6:  [0, 0, 1, 1, 1],
    7:  [0, 1, 1, 1, 1],
    8:  [0, 1, 1, 1, 1],
    9:  [0, 1, 1, 1, 2],
    10: [0, 1, 1, 2, 2]
};

const BUNKER_SLOTS = {
    4: 2, 5: 2, 6: 3, 7: 3, 8: 4, 9: 4, 10: 5
};

// Загрузка карт
let cardsData = null;

async function loadCards() {
    try {
        cardsData = require('./public/cards.json');
        console.log('✅ Cards loaded successfully');
    } catch (error) {
        console.error('❌ Failed to load cards:', error);
        cardsData = { superpowers: [], phobias: [], character: [], hobbies: [], luggage: [], facts: [], catastrophes: [], threats: [], bunker: [], special_conditions: [] };
    }
}

// ========================================
// ROOM MANAGEMENT
// ========================================

function generateRoomCode() {
    // Генерируем 6-значный код из букв и цифр
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

function createRoom(hostId, hostName, maxPlayers, gameMode = 'basic') {
    const roomCode = generateRoomCode();
    
    const room = {
        code: roomCode,
        hostId: hostId,
        maxPlayers: Math.min(Math.max(maxPlayers, 4), 10),
        gameMode: gameMode,
        status: 'waiting', // waiting, playing, finished
        players: new Map(),
        spectators: new Map(),
        gameState: null,
        createdAt: Date.now(),
        lastActivity: Date.now()
    };
    
    rooms.set(roomCode, room);
    console.log(`🏠 Room created: ${roomCode} by ${hostName}`);
    
    return room;
}

function getRoom(code) {
    return rooms.get(code.toUpperCase());
}

function deleteRoom(code) {
    const room = rooms.get(code);
    if (room) {
        // Отключаем всех игроков
        room.players.forEach((player, playerId) => {
            const socket = io.sockets.sockets.get(player.socketId);
            if (socket) {
                socket.leave(code);
            }
        });
        rooms.delete(code);
        console.log(`🗑️ Room deleted: ${code}`);
    }
}

function joinRoom(roomCode, playerId, playerData) {
    const room = getRoom(roomCode);
    if (!room) return { success: false, error: 'Комната не найдена' };
    
    if (room.status !== 'waiting') {
        return { success: false, error: 'Игра уже началась' };
    }
    
    if (room.players.size >= room.maxPlayers) {
        return { success: false, error: 'Комната заполнена' };
    }
    
    if (room.players.has(playerId)) {
        // Обновляем существующего игрока (переподключение)
        const existingPlayer = room.players.get(playerId);
        existingPlayer.socketId = playerData.socketId;
        existingPlayer.name = playerData.name || existingPlayer.name;
        existingPlayer.avatar = playerData.avatar || existingPlayer.avatar;
        existingPlayer.isConnected = true;
    } else {
        // Добавляем нового игрока
        room.players.set(playerId, {
            id: playerId,
            socketId: playerData.socketId,
            name: playerData.name,
            avatar: playerData.avatar || getRandomAvatar(),
            isHost: room.hostId === playerId,
            isConnected: true,
            isReady: false,
            isExiled: false,
            cards: {},
            revealedCards: [],
            votes: 0,
            joinedAt: Date.now()
        });
    }
    
    room.lastActivity = Date.now();
    
    // Присоединяем сокет к комнате
    const socket = io.sockets.sockets.get(playerData.socketId);
    if (socket) {
        socket.join(roomCode);
    }
    
    console.log(`👤 Player ${playerData.name} joined room ${roomCode}`);
    
    return { success: true, room };
}

function leaveRoom(roomCode, playerId) {
    const room = getRoom(roomCode);
    if (!room) return false;
    
    const player = room.players.get(playerId);
    if (player) {
        player.isConnected = false;
        
        const socket = io.sockets.sockets.get(player.socketId);
        if (socket) {
            socket.leave(roomCode);
        }
        
        // Если хост вышел и игра не началась - передаём хост другому
        if (player.isHost && room.status === 'waiting') {
            const nextHost = Array.from(room.players.values()).find(p => p.isConnected && p.id !== playerId);
            if (nextHost) {
                nextHost.isHost = true;
                room.hostId = nextHost.id;
            }
        }
        
        // Если все вышли - удаляем комнату
        const connectedPlayers = Array.from(room.players.values()).filter(p => p.isConnected);
        if (connectedPlayers.length === 0) {
            deleteRoom(roomCode);
        }
    }
    
    return true;
}

function getRandomAvatar() {
    const avatars = ['👤', '👨', '👩', '🧑', '👴', '👵', '🧓', '👶', '🧒', '👦', '👧', '🎅', '🤶', '🦸', '🦹', '🧙', '🧝', '🧛', '🧟'];
    return avatars[Math.floor(Math.random() * avatars.length)];
}

function getRandomItem(array) {
    return array[Math.floor(Math.random() * array.length)];
}

function shuffleArray(array) {
    const newArray = [...array];
    for (let i = newArray.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
    }
    return newArray;
}

// ========================================
// GAME LOGIC
// ========================================

function startGame(roomCode) {
    const room = getRoom(roomCode);
    if (!room) return { success: false, error: 'Комната не найдена' };
    
    const players = Array.from(room.players.values()).filter(p => p.isConnected);
    
    if (players.length < 4) {
        return { success: false, error: 'Нужно минимум 4 игрока' };
    }
    
    // Выбираем катастрофу
    const catastrophe = getRandomItem(cardsData.catastrophes);
    
    // Подготавливаем карты бункера и угроз
    const bunkerCards = shuffleArray([...cardsData.bunker]).slice(0, 5);
    const threatCards = shuffleArray([...cardsData.threats]).slice(0, 5);
    
    // Раздаём карты игрокам
    const cardTypes = ['superpowers', 'phobias', 'character', 'hobbies', 'luggage', 'facts'];
    
    players.forEach(player => {
        player.cards = {};
        player.revealedCards = [];
        player.isExiled = false;
        player.votes = 0;
        
        cardTypes.forEach(type => {
            const cards = cardsData[type];
            const randomCard = getRandomItem(cards);
            player.cards[type] = { ...randomCard, type };
        });
        
        // Особое условие
        player.cards.special = {
            ...getRandomItem(cardsData.special_conditions),
            type: 'special'
        };
    });
    
    // Инициализируем состояние игры
    room.gameState = {
        currentRound: 1,
        currentPhase: 'exploration', // exploration, reveal, discussion, voting, finished
        activePlayerIndex: 0,
        catastrophe: catastrophe,
        bunkerCards: bunkerCards,
        threatCards: threatCards,
        revealedBunker: [],
        revealedThreats: [],
        votes: {},
        votingResults: null,
        exiledThisRound: [],
        startedAt: Date.now()
    };
    
    room.status = 'playing';
    room.lastActivity = Date.now();
    
    console.log(`🎮 Game started in room ${roomCode}`);
    
    return { success: true, room };
}

function getNextActivePlayer(room) {
    const players = Array.from(room.players.values()).filter(p => p.isConnected && !p.isExiled);
    let nextIndex = (room.gameState.activePlayerIndex + 1) % players.length;
    let attempts = 0;
    
    while (attempts < players.length) {
        if (!players[nextIndex].isExiled) {
            return nextIndex;
        }
        nextIndex = (nextIndex + 1) % players.length;
        attempts++;
    }
    
    return -1;
}

function processVote(roomCode, voterId, targetId) {
    const room = getRoom(roomCode);
    if (!room || !room.gameState) return { success: false };
    
    room.gameState.votes[voterId] = targetId;
    
    // Проверяем, все ли проголосовали
    const players = Array.from(room.players.values()).filter(p => p.isConnected && !p.isExiled);
    const votedPlayers = Object.keys(room.gameState.votes);
    
    if (votedPlayers.length >= players.length) {
        // Подсчитываем голоса
        const voteCounts = {};
        players.forEach(p => p.votes = 0);
        
        Object.entries(room.gameState.votes).forEach(([voter, target]) => {
            if (voteCounts[target]) {
                voteCounts[target]++;
            } else {
                voteCounts[target] = 1;
            }
        });
        
        // Находим игрока с наибольшим количеством голосов
        let maxVotes = 0;
        let candidates = [];
        
        Object.entries(voteCounts).forEach(([playerId, count]) => {
            if (count > maxVotes) {
                maxVotes = count;
                candidates = [playerId];
            } else if (count === maxVotes) {
                candidates.push(playerId);
            }
        });
        
        // Отмечаем голоса у игроков
        Object.entries(voteCounts).forEach(([playerId, count]) => {
            const player = room.players.get(playerId);
            if (player) player.votes = count;
        });
        
        // Определяем изгнанного
        let exiledId = null;
        if (candidates.length === 1) {
            exiledId = candidates[0];
        } else {
            // При равенстве - случайный выбор
            exiledId = candidates[Math.floor(Math.random() * candidates.length)];
        }
        
        const exiledPlayer = room.players.get(exiledId);
        if (exiledPlayer) {
            exiledPlayer.isExiled = true;
            room.gameState.exiledThisRound.push(exiledId);
        }
        
        room.gameState.votingResults = {
            voteCounts,
            exiledId,
            candidates
        };
        
        return { success: true, complete: true, results: room.gameState.votingResults };
    }
    
    return { success: true, complete: false, votedCount: votedPlayers.length, totalCount: players.length };
}

function nextRound(roomCode) {
    const room = getRoom(roomCode);
    if (!room || !room.gameState) return { success: false };
    
    const gs = room.gameState;
    const playerCount = Array.from(room.players.values()).filter(p => p.isConnected).length;
    const expectedExiled = playerCount - BUNKER_SLOTS[playerCount];
    const currentExiled = Array.from(room.players.values()).filter(p => p.isExiled).length;
    
    // Проверяем конец игры
    if (gs.currentRound >= 5 && currentExiled >= expectedExiled) {
        gs.currentPhase = 'finished';
        room.status = 'finished';
        return { success: true, finished: true };
    }
    
    // Переходим к следующему раунду
    if (gs.currentRound < 5) {
        gs.currentRound++;
        gs.currentPhase = 'exploration';
        gs.activePlayerIndex = 0;
        gs.votes = {};
        gs.votingResults = null;
        gs.exiledThisRound = [];
        
        // Сбрасываем голоса
        room.players.forEach(p => p.votes = 0);
        
        return { success: true, nextRound: gs.currentRound };
    }
    
    // Конец игры
    gs.currentPhase = 'finished';
    room.status = 'finished';
    return { success: true, finished: true };
}

// ========================================
// SOCKET.IO HANDLERS
// ========================================

io.on('connection', (socket) => {
    console.log(`🔌 Socket connected: ${socket.id}`);
    
    // Создание комнаты
    socket.on('create-room', (data, callback) => {
        const { playerId, playerName, maxPlayers, gameMode } = data;
        
        const room = createRoom(playerId, playerName, maxPlayers, gameMode);
        const result = joinRoom(room.code, playerId, {
            socketId: socket.id,
            name: playerName,
            avatar: data.avatar
        });
        
        if (result.success) {
            playerSessions.set(socket.id, { roomCode: room.code, playerId });
            
            // Отправляем обновление всем в комнате
            broadcastRoomUpdate(room.code);
            
            callback({
                success: true,
                roomCode: room.code,
                player: sanitizePlayer(room.players.get(playerId)),
                players: Array.from(room.players.values()).map(sanitizePlayer)
            });
        } else {
            callback({ success: false, error: result.error });
        }
    });
    
    // Присоединение к комнате
    socket.on('join-room', (data, callback) => {
        const { roomCode, playerId, playerName } = data;
        
        const result = joinRoom(roomCode, playerId, {
            socketId: socket.id,
            name: playerName,
            avatar: data.avatar
        });
        
        if (result.success) {
            playerSessions.set(socket.id, { roomCode, playerCode: roomCode, playerId });
            
            // Уведомляем других игроков
            socket.to(roomCode).emit('player-joined', {
                player: sanitizePlayer(result.room.players.get(playerId))
            });
            
            broadcastRoomUpdate(roomCode);
            
            callback({
                success: true,
                roomCode: roomCode,
                player: sanitizePlayer(result.room.players.get(playerId)),
                players: Array.from(result.room.players.values()).map(sanitizePlayer),
                status: result.room.status,
                gameState: result.room.status === 'playing' ? sanitizeGameState(result.room.gameState, playerId) : null
            });
        } else {
            callback({ success: false, error: result.error });
        }
    });
    
    // Готовность игрока
    socket.on('player-ready', (data, callback) => {
        const session = playerSessions.get(socket.id);
        if (!session) return callback({ success: false, error: 'Сессия не найдена' });
        
        const room = getRoom(session.roomCode);
        if (!room) return callback({ success: false, error: 'Комната не найдена' });
        
        const player = room.players.get(session.playerId);
        if (player) {
            player.isReady = data.isReady;
            broadcastRoomUpdate(session.roomCode);
        }
        
        callback({ success: true });
    });
    
    // Старт игры (только хост)
    socket.on('start-game', (data, callback) => {
        const session = playerSessions.get(socket.id);
        if (!session) return callback({ success: false, error: 'Сессия не найдена' });
        
        const room = getRoom(session.roomCode);
        if (!room) return callback({ success: false, error: 'Комната не найдена' });
        
        const player = room.players.get(session.playerId);
        if (!player || !player.isHost) {
            return callback({ success: false, error: 'Только хост может начать игру' });
        }
        
        const result = startGame(session.roomCode);
        
        if (result.success) {
            // Отправляем каждому игроку его карты
            room.players.forEach((p, pid) => {
                const playerSocket = io.sockets.sockets.get(p.socketId);
                if (playerSocket) {
                    playerSocket.emit('game-started', {
                        gameState: sanitizeGameState(room.gameState, pid),
                        myCards: p.cards,
                        players: Array.from(room.players.values()).map(sanitizePlayerForGame)
                    });
                }
            });
            
            callback({ success: true });
        } else {
            callback({ success: false, error: result.error });
        }
    });
    
    // Исследование бункера
    socket.on('explore-bunker', (data, callback) => {
        const session = playerSessions.get(socket.id);
        if (!session) return callback({ success: false, error: 'Сессия не найдена' });
        
        const room = getRoom(session.roomCode);
        if (!room || !room.gameState) return callback({ success: false, error: 'Игра не найдена' });
        
        const gs = room.gameState;
        
        // Открываем карты для текущего раунда
        if (gs.currentRound > gs.revealedBunker.length) {
            gs.revealedBunker.push(gs.bunkerCards[gs.currentRound - 1]);
            gs.revealedThreats.push(gs.threatCards[gs.currentRound - 1]);
        }
        
        gs.currentPhase = 'reveal';
        gs.activePlayerIndex = 0;
        
        // Отправляем обновление всем
        broadcastGameUpdate(session.roomCode);
        
        callback({ success: true, bunker: gs.revealedBunker[gs.currentRound - 1], threat: gs.revealedThreats[gs.currentRound - 1] });
    });
    
    // Открытие карты игроком
    socket.on('reveal-card', (data, callback) => {
        const session = playerSessions.get(socket.id);
        if (!session) return callback({ success: false, error: 'Сессия не найдена' });
        
        const room = getRoom(session.roomCode);
        if (!room || !room.gameState) return callback({ success: false, error: 'Игра не найдена' });
        
        const player = room.players.get(session.playerId);
        if (!player) return callback({ success: false, error: 'Игрок не найден' });
        
        const { cardType } = data;
        
        // Проверяем, может ли игрок открыть эту карту
        if (!player.revealedCards.includes(cardType)) {
            player.revealedCards.push(cardType);
            
            // Переходим к следующему игроку
            const players = Array.from(room.players.values()).filter(p => p.isConnected && !p.isExiled);
            const currentPlayerIndex = players.findIndex(p => p.id === session.playerId);
            const nextIndex = (currentPlayerIndex + 1) % players.length;
            
            if (nextIndex <= currentPlayerIndex) {
                // Круг завершён
                const gs = room.gameState;
                const playerCount = players.length;
                const votesInRound = ROUNDS_TABLE[playerCount]?.[gs.currentRound - 1] || 0;
                
                if (votesInRound > 0) {
                    gs.currentPhase = 'voting';
                } else {
                    // Переходим к следующему раунду
                    const result = nextRound(session.roomCode);
                    if (result.finished) {
                        broadcastGameUpdate(session.roomCode);
                        callback({ success: true, roundComplete: true, gameFinished: true });
                        return;
                    }
                }
            } else {
                room.gameState.activePlayerIndex = nextIndex;
            }
            
            broadcastGameUpdate(session.roomCode);
            
            callback({ success: true, revealedCard: player.cards[cardType] });
        } else {
            callback({ success: false, error: 'Карта уже открыта' });
        }
    });
    
    // Голосование
    socket.on('cast-vote', (data, callback) => {
        const session = playerSessions.get(socket.id);
        if (!session) return callback({ success: false, error: 'Сессия не найдена' });
        
        const room = getRoom(session.roomCode);
        if (!room || !room.gameState) return callback({ success: false, error: 'Игра не найдена' });
        
        const { targetId } = data;
        const result = processVote(session.roomCode, session.playerId, targetId);
        
        if (result.complete) {
            broadcastGameUpdate(session.roomCode);
        } else {
            // Отправляем прогресс голосования
            io.to(session.roomCode).emit('voting-progress', {
                votedCount: result.votedCount,
                totalCount: result.totalCount
            });
        }
        
        callback({ success: true, complete: result.complete, results: result.results });
    });
    
    // Продолжение после голосования
    socket.on('continue-after-vote', (data, callback) => {
        const session = playerSessions.get(socket.id);
        if (!session) return callback({ success: false, error: 'Сессия не найдена' });
        
        const result = nextRound(session.roomCode);
        
        if (result.finished) {
            broadcastGameUpdate(session.roomCode);
            callback({ success: true, gameFinished: true });
        } else {
            broadcastGameUpdate(session.roomCode);
            callback({ success: true, nextRound: result.nextRound });
        }
    });
    
    // Переподключение
    socket.on('reconnect', (data, callback) => {
        const { roomCode, playerId } = data;
        const room = getRoom(roomCode);
        
        if (!room) return callback({ success: false, error: 'Комната не найдена' });
        
        const player = room.players.get(playerId);
        if (!player) return callback({ success: false, error: 'Игрок не найден' });
        
        // Обновляем сокет
        player.socketId = socket.id;
        player.isConnected = true;
        
        socket.join(roomCode);
        playerSessions.set(socket.id, { roomCode, playerId });
        
        broadcastRoomUpdate(roomCode);
        
        callback({
            success: true,
            roomCode,
            player: sanitizePlayer(player),
            players: Array.from(room.players.values()).map(sanitizePlayer),
            status: room.status,
            gameState: room.status === 'playing' ? sanitizeGameState(room.gameState, playerId) : null,
            myCards: player.cards,
            revealedCards: player.revealedCards
        });
    });
    
    // Отключение
    socket.on('disconnect', () => {
        console.log(`🔌 Socket disconnected: ${socket.id}`);
        
        const session = playerSessions.get(socket.id);
        if (session) {
            const room = getRoom(session.roomCode);
            if (room) {
                const player = room.players.get(session.playerId);
                if (player) {
                    player.isConnected = false;
                    broadcastRoomUpdate(session.roomCode);
                }
            }
            playerSessions.delete(socket.id);
        }
    });
});

// ========================================
// BROADCAST HELPERS
// ========================================

function broadcastRoomUpdate(roomCode) {
    const room = getRoom(roomCode);
    if (!room) return;
    
    io.to(roomCode).emit('room-update', {
        players: Array.from(room.players.values()).map(sanitizePlayer),
        status: room.status,
        maxPlayers: room.maxPlayers,
        gameMode: room.gameMode
    });
}

function broadcastGameUpdate(roomCode) {
    const room = getRoom(roomCode);
    if (!room || !room.gameState) return;
    
    // Отправляем каждому игроку его персонализированное состояние
    room.players.forEach((player, playerId) => {
        const socket = io.sockets.sockets.get(player.socketId);
        if (socket) {
            socket.emit('game-update', {
                gameState: sanitizeGameState(room.gameState, playerId),
                players: Array.from(room.players.values()).map(sanitizePlayerForGame),
                myRevealedCards: player.revealedCards
            });
        }
    });
}

// ========================================
// DATA SANITIZATION
// ========================================

function sanitizePlayer(player) {
    return {
        id: player.id,
        name: player.name,
        avatar: player.avatar,
        isHost: player.isHost,
        isConnected: player.isConnected,
        isReady: player.isReady,
        isExiled: player.isExiled,
        revealedCards: player.revealedCards
    };
}

function sanitizePlayerForGame(player) {
    return {
        id: player.id,
        name: player.name,
        avatar: player.avatar,
        isHost: player.isHost,
        isConnected: player.isConnected,
        isExiled: player.isExiled,
        revealedCards: player.revealedCards,
        votes: player.votes
    };
}

function sanitizeGameState(gameState, playerId) {
    // Возвращаем состояние игры без чужих карт
    return {
        currentRound: gameState.currentRound,
        currentPhase: gameState.currentPhase,
        activePlayerIndex: gameState.activePlayerIndex,
        catastrophe: gameState.catastrophe,
        revealedBunker: gameState.revealedBunker,
        revealedThreats: gameState.revealedThreats,
        votingResults: gameState.votingResults,
        exiledThisRound: gameState.exiledThisRound
    };
}

// ========================================
// EXPRESS ROUTES
// ========================================

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        rooms: rooms.size,
        players: Array.from(rooms.values()).reduce((sum, r) => sum + r.players.size, 0)
    });
});

// Получить информацию о комнате
app.get('/api/room/:code', (req, res) => {
    const room = getRoom(req.params.code);
    if (!room) {
        return res.status(404).json({ error: 'Комната не найдена' });
    }
    
    res.json({
        code: room.code,
        status: room.status,
        maxPlayers: room.maxPlayers,
        gameMode: room.gameMode,
        players: Array.from(room.players.values()).map(sanitizePlayer)
    });
});

// ========================================
// TELEGRAM WEBHOOK
// ========================================

app.post('/webhook', async (req, res) => {
    const update = req.body;
    
    try {
        if (update.message) {
            await handleMessage(update.message);
        } else if (update.callback_query) {
            await handleCallbackQuery(update.callback_query);
        }
        
        res.sendStatus(200);
    } catch (error) {
        console.error('Webhook error:', error);
        res.sendStatus(500);
    }
});

async function handleMessage(message) {
    const chatId = message.chat.id;
    const text = message.text || '';
    const username = message.from?.username || message.from?.first_name || 'Игрок';
    const userId = message.from?.id.toString();
    
    if (text.startsWith('/start')) {
        // Проверяем, есть ли код комнаты в параметре
        const parts = text.split(' ');
        if (parts.length > 1) {
            const roomCode = parts[1];
            const room = getRoom(roomCode);
            if (room && room.status === 'waiting') {
                await sendMessage(chatId, 
                    `🎮 Комната *${roomCode}* найдена!\n\n` +
                    `Нажмите кнопку ниже, чтобы присоединиться к игре:`,
                    {
                        reply_markup: {
                            inline_keyboard: [[{
                                text: '🎮 Присоединиться',
                                web_app: { 
                                    url: `${getMiniAppUrl()}?room=${roomCode}&playerId=${userId}&name=${encodeURIComponent(username)}` 
                                }
                            }]]
                        }
                    }
                );
                return;
            }
        }
        await sendWelcomeMessage(chatId, username, userId);
    } else if (text.startsWith('/join')) {
        const parts = text.split(' ');
        if (parts.length > 1) {
            const roomCode = parts[1].toUpperCase();
            const room = getRoom(roomCode);
            if (room && room.status === 'waiting') {
                await sendMessage(chatId,
                    `🎮 Присоединение к комнате *${roomCode}*`,
                    {
                        reply_markup: {
                            inline_keyboard: [[{
                                text: '🎮 Войти в игру',
                                web_app: { 
                                    url: `${getMiniAppUrl()}?room=${roomCode}&playerId=${userId}&name=${encodeURIComponent(username)}` 
                                }
                            }]]
                        }
                    }
                );
            } else {
                await sendMessage(chatId, '❌ Комната не найдена или игра уже началась');
            }
        } else {
            await sendMessage(chatId, '❌ Укажите код комнаты: /join ABC123');
        }
    } else if (text.startsWith('/create')) {
        await sendMessage(chatId,
            '🎮 Создание новой игры',
            {
                reply_markup: {
                    inline_keyboard: [[{
                        text: '🎮 Создать комнату',
                        web_app: { 
                            url: `${getMiniAppUrl()}?action=create&playerId=${userId}&name=${encodeURIComponent(username)}` 
                        }
                    }]]
                }
            }
        );
    } else if (text.startsWith('/help')) {
        await sendHelpMessage(chatId);
    } else {
        await sendDefaultMessage(chatId, userId, username);
    }
}

async function handleCallbackQuery(query) {
    const chatId = query.message?.chat?.id;
    const data = query.data;
    
    if (data === 'create_game') {
        await sendMessage(chatId, '🎮 Создайте комнату:', {
            reply_markup: {
                inline_keyboard: [[{
                    text: '🎮 Создать',
                    web_app: { url: getMiniAppUrl() }
                }]]
            }
        });
    }
    
    await answerCallbackQuery(query.id);
}

async function sendMessage(chatId, text, options = {}) {
    try {
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
            chat_id: chatId,
            text: text,
            parse_mode: 'Markdown',
            ...options
        });
    } catch (error) {
        console.error('Error sending message:', error.message);
    }
}

async function answerCallbackQuery(queryId, text = '') {
    try {
        await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
            callback_query_id: queryId,
            text: text
        });
    } catch (error) {
        console.error('Error answering callback:', error.message);
    }
}

async function sendWelcomeMessage(chatId, username, userId) {
    const text = `👋 Привет, ${username}!\n\n` +
        '☢️ *Бункер: Поколение Альфа* — многопользовательская игра на выживание!\n\n' +
        '🎯 Соберите друзей и решите, кто попадёт в бункер, когда настанет апокалипсис.\n\n' +
        '👥 *Как играть:*\n' +
        '1. Создайте комнату (/create)\n' +
        '2. Поделитесь кодом с друзьями\n' +
        '3. Начните игру когда все соберутся!\n\n' +
        'Или присоединитесь к существующей комнате: /join КОД';
    
    await sendMessage(chatId, text, {
        reply_markup: {
            inline_keyboard: [
                [{ text: '🎮 Создать игру', callback_data: 'create_game' }],
                [{ text: '📖 Как играть', url: 'https://telegra.ph/Pravila-igry-Bunker-01-01' }]
            ]
        }
    });
}

async function sendHelpMessage(chatId) {
    const text = '❓ *Команды:*\n\n' +
        '/start — Начать\n' +
        '/create — Создать комнату\n' +
        '/join КОД — Присоединиться\n' +
        '/help — Помощь\n\n' +
        '🎮 Для игры нажмите кнопку в меню бота';
    
    await sendMessage(chatId, text);
}

async function sendDefaultMessage(chatId, userId, username) {
    await sendMessage(chatId, 
        '🎮 Начните игру прямо сейчас!',
        {
            reply_markup: {
                inline_keyboard: [[{
                    text: '🎮 Играть',
                    web_app: { 
                        url: `${getMiniAppUrl()}?playerId=${userId}&name=${encodeURIComponent(username)}` 
                    }
                }]]
            }
        }
    );
}

function getMiniAppUrl() {
    if (process.env.MINI_APP_URL) {
        return process.env.MINI_APP_URL;
    }
    const host = process.env.RAILWAY_STATIC_URL || 
                 process.env.RAILWAY_PUBLIC_DOMAIN ||
                 `localhost:${PORT}`;
    const protocol = host.includes('localhost') ? 'http' : 'https';
    return `${protocol}://${host}`;
}

// ========================================
// SERVER STARTUP
// ========================================

server.listen(PORT, async () => {
    await loadCards();
    
    console.log('='.repeat(60));
    console.log('🎮 БУНКЕР: Поколение Альфа — Многопользовательский сервер');
    console.log('='.repeat(60));
    console.log(`🌐 Server: http://localhost:${PORT}`);
    console.log(`🎮 Mini App: ${getMiniAppUrl()}`);
    console.log(`📊 Socket.IO: enabled`);
    console.log('='.repeat(60));
});

// Очистка неактивных комнат каждые 10 минут
setInterval(() => {
    const now = Date.now();
    const inactiveTimeout = 30 * 60 * 1000; // 30 минут
    
    rooms.forEach((room, code) => {
        if (now - room.lastActivity > inactiveTimeout) {
            console.log(`🧹 Cleaning up inactive room: ${code}`);
            deleteRoom(code);
        }
    });
}, 10 * 60 * 1000);

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    server.close(() => {
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('SIGINT received, shutting down gracefully');
    server.close(() => {
        process.exit(0);
    });
});
