// ============================================================================
// HALCYON
//  - Radar Canvas con nodi audio-reattivi
//  - Echo/feedback detection (linea di tensione rossa tra mic correlati)
//  - Latenza + topologia da getStats, AEC toggle, switch device, Opus max
//
//   (hardening): wrapper logger window.__ar.log silenziabile
//  - precedenza livello: URL ?log=debug|info|warn|error > localStorage
//    "ar:logLevel" > "info"
//  - ring buffer di 50 errori (unhandledrejection + error) in __ar.state.errors
//  - console.error nativo SOLO per errori catastrofici (boot URL fallita)
// ============================================================================

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
const self = { id: 'self', name: '', rms: 0, env: new Float32Array(ENV_LEN), speaking: false, analyser: null, ctx: null };

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

// Sostituisce lo stream locale (cambio mic o toggle AEC) senza rinegoziare
async function replaceLocalStream(newStream) {
  const newTrack = newStream.getAudioTracks()[0];
  newTrack.enabled = micEnabled;
  if (mode === 'sfu' && serverPc) {
    const s = serverPc.getSenders().find(s => s.track && s.track.kind === 'audio');
    if (s) { try { await s.replaceTrack(newTrack); } catch (e) { __ar.log.warn('replaceTrack sfu', e); } }
  } else {
    for (const peer of peers.values()) {
      if (!peer.pc) continue;
      const sender = peer.pc.getSenders().find(s => s.track && s.track.kind === 'audio');
      if (sender) { try { await sender.replaceTrack(newTrack); } catch (e) { __ar.log.warn('replaceTrack mesh peer=' + peer.name, e); } }
    }
  }
  localStream.getTracks().forEach(t => t.stop());
  localStream = newStream;
  setupSelfAnalyser();
}

// ============================================================================
//  JOIN
// ============================================================================
$('join-btn').addEventListener('click', async () => {
  const name = $('nickname').value.trim();
  if (!name) { $('join-error').textContent = 'Scrivi un nome.'; return; }
  myName = name; self.name = name;
  aecOn = $('aec-init').checked;
  //  camera non più al join, ma da control deck (#camera-btn)
  videoEnabled = false;
  $('join-btn').disabled = true; $('join-error').textContent = '';
  try {
    localStream = await acquireStream($('mic-select').value);
  } catch (err) {
    $('join-error').textContent = 'Microfono non accessibile: ' + err.message;
    $('join-btn').disabled = false; return;
  }
  setupSelfAnalyser();
  syncAecUI();
  ensureSelfVideoTile();
  connectSignaling();
  initRoomId();
  joinScreen.classList.add('hidden');
  roomScreen.classList.remove('hidden');
  resizeCanvas();
  requestAnimationFrame(tick);
  setInterval(pollStats, 1500);
});
$('nickname').addEventListener('keydown', e => { if (e.key === 'Enter') $('join-btn').click(); });

// ============================================================================
//  SIGNALING — supporta 2 modalita': 'mesh' (P2P, server Node) e
//  'sfu' (audio instradato dal server Python con DeepFilterNet)
//
//   WS reconnect con backoff esponenziale + jitter, sessionToken per
//  identificare la stessa sessione attraverso reconnect (no peer fantasma).
// ============================================================================
//  solo modalita' mesh P2P. Studio Python :8444 (SFU) deprecato.
// Manteniamo la variabile per compatibilita' con il codice esistente ma il
// client si comporta sempre come 'mesh'.
let mode = 'mesh';
const serverPc = null;        // mai usato dopo unify
let micAttached = false;      // legacy, niente piu' SFU
const midToPeer = new Map();  // legacy

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
    online: '🟢 Online', connecting: '⏳ Connessione…',
    reconnecting: '🟡 Riconnessione…', dead: '🔴 Offline', offline: '— offline',
  };
  el.textContent = TXT[s] || s;
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
        //  forziamo sempre 'mesh' lato client, ignoriamo
        // qualsiasi modalita' SFU dal server. Single port :8443.
        myId = msg.id; mode = 'mesh';
        document.body.dataset.mode = mode;
        for (const p of msg.peers) ensurePeerMesh(p.id, p.name, false);
        if (msg.resumed) __ar.log.info('welcome: sessione ripristinata id=' + msg.id);
        break;
      case 'peer-joined':
        ensurePeerMesh(msg.id, msg.name, true);
        break;
      case 'peer-renamed': { const p = peers.get(msg.id); if (p) p.name = msg.name; break; }
      case 'peer-left': removePeer(msg.id); break;
      case 'signal': await handleSignal(msg.from, msg.data); break;  // mesh
      case 'offer': await handleServerOffer(msg); break;             // sfu
      case 'levels': handleLevels(msg.levels); break;                // sfu
      case 'pong': break;                                            // keep-alive ack
      //  chat
      case 'chat:msg': onChatMessage(msg); break;
      case 'chat:history:resp': onChatHistory(msg.items || []); break;
      case 'chat:edit:ack': onChatEdited(msg); break;
      case 'chat:delete:ack': onChatDeleted(msg.msgId); break;
      case 'chat:typing': onChatTyping(msg); break;
      case 'chat:react:ack': onChatReactionUpdate(msg); break;
      case 'chat:error': __ar.log.warn('[chat]', msg.reason, msg.msgId || ''); break;
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

// In SFU il radar riceve i livelli dei peer dal server (l'audio arriva mixato,
// quindi non possiamo computare l'RMS per-peer in locale).
function handleLevels(levels) {
  if (!levels) return;
  for (const [pid, rms] of Object.entries(levels)) {
    const p = peers.get(pid); if (!p) continue;
    p.rms = rms;
    p.speaking = rms > SPEAK_TH;
  }
}
function signal(to, data) { ws.send(JSON.stringify({ type: 'signal', to, data })); }

// ---------- nodo (display + audio), comune alle due modalita' ----------
function makeNode(name) {
  return {
    name, pc: null, audioEl: null, volume: 1,
    rms: 0, env: new Float32Array(ENV_LEN), speaking: false,
    analyser: null, ctx: null,
    x: 0, y: 0, fx: Math.random() * 6.28, fy: Math.random() * 6.28,
  };
}
function ensureNode(id, name) {
  let n = peers.get(id);
  if (n) { if (name) n.name = name; return n; }
  n = makeNode(name); peers.set(id, n); return n;
}

