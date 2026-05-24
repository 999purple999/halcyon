// ============================================================================
// HALCYON
//  - Serve la web app (HTTPS con cert self-signed auto-generato)
//  - Fa da "centralino" WebSocket per il mesh WebRTC (relay di offer/answer/ICE)
//  L'audio NON passa dal server: viaggia peer-to-peer tra i browser.
//
//   (hardening): logger leveled env-driven + /healthz + /readyz.
// ============================================================================

import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import selfsigned from 'selfsigned';
import { SettingsStore, isValidUserId, defaultDbPath } from './lib/settings_store.js';
import { ChatStore } from './lib/chat_store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ? Number(process.env.PORT) : 8443;
const PUBLIC_DIR = path.join(__dirname, 'public');
const CERT_DIR = path.join(__dirname, 'certs');
const START_TS = Date.now();

// ---------------------------------------------------------------------------
//  LOGGER leveled (vanilla, no deps). Routing per severity:
//    debug/info -> stdout   warn/error -> stderr   (process-supervisor friendly)
//  Livello da env LOG_LEVEL (default 'info'); banner di startup forzato a INFO.
// ---------------------------------------------------------------------------
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const MIN_LEVEL = LEVELS[LOG_LEVEL] ?? LEVELS.info;

function fmt(level, msg, args) {
  const ts = new Date().toISOString();
  const tag = level.toUpperCase().padEnd(5);
  const extra = args.length
    ? ' ' +
      args
        .map((a) => {
          if (a instanceof Error) return `${a.name}: ${a.message}`;
          if (typeof a === 'object') {
            try {
              return JSON.stringify(a);
            } catch {
              return String(a);
            }
          }
          return String(a);
        })
        .join(' ')
    : '';
  return `${ts} ${tag} ${msg}${extra}\n`;
}
const log = {
  debug: (msg, ...a) => {
    if (LEVELS.debug >= MIN_LEVEL) process.stdout.write(fmt('debug', msg, a));
  },
  info: (msg, ...a) => {
    if (LEVELS.info >= MIN_LEVEL) process.stdout.write(fmt('info', msg, a));
  },
  warn: (msg, ...a) => {
    if (LEVELS.warn >= MIN_LEVEL) process.stderr.write(fmt('warn', msg, a));
  },
  error: (msg, ...a) => {
    if (LEVELS.error >= MIN_LEVEL) process.stderr.write(fmt('error', msg, a));
  },
  // banner: SEMPRE visibile (utente deve vedere su che URL ha avviato)
  banner: (msg, ...a) => process.stdout.write(fmt('info', msg, a)),
};

// ---------------------------------------------------------------------------
//  Certificato self-signed (necessario: getUserMedia richiede HTTPS fuori da
//  localhost). Lo generiamo una volta sola e lo riusiamo.
// ---------------------------------------------------------------------------
function loadOrCreateCert() {
  const keyPath = path.join(CERT_DIR, 'key.pem');
  const certPath = path.join(CERT_DIR, 'cert.pem');
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  }
  log.info('Genero un certificato self-signed (solo la prima volta)...');
  const attrs = [{ name: 'commonName', value: 'halcyon-local' }];
  const pems = selfsigned.generate(attrs, {
    days: 3650,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [{ name: 'basicConstraints', cA: true }],
  });
  fs.mkdirSync(CERT_DIR, { recursive: true });
  fs.writeFileSync(keyPath, pems.private);
  fs.writeFileSync(certPath, pems.cert);
  return { key: pems.private, cert: pems.cert };
}

// ---------------------------------------------------------------------------
//  Static file server con cache ETag + compression negotiation (br/gzip).
//   - Strong ETag basato su SHA-1 short del contenuto: lo calcoliamo lazy
//     al primo hit e teniamo (etag, mtimeMs, compressed) in memoria.
//   - Per HTML uso `no-cache, must-revalidate`: il browser fa sempre IF-NONE-MATCH
//     ma riceve 304 se invariato → bandwidth quasi zero per il reload F5.
//   - Per asset versionabili (.js/.css) idem: stesso comportamento; basta cambiare
//     contenuto e l'ETag cambia.
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.svg', '.json']);
// Cache in-memory: filePath -> { etag, mtimeMs, raw, br, gz }
const fileCache = new Map();

function pickEncoding(req) {
  const ae = String(req.headers['accept-encoding'] || '').toLowerCase();
  if (ae.includes('br')) return 'br';
  if (ae.includes('gzip')) return 'gzip';
  return null;
}

