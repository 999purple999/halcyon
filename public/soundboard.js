// =============================================================================
// HALCYON — soundboard client
//
// REST helpers + local audio playback for the per-room shared soundboard.
// The server stores the binary blobs; this module fetches metadata, uploads
// new files, plays an item locally (Test), and exposes a hook the main
// app calls when a peer triggers a sound via WS so every client plays the
// same blob in sync.
//
// Audio is decoded into the dedicated soundboard AudioContext (not the main
// playback path) so volume control and quick re-trigger don't fight the
// mic chain. Each play() spawns a new BufferSource so overlapping triggers
// are possible without click-stops.
// =============================================================================

const SOUND_MAX_BYTES = 5 * 1024 * 1024; // mirror of server constant

let _ctx = null;
const _bufferCache = new Map(); // soundId -> AudioBuffer
const _active = new Map(); // soundId -> AudioBufferSourceNode (most recent)
let _volume = 1.0;

function ensureCtx() {
  if (_ctx && _ctx.state !== 'closed') return _ctx;
  _ctx = new (window.AudioContext || window.webkitAudioContext)();
  return _ctx;
}

/** Fetch the metadata list of every sound on the server. */
export async function listSounds() {
  const r = await fetch('/api/sounds', { cache: 'no-store' });
  if (!r.ok) throw new Error('list_failed_' + r.status);
  const body = await r.json();
  return body.sounds || [];
}

/**
 * Upload a sound. Returns the metadata of the new sound.
 * @param {{file: File, name: string, ownerId: string, ownerName: string}} args
 */
export async function uploadSound({ file, name, ownerId, ownerName }) {
  if (!file) throw new Error('no_file');
  if (file.size > SOUND_MAX_BYTES) throw new Error('too_large');
  const r = await fetch('/api/sounds', {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'X-Sound-Name': encodeURIComponent(name || file.name),
      'X-Sound-Owner-Id': ownerId,
      'X-Sound-Owner-Name': encodeURIComponent(ownerName || 'unknown'),
    },
    body: file,
  });
  if (!r.ok) {
    let detail = '';
    try {
      const j = await r.json();
      detail = j?.error || '';
    } catch {
      /* ignore */
    }
    throw new Error('upload_failed_' + r.status + (detail ? ':' + detail : ''));
  }
  const body = await r.json();
  return body.sound;
}

/**
 * Delete a sound owned by this user.
 * @param {string} id
 * @param {string} ownerId
 */
export async function deleteSound(id, ownerId) {
  const r = await fetch(
    `/api/sounds/${encodeURIComponent(id)}?userId=${encodeURIComponent(ownerId)}`,
    {
      method: 'DELETE',
    },
  );
  if (!r.ok) throw new Error('delete_failed_' + r.status);
  const body = await r.json();
  _bufferCache.delete(id);
  _stopOne(id);
  return body.deleted === true;
}

async function loadBuffer(id) {
  if (_bufferCache.has(id)) return _bufferCache.get(id);
  const r = await fetch(`/api/sounds/${encodeURIComponent(id)}/file`);
  if (!r.ok) throw new Error('fetch_failed_' + r.status);
  const arr = await r.arrayBuffer();
  const ctx = ensureCtx();
  const buf = await ctx.decodeAudioData(arr);
  _bufferCache.set(id, buf);
  return buf;
}

/**
 * Play a sound locally. Used both by the Test button and by the remote-play
 * WS handler. Returns a promise that resolves when playback ends naturally.
 *
 * @param {string} id
 * @param {{onEnded?: () => void}} [opts]
 */
export async function playLocal(id, opts = {}) {
  const ctx = ensureCtx();
  if (ctx.state === 'suspended') {
    try {
      await ctx.resume();
    } catch {
      /* swallow */
    }
  }
  const buf = await loadBuffer(id);
  const src = ctx.createBufferSource();
  const gain = ctx.createGain();
  gain.gain.value = _volume;
  src.buffer = buf;
  src.connect(gain).connect(ctx.destination);
  src.onended = () => {
    if (_active.get(id) === src) _active.delete(id);
    opts.onEnded?.();
  };
  _active.set(id, src);
  src.start();
  return new Promise((resolve) => {
    src.onended = () => {
      if (_active.get(id) === src) _active.delete(id);
      opts.onEnded?.();
      resolve();
    };
  });
}

function _stopOne(id) {
  const src = _active.get(id);
  if (!src) return;
  try {
    src.stop();
  } catch {
    /* already stopped */
  }
  _active.delete(id);
}

/** Stop every currently-playing sound. */
export function stopAll() {
  for (const id of [..._active.keys()]) _stopOne(id);
}

export function setSoundboardVolume(v) {
  _volume = Math.max(0, Math.min(1.5, v));
}

export function getSoundboardVolume() {
  return _volume;
}

/** Format bytes for display (KB / MB). */
export function humanBytesShort(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

if (typeof window !== 'undefined') {
  window.__sb = {
    list: listSounds,
    upload: uploadSound,
    play: playLocal,
    stop: stopAll,
    del: deleteSound,
  };
}
