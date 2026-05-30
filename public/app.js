// ============================================================================
// HALCYON — client mesh P2P
//  - WebRTC P2P audio + video + screen-share (mesh, no SFU)
//  - Logger leveled + ring buffer di 50 errori esposto su window.__ar
//  - Profilo persistente (UUID + preferences) sync con /api/settings
//  - Chat per-stanza con markdown XSS-safe, edit/delete, reactions
//
// Livello logger: URL ?log=debug|info|warn|error > localStorage > "info"
// ============================================================================

import { icon } from './icons.js';
import { playSound, setSoundEnabled, isSoundEnabled } from './sounds.js';
import {
  startRecording,
  stopRecording,
  isRecording,
  recordingElapsed,
} from './recorder.js';

// ---------- LOGGER (vedi raffinamento  §1.Step6) ----------
(function setupLogger() {
  const LV = { debug: 10, info: 20, warn: 30, error: 40 };
  let level = 'info';
  try {
    const qs = new URLSearchParams(location.search).get('log');
    if (qs && LV[qs.toLowerCase()]) level = qs.toLowerCase();
    else {
      const ls = localStorage.getItem('ar:logLevel');
      if (ls && LV[ls.toLowerCase()]) level = ls.toLowerCase();
    }
  } catch {}
  const errors = []; // ring buffer 50

  function fmt(lvl, args) {
    const ts = new Date().toISOString().slice(11, 23); // HH:mm:ss.SSS
    return [`[AR ${lvl}] ${ts}`, ...args];
  }
  function emit(lvl, args) {
    if (LV[lvl] < LV[level]) return;
    const fn = lvl === 'error' ? console.error : (lvl === 'warn' ? console.warn : console.log);
    fn(...fmt(lvl, args));
  }
  const log = {
    debug: (...a) => emit('debug', a),
    info:  (...a) => emit('info',  a),
    warn:  (...a) => emit('warn',  a),
    error: (...a) => emit('error', a),
  };

  function pushError(type, message, stack) {
    errors.push({ ts: Date.now(), type, message: String(message).slice(0, 500), stack: stack ? String(stack).slice(0, 1500) : null });
    if (errors.length > 50) errors.shift();
  }
  window.addEventListener('error', (e) => {
    pushError('error', e.message || (e.error && e.error.message), e.error && e.error.stack);
    log.error('window.error:', e.message);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason || {};
    pushError('unhandledrejection', r.message || r, r.stack);
    log.error('unhandledrejection:', r.message || r);
  });

  window.__ar = {
    log,
    setLevel(l) { if (LV[l]) { level = l; try { localStorage.setItem('ar:logLevel', l); } catch {} } },
    getLevel() { return level; },
    state: { errors },
    //  API di introspezione per test e2e Playwright.
    // - ws()       restituisce il WebSocket corrente (per close esplicito)
    // - peers()    restituisce un array dei peer correnti [{id, name}]
    // - wsState()  stato del badge (offline/connecting/online/reconnecting/dead)
    ws() { return typeof ws !== 'undefined' ? ws : null; },
    peers() { try { return [...peers.values()].map(p => ({ id: p.id, name: p.name })); } catch { return []; } },
    wsState() { return typeof wsState !== 'undefined' ? wsState : 'unknown'; },
  };
  log.info('logger pronto livello=' + level);
})();

// ============================================================================
//  PROFILE - identita' persistente ()
// ============================================================================
//  - userId UUID v4 generato 1 volta sola, salvato in localStorage e
//    referenziato in ogni PUT /api/settings.
//  - Profile {nickname, micDeviceId, outDeviceId, aecOn, theme, logLevel}
//    cache local-first in localStorage, sincronizzato col server via REST.
//  - Save debounced 500 ms su qualsiasi change.
// ============================================================================
const profile = {
  userId: null,
  data: {}, // shape libera, vedi defaults() qui sotto
  _saveTimer: null,
  _serverReachable: true,
};

function _uuidv4() {
  try { return crypto.randomUUID(); }
  catch { return 'sess-' + Math.random().toString(36).slice(2, 14) + Date.now().toString(36); }
}

function _profileDefaults() {
  return {
    nickname: '',
    micDeviceId: '',
    outDeviceId: '',
    aecOn: true,
    theme: 'default',
    logLevel: 'info',
  };
}

async function loadProfile() {
  // 1) userId stabile
  let uid;
  try { uid = localStorage.getItem('halcyon:userId'); } catch {}
  if (!uid) {
    uid = _uuidv4();
    try { localStorage.setItem('halcyon:userId', uid); } catch {}
  }
  profile.userId = uid;

  // 2) cache locale
  let local = null;
  try {
    const raw = localStorage.getItem('halcyon:profile');
    if (raw) local = JSON.parse(raw);
  } catch {}

  // 3) tenta fetch server (se disponibile, override cache)
  let remote = null;
  try {
    const r = await fetch(`/api/settings?userId=${encodeURIComponent(uid)}`, { cache: 'no-store' });
    if (r.ok) {
      const body = await r.json();
      remote = body.settings || null;
    } else if (r.status !== 404) {
      profile._serverReachable = false;
      __ar.log.warn('[profile] GET /api/settings status', r.status);
    }
  } catch (e) {
    profile._serverReachable = false;
    __ar.log.warn('[profile] /api/settings irraggiungibile, uso solo locale:', e.message);
  }

  profile.data = { ..._profileDefaults(), ...(local || {}), ...(remote || {}) };

  // Se il server era vuoto ma il client ha dati locali, sincronizza up.
  if (profile._serverReachable && remote === null && local) {
    saveProfile(true);
  }
  __ar.log.info(`[profile] userId=${uid.slice(0, 8)}... loaded (remote=${remote ? 'yes' : 'no'})`);
  applyProfileToUi();
  return profile;
}

function applyProfileToUi() {
  const d = profile.data;
  const nickEl = $('nickname');
  if (nickEl && !nickEl.value && d.nickname) nickEl.value = d.nickname;
  const aecInit = $('aec-init');
  if (aecInit) aecInit.checked = !!d.aecOn;
  // device picker richiede che enumerateDevices abbia gia' popolato la select;
  // la chiamata avviene dopo refreshDevices() (vedi APPLY ad ogni populate).
  applyPersistedDeviceSelections();
}

function applyPersistedDeviceSelections() {
  const d = profile.data;
  for (const id of ['mic-select', 'mic-room-select']) {
    const sel = $(id);
    if (!sel || !d.micDeviceId) continue;
    const opt = [...sel.options].find((o) => o.value === d.micDeviceId);
    if (opt) sel.value = d.micDeviceId;
  }
  const out = $('out-select');
  if (out && d.outDeviceId) {
    const opt = [...out.options].find((o) => o.value === d.outDeviceId);
    if (opt) out.value = d.outDeviceId;
  }
}

function captureProfileFromUi(partial = {}) {
  const next = { ...profile.data };
  const nick = $('nickname')?.value?.trim();
  if (nick) next.nickname = nick.slice(0, 32);
  const mic = $('mic-room-select')?.value || $('mic-select')?.value;
  if (mic) next.micDeviceId = mic;
  const out = $('out-select')?.value;
  if (out) next.outDeviceId = out;
  if (typeof aecOn === 'boolean') next.aecOn = aecOn;
  next.logLevel = __ar.getLevel();
  Object.assign(next, partial);
  return next;
}

function saveProfile(immediate = false) {
  profile.data = captureProfileFromUi();
  try { localStorage.setItem('halcyon:profile', JSON.stringify(profile.data)); } catch {}

  const flush = async () => {
    if (!profile._serverReachable) return;
    try {
      const r = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: profile.userId, settings: profile.data }),
      });
      if (!r.ok) __ar.log.warn('[profile] PUT /api/settings status', r.status);
    } catch (e) {
      profile._serverReachable = false;
      __ar.log.warn('[profile] PUT fallita:', e.message);
    }
  };

  if (immediate) {
    clearTimeout(profile._saveTimer);
    flush();
    return;
  }
  clearTimeout(profile._saveTimer);
  profile._saveTimer = setTimeout(flush, 500);
}

// Espongo per test e2e
window.__ar.profile = () => ({ userId: profile.userId, data: { ...profile.data }, serverReachable: profile._serverReachable });
window.__ar.saveProfile = saveProfile;

// ---------- A11y: live-region announcer (toggle/stato a screen reader) ----------
let _announceT = null;
function announce(text) {
  const el = document.getElementById('aria-live-status');
  if (!el) return;
  clearTimeout(_announceT);
  // Doppio update: vuoto + delay obbliga VoiceOver/NVDA a parlare anche se il
  // testo precedente era identico (sennò la live-region viene "ignorata").
  el.textContent = '';
  _announceT = setTimeout(() => {
    el.textContent = text;
  }, 30);
}
window.__ar.announce = announce;

// ---------- Stato ----------
const peers = new Map();   // id -> peer object (vedi makePeer)
let ws = null, myId = null, myName = '';
let localStream = null, micEnabled = true, deafened = false;
let aecOn = true;          // Acoustic Echo Cancellation / soppressione
let videoEnabled = false;  //  camera attiva (decided al join)
let outputSinkId = '';     // device di uscita scelto

const ENV_LEN = 48;        // campioni di inviluppo per nodo (~0.8s @60fps)
const SPEAK_TH = 0.055;    // soglia "sta parlando" (RMS)

const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// ---------- Self ----------
const self = { id: 'self', name: '', rms: 0, env: new Float32Array(ENV_LEN), speaking: false, analyser: null, ctx: null, handRaised: false };

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const joinScreen = $('join-screen'), roomScreen = $('room-screen');
//  niente più canvas. Render via DOM grid.

// ============================================================================
//  DEVICE / STREAM
// ============================================================================
async function refreshDevices() {
  let perm;
  try { perm = await navigator.mediaDevices.getUserMedia({ audio: true }); perm.getTracks().forEach(t => t.stop()); } catch {}
  const devices = await navigator.mediaDevices.enumerateDevices();
  const mics = devices.filter(d => d.kind === 'audioinput');
  const outs = devices.filter(d => d.kind === 'audiooutput');
  fillSelect($('mic-select'), mics, 'Microfono');
  fillSelect($('mic-room-select'), mics, 'Microfono');
  if (outs.length) fillSelect($('out-select'), outs, 'Uscita');
  else $('out-select').innerHTML = '<option>Predefinita</option>';
}
function fillSelect(sel, devices, label) {
  const cur = sel.value;
  sel.innerHTML = '';
  devices.forEach((d, i) => {
    const o = document.createElement('option');
    o.value = d.deviceId; o.textContent = d.label || `${label} ${i + 1}`;
    sel.appendChild(o);
  });
  if (cur) sel.value = cur;
}

function micConstraints(deviceId) {
  // AEC ON  -> elaborazione WebRTC attiva (consigliata in stanza, anti-Larsen)
  // AEC OFF -> Hi-Fi: niente filtri, stereo, massima fedelta
  return {
    deviceId: deviceId ? { exact: deviceId } : undefined,
    channelCount: aecOn ? 1 : 2,
    sampleRate: 48000,
    echoCancellation: aecOn,
    noiseSuppression: aecOn,
    autoGainControl: aecOn,
  };
}

async function acquireStream(deviceId) {
  //  la camera ora si attiva runtime dal control deck (vedi startCamera/
  // stopCamera). Il join iniziale acquisisce solo audio; nessun lock-in.
  return navigator.mediaDevices.getUserMedia({ audio: micConstraints(deviceId), video: false });
}

// Sostituisce lo stream locale (cambio mic o toggle AEC) senza rinegoziare.
//
// When the noise gate is on, the raw mic stream is piped through a WebAudio
// chain (low-cut biquad -> compressor -> output) and the OUTPUT stream is
// what goes to peers. When the gate is off the raw stream goes through
// directly. The caller passes the raw stream from getUserMedia; this
// function transparently decides which one to publish.
async function replaceLocalStream(newRawStream) {
  // Build the processed stream once. Always keep a handle to the raw stream
  // so toggleGate can flip without re-prompting for permissions.
  _rawMicStream = newRawStream;
  const publishedStream = gateOn ? buildGatedStream(newRawStream) : newRawStream;
  const newTrack = publishedStream.getAudioTracks()[0];
  newTrack.enabled = micEnabled;
  for (const peer of peers.values()) {
    if (!peer.pc) continue;
    const sender = peer.pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
    if (sender) {
      try {
        await sender.replaceTrack(newTrack);
      } catch (e) {
        __ar.log.warn('replaceTrack mesh peer=' + peer.name, e);
      }
    }
  }
  // Stop the previous published stream (raw or gated) before reassigning.
  if (localStream && localStream !== newRawStream) {
    localStream.getTracks().forEach((t) => t.stop());
  }
  destroyGateChain();
  if (gateOn) _gateChain = _pendingGateChain; // moved to live ref
  _pendingGateChain = null;
  localStream = publishedStream;
  setupSelfAnalyser();
}

// =========================================================================
// NOISE GATE (low-cut + dynamics compressor + gain) — WebAudio chain.
//
// Off by default. When the user toggles it on, the raw mic stream is piped
// through:
//   source -> highpass(80Hz, Q=0.7) -> compressor(thr -32dB, ratio 8:1,
//             knee 12dB, attack 8ms, release 200ms) -> gain(1.05) -> dest
// The destination's MediaStream is what goes to peers. Tuning aims at a
// "podcast desk" sound: rumble killed, persistent room noise pulled down,
// voice transients preserved.
// =========================================================================
let gateOn = false;
let _rawMicStream = null;
let _gateChain = null; // { ctx, src, hp, comp, gain, dest }
let _pendingGateChain = null; // built but not yet committed during swap