// ============================================================================
//  WEBRTC MESH (server Node)
// ============================================================================
function ensurePeerMesh(id, name, initiator) {
  if (peers.has(id) && peers.get(id).pc) return peers.get(id);
  const peer = ensureNode(id, name);
  const pc = new RTCPeerConnection(RTC_CONFIG);
  peer.pc = pc;
  peer.isInitiator = !!initiator;
  peer.iceRestartPending = false;
  for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
  pc.addEventListener('icecandidate', e => { if (e.candidate) signal(id, { candidate: e.candidate }); });
  pc.addEventListener('track', (e) => {
    const stream = e.streams[0] || new MediaStream([e.track]);
    if (e.track.kind === 'video') attachRemoteVideo(id, stream);
    else attachRemoteAudio(id, stream);
  });
  //  su failed l'initiator triggera ICE restart. Il non-initiator
  // attende: la sua negotiationneeded scattera dopo che l'altro lato emette
  // la nuova offer con iceRestart. Su 'disconnected' aspettiamo 5s: spesso
  // si riprende da solo (mobility transient), altrimenti escaliamo a failed.
  pc.addEventListener('connectionstatechange', () => {
    const st = pc.connectionState;
    __ar.log.debug(`peer=${id} conn=${st}`);
    if (st === 'failed') tryIceRestart(peer, id);
    else if (st === 'disconnected') {
      setTimeout(() => { if (pc.connectionState === 'disconnected') tryIceRestart(peer, id); }, 5000);
    }
  });
  pc.addEventListener('iceconnectionstatechange', () => __ar.log.debug(`peer=${id} ice=${pc.iceConnectionState}`));
  if (initiator) {
    pc.addEventListener('negotiationneeded', async () => {
      try {
        // Se siamo qui per un ICE restart, createOffer({iceRestart:true}) e'
        // gia stato chiamato manualmente -> NON rilanciare: leggiamo solo lo
        // stato corrente e propaghiamo. Altrimenti negoziazione standard.
        if (peer.iceRestartPending) { peer.iceRestartPending = false; return; }
        const o = await pc.createOffer();
        await pc.setLocalDescription(tuneOpus(o));
        signal(id, { sdp: pc.localDescription });
      } catch (e) { __ar.log.error(`createOffer peer=${id}`, e); }
    });
  }
  return peer;
}

//  ICE restart helper. Initiator-side: pc.restartIce() triggera
// negotiationneeded che noi intercettiamo per inviare un offer con
// a=ice-ufrag/pwd nuovi. Non-initiator-side: nessun-op (attende).
async function tryIceRestart(peer, id) {
  if (!peer || !peer.pc) return;
  if (!peer.isInitiator) {
    __ar.log.warn(`peer=${id} failed: non sono initiator, attendo offer`);
    return;
  }
  if (peer.iceRestartPending) return;
  peer.iceRestartPending = true;
  try {
    if (typeof peer.pc.restartIce === 'function') {
      peer.pc.restartIce();
      // restartIce() innesca negotiationneeded async che fara' la nuova offer
      // -- usiamo manualmente createOffer per garantire iceRestart:true.
      const o = await peer.pc.createOffer({ iceRestart: true });
      await peer.pc.setLocalDescription(tuneOpus(o));
    } else {
      const o = await peer.pc.createOffer({ iceRestart: true });
      await peer.pc.setLocalDescription(tuneOpus(o));
    }
    signal(id, { sdp: peer.pc.localDescription });
    __ar.log.info(`peer=${id} ICE restart inviato`);
  } catch (e) {
    __ar.log.error(`peer=${id} ICE restart fallito`, e);
    peer.iceRestartPending = false;
  }
}
async function handleSignal(from, data) {
  const peer = peers.get(from); if (!peer || !peer.pc) return;
  const pc = peer.pc;
  if (data.sdp) {
    await pc.setRemoteDescription(data.sdp);
    if (data.sdp.type === 'offer') {
      const a = await pc.createAnswer(); await pc.setLocalDescription(tuneOpus(a));
      maximizeBitrate(pc); signal(from, { sdp: pc.localDescription });
    } else { maximizeBitrate(pc); }
  } else if (data.candidate) {
    try { await pc.addIceCandidate(data.candidate); } catch (e) { __ar.log.warn(`addIceCandidate peer=${from}`, e); }
  }
}

// ============================================================================
//  WEBRTC SFU/STUDIO (server Python + DeepFilterNet) — server e' l'offerer
// ============================================================================
let mixAudioEl = null;
let mixAnalyser = null;
let mixAnalyserBuf = null;
let mixAudioCtx = null;
function attachMixAudio(stream) {
  if (!mixAudioEl) {
    mixAudioEl = document.createElement('audio');
    mixAudioEl.autoplay = true;
    mixAudioEl.playsInline = true;
    document.body.appendChild(mixAudioEl);
  }
  mixAudioEl.srcObject = stream;
  mixAudioEl.volume = deafened ? 0 : 1;
  if (outputSinkId && mixAudioEl.setSinkId) mixAudioEl.setSinkId(outputSinkId).catch(() => {});
  tryPlayAudio(mixAudioEl, '[mix]');
  __ar.log.info('[mix] audio studio agganciato, tracks=' + stream.getAudioTracks().length);
  //  fix utente: setup VU meter del mix per diagnostica visiva.
  // L'utente VEDE se l'audio sta arrivando anche se non lo sente (problema
  // output device, volume sistema, deafen attivo, etc.).
  try {
    if (mixAudioCtx) mixAudioCtx.close().catch(() => {});
    mixAudioCtx = new AudioContext();
    const src = mixAudioCtx.createMediaStreamSource(stream);
    mixAnalyser = mixAudioCtx.createAnalyser();
    mixAnalyser.fftSize = 512;
    src.connect(mixAnalyser);
    mixAnalyserBuf = new Uint8Array(mixAnalyser.frequencyBinCount);
  } catch (e) { __ar.log.warn('[mix] VU analyser setup failed', e); }
}

//  fix utente: aggiorna VU meter del mix ogni frame (chiamato dal tick).
function updateMixVu() {
  if (!mixAnalyser || !mixAnalyserBuf) return;
  mixAnalyser.getByteTimeDomainData(mixAnalyserBuf);
  let sum = 0;
  for (let i = 0; i < mixAnalyserBuf.length; i++) {
    const v = (mixAnalyserBuf[i] - 128) / 128;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / mixAnalyserBuf.length);
  const fill = $('mix-vu-fill');
  if (fill) fill.style.width = Math.min(100, rms * 280) + '%';
}

//  fix utente: beep locale per verificare il device audio del browser.
// Suono 880Hz sine wave 200ms, indipendente dalla pipeline WebRTC.
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
function hideAudioGate() { const gate = $('audio-gate'); if (gate) gate.classList.add('hidden'); }

