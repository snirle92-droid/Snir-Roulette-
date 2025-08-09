import express from 'express';
import http from 'http';
import cors from 'cors';
import serveStatic from 'serve-static';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { nanoid } from 'nanoid';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());

// Serve the client folder statically
const clientDir = path.resolve(__dirname, '../client');
app.use('/', serveStatic(clientDir, { index: ['index.html'] }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ----- Roulette helpers -----
const REDS = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
const isRed = (n) => REDS.has(n);
const isBlack = (n) => n !== 0 && !REDS.has(n);
const isEven = (n) => n !== 0 && n % 2 === 0;
const isOdd  = (n) => n % 2 === 1;
const inLow  = (n) => n >= 1 && n <= 18;
const inHigh = (n) => n >= 19 && n <= 36;
const inDozen = (n, d) => {
  if (d === 1) return n >= 1 && n <= 12;
  if (d === 2) return n >= 13 && n <= 24;
  if (d === 3) return n >= 25 && n <= 36;
  return false;
};

// European wheel order (clockwise), starting from 0 position marker
const WHEEL = [0,32,15,19,4,21,2,25,17,34,6,27,13,36,11,30,8,23,10,5,24,16,33,1,20,14,31,9,22,18,29,7,28,12,35,3,26];

function spinWheel() {
  // European roulette: single zero 0–36
  return Math.floor(Math.random() * 37); // 0..36
}

// ----- Room state -----
const MAX_PLAYERS = 5;
const START_CHIPS = 1000;
const BETTING_WINDOW_MS = 30_000;

/** rooms = {
 *  [roomId]: {
 *     id,
 *     players: Map(client => { id, name, chips, joinedAt }),
 *     playerIndex: Map(playerId => ws),
 *     round: number,
 *     phase: 'waiting'|'betting'|'spinning',
 *     bets: Map(playerId => Array<{type, value, amount, round}>)
 *     timerEnd: number,
 *     lastResult: { number, color, ts } | null,
 *     history: Array<{ number, color, ts }>,
 *     tick: NodeJS.Timer | null,
 *  }
 * }
 */
const rooms = new Map();

function getRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = {
      id: roomId,
      players: new Map(),
      playerIndex: new Map(),
      round: 0,
      phase: 'waiting',
      bets: new Map(),
      timerEnd: 0,
      lastResult: null,
      history: [],
      tick: null,
    };
    rooms.set(roomId, room);
  }
  return room;
}

function aggregatePublicBets(room) {
  // Aggregate bets by spot for UI chips
  const agg = {};
  for (const [pid, list] of room.bets) {
    for (const b of list || []) {
      if (b.round !== room.round) continue;
      let key = '';
      if (b.type === 'number') key = `n_${b.value}`;
      else if (b.type === 'color') key = `color_${b.value}`;
      else if (b.type === 'parity') key = `parity_${b.value}`;
      else if (b.type === 'range') key = `range_${b.value}`;
      else if (b.type === 'dozen') key = `dozen_${b.value}`;
      if (!key) continue;
      agg[key] = (agg[key] || 0) + b.amount;
    }
  }
  return agg;
}