function buildGatedStream(rawStream) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const src = ctx.createMediaStreamSource(rawStream);
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 80;
  hp.Q.value = 0.707;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -32;
  comp.knee.value = 12;
  comp.ratio.value = 8;
  comp.attack.value = 0.008;
  comp.release.value = 0.2;
  const gain = ctx.createGain();
  gain.gain.value = 1.05;
  const dest = ctx.createMediaStreamDestination();
  src.connect(hp).connect(comp).connect(gain).connect(dest);
  _pendingGateChain = { ctx, src, hp, comp, gain, dest };
  return dest.stream;
}

function destroyGateChain() {
  if (!_gateChain) return;
  try {
    _gateChain.src.disconnect();
    _gateChain.hp.disconnect();
    _gateChain.comp.disconnect();
    _gateChain.gain.disconnect();
  } catch {
    /* fine */
  }
  _gateChain.ctx.close().catch(() => {});
  _gateChain = null;
}

async function toggleGate() {
  gateOn = !gateOn;
  syncGateBtn();
  if (!_rawMicStream) return;
  // Rebuild the published stream from the cached raw stream — no re-prompt.
  await replaceLocalStream(_rawMicStream);
  announce(gateOn ? 'Noise gate engaged' : 'Noise gate disengaged');
  playSound('tick');
}

function syncGateBtn() {
  const btn = $('gate-btn');
  if (!btn) return;
  btn.classList.toggle('on', gateOn);
  btn.setAttribute('aria-pressed', String(gateOn));
  btn.title = gateOn
    ? 'Noise gate engaged (low-cut + compressor). Click to disengage.'
    : 'Noise gate (low-cut + compressor). Off by default.';
}

// ============================================================================
//  JOIN
// ============================================================================
$('join-btn').addEventListener('click', async () => {
  const name = $('nickname').value.trim();
  if (!name) {
    $('join-error').textContent = 'Please enter a name.';
    return;
  }
  myName = name; self.name = name;
  aecOn = $('aec-init').checked;
  //  camera non più al join, ma da control deck (#camera-btn)
  videoEnabled = false;
  $('join-btn').disabled = true; $('join-error').textContent = '';
  try {
    localStream = await acquireStream($('mic-select').value);
    _rawMicStream = localStream;
  } catch (err) {
    $('join-error').textContent = 'Microphone not accessible: ' + err.message;
    $('join-btn').disabled = false; return;
  }
  setupSelfAnalyser();
  syncAecUI();
  ensureSelfVideoTile();
  stopJoinPreview();
  connectSignaling();
  initRoomId();
  joinScreen.classList.add('hidden');
  roomScreen.classList.remove('hidden');
  rafHandle = requestAnimationFrame(tick);
  pollStatsTimer = setInterval(pollStats, 1500);
});
$('nickname').addEventListener('keydown', e => { if (e.key === 'Enter') $('join-btn').click(); });

// ============================================================================
//  SIGNALING — supporta 2 modalita': 'mesh' (P2P, server Node) e
//  'sfu' (audio instradato dal server Python con DeepFilterNet)
//
//   WS reconnect con backoff esponenziale + jitter, sessionToken per
//  identificare la stessa sessione attraverso reconnect (no peer fantasma).
// ============================================================================
// --- Reconnect state ---
const sessionToken = (() => {
  // sessione effimera: cambia ad ogni reload del tab, identica fra reconnect WS.
  try { return crypto.randomUUID(); }
  catch { return 'sess-' + Math.random().toString(36).slice(2) + Date.now().toString(36); }
})();
let manualClose = false;          // settato solo dal pulsante Esci
let reconnectAttempt = 0;         // numero tentativi consecutivi falliti
let reconnectTimer = null;
let wsState = 'offline';          // offline | connecting | online | reconnecting | dead
const RECONNECT_MAX = 12;         // dopo N tentativi falliti dichiariamo dead

function setWsState(s) {
  if (s === wsState) return;
  wsState = s;
  const el = $('ws-badge');
  if (!el) return;
  el.dataset.state = s;
  const TXT = {
    online: 'Online',
    connecting: 'Connecting',
    reconnecting: 'Reconnecting',
    dead: 'Offline',
    offline: 'Offline',
  };
  // Markup: <span class="lat-dot"></span><span class="label">…</span>
  // Color of the dot + label tint is driven by the [data-state] selector in CSS.
  const label = el.querySelector('.label');
  if (label) label.textContent = TXT[s] || s;
  else el.textContent = TXT[s] || s;
}

function scheduleReconnect() {
  if (manualClose) return;
  if (reconnectAttempt >= RECONNECT_MAX) {
    setWsState('dead');
    __ar.log.warn('reconnect: max tentativi raggiunto, dichiarato offline');
    // ora rilascio anche i peer (non recuperabili senza signaling)
    for (const id of [...peers.keys()]) removePeer(id);
    setLat(null);
    return;
  }
  // backoff esponenziale: 250 500 1000 2000 4000 ... cap 10000 ms, jitter +-30%
  const base = Math.min(10000, 250 * Math.pow(2, reconnectAttempt));
  const jitter = base * (Math.random() * 0.6 - 0.3);
  const delay = Math.max(150, Math.round(base + jitter));
  reconnectAttempt++;
  setWsState('reconnecting');
  __ar.log.info(`reconnect: tentativo ${reconnectAttempt} fra ${delay}ms`);
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(openSocket, delay);
}

function openSocket() {
  setWsState(reconnectAttempt === 0 ? 'connecting' : 'reconnecting');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let sock;
  try { sock = new WebSocket(`${proto}://${location.host}/ws`); }
  catch (e) { __ar.log.warn('WebSocket ctor failed', e); scheduleReconnect(); return; }
  ws = sock;
  sock.addEventListener('open', () => {
    reconnectAttempt = 0;
    setWsState('online');
    // join include sessionToken e userId del profilo ( serve a chat
    // per autorizzare edit/delete sui messaggi). Il server li registra in
    // peer.token / peer.userId.
    //  roomId da URL ?room=X (default 'main', alfanum [a-zA-Z0-9_-]).
    const roomId = (() => {
      try {
        const r = new URLSearchParams(location.search).get('room') || 'main';
        return /^[a-zA-Z0-9_-]{1,40}$/.test(r) ? r : 'main';
      } catch { return 'main'; }
    })();
    sock.send(JSON.stringify({ type: 'join', name: myName, sessionToken, userId: profile.userId, roomId }));
    //  appena online, chiediamo la history della stanza.
    if (typeof requestChatHistory === 'function') requestChatHistory();
  });
  sock.addEventListener('error', (e) => __ar.log.warn('ws error', e?.message || ''));
  sock.addEventListener('close', () => {
    if (manualClose) { setWsState('offline'); return; }
    __ar.log.warn('ws close, schedulo reconnect');
    scheduleReconnect();
  });
  sock.addEventListener('message', async ev => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    switch (msg.type) {
      case 'welcome':
        myId = msg.id;
        document.body.dataset.mode = 'mesh';
        for (const p of msg.peers) ensurePeerMesh(p.id, p.name, false);
        if (msg.resumed) __ar.log.info('welcome: sessione ripristinata id=' + msg.id);
        break;
      case 'peer-joined':
        ensurePeerMesh(msg.id, msg.name, true);
        updateAloneBadge();
        playSound('join');
        break;
      case 'peer-renamed': {
        const p = peers.get(msg.id);
        if (p) p.name = msg.name;
        break;
      }
      case 'peer-left':
        removePeer(msg.id);
        updateAloneBadge();
        playSound('leave');
        break;
      case 'signal':
        await handleSignal(msg.from, msg.data);
        break;
      case 'pong':
        break;
      //  chat
      case 'chat:msg': onChatMessage(msg); break;
      case 'chat:history:resp': onChatHistory(msg.items || []); break;
      case 'chat:edit:ack': onChatEdited(msg); break;
      case 'chat:delete:ack': onChatDeleted(msg.msgId); break;
      case 'chat:typing': onChatTyping(msg); break;
      case 'chat:react:ack': onChatReactionUpdate(msg); break;
      case 'chat:error': __ar.log.warn('[chat]', msg.reason, msg.msgId || ''); break;
      //  room signals: floating reactions + hand-raise
      case 'room:reaction': onRoomReaction(msg); break;
      case 'room:hand': onRoomHand(msg); break;
    }
  });
}

// API pubblica preservata: tutti i call site esistenti continuano a funzionare.
function connectSignaling() {
  manualClose = false;
  reconnectAttempt = 0;
  openSocket();
  // App-level keep-alive: ogni 20s ping leggero al server. Il server WebSocket
  // nativo gestisce ping/pong al livello protocollo (vedi server.js), ma un
  // ping app-level rivela stalli precoci di proxy/middleware.
  if (!connectSignaling._kaTimer) {
    connectSignaling._kaTimer = setInterval(() => {
      if (ws && ws.readyState === 1) {
        try { ws.send(JSON.stringify({ type: 'ka', t: Date.now() })); } catch {}
      }
    }, 20000);
  }
}

function signal(to, data) {
  ws.send(JSON.stringify({ type: 'signal', to, data }));
}

// ---------- nodo (display + audio), comune alle due modalita' ----------
function makeNode(name) {
  return {
    name, pc: null, audioEl: null, volume: 1,
    rms: 0, env: new Float32Array(ENV_LEN), speaking: false,
    analyser: null, ctx: null,
    handRaised: false,
    x: 0, y: 0, fx: Math.random() * 6.28, fy: Math.random() * 6.28,
  };
}
function ensureNode(id, name) {
  let n = peers.get(id);
  if (n) {
    if (name) n.name = name;
    return n;
  }
  n = makeNode(name);
  n.id = id; // expose Map key on the value (used by startScreenShare/startCamera logs + e2e API)
  peers.set(id, n);
  return n;
}

// ============================================================================
//  WEBRTC MESH — perfect negotiation pattern (W3C)
//
//  Why: the previous version registered `negotiationneeded` ONLY for the
//  initiator. When the non-initiator added a new track (camera, screen-share),
//  the event fired but no listener was attached → no SDP renegotiation → the
//  remote peer never received the new tracks. Result: clicking "Share screen"
//  on the second peer did nothing.
//
//  Fix: both sides listen to `negotiationneeded`. Glare (simultaneous offers)
//  is handled the spec-recommended way:
//   - "polite" side (non-initiator) accepts the incoming offer even mid-negotiation
//     (modern Chrome auto-rolls back the local pending offer).
//   - "impolite" side (initiator) ignores incoming offers during glare.
//  Initial setup is unchanged: only the initiator's first negotiationneeded
//  produces the bootstrap offer because the non-initiator's pc adds the local
//  tracks after the remote SDP arrives in welcome.
// ============================================================================
function ensurePeerMesh(id, name, initiator) {
  if (peers.has(id) && peers.get(id).pc) return peers.get(id);
  const peer = ensureNode(id, name);
  const pc = new RTCPeerConnection(RTC_CONFIG);
  peer.pc = pc;
  peer.isInitiator = !!initiator;
  peer._isPolite = !initiator;
  peer._makingOffer = false;
  for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
  pc.addEventListener('icecandidate', (e) => {
    if (e.candidate) signal(id, { candidate: e.candidate });
  });
  pc.addEventListener('track', (e) => {
    const stream = e.streams[0] || new MediaStream([e.track]);
    if (e.track.kind === 'video') {
      attachRemoteVideo(id, stream);
    } else {
      // Audio track. If the stream also carries video, it belongs to a screen-share —
      // the audio rides on the same MediaStream as the video and will be played by
      // the remote <video> element (which we keep un-muted). Routing it to the
      // mic <audio> element would overwrite the mic playback (srcObject is exclusive).
      if (stream.getVideoTracks().length > 0) {
        __ar.log.info(`[track] screen-share audio peer=${id} (plays via video tile)`);
      } else {
        attachRemoteAudio(id, stream);
      }
    }
  });
  pc.addEventListener('connectionstatechange', () => {
    const st = pc.connectionState;
    __ar.log.debug(`peer=${id} conn=${st}`);
    if (st === 'failed') tryIceRestart(peer, id);
    else if (st === 'disconnected') {
      setTimeout(() => {
        if (pc.connectionState === 'disconnected') tryIceRestart(peer, id);
      }, 5000);
    }
  });
  pc.addEventListener('iceconnectionstatechange', () =>
    __ar.log.debug(`peer=${id} ice=${pc.iceConnectionState}`),
  );

  // Universal negotiationneeded handler. Fires for:
  //   - initial setup (initiator)
  //   - addTrack from either side (camera, screen-share)
  //   - restartIce() from either side
  // The signalingState=stable guard prevents racing with an inbound offer.
  pc.addEventListener('negotiationneeded', async () => {
    try {
      peer._makingOffer = true;
      const o = await pc.createOffer();
      if (pc.signalingState !== 'stable') return; // re-entry safety
      await pc.setLocalDescription(tuneOpus(o));
      maximizeBitrate(pc);
      signal(id, { sdp: pc.localDescription });
    } catch (e) {
      __ar.log.error(`negotiationneeded peer=${id}`, e);
    } finally {
      peer._makingOffer = false;
    }
  });
  return peer;
}

