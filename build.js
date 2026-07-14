#!/usr/bin/env node
'use strict';
// ============================================================================
// build.js — splice the editable sources back into the distributed bundle.
// ----------------------------------------------------------------------------
// index.html is a self-contained bundle: fonts + the DC runtime are packed as
// base64 assets, and the app itself lives inside a JSON-stringified
// <script type="__bundler/template"> blob. We never hand-edit that blob.
// Instead we keep the app in src/ and this script re-injects it:
//
//   • src/markup.html   → the <x-dc> markup (between </helmet> and </x-dc>)
//   • src/component.js  → the <script type="text/x-dc"> component body
//   • src/engine.js     → injected as a plain <script id="game-engine"> so it
//                         runs in true global scope and sets window.GameEngine
//
// The fonts and runtime are left untouched. Re-runnable (idempotent).
// ============================================================================
const fs = require('fs');
const path = require('path');

const root = __dirname;
const indexPath = path.join(root, 'index.html');
const markup = fs.readFileSync(path.join(root, 'src/markup.html'), 'utf8').trim();
const component = fs.readFileSync(path.join(root, 'src/component.js'), 'utf8').trim();
const engine = fs.readFileSync(path.join(root, 'src/engine.js'), 'utf8').trim();
const net = fs.readFileSync(path.join(root, 'src/net.js'), 'utf8').trim();
const p2p = fs.readFileSync(path.join(root, 'src/game-p2p.js'), 'utf8').trim();
const roomjs = fs.readFileSync(path.join(root, 'src/room.js'), 'utf8').trim();
const qrcode = fs.readFileSync(path.join(root, 'src/qrcode.js'), 'utf8').trim();

// Trystero (P2P transport dependency) is loaded from jsDelivr as a self-contained
// ES module and exposed on window.trystero. See src/game-p2p.js for why this exact
// URL (0.21.1 /torrent/+esm) rather than the classic <script> the spec suggested.
// Discovery strategy: nostr (not torrent). The WebTorrent trackers the torrent
// strategy uses are flaky and iOS Safari often can't complete the WebSocket
// handshake to them, so a phone would join the room but never find the host.
// Nostr relays are plain TLS WebSockets to well-known hosts — Safari-friendly
// and far more reliable for rendezvous. Same joinRoom/selfId API.
const TRYSTERO_TAG =
  '<script type="module" id="trystero-cdn">\n' +
  "import { joinRoom, selfId } from 'https://cdn.jsdelivr.net/npm/trystero@0.21.1/nostr/+esm';\n" +
  'window.trystero = { joinRoom: joinRoom, selfId: selfId };\n' +
  "window.dispatchEvent(new Event('trystero-ready'));\n" +
  '</script>\n';

// On-screen connection diagnostics. Phones have no dev console, so this overlay
// prints each connection milestone + uncaught errors right on the page. It
// shows automatically when the URL has ?room= or ?debug, or on any error. It
// re-attaches itself to <html> so the app re-rendering the <body> can't wipe it.
const DIAG_SCRIPT = fs.readFileSync(path.join(root, 'src/diag.js'), 'utf8').trim();
const DIAG_TAG = '<script id="mp-diag-boot">\n' + DIAG_SCRIPT + '\n</script>\n';

let html = fs.readFileSync(indexPath, 'utf8');

// 1) Pull the template string out of the bundle.
const tplRe = /(<script type="__bundler\/template">\s*)([\s\S]*?)(\s*<\/script>)/;
const tplMatch = html.match(tplRe);
if (!tplMatch) throw new Error('Could not find __bundler/template script in index.html');
let template = JSON.parse(tplMatch[2]);

// 2) Swap the app markup (everything between </helmet> and </x-dc>).
const helmetEnd = template.indexOf('</helmet>');
const xdcClose = template.indexOf('</x-dc>');
if (helmetEnd === -1 || xdcClose === -1) throw new Error('Could not locate </helmet> or </x-dc> in template');
template = template.slice(0, helmetEnd + '</helmet>'.length) +
  '\n\n' + markup + '\n\n' +
  template.slice(xdcClose);