function loadCachedFile(filePath, ext) {
  const stat = fs.statSync(filePath);
  const cached = fileCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached;
  const raw = fs.readFileSync(filePath);
  const etag = '"' + crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16) + '"';
  const entry = { etag, mtimeMs: stat.mtimeMs, raw, br: null, gz: null };
  if (COMPRESSIBLE.has(ext)) {
    try {
      entry.br = zlib.brotliCompressSync(raw, {
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 },
      });
    } catch {}
    try {
      entry.gz = zlib.gzipSync(raw, { level: 6 });
    } catch {}
  }
  fileCache.set(filePath, entry);
  return entry;
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  let entry;
  try {
    const ext = path.extname(filePath).toLowerCase();
    entry = loadCachedFile(filePath, ext);
    // === Conditional GET (304) ===
    const inm = req.headers['if-none-match'];
    if (inm && inm === entry.etag) {
      res.writeHead(304, {
        ETag: entry.etag,
        'Cache-Control': 'no-cache, must-revalidate',
      });
      return res.end();
    }
    // === Compression negotiation ===
    const enc = pickEncoding(req);
    let body = entry.raw;
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      ETag: entry.etag,
      'Cache-Control': 'no-cache, must-revalidate',
      Vary: 'Accept-Encoding',
      // Security headers a basso costo per LAN-only app
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    };
    if (enc === 'br' && entry.br) {
      body = entry.br;
      headers['Content-Encoding'] = 'br';
    } else if (enc === 'gzip' && entry.gz) {
      body = entry.gz;
      headers['Content-Encoding'] = 'gzip';
    }
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    res.end(body);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      res.writeHead(404);
      return res.end('Not found');
    }
    log.warn('static error', err.message);
    res.writeHead(500);
    res.end('Internal error');
  }
}

// Avoid unused: pipeline è importato per allinearsi a node:stream best-practice,
// in caso futuro di range/streaming.
void pipeline;

// ---------------------------------------------------------------------------
//  Health/Readiness — intercettati PRIMA di serveStatic per non confonderli
//  con file 404. Body JSON sempre; Cache-Control: no-store.
// ---------------------------------------------------------------------------
function uptimeSeconds() {
  return Math.round(((Date.now() - START_TS) / 1000) * 1000) / 1000;
}