// ICE restart helper. Either side can call: restartIce() sets internal state
// so the next negotiationneeded produces an ICE-restart offer automatically.
async function tryIceRestart(peer, id) {
  if (!peer?.pc) return;
  try {
    if (typeof peer.pc.restartIce === 'function') {
      peer.pc.restartIce();
    } else {
      // Legacy fallback (very old browsers). Modern Chrome 124+ always has restartIce.
      const o = await peer.pc.createOffer({ iceRestart: true });
      if (peer.pc.signalingState !== 'stable') return;
      await peer.pc.setLocalDescription(tuneOpus(o));
      signal(id, { sdp: peer.pc.localDescription });
    }
    __ar.log.info(`peer=${id} ICE restart triggered`);
  } catch (e) {
    __ar.log.error(`peer=${id} ICE restart failed`, e);
  }
}

async function handleSignal(from, data) {
  const peer = peers.get(from);
  if (!peer || !peer.pc) return;
  const pc = peer.pc;
  // Wrap the entire body. Any unhandled rejection would be caught by
  // window.unhandledrejection and pollute __ar.state.errors (we use that ring
  // as a CI invariant in e2e tests).
  try {
    if (data.sdp) {
      const isOffer = data.sdp.type === 'offer';
      const offerCollision = isOffer && (peer._makingOffer || pc.signalingState !== 'stable');
      if (!peer._isPolite && offerCollision) {
        __ar.log.debug(`peer=${from} ignoring colliding offer (impolite)`);
        return;
      }
      await pc.setRemoteDescription(data.sdp); // implicit rollback if polite + collision
      if (isOffer) {
        const a = await pc.createAnswer();
        await pc.setLocalDescription(tuneOpus(a));
        maximizeBitrate(pc);
        signal(from, { sdp: pc.localDescription });
      } else {
        maximizeBitrate(pc);
      }
    } else if (data.candidate) {
      try {
        await pc.addIceCandidate(data.candidate);
      } catch (e) {
        // After an ignored offer, stray ICE candidates may fail — debug only.
        __ar.log.debug(`addIceCandidate peer=${from}`, e?.name || e);
      }
    }
  } catch (e) {
    // Negotiation race / state mismatch. Downgrade to warn (no impact on errors ring).
    __ar.log.warn(`handleSignal peer=${from}`, e?.name || e);
  }
}

// ============================================================================
//  Test beep locale (verifica device audio del browser, 880Hz sine 200ms).
// ============================================================================
function playTestBeep() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.25, ctx.currentTime + 0.02);
    gain.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + 0.22);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.25);
    // Set sink se selezionato e supportato (Chrome 110+)
    if (outputSinkId && ctx.setSinkId) ctx.setSinkId(outputSinkId).catch(() => {});
    setTimeout(() => ctx.close().catch(() => {}), 400);
    __ar.log.info('[test-beep] 880Hz 200ms');
  } catch (e) {
    __ar.log.warn('[test-beep] failed', e);
  }
}

// ---------------------------------------------------------------------------
//   audio playback fallback.
//  Se il browser blocca play() per autoplay policy (NotAllowedError) mostriamo
//  un overlay full-screen che l'utente clicca una sola volta per sbloccare
//  TUTTI gli audio el contemporaneamente.
// ---------------------------------------------------------------------------
const pendingAudio = new Set();    // HTMLAudioElement che hanno fallito play()
let audioGateBound = false;

function tryPlayAudio(el, tag = '') {
  el.play().then(() => {
    pendingAudio.delete(el);
    if (pendingAudio.size === 0) hideAudioGate();
  }).catch(err => {
    if (err && err.name === 'NotAllowedError') {
      pendingAudio.add(el);
      showAudioGate();
      __ar.log.warn(`${tag} play() bloccato (autoplay policy) - overlay attivato`);
    } else {
      __ar.log.warn(`${tag} play() errore`, err?.name, err?.message);
    }
  });
}

function showAudioGate() {
  const gate = $('audio-gate'); if (!gate) return;
  gate.classList.remove('hidden');
  if (audioGateBound) return;
  audioGateBound = true;
  const release = async () => {
    // Snapshot del Set: durante il loop puo' essere mutato dai .then() concorrenti.
    const els = [...pendingAudio];
    for (const el of els) {
      try { await el.play(); pendingAudio.delete(el); } catch (e) { __ar.log.warn('retry play()', e?.name); }
    }
    if (pendingAudio.size === 0) hideAudioGate();
  };
  gate.addEventListener('click', release);
  $('audio-gate-btn')?.addEventListener('click', (ev) => { ev.stopPropagation(); release(); });
  gate.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); release(); } });
}
function hideAudioGate() {
  const gate = $('audio-gate');
  if (gate) gate.classList.add('hidden');
}

function tuneOpus(desc) {
  let sdp = desc.sdp;
  const m = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/);
  if (m) {
    const pt = m[1];
    const fmtp = `a=fmtp:${pt} minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=510000;maxplaybackrate=48000;cbr=0`;
    sdp = new RegExp(`a=fmtp:${pt} `).test(sdp)
      ? sdp.replace(new RegExp(`a=fmtp:${pt} .*`), fmtp)
      : sdp.replace(new RegExp(`(a=rtpmap:${pt} opus/48000/2.*)`), `$1\r\n${fmtp}`);
  }
  return { type: desc.type, sdp };
}
async function maximizeBitrate(pc) {
  // Defensive: sender.getParameters() may return { encodings: [] } (empty array)
  // on some negotiation paths, in which case p.encodings[0] is undefined and
  // a naive assignment throws TypeError. Always ensure at least one encoding.
  //
  // Senders flagged with _musicCap are tuned by tuneAudioForMusic at the music-
  // specific 320 kbps cap, so the negotiation loop skips them.
  for (const sender of pc.getSenders()) {
    if (!sender.track || sender.track.kind !== 'audio') continue;
    if (sender._musicCap) continue;
    try {
      const p = sender.getParameters();
      if (!p.encodings || p.encodings.length === 0) p.encodings = [{}];
      p.encodings[0].maxBitrate = 510000;
      await sender.setParameters(p);
    } catch (e) {
      __ar.log.debug(`maximizeBitrate sender skip`, e?.name || e);
    }
  }
}

// Music-share sender tune. 320 kbps stereo Opus is the practical sweet spot
// (transparent for most listeners, fits in a typical LAN budget). Flags the
// sender so the global maximizeBitrate skips it on later negotiation passes.
async function tuneAudioForMusic(sender, label) {
  try {
    const p = sender.getParameters();
    if (!p.encodings || p.encodings.length === 0) p.encodings = [{}];
    p.encodings[0].maxBitrate = 320000;
    p.encodings[0].priority = 'high';
    p.encodings[0].networkPriority = 'high';
    sender._musicCap = true;
    await sender.setParameters(p);
    __ar.log.info(`[music] ${label} maxBitrate=320kbps stereo`);
  } catch (e) {
    __ar.log.warn(`[music] ${label} setParameters`, e);
  }
}
function attachRemoteAudio(id, stream) {
  const peer = peers.get(id); if (!peer) return;
  if (!stream) { __ar.log.warn(`[track] stream nullo per peer=${id}`); return; }
  let el = peer.audioEl;
  if (!el) {
    el = document.createElement('audio');
    el.autoplay = true;
    el.playsInline = true;
    document.body.appendChild(el);
    peer.audioEl = el;
  }
  el.srcObject = stream;
  el.volume = deafened ? 0 : peer.volume;
  if (outputSinkId && el.setSinkId) el.setSinkId(outputSinkId).catch(() => {});
  tryPlayAudio(el, `[track peer=${id}]`);
  __ar.log.info(`[track] audio agganciato peer=${id} tracks=${stream.getAudioTracks().length}`);
  setupAnalyser(peer, stream);
}
function removePeer(id) {
  const peer = peers.get(id);
  if (!peer) return;
  if (peer.pc) {
    try {
      peer.pc.close();
    } catch {}
  }
  if (peer.audioEl) peer.audioEl.remove();
  if (peer.videoEl) peer.videoEl.parentElement?.remove();
  if (peer.ctx) peer.ctx.close().catch(() => {});
  peers.delete(id);
  refreshVideoGridVisibility();
}

// +15: video grid management. Tile 16:9 nativo per match 1080p stream.
// L'audio dello screen share remoto va al normale audio el del peer (NON sul
// video element, che resta muted per evitare doppia riproduzione).
function attachRemoteVideo(id, stream) {
  const peer = peers.get(id);
  if (!peer) return;
  const grid = $('video-grid');
  if (!grid) return;
  let tile = peer.videoTile;
  if (!tile) {
    tile = document.createElement('div');
    tile.className = 'video-tile';
    tile.dataset.peerId = id;
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    // NOT muted: if this stream carries screen-share audio, the video element
    // is responsible for playing it (the mic audio uses a separate <audio> el).
    // The output sink follows the user's selected device when supported.
    video.muted = false;
    if (outputSinkId && video.setSinkId) video.setSinkId(outputSinkId).catch(() => {});
    const label = document.createElement('div');
    label.className = 'video-label';
    label.textContent = peer.name;
    tile.appendChild(video);
    tile.appendChild(label);
    grid.appendChild(tile);
    peer.videoTile = tile;
    peer.videoEl = video;
  }
  peer.videoEl.srcObject = stream;
  // Respect global deafen.
  peer.videoEl.volume = deafened ? 0 : 1;
  tryPlayVideo(peer.videoEl, `[video peer=${id}]`);
  refreshVideoGridVisibility();
}

// play()-with-audio-gate-fallback for remote <video> elements (same logic as audio).
function tryPlayVideo(el, tag = '') {
  el.play()
    .then(() => {
      pendingAudio.delete(el);
      if (pendingAudio.size === 0) hideAudioGate();
    })
    .catch((err) => {
      if (err && err.name === 'NotAllowedError') {
        pendingAudio.add(el);
        showAudioGate();
        __ar.log.warn(`${tag} play() blocked (autoplay policy) — gate shown`);
      } else {
        __ar.log.warn(`${tag} play() error`, err?.name, err?.message);
      }
    });
}

function refreshVideoGridVisibility() {
  const grid = $('video-grid');
  if (!grid) return;
  const hasTiles = grid.querySelector('.video-tile, .video-tile-self');
  if (hasTiles) grid.classList.remove('hidden');
  else grid.classList.add('hidden');
  applySpeakerLayout();
}

// ============================================================================
// VIEW MODES + SPEAKER PINNING
//
// 'grid'    : default flex-row layout (all video tiles equal size).
// 'speaker' : one tile becomes large (pinned or auto-picked), the others
//             shrink into a strip. Click any tile to pin/unpin it.
// Auto-pick priority when no manual pin: screen-share-self -> camera-self
// -> first remote video -> first tile available.
// ============================================================================
let viewMode = 'grid';
let pinnedPeerId = null;

function setViewMode(mode) {
  viewMode = mode === 'speaker' ? 'speaker' : 'grid';
  const grid = $('video-grid');
  grid?.classList.toggle('speaker-view', viewMode === 'speaker');
  $('view-btn')?.setAttribute('aria-pressed', String(viewMode === 'speaker'));
  $('view-btn')?.querySelector('.ico')
    ?.replaceChildren(/* noop */);
  const ico = $('view-btn')?.querySelector('.ico');
  if (ico) ico.innerHTML = icon(viewMode === 'speaker' ? 'user' : 'users', { size: 18 });
  applySpeakerLayout();
}

function cycleViewMode() {
  setViewMode(viewMode === 'grid' ? 'speaker' : 'grid');
  showToast(viewMode === 'speaker' ? 'Speaker view' : 'Grid view', 1200);
}

function applySpeakerLayout() {
  const grid = $('video-grid');
  if (!grid || viewMode !== 'speaker') {
    // grid mode: strip any leftover .is-main class
    grid?.querySelectorAll('.video-tile.is-main').forEach((t) => t.classList.remove('is-main'));
    return;
  }
  let main = null;
  if (pinnedPeerId) {
    main = grid.querySelector(`.video-tile[data-peer-id="${CSS.escape(pinnedPeerId)}"]`);
    if (!main && pinnedPeerId === 'self-screen') {
      main = grid.querySelector('.video-tile-screen-self');
    }
    if (!main && pinnedPeerId === 'self-camera') {
      main = grid.querySelector('.video-tile-camera-self');
    }
  }
  if (!main) main = grid.querySelector('.video-tile-screen-self');
  if (!main) main = grid.querySelector('.video-tile-camera-self');
  if (!main) main = grid.querySelector('.video-tile');
  for (const tile of grid.querySelectorAll('.video-tile')) {
    tile.classList.toggle('is-main', tile === main);
  }
}

function bindVideoGridClicks() {
  $('video-grid')?.addEventListener('click', (e) => {
    const tile = e.target.closest?.('.video-tile');
    if (!tile) return;
    let id = tile.dataset.peerId;
    if (!id) {
      if (tile.classList.contains('video-tile-screen-self')) id = 'self-screen';
      else if (tile.classList.contains('video-tile-camera-self')) id = 'self-camera';
      else if (tile.classList.contains('video-tile-self')) id = 'self';
      else return;
    }
    pinnedPeerId = pinnedPeerId === id ? null : id;
    if (viewMode !== 'speaker') setViewMode('speaker');
    applySpeakerLayout();
    showToast(pinnedPeerId ? 'Tile pinned' : 'Tile unpinned', 1200);
  });
}

