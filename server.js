const express = require('express');
const http    = require('http');
const path    = require('path');
const { Server } = require('socket.io');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.static(__dirname));
app.get(/^(?!\/socket\.io).*$/, (req, res) => {
  const fs   = require('fs');
  const file = path.join(__dirname, 'index.html');
  if (fs.existsSync(file)) res.sendFile(file);
  else res.status(404).send('Not found');
});

/* ════════════════════════════════════════
   ROOMS — game4 Champions (coopératif)
════════════════════════════════════════ */
const rooms = {};

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function buildPlayers(room) {
  return Object.entries(room.players).map(([id, p]) => ({ id, name: p.name, score: p.score }));
}

io.on('connection', socket => {

  /* ── game4 : create ── */
  socket.on('createRoom', ({ name }, cb) => {
    const playerName = name || 'Joueur';
    const code = genCode();
    socket._g4room = code;
    socket._g4name = playerName;
    rooms[code] = { startTime: Date.now(), found: {}, players: { [socket.id]: { name: playerName, score: 0 } } };
    socket.join(code);
    cb({ ok: true, code, startTime: rooms[code].startTime });
  });

  /* ── game4 : join ── */
  socket.on('joinRoom', ({ name, code }, cb) => {
    const room = rooms[code];
    if (!room) { cb({ ok: false, error: 'Salle introuvable' }); return; }
    const playerName = name || 'Joueur';
    socket._g4room = code;
    socket._g4name = playerName;
    room.players[socket.id] = { name: playerName, score: 0 };
    socket.join(code);
    cb({ ok: true, code, startTime: room.startTime, found: Object.values(room.found), players: buildPlayers(room) });
    socket.to(code).emit('playerJoined', { id: socket.id, name: playerName, players: buildPlayers(room) });
  });

  /* ── game4 : champFound ── */
  socket.on('champFound', ({ champId, champName }) => {
    const code = socket._g4room;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    if (room.found[champId]) return;
    const ev = { champId, champName, playerId: socket.id, playerName: socket._g4name, ts: Date.now() };
    room.found[champId] = ev;
    if (room.players[socket.id]) room.players[socket.id].score++;
    io.to(code).emit('champFound', { ...ev, players: buildPlayers(room) });
  });

  /* ════════════════════════════════════════
     BATTLE — game6 Flou Battle (PvP)
  ════════════════════════════════════════ */
  socket.on('battle:create', ({ name }, cb) => {
    const playerName = name || 'Joueur';
    let code;
    do { code = 'B' + Array.from({length:5}, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random()*32)]).join(''); }
    while (battleRooms[code]);

    socket._broom = code;
    socket._bname = playerName;
    battleRooms[code] = {
      code, phase: 'lobby', round: 0, foundCount: 0,
      readyTimer: null, roundTimer: null, interPending: false,
      players: { [socket.id]: { name: playerName, score: 0, ready: false, found: false } }
    };
    socket.join(code);
    cb({ ok: true, code });
  });

  socket.on('battle:join', ({ name, code }, cb) => {
    const room = battleRooms[code];
    if (!room) { cb({ ok: false, error: 'Salle introuvable' }); return; }
    if (room.phase === 'over') { cb({ ok: false, error: 'Partie terminée' }); return; }
    const playerName = name || 'Joueur';
    socket._broom = code;
    socket._bname = playerName;
    room.players[socket.id] = { name: playerName, score: 0, ready: false, found: false };
    socket.join(code);
    cb({ ok: true, code, players: buildBattlePlayers(room), phase: room.phase, round: room.round });
    socket.to(code).emit('battle:playerJoined', { players: buildBattlePlayers(room) });
  });

  socket.on('battle:ready', () => {
    const code = socket._broom;
    if (!code || !battleRooms[code]) return;
    const room = battleRooms[code];
    if (room.phase !== 'lobby') return;
    if (room.players[socket.id]) room.players[socket.id].ready = true;
    io.to(code).emit('battle:playerReady', { players: buildBattlePlayers(room) });
    const all = Object.values(room.players);
    if (all.length >= 1 && all.every(p => p.ready)) {
      clearTimeout(room.readyTimer);
      startBattle(code);
    }
    if (!room.readyTimer) {
      room.readyTimer = setTimeout(() => {
        if (battleRooms[code] && battleRooms[code].phase === 'lobby') startBattle(code);
      }, 30000);
    }
  });

  socket.on('battle:found', ({ champId }) => {
    const code = socket._broom;
    if (!code || !battleRooms[code]) return;
    const room = battleRooms[code];
    if (room.phase !== 'playing') return;
    if (!room.players[socket.id] || room.players[socket.id].found) return;
    room.players[socket.id].found  = true;
    room.players[socket.id].score += 1;
    room.foundCount++;
    io.to(code).emit('battle:found', { playerId: socket.id, playerName: socket._bname, players: buildBattlePlayers(room) });
    const total = Object.keys(room.players).length;
    if (room.foundCount >= total) triggerInterRound(code);
  });

  /* ── Disconnect ── */
  socket.on('disconnect', () => {
    // game4
    const g4code = socket._g4room;
    if (g4code && rooms[g4code]) {
      const room = rooms[g4code];
      delete room.players[socket.id];
      socket.to(g4code).emit('playerLeft', { id: socket.id, players: buildPlayers(room) });
      if (Object.keys(room.players).length === 0) setTimeout(() => { delete rooms[g4code]; }, 3_600_000);
    }
    // battle
    const bcode = socket._broom;
    if (bcode && battleRooms[bcode]) {
      const room = battleRooms[bcode];
      delete room.players[socket.id];
      socket.to(bcode).emit('battle:playerLeft', { players: buildBattlePlayers(room) });
      if (Object.keys(room.players).length === 0) {
        clearTimeout(room.roundTimer); clearTimeout(room.readyTimer);
        setTimeout(() => { delete battleRooms[bcode]; }, 3_600_000);
      }
    }
  });
});