// 3) Replace the component body inside the text/x-dc script.
const scriptOpenRe = /<script type="text\/x-dc"[^>]*>/;
const openMatch = template.match(scriptOpenRe);
if (!openMatch) throw new Error('Could not find <script type="text/x-dc"> in template');
const bodyStart = openMatch.index + openMatch[0].length;
const bodyEnd = template.indexOf('</script>', bodyStart);
if (bodyEnd === -1) throw new Error('Unterminated text/x-dc script');
template = template.slice(0, bodyStart) + '\n' + component + '\n' + template.slice(bodyEnd);

// 4) Inject the engine and the networking layer as plain global scripts just
//    before the component (so window.GameEngine / window.GameNet exist when the
//    DC runtime evaluates the component). Strip prior injections so rebuilds
//    stay clean.
template = template.replace(/<script id="game-engine">[\s\S]*?<\/script>\s*/, '');
template = template.replace(/<script id="game-p2p">[\s\S]*?<\/script>\s*/, '');
template = template.replace(/<script id="game-room">[\s\S]*?<\/script>\s*/, '');
template = template.replace(/<script id="game-net">[\s\S]*?<\/script>\s*/, '');
template = template.replace(/<script id="game-qr">[\s\S]*?<\/script>\s*/, '');
const reOpenMatch = template.match(scriptOpenRe); // index shifted after step 3
// Order matters: room.js reads window.GameEngine at load; net.js reads
// window.GameEngine, window.GameRoom and window.GameP2P at connect time.
const globals = '<script id="game-qr">\n' + qrcode + '\n</script>\n' +
  '<script id="game-engine">\n' + engine + '\n</script>\n' +
  '<script id="game-p2p">\n' + p2p + '\n</script>\n' +
  '<script id="game-room">\n' + roomjs + '\n</script>\n' +
  '<script id="game-net">\n' + net + '\n</script>\n';
template = template.slice(0, reOpenMatch.index) + globals + template.slice(reOpenMatch.index);

// 4b) Load Trystero in the OUTER page <head> (a real ES-module <script>, not
//     inside the JSON template blob) so window.trystero is ready before the app
//     boots. Strip any prior injection first so rebuilds stay idempotent.
html = html.replace(/[ \t]*<script type="module" id="trystero-cdn">[\s\S]*?<\/script>\s*/, '');
html = html.replace('</head>', '  ' + TRYSTERO_TAG + '</head>'); // first match = outer <head>

// 4c) On-screen diagnostics overlay, injected into the outer <body>. Anchor at
//     the very end of the file — the template JSON blob contains its own
//     (earlier) </body>, so a first-match replace would land inside the blob and
//     get overwritten when the template is re-stringified in step 5.
html = html.replace(/[ \t]*<script id="mp-diag-boot">[\s\S]*?<\/script>\s*/, '');
html = html.replace(/<\/body>\s*<\/html>\s*$/i, '  ' + DIAG_TAG + '</body>\n</html>\n');

// 5) Re-stringify and write the bundle back. Two escapes mirror what the
//    original bundler did, both by replacing the "/" with its / form:
//      • "</script"  — so the embedded JSON can't prematurely terminate the
//        outer <script type="__bundler/template"> element.
//      • "</x-dc>"   — the runtime's boot() re-fetches this raw file and
//        string-slices <x-dc>…</x-dc> out of it (a hot-reload path). If a
//        literal close tag survives here it slices the *escaped* JSON markup
//        and overwrites the correctly-parsed DOM with garbage. Hiding the
//        close tag makes that slice find no end and bail (as the original).
html = html.replace(tplRe, function (_, open, _body, close) {
  const json = JSON.stringify(template)
    .replace(/<\/script/gi, '<\\u002Fscript')
    .replace(/<\/x-dc/gi, '<\\u002Fx-dc');
  return open + json + close;
});
fs.writeFileSync(indexPath, html);
console.log('Built index.html  (markup %d B, component %d B, engine %d B)', markup.length, component.length, engine.length);
