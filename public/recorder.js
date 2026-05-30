// =============================================================================
// HALCYON — local meeting recorder
//
// Records the live room to a single WebM file using MediaRecorder. The audio
// track is a WebAudio mixdown of the local mic plus every peer's incoming
// audio (and the screen-share audio track when present). Video, if any, comes
// from the locally-shared camera or screen (in that order of priority).
//
// The result downloads as halcyon-YYYY-MM-DD-HH-MM-SS.webm. Nothing leaves
// the browser; the LAN-first promise is preserved.
//
// USAGE:
//   import { startRecording, stopRecording, isRecording, recordingElapsed } from './recorder.js';
//   startRecording({ localStream, peerAudioElements: [...], screenStream, videoStream });
//   if (isRecording()) stopRecording();
// =============================================================================

let state = nullState();

function nullState() {
  return {
    mr: null,
    chunks: [],
    startedAt: 0,
    ctx: null,
    dest: null,
    mime: '',
  };
}

const MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=h264,opus',
  'video/webm',
  'audio/webm;codecs=opus',
  'audio/webm',
];

function chooseMime(hasVideo) {
  const list = hasVideo ? MIME_CANDIDATES : MIME_CANDIDATES.filter((m) => m.startsWith('audio/'));
  for (const m of list) {
    try {
      if (window.MediaRecorder?.isTypeSupported(m)) return m;
    } catch {
      /* keep trying */
    }
  }
  return '';
}

/**
 * Start a recording. Mixes every audio source into a single track via WebAudio
 * and bundles whatever video the caller passes (camera preferred over screen
 * share, since the user usually wants the face on the recording).
 *
 * @param {{localStream: MediaStream | null,
 *          peerAudioElements: HTMLAudioElement[],
 *          screenStream?: MediaStream | null,
 *          videoStream?: MediaStream | null}} sources
 * @returns {boolean} true if recording started, false otherwise
 */
export function startRecording(sources) {
  if (state.mr) return false;
  if (typeof MediaRecorder === 'undefined') return false;

  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const dest = ctx.createMediaStreamDestination();

  const addAudio = (mediaStream) => {
    if (!mediaStream || !mediaStream.getAudioTracks().length) return;
    try {
      const src = ctx.createMediaStreamSource(mediaStream);
      src.connect(dest);
    } catch {
      /* a stream may have just ended; ignore */
    }
  };

  addAudio(sources.localStream);
  for (const el of sources.peerAudioElements || []) {
    if (el?.srcObject) addAudio(el.srcObject);
  }
  if (sources.screenStream) addAudio(sources.screenStream);

  const tracks = [dest.stream.getAudioTracks()[0]].filter(Boolean);
  // Pick exactly one video track for the recording. Camera first (the face is
  // what the user usually wants to keep), screen share second.
  const videoTrack =
    sources.videoStream?.getVideoTracks?.()[0] || sources.screenStream?.getVideoTracks?.()[0];
  if (videoTrack) tracks.push(videoTrack);

  const recStream = new MediaStream(tracks);
  const mime = chooseMime(!!videoTrack);
  let mr;
  try {
    const opts = mime ? { mimeType: mime } : {};
    if (videoTrack) opts.videoBitsPerSecond = 4_000_000;
    opts.audioBitsPerSecond = 256_000;
    mr = new MediaRecorder(recStream, opts);
  } catch {
    ctx.close().catch(() => {});
    return false;
  }

  state = {
    mr,
    chunks: [],
    startedAt: Date.now(),
    ctx,
    dest,
    mime: mime || 'video/webm',
  };

  mr.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) state.chunks.push(e.data);
  };
  mr.onstop = finalize;
  mr.onerror = () => {
    try {
      mr.stop();
    } catch {
      /* ignore */
    }
  };
  mr.start(1000); // request a chunk every second for safer recovery
  return true;
}

function finalize() {
  if (!state.mr) return;
  const { chunks, mime, startedAt, ctx } = state;
  const blob = new Blob(chunks, { type: mime || 'video/webm' });
  const url = URL.createObjectURL(blob);
  const ts = new Date(startedAt).toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const a = document.createElement('a');
  a.href = url;
  a.download = `halcyon-${ts}.webm`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  ctx?.close().catch(() => {});
  state = nullState();
}

/** Stop the current recording. Triggers the download asynchronously. */
export function stopRecording() {
  if (!state.mr) return;
  try {
    state.mr.stop();
  } catch {
    /* may already be inactive */
  }
}

export function isRecording() {
  return !!state.mr && state.mr.state !== 'inactive';
}

export function recordingElapsed() {
  if (!state.startedAt) return 0;
  return Date.now() - state.startedAt;
}

if (typeof window !== 'undefined') {
  window.__rec = {
    start: startRecording,
    stop: stopRecording,
    on: isRecording,
    ms: recordingElapsed,
  };
}
