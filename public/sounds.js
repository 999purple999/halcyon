// =============================================================================
// HALCYON — notification sound synthesizer
//
// Short synthetic tones for room events (join, leave, hand-raise, chat msg,
// mute toggle, push-to-talk on/off). No audio assets: every sound is built
// from oscillators + an envelope, keeping the bundle dependency-free and the
// timbre consistent with the design system.
//
// USAGE:
//   import { playSound, setSoundEnabled, isSoundEnabled } from './sounds.js';
//   playSound('join');
//   setSoundEnabled(false);   // mutes all notifications
//
// All play* helpers no-op silently if notifications are disabled, if the
// browser blocks the AudioContext, or if the tab is in the background.
// =============================================================================

let _ctx = null;
let _enabled = true;

function ensureCtx() {
  if (_ctx) return _ctx;
  try {
    _ctx = new (window.AudioContext || window.webkitAudioContext)();
  } catch {
    _ctx = null;
  }
  return _ctx;
}

/**
 * Schedule a single tone with an attack/decay envelope.
 * @param {number} freq   Hz
 * @param {number} when   relative seconds from now
 * @param {number} dur    seconds
 * @param {number} peak   0..1 gain at envelope peak
 * @param {OscillatorType} [type='sine']
 */
function tone(ctx, freq, when, dur, peak, type = 'sine') {
  const t0 = ctx.currentTime + when;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.04);
}

const VOICINGS = {
  // Ascending pair, friendly. Used when a peer joins.
  join: (ctx) => {
    tone(ctx, 660, 0.0, 0.16, 0.18);
    tone(ctx, 990, 0.09, 0.22, 0.22);
  },
  // Descending pair. Used when a peer leaves.
  leave: (ctx) => {
    tone(ctx, 880, 0.0, 0.16, 0.18);
    tone(ctx, 587, 0.09, 0.22, 0.16);
  },
  // Single warm bell. Used for hand-raise + floating reactions.
  raise: (ctx) => {
    tone(ctx, 1175, 0.0, 0.34, 0.18, 'triangle');
    tone(ctx, 1760, 0.0, 0.34, 0.1, 'sine');
  },
  // Soft click. Used for incoming chat messages when chat drawer is closed.
  msg: (ctx) => {
    tone(ctx, 1320, 0.0, 0.09, 0.14, 'triangle');
  },
  // Neutral tick. Used for the local mute / deafen toggles so the user has
  // an audible confirmation in addition to the visual state change.
  tick: (ctx) => {
    tone(ctx, 2200, 0.0, 0.05, 0.1, 'square');
  },
  // PTT engaged / released. Pair of short pings, slightly different timbre.
  pttOn: (ctx) => {
    tone(ctx, 1500, 0.0, 0.07, 0.12, 'sine');
  },
  pttOff: (ctx) => {
    tone(ctx, 900, 0.0, 0.07, 0.1, 'sine');
  },
  // Warning chirp. Used by the connection-quality system when a peer's link
  // crosses a degradation threshold (high RTT, packet loss spike).
  warn: (ctx) => {
    tone(ctx, 440, 0.0, 0.12, 0.2, 'sawtooth');
    tone(ctx, 392, 0.1, 0.16, 0.18, 'sawtooth');
  },
};

/**
 * Play one of the named voicings if notifications are enabled.
 * @param {keyof typeof VOICINGS} name
 */
export function playSound(name) {
  if (!_enabled) return;
  if (typeof document !== 'undefined' && document.hidden) return;
  const v = VOICINGS[name];
  if (!v) return;
  const ctx = ensureCtx();
  if (!ctx) return;
  // Resume context if it was suspended (Chrome autoplay policy).
  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }
  try {
    v(ctx);
  } catch {
    /* swallow: never let a notification crash the UI */
  }
}

export function setSoundEnabled(on) {
  _enabled = !!on;
  try {
    localStorage.setItem('halcyon:sounds', _enabled ? '1' : '0');
  } catch {
    /* private mode etc */
  }
}

export function isSoundEnabled() {
  return _enabled;
}

// Load persisted preference at module init.
try {
  const stored = localStorage.getItem('halcyon:sounds');
  if (stored === '0') _enabled = false;
} catch {
  /* nothing */
}

if (typeof window !== 'undefined') {
  window.__sound = { play: playSound, set: setSoundEnabled, on: () => _enabled };
}
