const express = require('express');
const http    = require('http');
const path    = require('path');
const { Server } = require('socket.io');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*', methods: ['GET','POST'] } });

app.use(express.static(__dirname));
app.get(/^(?!\/socket\.io).*$/, (req, res) => {
  const fs = require('fs');
  const f  = path.join(__dirname, 'index.html');
  fs.existsSync(f) ? res.sendFile(f) : res.status(404).send('Not found');
});

/* ══════════════════════════════════════════════════
   UTILS
══════════════════════════════════════════════════ */
function genCode(prefix) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = prefix || '';
  for (let i = s.length; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function sanitizeOpts(o) {
  o = o || {};
  return {
    duration     : Math.min(30,  Math.max(3,   parseInt(o.duration)     || 15)),
    champCount   : Math.min(200, Math.max(10,  parseInt(o.champCount)   || 50)),
    attackMode   : !!o.attackMode,
    atkThreshold : Math.min(10,  Math.max(3,   parseInt(o.atkThreshold) || 5))
  };
}

/* ══════════════════════════════════════════════════
   GAME 4 — COOP
══════════════════════════════════════════════════ */
const coopRooms = {};
function coopPlayers(room) {
  return Object.entries(room.players).map(([id, p]) => ({ id, name: p.name, score: p.score }));
}

/* ══════════════════════════════════════════════════
   GAME 4 — DUEL
══════════════════════════════════════════════════ */
const duelRooms = {};
function duelPlayers(room) {
  return Object.entries(room.players).map(([id, p]) => ({
    id, name: p.name, score: p.foundCount, ready: p.ready
  }));
}

function duelStart(code) {
  const room = duelRooms[code];
  if (!room) return;
  room.phase = 'playing';
  io.to(code).emit('duel:start', { options: room.options, players: duelPlayers(room) });
  clearTimeout(room.gameTimer);
  room.gameTimer = setTimeout(() => {
    if (duelRooms[code] && duelRooms[code].phase === 'playing') duelEnd(code, null);
  }, room.options.duration * 60 * 1000);
}

function duelEnd(code, winnerId) {
  const room = duelRooms[code];
  if (!room) return;
  room.phase = 'over';
  clearTimeout(room.gameTimer);
  let winner = winnerId;
  if (!winner) {
    const sorted = Object.entries(room.players).sort((a, b) => b[1].foundCount - a[1].foundCount);
    if (sorted.length >= 2 && sorted[0][1].foundCount !== sorted[1][1].foundCount) {
      winner = sorted[0][0];
    }
  }
  const scores = {};
  Object.entries(room.players).forEach(([id, p]) => { scores[id] = p.foundCount; });
  io.to(code).emit('duel:over', { winner, scores });
}

/* ══════════════════════════════════════════════════
   GAME 6 — FLOU BATTLE
══════════════════════════════════════════════════ */
const battleRooms = {};
const B_ROUNDS  = 10;
const B_ROUND_S = 25;
const B_INTER_S = 3;

function battlePlayers(room) {
  return Object.entries(room.players).map(([id, p]) => ({
    id, name: p.name, score: p.score, ready: p.ready, found: p.found
  }));
}

function battleStart(code) {
  const room = battleRooms[code];
  if (!room) return;
  room.phase = 'playing'; room.round = 0;
  io.to(code).emit('battle:start');
  battleNext(code);
}

function battleNext(code) {
  const room = battleRooms[code];
  if (!room) return;
  room.round++;
  if (room.round > B_ROUNDS) { battleEnd(code); return; }
  Object.values(room.players).forEach(p => { p.found = false; });
  room.foundCount = 0;
  io.to(code).emit('battle:round', {
    round: room.round, total: B_ROUNDS, duration: B_ROUND_S, players: battlePlayers(room)
  });
  clearTimeout(room.roundTimer);
  room.roundTimer = setTimeout(() => {
    if (battleRooms[code] && battleRooms[code].phase === 'playing') battleInter(code);
  }, B_ROUND_S * 1000);
}

function battleInter(code) {
  const room = battleRooms[code];
  if (!room || room.interPending) return;
  room.interPending = true;
  clearTimeout(room.roundTimer);
  io.to(code).emit('battle:interRound', { countdown: B_INTER_S, players: battlePlayers(room) });
  setTimeout(() => {
    if (battleRooms[code]) { battleRooms[code].interPending = false; battleNext(code); }
  }, B_INTER_S * 1000);
}

function battleEnd(code) {
  const room = battleRooms[code];
  if (!room) return;
  room.phase = 'over';
  io.to(code).emit('battle:over', { players: battlePlayers(room).sort((a, b) => b.score - a.score) });
}

/* ══════════════════════════════════════════════════
   SOCKET HANDLERS
══════════════════════════════════════════════════ */
io.on('connection', socket => {

  /* ─── COOP ─── */
  socket.on('createRoom', ({ name }, cb) => {
    const pn = name || 'Joueur', code = genCode();
    socket._coopRoom = code; socket._coopName = pn;
    coopRooms[code] = {
      startTime: Date.now(), found: {},
      players: { [socket.id]: { name: pn, score: 0 } }
    };
    socket.join(code);
    cb({ ok: true, code, startTime: coopRooms[code].startTime });
  });

  socket.on('joinRoom', ({ name, code }, cb) => {
    const room = coopRooms[code];
    if (!room) { cb({ ok: false, error: 'Salle introuvable' }); return; }
    const pn = name || 'Joueur';
    socket._coopRoom = code; socket._coopName = pn;
    room.players[socket.id] = { name: pn, score: 0 };
    socket.join(code);
    const players = coopPlayers(room);
    cb({ ok: true, code, startTime: room.startTime, found: Object.values(room.found), players });
    socket.to(code).emit('playerJoined', { id: socket.id, name: pn, players });
  });

  socket.on('champFound', ({ champId, champName }) => {
    const code = socket._coopRoom;
    if (!code || !coopRooms[code]) return;
    const room = coopRooms[code];
    if (room.found[champId]) return;
    const ev = { champId, champName, playerId: socket.id, playerName: socket._coopName, ts: Date.now() };
    room.found[champId] = ev;
    if (room.players[socket.id]) room.players[socket.id].score++;
    io.to(code).emit('champFound', { ...ev, players: coopPlayers(room) });
  });

  /* ─── DUEL ─── */
  socket.on('duel:create', ({ name, options }, cb) => {
    const pn = name || 'Joueur';
    let code;
    do { code = genCode('D'); } while (duelRooms[code]);
    socket._duelRoom = code; socket._duelName = pn;
    duelRooms[code] = {
      phase: 'lobby', options: sanitizeOpts(options),
      gameTimer: null, readyTimer: null,
      players: {
        [socket.id]: { name: pn, foundCount: 0, foundIds: new Set(), streak: 0, ready: false }
      }
    };
    socket.join(code);
    cb({ ok: true, code });
  });

  socket.on('duel:join', ({ name, code }, cb) => {
    const room = duelRooms[code];
    if (!room)                                 { cb({ ok: false, error: 'Salle introuvable' }); return; }
    if (room.phase !== 'lobby')                { cb({ ok: false, error: 'Partie déjà en cours' }); return; }
    if (Object.keys(room.players).length >= 2) { cb({ ok: false, error: 'Salle complète (2 max)' }); return; }
    const pn = name || 'Joueur';
    socket._duelRoom = code; socket._duelName = pn;
    room.players[socket.id] = { name: pn, foundCount: 0, foundIds: new Set(), streak: 0, ready: false };
    socket.join(code);
    cb({ ok: true, code, players: duelPlayers(room), options: room.options });
    socket.to(code).emit('duel:playerJoined', { players: duelPlayers(room) });
  });

  socket.on('duel:updateOptions', ({ options }) => {
    const code = socket._duelRoom;
    if (!code || !duelRooms[code]) return;
    const room = duelRooms[code];
    if (Object.keys(room.players)[0] !== socket.id) return; // host only
    room.options = sanitizeOpts(options);
    socket.to(code).emit('duel:optionsUpdate', { options: room.options });
  });

  socket.on('duel:ready', () => {
    const code = socket._duelRoom;
    if (!code || !duelRooms[code]) return;
    const room = duelRooms[code];
    if (room.phase !== 'lobby') return;
    if (room.players[socket.id]) room.players[socket.id].ready = true;
    io.to(code).emit('duel:playerReady', { players: duelPlayers(room) });
    const all = Object.values(room.players);
    if (all.length >= 1 && all.every(p => p.ready)) {
      clearTimeout(room.readyTimer);
      duelStart(code);
      return;
    }
    if (!room.readyTimer) {
      room.readyTimer = setTimeout(() => {
        if (duelRooms[code] && duelRooms[code].phase === 'lobby') duelStart(code);
      }, 30000);
    }
  });

  socket.on('duel:found', ({ champId }) => {
    const code = socket._duelRoom;
    if (!code || !duelRooms[code]) return;
    const room = duelRooms[code];
    if (room.phase !== 'playing') return;
    const me = room.players[socket.id];
    if (!me || me.foundIds.has(champId)) return;

    me.foundIds.add(champId);
    me.foundCount++;
    me.streak++;

    // Reset opponent streak
    const oppId = Object.keys(room.players).find(id => id !== socket.id);
    if (oppId && room.players[oppId]) room.players[oppId].streak = 0;

    io.to(code).emit('duel:found', { playerId: socket.id, champId, players: duelPlayers(room) });

    // Win check
    if (me.foundCount >= room.options.champCount) {
      duelEnd(code, socket.id);
      return;
    }

    // Attack mode
    if (room.options.attackMode && me.streak >= room.options.atkThreshold) {
      me.streak = 0;
      const opp = oppId ? room.players[oppId] : null;
      if (opp && opp.foundCount > 0) {
        const arr = Array.from(opp.foundIds);
        const victim = arr[Math.floor(Math.random() * arr.length)];
        opp.foundIds.delete(victim);
        opp.foundCount--;
        io.to(code).emit('duel:attacked', {
          attackerId : socket.id,
          targetId   : oppId,
          victimId   : victim,
          players    : duelPlayers(room)
        });
      }
    }
  });

  socket.on('duel:rejoin', ({ code }) => {
    const room = duelRooms[code];
    if (!room) return;
    if (room.players[socket.id]) {
      room.players[socket.id].ready      = false;
      room.players[socket.id].foundCount = 0;
      room.players[socket.id].foundIds   = new Set();
      room.players[socket.id].streak     = 0;
    }
    room.phase = 'lobby';
    clearTimeout(room.gameTimer);
    clearTimeout(room.readyTimer);
    room.readyTimer = null;
    io.to(code).emit('duel:playerReady', { players: duelPlayers(room) });
  });

  /* ─── BATTLE (game6) ─── */
  socket.on('battle:create', ({ name }, cb) => {
    const pn = name || 'Joueur';
    let code;
    do { code = genCode('B'); } while (battleRooms[code]);
    socket._battleRoom = code; socket._battleName = pn;
    battleRooms[code] = {
      phase: 'lobby', round: 0, foundCount: 0,
      readyTimer: null, roundTimer: null, interPending: false,
      players: { [socket.id]: { name: pn, score: 0, ready: false, found: false } }
    };
    socket.join(code);
    cb({ ok: true, code });
  });

  socket.on('battle:join', ({ name, code }, cb) => {
    const room = battleRooms[code];
    if (!room)                  { cb({ ok: false, error: 'Salle introuvable' }); return; }
    if (room.phase === 'over')  { cb({ ok: false, error: 'Partie terminée' }); return; }
    const pn = name || 'Joueur';
    socket._battleRoom = code; socket._battleName = pn;
    room.players[socket.id] = { name: pn, score: 0, ready: false, found: false };
    socket.join(code);
    cb({ ok: true, code, players: battlePlayers(room), phase: room.phase, round: room.round });
    socket.to(code).emit('battle:playerJoined', { players: battlePlayers(room) });
  });

  socket.on('battle:ready', () => {
    const code = socket._battleRoom;
    if (!code || !battleRooms[code]) return;
    const room = battleRooms[code];
    if (room.phase !== 'lobby') return;
    if (room.players[socket.id]) room.players[socket.id].ready = true;
    io.to(code).emit('battle:playerReady', { players: battlePlayers(room) });
    const all = Object.values(room.players);
    if (all.length >= 1 && all.every(p => p.ready)) {
      clearTimeout(room.readyTimer); battleStart(code); return;
    }
    if (!room.readyTimer) {
      room.readyTimer = setTimeout(() => {
        if (battleRooms[code] && battleRooms[code].phase === 'lobby') battleStart(code);
      }, 30000);
    }
  });

  socket.on('battle:found', ({ champId }) => {
    const code = socket._battleRoom;
    if (!code || !battleRooms[code]) return;
    const room = battleRooms[code];
    if (room.phase !== 'playing') return;
    if (!room.players[socket.id] || room.players[socket.id].found) return;
    room.players[socket.id].found = true;
    room.players[socket.id].score++;
    room.foundCount++;
    io.to(code).emit('battle:found', {
      playerId: socket.id, playerName: socket._battleName, players: battlePlayers(room)
    });
    if (room.foundCount >= Object.keys(room.players).length) battleInter(code);
  });

  /* ─── DISCONNECT ─── */
  socket.on('disconnect', () => {
    // Coop
    const cc = socket._coopRoom;
    if (cc && coopRooms[cc]) {
      const r = coopRooms[cc];
      delete r.players[socket.id];
      socket.to(cc).emit('playerLeft', { id: socket.id, players: coopPlayers(r) });
      if (!Object.keys(r.players).length) setTimeout(() => delete coopRooms[cc], 3_600_000);
    }
    // Duel
    const dc = socket._duelRoom;
    if (dc && duelRooms[dc]) {
      const r = duelRooms[dc];
      const wasPlaying = r.phase === 'playing';
      delete r.players[socket.id];
      socket.to(dc).emit('duel:playerLeft', { players: duelPlayers(r) });
      if (wasPlaying && Object.keys(r.players).length === 1) {
        duelEnd(dc, Object.keys(r.players)[0]);
      }
      if (!Object.keys(r.players).length) {
        clearTimeout(r.gameTimer); clearTimeout(r.readyTimer);
        setTimeout(() => delete duelRooms[dc], 3_600_000);
      }
    }
    // Battle
    const bc = socket._battleRoom;
    if (bc && battleRooms[bc]) {
      const r = battleRooms[bc];
      delete r.players[socket.id];
      socket.to(bc).emit('battle:playerLeft', { players: battlePlayers(r) });
      if (!Object.keys(r.players).length) {
        clearTimeout(r.roundTimer); clearTimeout(r.readyTimer);
        setTimeout(() => delete battleRooms[bc], 3_600_000);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`\u2705 Serveur sur le port ${PORT}`));