function createServerPc() {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  pc.addEventListener('track', e => {
    const mid = e.transceiver && e.transceiver.mid;
    const pid = midToPeer.get(mid);
    if (!pid) return;
    const stream = e.streams[0] || new MediaStream([e.track]);
    if (pid === '__mix__') attachMixAudio(stream);
    else attachRemoteAudio(pid, stream);
  });
  pc.addEventListener('connectionstatechange', () => {
    const st = pc.connectionState;
    __ar.log.debug('[sfu] conn=' + st);
    if (st === 'failed') {
      //  il server e' offerer in SFU. Segnaliamo via WS; se entro 8s
      // non riceviamo nuova offer, distruggiamo serverPc e attendiamo. Il
      // supporto server-side completo per ICE restart e' sub- (Python).
      __ar.log.warn('[sfu] connessione PC fallita, chiedo ICE restart al server');
      try {
        if (ws && ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'ice-restart-request' }));
        }
      } catch {}
      setTimeout(() => {
        if (serverPc === pc && pc.connectionState === 'failed') {
          __ar.log.warn('[sfu] nessuna risposta a ice-restart-request, riavvio sessione');
          try { pc.close(); } catch {}
          serverPc = null;
          micAttached = false;
          midToPeer.clear();
          // forziamo il path di reconnect WS che si tira dietro un nuovo offer
          if (ws && ws.readyState === 1) { try { ws.close(); } catch {} }
        }
      }, 8000);
    }
  });
  pc.addEventListener('iceconnectionstatechange', () => __ar.log.debug('[sfu] ice=' + pc.iceConnectionState));
  return pc;
}
async function handleServerOffer(msg) {
  if (!serverPc) serverPc = createServerPc();
  const pc = serverPc;
  for (const tk of (msg.tracks || [])) {
    midToPeer.set(tk.mid, tk.peerId);
    if (tk.peerId !== '__mix__') ensureNode(tk.peerId, tk.name);
  }
  await pc.setRemoteDescription(msg.sdp);
  // aggancia il microfono al transceiver indicato dal server
  if (msg.micMid && !micAttached) {
    const t = pc.getTransceivers().find(tr => tr.mid === msg.micMid);
    if (t) {
      try { t.direction = 'sendonly'; } catch {}
      await t.sender.replaceTrack(localStream.getAudioTracks()[0]);
      maximizeBitrate(pc);
      micAttached = true;
    }
  }
  const ans = await pc.createAnswer();
  await pc.setLocalDescription(tuneOpus(ans));
  await waitIce(pc);
  ws.send(JSON.stringify({ type: 'answer', sdp: { sdp: pc.localDescription.sdp, type: pc.localDescription.type } }));
}
function waitIce(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise(res => {
    const check = () => { if (pc.iceGatheringState === 'complete') { pc.removeEventListener('icegatheringstatechange', check); res(); } };
    pc.addEventListener('icegatheringstatechange', check);
    setTimeout(res, 2500);
  });
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
  for (const sender of pc.getSenders()) {
    if (!sender.track || sender.track.kind !== 'audio') continue;
    const p = sender.getParameters(); if (!p.encodings) p.encodings = [{}];
    p.encodings[0].maxBitrate = 510000;
    try { await sender.setParameters(p); } catch {}
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
  const peer = peers.get(id); if (!peer) return;
  if (peer.pc) { try { peer.pc.close(); } catch {} }
  if (peer.audioEl) peer.audioEl.remove();
  if (peer.videoEl) peer.videoEl.parentElement?.remove(); // tile container ()
  if (peer.ctx) peer.ctx.close().catch(() => {});
  for (const [mid, pid] of midToPeer) if (pid === id) midToPeer.delete(mid);
  peers.delete(id);
  refreshVideoGridVisibility();
}

// +15: video grid management. Tile 16:9 nativo per match 1080p stream.
// L'audio dello screen share remoto va al normale audio el del peer (NON sul
// video element, che resta muted per evitare doppia riproduzione).
function attachRemoteVideo(id, stream) {
  const peer = peers.get(id); if (!peer) return;
  const grid = $('video-grid'); if (!grid) return;
  let tile = peer.videoTile;
  if (!tile) {
    tile = document.createElement('div');
    tile.className = 'video-tile';
    tile.dataset.peerId = id;
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
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
  peer.videoEl.play().catch((e) => __ar.log.warn('[video] play()', e.name));
  refreshVideoGridVisibility();
}

function refreshVideoGridVisibility() {
  const grid = $('video-grid');
  if (!grid) return;
  const hasTiles = grid.querySelector('.video-tile, .video-tile-self');
  if (hasTiles) grid.classList.remove('hidden');
  else grid.classList.add('hidden');
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
  label.textContent = myName + ' (tu)';
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
  const an = ctx.createAnalyser(); an.fftSize = 512;
  an.smoothingTimeConstant = 0.7; //  smussa la FFT viz
  src.connect(an);
  target.ctx = ctx; target.analyser = an;
  target._buf = new Uint8Array(an.frequencyBinCount);
  target._freq = new Uint8Array(an.frequencyBinCount);
  //  3 satelliti orbitanti con fasi sfalsate, velocita' base
  if (!target._orbitPhases) target._orbitPhases = [0, 2.094, 4.188];
}
function setupSelfAnalyser() { setupAnalyser(self, localStream); }

function sampleRms(node) {
  if (!node.analyser) return 0;
  node.analyser.getByteTimeDomainData(node._buf);
  //  FFT per visualization tangenziale
  if (node._freq) node.analyser.getByteFrequencyData(node._freq);
  let sum = 0; const b = node._buf;
  for (let i = 0; i < b.length; i++) { const v = (b[i] - 128) / 128; sum += v * v; }
  const rms = Math.sqrt(sum / b.length);
  node.rms = rms;
  node.env.copyWithin(0, 1); node.env[ENV_LEN - 1] = rms; // shift + push
  const nowSpeaking = rms > SPEAK_TH;
  //  detect transizione idle→speak per emit shockwave
  if (nowSpeaking && !node.speaking) node._shockT = performance.now();
  node.speaking = nowSpeaking;
  return rms;
}

// ============================================================================
//  PARTICIPANTS GRID () — render via DOM, niente canvas/radar.
//  Layout Discord/Zoom-like: tile per ogni partecipante, glow verde quando
//  parla, hover = popover volume/silenzia (riusa openPeerPopover/Self esistenti).
// ============================================================================
let lastT = 0;
let _lastGridSig = '';

function renderParticipantsGrid() {
  const grid = $('participants-grid');
  if (!grid) return;
  const all = [self, ...peers.values()];
  // signature minima per detect change (evita innerHTML thrash ogni frame)
  let sig = '';
  for (const n of all) {
    const isSelf = n === self;
    const muted = isSelf && !micEnabled;
    sig += (isSelf ? 'S' : n.id || '?') + '|' + (n.name || '') + '|' + (n.speaking && !muted ? 's' : '.') + (muted ? 'm' : '.') + ';';
  }
  if (sig !== _lastGridSig) {
    _lastGridSig = sig;
    grid.innerHTML = all
      .map((n) => {
        const isSelf = n === self;
        const muted = isSelf && !micEnabled;
        const speaking = n.speaking && !muted;
        const name = isSelf ? myName + ' (tu)' : n.name || '?';
        const init = initials(name);
        const cls = ['participant'];
        if (isSelf) cls.push('self');
        if (speaking) cls.push('speaking');
        if (muted) cls.push('muted');
        const sid = isSelf ? 'self' : n.id;
        return `<div class="${cls.join(' ')}" data-pid="${escapeHtml(String(sid))}">
          <div class="participant-avatar"><span>${escapeHtml(init)}</span></div>
          <div class="participant-name">${escapeHtml(name)}</div>
          ${muted ? '<div class="participant-badge">🔇</div>' : speaking ? '<div class="participant-badge speak-badge">🎙</div>' : ''}
        </div>`;
      })
      .join('');
  }
  // Aggiorna SOLO la "intensità" speaking via CSS var (no re-render DOM)
  for (const n of all) {
    const isSelf = n === self;
    const sid = isSelf ? 'self' : n.id;
    const el = grid.querySelector(`[data-pid="${sid}"]`);
    if (el) el.style.setProperty('--rms', String(Math.min(1, (n.rms || 0) * 3)));
  }
}

function resizeCanvas() {
  /*  no-op, niente piu' canvas */
}

function _unusedInitStars_pivot16() {
  return; }
function _legacyInitStars_pivot16() {
  const n = Math.round((W * H) / 6000);  // densita' ~ area
  stars = [];
  for (let i = 0; i < n; i++) {
    stars.push({
      x: Math.random() * W,
      y: Math.random() * H,
      z: 0.25 + Math.random() * 0.75,
      tw: Math.random() * 6.28,
    });
  }
}
/*  resize handler non più necessario senza canvas */

function nodeList() { return [self, ...peers.values()]; }

function layout(t) {
  const cx = W / 2, cy = H / 2;
  const R = Math.min(W, H) * 0.31;
  const others = [...peers.values()];
  self.x = cx + Math.sin(t * 0.0006 + self_fx) * 6;
  self.y = cy + Math.cos(t * 0.0005 + self_fy) * 6;
  others.forEach((p, i) => {
    const ang = (i / Math.max(1, others.length)) * Math.PI * 2 - Math.PI / 2;
    p.x = cx + Math.cos(ang) * R + Math.sin(t * 0.0007 + p.fx) * 10;
    p.y = cy + Math.sin(ang) * R + Math.cos(t * 0.0006 + p.fy) * 10;
  });
}
const self_fx = Math.random() * 6.28, self_fy = Math.random() * 6.28;

function drawStars(t) {
  // parallax: stelle "lontane" (z piccola) si muovono pochissimo, vicine di piu'
  ctx2d.save();
  for (const s of stars) {
    // drift orizzontale lento proporzionale a z (depth)
    const dx = ((s.x + t * 0.012 * s.z) % (W + 20)) - 10;
    const dy = s.y + Math.sin(t * 0.0006 + s.tw) * 0.3;
    // twinkle
    const tw = 0.5 + 0.5 * Math.sin(t * 0.002 + s.tw * 3);
    const a = (0.25 + 0.75 * s.z) * (0.45 + 0.55 * tw);
    const r = 0.4 + 1.2 * s.z;
    ctx2d.beginPath(); ctx2d.arc(dx, dy, r, 0, 7);
    ctx2d.fillStyle = `rgba(${200 + Math.round(55 * s.z)},${210 + Math.round(40 * s.z)},255,${a})`;
    ctx2d.fill();
    // alone leggero sulle stelle piu' vicine
    if (s.z > 0.85 && tw > 0.7) {
      ctx2d.beginPath(); ctx2d.arc(dx, dy, r * 4, 0, 7);
      ctx2d.fillStyle = `rgba(180,200,255,${0.04 * tw})`;
      ctx2d.fill();
    }
  }
  ctx2d.restore();
}

function drawRadarBg(t) {
  const cx = W / 2, cy = H / 2, maxR = Math.min(W, H) * 0.46;

  // 1) Aura centrale profonda: gradiente radiale che "scava" la profondita'
  const deep = ctx2d.createRadialGradient(cx, cy, 0, cx, cy, maxR * 1.3);
  deep.addColorStop(0,    'rgba(40, 80, 160, 0.18)');
  deep.addColorStop(0.35, 'rgba(20, 30, 80,  0.10)');
  deep.addColorStop(1,    'rgba(0,  0,  0,   0)');
  ctx2d.fillStyle = deep;
  ctx2d.fillRect(0, 0, W, H);

  // 2) Anelli concentrici con dissolvenza dal centro (effetto orizzonte)
  ctx2d.save();
  for (let i = 1; i <= 6; i++) {
    const r = (maxR / 6) * i;
    const a = 0.12 * (1 - i / 7);
    ctx2d.strokeStyle = `rgba(180, 210, 255, ${a})`;
    ctx2d.lineWidth = 1;
    ctx2d.beginPath(); ctx2d.arc(cx, cy, r, 0, 7); ctx2d.stroke();
  }
  ctx2d.restore();

  // 3) Crosshair sottilissima
  ctx2d.save();
  ctx2d.strokeStyle = 'rgba(180,210,255,0.06)'; ctx2d.lineWidth = 1;
  ctx2d.beginPath(); ctx2d.moveTo(cx - maxR, cy); ctx2d.lineTo(cx + maxR, cy);
  ctx2d.moveTo(cx, cy - maxR); ctx2d.lineTo(cx, cy + maxR); ctx2d.stroke();
  ctx2d.restore();

  // 4) Scan beam volumetrico (conic gradient: bagliore concentrato + scia)
  const ang = (t * 0.0008) % (Math.PI * 2);
  if (ctx2d.createConicGradient) {
    const g = ctx2d.createConicGradient(ang - Math.PI / 2, cx, cy);
    g.addColorStop(0,    'rgba(120, 180, 255, 0.00)');
    g.addColorStop(0.02, 'rgba(120, 180, 255, 0.32)');
    g.addColorStop(0.08, 'rgba(106, 163, 255, 0.08)');
    g.addColorStop(0.20, 'rgba(106, 163, 255, 0.00)');
    g.addColorStop(1,    'rgba(0,   0,   0,   0)');
    ctx2d.fillStyle = g;
    ctx2d.beginPath(); ctx2d.arc(cx, cy, maxR, 0, 7); ctx2d.fill();
  }

  // 5) Punto focale brillante al centro (origine del radar)
  const core = ctx2d.createRadialGradient(cx, cy, 0, cx, cy, 30);
  core.addColorStop(0, 'rgba(180,220,255,0.35)');
  core.addColorStop(1, 'rgba(180,220,255,0)');
  ctx2d.fillStyle = core;
  ctx2d.beginPath(); ctx2d.arc(cx, cy, 30, 0, 7); ctx2d.fill();
}

// ----- Particelle audio-reattive che emanano dai nodi che parlano -----
function spawnParticles(node, intensity) {
  // ~0..3 particelle per frame in base all'intensita' (RMS)
  const n = Math.min(3, Math.floor(intensity * 14));
  for (let i = 0; i < n; i++) {
    const ang = Math.random() * Math.PI * 2;
    const sp = 0.4 + Math.random() * 0.9 + intensity * 1.8;
    particles.push({
      x: node.x + Math.cos(ang) * 6,
      y: node.y + Math.sin(ang) * 6,
      vx: Math.cos(ang) * sp,
      vy: Math.sin(ang) * sp,
      life: 0,
      max: 60 + Math.random() * 40,
      hue: 150 + Math.random() * 50,        // verde-acqua
    });
  }
  if (particles.length > 600) particles.splice(0, particles.length - 600);
}

function updateAndDrawParticles(dt) {
  ctx2d.save();
  ctx2d.globalCompositeOperation = 'lighter';
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life += dt;
    if (p.life >= p.max) { particles.splice(i, 1); continue; }
    p.x += p.vx; p.y += p.vy;
    p.vx *= 0.985; p.vy *= 0.985;
    const a = (1 - p.life / p.max);
    ctx2d.fillStyle = `hsla(${p.hue}, 90%, 70%, ${a * 0.55})`;
    ctx2d.beginPath(); ctx2d.arc(p.x, p.y, 1.6 * a + 0.5, 0, 7); ctx2d.fill();
  }
  ctx2d.restore();
}

//  HALCYON: nodo spaziale a strati. Z-order:
//   1) shockwave (onda d'urto su transizione idle->speak, dietro tutto)
//   2) aura radiale (alone gravitazionale)
//   3) satelliti orbitanti dietro
//   4) corpo: gradient + scanline olografica + iridescent border
//   5) satelliti orbitanti davanti
//   6) FFT visualization tangenziale (32 bin)
//   7) highlight specular + iniziali + nome
function drawNode(node, t, isSelf) {
  const muted = isSelf && !micEnabled;
  const base = isSelf ? 38 : 32;
  const r = muted ? base * 0.82 : base;
  const speak = node.speaking && !muted;
  const cx = node.x, cy = node.y;
  const wallNow = performance.now();

  // === Idle pulse (anche se non parla, mini-respiro 4s) =====================
  const idleBreath = 1 + 0.04 * Math.sin(t * 0.0014 + (node.fx || 0));
  const rEff = r * idleBreath;

  // === 1. Shockwave su transizione idle->speak =============================
  if (node._shockT && !muted) {
    const age = wallNow - node._shockT;
    if (age >= 0 && age < 700) {
      const k = age / 700;
      const sr = rEff + k * (90 + (node.rms || 0) * 120);
      ctx2d.save();
      ctx2d.lineWidth = 2.5 * (1 - k);
      ctx2d.strokeStyle = `rgba(120,255,200,${(1 - k) * 0.7})`;
      ctx2d.beginPath(); ctx2d.arc(cx, cy, sr, 0, 7); ctx2d.stroke();
      ctx2d.restore();
    } else if (age >= 700) {
      node._shockT = null;
    }
  }

  // === anelli waveform pulsanti (speak only) ===============================
  if (speak) {
    for (let k = 0; k < 3; k++) {
      const phase = ((t * 0.0016 + k / 3) % 1);
      const rr = rEff + 6 + phase * (24 + node.rms * 90);
      ctx2d.beginPath(); ctx2d.arc(cx, cy, rr, 0, 7);
      ctx2d.strokeStyle = `rgba(54,211,153,${(1 - phase) * 0.5})`;
      ctx2d.lineWidth = 2; ctx2d.stroke();
    }
  } else if (muted) {
    ctx2d.beginPath(); ctx2d.arc(cx, cy, rEff + 10, 0, 7);
    ctx2d.strokeStyle = 'rgba(255,255,255,0.08)'; ctx2d.setLineDash([4, 6]); ctx2d.lineWidth = 1.5;
    ctx2d.stroke(); ctx2d.setLineDash([]);
  }

  // === 2. Aura radiale gravitazionale ======================================
  const auraR = rEff * 3.0;
  const aura = ctx2d.createRadialGradient(cx, cy, rEff * 0.6, cx, cy, auraR);
  if (speak) { aura.addColorStop(0, 'rgba(54,211,153,0.38)'); aura.addColorStop(1, 'rgba(54,211,153,0)'); }
  else if (muted) { aura.addColorStop(0, 'rgba(120,130,160,0.10)'); aura.addColorStop(1, 'rgba(120,130,160,0)'); }
  else { aura.addColorStop(0, 'rgba(120,160,240,0.20)'); aura.addColorStop(1, 'rgba(120,160,240,0)'); }
  ctx2d.fillStyle = aura;
  ctx2d.beginPath(); ctx2d.arc(cx, cy, auraR, 0, 7); ctx2d.fill();

  // === 3. Satelliti orbitanti dietro =======================================
  // 3 piccole sfere che orbitano. Quando parla, le orbite si espandono e
  // accelerano leggermente; idle hanno raggio piu' contenuto.
  const orbitR = rEff * (speak ? 1.55 : 1.35);
  const orbitSpeed = speak ? 0.0024 : 0.0011;
  const phases = node._orbitPhases || [0, 2.094, 4.188];
  ctx2d.save();
  ctx2d.globalCompositeOperation = 'lighter';
  for (let i = 0; i < phases.length; i++) {
    const ang = phases[i] + t * orbitSpeed * (i % 2 === 0 ? 1 : -0.7);
    const ox = cx + Math.cos(ang) * orbitR;
    const oy = cy + Math.sin(ang) * orbitR * 0.55; // ellittica per profondita'
    const behind = Math.sin(ang) < 0; // dietro se la y normalizzata e' negativa
    if (!behind) continue;
    const sr = 2 + (node.rms || 0) * 6;
    const hue = speak ? 150 + i * 18 : 200 + i * 22;
    ctx2d.fillStyle = `hsla(${hue}, 90%, 70%, 0.7)`;
    ctx2d.beginPath(); ctx2d.arc(ox, oy, sr, 0, 7); ctx2d.fill();
  }
  ctx2d.restore();

  // === 4a. Corpo con gradient ==============================================
  const grad = ctx2d.createLinearGradient(cx - rEff, cy - rEff, cx + rEff, cy + rEff);
  if (muted) { grad.addColorStop(0, '#3a3f52'); grad.addColorStop(1, '#272b3a'); }
  else if (speak) { grad.addColorStop(0, '#43e3ad'); grad.addColorStop(1, '#2bb6cf'); }
  else { grad.addColorStop(0, 'rgba(106,163,255,0.92)'); grad.addColorStop(1, 'rgba(176,108,255,0.92)'); }
  ctx2d.save();
  ctx2d.shadowColor = speak ? 'rgba(54,211,153,0.95)' : 'rgba(106,163,255,0.5)';
  ctx2d.shadowBlur = speak ? 32 : 14;
  ctx2d.beginPath(); ctx2d.arc(cx, cy, rEff, 0, 7); ctx2d.fillStyle = grad; ctx2d.fill();
  ctx2d.restore();

  // === 4b. Scanline olografica interna (cyberpunk vibe) ====================
  // Clip al cerchio e disegna una linea orizzontale sottile che si muove
  // verticalmente. Si attenua quando muto.
  if (!muted) {
    ctx2d.save();
    ctx2d.beginPath(); ctx2d.arc(cx, cy, rEff, 0, 7); ctx2d.clip();
    const scanY = cy - rEff + ((t * 0.06 + (node.fx || 0) * 60) % (rEff * 2));
    const grd = ctx2d.createLinearGradient(0, scanY - 1, 0, scanY + 2);
    grd.addColorStop(0, 'rgba(255,255,255,0)');
    grd.addColorStop(0.5, speak ? 'rgba(220,255,235,0.65)' : 'rgba(220,235,255,0.55)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    ctx2d.fillStyle = grd;
    ctx2d.fillRect(cx - rEff, scanY - 1, rEff * 2, 3);
    ctx2d.restore();
  }

  // === 4c. Bordo iridescente animato (HSL drift) ===========================
  if (!muted) {
    const hueShift = (t * 0.06 + (node.fx || 0) * 60) % 360;
    ctx2d.save();
    ctx2d.lineWidth = 1.5;
    ctx2d.strokeStyle = speak
      ? `hsla(${150 + ((hueShift) % 40)}, 90%, 70%, 0.85)`
      : `hsla(${200 + ((hueShift) % 80)}, 80%, 72%, 0.6)`;
    ctx2d.beginPath(); ctx2d.arc(cx, cy, rEff + 0.5, 0, 7); ctx2d.stroke();
    ctx2d.restore();
  }

  // === 5. Satelliti orbitanti davanti ======================================
  ctx2d.save();
  ctx2d.globalCompositeOperation = 'lighter';
  for (let i = 0; i < phases.length; i++) {
    const ang = phases[i] + t * orbitSpeed * (i % 2 === 0 ? 1 : -0.7);
    const ox = cx + Math.cos(ang) * orbitR;
    const oy = cy + Math.sin(ang) * orbitR * 0.55;
    const front = Math.sin(ang) >= 0;
    if (!front) continue;
    const sr = 2 + (node.rms || 0) * 6;
    const hue = speak ? 150 + i * 18 : 200 + i * 22;
    ctx2d.shadowColor = `hsla(${hue}, 90%, 70%, 0.9)`;
    ctx2d.shadowBlur = 8;
    ctx2d.fillStyle = `hsla(${hue}, 90%, 75%, 0.95)`;
    ctx2d.beginPath(); ctx2d.arc(ox, oy, sr, 0, 7); ctx2d.fill();
  }
  ctx2d.restore();

  // === 6. FFT visualization tangenziale (32 bin) ===========================
  if (node._freq && !muted) {
    const N = 32;
    const innerR = rEff + 5;
    const minBar = 1.2;
    const maxBar = 22;
    ctx2d.save();
    for (let i = 0; i < N; i++) {
      // Saltiamo le frequenze sub-bass (rumore costante) usando offset 2
      const v = node._freq[i + 2] / 255;
      if (v < 0.05) continue;
      const ang = (i / N) * Math.PI * 2 - Math.PI / 2;
      const lo = innerR;
      const hi = innerR + minBar + v * maxBar;
      const x1 = cx + Math.cos(ang) * lo;
      const y1 = cy + Math.sin(ang) * lo;
      const x2 = cx + Math.cos(ang) * hi;
      const y2 = cy + Math.sin(ang) * hi;
      const hue = speak ? 150 + i * 4 : 200 + i * 3;
      ctx2d.strokeStyle = `hsla(${hue}, 95%, ${60 + v * 20}%, ${0.4 + v * 0.5})`;
      ctx2d.lineWidth = 2;
      ctx2d.beginPath(); ctx2d.moveTo(x1, y1); ctx2d.lineTo(x2, y2); ctx2d.stroke();
    }
    ctx2d.restore();
  }

  // === 7. Highlight specular + bordo self + testo ==========================
  const sphere = ctx2d.createRadialGradient(cx - rEff * 0.35, cy - rEff * 0.45, 0, cx - rEff * 0.35, cy - rEff * 0.45, rEff * 0.9);
  sphere.addColorStop(0, 'rgba(255,255,255,0.35)');
  sphere.addColorStop(1, 'rgba(255,255,255,0)');
  ctx2d.fillStyle = sphere;
  ctx2d.beginPath(); ctx2d.arc(cx, cy, rEff, 0, 7); ctx2d.fill();

  if (isSelf) {
    ctx2d.beginPath(); ctx2d.arc(cx, cy, rEff, 0, 7);
    ctx2d.strokeStyle = 'rgba(255,255,255,0.55)'; ctx2d.lineWidth = 2; ctx2d.stroke();
  }

  // Iniziali con leggera ombra per profondita'
  ctx2d.save();
  ctx2d.fillStyle = muted ? '#9aa0b8' : (speak ? '#06291c' : '#fff');
  ctx2d.font = `800 ${Math.round(rEff * 0.55)}px system-ui`;
  ctx2d.textAlign = 'center'; ctx2d.textBaseline = 'middle';
  ctx2d.shadowColor = 'rgba(0,0,0,0.45)';
  ctx2d.shadowBlur = 2;
  ctx2d.fillText(initials(isSelf ? myName : node.name), cx, cy);
  ctx2d.restore();

  // Nome con badge underline iridescente
  ctx2d.fillStyle = 'rgba(255,255,255,0.9)';
  ctx2d.font = '600 13px system-ui';
  ctx2d.textAlign = 'center'; ctx2d.textBaseline = 'middle';
  ctx2d.fillText((isSelf ? myName + ' (tu)' : node.name), cx, cy + rEff + 16);

  if (muted) {
    ctx2d.fillStyle = 'rgba(255,77,109,0.95)';
    ctx2d.font = '600 11px system-ui';
    ctx2d.fillText('🔇 muto', cx, cy + rEff + 32);
  }

  node._screenR = rEff; // per hit-test
}

function tick(t) {
  lastT = t;
  trackFps(t);
  updateMixVu();
  sampleRms(self);
  for (const p of peers.values()) sampleRms(p);
  // LED meter input
  const pct = Math.min(100, self.rms * 280) * (micEnabled ? 1 : 0);
  const meter = $('self-meter');
  if (meter) meter.style.width = pct + '%';
  // Render DOM grid partecipanti
  renderParticipantsGrid();
  requestAnimationFrame(tick);
}

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
    <div class="row"><span>🔈</span><input type="range" min="0" max="200" value="${Math.round(peer.volume * 100)}"></div>
    <button class="pbtn danger">Silenzia questo utente</button>`;
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
  po.innerHTML = `<h4>Il tuo nome</h4>
    <input type="text" maxlength="32" value="${escapeHtml(myName)}">
    <button class="pbtn">Salva</button>`;
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
  localStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
  $('mute-btn').classList.toggle('off', !micEnabled);
  $('mute-btn').classList.toggle('live', micEnabled);
  $('mute-btn').querySelector('.ico').textContent = micEnabled ? '🎙' : '🔇';
});
$('deafen-btn').addEventListener('click', () => {
  deafened = !deafened;
  for (const p of peers.values()) if (p.audioEl) p.audioEl.volume = deafened ? 0 : p.volume;
  if (mixAudioEl) mixAudioEl.volume = deafened ? 0 : 1;
  $('deafen-btn').classList.toggle('off', deafened);
  $('deafen-btn').querySelector('.ico').textContent = deafened ? '🔇' : '🔊';
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
  if (mixAudioEl?.setSinkId) mixAudioEl.setSinkId(outputSinkId).catch(() => {});
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
  const targets =
    mode === 'sfu' && serverPc
      ? [{ pc: serverPc, peerId: '__sfu__' }]
      : [...peers.values()].filter((p) => p.pc).map((p) => ({ pc: p.pc, peerId: p.id }));
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
  label.textContent = myName + ' (tu)';
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
  btn.querySelector('.ico').textContent = active ? '🛑' : '📹';
  btn.title = active ? 'Spegni camera' : 'Attiva camera (mesh P2P)';
}

// ============================================================================
//  ALONE-IN-ROOM HINT ( fix utente) — mostra "sei solo qui" quando
//  peers vuoto: cosi' l'utente sa che il silenzio in mix N-1 e' atteso.
// ============================================================================
function updateAloneBadge() {
  const b = $('alone-badge');
  if (!b) return;
  // peers = altri utenti (escluso self). Se 0, sono solo nella stanza.
  if (peers.size === 0 && mode) b.classList.remove('hidden');
  else b.classList.add('hidden');
}
setInterval(updateAloneBadge, 1000);

// ============================================================================
//  SCREEN SHARING () — mesh P2P only
// ============================================================================
let screenStream = null;
let screenSenders = []; // [{peerId, sender, pc, kind}]

async function startScreenShare() {
  if (screenStream) { return stopScreenShare(); }
  //  1080p60 + audio capture (tab/system audio). Chrome chiede al
  // utente se condividere anche l'audio della tab/monitor.
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { ...VIDEO_PROFILE_HQ, displaySurface: 'monitor' },
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: 48000,
      },
    });
  } catch (e) {
    __ar.log.warn('[screen] getDisplayMedia rejected', e.name);
    return;
  }
  const videoTrack = screenStream.getVideoTracks()[0];
  const audioTrack = screenStream.getAudioTracks()[0];
  if (!videoTrack) return;
  const vs = videoTrack.getSettings?.() || {};
  __ar.log.info(
    `[screen] acquisito ${vs.width}x${vs.height}@${vs.frameRate}fps, audio=${audioTrack ? 'sì' : 'no'}`,
  );
  videoTrack.addEventListener('ended', () => stopScreenShare());
  audioTrack?.addEventListener('ended', () => __ar.log.info('[screen] audio track ended'));

  const targets =
    mode === 'sfu' && serverPc
      ? [{ pc: serverPc, peerId: '__sfu__' }]
      : [...peers.values()].filter((p) => p.pc).map((p) => ({ pc: p.pc, peerId: p.id }));

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
  __ar.log.info(
    `[screen] sharing avviato, peers=${targets.length}, tracks=${videoTrack ? 1 : 0}v+${audioTrack ? 1 : 0}a`,
  );
}

function stopScreenShare() {
  if (!screenStream) return;
  screenStream.getTracks().forEach((t) => t.stop());
  screenStream = null;
  // Rimuovi sender dai pc ( tracking diretto del pc nel sender entry)
  for (const { sender, pc } of screenSenders) {
    if (!pc) continue;
    try { pc.removeTrack(sender); } catch (e) { __ar.log.warn('[screen] removeTrack', e); }
  }
  screenSenders = [];
  document.querySelector('.video-tile-screen-self')?.remove();
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
  label.textContent = audioOn ? '📺🔊 Schermo + audio condivisi' : '📺 Stai condividendo lo schermo';
  tile.appendChild(video);
  tile.appendChild(label);
  grid.appendChild(tile);
  video.play().catch(() => {});
  refreshVideoGridVisibility();
}

function updateScreenShareUi(active) {
  const btn = $('screen-share-btn');
  if (!btn) return;
  btn.classList.toggle('active', active);
  btn.querySelector('.ico').textContent = active ? '⏹' : '📺';
  btn.title = active ? 'Ferma condivisione' : 'Condividi schermo (mesh P2P)';
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
  default: '🌌 Cosmic',
  matrix: '💚 Matrix',
  cyberpunk: '⚡ Cyberpunk',
  apple: '🍎 Apple',
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
  if (ico) ico.textContent = enabled ? '🎙' : '🔇';
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
    case '?':
      toggleShortcutsCheatsheet();
      break;
    case 'escape':
      closeChat?.();
      closePopover?.();
      closeStatsPanel?.();
      hideShortcutsCheatsheet();
      break;
    case ' ':
      // Push-to-talk: se mic muto, attiviamo finche' tenuto premuto
      if (!micEnabled) {
        e.preventDefault();
        pttHeld = true;
        pttRestoreMute = true;
        setMic(true);
        document.body.classList.add('ptt-active');
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
  }
});

// Cheatsheet shortcuts
let cheatsheetEl = null;
function toggleShortcutsCheatsheet() {
  if (cheatsheetEl) return hideShortcutsCheatsheet();
  cheatsheetEl = document.createElement('div');
  cheatsheetEl.className = 'shortcuts-cheatsheet';
  cheatsheetEl.innerHTML = `
    <h3>⌨ Shortcut tastiera</h3>
    <table>
      <tr><th>Tasto</th><th>Azione</th></tr>
      <tr><td><kbd>M</kbd></td><td>Microfono on/off</td></tr>
      <tr><td><kbd>Space</kbd> (hold)</td><td>Push-to-talk</td></tr>
      <tr><td><kbd>D</kbd></td><td>Deafen (silenzia tutto)</td></tr>
      <tr><td><kbd>C</kbd></td><td>Camera on/off</td></tr>
      <tr><td><kbd>S</kbd></td><td>Schermo on/off</td></tr>
      <tr><td><kbd>T</kbd></td><td>Test beep</td></tr>
      <tr><td><kbd>Ctrl+Shift+D</kbd></td><td>Stats debug panel</td></tr>
      <tr><td><kbd>?</kbd></td><td>Questo riepilogo</td></tr>
      <tr><td><kbd>Esc</kbd></td><td>Chiudi pannelli</td></tr>
    </table>
    <p class="cheat-foot">Le shortcut sono disattive nei campi di testo. Premi <kbd>?</kbd> o <kbd>Esc</kbd> per chiudere.</p>
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
  renderChatList();
  if (!chatState.open && m.fromId !== profile.userId) {
    chatState.unread++;
    updateChatBadge();
  }
}

function onChatEdited({ msgId, text, editedAt }) {
  const m = chatState.msgById.get(msgId);
  if (!m) return;
  m.text = text;
  m.editedAt = editedAt;
  renderChatList();
}

function onChatDeleted(msgId) {
  const m = chatState.msgById.get(msgId);
  if (!m) return;
  m.deleted = true;
  renderChatList();
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
      (e) => `<button class="chat-quick-react" data-emoji="${e}" title="Reazione ${e}">${e}</button>`,
    ).join('') +
    '</div>'
  );
}

