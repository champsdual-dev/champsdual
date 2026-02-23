const express = require('express');
const http    = require('http');
const path    = require('path');
const { Server } = require('socket.io');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

/* ── Fichiers statiques (HTML, CSS, JS) ── */
app.use(express.static(path.join(__dirname)));

/* ── Fallback → index.html
   IMPORTANT : exclure /socket.io/ sinon ça casse le websocket ── */
app.get(/^(?!\/socket\.io).*$/, (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

/* ═══════════════════ SALLES MULTIJOUEUR ═══════════════════ */
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
    console.log(`[${code}] créée par ${playerName}`);
  });

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
    console.log(`[${code}] ${playerName} a rejoint`);
  });

  socket.on('champFound', ({ champId, champName }) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    if (room.found[champId]) return;
    const ev = { champId, champName, playerId: socket.id, playerName, ts: Date.now() };
    room.found[champId] = ev;
    if (room.players[socket.id]) room.players[socket.id].score++;
    io.to(currentRoom).emit('champFound', { ...ev, players: buildPlayers(room) });
  });

  socket.on('disconnect', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    delete room.players[socket.id];
    socket.to(currentRoom).emit('playerLeft', { id: socket.id, players: buildPlayers(room) });
    if (Object.keys(room.players).length === 0) {
      setTimeout(() => { delete rooms[currentRoom]; }, 3_600_000);
    }
  });
});

/* ── bind sur 0.0.0.0 obligatoire pour Railway ── */
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Serveur lancé → http://0.0.0.0:${PORT}`);
});
