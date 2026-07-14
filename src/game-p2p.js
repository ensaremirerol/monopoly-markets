'use strict';
// ============================================================================
// game-p2p.js — serverless host-authority transport via Trystero + WebRTC.
// ----------------------------------------------------------------------------
// No backend. Peers find each other through public Nostr relays (Trystero's
// nostr strategy — used only for signaling/rendezvous) and then talk directly,
// browser-to-browser, over WebRTC data channels. Works from a plain static host
// (GitHub Pages) — no server, no API key, no build step for the dependency.
//
// Trystero is loaded as an ES module (see index.html) and exposed on
// `window.trystero`. NOTE: the version pinned in the original spec
// (@0.21/dist/torrent.js as a classic <script>) does not exist — modern
// Trystero ships ESM only, and 0.25+ removed the bundled strategies. We load
// `trystero@0.21.1/nostr/+esm` (jsDelivr's self-contained bundle), which
// exports { joinRoom, selfId }. We use nostr rather than the torrent strategy
// because the WebTorrent trackers are flaky and iOS Safari can't reliably reach
// them (peers join but never find each other); nostr relays are Safari-friendly
// plain-TLS WebSockets.
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

  // Trystero's defaults ship STUN only (Google + Twilio). STUN is enough to
  // punch through most home/office NATs — which is why two laptops on different
  // networks connect fine — but it CANNOT traverse a symmetric NAT. Mobile
  // carriers put phones behind carrier-grade (symmetric) NAT, so a phone on
  // cellular needs a TURN relay to connect. These are the free public OpenRelay
  // (metered.ca) TURN servers, best-effort. For a reliable game (or if these go
  // down), provision your own TURN and set `window.TRYSTERO_TURN` to an
  // iceServers-style array before the page loads — it replaces these.
  var DEFAULT_TURN = [
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ];

  // Pinned Nostr relays for rendezvous. We pin an explicit, small set of big,
  // well-maintained relays (rather than trusting Trystero's rotating defaults)
  // and set relayRedundancy to the full count so EVERY peer announces on EVERY
  // relay — that guarantees the host and a guest share a relay and can find each
  // other. Override with window.TRYSTERO_RELAYS if these ever misbehave.
  var DEFAULT_RELAYS = [
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.primal.net',
    'wss://relay.snort.social',
  ];

  function trystero() {
    return (typeof window !== 'undefined' && window.trystero) || null;
  }

  // The room config handed to Trystero. `turnConfig` is merged into Trystero's
  // default STUN list, so we keep STUN (fast, direct) and fall back to TURN
  // (relayed) only when a direct path can't be found.
  function roomConfig() {
    var turn = (typeof window !== 'undefined' && Array.isArray(window.TRYSTERO_TURN))
      ? window.TRYSTERO_TURN : DEFAULT_TURN;
    var relays = (typeof window !== 'undefined' && Array.isArray(window.TRYSTERO_RELAYS))
      ? window.TRYSTERO_RELAYS : DEFAULT_RELAYS;
    var cfg = {
      appId: APP_ID,
      relayUrls: relays,
      relayRedundancy: relays.length,
      turnConfig: turn,
    };
    if (typeof window !== 'undefined' && window.TRYSTERO_RTC_CONFIG) cfg.rtcConfig = window.TRYSTERO_RTC_CONFIG;
    return cfg;
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
    var room = t.joinRoom(roomConfig(), cfg.roomId);
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
    var room = t.joinRoom(roomConfig(), cfg.roomId);
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