function broadcast(room, payload) {
  const msg = JSON.stringify(payload);
  for (const [ws] of room.players) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

function serializeRoom(room) {
  const players = [];
  for (const [ws, p] of room.players) {
    players.push({ id: p.id, name: p.name, chips: p.chips, joinedAt: p.joinedAt });
  }
  players.sort((a,b)=>a.joinedAt-b.joinedAt);
  return {
    id: room.id,
    round: room.round,
    phase: room.phase,
    timerEnd: room.timerEnd,
    players,
    lastResult: room.lastResult,
    history: room.history.slice(-20),
    publicBets: aggregatePublicBets(room),
    wheel: WHEEL
  };
}

function ensureBettingLoop(room) {
  if (room.phase === 'waiting' && room.players.size > 0) {
    startBetting(room);
  }
}

function startBetting(room) {
  room.phase = 'betting';
  room.round += 1;
  room.timerEnd = Date.now() + BETTING_WINDOW_MS;
  // Clear previous round bets
  for (const [pid] of room.playerIndex) {
    room.bets.set(pid, []);
  }
  scheduleTicks(room);
  broadcast(room, { type: 'room_update', data: serializeRoom(room) });
}

function scheduleTicks(room) {
  if (room.tick) clearInterval(room.tick);
  room.tick = setInterval(() => {
    broadcast(room, { type: 'timer', data: { now: Date.now(), timerEnd: room.timerEnd } });
    if (room.phase === 'betting' && Date.now() >= room.timerEnd) {
      clearInterval(room.tick);
      room.tick = null;
      startSpin(room);
    }
  }, 250);
}

function startSpin(room) {
  room.phase = 'spinning';
  broadcast(room, { type: 'room_update', data: serializeRoom(room) });
  setTimeout(() => resolveRound(room), 1600);
}

function resolveRound(room) {
  const n = spinWheel();
  const color = n === 0 ? 'green' : isRed(n) ? 'red' : 'black';
  const result = { number: n, color, ts: Date.now() };
  room.lastResult = result;
  room.history.push(result);

  // Payouts
  for (const [pid, ws] of room.playerIndex) {
    const bets = room.bets.get(pid) || [];
    let delta = 0;
    for (const bet of bets) {
      const { type, value, amount, round } = bet;
      if (round !== room.round) continue;
      switch (type) {
        case 'number':
          if (value === n) delta += amount * 35;
          break;
        case 'color':
          if ((value === 'red' && isRed(n)) || (value === 'black' && isBlack(n))) delta += amount;
          break;
        case 'parity':
          if ((value === 'even' && isEven(n)) || (value === 'odd' && isOdd(n))) delta += amount;
          break;
        case 'range':
          if ((value === 'low' && inLow(n)) || (value === 'high' && inHigh(n))) delta += amount;
          break;
        case 'dozen':
          if (inDozen(n, value)) delta += amount * 2;
          break;
        default:
          break;
      }
    }
    const p = [...room.players.values()].find(pp => pp.id === pid);
    if (p) p.chips += delta;
  }

  broadcast(room, { type: 'spin_result', data: result });
  broadcast(room, { type: 'room_update', data: serializeRoom(room) });

  if (room.players.size > 0) startBetting(room); else room.phase = 'waiting';
}

function placeBet(room, playerId, bet) {
  const p = [...room.players.values()].find(pp => pp.id === playerId);
  if (!p) return { ok: false, error: 'player_not_found' };
  if (room.phase !== 'betting') return { ok: false, error: 'not_in_betting_phase' };
  const amount = Math.floor(bet.amount || 0);
  if (amount <= 0) return { ok: false, error: 'invalid_amount' };
  if (p.chips < amount) return { ok: false, error: 'insufficient_chips' };

  const normalized = { type: bet.type, value: bet.value, amount, round: room.round };
  const valid = (
    (normalized.type === 'number' && Number.isInteger(normalized.value) && normalized.value >= 0 && normalized.value <= 36) ||
    (normalized.type === 'color' && (normalized.value === 'red' || normalized.value === 'black')) ||
    (normalized.type === 'parity' && (normalized.value === 'even' || normalized.value === 'odd')) ||
    (normalized.type === 'range' && (normalized.value === 'low' || normalized.value === 'high')) ||
    (normalized.type === 'dozen' && (normalized.value === 1 || normalized.value === 2 || normalized.value === 3))
  );
  if (!valid) return { ok: false, error: 'invalid_bet' };

  p.chips -= amount; // deduct stake now
  const arr = room.bets.get(playerId) || [];
  arr.push(normalized);
  room.bets.set(playerId, arr);

  // Notify immediately to show chips
  broadcast(room, { type: 'room_update', data: serializeRoom(room) });
  return { ok: true };
}

wss.on('connection', (ws) => {
  ws.id = nanoid(8);
  ws.on('message', (buf) => {
    let msg = null;
    try { msg = JSON.parse(buf.toString()); } catch { return; }
    const { type, data } = msg || {};

    if (type === 'join') {
      const { roomId, name } = data || {};
      const room = getRoom(roomId || 'lobby');
      if (room.players.size >= MAX_PLAYERS) {
        ws.send(JSON.stringify({ type: 'error', data: { code: 'room_full' } }));
        return;
      }
      const player = { id: ws.id, name: (name || 'Player').slice(0,18), chips: START_CHIPS, joinedAt: Date.now() };
      room.players.set(ws, player);
      room.playerIndex.set(player.id, ws);
      ws.roomId = room.id;
      ws.send(JSON.stringify({ type: 'joined', data: { playerId: player.id, room: serializeRoom(room) } }));
      broadcast(room, { type: 'room_update', data: serializeRoom(room) });
      ensureBettingLoop(room);
      return;
    }

    if (type === 'place_bet') {
      const room = rooms.get(ws.roomId);
      if (!room) return;
      const result = placeBet(room, data.playerId, data.bet);
      ws.send(JSON.stringify({ type: 'bet_result', data: result }));
      return;
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomId);
    if (!room) return;
    const p = room.players.get(ws);
    if (p) {
      room.players.delete(ws);
      room.playerIndex.delete(p.id);
      broadcast(room, { type: 'room_update', data: serializeRoom(room) });
      if (room.players.size === 0) {
        if (room.tick) clearInterval(room.tick);
        rooms.delete(room.id);
      }
    }
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`HTTP+WS server on http://localhost:${PORT}`));
