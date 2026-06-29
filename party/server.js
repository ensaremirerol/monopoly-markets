// ============================================================================
// PartyKit server — one authoritative game room per party.
// ----------------------------------------------------------------------------
// Concurrency: a PartyKit party is a single Cloudflare Durable Object —
// single-threaded, messages handled one at a time — and this server is the
// ONLY writer of game state (clients merely propose orders the host approves).
// So there are no races and no locks: every message reads the latest state,
// applies one pure reducer step, persists, and re-broadcasts.
//
// Run locally:  npm run party:dev     Deploy:  npm run party:deploy
// ============================================================================
import engine from '../src/engine.js';
import Room from '../src/room.js';

Room.setEngine(engine); // esbuild bundles can't always require(); inject explicitly.

export default class GameServer {
  constructor(party) {
    this.party = party;
    this.room = null; // created when a host starts the game
  }

  // Restore a persisted game after the Durable Object wakes from hibernation.
  async onStart() {
    const saved = await this.party.storage.get('room');
    if (saved) this.room = saved;
  }

  async persist() {
    await this.party.storage.put('room', this.room);
  }

  onConnect(conn) {
    // Bring the newcomer up to date (or tell them no game has started yet).
    this.sendView(conn);
  }

  async onMessage(raw, sender) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'host': // start/host a new game
        this.room = Room.claimHost(Room.create(msg.opts || {}), sender.id);
        break;

      case 'join': {
        const res = Room.joinPlayer(this.requireRoom(), sender.id, { playerIdx: msg.playerIdx, name: msg.name });
        if (res.error) return this.sendError(sender, res.error);
        this.room = res.room;
        break;
      }

      case 'order': {
        const res = Room.queueOrder(this.requireRoom(), sender.id, msg.order || {});
        if (res.error) return this.sendError(sender, res.error);
        this.room = res.room;
        break;
      }

      case 'approve': {
        if (!this.isHost(sender)) return this.sendError(sender, 'Only the host can approve');
        const res = Room.approveOrder(this.room, msg.orderId);
        if (res.error) return this.sendError(sender, res.error); // order stays queued
        this.room = res.room;
        break;
      }

      case 'reject':
        if (!this.isHost(sender)) return this.sendError(sender, 'Only the host can reject');
        this.room = Room.rejectOrder(this.room, msg.orderId);
        break;

      case 'advance':
        if (!this.isHost(sender)) return this.sendError(sender, 'Only the host can advance');
        this.room = Room.advance(this.room).room;
        break;

      default:
        return;
    }

    await this.persist();
    this.broadcastViews();
  }

  // ── helpers ──
  requireRoom() {
    if (!this.room) this.room = Room.create({}); // tolerate a join before host
    return this.room;
  }
  isHost(conn) {
    return this.room && this.room.hostConnId === conn.id;
  }
  sendError(conn, error) {
    conn.send(JSON.stringify({ type: 'error', error }));
  }
  sendView(conn) {
    if (!this.room) return conn.send(JSON.stringify({ type: 'idle' }));
    conn.send(JSON.stringify({ type: 'state', view: Room.viewFor(this.room, conn.id) }));
  }
  // Each connection gets its own view (host sees the full queue, players only
  // their own), so we send per-connection rather than a blanket broadcast.
  broadcastViews() {
    for (const conn of this.party.getConnections()) this.sendView(conn);
  }
}