function ensureSelfVideoTile() {
  const grid = $('video-grid');
  if (!grid || !videoEnabled || !localStream) return;
  if (document.querySelector('.video-tile-self')) return;
  const tile = document.createElement('div');
  tile.className = 'video-tile video-tile-self';
  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;
  video.srcObject = localStream;
  const label = document.createElement('div');
  label.className = 'video-label';
  label.textContent = myName + ' (you)';
  tile.appendChild(video);
  tile.appendChild(label);
  grid.appendChild(tile);
  video.play().catch(() => {});
  refreshVideoGridVisibility();
}

// ============================================================================
//  ANALISI AUDIO (RMS + inviluppo per echo detection)
// ============================================================================
function setupAnalyser(target, stream) {
  if (target.ctx) target.ctx.close().catch(() => {});
  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  const an = ctx.createAnalyser();
  an.fftSize = 256; // metà dell'originale: in DOM-mode non serve risoluzione FFT, solo RMS
  an.smoothingTimeConstant = 0.7;
  src.connect(an);
  target.ctx = ctx;
  target.analyser = an;
  target._buf = new Uint8Array(an.frequencyBinCount);
}
function setupSelfAnalyser() {
  setupAnalyser(self, localStream);
}

function sampleRms(node) {
  if (!node.analyser) return 0;
  node.analyser.getByteTimeDomainData(node._buf);
  let sum = 0;
  const b = node._buf;
  for (let i = 0; i < b.length; i++) {
    const v = (b[i] - 128) / 128;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / b.length);
  node.rms = rms;
  node.env.copyWithin(0, 1);
  node.env[ENV_LEN - 1] = rms;
  node.speaking = rms > SPEAK_TH;
  return rms;
}

// ============================================================================
//  PARTICIPANTS GRID () — render via DOM, niente canvas/radar.
//  Layout Discord/Zoom-like: tile per ogni partecipante, glow verde quando
//  parla, hover = popover volume/silenzia (riusa openPeerPopover/Self esistenti).
// ============================================================================
let _lastGridSig = '';
const _gridElById = new Map(); // pid -> .participant element (cache per frame-fast lookup)
let pollStatsTimer = null;

function renderParticipantsGrid() {
  const grid = $('participants-grid');
  if (!grid) return;
  const all = [self, ...peers.values()];
  // signature minima per detect change (evita innerHTML thrash ogni frame)
  let sig = '';
  for (const n of all) {
    const isSelf = n === self;
    const muted = isSelf && !micEnabled;
    sig += (isSelf ? 'S' : n.id || '?') + '|' + (n.name || '') + '|' + (n.speaking && !muted ? 's' : '.') + (muted ? 'm' : '.') + (n.handRaised ? 'h' : '.') + ';';
  }
  if (sig !== _lastGridSig) {
    _lastGridSig = sig;
    grid.innerHTML = all
      .map((n) => {
        const isSelf = n === self;
        const muted = isSelf && !micEnabled;
        const speaking = n.speaking && !muted;
        const handUp = !!n.handRaised;
        const name = isSelf ? myName + ' (you)' : n.name || '?';
        const init = initials(name);
        const cls = ['participant'];
        if (isSelf) cls.push('self');
        if (speaking) cls.push('speaking');
        if (muted) cls.push('muted');
        if (handUp) cls.push('hand-up');
        const sid = isSelf ? 'self' : n.id;
        const handTag = handUp ? ' (hand raised)' : '';
        const stateTag = muted ? ' (mic muted)' : speaking ? ' (speaking)' : '';
        return `<div class="${cls.join(' ')}" role="listitem" data-pid="${escapeHtml(String(sid))}" tabindex="0" aria-label="${escapeHtml(name)}${stateTag}${handTag}">
          <div class="participant-avatar"><span>${escapeHtml(init)}</span></div>
          <div class="participant-name">${escapeHtml(name)}</div>
          ${handUp ? `<div class="participant-badge hand-badge" title="Hand raised">${icon('hand', { size: 14 })}</div>` : muted ? `<div class="participant-badge mute-badge" title="Microphone muted">${icon('mic-off', { size: 14 })}</div>` : speaking ? `<div class="participant-badge speak-badge" title="Speaking">${icon('mic', { size: 14 })}</div>` : ''}
        </div>`;
      })
      .join('');
    // ricostruisci cache id→element (fatto una volta per re-render, non per frame)
    _gridElById.clear();
    for (const el of grid.children) _gridElById.set(el.dataset.pid, el);
  }
  // Aggiorna SOLO la "intensità" speaking via CSS var (no re-render DOM).
  // Lookup via Map invece di querySelector → O(1) costante per peer.
  for (const n of all) {
    const sid = n === self ? 'self' : n.id;
    const el = _gridElById.get(sid);
    if (el) {
      const v = Math.min(1, (n.rms || 0) * 3);
      // skip set se delta < 0.02 (sotto la soglia visiva): evita reflow stylesheet
      const prev = el._lastRms || 0;
      if (Math.abs(v - prev) >= 0.02) {
        el.style.setProperty('--rms', String(v));
        el._lastRms = v;
      }
    }
  }
}

// Handle del rAF loop. Quando il tab è hidden lo pausiamo (perf):
//   - browser comunque rallenta rAF a ~1Hz, ma cosi' azzeriamo anche analyser,
//     LED meter, querySelector, sampleRms loop -> niente jank al ritorno.
let rafHandle = null;

function tick(t) {
  trackFps(t);
  sampleRms(self);
  for (const p of peers.values()) sampleRms(p);
  const pct = micEnabled ? Math.min(100, self.rms * 280) : 0;
  const meter = $('self-meter');
  if (meter) meter.style.width = pct + '%';
  renderParticipantsGrid();
  rafHandle = requestAnimationFrame(tick);
}

// Pause/resume in base alla visibilità del documento.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (rafHandle) {
      cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }
  } else if (!rafHandle && roomScreen && !roomScreen.classList.contains('hidden')) {
    rafHandle = requestAnimationFrame(tick);
  }
});

function initials(name) { return (name || '?').trim().slice(0, 2).toUpperCase() || '?'; }

// ============================================================================
//  INTERAZIONE CANVAS (popover volume / rename)
// ============================================================================
//  click sui tile DOM dei partecipanti per aprire popover.
document.addEventListener('click', (e) => {
  const grid = $('participants-grid');
  if (!grid) return;
  const tile = e.target.closest?.('.participant');
  if (!tile || !grid.contains(tile)) {
    if (!e.target.closest?.('.popover')) closePopover();
    return;
  }
  const pid = tile.dataset.pid;
  const rect = tile.getBoundingClientRect();
  const mx = rect.left + rect.width / 2;
  const my = rect.top + rect.height / 2;
  if (pid === 'self') openSelfPopover(mx, my);
  else {
    const peer = peers.get(pid);
    if (peer) openPeerPopover(peer, mx, my);
  }
});

function openPeerPopover(peer, x, y) {
  const po = $('popover');
  po.innerHTML = `<h4>${escapeHtml(peer.name)}</h4>
    <div class="row">${icon('headphones', { size: 16 })}<input type="range" min="0" max="200" value="${Math.round(peer.volume * 100)}"></div>
    <button class="pbtn danger">Mute this user</button>`;
  const range = po.querySelector('input');
  range.addEventListener('input', () => {
    peer.volume = Number(range.value) / 100;
    if (peer.audioEl) peer.audioEl.volume = deafened ? 0 : peer.volume;
  });
  po.querySelector('.pbtn').addEventListener('click', () => {
    peer.volume = 0; range.value = 0; if (peer.audioEl) peer.audioEl.volume = 0; closePopover();
  });
  showPopover(po, x, y);
}
function openSelfPopover(x, y) {
  const po = $('popover');
  po.innerHTML = `<h4>Your name</h4>
    <input type="text" maxlength="32" value="${escapeHtml(myName)}">
    <button class="pbtn">Save</button>`;
  const inp = po.querySelector('input');
  const save = () => {
    const n = inp.value.trim().slice(0, 32);
    if (n && n !== myName) { myName = n; self.name = n; if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'rename', name: n })); }
    closePopover();
  };
  po.querySelector('.pbtn').addEventListener('click', save);
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
  showPopover(po, x, y); inp.focus(); inp.select();
}
function showPopover(po, x, y) {
  po.classList.remove('hidden');
  const w = po.offsetWidth, h = po.offsetHeight;
  po.style.left = Math.max(8, Math.min(W - w - 8, x - w / 2)) + 'px';
  po.style.top = Math.max(8, Math.min(H - h - 8, y + 16)) + 'px';
}
function closePopover() { $('popover').classList.add('hidden'); }
document.addEventListener('keydown', e => { if (e.key === 'Escape') closePopover(); });

// ============================================================================
//  CONTROL DECK
// ============================================================================
$('mute-btn').addEventListener('click', () => {
  micEnabled = !micEnabled;
  localStream.getAudioTracks().forEach((t) => (t.enabled = micEnabled));
  const btn = $('mute-btn');
  btn.classList.toggle('off', !micEnabled);
  btn.classList.toggle('live', micEnabled);
  btn.setAttribute('aria-pressed', String(micEnabled));
  btn.querySelector('.ico').innerHTML = icon(micEnabled ? 'mic' : 'mic-off', { size: 22 });
  announce(micEnabled ? 'Microphone live' : 'Microphone muted');
  playSound('tick');
});
$('deafen-btn').addEventListener('click', () => {
  deafened = !deafened;
  for (const p of peers.values()) {
    if (p.audioEl) p.audioEl.volume = deafened ? 0 : p.volume;
    // Also mute the remote video element (which carries screen-share audio).
    if (p.videoEl) p.videoEl.volume = deafened ? 0 : 1;
  }
  const btn = $('deafen-btn');
  btn.classList.toggle('off', deafened);
  btn.setAttribute('aria-pressed', String(deafened));
  btn.querySelector('.ico').innerHTML = icon(deafened ? 'headphones-off' : 'headphones', { size: 20 });
  announce(deafened ? 'Incoming audio silenced' : 'Incoming audio restored');
  playSound('tick');
});
$('aec-toggle').addEventListener('click', async () => {
  aecOn = !aecOn; syncAecUI();
  try { await replaceLocalStream(await acquireStream($('mic-room-select').value)); } catch (e) { __ar.log.warn('aec-toggle replaceLocalStream', e); }
});
function syncAecUI() {
  $('aec-toggle').classList.toggle('on', aecOn);
  $('aec-toggle').setAttribute('aria-checked', String(aecOn));
}
$('mic-room-select').addEventListener('change', async () => {
  try { await replaceLocalStream(await acquireStream($('mic-room-select').value)); } catch (e) { __ar.log.warn('mic-change replaceLocalStream', e); }
});
$('out-select').addEventListener('change', () => {
  outputSinkId = $('out-select').value;
  for (const p of peers.values()) if (p.audioEl?.setSinkId) p.audioEl.setSinkId(outputSinkId).catch(() => {});
});
// ============================================================================
//  VIDEO QUALITY () — 1080p60 + codec preference AV1 → H264 (NVENC se
//  disponibile) → VP9 → VP8, max bitrate sender, audio capture screen share.
// ============================================================================
const VIDEO_PROFILE_HQ = {
  width: { ideal: 1920, min: 640 },
  height: { ideal: 1080, min: 360 },
  frameRate: { ideal: 60, min: 24 },
};
const PREFERRED_VIDEO_CODECS = ['video/AV1', 'video/H264', 'video/VP9', 'video/VP8'];
const VIDEO_MAX_BITRATE = 6_000_000; // 6 Mbps per 1080p60 hardware-encoded

/**
 * Applica codec preference su un transceiver. AV1 first se Chrome lo supporta.
 * H264 spesso e' accelerato hardware (NVENC su NVIDIA). VP9 e VP8 fallback.
 */
function preferVideoCodecs(transceiver) {
  if (!transceiver?.setCodecPreferences) return;
  let caps;
  try { caps = RTCRtpSender.getCapabilities?.('video'); } catch { return; }
  if (!caps?.codecs?.length) return;
  const wanted = [];
  for (const target of PREFERRED_VIDEO_CODECS) {
    const t = target.toLowerCase();
    for (const c of caps.codecs) {
      if (c.mimeType.toLowerCase() === t && !wanted.includes(c)) wanted.push(c);
    }
  }
  // appendi gli altri per non rompere la negoziazione se nessuno dei
  // preferred e' supportato dall'altro lato.
  for (const c of caps.codecs) if (!wanted.includes(c)) wanted.push(c);
  try {
    transceiver.setCodecPreferences(wanted);
    __ar.log.info(
      '[video] codec pref: ' + wanted.slice(0, 3).map((c) => c.mimeType.split('/')[1]).join('→'),
    );
  } catch (e) { __ar.log.warn('[video] setCodecPreferences', e); }
}

/**
 * Trova il transceiver di un sender e applica codec preferences + max bitrate.
 */
async function tuneVideoSender(pc, sender, label) {
  const tr = pc.getTransceivers?.().find((t) => t.sender === sender);
  if (tr) preferVideoCodecs(tr);
  try {
    const p = sender.getParameters();
    if (!p.encodings) p.encodings = [{}];
    p.encodings[0].maxBitrate = VIDEO_MAX_BITRATE;
    p.encodings[0].priority = 'high';
    p.encodings[0].networkPriority = 'high';
    p.degradationPreference = 'maintain-resolution';
    await sender.setParameters(p);
    __ar.log.info(`[video] ${label} maxBitrate=${VIDEO_MAX_BITRATE / 1e6}Mbps`);
  } catch (e) { __ar.log.warn(`[video] ${label} setParameters`, e); }
}