function renderChatList() {
  const list = $('chat-list');
  if (!list) return;
  // Stampiamo dal piu' vecchio al piu' nuovo; con flex-direction:column-reverse
  // sul container il browser autoscrollera' verso il basso (gli ultimi).
  list.innerHTML = chatState.messages.map((m) => {
    const mine = m.fromId === profile.userId ? ' mine' : '';
    const edited = m.editedAt ? ' <span class="edit-tag">(modificato)</span>' : '';
    if (m.deleted) {
      return `<div class="chat-msg${mine} deleted" data-id="${m.id}"><span class="chat-from">${escapeHtmlText(m.fromName)}</span><span class="chat-body deleted-body">[messaggio rimosso]</span></div>`;
    }
    const html = renderChatMarkdown(m.text);
    const time = new Date(m.ts).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    const reactions = renderReactionsHtml(m.reactions, profile.userId);
    return `<div class="chat-msg${mine}" data-id="${m.id}"><div class="chat-meta"><span class="chat-from">${escapeHtmlText(m.fromName)}</span> <span class="chat-time">${time}</span>${edited}</div><div class="chat-body">${html}</div>${reactions}${renderQuickReactionsHtml()}</div>`;
  }).join('');
  list.scrollTop = list.scrollHeight;
}

function onChatReactionUpdate({ msgId, reactions }) {
  const m = chatState.msgById.get(msgId);
  if (!m) return;
  m.reactions = reactions;
  renderChatList();
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
  el.textContent = names.length === 1
    ? `${names[0]} sta scrivendo…`
    : `${names.slice(0, -1).join(', ')} e ${names[names.length - 1]} stanno scrivendo…`;
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
  $('chat-drawer')?.classList.add('open');
  chatState.unread = 0;
  updateChatBadge();
  setTimeout(() => $('chat-input')?.focus(), 50);
}