/* ════════════════════════════════════════
   BATTLE HELPERS
════════════════════════════════════════ */
const battleRooms = {};
const TOTAL_ROUNDS  = 10;
const ROUND_SECONDS = 25;
const INTER_SECONDS = 3;

function buildBattlePlayers(room) {
  return Object.entries(room.players).map(([id, p]) => ({
    id, name: p.name, score: p.score, ready: p.ready, found: p.found
  }));
}

function startBattle(code) {
  const room = battleRooms[code];
  if (!room) return;
  room.phase = 'playing';
  room.round = 0;
  io.to(code).emit('battle:start');
  nextBattleRound(code);
}

function nextBattleRound(code) {
  const room = battleRooms[code];
  if (!room) return;
  room.round++;
  if (room.round > TOTAL_ROUNDS) { endBattle(code); return; }
  Object.values(room.players).forEach(p => { p.found = false; });
  room.foundCount = 0;
  io.to(code).emit('battle:round', {
    round: room.round, total: TOTAL_ROUNDS, duration: ROUND_SECONDS, players: buildBattlePlayers(room)
  });
  clearTimeout(room.roundTimer);
  room.roundTimer = setTimeout(() => {
    if (battleRooms[code] && battleRooms[code].phase === 'playing') triggerInterRound(code);
  }, ROUND_SECONDS * 1000);
}

function triggerInterRound(code) {
  const room = battleRooms[code];
  if (!room || room.interPending) return;
  room.interPending = true;
  clearTimeout(room.roundTimer);
  io.to(code).emit('battle:interRound', { countdown: INTER_SECONDS, players: buildBattlePlayers(room) });
  setTimeout(() => {
    if (battleRooms[code]) {
      battleRooms[code].interPending = false;
      nextBattleRound(code);
    }
  }, INTER_SECONDS * 1000);
}

function endBattle(code) {
  const room = battleRooms[code];
  if (!room) return;
  room.phase = 'over';
  const sorted = buildBattlePlayers(room).sort((a, b) => b.score - a.score);
  io.to(code).emit('battle:over', { players: sorted });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`✅ Serveur sur le port ${PORT}`));
