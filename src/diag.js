'use strict';
// ============================================================================
// diag.js — on-screen P2P connection diagnostics.
// ----------------------------------------------------------------------------
// Phones can't easily open a dev console, so we print connection milestones and
// uncaught errors onto the page. net.js calls window.MPLOG(...) at each step.
// The panel shows automatically when the URL carries ?room= (a guest joining)
// or ?debug, and forces itself visible on any error. It lives on <html> so the
// app rebuilding <body> can't remove it.
// ============================================================================
(function () {
  var lines = [];
  var shown = false;

  function panel() {
    var el = document.getElementById('mp-diag');
    if (!el) {
      el = document.createElement('div');
      el.id = 'mp-diag';
      el.style.cssText = [
        'position:fixed', 'left:0', 'right:0', 'bottom:0', 'max-height:50vh',
        'overflow:auto', 'background:rgba(0,0,0,0.92)', 'color:#3fb950',
        'font:11px/1.45 ui-monospace,Menlo,Consolas,monospace', 'padding:8px 10px',
        'z-index:2147483647', 'white-space:pre-wrap', 'word-break:break-word',
        'border-top:1px solid #238636', 'display:' + (shown ? 'block' : 'none'),
      ].join(';');
      (document.body || document.documentElement).appendChild(el);
    }
    return el;
  }

  function render() { try { panel().textContent = lines.join('\n'); } catch (e) { /* pre-DOM */ } }

  function stamp() {
    try { return new Date().toTimeString().slice(0, 8); } catch (e) { return ''; }
  }

  window.MPLOG = function (s) {
    lines.push('[' + stamp() + '] ' + s);
    if (lines.length > 200) lines.shift();
    render();
  };
  window.MPDIAG_SHOW = function () { shown = true; try { panel().style.display = 'block'; } catch (e) { } };

  try {
    var qs = new URLSearchParams(location.search);
    if (qs.has('debug') || qs.has('room')) window.MPDIAG_SHOW();
  } catch (e) { /* ignore */ }

  window.addEventListener('error', function (e) {
    var m = (e && (e.message || (e.error && e.error.message))) || 'error';
    window.MPLOG('JS ERROR: ' + m + (e && e.filename ? ' @' + e.filename + ':' + e.lineno : ''));
    window.MPDIAG_SHOW();
  });
  window.addEventListener('unhandledrejection', function (e) {
    window.MPLOG('PROMISE REJECTED: ' + (e && e.reason ? (e.reason.message || e.reason) : ''));
    window.MPDIAG_SHOW();
  });

  // Wrap RTCPeerConnection to watch the actual WebRTC handshake. This runs at
  // load, before Trystero creates any connection (that happens on a click), so
  // every peer connection is instrumented. ICE "checking → failed" is the
  // signature of a NAT that STUN can't traverse (needs TURN); a jump to
  // "connected" means the data path is up.
  try {
    var OrigPC = window.RTCPeerConnection || window.webkitRTCPeerConnection;
    if (OrigPC && !OrigPC.__mpWrapped) {
      var Wrapped = function (cfg) {
        var pc = new OrigPC(cfg);
        try {
          var ice = (cfg && cfg.iceServers) || [];
          var hasTurn = ice.some(function (s) {
            return [].concat(s.urls || []).some(function (u) { return /^turns?:/i.test(u); });
          });
          window.MPLOG('RTCPeerConnection · iceServers=' + ice.length + ' · TURN=' + hasTurn);
          pc.addEventListener('iceconnectionstatechange', function () {
            window.MPLOG('ICE: ' + pc.iceConnectionState);
            if (pc.iceConnectionState === 'failed') {
              window.MPLOG('→ WebRTC could not connect. This is symmetric-NAT (cellular): a working TURN relay is required.');
              window.MPDIAG_SHOW();
            }
          });
        } catch (e) { /* ignore */ }
        return pc;
      };
      Wrapped.prototype = OrigPC.prototype;
      Wrapped.__mpWrapped = true;
      window.RTCPeerConnection = Wrapped;
    }
  } catch (e) { /* ignore */ }

  window.MPLOG('boot · ' + navigator.userAgent);
  window.MPLOG('secureContext=' + window.isSecureContext +
    ' · RTCPeerConnection=' + (typeof RTCPeerConnection !== 'undefined') +
    ' · WebSocket=' + (typeof WebSocket !== 'undefined'));

  window.addEventListener('trystero-ready', function () { window.MPLOG('trystero module loaded ✓'); });
  setTimeout(function () {
    if (!(window.trystero && window.trystero.joinRoom)) {
      window.MPLOG('✗ Trystero did NOT load after 8s — ES-module import blocked. ' +
        'Likely an in-app/webview browser or a browser that blocks CDN modules. ' +
        'Open the link in the real Safari/Chrome app.');
      window.MPDIAG_SHOW();
    }
  }, 8000);
})();
