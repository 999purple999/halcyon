// =============================================================================
// HALCYON — inline SVG icon library
//
// Lucide-inspired set, 24x24 viewBox, currentColor, stroke-width 1.75.
// Every glyph in the UI is sourced from here. Replaces every emoji literal that
// used to live in markup or app.js string templates, so the visual stays crisp
// at any size and inherits text color.
//
// USAGE:
//   import { icon } from './icons.js';
//   element.innerHTML = icon('mic');
//   element.innerHTML = icon('mic', { size: 20 });
//
// All icons are pure functions returning a string, so they compose with
// existing innerHTML / template-literal patterns without DOM API changes.
// =============================================================================

const PATHS = {
  mic: '<path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v1a7 7 0 0 1-14 0v-1"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/>',
  'mic-off':
    '<line x1="2" y1="2" x2="22" y2="22"/><path d="M18.89 13.23A7 7 0 0 0 19 11v-1"/><path d="M5 10v1a7 7 0 0 0 12 5"/><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/><path d="M9 9v2a3 3 0 0 0 5.12 2.12"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/>',
  headphones:
    '<path d="M3 14h3a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6a9 9 0 0 1 18 0v6a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1h3"/>',
  'headphones-off':
    '<path d="M21 14h-1.34"/><path d="M21 14v-3a9 9 0 0 0-15.5-6.28"/><path d="M3 14h3a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M21 14v6a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1v-3"/><line x1="2" y1="2" x2="22" y2="22"/>',
  video:
    '<rect x="2" y="6" width="14" height="12" rx="2" ry="2"/><polygon points="22 8 16 12 22 16 22 8"/>',
  'video-off':
    '<path d="M10.66 6H14a2 2 0 0 1 2 2v2.34"/><path d="M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h.34"/><polyline points="22 8 16 12 22 16 22 8"/><line x1="2" y1="2" x2="22" y2="22"/>',
  monitor:
    '<rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>',
  'monitor-off':
    '<path d="M17 17H4a2 2 0 0 1-2-2V5c0-1.5 1-2 1-2"/><path d="M22 15V5a2 2 0 0 0-2-2H9"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/><line x1="2" y1="2" x2="22" y2="22"/>',
  chat: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  palette:
    '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="7.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="7.5" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="16.5" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="16.5" r="1.2" fill="currentColor" stroke="none"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  radio:
    '<circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14"/>',
  bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  users:
    '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  'user-alone': '<circle cx="12" cy="8" r="4"/><path d="M6 21v-2a6 6 0 0 1 12 0v2"/>',
  signal:
    '<path d="M2 20h.01"/><path d="M7 20v-4"/><path d="M12 20v-8"/><path d="M17 20V8"/><path d="M22 4v16"/>',
  gauge: '<path d="M12 14l4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
  refresh:
    '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
  send: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
  arrowLeft: '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1" ry="1"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  keyboard:
    '<rect x="2" y="4" width="20" height="16" rx="2" ry="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10"/>',
  reaction:
    '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>',
  zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  dot: '<circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  waveform:
    '<line x1="4" y1="12" x2="4" y2="12"/><line x1="8" y1="9" x2="8" y2="15"/><line x1="12" y1="5" x2="12" y2="19"/><line x1="16" y1="8" x2="16" y2="16"/><line x1="20" y1="11" x2="20" y2="13"/>',
};

/**
 * Render a Lucide-style SVG icon as a string.
 *
 * @param {string} name  Icon key from PATHS (e.g. 'mic', 'video-off').
 * @param {{size?: number, stroke?: number, className?: string}} [opts]
 * @returns {string} A self-contained <svg> string, currentColor stroke.
 */
export function icon(name, opts = {}) {
  const path = PATHS[name];
  if (!path) {
    // Soft fallback so a typo cannot crash the page. Renders an empty 1×1 svg.
    return '<svg width="0" height="0" aria-hidden="true"></svg>';
  }
  const size = opts.size || 20;
  const stroke = opts.stroke || 1.75;
  const cls = opts.className ? ` class="${opts.className}"` : '';
  return (
    `<svg${cls} xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`
  );
}

/** List of all available icon names (for debugging + future icon picker UI). */
export const ICON_NAMES = Object.keys(PATHS);

// Also expose globally so non-module callers (e.g. ad-hoc snippets in DevTools)
// can render icons without import gymnastics.
if (typeof window !== 'undefined') window.__icon = icon;
