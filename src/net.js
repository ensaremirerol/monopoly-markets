'use strict';
// ============================================================================
// Monopoly Markets — client networking (serverless P2P multiplayer)
// ----------------------------------------------------------------------------
// Drop-in replacement for the old PartyKit WebSocket client. It keeps the exact
// same surface the UI already speaks to —
//
//     window.GameNet.connect({ room, role, onOpen, onStatus, onMessage })
//        → { send, close }
//
// — so component.js did not need to change how it talks to the network.
//
// The transport underneath is now peer-to-peer (game-p2p.js / Trystero), with
// NO server. One browser is the authority:
//
//   • role:'host'  — this browser holds the only authoritative game state and
//     runs the room reducers (src/room.js) locally. It is the same logic the
//     PartyKit Durable Object used to run server-side; here it just runs in the
//     host's tab. Guests' action messages arrive over WebRTC, get validated,
//     and each peer is sent its own per-connection view.
//
//   • role:'guest' — this browser holds no state. It relays the UI's messages
//     to the host and renders whatever view the host sends back.
//
// Messages in/out are identical to before:
//   UI → net : {type:'host'|'join'|'start'|'order'|'approve'|'reject'|'advance', …}
//   net → UI : {type:'state', view} | {type:'idle'} | {type:'error', error}
// ============================================================================
(function () {
  // A synthetic connection id for the host's own seat, so the host is just
  // another "connection" as far as the room reducers are concerned. Guest ids
  // come from Trystero and are long random strings, so no collision.
  var HOST_ID = '__host__';
  var TRYSTERO_TIMEOUT = 12000;

  function mplog(s) { try { if (window.MPLOG) window.MPLOG(s); } catch (e) { /* ignore */ } }

  // Trystero loads as an async ES module (index.html) and fires this event when
  // window.trystero is ready. connect() is always user-initiated (a button
  // click) well after page load, so this normally resolves immediately.
  function whenTrystero(onReady, onFail) {
    if (window.trystero && window.trystero.joinRoom) {
      // Defer so the synchronous connect() call returns and `this.conn` is
      // assigned before onOpen fires.
      setTimeout(onReady, 0);
      return;
    }
    var done = false;
    var timer = setTimeout(function () { if (!done) { done = true; onFail && onFail(); } }, TRYSTERO_TIMEOUT);
    window.addEventListener('trystero-ready', function () {
      if (done) return;
      done = true; clearTimeout(timer); onReady();
    }, { once: true });
  }

  function connect(opts) {
    var role = opts.role === 'host' ? 'host' : 'guest';
    var roomId = opts.room;
    var closed = false;
    var transport = null;
    var hostHandle = null;   // host: function(connId, msg)
    var outbox = [];         // messages sent before the transport is ready

    function status(s) { if (opts.onStatus) opts.onStatus(s); }
    function deliver(m) { if (opts.onMessage) opts.onMessage(m); }
    function fail() { status('error'); mplog('✗ transport failed to start (Trystero unavailable)'); }

    status('connecting');
    mplog('connect · role=' + role + ' · room=' + roomId);
    if (role === 'host') startHost(); else startGuest();

    // ── HOST: authoritative, runs the room reducers locally ────────────────
    function startHost() {
      whenTrystero(function () {
        if (closed) return;
        var R = window.GameRoom;
        if (!R) { fail(); return; }
        var game = null; // room.js state; created when the UI sends {type:'host'}

        mplog('host: joining P2P room…');
        transport = window.GameP2P.createHost({
          roomId: roomId,
          onPeerJoin: function (peerId) { mplog('host: peer joined ' + peerId); sendViewTo(peerId); },
          onPeerLeave: function (peerId) { mplog('host: peer left ' + peerId); },
          onMessage: function (peerId, data) { handle(peerId, data); },
        });

        function view(connId) {
          if (!game) return { type: 'idle' };
          return { type: 'state', view: R.viewFor(game, connId) };
        }
        function sendViewTo(connId) {
          if (connId === HOST_ID) deliver(view(connId));
          else transport.sendTo(connId, view(connId));
        }
        function broadcastViews() {
          sendViewTo(HOST_ID);
          transport.peers().forEach(sendViewTo);
        }
        function err(connId, error) {
          var m = { type: 'error', error: error };
          if (connId === HOST_ID) deliver(m); else transport.sendTo(connId, m);
        }
        function isHost(connId) { return game && game.hostConnId === connId; }
        function requireRoom() { if (!game) game = R.create({}); return game; }

        // Mirrors the old PartyKit server's onMessage switch exactly.
        function handle(connId, msg) {
          if (!msg || typeof msg !== 'object') return;
          switch (msg.type) {
            case 'host': {
              var r = game;
              if (r && r.hostClientId && msg.clientId !== r.hostClientId) {
                return err(connId, 'This room already has a host');
              }
              game = (r && r.game && r.hostClientId)
                ? R.claimHost(r, connId, msg.clientId)
                : R.claimHost(R.create(msg.opts || { names: [] }), connId, msg.clientId);
              break;
            }
            case 'join': {
              var jr = R.addPlayer(requireRoom(), connId, msg.clientId, msg.name);
              if (jr.error) return err(connId, jr.error);
              game = jr.room;
              break;
            }
            case 'start': {
              if (!isHost(connId)) return err(connId, 'Only the host can start');
              var sr = R.startGame(requireRoom());
              if (sr.error) return err(connId, sr.error);
              game = sr.room;
              break;
            }
            case 'order': {
              // The host trades from their own seat and, being the authority,
              // their orders fill immediately; guests' orders queue for approval.
              if (isHost(connId)) {
                var hr = R.applyHostOrder(requireRoom(), connId, msg.order || {});
                if (hr.error) return err(connId, hr.error);
                game = hr.room;
              } else {
                var or = R.queueOrder(requireRoom(), connId, msg.order || {});
                if (or.error) return err(connId, or.error);
                game = or.room;
              }
              break;
            }
            case 'approve': {
              if (!isHost(connId)) return err(connId, 'Only the host can approve');
              var ar = R.approveOrder(game, msg.orderId);
              if (ar.error) return err(connId, ar.error); // order stays queued
              game = ar.room;
              break;
            }
            case 'reject':
              if (!isHost(connId)) return err(connId, 'Only the host can reject');
              game = R.rejectOrder(game, msg.orderId);
              break;
            case 'advance':
              if (!isHost(connId)) return err(connId, 'Only the host can advance');
              game = R.advance(game).room;
              break;
            default:
              return;
          }
          broadcastViews();
        }

        hostHandle = handle;
        status('connected');
        mplog('host: P2P room ready, waiting for peers');
        if (opts.onOpen) opts.onOpen();          // → UI sends {type:'host'}
        flushOutbox(function (m) { handle(HOST_ID, m); });
      }, fail);
    }

    // ── GUEST: no state; relay to host, render host's views ────────────────
    function startGuest() {
      whenTrystero(function () {
        if (closed) return;
        mplog('guest: joining P2P room, searching for host over DHT…');
        var gotState = false;
        transport = window.GameP2P.joinAsPlayer({
          roomId: roomId,
          onMessage: function (data) {
            if (!gotState) { gotState = true; mplog('guest: first message from host (' + (data && data.type) + ') ✓'); }
            deliver(data);
          },
          onHostConnect: function () { status('connected'); mplog('guest: connected to host ✓'); },
          onHostLeave: function () { status('reconnecting'); mplog('guest: host connection lost'); },
        });
        if (opts.onOpen) opts.onOpen();
        flushOutbox(function (m) { transport.send(m); });
        // If no peer shows up, say so — this is the "same-Wi-Fi still fails" case.
        setTimeout(function () {
          if (!closed && !gotState) mplog('guest: still no host after 15s — host tab open on this room? trackers reachable?');
        }, 15000);
      }, fail);
    }

    function flushOutbox(fn) {
      var q = outbox; outbox = [];
      for (var i = 0; i < q.length; i++) fn(q[i]);
    }

    return {
      send: function (m) {
        if (closed) return;
        if (role === 'host') {
          if (hostHandle) hostHandle(HOST_ID, m); else outbox.push(m);
        } else {
          if (transport) transport.send(m); else outbox.push(m);
        }
      },
      close: function () {
        closed = true;
        try { if (transport) transport.leave(); } catch (e) { /* ignore */ }
      },
    };
  }

  var NET = { connect: connect };
  if (typeof window !== 'undefined') window.GameNet = NET;
  if (typeof module !== 'undefined' && module.exports) module.exports = NET;
})();
