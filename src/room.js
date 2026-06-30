'use strict';
// ============================================================================
// Monopoly Markets — room reducer (cloud multiplayer, Kahoot-style join)
// ----------------------------------------------------------------------------
// Pure, transport-free logic for a host-authoritative room. The PartyKit
// server (party/server.js) owns one Room per game and is the ONLY writer, so
// these reducers never need locks: clients only *propose* orders the host
// approves, and the engine validates every applied move.
//
// Players are NOT pre-defined — the host opens a lobby (with a QR code) and
// players add themselves with their own names. A stable `clientId` (kept in
// the phone's localStorage) maps a person to their player across reconnects,
// so a dropped phone rejoins its own slot instead of spawning a duplicate.
//
//   game:     engine state (players appended as people join)
//   members:  connId   -> { role:'host'|'player', clientId, playerIdx? }
//   clients:  clientId -> playerIdx           (survives reconnects)
//   queue:    [ { id, fromConnId, order, status:'pending', ts } ]
//   started:  false in the lobby, true once the host starts the game
// ============================================================================

var engine = null;
try { if (typeof require !== 'undefined') engine = require('./engine'); } catch (e) { /* bundled env */ }
if (!engine && typeof window !== 'undefined') engine = window.GameEngine;
if (!engine && typeof globalThis !== 'undefined' && globalThis.GameEngine) engine = globalThis.GameEngine;
function setEngine(e) { engine = e; }

// Monopoly seats 2–8 players. The cap also doubles as an abuse limit since a
// client that knows the room code is otherwise untrusted.
var MIN_PLAYERS = 2;
var MAX_PLAYERS = 8;
var MAX_PENDING_PER_PLAYER = 20;
var MAX_NAME_LEN = 24;

function cleanName(name) {
  return String(name == null ? '' : name).replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LEN);
}

function create(opts) {
  return {
    game: engine.createInitialState(opts || {}),
    members: {},
    clients: {},
    queue: [],
    hostConnId: null,
    hostClientId: null,
    nextOrderId: 1,
    started: false,
  };
}

function clone(room) {
  return {
    game: room.game,
    members: Object.assign({}, room.members),
    clients: Object.assign({}, room.clients),
    queue: room.queue.slice(),
    hostConnId: room.hostConnId,
    hostClientId: room.hostClientId,
    nextOrderId: room.nextOrderId,
    started: room.started,
  };
}

function claimHost(room, connId, clientId) {
  var r = clone(room);
  r.members[connId] = { role: 'host', clientId: clientId || null };
  r.hostConnId = connId;
  r.hostClientId = clientId || null;
  return r;
}

// Add a player (new name) or re-attach a returning one by clientId.
function addPlayer(room, connId, clientId, name) {
  var r = clone(room);
  var clean = cleanName(name);
  if (clientId && r.clients[clientId] != null) {
    var idx = r.clients[clientId];
    r.members[connId] = { role: 'player', clientId: clientId, playerIdx: idx };
    if (clean) {
      r.game = Object.assign({}, r.game, {
        players: r.game.players.map(function (p, i) { return i === idx ? Object.assign({}, p, { name: clean }) : p; }),
      });
    }
    return { room: r, playerIdx: idx };
  }
  if (r.game.players.length >= MAX_PLAYERS) return { room: room, error: 'Room is full' };
  r.game = engine.addPlayer(r.game, clean || ('Player ' + (r.game.players.length + 1)));
  var newIdx = r.game.players.length - 1;
  if (clientId) r.clients[clientId] = newIdx;
  r.members[connId] = { role: 'player', clientId: clientId || null, playerIdx: newIdx };
  return { room: r, playerIdx: newIdx };
}

function startGame(room) {
  if (room.game.players.length < MIN_PLAYERS) {
    return { room: room, error: 'Need at least ' + MIN_PLAYERS + ' players to start' };
  }
  var r = clone(room);
  r.started = true;
  return { room: r };
}

function fail(room, msg) { return { room: room, error: msg }; }

function queueOrder(room, connId, order) {
  if (!room.started) return fail(room, 'The game has not started yet');
  var member = room.members[connId];
  if (!member || typeof member.playerIdx !== 'number') return fail(room, 'Join the game before placing orders');
  var pending = room.queue.filter(function (q) { return q.order.playerIdx === member.playerIdx; }).length;
  if (pending >= MAX_PENDING_PER_PLAYER) return fail(room, 'Too many pending orders — wait for the host to clear some');
  var r = clone(room);
  var id = 'o' + r.nextOrderId++;
  // Stamp the player from the trusted membership, never the client payload.
  var stamped = {
    playerIdx: member.playerIdx,
    stockId: order.stockId,
    action: order.action,
    qty: order.qty,
    margin: !!order.margin,
  };
  r.queue = r.queue.concat([{ id: id, fromConnId: connId, order: stamped, status: 'pending', ts: Date.now() }]);
  return { room: r, orderId: id };
}

function approveOrder(room, orderId) {
  var item = null;
  for (var i = 0; i < room.queue.length; i++) if (room.queue[i].id === orderId) item = room.queue[i];
  if (!item) return fail(room, 'Order not found');
  var res = engine.applyTrade(room.game, item.order);
  if (res.error) return fail(room, res.error); // leave game untouched
  var r = clone(room);
  r.game = res.state;
  r.queue = r.queue.filter(function (q) { return q.id !== orderId; });
  return { room: r, txn: res.txn };
}

function rejectOrder(room, orderId) {
  var r = clone(room);
  r.queue = r.queue.filter(function (q) { return q.id !== orderId; });
  return r;
}

function advance(room, rng) {
  var res = engine.advanceRound(room.game, rng);
  var r = clone(room);
  r.game = res.state;
  return { room: r, events: res.events, liquidations: res.liquidations };
}

// What a given connection is allowed to see. Everyone sees the market and the
// lobby roster; the host sees every pending order, a player sees only their own.
function viewFor(room, connId) {
  var member = room.members[connId] || { role: 'spectator' };
  var isHost = member.role === 'host';
  var queue = isHost
    ? room.queue.slice()
    : room.queue.filter(function (q) { return typeof member.playerIdx === 'number' && q.order.playerIdx === member.playerIdx; });
  var youName;
  if (typeof member.playerIdx === 'number' && room.game.players[member.playerIdx]) {
    youName = room.game.players[member.playerIdx].name;
  }
  return {
    role: member.role,
    you: { playerIdx: member.playerIdx, name: youName },
    started: room.started,
    players: room.game.players.map(function (p) { return p.name; }),
    queue: queue,
    game: room.game,
  };
}

var ROOM = {
  setEngine: setEngine,
  create: create,
  claimHost: claimHost,
  addPlayer: addPlayer,
  startGame: startGame,
  queueOrder: queueOrder,
  approveOrder: approveOrder,
  rejectOrder: rejectOrder,
  advance: advance,
  viewFor: viewFor,
};

if (typeof module !== 'undefined' && module.exports) module.exports = ROOM;
if (typeof window !== 'undefined') window.GameRoom = ROOM;