function sendJSON(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function handleHealth(res) {
  sendJSON(res, 200, {
    status: 'ok',
    uptime_s: uptimeSeconds(),
    peers_count: peers.size,
    mode: 'p2p',
    port: PORT,
  });
}

function handleReady(res) {
  // Per il P2P legacy readiness == liveness: HTTPS server in listen + WS up.
  // Non ci sono modelli ML da caricare.
  const ready = httpsServer.listening;
  if (ready) {
    sendJSON(res, 200, {
      status: 'ready',
      uptime_s: uptimeSeconds(),
      peers_count: peers.size,
      profiles_count: settingsStore.size(),
      mode: 'p2p',
      port: PORT,
    });
  } else {
    sendJSON(res, 503, { status: 'starting', uptime_s: uptimeSeconds() });
  }
}

// ---------------------------------------------------------------------------
//   identita' persistente (settings store SQLite).
//  Endpoint REST:
//    GET  /api/settings?userId=<uuid>  -> 200 {settings, updatedAt} | 404
//    PUT  /api/settings  body {userId, settings} -> 200 {ok, updatedAt}
//    DELETE /api/settings?userId=<uuid> -> 200 {deleted}
//  Tutti rispondono JSON, no-store. Validation strict (UUID v4 o sess-...).
// ---------------------------------------------------------------------------
const settingsStore = new SettingsStore(defaultDbPath());
const chatStore = new ChatStore(defaultDbPath());
const DEFAULT_ROOM = 'main';

function parseQuery(req) {
  const url = req.url || '/';
  const q = url.split('?')[1] || '';
  const out = {};
  for (const part of q.split('&')) {
    if (!part) continue;
    const [k, v] = part.split('=');
    out[decodeURIComponent(k)] = v !== undefined ? decodeURIComponent(v) : '';
  }
  return out;
}

function readBody(req, maxBytes = 128 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let len = 0;
    req.on('data', (c) => {
      len += c.length;
      if (len > maxBytes) {
        req.destroy();
        reject(new Error('body_too_large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleSettingsGet(req, res) {
  const { userId } = parseQuery(req);
  if (!isValidUserId(userId)) return sendJSON(res, 400, { error: 'invalid_user_id' });
  const row = settingsStore.get(userId);
  if (!row) return sendJSON(res, 404, { error: 'not_found' });
  return sendJSON(res, 200, row);
}

async function handleSettingsPut(req, res) {
  let raw;
  try {
    raw = await readBody(req);
  } catch (e) {
    return sendJSON(res, 413, { error: e.message });
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return sendJSON(res, 400, { error: 'invalid_json' });
  }
  if (!body || typeof body !== 'object') return sendJSON(res, 400, { error: 'invalid_body' });
  const { userId, settings } = body;
  if (!isValidUserId(userId)) return sendJSON(res, 400, { error: 'invalid_user_id' });
  if (typeof settings !== 'object' || settings === null)
    return sendJSON(res, 400, { error: 'invalid_settings' });
  try {
    const row = settingsStore.put(userId, settings);
    return sendJSON(res, 200, { ok: true, ...row });
  } catch (e) {
    log.warn('settings put failed', e.message);
    return sendJSON(res, 400, { error: e.message });
  }
}

async function handleSettingsDelete(req, res) {
  const { userId } = parseQuery(req);
  if (!isValidUserId(userId)) return sendJSON(res, 400, { error: 'invalid_user_id' });
  const deleted = settingsStore.delete(userId);
  return sendJSON(res, 200, { deleted });
}

function requestHandler(req, res) {
  const url = (req.url || '/').split('?')[0];
  if (url === '/healthz') return handleHealth(res);
  if (url === '/readyz') return handleReady(res);
  if (url === '/api/settings') {
    if (req.method === 'GET') return handleSettingsGet(req, res);
    if (req.method === 'PUT' || req.method === 'POST') return handleSettingsPut(req, res);
    if (req.method === 'DELETE') return handleSettingsDelete(req, res);
    res.writeHead(405, { Allow: 'GET, PUT, POST, DELETE' });
    return res.end();
  }
  return serveStatic(req, res);
}

const { key, cert } = loadOrCreateCert();
const httpsServer = https.createServer({ key, cert }, requestHandler);

// ---------------------------------------------------------------------------
//  Signaling WebSocket — stanza singola, mesh full
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server: httpsServer });
/** @type {Map<string, {ws: import('ws').WebSocket, name: string}>} */
const peers = new Map();
let nextId = 1;

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

//  broadcast filtrato per stanza. Se srcId e' dato, usiamo il roomId
// del mittente; altrimenti tutti.
function broadcast(msg, exceptId, srcId = null) {
  const srcRoom = srcId ? peers.get(srcId)?.roomId : null;
  for (const [pid, peer] of peers) {
    if (pid === exceptId) continue;
    if (srcRoom && peer.roomId !== srcRoom) continue;
    send(peer.ws, msg);
  }
}

function broadcastInRoom(roomId, msg, exceptId = null) {
  for (const [pid, peer] of peers) {
    if (peer.roomId !== roomId) continue;
    if (pid === exceptId) continue;
    send(peer.ws, msg);
  }
}

// ---------------------------------------------------------------------------
//   sessionToken -> id mapping per riassociare la stessa sessione di
//  un client su reconnect (evita il "peer fantasma" lato altri client).
//  La mappa contiene anche un timer "grace" di 30s entro cui il peer puo'
//  riconnettersi senza essere notificato come left agli altri.
// ---------------------------------------------------------------------------
const sessionIndex = new Map(); // sessionToken -> id
const graceTimers = new Map(); // id -> setTimeout handle
const GRACE_MS = 30000;

wss.on('connection', (ws) => {
  let id = String(nextId++);
  let joined = false;
  // Heartbeat: socket marcato vivo a ogni pong (ws built-in) o a ogni 'ka'
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case 'join': {
        if (joined) return;
        joined = true;
        const name = String(msg.name || 'Anonimo').slice(0, 32);
        const token = typeof msg.sessionToken === 'string' ? msg.sessionToken.slice(0, 80) : null;
        const userId = isValidUserId(msg.userId) ? msg.userId : null; //  chat
        //  multi-room. Default 'main'; identificatore alfanumerico
        // [a-zA-Z0-9_-]{1,40}. Stanze auto-create al primo join.
        const roomId = (() => {
          const r = String(msg.roomId || 'main');
          return /^[a-zA-Z0-9_-]{1,40}$/.test(r) ? r : 'main';
        })();
        let resumed = false;
        // Riassocia la sessione se il token esiste e ha un id ancora vivo
        if (token && sessionIndex.has(token)) {
          const existingId = sessionIndex.get(token);
          const existing = peers.get(existingId);
          if (existing) {
            // Vecchio socket ancora aperto -> lo chiudiamo silenziosamente
            try {
              if (existing.ws !== ws && existing.ws.readyState === existing.ws.OPEN)
                existing.ws.terminate();
            } catch {}
            id = existingId;
            existing.ws = ws;
            existing.name = name;
            if (userId) existing.userId = userId;
            resumed = true;
            // cancella eventuale timer di grazia
            const g = graceTimers.get(id);
            if (g) {
              clearTimeout(g);
              graceTimers.delete(id);
            }
            log.info(`peer=${id} (${name}) RIPRISTINATO via sessionToken`);
          }
        }
        if (!resumed) {
          peers.set(id, { ws, name, token, userId, roomId });
          if (token) sessionIndex.set(token, id);
        } else {
          peers.get(id).roomId = roomId;
        }
        const others = [...peers.entries()]
          .filter(([pid, p]) => pid !== id && p.roomId === roomId)
          .map(([pid, p]) => ({ id: pid, name: p.name }));
        send(ws, { type: 'welcome', id, peers: others, resumed, roomId });
        if (!resumed) {
          // Solo per nuove sessioni notifichiamo peer-joined agli altri.
          broadcast({ type: 'peer-joined', id, name }, id);
          log.info(`peer=${id} (${name}) connesso. Totale: ${peers.size}`);
        } else {
          // Nome puo' essere cambiato durante la sessione persa -> broadcast rename
          broadcast({ type: 'peer-renamed', id, name }, id);
        }
        break;
      }
      // Cambio nome in tempo reale
      case 'rename': {
        const peer = peers.get(id);
        if (!peer) return;
        const name =
          String(msg.name || '')
            .trim()
            .slice(0, 32) || peer.name;
        peer.name = name;
        broadcast({ type: 'peer-renamed', id, name }, id);
        break;
      }
      // Relay puro di segnalazione WebRTC (sdp / ice) verso un peer specifico
      case 'signal': {
        const target = peers.get(String(msg.to));
        if (target) {
          send(target.ws, { type: 'signal', from: id, data: msg.data });
        }
        break;
      }
      //  keep-alive app-level. Rispondiamo con pong cosi' il client puo'
      // misurare la freschezza della pipe anche oltre il framing WebSocket.
      case 'ka': {
        send(ws, { type: 'pong', t: msg.t });
        break;
      }
      // ---------------------------------------------------------------------
      //  chat testuale per-stanza (persistente in SQLite messages).
      // ---------------------------------------------------------------------
      case 'chat:send': {
        const peer = peers.get(id);
        if (!peer || !peer.userId) {
          send(ws, { type: 'chat:error', reason: 'no_user_id' });
          break;
        }
        try {
          const m = chatStore.send({
            roomId: peer.roomId || DEFAULT_ROOM,
            fromId: peer.userId,
            fromName: peer.name,
            text: msg.text,
            replyTo: msg.replyTo || null,
          });
          // echo a tutti incluso sender (cosi' il client conosce id finale)
          const out = { type: 'chat:msg', ...m };
          send(ws, out);
          broadcast(out, id, id);
        } catch (e) {
          send(ws, { type: 'chat:error', reason: e.message });
        }
        break;
      }
      case 'chat:history': {
        const peer = peers.get(id);
        const roomId = peer?.roomId || DEFAULT_ROOM;
        const before = typeof msg.before === 'number' ? msg.before : Date.now() + 1;
        const limit = typeof msg.limit === 'number' ? msg.limit : 50;
        try {
          const items = chatStore.history({ roomId, before, limit });
          send(ws, { type: 'chat:history:resp', items });
        } catch (e) {
          send(ws, { type: 'chat:error', reason: e.message });
        }
        break;
      }
      case 'chat:edit': {
        const peer = peers.get(id);
        if (!peer?.userId) break;
        try {
          const ok = chatStore.edit({ id: msg.msgId, fromId: peer.userId, text: msg.text });
          if (ok) {
            const out = {
              type: 'chat:edit:ack',
              msgId: msg.msgId,
              text: msg.text,
              editedAt: Date.now(),
            };
            send(ws, out);
            broadcast(out, id, id);
          } else {
            send(ws, { type: 'chat:error', reason: 'edit_denied', msgId: msg.msgId });
          }
        } catch (e) {
          send(ws, { type: 'chat:error', reason: e.message });
        }
        break;
      }
      case 'chat:delete': {
        const peer = peers.get(id);
        if (!peer?.userId) break;
        const ok = chatStore.delete({ id: msg.msgId, fromId: peer.userId });
        if (ok) {
          const out = { type: 'chat:delete:ack', msgId: msg.msgId };
          send(ws, out);
          broadcast(out, id, id);
        } else {
          send(ws, { type: 'chat:error', reason: 'delete_denied', msgId: msg.msgId });
        }
        break;
      }
      case 'chat:typing': {
        const peer = peers.get(id);
        if (!peer) break;
        // Effimero, no persist. Solo broadcast leggero, filtrato per stanza.
        broadcast(
          { type: 'chat:typing', from: id, fromName: peer.name, isTyping: !!msg.isTyping },
          id,
          id,
        );
        break;
      }
      case 'chat:react': {
        const peer = peers.get(id);
        if (!peer?.userId) break;
        try {
          const action = chatStore.toggleReaction({
            msgId: msg.msgId,
            userId: peer.userId,
            emoji: msg.emoji,
          });
          const reactions = chatStore.reactionsFor(msg.msgId);
          const out = { type: 'chat:react:ack', msgId: msg.msgId, reactions, action };
          send(ws, out);
          broadcast(out, id, id);
        } catch (e) {
          send(ws, { type: 'chat:error', reason: e.message, msgId: msg.msgId });
        }
        break;
      }
      default:
        break;
    }
  });

  ws.on('close', () => {
    if (peers.has(id)) {
      const peer = peers.get(id);
      const { name, token } = peer;
      //  ritardiamo la notifica 'peer-left' agli altri di GRACE_MS
      // per dare al client la possibilita' di riconnettersi. Se entro la
      // finestra arriva un nuovo join con stesso sessionToken, riassociamo
      // (sopra nel handler 'join') -- altrimenti notifichiamo definitivamente.
      const finalize = () => {
        if (peers.get(id) && peers.get(id).ws === ws) {
          peers.delete(id);
          if (token) sessionIndex.delete(token);
          graceTimers.delete(id);
          broadcast({ type: 'peer-left', id }, id);
          log.info(`peer=${id} (${name}) disconnesso (definitivo). Totale: ${peers.size}`);
        }
      };
      if (token) {
        log.info(`peer=${id} (${name}) socket chiuso, grace ${GRACE_MS}ms`);
        graceTimers.set(id, setTimeout(finalize, GRACE_MS));
      } else {
        finalize();
      }
    }
  });
});

// ---------------------------------------------------------------------------
//   heartbeat dei socket. Ogni 25s pinghiamo tutti i client. Se al
//  giro successivo qualcuno non ha risposto (isAlive==false), terminiamo --
//  il close handler attivera' il grace period per la sessione.
// ---------------------------------------------------------------------------
const HEARTBEAT_MS = 25000;
const heartbeatTimer = setInterval(() => {
  for (const peer of peers.values()) {
    const sock = peer.ws;
    if (!sock || sock.readyState !== sock.OPEN) continue;
    if (sock.isAlive === false) {
      log.warn(`heartbeat: socket muto, termino (peer ${peer.name})`);
      try {
        sock.terminate();
      } catch {}
      continue;
    }
    sock.isAlive = false;
    try {
      sock.ping();
    } catch {}
  }
}, HEARTBEAT_MS);
heartbeatTimer.unref?.();

// ---------------------------------------------------------------------------
//  Avvio + stampa gli indirizzi LAN per i tuoi amici
// ---------------------------------------------------------------------------
function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const net of ifaces[name] || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

httpsServer.listen(PORT, '0.0.0.0', () => {
  // Banner is ALWAYS visible (forced INFO regardless of LOG_LEVEL).
  log.banner('========================================================');
  log.banner('  HALCYON  ·  server live');
  log.banner('========================================================');
  log.banner(`  LOG_LEVEL=${LOG_LEVEL}`);
  log.banner(`  On this machine:   https://localhost:${PORT}`);
  for (const ip of lanAddresses()) {
    log.banner(`  For your peers:    https://${ip}:${PORT}`);
  }
  log.banner('--------------------------------------------------------');
  log.banner('  /healthz and /readyz are available for external probes.');
  log.banner('  Note: on first access the browser will warn about the');
  log.banner('  self-signed certificate. That is expected.');
  log.banner('========================================================');
});

// Graceful shutdown -> /readyz returns 503 so clients can detect the drain window.
process.on('SIGTERM', () => {
  log.info('SIGTERM received, shutting down');
  httpsServer.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  log.info('SIGINT received, shutting down');
  httpsServer.close(() => process.exit(0));
});