// ============================================================================
//  CAMERA TOGGLE RUNTIME ( + 15) — 1080p60 con codec preference.
// ============================================================================
let cameraStream = null;
let cameraSenders = []; // [{peerId, sender, pc}]

async function startCamera() {
  if (cameraStream) return;
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: VIDEO_PROFILE_HQ,
      audio: false,
    });
  } catch (e) {
    __ar.log.warn('[camera] getUserMedia rejected', e.name);
    // Fallback risoluzione minore se il device non regge 1080p60
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { width: 1280, height: 720, frameRate: 30 },
        audio: false,
      });
      __ar.log.info('[camera] fallback 720p30');
    } catch (e2) {
      __ar.log.warn('[camera] fallback rejected', e2.name);
      return;
    }
  }
  const track = cameraStream.getVideoTracks()[0];
  if (!track) return;
  const settings = track.getSettings?.() || {};
  __ar.log.info(`[camera] acquisita ${settings.width}x${settings.height}@${settings.frameRate}fps`);
  track.addEventListener('ended', () => stopCamera());
  const targets = [...peers.values()]
    .filter((p) => p.pc)
    .map((p) => ({ pc: p.pc, peerId: p.id }));
  for (const { pc, peerId } of targets) {
    try {
      const sender = pc.addTrack(track, cameraStream);
      cameraSenders.push({ peerId, sender, pc });
      await tuneVideoSender(pc, sender, `camera→${peerId}`);
    } catch (e) { __ar.log.warn('[camera] addTrack', e); }
  }
  ensureSelfCameraTile(cameraStream);
  videoEnabled = true;
  updateCameraUi(true);
  __ar.log.info('[camera] attivata, peers=' + peers.size);
}

function stopCamera() {
  if (!cameraStream) return;
  cameraStream.getTracks().forEach((t) => t.stop());
  cameraStream = null;
  for (const { sender, pc } of cameraSenders) {
    if (!pc) continue;
    try { pc.removeTrack(sender); } catch (e) { __ar.log.warn('[camera] removeTrack', e); }
  }
  cameraSenders = [];
  document.querySelector('.video-tile-camera-self')?.remove();
  refreshVideoGridVisibility();
  videoEnabled = false;
  updateCameraUi(false);
  __ar.log.info('[camera] disattivata');
}

function ensureSelfCameraTile(stream) {
  const grid = $('video-grid');
  if (!grid) return;
  if (document.querySelector('.video-tile-camera-self')) return;
  const tile = document.createElement('div');
  tile.className = 'video-tile video-tile-self video-tile-camera-self';
  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;
  video.srcObject = stream;
  const label = document.createElement('div');
  label.className = 'video-label';
  label.textContent = myName + ' (you)';
  tile.appendChild(video);
  tile.appendChild(label);
  grid.appendChild(tile);
  video.play().catch(() => {});
  refreshVideoGridVisibility();
}

function updateCameraUi(active) {
  const btn = $('camera-btn');
  if (!btn) return;
  btn.classList.toggle('active', active);
  btn.setAttribute('aria-pressed', String(active));
  btn.querySelector('.ico').innerHTML = icon(active ? 'video-off' : 'video', { size: 20 });
  btn.title = active ? 'Turn camera off (C)' : 'Turn camera on (C)';
}

// ============================================================================
//  ALONE-IN-ROOM HINT ( fix utente) — mostra "sei solo qui" quando
//  peers vuoto: cosi' l'utente sa che il silenzio in mix N-1 e' atteso.
// ============================================================================
function updateAloneBadge() {
  const b = $('alone-badge');
  if (!b) return;
  // peers = altri utenti (escluso self). Se 0, sono solo nella stanza.
  b.classList.toggle('hidden', peers.size !== 0);
}
// event-driven (peer-joined/peer-left chiamano updateAloneBadge direttamente):
// niente più polling 1Hz inutile.

// ============================================================================
//  SCREEN SHARING () — mesh P2P only
// ============================================================================
let screenStream = null;
let screenSenders = []; // [{peerId, sender, pc, kind}]

async function startScreenShare() {
  if (screenStream) return stopScreenShare();

  // Robust acquisition strategy:
  //   1) First try with audio enabled. NOTE: `displaySurface: 'monitor'` was
  //      a HARD constraint that rejected with OverconstrainedError whenever
  //      the user picked a Window or Tab. We dropped it: the browser still
  //      shows all surface kinds in the picker, the user simply chooses.
  //   2) If the request fails because of the audio constraint (some sources
  //      like "Window" don't support system audio capture), retry without
  //      audio so the user at least gets video.
  //   3) NotAllowedError = user cancelled the picker → silent (it's their choice).
  //   4) Any other error → visible toast so the user knows it didn't work.
  //
  // IMPORTANT: getDisplayMedia spec FORBIDS `min` constraints (only ideal/exact/max
  // are accepted). VIDEO_PROFILE_HQ has `min` keys for getUserMedia/camera, so
  // here we keep only the `ideal` subset. Without this filter Chrome rejects
  // with TypeError: "min constraints are not supported" → screen-share never starts.
  const videoConstraints = {
    width: { ideal: VIDEO_PROFILE_HQ.width.ideal },
    height: { ideal: VIDEO_PROFILE_HQ.height.ideal },
    frameRate: { ideal: VIDEO_PROFILE_HQ.frameRate.ideal },
  };
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: videoConstraints,
      audio: true, // tab/system audio when supported
    });
  } catch (e) {
    if (e.name === 'NotAllowedError') {
      __ar.log.info('[screen] picker cancelled by user');
      return;
    }
    __ar.log.warn('[screen] first attempt failed, retrying video-only', e.name);
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: videoConstraints,
        audio: false,
      });
    } catch (e2) {
      if (e2.name === 'NotAllowedError') return;
      __ar.log.error('[screen] getDisplayMedia failed', e2.name, e2.message);
      showToast(`Screen share failed: ${e2.name}`);
      return;
    }
  }

  const videoTrack = screenStream.getVideoTracks()[0];
  const audioTrack = screenStream.getAudioTracks()[0];
  if (!videoTrack) {
    __ar.log.warn('[screen] stream has no video track');
    showToast('Screen share failed: no video track returned');
    return;
  }
  const vs = videoTrack.getSettings?.() || {};
  __ar.log.info(
    `[screen] acquired ${vs.width}x${vs.height}@${vs.frameRate}fps, audio=${audioTrack ? 'yes' : 'no'}`,
  );
  videoTrack.addEventListener('ended', () => stopScreenShare());
  audioTrack?.addEventListener('ended', () => __ar.log.info('[screen] audio track ended'));

  const targets = [...peers.values()]
    .filter((p) => p.pc)
    .map((p) => ({ pc: p.pc, peerId: p.id }));

  for (const { pc, peerId } of targets) {
    try {
      const vsender = pc.addTrack(videoTrack, screenStream);
      screenSenders.push({ peerId, sender: vsender, pc, kind: 'video' });
      await tuneVideoSender(pc, vsender, `screen→${peerId}`);
      if (audioTrack) {
        const asender = pc.addTrack(audioTrack, screenStream);
        screenSenders.push({ peerId, sender: asender, pc, kind: 'audio' });
      }
    } catch (e) {
      __ar.log.warn('[screen] addTrack failed peer=' + peerId, e);
    }
  }
  ensureSelfScreenTile(screenStream);
  updateScreenShareUi(true);
  announce(audioTrack ? 'Screen + audio shared' : 'Screen shared');
  __ar.log.info(
    `[screen] sharing started, peers=${targets.length}, tracks=${videoTrack ? 1 : 0}v+${audioTrack ? 1 : 0}a`,
  );
}

// Lightweight toast helper for transient errors. Reuses the copy-toast styling.
function showToast(text, ms = 2400) {
  let toast = document.getElementById('copy-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'copy-toast';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = text;
  toast.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.add('hidden'), ms);
}

function stopScreenShare() {
  if (!screenStream) return;
  screenStream.getTracks().forEach((t) => t.stop());
  screenStream = null;
  // Rimuovi sender dai pc ( tracking diretto del pc nel sender entry)
  for (const { sender, pc } of screenSenders) {
    if (!pc) continue;
    try {
      pc.removeTrack(sender);
    } catch (e) {
      __ar.log.warn('[screen] removeTrack', e);
    }
  }
  screenSenders = [];
  document.querySelector('.video-tile-screen-self')?.remove();
  document.querySelector('.music-tile-self')?.remove();
  refreshVideoGridVisibility();
  updateScreenShareUi(false);
  __ar.log.info('[screen] sharing fermato');
}

function ensureSelfScreenTile(stream) {
  const grid = $('video-grid');
  if (!grid) return;
  if (document.querySelector('.video-tile-screen-self')) return;
  const tile = document.createElement('div');
  tile.className = 'video-tile video-tile-screen-self';
  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true; // anti-larsen sulla SELF tile
  video.srcObject = stream;
  const audioOn = stream.getAudioTracks().length > 0;
  const label = document.createElement('div');
  label.className = 'video-label';
  label.innerHTML = icon('monitor', { size: 14 }) + (audioOn ? ' Sharing screen and audio' : ' Sharing your screen');
  tile.appendChild(video);
  tile.appendChild(label);
  grid.appendChild(tile);
  video.play().catch(() => {});
  refreshVideoGridVisibility();
}

function updateScreenShareUi(active, mode) {
  // mode: 'screen' | 'music' | undefined (idle)
  const btn = $('screen-share-btn');
  if (!btn) return;
  btn.classList.toggle('active', active);
  btn.classList.toggle('music', active && mode === 'music');
  btn.setAttribute('aria-pressed', String(active));
  const iconName = active ? 'stop' : 'monitor';
  btn.querySelector('.ico').innerHTML = icon(iconName, { size: 20 });
  btn.title = active
    ? mode === 'music'
      ? 'Stop audio share (S)'
      : 'Stop sharing (S)'
    : 'Share screen or audio (S)';
}

// ============================================================================
// MUSIC SHARE — getDisplayMedia audio-only at 320 kbps stereo
//
// Why this exists: getDisplayMedia by spec REQUIRES a video constraint, you
// cannot ask for audio-only directly. The workaround is to ask for the smallest
// possible video stream, then discard the video track immediately and only
// addTrack the audio. The picker still shows tab/window/screen choices; the
// user picks a Chrome tab that has audio (a music site, a YouTube video, etc).
//
// Quality target: 320 kbps stereo Opus. The SDP fmtp from tuneOpus already
// negotiates stereo + maxaveragebitrate=510000 (session-wide setting), and
// tuneAudioForMusic clamps the per-sender encoding to 320 kbps so the bitrate
// stays predictable even when the audio track also benefits from the higher
// SDP cap.
// ============================================================================
async function startMusicShare() {
  if (screenStream) return stopScreenShare(); // already sharing something
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      // Video constraint is mandatory; ask for the cheapest possible stub.
      video: { width: { ideal: 1 }, height: { ideal: 1 }, frameRate: { ideal: 1 } },
      audio: {
        autoGainControl: false,
        echoCancellation: false,
        noiseSuppression: false,
      },
    });
  } catch (e) {
    if (e.name === 'NotAllowedError') {
      __ar.log.info('[music] picker cancelled by user');
      return;
    }
    __ar.log.error('[music] getDisplayMedia failed', e.name, e.message);
    showToast(`Audio share failed: ${e.name}`);
    return;
  }
  const audioTrack = stream.getAudioTracks()[0];
  // Discard the mandatory video track. We never send it.
  for (const v of stream.getVideoTracks()) v.stop();
  if (!audioTrack) {
    showToast('Audio share failed. This source has no audio. Try a Chrome tab.');
    stream.getTracks().forEach((t) => t.stop());
    return;
  }
  __ar.log.info(`[music] acquired audio, sampleRate=${audioTrack.getSettings?.().sampleRate || '?'}`);
  audioTrack.addEventListener('ended', () => stopScreenShare());

  screenStream = stream;
  const targets = [...peers.values()]
    .filter((p) => p.pc)
    .map((p) => ({ pc: p.pc, peerId: p.id }));
  for (const { pc, peerId } of targets) {
    try {
      const asender = pc.addTrack(audioTrack, stream);
      screenSenders.push({ peerId, sender: asender, pc, kind: 'audio' });
      await tuneAudioForMusic(asender, `music→${peerId}`);
    } catch (e) {
      __ar.log.warn('[music] addTrack failed peer=' + peerId, e);
    }
  }
  ensureSelfMusicTile();
  updateScreenShareUi(true, 'music');
  announce('Sharing tab audio at 320 kbps');
  __ar.log.info(`[music] sharing started, peers=${targets.length}`);
}

// Compact tile shown in the video-grid area while audio-only is being shared.
// No <video> element since there is no video; only an icon and a label so the
// sharer has a visible reminder that the share is live.
function ensureSelfMusicTile() {
  const grid = $('video-grid');
  if (!grid) return;
  if (document.querySelector('.music-tile-self')) return;
  const tile = document.createElement('div');
  tile.className = 'video-tile music-tile-self';
  tile.innerHTML =
    `<div class="music-tile-body">${icon('music', { size: 24 })}` +
    `<div class="music-tile-text"><span class="music-tile-title">Sharing audio</span>` +
    `<span class="music-tile-sub">320 kbps stereo</span></div></div>`;
  grid.appendChild(tile);
  refreshVideoGridVisibility();
}

