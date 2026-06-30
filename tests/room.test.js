'use strict';
const { test, run, assert } = require('./harness');
const Room = require('../src/room');

function seq(values) { let i = 0; return () => values[Math.min(i++, values.length - 1)]; }
// Online host games start with NO players — players add themselves (Kahoot-style).
function fresh() { return Room.create({ gameName: 'Game', mode: 'integer', names: [] }); }
// A started room with the given [connId, clientId, name] players.
function started(players) {
  let r = fresh();
  players.forEach(function (p) { r = Room.addPlayer(r, p[0], p[1], p[2]).room; });
  return Room.startGame(r).room;
}
const TWO = [['c1', 'cid1', 'Maya'], ['c2', 'cid2', 'Sam']];

// ── Lobby & membership ──────────────────────────────────────────────────────
test('create starts empty: no players, not started, no members', () => {
  const r = fresh();
  assert.strictEqual(r.game.players.length, 0);
  assert.strictEqual(r.started, false);
  assert.deepStrictEqual(Object.keys(r.members), []);
});
test('claimHost marks the connection as host', () => {
  const r = Room.claimHost(fresh(), 'h', 'host-client');
  assert.strictEqual(r.members['h'].role, 'host');
  assert.strictEqual(r.hostConnId, 'h');
});
test('addPlayer appends a player and assigns the connection', () => {
  const res = Room.addPlayer(fresh(), 'c1', 'cid1', 'Maya');
  assert.strictEqual(res.playerIdx, 0);
  assert.strictEqual(res.room.game.players.length, 1);
  assert.strictEqual(res.room.game.players[0].name, 'Maya');
  assert.strictEqual(res.room.members['c1'].playerIdx, 0);
});
test('a second client adds a second, distinct player', () => {
  let r = Room.addPlayer(fresh(), 'c1', 'cid1', 'Maya').room;
  const res = Room.addPlayer(r, 'c2', 'cid2', 'Sam');
  assert.strictEqual(res.playerIdx, 1);
  assert.strictEqual(res.room.game.players.length, 2);
  assert.strictEqual(res.room.game.players[1].name, 'Sam');
});
test('reconnecting with the same clientId rejoins the same player (no duplicate)', () => {
  let r = Room.addPlayer(fresh(), 'c1', 'cid1', 'Maya').room;
  const res = Room.addPlayer(r, 'c1-reconnect', 'cid1', 'Maya');
  assert.strictEqual(res.room.game.players.length, 1);
  assert.strictEqual(res.playerIdx, 0);
  assert.strictEqual(res.room.members['c1-reconnect'].playerIdx, 0);
});

// ── Starting (2–8 players, Monopoly rules) ──────────────────────────────────
test('startGame is refused with fewer than 2 players', () => {
  assert.ok(Room.startGame(fresh()).error); // 0 players
  const one = Room.addPlayer(fresh(), 'c1', 'cid1', 'Maya').room;
  assert.ok(Room.startGame(one).error);      // 1 player
  assert.strictEqual(Room.startGame(one).room.started, false);
});
test('startGame starts the game with 2+ players', () => {
  let r = Room.addPlayer(fresh(), 'c1', 'cid1', 'Maya').room;
  r = Room.addPlayer(r, 'c2', 'cid2', 'Sam').room;
  const res = Room.startGame(r);
  assert.strictEqual(res.error, undefined);
  assert.strictEqual(res.room.started, true);
});

