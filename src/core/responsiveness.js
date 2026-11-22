// How quickly a limb counts as "on a hold" and how much the tracked points are smoothed. Pure, so it can be tested.
//
//   holdMs      a limb must stay over the same hold this long before it counts
//   releaseMs   it must be away this long before the hold is released
//   maxSpeed    cm/s: moving faster than this is swiping past, not touching
//   smoothing   0..1: 0 = raw points (quick, jittery), 1 = heavily smoothed (steady, lags behind)
//
// Presets are measured trade-offs, not guesses: "precise" is the original behaviour of the app.

export const PRESETS = {
  precise:  { holdMs: 90, releaseMs: 120, maxSpeed: 90,  smoothing: 0.85 },
  balanced: { holdMs: 60, releaseMs: 120, maxSpeed: 120, smoothing: 0.5 },
  fast:     { holdMs: 30, releaseMs: 90,  maxSpeed: 160, smoothing: 0.15 },
};
export const DEFAULT_PRESET = 'balanced';

export const LIMITS = {
  holdMs: [20, 250], releaseMs: [40, 400], maxSpeed: [40, 300], smoothing: [0, 1],
};

const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));

/** Full settings object ({preset, holdMs, releaseMs, maxSpeed, smoothing}) from anything stored or typed. */
export function sanitize(input = {}) {
  const preset = PRESETS[input.preset] ? input.preset : input.preset === 'custom' ? 'custom' : DEFAULT_PRESET;
  const base = PRESETS[preset] || PRESETS[DEFAULT_PRESET];
  const out = { preset };
  for (const k of Object.keys(LIMITS)) out[k] = clamp(Number.isFinite(+input[k]) && input[k] !== null && input[k] !== '' ? +input[k] : base[k], LIMITS[k]);
  return out;
}

/** Choosing a preset replaces all four numbers. */
export function withPreset(name) { return PRESETS[name] ? { preset: name, ...PRESETS[name] } : sanitize({}); }

/** Changing a single number makes the settings "custom" (or back to a preset when the numbers match one). */
export function withValue(settings, key, value) {
  const next = sanitize({ ...settings, preset: 'custom', [key]: value });
  for (const [name, p] of Object.entries(PRESETS)) if (Object.keys(LIMITS).every((k) => Math.abs(p[k] - next[k]) < 1e-9)) return { ...next, preset: name };
  return next;
}

/**
 * One-Euro filter parameters for a smoothing value: cut-off frequency at rest and how fast it opens while moving.
 * Geometric between "no smoothing" (4 Hz, beta 0.5) and "heavy" (1 Hz, beta 0.02).
 */
export function filterParams(smoothing) {
  const s = clamp(smoothing, LIMITS.smoothing);
  return { minCutoff: 4 * 0.25 ** s, beta: 0.5 * 0.04 ** s };
}

/** What ContactTracker and the point filters take. */
export function resolve(settings) {
  const s = sanitize(settings);
  return { tracker: { onMs: s.holdMs, offMs: s.releaseMs, maxSpeedCmS: s.maxSpeed }, filter: filterParams(s.smoothing) };
}