// Share-mode picker. Two options: full screen + audio, or audio only.
// Centered card, click outside or Esc closes it. Mirrors the cheatsheet
// pattern so users don't have to learn a new modal grammar.
let shareMenuEl = null;
function openShareMenu() {
  if (shareMenuEl) return closeShareMenu();
  shareMenuEl = document.createElement('div');
  shareMenuEl.className = 'share-menu';
  shareMenuEl.setAttribute('role', 'menu');
  shareMenuEl.innerHTML = `
    <h3>Choose what to share</h3>
    <button class="share-option" data-mode="screen" role="menuitem" type="button">
      <span class="share-option-icon">${icon('monitor', { size: 22 })}</span>
      <span class="share-option-text">
        <span class="share-option-title">Screen and audio</span>
        <span class="share-option-sub">A tab, a window, or the full desktop.</span>
      </span>
    </button>
    <button class="share-option" data-mode="music" role="menuitem" type="button">
      <span class="share-option-icon">${icon('music', { size: 22 })}</span>
      <span class="share-option-text">
        <span class="share-option-title">Audio only</span>
        <span class="share-option-sub">Stream tab audio at 320 kbps stereo. No video.</span>
      </span>
    </button>
    <p class="share-menu-foot">Esc to close.</p>
  `;
  document.body.appendChild(shareMenuEl);
  shareMenuEl.addEventListener('click', (e) => {
    const opt = e.target.closest('.share-option');
    if (!opt) return;
    const mode = opt.dataset.mode;
    closeShareMenu();
    if (mode === 'screen') startScreenShare();
    else if (mode === 'music') startMusicShare();
  });
  // Outside-click close. Use a microtask so the originating click doesn't
  // immediately close the menu we just opened.
  setTimeout(() => {
    document.addEventListener('click', _shareMenuOutsideClick, { capture: true });
  }, 0);
  shareMenuEl.querySelector('.share-option')?.focus();
}
function closeShareMenu() {
  if (!shareMenuEl) return;
  shareMenuEl.remove();
  shareMenuEl = null;
  document.removeEventListener('click', _shareMenuOutsideClick, { capture: true });
}
function _shareMenuOutsideClick(e) {
  if (!shareMenuEl) return;
  if (shareMenuEl.contains(e.target)) return;
  if (e.target.closest?.('#screen-share-btn')) return; // the toggle handles itself
  closeShareMenu();
}

$('leave-btn').addEventListener('click', () => {
  //  chiusura intenzionale -> sopprimi il reconnect loop prima di
  // ricaricare la pagina (evita una raffica di tentativi durante l'unload).
  manualClose = true;
  clearTimeout(reconnectTimer);
  try { if (ws && ws.readyState === 1) ws.close(); } catch {}
  location.reload();
});

// ============================================================================
//  THEME SWITCHER () — default → matrix → cyberpunk → apple → default
// ============================================================================
const THEMES = ['default', 'matrix', 'cyberpunk', 'apple'];
const THEME_LABELS = {
  default: 'Graphite',
  matrix: 'Terminal',
  cyberpunk: 'Ember',
  apple: 'Dawn',
};

function applyTheme(name) {
  if (!THEMES.includes(name)) name = 'default';
  if (name === 'default') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', name);
  try {
    localStorage.setItem('halcyon:theme', name);
  } catch {}
  if (profile?.data) {
    profile.data.theme = name;
    saveProfile?.();
  }
}

function showThemeToast(name) {
  const old = document.querySelector('.theme-toast');
  if (old) old.remove();
  const toast = document.createElement('div');
  toast.className = 'theme-toast';
  toast.textContent = THEME_LABELS[name] || name;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 1700);
}

function cycleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') || 'default';
  const idx = THEMES.indexOf(cur);
  const next = THEMES[(idx + 1) % THEMES.length];
  applyTheme(next);
  showThemeToast(next);
}

// All'avvio carica il tema persisted (localStorage o profile)
function bootTheme() {
  let theme = 'default';
  try {
    theme = localStorage.getItem('halcyon:theme') || profile?.data?.theme || 'default';
  } catch {}
  if (THEMES.includes(theme)) applyTheme(theme);
}

window.__ar.theme = () => document.documentElement.getAttribute('data-theme') || 'default';
window.__ar.setTheme = applyTheme;

// ============================================================================
//  KEYBOARD SHORTCUTS () — usabilità rapida
//
//  M           toggle microfono (mute/unmute)
//  D           toggle deafen (silenzia tutto in arrivo)
//  C           toggle camera
//  S           toggle screen share
//  T           test beep (verifica audio output)
//  Space (hold) push-to-talk (PTT): se mic e' muto, hold attiva temporaneamente
//  ?           mostra/nascondi cheatsheet shortcuts
//  Esc         chiude drawer chat e modali
//
//  Sono disabilitate quando il focus e' su un input/textarea (per non
//  bloccare il typing nella chat).
// ============================================================================
let pttHeld = false;
let pttRestoreMute = false; // stato mic da ripristinare a rilascio space

function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
}

function setMic(enabled) {
  if (!localStream) return;
  micEnabled = enabled;
  localStream.getAudioTracks().forEach((t) => (t.enabled = enabled));
  $('mute-btn')?.classList.toggle('off', !enabled);
  $('mute-btn')?.classList.toggle('live', enabled);
  const ico = $('mute-btn')?.querySelector('.ico');
  if (ico) ico.innerHTML = icon(enabled ? 'mic' : 'mic-off', { size: 22 });
}

document.addEventListener('keydown', (e) => {
  if (e.repeat) {
    // Space PTT: ignoriamo i repeat (gestiti separatamente sotto)
    if (e.code === 'Space' && !isTypingTarget(document.activeElement)) e.preventDefault();
    return;
  }
  if (isTypingTarget(document.activeElement)) return;
  // I modificatori passano (Ctrl+Shift+D = stats panel, gestito altrove)
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  switch (e.key.toLowerCase()) {
    case 'm':
      setMic(!micEnabled);
      saveProfile?.();
      break;
    case 'd':
      $('deafen-btn')?.click();
      break;
    case 'c':
      $('camera-btn')?.click();
      break;
    case 's':
      $('screen-share-btn')?.click();
      break;
    case 't':
      playTestBeep();
      break;
    case 'r':
      openReactPopover();
      break;
    case 'g':
      cycleViewMode();
      break;
    case '?':
      toggleShortcutsCheatsheet();
      break;
    case 'escape':
      closeChat?.();
      closePopover?.();
      closeStatsPanel?.();
      hideShortcutsCheatsheet();
      closeShareMenu?.();
      closeReactPopover?.();
      break;
    case ' ':
      // Push-to-talk: se mic muto, attiviamo finche' tenuto premuto
      if (!micEnabled) {
        e.preventDefault();
        pttHeld = true;
        pttRestoreMute = true;
        setMic(true);
        document.body.classList.add('ptt-active');
        playSound('pttOn');
      }
      break;
  }
});

document.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && pttHeld) {
    pttHeld = false;
    if (pttRestoreMute) {
      setMic(false);
      pttRestoreMute = false;
    }
    document.body.classList.remove('ptt-active');
    playSound('pttOff');
  }
});

// Cheatsheet shortcuts
let cheatsheetEl = null;
function toggleShortcutsCheatsheet() {
  if (cheatsheetEl) return hideShortcutsCheatsheet();
  cheatsheetEl = document.createElement('div');
  cheatsheetEl.className = 'shortcuts-cheatsheet';
  cheatsheetEl.innerHTML = `
    <h3>${icon('keyboard', { size: 18 })}Keyboard shortcuts</h3>
    <table>
      <tr><th>Key</th><th>Action</th></tr>
      <tr><td><kbd>M</kbd></td><td>Mic on/off</td></tr>
      <tr><td><kbd>Space</kbd> (hold)</td><td>Push-to-talk</td></tr>
      <tr><td><kbd>D</kbd></td><td>Deafen (silence all incoming)</td></tr>
      <tr><td><kbd>C</kbd></td><td>Camera on/off</td></tr>
      <tr><td><kbd>S</kbd></td><td>Screen-share on/off</td></tr>
      <tr><td><kbd>T</kbd></td><td>Test beep</td></tr>
      <tr><td><kbd>Ctrl+Shift+D</kbd></td><td>Stats debug panel</td></tr>
      <tr><td><kbd>?</kbd></td><td>This cheatsheet</td></tr>
      <tr><td><kbd>Esc</kbd></td><td>Close panels</td></tr>
    </table>
    <p class="cheat-foot">Shortcuts are disabled while typing in a text field. Press <kbd>?</kbd> or <kbd>Esc</kbd> to close.</p>
  `;
  document.body.appendChild(cheatsheetEl);
}
function hideShortcutsCheatsheet() {
  if (cheatsheetEl) {
    cheatsheetEl.remove();
    cheatsheetEl = null;
  }
}
window.__ar.shortcuts = () => ({ ptt: pttHeld, mic: micEnabled, deafened });

// ============================================================================
//  ROOM ID + COPIA INVITO
// ============================================================================
function initRoomId() {
  //  se ?room=X presente lo mostriamo, altrimenti host-derived.
  try {
    const r = new URLSearchParams(location.search).get('room');
    if (r && /^[a-zA-Z0-9_-]{1,40}$/.test(r)) {
      $('room-id-text').textContent = r;
      return;
    }
  } catch {}
  const host = location.hostname;
  const last = host.split('.').pop();
  $('room-id-text').textContent = 'Local-Node-' + (/^\d+$/.test(last) ? last.padStart(2, '0') : '01');
}
$('room-id').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(location.href); } catch {}
  const toast = $('copy-toast'); toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 1600);
});

// ============================================================================
//  CHAT () — drawer destro, markdown minimal, history persistente
// ============================================================================
const chatState = {
  messages: [],       // array {id, fromId, fromName, ts, text, editedAt, deleted}
  msgById: new Map(), // id -> messaggio (per edit/delete in place)
  typingUsers: new Map(), // peerId -> {name, until}
  unread: 0,
  open: false,
};