function closeChat() {
  chatState.open = false;
  $('chat-drawer')?.classList.remove('open');
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
  const pcs = mode === 'sfu' ? (serverPc ? [serverPc] : []) : [...peers.values()].map(p => p.pc).filter(Boolean);
  const rtts = []; let relay = false, any = false;
  for (const pc of pcs) {
    try {
      const stats = await pc.getStats();
      stats.forEach(r => {
        if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) {
          any = true;
          if (typeof r.currentRoundTripTime === 'number') rtts.push(r.currentRoundTripTime * 1000);
          const lc = stats.get(r.localCandidateId), rc = stats.get(r.remoteCandidateId);
          if (lc?.candidateType === 'relay' || rc?.candidateType === 'relay') relay = true;
        }
      });
    } catch {}
  }
  setLat(rtts.length ? Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length) : (any ? 1 : null));
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
  const pcs =
    mode === 'sfu'
      ? serverPc
        ? [{ pid: '__sfu__', pc: serverPc, name: 'Studio' }]
        : []
      : [...peers.values()]
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
  if ($$('stats-mode')) $$('stats-mode').textContent = mode;
  if ($$('stats-errors')) $$('stats-errors').textContent = String(__ar.state.errors.length);
  if ($$('stats-fps')) $$('stats-fps').textContent = String(statsState.fps);
}

setInterval(renderStatsPanel, 1500);

function setLat(ms) {
  const el = $('lat-badge'), val = $('lat-val');
  if (ms == null) { el.className = 'lat'; val.textContent = '— ms'; return; }
  val.textContent = (ms < 1 ? '<1' : ms) + ' ms';
  el.className = 'lat ' + (ms <= 5 ? 'good' : ms <= 20 ? 'mid' : 'bad');
}
function setTopo(relay) {
  const el = $('topo-badge');
  if (mode === 'sfu') { el.className = 'topo'; el.textContent = '🎛 Studio · DeepFilterNet'; return; }
  el.className = 'topo' + (relay ? ' relay' : '');
  el.textContent = relay ? '↩ Relay (TURN)' : '⛓ P2P diretto';
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
  //  screen share toggle
  $('screen-share-btn')?.addEventListener('click', () => {
    if (screenStream) stopScreenShare();
    else startScreenShare();
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
})();
navigator.mediaDevices.addEventListener?.('devicechange', refreshDevices);
