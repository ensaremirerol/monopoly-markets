'use strict';
// ============================================================================
// game-p2p.js — serverless host-authority transport via Trystero + WebRTC.
// ----------------------------------------------------------------------------
// No backend. Peers find each other through the public BitTorrent DHT (via
// Trystero's torrent strategy) and then talk directly, browser-to-browser,
// over WebRTC data channels. Works from a plain static host (GitHub Pages) —
// no server, no API key, no build step for the dependency itself.
//
// Trystero is loaded as an ES module (see index.html) and exposed on
// `window.trystero`. NOTE: the version pinned in the original spec
// (@0.21/dist/torrent.js as a classic <script>) does not exist — modern
// Trystero ships ESM only, and 0.25+ removed the bundled torrent strategy.
// We load `trystero@0.21.1/torrent/+esm` (jsDelivr's self-contained bundle),
// which still exports { joinRoom, selfId }.
//
// This layer is deliberately thin: it does raw message passing, peer join /
// leave, and per-peer targeted sends. The host-authority game protocol
// (validating actions, computing a *per-peer* view — the host sees the full
// order queue, a player sees only their own) lives one level up in net.js.
// A fixed "broadcast the same state to everyone" model (as sketched in the
// integration spec) cannot express per-peer views, so we expose the transport
// primitives instead and let net.js drive them.
//
// Full mesh caveat: Trystero connects every peer to every other peer, so a
// guest also sees other guests as peers. We identify the host as "the first
// peer that sends us a game message" — guests never send to each other, only
// to the host, so this is unambiguous.
// ============================================================================
(function () {
  // Unique to this game so rooms don't collide with other Trystero apps
  // sharing the public torrent trackers.
  var APP_ID = 'monopoly-markets-v1';

  function trystero() {
    return (typeof window !== 'undefined' && window.trystero) || null;
  }

  function getRoomIdFromURL() {
    try { return new URLSearchParams(location.search).get('room'); } catch (e) { return null; }
  }

  function generateRoomId() {
    return Math.random().toString(36).slice(2, 10);
  }

  function buildJoinURL(roomId) {
    var base = '';
    try { base = location.origin + location.pathname; } catch (e) { base = ''; }
    return base + '?room=' + encodeURIComponent(roomId);
  }

  // ── HOST ────────────────────────────────────────────────────────────────
  // The host's browser is authoritative. It receives ACTION-style messages
  // from guests and pushes state back with per-peer targeted sends.
  //
  //   createHost({ roomId, onMessage, onPeerJoin, onPeerLeave })
  //     onMessage(peerId, data)  — a guest sent us a message
  //     onPeerJoin(peerId)       — a guest's WebRTC channel opened
  //     onPeerLeave(peerId)      — a guest disconnected
  //
  //   returns { sendTo(peerId, data), broadcast(data), peers(), leave() }
  function createHost(cfg) {
    var t = trystero();
    if (!t) throw new Error('Trystero not loaded');
    var room = t.joinRoom({ appId: APP_ID }, cfg.roomId);
    var action = room.makeAction('game');
    var send = action[0], recv = action[1];
    var peers = {};

    recv(function (data, peerId) { cfg.onMessage && cfg.onMessage(peerId, data); });
    room.onPeerJoin(function (peerId) {
      peers[peerId] = true;
      cfg.onPeerJoin && cfg.onPeerJoin(peerId);
    });
    room.onPeerLeave(function (peerId) {
      delete peers[peerId];
      cfg.onPeerLeave && cfg.onPeerLeave(peerId);
    });

    return {
      sendTo: function (peerId, data) { try { send(data, peerId); } catch (e) { /* peer gone */ } },
      broadcast: function (data) { try { send(data); } catch (e) { /* no peers */ } },
      peers: function () { return Object.keys(peers); },
      leave: function () { try { room.leave(); } catch (e) { /* ignore */ } },
    };
  }

  // ── GUEST ───────────────────────────────────────────────────────────────
  //   joinAsPlayer({ roomId, onMessage, onHostConnect, onHostLeave })
  //     onMessage(data, peerId)  — the host pushed us a message
  //     onHostConnect(peerId)    — we identified the host (first inbound msg)
  //     onHostLeave(peerId)      — the host disconnected
  //
  //   returns { send(data), leave() }
  function joinAsPlayer(cfg) {
    var t = trystero();
    if (!t) throw new Error('Trystero not loaded');
    var room = t.joinRoom({ appId: APP_ID }, cfg.roomId);
    var action = room.makeAction('game');
    var send = action[0], recv = action[1];
    var hostId = null;

    recv(function (data, peerId) {
      // The host is the only peer that ever sends us a message.
      if (!hostId) { hostId = peerId; cfg.onHostConnect && cfg.onHostConnect(peerId); }
      cfg.onMessage && cfg.onMessage(data, peerId);
    });
    room.onPeerLeave(function (peerId) {
      if (peerId === hostId) { hostId = null; cfg.onHostLeave && cfg.onHostLeave(peerId); }
    });

    return {
      // Target the host once known; before that, broadcast (only the host is
      // listening for guest messages anyway).
      send: function (data) { try { hostId ? send(data, hostId) : send(data); } catch (e) { /* ignore */ } },
      leave: function () { try { room.leave(); } catch (e) { /* ignore */ } },
    };
  }

  var P2P = {
    APP_ID: APP_ID,
    getRoomIdFromURL: getRoomIdFromURL,
    generateRoomId: generateRoomId,
    buildJoinURL: buildJoinURL,
    createHost: createHost,
    joinAsPlayer: joinAsPlayer,
  };

  if (typeof window !== 'undefined') window.GameP2P = P2P;
  if (typeof module !== 'undefined' && module.exports) module.exports = P2P;
})();