function escapeHtmlText(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function renderChatMarkdown(input) {
  let s = escapeHtmlText(String(input || ''));
  s = s.replace(/```([\s\S]+?)```/g, (_, body) => `<pre><code>${body}</code></pre>`);
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(?<![*\w])\*([^*\n]+)\*(?!\w)/g, '<em>$1</em>');
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g,
    (_, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`);
  s = s.replace(/(^|\s)@([a-zA-Z0-9_]{1,32})/g, '$1<span class="mention">@$2</span>');
  return s.replace(/\n/g, '<br>');
}

function requestChatHistory() {
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: 'chat:history', limit: 50 }));
}

function onChatHistory(items) {
  // items arrivano in ordine ts DESC (piu' recenti per primi); rovesciamo
  // per inserire in ordine cronologico nell'array.
  const ordered = [...items].reverse();
  for (const m of ordered) {
    if (chatState.msgById.has(m.id)) continue;
    chatState.messages.push(m);
    chatState.msgById.set(m.id, m);
  }
  renderChatList();
}

function onChatMessage(m) {
  if (chatState.msgById.has(m.id)) return;
  chatState.messages.push(m);
  chatState.msgById.set(m.id, m);
  appendChatMsg(m); // append-only invece di full rebuild
  if (!chatState.open && m.fromId !== profile.userId) {
    chatState.unread++;
    updateChatBadge();
    announce(`Nuovo messaggio in chat da ${m.fromName}`);
    playSound('msg');
  }
}

function onChatEdited({ msgId, text, editedAt }) {
  const m = chatState.msgById.get(msgId);
  if (!m) return;
  m.text = text;
  m.editedAt = editedAt;
  updateChatMsg(m); // in-place
}

function onChatDeleted(msgId) {
  const m = chatState.msgById.get(msgId);
  if (!m) return;
  m.deleted = true;
  updateChatMsg(m); // in-place
}

function onChatTyping({ from, fromName, isTyping }) {
  if (isTyping) chatState.typingUsers.set(from, { name: fromName, until: Date.now() + 3500 });
  else chatState.typingUsers.delete(from);
  renderChatTyping();
}

const QUICK_EMOJIS = ['👍', '❤️', '😂', '🎉', '🔥', '🤔'];

function renderReactionsHtml(reactions, myUserId) {
  if (!reactions) return '';
  const entries = Object.entries(reactions).filter(([, r]) => r.count > 0);
  if (!entries.length) return '';
  return (
    '<div class="chat-reactions">' +
    entries
      .map(([emoji, r]) => {
        const mine = r.users.includes(myUserId) ? ' mine' : '';
        return `<button class="chat-reaction${mine}" data-emoji="${escapeHtmlText(emoji)}">${escapeHtmlText(emoji)} <span class="r-count">${r.count}</span></button>`;
      })
      .join('') +
    '</div>'
  );
}

function renderQuickReactionsHtml() {
  return (
    '<div class="chat-react-picker">' +
    QUICK_EMOJIS.map(
      (e) =>
        `<button class="chat-quick-react" data-emoji="${e}" title="React ${e}">${e}</button>`,
    ).join('') +
    '</div>'
  );
}

// Rendering chat incrementale: la versione precedente faceva `list.innerHTML = ...`
// su OGNI nuovo messaggio / edit / delete / reaction. Per 100+ messaggi questo:
//   1) rompe la selezione di testo dell'utente
//   2) interrompe lo scroll se l'utente sta leggendo in alto
//   3) costa O(N) DOM rebuild + reflow ogni volta
// Ora: append-only per i nuovi, in-place update per edit/delete/react.
function renderChatMsgEl(m) {
  const mine = m.fromId === profile.userId ? ' mine' : '';
  const el = document.createElement('div');
  el.className = 'chat-msg' + mine;
  el.dataset.id = m.id;
  updateChatMsgInner(el, m);
  return el;
}

function updateChatMsgInner(el, m) {
  if (m.deleted) {
    el.classList.add('deleted');
    el.innerHTML = `<span class="chat-from">${escapeHtmlText(m.fromName)}</span><span class="chat-body deleted-body">[message removed]</span>`;
    return;
  }
  el.classList.remove('deleted');
  const edited = m.editedAt ? ' <span class="edit-tag">(edited)</span>' : '';
  const html = renderChatMarkdown(m.text);
  const time = new Date(m.ts).toLocaleTimeString('it-IT', {
    hour: '2-digit',
    minute: '2-digit',
  });
  const reactions = renderReactionsHtml(m.reactions, profile.userId);
  el.innerHTML =
    `<div class="chat-meta"><span class="chat-from">${escapeHtmlText(m.fromName)}</span> <span class="chat-time">${time}</span>${edited}</div>` +
    `<div class="chat-body">${html}</div>` +
    reactions +
    renderQuickReactionsHtml();
}

function renderChatList() {
  // Full rebuild: usato solo dal load iniziale di history.
  const list = $('chat-list');
  if (!list) return;
  list.replaceChildren(...chatState.messages.map(renderChatMsgEl));
  list.scrollTop = list.scrollHeight;
}

function appendChatMsg(m) {
  const list = $('chat-list');
  if (!list) return;
  // Se l'utente è scrollato vicino al fondo (entro 80px) auto-scroll;
  // altrimenti non interrompere la lettura.
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  list.appendChild(renderChatMsgEl(m));
  if (nearBottom) list.scrollTop = list.scrollHeight;
}

function updateChatMsg(m) {
  const list = $('chat-list');
  const el = list?.querySelector(`.chat-msg[data-id="${CSS.escape(m.id)}"]`);
  if (!el) return appendChatMsg(m);
  updateChatMsgInner(el, m);
}

function onChatReactionUpdate({ msgId, reactions }) {
  const m = chatState.msgById.get(msgId);
  if (!m) return;
  m.reactions = reactions;
  updateChatMsg(m);
}

function sendReaction(msgId, emoji) {
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: 'chat:react', msgId, emoji }));
}

function renderChatTyping() {
  const el = $('chat-typing');
  if (!el) return;
  const now = Date.now();
  for (const [k, v] of chatState.typingUsers) if (v.until < now) chatState.typingUsers.delete(k);
  const names = [...chatState.typingUsers.values()].map((v) => v.name);
  if (!names.length) { el.textContent = ''; return; }
  el.textContent =
    names.length === 1
      ? `${names[0]} is typing…`
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} are typing…`;
}

function updateChatBadge() {
  const b = $('chat-toggle-badge');
  if (!b) return;
  if (chatState.unread > 0) {
    b.textContent = chatState.unread > 99 ? '99+' : String(chatState.unread);
    b.classList.remove('hidden');
  } else b.classList.add('hidden');
}

function openChat() {
  chatState.open = true;
  const drawer = $('chat-drawer');
  drawer?.classList.add('open');
  drawer?.setAttribute('aria-hidden', 'false');
  $('chat-toggle')?.setAttribute('aria-expanded', 'true');
  chatState.unread = 0;
  updateChatBadge();
  setTimeout(() => $('chat-input')?.focus(), 50);
}

function closeChat() {
  chatState.open = false;
  const drawer = $('chat-drawer');
  drawer?.classList.remove('open');
  drawer?.setAttribute('aria-hidden', 'true');
  $('chat-toggle')?.setAttribute('aria-expanded', 'false');
}

function bindChatUi() {
  $('chat-toggle')?.addEventListener('click', () => (chatState.open ? closeChat() : openChat()));
  $('chat-close')?.addEventListener('click', closeChat);
  // Event delegation per click su reactions (quick picker + counter toggle).
  $('chat-list')?.addEventListener('click', (e) => {
    const msgEl = e.target.closest('.chat-msg');
    if (!msgEl) return;
    const msgId = msgEl.dataset.id;
    if (!msgId) return;
    const btn = e.target.closest('.chat-quick-react, .chat-reaction');
    if (!btn) return;
    const emoji = btn.dataset.emoji;
    if (emoji) sendReaction(msgId, emoji);
  });
  const input = $('chat-input');
  if (!input) return;
  let typingDebounce;
  let isTyping = false;
  const sendTyping = (state) => {
    if (!ws || ws.readyState !== 1) return;
    if (state === isTyping) return;
    isTyping = state;
    ws.send(JSON.stringify({ type: 'chat:typing', isTyping: state }));
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      if (!ws || ws.readyState !== 1) { __ar.log.warn('[chat] WS not ready'); return; }
      ws.send(JSON.stringify({ type: 'chat:send', text }));
      input.value = '';
      sendTyping(false);
      clearTimeout(typingDebounce);
    } else {
      sendTyping(true);
      clearTimeout(typingDebounce);
      typingDebounce = setTimeout(() => sendTyping(false), 2000);
    }
  });
  setInterval(renderChatTyping, 1500);
}
// Espongo per test e2e
window.__ar.chat = () => ({
  messages: [...chatState.messages],
  unread: chatState.unread,
  open: chatState.open,
});

// ============================================================================
//  STATS: latenza + topologia (P2P vs relay)
// ============================================================================
async function pollStats() {
  if (document.hidden) return; // perf: niente getStats() in background tab
  const entries = [...peers.values()].filter((p) => p.pc).map((p) => ({ peer: p, pc: p.pc }));
  const rtts = [];
  let relay = false,
    any = false;
  for (const { peer, pc } of entries) {
    let peerRtt = null;
    let peerLossPct = null;
    try {
      const stats = await pc.getStats();
      stats.forEach((r) => {
        if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) {
          any = true;
          if (typeof r.currentRoundTripTime === 'number') {
            const ms = r.currentRoundTripTime * 1000;
            rtts.push(ms);
            peerRtt = ms;
          }
          const lc = stats.get(r.localCandidateId),
            rc = stats.get(r.remoteCandidateId);
          if (lc?.candidateType === 'relay' || rc?.candidateType === 'relay') relay = true;
        }
        if (r.type === 'inbound-rtp' && r.kind === 'audio') {
          if (typeof r.packetsLost === 'number' && typeof r.packetsReceived === 'number') {
            const total = r.packetsLost + r.packetsReceived;
            if (total > 0) peerLossPct = (r.packetsLost / total) * 100;
          }
        }
      });
    } catch {
      /* swallow per-pc errors */
    }
    if (peerRtt !== null || peerLossPct !== null) {
      reportQuality(peer.id, peer.name, peerRtt, peerLossPct);
    }
  }
  setLat(rtts.length ? Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length) : any ? 1 : null);
  setTopo(relay);
}
// ============================================================================
//  STATS DASHBOARD () - Ctrl+Shift+D toggle
// ============================================================================
const statsState = { open: false, perPeer: new Map(), fps: 0, _fpsT: 0, _fpsN: 0 };

function openStatsPanel() {
  statsState.open = true;
  $('stats-panel')?.classList.remove('hidden');
}
function closeStatsPanel() {
  statsState.open = false;
  $('stats-panel')?.classList.add('hidden');
}
function toggleStatsPanel() {
  statsState.open ? closeStatsPanel() : openStatsPanel();
}

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
    e.preventDefault();
    toggleStatsPanel();
  }
});

// Update FPS sampled in tick loop
function trackFps(now) {
  statsState._fpsN++;
  if (now - statsState._fpsT >= 1000) {
    statsState.fps = Math.round((statsState._fpsN * 1000) / (now - statsState._fpsT));
    statsState._fpsT = now;
    statsState._fpsN = 0;
  }
}

async function collectStatsAll() {
  const pcs = [...peers.values()]
    .filter((p) => p.pc)
    .map((p) => ({ pid: p.id || '?', pc: p.pc, name: p.name }));
  const out = [];
  for (const { pid, pc, name } of pcs) {
    const entry = { pid, name, rtt: null, loss: null, jitter: null, kbpsDown: null, kbpsUp: null, codec: null };
    try {
      const stats = await pc.getStats();
      let bytesRecv = 0, bytesSent = 0;
      stats.forEach((r) => {
        if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') {
          if (typeof r.currentRoundTripTime === 'number') entry.rtt = Math.round(r.currentRoundTripTime * 1000);
        }
        if (r.type === 'inbound-rtp' && r.kind === 'audio') {
          if (typeof r.packetsLost === 'number' && typeof r.packetsReceived === 'number') {
            const total = r.packetsLost + r.packetsReceived;
            entry.loss = total > 0 ? ((r.packetsLost / total) * 100).toFixed(2) + '%' : '0%';
          }
          if (typeof r.jitter === 'number') entry.jitter = (r.jitter * 1000).toFixed(1) + 'ms';
          if (typeof r.bytesReceived === 'number') bytesRecv = r.bytesReceived;
          if (r.codecId) {
            const c = stats.get(r.codecId);
            if (c?.mimeType) entry.codec = c.mimeType.replace('audio/', '');
          }
        }
        if (r.type === 'outbound-rtp' && r.kind === 'audio') {
          if (typeof r.bytesSent === 'number') bytesSent = r.bytesSent;
        }
      });
      // Compute kbps from previous sample
      const prev = statsState.perPeer.get(pid);
      const nowSec = Date.now() / 1000;
      if (prev) {
        const dt = nowSec - prev.t;
        if (dt > 0) {
          entry.kbpsDown = Math.round(((bytesRecv - prev.bytesRecv) * 8) / 1000 / dt);
          entry.kbpsUp = Math.round(((bytesSent - prev.bytesSent) * 8) / 1000 / dt);
        }
      }
      statsState.perPeer.set(pid, { t: nowSec, bytesRecv, bytesSent });
    } catch {}
    out.push(entry);
  }
  return out;
}

async function renderStatsPanel() {
  if (!statsState.open) return;
  const rows = await collectStatsAll();
  const tbody = $('stats-tbody');
  if (tbody) {
    tbody.innerHTML = rows
      .map(
        (r) => `
        <tr>
          <td>${escapeHtmlText(r.name || r.pid)}</td>
          <td>${r.rtt ?? '—'} ${r.rtt !== null ? 'ms' : ''}</td>
          <td>${r.loss ?? '—'}</td>
          <td>${r.jitter ?? '—'}</td>
          <td>${r.kbpsDown ?? '—'}</td>
          <td>${r.kbpsUp ?? '—'}</td>
          <td>${r.codec ?? '—'}</td>
        </tr>`,
      )
      .join('');
  }
  const $$ = (id) => document.getElementById(id);
  if ($$('stats-ws')) $$('stats-ws').textContent = wsState;
  if ($$('stats-mode')) $$('stats-mode').textContent = 'mesh';
  if ($$('stats-errors')) $$('stats-errors').textContent = String(__ar.state.errors.length);
  if ($$('stats-fps')) $$('stats-fps').textContent = String(statsState.fps);
}

setInterval(renderStatsPanel, 1500);

// ============================================================================
// ROOM SIGNALS — floating reactions + hand-raise
//
// The reactions popover lives above the React deck button. Picking an emoji
// (or pressing the hand toggle) sends a WS message; the server fans it out to
// the whole room. Receiver-side, an emoji floats up over the sender's avatar
// for ~1.4s, and hand-raise paints a persistent badge on the tile.
// ============================================================================
const REACT_EMOJIS = ['👍', '❤️', '😂', '🎉', '🔥', '🤔'];
let _selfHandRaised = false;
let _reactPopoverEl = null;

function openReactPopover() {
  if (_reactPopoverEl) return closeReactPopover();
  _reactPopoverEl = document.createElement('div');
  _reactPopoverEl.className = 'react-popover';
  _reactPopoverEl.setAttribute('role', 'menu');
  _reactPopoverEl.innerHTML = `
    <button type="button" class="react-hand ${_selfHandRaised ? 'on' : ''}" data-role="hand">
      ${icon('hand', { size: 18 })}
      <span>${_selfHandRaised ? 'Lower hand' : 'Raise hand'}</span>
    </button>
    <div class="react-row">
      ${REACT_EMOJIS.map(
        (e) => `<button type="button" class="react-emoji" data-emoji="${e}">${e}</button>`,
      ).join('')}
    </div>
  `;
  // Anchor above the React button.
  const btn = $('react-btn');
  document.body.appendChild(_reactPopoverEl);
  const r = btn.getBoundingClientRect();
  const pw = _reactPopoverEl.offsetWidth;
  _reactPopoverEl.style.left = Math.max(8, Math.min(window.innerWidth - pw - 8, r.left + r.width / 2 - pw / 2)) + 'px';
  _reactPopoverEl.style.top = r.top - _reactPopoverEl.offsetHeight - 10 + 'px';
  btn.setAttribute('aria-expanded', 'true');

  _reactPopoverEl.addEventListener('click', (e) => {
    const hand = e.target.closest('.react-hand');
    if (hand) {
      toggleHand();
      closeReactPopover();
      return;
    }
    const em = e.target.closest('.react-emoji');
    if (em) {
      sendReaction(em.dataset.emoji);
      closeReactPopover();
    }
  });
  setTimeout(() => {
    document.addEventListener('click', _reactOutsideClick, { capture: true });
  }, 0);
}
function closeReactPopover() {
  if (!_reactPopoverEl) return;
  _reactPopoverEl.remove();
  _reactPopoverEl = null;
  $('react-btn')?.setAttribute('aria-expanded', 'false');
  document.removeEventListener('click', _reactOutsideClick, { capture: true });
}
function _reactOutsideClick(e) {
  if (!_reactPopoverEl) return;
  if (_reactPopoverEl.contains(e.target)) return;
  if (e.target.closest?.('#react-btn')) return;
  closeReactPopover();
}