// ── Trading ───────────────────────────────────────────────────────────────
test('queueOrder is rejected before the game has started', () => {
  let r = Room.addPlayer(fresh(), 'c1', 'cid1', 'Maya').room;
  r = Room.addPlayer(r, 'c2', 'cid2', 'Sam').room;
  const res = Room.queueOrder(r, 'c1', { stockId: 'BPI', action: 'buy', qty: 1 });
  assert.ok(res.error);
});
test('queueOrder works after start, stamped to the member player (anti-spoof)', () => {
  const r = started(TWO);
  const res = Room.queueOrder(r, 'c1', { playerIdx: 9, stockId: 'BPI', action: 'buy', qty: 2 });
  assert.strictEqual(res.error, undefined);
  assert.strictEqual(res.room.queue[0].order.playerIdx, 0);
  assert.ok(res.orderId);
});
test('queueOrder rejects a connection that has not joined', () => {
  const r = Room.claimHost(started(TWO), 'h', 'hc');
  const res = Room.queueOrder(r, 'h', { stockId: 'BPI', action: 'buy', qty: 1 });
  assert.ok(res.error);
});
test('approveOrder applies a valid order and clears it', () => {
  let r = started(TWO);
  const queued = Room.queueOrder(r, 'c1', { stockId: 'BPI', action: 'buy', qty: 2 });
  r = queued.room;
  const res = Room.approveOrder(r, queued.orderId);
  assert.strictEqual(res.error, undefined);
  assert.strictEqual(res.room.game.players[0].portfolio.BPI.shares, 2);
  assert.strictEqual(res.room.queue.find(q => q.id === queued.orderId), undefined);
});
test('approveOrder surfaces an engine rejection without changing the game', () => {
  let r = started(TWO);
  r = Room.queueOrder(r, 'c1', { stockId: 'BPI', action: 'sell', qty: 5 }).room;
  const res = Room.approveOrder(r, r.queue[0].id);
  assert.ok(res.error);
  assert.deepStrictEqual(res.room.game.players[0].portfolio, {});
});
test('rejectOrder drops a pending order without touching the game', () => {
  let r = started(TWO);
  r = Room.queueOrder(r, 'c1', { stockId: 'BPI', action: 'buy', qty: 2 }).room;
  r = Room.rejectOrder(r, r.queue[0].id);
  assert.strictEqual(r.queue.length, 0);
  assert.deepStrictEqual(r.game.players[0].portfolio, {});
});
test('advance moves the game forward a round', () => {
  const res = Room.advance(started(TWO), seq([0, 0, 0.46, 0.46, 0.46, 0.46, 0.46, 0.46, 0.46, 0.46]));
  assert.strictEqual(res.room.game.round, 2);
});

// ── Per-connection views ────────────────────────────────────────────────────
test('the host view includes the lobby roster, started flag and full queue', () => {
  let r = Room.claimHost(fresh(), 'h', 'hc');
  r = Room.addPlayer(r, 'c1', 'cid1', 'Maya').room;
  r = Room.addPlayer(r, 'c2', 'cid2', 'Sam').room;
  r = Room.startGame(r).room;
  r = Room.queueOrder(r, 'c1', { stockId: 'BPI', action: 'buy', qty: 1 }).room;
  const v = Room.viewFor(r, 'h');
  assert.strictEqual(v.role, 'host');
  assert.strictEqual(v.started, true);
  assert.deepStrictEqual(v.players, ['Maya', 'Sam']);
  assert.strictEqual(v.queue.length, 1);
});
test('a player view shows only their own queued orders, name and index', () => {
  let r = started(TWO);
  r = Room.queueOrder(r, 'c1', { stockId: 'BPI', action: 'buy', qty: 1 }).room;
  r = Room.queueOrder(r, 'c2', { stockId: 'CCF', action: 'buy', qty: 1 }).room;
  const v = Room.viewFor(r, 'c2');
  assert.strictEqual(v.role, 'player');
  assert.strictEqual(v.you.playerIdx, 1);
  assert.strictEqual(v.you.name, 'Sam');
  assert.strictEqual(v.queue.length, 1);
  assert.strictEqual(v.queue[0].order.playerIdx, 1);
});
test('an unjoined connection sees a spectator view with the started flag', () => {
  const v = Room.viewFor(fresh(), 'nobody');
  assert.strictEqual(v.role, 'spectator');
  assert.strictEqual(v.started, false);
});

// ── Abuse limits (a malicious client knows the room code) ───────────────────
test('queueOrder caps how many pending orders one player can stack', () => {
  let r = started(TWO);
  for (let i = 0; i < 20; i++) r = Room.queueOrder(r, 'c1', { stockId: 'BPI', action: 'buy', qty: 1 }).room;
  const res = Room.queueOrder(r, 'c1', { stockId: 'BPI', action: 'buy', qty: 1 });
  assert.ok(res.error); // 21st is rejected
});
test('addPlayer caps the room at 8 players (Monopoly rules)', () => {
  let r = fresh();
  for (let i = 0; i < 8; i++) r = Room.addPlayer(r, 'c' + i, 'cid' + i, 'P' + i).room;
  const res = Room.addPlayer(r, 'cX', 'cidX', 'Late');
  assert.ok(res.error);
  assert.strictEqual(res.room.game.players.length, 8);
});
test('a long player name is truncated when added', () => {
  const res = Room.addPlayer(fresh(), 'c1', 'cid1', 'x'.repeat(200));
  assert.ok(res.room.game.players[0].name.length <= 24);
});

run();
