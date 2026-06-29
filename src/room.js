'use strict';
// ============================================================================
// Monopoly Markets — room reducer (cloud multiplayer)
// ----------------------------------------------------------------------------
// Pure, transport-free logic for a host-authoritative multiplayer room. The
// PartyKit server (party/server.js) owns one Room per game and is the ONLY
// writer, so these reducers never need locks: clients merely *propose* orders
// that the host approves, and the engine validates every applied move.
//
//   members:  connId -> { role:'host'|'player', playerIdx?, name? }
//   queue:    [ { id, fromConnId, order, status:'pending', ts } ]
//   game:     the engine state (single source of truth)
//
// Mirrors src/engine.js packaging so it loads under Node (tests) and esbuild
// (PartyKit bundles the require below).
// ============================================================================

// Resolve the engine across runtimes: Node tests (require), the browser client
// (window.GameEngine), and esbuild/PartyKit bundles (which inject it via
// setEngine, since `require` may not exist at runtime there).
var engine = null;
try { if (typeof require !== 'undefined') engine = require('./engine'); } catch (e) { /* bundled env */ }
if (!engine && typeof window !== 'undefined') engine = window.GameEngine;
if (!engine && typeof globalThis !== 'undefined' && globalThis.GameEngine) engine = globalThis.GameEngine;
function setEngine(e) { engine = e; }

function create(opts) {
  return {
    game: engine.createInitialState(opts || {}),
    members: {},
    queue: [],
    hostConnId: null,
    nextOrderId: 1,
  };
}

function clone(room) {
  return {
    game: room.game,
    members: Object.assign({}, room.members),
    queue: room.queue.slice(),
    hostConnId: room.hostConnId,
    nextOrderId: room.nextOrderId,
  };
}

function claimHost(room, connId) {
  var r = clone(room);
  r.members[connId] = { role: 'host' };
  r.hostConnId = connId;
  return r;
}

function joinPlayer(room, connId, info) {
  info = info || {};
  var idx = info.playerIdx;
  if (typeof idx !== 'number' || idx < 0 || idx >= room.game.players.length) {
    return { room: room, error: 'Invalid player slot' };
  }
  // Reject a slot already held by a different connection.
  var taken = Object.keys(room.members).some(function (c) {
    return c !== connId && room.members[c].role === 'player' && room.members[c].playerIdx === idx;
  });
  if (taken) return { room: room, error: 'That player is already taken' };

  var r = clone(room);
  r.members[connId] = { role: 'player', playerIdx: idx, name: info.name || room.game.players[idx].name };
  return { room: r };
}

function queueOrder(room, connId, order) {
  var member = room.members[connId];
  if (!member || typeof member.playerIdx !== 'number') {
    return { room: room, error: 'Join as a player before placing orders' };
  }
  var r = clone(room);
  var id = 'o' + r.nextOrderId++;
  // Stamp the player from the trusted membership, never from the client payload.
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
  if (!item) return { room: room, error: 'Order not found' };

  var res = engine.applyTrade(room.game, item.order);
  if (res.error) {
    // Leave the game untouched; surface why so the host can tell the player.
    return { room: room, error: res.error };
  }
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
// leaderboard; the host sees every pending order, a player sees only their own.
function viewFor(room, connId) {
  var member = room.members[connId] || { role: 'spectator' };
  var isHost = member.role === 'host';
  var queue = isHost
    ? room.queue.slice()
    : room.queue.filter(function (q) { return typeof member.playerIdx === 'number' && q.order.playerIdx === member.playerIdx; });
  return {
    role: member.role,
    you: { playerIdx: member.playerIdx, name: member.name },
    game: room.game,
    queue: queue,
  };
}

var ROOM = {
  setEngine: setEngine,
  create: create,
  claimHost: claimHost,
  joinPlayer: joinPlayer,
  queueOrder: queueOrder,
  approveOrder: approveOrder,
  rejectOrder: rejectOrder,
  advance: advance,
  viewFor: viewFor,
};

if (typeof module !== 'undefined' && module.exports) module.exports = ROOM;
if (typeof window !== 'undefined') window.GameRoom = ROOM;