function sendReaction(emoji) {
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: 'room:reaction', emoji }));
}
function toggleHand() {
  _selfHandRaised = !_selfHandRaised;
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'room:hand', raised: _selfHandRaised }));
  }
  // Render locally too so the user sees the badge instantly without waiting
  // for the server echo.
  self.handRaised = _selfHandRaised;
  _lastGridSig = ''; // force re-render with the new state
  renderParticipantsGrid();
  syncReactBtn();
}
function syncReactBtn() {
  const btn = $('react-btn');
  if (!btn) return;
  btn.classList.toggle('hand-up', _selfHandRaised);
  btn.setAttribute('aria-pressed', String(_selfHandRaised));
}

function onRoomReaction({ from, emoji }) {
  spawnFloatingEmoji(from, emoji);
  playSound('raise');
}
function onRoomHand({ from, raised }) {
  const peer = peers.get(from);
  if (peer) {
    peer.handRaised = !!raised;
    _lastGridSig = '';
    renderParticipantsGrid();
  }
  if (raised) playSound('raise');
}

// Spawn an emoji that floats up + fades over the sender's participant tile.
function spawnFloatingEmoji(peerId, emoji) {
  const sid = peerId === myId ? 'self' : peerId;
  const tile = _gridElById.get(sid);
  if (!tile) return;
  const span = document.createElement('span');
  span.className = 'float-emoji';
  span.textContent = emoji;
  // Random horizontal jitter so multiple in a row don't stack identically.
  const jx = Math.floor((Math.random() - 0.5) * 28);
  span.style.setProperty('--jx', jx + 'px');
  tile.appendChild(span);
  // Remove after the animation completes (1400ms).
  setTimeout(() => span.remove(), 1500);
}

// ============================================================================
// CONNECTION-QUALITY TOAST — surface real-time link degradation events.
//
// pollStats already computes per-peer RTT; this layer keeps a small rolling
// baseline and emits a toast when a peer's link degrades sharply. Throttled
// to one toast per peer per 30 seconds to avoid spam.
// ============================================================================
const _qualityState = new Map(); // peerId -> { rttSamples: [], lastToastAt: number, lossPct: 0 }
const QUAL_RTT_TRIGGER = 200; // ms absolute floor for a toast
const QUAL_RTT_RATIO = 2.2; // current must be N× the recent baseline
const QUAL_LOSS_PCT = 5; // %
const QUAL_THROTTLE_MS = 30_000;

function reportQuality(peerId, peerName, rttMs, lossPct) {
  let st = _qualityState.get(peerId);
  if (!st) {
    st = { rttSamples: [], lastToastAt: 0 };
    _qualityState.set(peerId, st);
  }
  if (typeof rttMs === 'number' && rttMs > 0) {
    st.rttSamples.push(rttMs);
    if (st.rttSamples.length > 20) st.rttSamples.shift();
  }
  const now = Date.now();
  if (now - st.lastToastAt < QUAL_THROTTLE_MS) return;
  const baseline = st.rttSamples.length >= 4
    ? st.rttSamples.slice(0, -1).reduce((a, b) => a + b, 0) / (st.rttSamples.length - 1)
    : 0;
  const rttBad = baseline > 0 && rttMs >= QUAL_RTT_TRIGGER && rttMs >= baseline * QUAL_RTT_RATIO;
  const lossBad = typeof lossPct === 'number' && lossPct >= QUAL_LOSS_PCT;
  if (rttBad || lossBad) {
    st.lastToastAt = now;
    const what = rttBad
      ? `RTT spiked to ${Math.round(rttMs)} ms (baseline ${Math.round(baseline)} ms)`
      : `${lossPct.toFixed(1)}% packet loss`;
    showToast(`${peerName || peerId.slice(0, 6)}: ${what}`, 4000);
    playSound('warn');
  }
}

function setLat(ms) {
  const el = $('lat-badge'), val = $('lat-val');
  if (ms == null) { el.className = 'lat'; val.textContent = '— ms'; return; }
  val.textContent = (ms < 1 ? '<1' : ms) + ' ms';
  el.className = 'lat ' + (ms <= 5 ? 'good' : ms <= 20 ? 'mid' : 'bad');
}
function setTopo(relay) {
  const el = $('topo-badge');
  el.className = 'topo' + (relay ? ' relay' : '');
  el.innerHTML = relay
    ? `${icon('refresh', { size: 14 })}<span class="label">Relay (TURN)</span>`
    : `${icon('link', { size: 14 })}<span class="label">Direct P2P</span>`;
}

// ============================================================================
//  UTIL + AVVIO
// ============================================================================
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// Boot: prima carico il profilo (UUID + preferences), poi i devices, poi
// applico le preferenze di device picker e setto i listener di persistenza.
(async () => {
  await loadProfile();
  await refreshDevices();
  applyPersistedDeviceSelections();
  // Salva su qualsiasi change rilevante
  $('nickname')?.addEventListener('input', () => saveProfile());
  $('mic-select')?.addEventListener('change', () => saveProfile());
  $('mic-room-select')?.addEventListener('change', () => saveProfile());
  $('out-select')?.addEventListener('change', () => saveProfile());
  $('aec-init')?.addEventListener('change', () => saveProfile());
  $('aec-toggle')?.addEventListener('click', () => setTimeout(saveProfile, 0));
  //  chat drawer
  bindChatUi();
  //  screen share toggle: when sharing -> stop, when idle -> show the share
  //  picker (screen+audio vs audio-only at 320 kbps).
  $('screen-share-btn')?.addEventListener('click', () => {
    if (screenStream) stopScreenShare();
    else openShareMenu();
  });
  //  stats panel close button
  $('stats-close')?.addEventListener('click', closeStatsPanel);
  //  camera toggle dinamico
  $('camera-btn')?.addEventListener('click', () => {
    if (cameraStream) stopCamera();
    else startCamera();
  });
  //  fix utente: test beep locale
  $('test-beep-btn')?.addEventListener('click', playTestBeep);
  //  theme switcher
  bootTheme();
  $('theme-btn')?.addEventListener('click', cycleTheme);
  //  notification sounds toggle (bell-btn in topbar)
  syncSoundBtn();
  $('sound-btn')?.addEventListener('click', () => {
    const next = !isSoundEnabled();
    setSoundEnabled(next);
    syncSoundBtn();
    if (next) playSound('tick');
  });
  //  meeting recorder toggle (record-btn in topbar)
  $('record-btn')?.addEventListener('click', toggleRecording);
  //  react popover (hand-raise + 6 emoji)
  $('react-btn')?.addEventListener('click', openReactPopover);
  //  noise gate toggle (gate-btn in topbar)
  syncGateBtn();
  $('gate-btn')?.addEventListener('click', toggleGate);
  //  view-mode toggle + speaker pinning
  setViewMode('grid');
  $('view-btn')?.addEventListener('click', cycleViewMode);
  bindVideoGridClicks();
  //  pre-join preview: mic VU + echo test
  startJoinPreview().catch(() => {
    /* mic-denied is fine; the user can still try to join */
  });
  $('echo-test-btn')?.addEventListener('click', runEchoTest);
})();

// ============================================================================
// RECORDING (topbar Record button) — local-only via MediaRecorder
//
// When clicked, mixes own mic + every peer's incoming audio + screen-share
// audio (if any) into a single WebM, including camera or screen video when
// the user is sharing. Stop -> auto-download halcyon-<timestamp>.webm.
// ============================================================================
let recTick = null;
function toggleRecording() {
  if (isRecording()) {
    stopRecording();
    syncRecordUi(false);
    if (recTick) {
      clearInterval(recTick);
      recTick = null;
    }
    announce('Recording stopped, downloading');
    playSound('tick');
    return;
  }
  const peerAudioElements = [...peers.values()].map((p) => p.audioEl).filter(Boolean);
  const started = startRecording({
    localStream,
    peerAudioElements,
    screenStream: typeof screenStream !== 'undefined' ? screenStream : null,
    videoStream: typeof cameraStream !== 'undefined' ? cameraStream : null,
  });
  if (!started) {
    showToast('Recording unavailable in this browser');
    return;
  }
  syncRecordUi(true);
  recTick = setInterval(updateRecordElapsed, 1000);
  updateRecordElapsed();
  announce('Recording started');
  playSound('tick');
}
function syncRecordUi(on) {
  const btn = $('record-btn');
  if (!btn) return;
  btn.classList.toggle('recording', on);
  btn.setAttribute('aria-pressed', String(on));
  btn.title = on ? 'Stop recording (will download)' : 'Start recording the room';
  const lbl = btn.querySelector('.record-lbl');
  if (lbl && !on) lbl.textContent = 'Record';
}
function updateRecordElapsed() {
  const btn = $('record-btn');
  if (!btn) return;
  const lbl = btn.querySelector('.record-lbl');
  if (!lbl) return;
  const ms = recordingElapsed();
  const s = Math.floor(ms / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  lbl.textContent = `${mm}:${ss}`;
}

// ============================================================================
// PRE-JOIN PREVIEW — mic VU meter + 3-second echo loopback
//
// Lets the user verify the mic works before joining a room (the single most
// common "I can't hear anything" failure mode). The preview stream is its own
// short-lived getUserMedia handle, separate from the room stream; it shuts
// down on Join so the room flow re-acquires the mic cleanly.
// ============================================================================
const joinPreview = { stream: null, ctx: null, an: null, buf: null, raf: 0 };

async function startJoinPreview() {
  if (joinPreview.stream) return;
  try {
    joinPreview.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    __ar.log.warn('[join-preview] getUserMedia rejected', e?.name);
    return;
  }
  joinPreview.ctx = new (window.AudioContext || window.webkitAudioContext)();
  const src = joinPreview.ctx.createMediaStreamSource(joinPreview.stream);
  const an = joinPreview.ctx.createAnalyser();
  an.fftSize = 256;
  an.smoothingTimeConstant = 0.5;
  src.connect(an);
  joinPreview.an = an;
  joinPreview.buf = new Uint8Array(an.frequencyBinCount);
  tickJoinVU();
}

function tickJoinVU() {
  if (!joinPreview.an) return;
  joinPreview.an.getByteTimeDomainData(joinPreview.buf);
  let sum = 0;
  for (let i = 0; i < joinPreview.buf.length; i++) {
    const v = (joinPreview.buf[i] - 128) / 128;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / joinPreview.buf.length);
  const pct = Math.min(100, rms * 280);
  const fill = $('join-vu-fill');
  if (fill) fill.style.width = pct + '%';
  joinPreview.raf = requestAnimationFrame(tickJoinVU);
}

function stopJoinPreview() {
  if (joinPreview.raf) cancelAnimationFrame(joinPreview.raf);
  joinPreview.stream?.getTracks().forEach((t) => t.stop());
  joinPreview.ctx?.close().catch(() => {});
  joinPreview.stream = null;
  joinPreview.ctx = null;
  joinPreview.an = null;
  joinPreview.buf = null;
  joinPreview.raf = 0;
}

async function runEchoTest() {
  if (!joinPreview.stream) {
    await startJoinPreview();
    if (!joinPreview.stream) return;
  }
  const btn = $('echo-test-btn');
  if (!btn) return;
  if (btn.disabled) return;
  btn.disabled = true;
  const labelSpan = btn.querySelector('span:last-child');
  const orig = labelSpan ? labelSpan.textContent : '';
  if (labelSpan) labelSpan.textContent = 'Recording 3s';
  let mr;
  try {
    mr = new MediaRecorder(joinPreview.stream);
  } catch {
    btn.disabled = false;
    if (labelSpan) labelSpan.textContent = orig;
    return;
  }
  const chunks = [];
  mr.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  mr.onstop = () => {
    if (labelSpan) labelSpan.textContent = 'Playing back';
    const blob = new Blob(chunks);
    const url = URL.createObjectURL(blob);
    const a = new Audio(url);
    a.play().catch(() => {});
    a.onended = () => {
      if (labelSpan) labelSpan.textContent = orig || 'Test mic, 3s loopback';
      btn.disabled = false;
      URL.revokeObjectURL(url);
    };
  };
  mr.start();
  setTimeout(() => {
    try {
      mr.stop();
    } catch {
      /* already stopped */
    }
  }, 3000);
}

function syncSoundBtn() {
  const btn = $('sound-btn');
  if (!btn) return;
  const on = isSoundEnabled();
  btn.classList.toggle('muted', !on);
  btn.setAttribute('aria-pressed', String(on));
  btn.title = on ? 'Mute notification sounds' : 'Enable notification sounds';
  const ico = btn.querySelector('.ico');
  if (ico) ico.innerHTML = icon(on ? 'bell' : 'bell-off', { size: 18 });
}
navigator.mediaDevices.addEventListener?.('devicechange', refreshDevices);
