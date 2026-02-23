const express = require('express');
const http    = require('http');
const path    = require('path');
const { Server } = require('socket.io');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

/* ── Serve all HTML/CSS/JS files from the same folder ── */
app.use(express.static(path.join(__dirname, 'public')));

/* Fallback: any unknown route → index.html */
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ════════════════════════════════════════
   ROOMS
   room = {
     startTime : number,
     found     : { [champId]: { champId, champName, playerId, playerName, ts } },
     players   : { [socketId]: { name, score } }
   }
════════════════════════════════════════ */
const rooms = {};

function genCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function buildPlayers(room) {
  return Object.entries(room.players).map(([id, p]) => ({ id, name: p.name, score: p.score }));
}

io.on('connection', socket => {
  let currentRoom = null;
  let playerName  = 'Joueur';

  /* ── CREATE ── */
  socket.on('createRoom', ({ name }, cb) => {
    playerName  = name || 'Joueur';
    const code  = genCode();
    currentRoom = code;
    rooms[code] = {
      startTime : Date.now(),
      found     : {},
      players   : { [socket.id]: { name: playerName, score: 0 } }
    };
    socket.join(code);
    cb({ ok: true, code, startTime: rooms[code].startTime });
    console.log(`[${code}] created by ${playerName}`);
  });

  /* ── JOIN ── */
  socket.on('joinRoom', ({ name, code }, cb) => {
    const room = rooms[code];
    if (!room) { cb({ ok: false, error: 'Salle introuvable' }); return; }
    playerName  = name || 'Joueur';
    currentRoom = code;
    room.players[socket.id] = { name: playerName, score: 0 };
    socket.join(code);
    cb({
      ok        : true,
      code,
      startTime : room.startTime,
      found     : Object.values(room.found),
      players   : buildPlayers(room)
    });
    socket.to(code).emit('playerJoined', { id: socket.id, name: playerName, players: buildPlayers(room) });
    console.log(`[${code}] ${playerName} joined`);
  });

  /* ── CHAMP FOUND ── */
  socket.on('champFound', ({ champId, champName }) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    if (room.found[champId]) return;                          // already found
    const ev = { champId, champName, playerId: socket.id, playerName, ts: Date.now() };
    room.found[champId] = ev;
    if (room.players[socket.id]) room.players[socket.id].score++;
    io.to(currentRoom).emit('champFound', { ...ev, players: buildPlayers(room) });
  });

  /* ── DISCONNECT ── */
  socket.on('disconnect', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    delete room.players[socket.id];
    socket.to(currentRoom).emit('playerLeft', { id: socket.id, players: buildPlayers(room) });
    if (Object.keys(room.players).length === 0) {
      setTimeout(() => { delete rooms[currentRoom]; }, 3_600_000); // clean after 1h
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Serveur démarré sur le port ${PORT}`));
