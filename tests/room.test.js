'use strict';
const { test, run, assert } = require('./harness');
const Room = require('../src/room');

function seq(values) { let i = 0; return () => values[Math.min(i++, values.length - 1)]; }
function fresh() { return Room.create({ gameName: 'Game', mode: 'integer', names: ['Maya', 'Sam', 'Lee'] }); }

// ── Membership & roles ──────────────────────────────────────────────────────
test('create starts with a game, no members and an empty queue', () => {
  const r = fresh();
  assert.strictEqual(r.game.players.length, 3);
  assert.deepStrictEqual(r.queue, []);
  assert.deepStrictEqual(Object.keys(r.members), []);
});
test('claimHost marks the connection as host', () => {
  const r = Room.claimHost(fresh(), 'conn-h');
  assert.strictEqual(r.members['conn-h'].role, 'host');
  assert.strictEqual(r.hostConnId, 'conn-h');
});
test('joinPlayer claims a player slot for a connection', () => {
  const r = Room.joinPlayer(fresh(), 'conn-1', { playerIdx: 1 }).room;
  assert.strictEqual(r.members['conn-1'].role, 'player');
  assert.strictEqual(r.members['conn-1'].playerIdx, 1);
});
test('joinPlayer rejects a slot that is already taken', () => {
  let r = Room.joinPlayer(fresh(), 'conn-1', { playerIdx: 1 }).room;
  const res = Room.joinPlayer(r, 'conn-2', { playerIdx: 1 });
  assert.ok(res.error);
});

// ── Queueing orders ─────────────────────────────────────────────────────────
test('queueOrder appends a pending order stamped with the member player', () => {
  let r = Room.joinPlayer(fresh(), 'c1', { playerIdx: 0 }).room;
  const res = Room.queueOrder(r, 'c1', { stockId: 'BPI', action: 'buy', qty: 2 });
  assert.strictEqual(res.error, undefined);
  const q = res.room.queue;
  assert.strictEqual(q.length, 1);
  assert.strictEqual(q[0].status, 'pending');
  assert.strictEqual(q[0].order.playerIdx, 0);   // server-stamped, not client-trusted
  assert.ok(q[0].id);
});
test('queueOrder ignores a client-supplied playerIdx (anti-spoof)', () => {
  let r = Room.joinPlayer(fresh(), 'c1', { playerIdx: 0 }).room;
  const res = Room.queueOrder(r, 'c1', { playerIdx: 2, stockId: 'BPI', action: 'buy', qty: 1 });
  assert.strictEqual(res.room.queue[0].order.playerIdx, 0);
});
test('queueOrder rejects a connection that has not claimed a player', () => {
  const r = Room.claimHost(fresh(), 'h');
  const res = Room.queueOrder(r, 'h', { stockId: 'BPI', action: 'buy', qty: 1 });
  assert.ok(res.error);
});

// ── Approving / rejecting ───────────────────────────────────────────────────
test('approveOrder applies a valid order to the game and clears it', () => {
  let r = Room.joinPlayer(fresh(), 'c1', { playerIdx: 0 }).room;
  const queued = Room.queueOrder(r, 'c1', { stockId: 'BPI', action: 'buy', qty: 2 });
  r = queued.room;
  const res = Room.approveOrder(r, queued.orderId);
  assert.strictEqual(res.error, undefined);
  assert.strictEqual(res.room.game.players[0].portfolio.BPI.shares, 2);
  assert.strictEqual(res.room.queue.find(q => q.id === queued.orderId), undefined); // removed
});
test('approveOrder surfaces an engine rejection without changing the game', () => {
  let r = Room.joinPlayer(fresh(), 'c1', { playerIdx: 0 }).room;
  r = Room.queueOrder(r, 'c1', { stockId: 'BPI', action: 'sell', qty: 5 }).room; // owns nothing
  const id = r.queue[0].id;
  const res = Room.approveOrder(r, id);
  assert.ok(res.error);
  assert.deepStrictEqual(res.room.game.players[0].portfolio, {});
});
test('rejectOrder drops a pending order without touching the game', () => {
  let r = Room.joinPlayer(fresh(), 'c1', { playerIdx: 0 }).room;
  r = Room.queueOrder(r, 'c1', { stockId: 'BPI', action: 'buy', qty: 2 }).room;
  const id = r.queue[0].id;
  r = Room.rejectOrder(r, id);
  assert.strictEqual(r.queue.length, 0);
  assert.deepStrictEqual(r.game.players[0].portfolio, {});
});

// ── Advancing ───────────────────────────────────────────────────────────────
test('advance moves the game forward a round', () => {
  const r = fresh();
  const res = Room.advance(r, seq([0, 0, 0.46, 0.46, 0.46, 0.46, 0.46, 0.46, 0.46, 0.46]));
  assert.strictEqual(res.room.game.round, 2);
});

// ── Per-connection views ────────────────────────────────────────────────────
test('the host view includes the full pending queue', () => {
  let r = Room.claimHost(fresh(), 'h');
  r = Room.joinPlayer(r, 'c1', { playerIdx: 0 }).room;
  r = Room.queueOrder(r, 'c1', { stockId: 'BPI', action: 'buy', qty: 1 }).room;
  const v = Room.viewFor(r, 'h');
  assert.strictEqual(v.role, 'host');
  assert.strictEqual(v.queue.length, 1);
});
test('a player view shows only their own queued orders and their player index', () => {
  let r = Room.joinPlayer(fresh(), 'c1', { playerIdx: 0 }).room;
  r = Room.joinPlayer(r, 'c2', { playerIdx: 1 }).room;
  r = Room.queueOrder(r, 'c1', { stockId: 'BPI', action: 'buy', qty: 1 }).room;
  r = Room.queueOrder(r, 'c2', { stockId: 'CCF', action: 'buy', qty: 1 }).room;
  const v = Room.viewFor(r, 'c2');
  assert.strictEqual(v.role, 'player');
  assert.strictEqual(v.you.playerIdx, 1);
  assert.strictEqual(v.queue.length, 1);                 // only c2's order
  assert.strictEqual(v.queue[0].order.playerIdx, 1);
});

run();
