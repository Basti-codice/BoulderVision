// Hold-centric LED <-> hold mapping for Aurora/Kilter boards.
//
// WHY HOLD-CENTRIC. An LED sits behind its hold; its light leaks out around the whole outline (a ~1 cm coloured rim,
// sometimes bleeding onto neighbours, the hold surface itself dark or saturated). Blob finding on such rings yields
// several peaks or none. The holds are already known, so brightness is measured PER HOLD REGION (the hold polygon plus a
// thin ring around it) and every decision compares regions with each other.
//
// CALL SEQUENCE (all images are wall-image pixels, row-major, width*height; "signal" = lit frame minus dark frame,
// Uint8Array 0..255; hold = {id, cx, cy, poly:[[x,y],..], area}; holdIndex = index into the holds array):
//
//   1. layout = scanLayout(N)                                      (calibrate.js; capture one signal per layout frame)
//   2. {dx, dy} = estimateShift(holds, spotImage(layout, signals), W, H, {pxPerCm}); if dx or dy != 0, translate every
//      hold (cx, cy and poly) by (dx, dy) (camera moved since hold detection)
//      labels = holdRegions(holds, W, H, Math.round(DEFAULT_RING_CM * pxPerCm))        Int32Array, 0 = none, k+1 = hold k
//   3. means  = signals.map((s) => regionMeans(labels, holds.length, s))               Float64Array[frame][hold]
//   4. dec    = decodeHolds(means, layout)          -> {holds:[{pos|null, conf, guess, top, reasons}], noiseFloor}
//      assigned = new Map(holdIndex -> pos) for every dec.holds[k].pos !== null
//   5. orphans = orphanSpots(labels, signals, layout, W, H, pxPerCm, {decoded: dec.holds})
//                                  -> [{pos, x, y, conf, ref, supersedes?}]  LEDs lit outside every hold region;
//      for every orphan with `supersedes`, assigned.delete(orphan.supersedes) (that hold only caught bleed)
//   6. suspects = pathCheck(assigned, holds)        -> [{pos, holdIndex, distPrev, distNext, ratio}]
//      (optional: remove suspects from `assigned`; they are re-tested by probing and by the confirm pass)
//   7. unassignedHolds = hold indices not in `assigned`; missing = positions 0..N-1 not in assigned and not orphans
//      probes = planProbes(assigned, unassignedHolds, missing, holds)  -> [{leds:[pos], targets:[{pos, candidates, context}]}]
//      for each probe: light probe.leds, capture signal s, then
//        res = evaluateProbe(regionMeans(labels, holds.length, s), probe)  -> [{pos, holdIndex|null, conf, reason}]
//        add every res entry with holdIndex !== null to `assigned`
//      repeat step 7 once with the updated `assigned` if the first round assigned anything (new anchors shrink the
//      search radii). Holds without an LED stay candidates, so expect ~10-30 probe frames per round on a 400-hold wall.
//   8. plan = confirmPlan(assigned, holds)                       -> [{leds:[pos], holds:[holdIndex]}]
//      for each frame: light frame.leds, capture signal, m[f] = regionMeans(...)
//      ver = evaluateConfirm(m, plan, assigned, holds)    -> {holds:[{holdIndex,pos,ok,reasons,on}], unexpected, ok, bad}
//      drop (or re-probe) every hold with ok === false.
//
// All functions are pure, deterministic and DOM-free. Thresholds are relative to measured brightness wherever possible;
// the absolute ones only guard against decisions made on pure sensor noise.

import { scanLayout, findSpots, decodeSpots, spotImage } from './calibrate.js';

export { scanLayout };

// ---------------------------------------------------------------------------------------------------------------------
// Constants

/** Default ring width around each hold polygon, in cm. The visible rim is ~1 cm; 1.5 cm also covers small outline errors. */
export const DEFAULT_RING_CM = 1.5;

/**
 * Brightness statistic of a region: mean of its brightest TOP_FRACTION of pixels. Only the rim of a lit hold glows
 * (the surface may be dark or saturated), so a plain mean is diluted when the region is larger than the lit part
 * (outline detected too small: most of the rim falls into the thin ring); a small fraction picks up one-sided bleed from
 * a lit neighbour and single noisy pixels. Simulation (tests/unit/ledmap.test.js wall, 2 seeds x 6 scenarios: normal,
 * strong bleed, 8 % dim LEDs, outlines 15-35 % too big, outlines 10-25 % too small, bleed + too big): 0.5 mapped the
 * most holds (or tied) in every scenario; 1.0 (plain mean) lost up to 1 % with too-small outlines; 0.1 lost up to 3.4 %
 * with dim LEDs and produced a wrong label with too-big outlines. See the test 'robust region statistic'.
 */
export const DEFAULT_TOP_FRACTION = 0.5;

/** Absolute floor (grey levels) below which a region is never called lit, whatever the statistics say. */
export const MIN_SIGNAL = 6;

/** Noise floor = median + NOISE_K * robust sigma (1.4826 * MAD) of all region values of a frame set. */
export const NOISE_K = 6;

/**
 * Decoded labels with conf below this are not assigned (returned as `guess` only). conf = 1 - runnerUp / winner on the
 * weaker axis, so 0.35 means the winning pattern is at least ~1.54x brighter than any other pattern on both axes.
 * Simulation (18 walls, 7140 correct decodes above the noise floor): 0.17 % of correct decodes fall below 0.35 and go to
 * probing instead. Wrong decodes above the noise floor were all holds WITHOUT an LED catching the glow of an undetected
 * neighbour, with conf up to 0.77: confidence cannot catch those, orphanSpots' `supersedes` and the confirm pass do.
 */
export const ACCEPT_CONF = 0.35;

/** The x- and y-winner of one hold come from the same LED, so their brightness must agree within this ratio. */
export const AXIS_RATIO_MIN = 0.5;

/** Maximum LEDs lit in a probe frame (board power supply sags with many LEDs). */
export const PROBE_MAX_LEDS = 25;

/** Maximum LEDs lit in a confirm frame. */
export const CONFIRM_MAX_LEDS = 30;

/** Minimum distance (cm) between hold sets whose LEDs share a probe/confirm frame (beyond any visible bleed). */
export const MIN_SEPARATION_CM = 25;

/** Probe: winner must be at least this much brighter than the runner-up candidate (ratio). */
export const PROBE_MARGIN = 1.6;

/** Probe: a target with more candidate holds than this is skipped (expected location too uncertain). */
export const PROBE_MAX_CANDIDATES = 12;

/** Uncertainty growth per position step away from the nearest anchor, in units of the median LED step. */
export const LOCATION_SLACK = 1.5;

/** pathCheck: a link is "long" when it exceeds this many median LED steps per position of gap. */
export const PATH_LONG_FACTOR = 3;

/** Confirm: a lit hold must be at least this fraction of the brightest lit hold of its frame (90th percentile). */
export const CONFIRM_ON_REL = 0.05;

/** Confirm: a lit hold must be at least this much brighter than every other hold near it (it is the source of the light). */
export const CONFIRM_LOCAL_DOMINANCE = 1.15;

/** Confirm: an unlit hold far from every lit hold must stay below this fraction of its own "on" brightness. */
export const CONFIRM_OFF_REL = 0.35;

// ---------------------------------------------------------------------------------------------------------------------
// A. Hold regions

/**
 * Label image of hold regions: each hold polygon plus a ring of `ringPx` around it. A ring pixel belongs to the NEAREST
 * hold (octagonal distance, ties broken by the nearer hold centre), so rings of neighbours never overlap. Where two
 * polygons overlap the pixel goes to the hold with the nearer centre. Runs in O(width*height + total polygon bbox area).
 *
 * @param {Array<{cx:number, cy:number, poly:number[][]}>} holds
 * @param {number} width  wall image width (px)
 * @param {number} height wall image height (px)
 * @param {number} ringPx ring width in px (e.g. Math.round(DEFAULT_RING_CM * pxPerCm)); 0 = polygons only
 * @returns {Int32Array} length width*height; 0 = no hold, k+1 = hold index k
 */
export function holdRegions(holds, width, height, ringPx) {
  const labels = new Int32Array(width * height);
  const centreD2 = (k, x, y) => (holds[k].cx - x) ** 2 + (holds[k].cy - y) ** 2;
  holds.forEach((h, k) => rasterizePolygon(h.poly, width, height, (i, x, y) => {
    const cur = labels[i] - 1;
    if (cur < 0 || centreD2(k, x, y) < centreD2(cur, x, y)) labels[i] = k + 1;
  }));
  if (ringPx <= 0 || holds.length === 0) return labels;

  // Multi-source BFS, one layer per pixel of ring. Alternating 4- and 8-neighbourhood layers gives an octagonal
  // distance, a close approximation of the Euclidean one. `layer` remembers in which layer a pixel was claimed, so a
  // pixel reached by two holds in the same layer goes to the nearer hold centre.
  const layer = new Int32Array(width * height).fill(-1);
  let frontier = [];
  for (let i = 0; i < labels.length; i++) {
    if (!labels[i]) continue;
    layer[i] = 0;
    const x = i % width, y = (i - x) / width;
    if ((x > 0 && !labels[i - 1]) || (x < width - 1 && !labels[i + 1]) || (y > 0 && !labels[i - width]) || (y < height - 1 && !labels[i + width])) frontier.push(i);
  }
  const N4 = [[-1, 0], [1, 0], [0, -1], [0, 1]], N8 = [...N4, [-1, -1], [1, -1], [-1, 1], [1, 1]];
  for (let d = 1; d <= ringPx && frontier.length; d++) {
    const nb = d % 2 ? N4 : N8, next = [];
    for (const i of frontier) {
      const x = i % width, y = (i - x) / width, lab = labels[i];
      for (const [dx, dy] of nb) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const j = ny * width + nx;
        if (layer[j] === -1) { layer[j] = d; labels[j] = lab; next.push(j); }
        else if (layer[j] === d && labels[j] !== lab && centreD2(lab - 1, nx, ny) < centreD2(labels[j] - 1, nx, ny)) labels[j] = lab;
      }
    }
    frontier = next;
  }
  return labels;
}

/** Calls visit(index, x, y) for every pixel whose centre lies inside the polygon (even-odd rule, scanline). */
function rasterizePolygon(poly, width, height, visit) {
  if (!poly || poly.length < 3) return;
  let y0 = Infinity, y1 = -Infinity;
  for (const [, y] of poly) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const xs = [];
  for (let y = Math.max(0, Math.ceil(y0 - 0.5)); y <= Math.min(height - 1, Math.floor(y1 - 0.5)); y++) {
    const yc = y + 0.5;
    xs.length = 0;
    for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
      const [xa, ya] = poly[a], [xb, yb] = poly[b];
      if ((ya > yc) !== (yb > yc)) xs.push(xa + ((yc - ya) * (xb - xa)) / (yb - ya));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (let x = Math.max(0, Math.ceil(xs[k] - 0.5)); x <= Math.min(width - 1, Math.floor(xs[k + 1] - 0.5)); x++) visit(y * width + x, x, y);
    }
  }
}

/** estimateShift: half-width (cm) of the band around each outline where the rim light is expected. */
export const RIM_BAND_CM = 0.8;

/**
 * Registration check: the translation (dx, dy) that best aligns the hold outlines with the observed glow rims. Sums
 * the image over a band of +-bandPx around every outline for every integer shift up to maxShiftPx and returns the best.
 * Use the per-pixel maximum of the x-pattern signals (spotImage in calibrate.js: every LED lit exactly once). If the
 * camera moved between hold detection and the scan, translate the holds by (dx, dy) before holdRegions; the
 * simulation shows decoding degrades from about 1.5 cm misregistration on. gain = best score / score at (0, 0); a value
 * near 1 means the outlines already fit. Coarse-to-fine search: O(bandPixels * ((maxShiftPx + 1)^2 + 9)).
 *
 * @param {Array<{cx:number, cy:number, poly:number[][]}>} holds
 * @param {Uint8Array} image glow image (wall pixels)
 * @param {number} width
 * @param {number} height
 * @param {{maxShiftPx?:number, bandPx?:number, pxPerCm?:number}} [options] maxShiftPx default 4 cm, bandPx RIM_BAND_CM
 * @returns {{dx:number, dy:number, gain:number}}
 */
export function estimateShift(holds, image, width, height, { pxPerCm = 2.8, maxShiftPx = Math.round(4 * pxPerCm), bandPx = Math.max(1, Math.round(RIM_BAND_CM * pxPerCm)) } = {}) {
  const outer = holdRegions(holds, width, height, bandPx);
  const inner = holdRegions(holds.map((h) => ({ ...h, poly: shrinkPolygon(h, bandPx) })), width, height, 0);
  const band = [];
  for (let i = 0; i < outer.length; i++) if (outer[i] && !inner[i]) band.push(i);
  const scoreAt = (dx, dy) => {
    let sum = 0;
    for (const i of band) {
      const x = (i % width) + dx, y = ((i / width) | 0) + dy;
      if (x >= 0 && y >= 0 && x < width && y < height) sum += image[y * width + x];
    }
    return sum;
  };
  // Coarse grid (step 2), then the 3x3 neighbourhood of the coarse winner. Ties go to the smaller shift.
  const score0 = scoreAt(0, 0);
  let best = { dx: 0, dy: 0, score: score0 };
  const consider = (dx, dy) => {
    const sc = scoreAt(dx, dy);
    if (sc > best.score || (sc === best.score && Math.hypot(dx, dy) < Math.hypot(best.dx, best.dy))) best = { dx, dy, score: sc };
  };
  for (let dy = -maxShiftPx; dy <= maxShiftPx; dy += 2) for (let dx = -maxShiftPx; dx <= maxShiftPx; dx += 2) consider(dx, dy);
  const { dx: cx, dy: cy } = best;
  for (let dy = cy - 1; dy <= cy + 1; dy++) for (let dx = cx - 1; dx <= cx + 1; dx++) if (Math.abs(dx) <= maxShiftPx && Math.abs(dy) <= maxShiftPx) consider(dx, dy);
  return { dx: best.dx, dy: best.dy, gain: score0 > 0 ? best.score / score0 : 1 };
}

/** Polygon moved inward by d px along the centre rays (vertices never cross the centre). */
function shrinkPolygon(h, d) {
  return (h.poly || []).map(([x, y]) => {
    const l = Math.hypot(x - h.cx, y - h.cy) || 1, k = Math.max(0, 1 - d / l);
    return [h.cx + (x - h.cx) * k, h.cy + (y - h.cy) * k];
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// B. Region brightness

/**
 * Robust brightness of every hold region in one signal image: mean of the brightest `topFraction` of the region's
 * pixels (topFraction = 1 gives the plain mean). One pass over the pixels plus 256 histogram bins per hold.
 *
 * @param {Int32Array} labelMap from holdRegions
 * @param {number} holdCount number of holds (labels 1..holdCount)
 * @param {Uint8Array|Uint8ClampedArray} signal lit minus dark, same size as labelMap
 * @param {{topFraction?: number}} [options]
 * @returns {Float64Array} length holdCount; 0 for a hold without pixels
 */
export function regionMeans(labelMap, holdCount, signal, { topFraction = DEFAULT_TOP_FRACTION } = {}) {
  const hist = new Uint32Array(holdCount * 256), count = new Uint32Array(holdCount);
  for (let i = 0; i < labelMap.length; i++) {
    const lab = labelMap[i];
    if (lab > 0) { hist[(lab - 1) * 256 + signal[i]]++; count[lab - 1]++; }
  }
  const out = new Float64Array(holdCount);
  for (let k = 0; k < holdCount; k++) {
    if (!count[k]) continue;
    const want = Math.max(1, Math.round(count[k] * Math.min(1, Math.max(0, topFraction))));
    let left = want, sum = 0;
    for (let v = 255; v >= 0 && left > 0; v--) {
      const n = Math.min(left, hist[k * 256 + v]);
      sum += n * v; left -= n;
    }
    out[k] = sum / want;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// C. Decoding the row/column scan per hold

/**
 * Robust noise floor of a list of region values: max(minSignal, median + noiseK * 1.4826 * MAD). Valid when most values
 * are unlit regions, which holds for every frame of this module (few LEDs lit at a time).
 *
 * @param {ArrayLike<number>} values
 * @param {{noiseK?:number, minSignal?:number}} [options] defaults NOISE_K, MIN_SIGNAL
 * @returns {number}
 */
export function noiseFloorOf(values, { noiseK = NOISE_K, minSignal = MIN_SIGNAL } = {}) {
  if (!values.length) return minSignal;
  const med = quantile(values, 0.5), dev = Array.from(values, (v) => Math.abs(v - med));
  return Math.max(minSignal, med + noiseK * 1.4826 * quantile(dev, 0.5));
}

function quantile(values, q) {
  const s = Float64Array.from(values).sort();
  return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1) + 0.5)))] : 0;
}

/** Winner, its value and the runner-up value of arr[from..to). */
function best2(arr, from, to) {
  let bi = -1, bv = -Infinity, sv = 0;
  for (let i = from; i < to; i++) { const v = arr[i]; if (v > bv) { sv = Math.max(sv, bv); bv = v; bi = i; } else if (v > sv) sv = v; }
  return { index: bi - from, top: bv, second: Math.max(0, sv) };
}

/**
 * Decode every hold from the row/column scan. x = brightest x-pattern, y = brightest y-pattern, pos = x + q*y.
 * conf = min over both axes of (1 - runnerUp / winner), capped just below minConf for every rejected hold, so a
 * non-null pos always has conf >= minConf and a null pos always conf < minConf. A hold is left unassigned (pos = null,
 * reason given) when it is darker than the noise floor ('dark'), when its two axis winners differ in brightness by more than AXIS_RATIO_MIN
 * ('axis-mismatch': two different LEDs won), when the code is >= N ('out-of-range'), when conf < minConf
 * ('low-confidence'), or when a more confident hold decoded to the same position ('duplicate').
 *
 * @param {ArrayLike<number>[]} means means[frame][hold] (frames in layout.frames order)
 * @param {{q:number, Q:number, N:number}} layout from scanLayout
 * @param {{minConf?:number, axisRatioMin?:number, noiseFloor?:number}} [options] noiseFloor overrides the estimate
 * @returns {{holds: Array<{pos:number|null, guess:number|null, conf:number, top:number, reasons:string[]}>, noiseFloor:number}}
 */
export function decodeHolds(means, layout, { minConf = ACCEPT_CONF, axisRatioMin = AXIS_RATIO_MIN, noiseFloor } = {}) {
  const { q, Q, N } = layout, F = q + Q, H = means.length ? means[0].length : 0;
  if (means.length !== F) throw new Error(`decodeHolds: expected ${F} frames, got ${means.length}`);
  if (noiseFloor === undefined) {
    const all = [];
    for (let f = 0; f < F; f++) for (let k = 0; k < H; k++) all.push(means[f][k]);
    noiseFloor = noiseFloorOf(all);
  }
  const out = [], v = new Float64Array(F);
  for (let k = 0; k < H; k++) {
    for (let f = 0; f < F; f++) v[f] = means[f][k];
    const bx = best2(v, 0, q), by = best2(v, q, F), top = Math.max(bx.top, by.top);
    const guess = bx.index + q * by.index, reasons = [];
    const conf = Math.max(0, Math.min(1 - bx.second / Math.max(1e-9, bx.top), 1 - by.second / Math.max(1e-9, by.top)));
    if (Math.min(bx.top, by.top) < noiseFloor) reasons.push('dark');
    else if (Math.min(bx.top, by.top) < axisRatioMin * top) reasons.push('axis-mismatch');
    else if (guess >= N) reasons.push('out-of-range');
    else if (conf < minConf) reasons.push('low-confidence');
    out.push({ pos: reasons.length ? null : guess, guess: reasons[0] === 'dark' ? null : guess, conf: reasons.length ? Math.min(conf, minConf * 0.999) : conf, top, reasons });
  }
  resolveDuplicates(out, minConf);
  return { holds: out, noiseFloor };
}

/**
 * Two holds with the same position: the more confident (then brighter) one keeps it, the other gets 'duplicate' and its
 * conf is capped below the acceptance threshold like every other rejection.
 */
function resolveDuplicates(results, minConf) {
  const owner = new Map();
  const order = results.map((_, k) => k).filter((k) => results[k].pos !== null).sort((a, b) => results[b].conf - results[a].conf || results[b].top - results[a].top || a - b);
  for (const k of order) {
    const r = results[k];
    if (owner.has(r.pos)) { r.reasons.push('duplicate'); r.pos = null; r.conf = Math.min(r.conf, minConf * 0.999); } else owner.set(r.pos, k);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// D. LEDs outside every hold region

/** Fraction of an orphan spot's sampling disk that must lie outside hold regions (otherwise it is a hold's glow tail). */
const ORPHAN_MIN_FREE_FRAC = 0.5;

/** An orphan spot replaces a hold decoded to the same position only if it is this much brighter than the hold region. */
const ORPHAN_SUPERSEDE_RATIO = 1.5;

/**
 * LEDs that light up outside every hold region (a hole without a detected hold, or a missed hold). Hold regions are
 * masked out of the per-pixel maximum of the x-patterns, the remaining glows are found with findSpots and decoded with
 * decodeSpots (both calibrate.js) on the unmasked pixels only.
 * A spot that decodes to a position some hold k also decoded is either the outer glow of hold k (its outline was
 * detected too small) or a missed hold whose bleed hold k caught. It is taken as a missed hold, returned with
 * `supersedes: k` (the CALLER MUST UNASSIGN hold k), only if its centre lies outside hold k's region and it is
 * ORPHAN_SUPERSEDE_RATIO times brighter (disk mean `ref` vs. region value `top`); otherwise it is dropped.
 *
 * @param {Int32Array} labelMap from holdRegions
 * @param {Uint8Array[]} signals one signal image per layout frame
 * @param {{q:number, Q:number, N:number}} layout
 * @param {number} width
 * @param {number} height
 * @param {number} pxPerCm
 * @param {{decoded?: Array<{pos:number|null, top:number}>, minConf?: number}} [options] decoded = decodeHolds(...).holds
 * @returns {Array<{pos:number, x:number, y:number, conf:number, ref:number, supersedes?:number}>} sorted by pos
 */
export function orphanSpots(labelMap, signals, layout, width, height, pxPerCm, { decoded = [], minConf = ACCEPT_CONF } = {}) {
  if (!signals.length) return [];
  const img = spotImage(layout, signals);
  for (let i = 0; i < img.length; i++) if (labelMap[i]) img[i] = 0;
  const spots = [];
  for (const sp of findSpots(img, width, height, pxPerCm)) {
    const free = sp.pix.filter((i) => !labelMap[i]);
    if (free.length >= ORPHAN_MIN_FREE_FRAC * sp.pix.length) spots.push({ ...sp, pix: free, area: free.length });
  }
  const holdOf = new Map();
  decoded.forEach((r, k) => { if (r.pos !== null) holdOf.set(r.pos, k); });
  const out = [];
  for (const { pos, x, y, conf, ref } of decodeSpots(spots, signals, layout).leds) {
    if (conf < minConf) continue;
    const k = holdOf.get(pos);
    if (k === undefined) out.push({ pos, x, y, conf, ref });
    else if (labelMap[Math.round(y) * width + Math.round(x)] !== k + 1 && ref > ORPHAN_SUPERSEDE_RATIO * decoded[k].top) out.push({ pos, x, y, conf, ref, supersedes: k });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// E. Serpentine prior and targeted probing

/** Sorted assigned positions and their hold centres. */
function positionIndex(assigned, holds) {
  const byPos = new Map();
  for (const [k, p] of assigned) if (holds[k]) byPos.set(p, holds[k]);
  return { byPos, sorted: [...byPos.keys()].sort((a, b) => a - b) };
}

/** Median centre distance between holds of consecutive assigned positions (the typical LED step), or null. */
function medianStep(index) {
  const d = [];
  for (const p of index.sorted) {
    const a = index.byPos.get(p), b = index.byPos.get(p + 1);
    if (b) d.push(Math.hypot(a.cx - b.cx, a.cy - b.cy));
  }
  return d.length >= 3 ? quantile(d, 0.5) : null;
}

/** Median nearest-neighbour centre distance of the holds (fallback LED step). O(n^2), n = holds. */
function medianHoldSpacing(holds) {
  if (holds.length < 2) return 1;
  const nn = holds.map((a, i) => {
    let m = Infinity;
    holds.forEach((b, j) => { if (j !== i) m = Math.min(m, Math.hypot(a.cx - b.cx, a.cy - b.cy)); });
    return m;
  });
  return quantile(nn, 0.5);
}

/** Nearest position < p (dir -1) or > p (dir +1) in a sorted array; undefined if none. O(log n). */
function neighbourPos(sorted, p, dir) {
  let lo = 0, hi = sorted.length; // first index with sorted[i] >= p
  while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < p) lo = m + 1; else hi = m; }
  if (dir < 0) return sorted[lo - 1];
  return sorted[sorted[lo] === p ? lo + 1 : lo];
}

/** expectedLocation on a prepared positionIndex with a known LED step (px). */
function expectedIn(index, pos, step) {
  const lo = neighbourPos(index.sorted, pos, -1), hi = neighbourPos(index.sorted, pos, +1);
  if (lo === undefined && hi === undefined) return null;
  if (lo !== undefined && hi !== undefined) {
    const a = index.byPos.get(lo), b = index.byPos.get(hi), t = (pos - lo) / (hi - lo);
    const dAB = Math.hypot(b.cx - a.cx, b.cy - a.cy);
    // The strip may turn between the anchors (end of a row): then the point is near one anchor, not between them, and
    // the radius must cover that detour.
    const detour = Math.max(0, dAB - step * (hi - lo)) / 2;
    return { x: a.cx + t * (b.cx - a.cx), y: a.cy + t * (b.cy - a.cy), radiusPx: LOCATION_SLACK * step * Math.min(pos - lo, hi - pos) + detour };
  }
  // One-sided: extrapolate along the direction of the two nearest anchors on that side.
  const dir = lo !== undefined ? -1 : +1, p1 = lo !== undefined ? lo : hi, p2 = neighbourPos(index.sorted, p1, dir);
  const a = index.byPos.get(p1), gap = Math.abs(pos - p1);
  let x = a.cx, y = a.cy;
  if (p2 !== undefined) {
    const b = index.byPos.get(p2), k = gap / Math.abs(p1 - p2), len = Math.hypot(a.cx - b.cx, a.cy - b.cy);
    if (len <= step * PATH_LONG_FACTOR * Math.abs(p1 - p2)) { x = a.cx + (a.cx - b.cx) * k; y = a.cy + (a.cy - b.cy) * k; }
  }
  return { x, y, radiusPx: LOCATION_SLACK * step * gap };
}

/**
 * Where LED position `pos` should be, from the confidently assigned positions around it (the strip runs through the
 * board hold to hold, so consecutive positions are wall neighbours). Interpolates between the nearest assigned lower and
 * higher positions, or extrapolates from one side. radiusPx grows with the position gap (LOCATION_SLACK median LED steps
 * per position) and with any detour between the anchors. A soft hint: the true hold may lie outside the circle.
 * Builds an index of `assigned` on every call (O(n log n)); planProbes builds it once.
 *
 * @param {number} pos
 * @param {Map<number, number>} assigned holdIndex -> pos
 * @param {Array<{cx:number, cy:number}>} holds
 * @param {{stepPx?: number}} [options] typical LED step in px (default: median from `assigned`, else hold spacing)
 * @returns {{x:number, y:number, radiusPx:number}|null} null without any assigned position
 */
export function expectedLocation(pos, assigned, holds, { stepPx } = {}) {
  const index = positionIndex(assigned, holds);
  return expectedIn(index, pos, stepPx ?? medianStep(index) ?? medianHoldSpacing(holds));
}

/**
 * Plan probe frames for positions that are missing from the mapping. Each target position gets as candidates the
 * unassigned holds whose centre lies within its expected-location circle (plus the hold's own size), and as context the
 * assigned holds in that circle (used by evaluateProbe to reject light that lands on an already mapped hold). Targets
 * without candidates, without a location estimate or with more than maxCandidates candidates are not probed.
 * Frames are built by greedy first-fit colouring, most constrained target first: two targets share a frame only if every
 * hold of one (candidates and context) is more than minSeparationPx from every hold of the other, so each response can
 * be attributed to exactly one lit LED; at most maxLeds per frame. Complexity O(T * F * c^2) for T targets, F frames and
 * c holds per target (a few thousand distance checks per target in practice).
 *
 * @param {Map<number, number>} assigned holdIndex -> pos
 * @param {Iterable<number>} unassignedHolds hold indices without a position
 * @param {Iterable<number>} missingPositions positions without a hold (exclude orphans)
 * @param {Array<{cx:number, cy:number, poly:number[][]}>} holds
 * @param {{maxLeds?:number, minSeparationPx?:number, pxPerCm?:number, maxCandidates?:number, stepPx?:number}} [options]
 *        minSeparationPx defaults to MIN_SEPARATION_CM * pxPerCm (pxPerCm default 2.8)
 * @returns {Array<{leds:number[], targets:Array<{pos:number, candidates:number[], context:number[], x:number, y:number, radiusPx:number}>}>}
 */
export function planProbes(assigned, unassignedHolds, missingPositions, holds, { maxLeds = PROBE_MAX_LEDS, pxPerCm = 2.8, minSeparationPx = MIN_SEPARATION_CM * pxPerCm, maxCandidates = PROBE_MAX_CANDIDATES, stepPx } = {}) {
  const index = positionIndex(assigned, holds), step = stepPx ?? medianStep(index) ?? medianHoldSpacing(holds);
  const free = [...new Set(unassignedHolds)].filter((k) => holds[k]), mapped = [...assigned.keys()].filter((k) => holds[k]);
  const size = holds.map(holdRadius), targets = [];
  const within = (list, e) => list.filter((k) => Math.hypot(holds[k].cx - e.x, holds[k].cy - e.y) <= e.radiusPx + size[k]);
  for (const pos of [...new Set(missingPositions)].sort((a, b) => a - b)) {
    const e = expectedIn(index, pos, step);
    if (!e) continue;
    const candidates = within(free, e);
    if (!candidates.length || candidates.length > maxCandidates) continue;
    targets.push({ pos, candidates, context: within(mapped, e), x: e.x, y: e.y, radiusPx: e.radiusPx });
  }
  targets.sort((a, b) => b.candidates.length + b.context.length - a.candidates.length - a.context.length || a.pos - b.pos);
  const frames = [], sep2 = minSeparationPx * minSeparationPx;
  const pointsOf = (t) => [...t.candidates, ...t.context].map((k) => holds[k]);
  for (const t of targets) {
    const pts = pointsOf(t);
    let frame = frames.find((f) => f.targets.length < maxLeds && f.points.every((a) => pts.every((b) => (a.cx - b.cx) ** 2 + (a.cy - b.cy) ** 2 > sep2)));
    if (!frame) frames.push(frame = { targets: [], points: [] });
    frame.targets.push(t);
    frame.points.push(...pts);
  }
  return frames.map((f) => ({ leds: f.targets.map((t) => t.pos), targets: f.targets }));
}

/** Largest centre-to-vertex distance of a hold (its "radius"). */
function holdRadius(h) {
  let r = 0;
  for (const [x, y] of h.poly || []) r = Math.max(r, Math.hypot(x - h.cx, y - h.cy));
  return r;
}

/**
 * Attribute the response of one probe frame. For each lit position the candidate hold whose region is brightest wins
 * if it is above the frame's noise floor and at least `margin` times brighter than the runner-up candidate AND than
 * every context (already assigned) hold near it; otherwise holdIndex = null with a reason ('no-response',
 * 'ambiguous', 'lights-assigned-hold'). conf = 1 - runnerUp / winner.
 *
 * @param {ArrayLike<number>} means regionMeans of the probe frame's signal, per hold
 * @param {{targets:Array<{pos:number, candidates:number[], context?:number[]}>}} probe one entry of planProbes
 * @param {{margin?:number, noiseFloor?:number}} [options] noiseFloor default: noiseFloorOf(all region values)
 * @returns {Array<{pos:number, holdIndex:number|null, conf:number, reason:string|null}>}
 */
export function evaluateProbe(means, probe, { margin = PROBE_MARGIN, noiseFloor } = {}) {
  const floor = noiseFloor ?? noiseFloorOf(Array.from(means));
  return probe.targets.map(({ pos, candidates, context = [] }) => {
    let best = -1, top = -Infinity, second = 0;
    for (const k of candidates) { const v = means[k]; if (v > top) { second = Math.max(second, top); top = v; best = k; } else if (v > second) second = v; }
    const ctx = context.reduce((m, k) => Math.max(m, means[k]), 0), conf = Math.max(0, 1 - Math.max(second, ctx) / Math.max(1e-9, top));
    if (best < 0 || top < floor) return { pos, holdIndex: null, conf: 0, reason: 'no-response' };
    if (ctx * margin > top) return { pos, holdIndex: null, conf, reason: 'lights-assigned-hold' };
    if (second * margin > top) return { pos, holdIndex: null, conf, reason: 'ambiguous' };
    return { pos, holdIndex: best, conf, reason: null };
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// F. Geometric path check

/**
 * Consecutive LED positions are wall neighbours (the strip runs hold to hold), so an assignment that has no short link
 * to any neighbouring assigned position is suspicious. One long link next to a short one is normal at the end of a strip
 * row and is not flagged. "Long" = longer than PATH_LONG_FACTOR median LED steps per position of gap; only neighbours at
 * most maxGap positions away count, so an assignment without any such neighbour carries no evidence and is not flagged.
 * Pure geometry.
 *
 * @param {Map<number, number>} assigned holdIndex -> pos
 * @param {Array<{cx:number, cy:number}>} holds
 * @param {{longFactor?:number, maxGap?:number, stepPx?:number}} [options]
 * @returns {Array<{pos:number, holdIndex:number, distPrev:number|null, distNext:number|null, ratio:number}>} ratio = shorter link /
 *          allowed length; sorted by ratio, most suspicious first
 */
export function pathCheck(assigned, holds, { longFactor = PATH_LONG_FACTOR, maxGap = 3, stepPx } = {}) {
  const index = positionIndex(assigned, holds), step = stepPx ?? medianStep(index);
  if (!step) return [];
  const holdOf = new Map([...assigned].map(([k, p]) => [p, k])), out = [];
  for (const p of index.sorted) {
    const h = index.byPos.get(p), link = (q) => {
      if (q === undefined || Math.abs(q - p) > maxGap) return null;
      const o = index.byPos.get(q);
      return { d: Math.hypot(o.cx - h.cx, o.cy - h.cy), allowed: longFactor * step * Math.abs(q - p) };
    };
    const a = link(neighbourPos(index.sorted, p, -1)), b = link(neighbourPos(index.sorted, p, +1));
    if (!a && !b) continue;
    const ratio = Math.min(a ? a.d / a.allowed : Infinity, b ? b.d / b.allowed : Infinity);
    if (ratio > 1) out.push({ pos: p, holdIndex: holdOf.get(p), distPrev: a ? a.d : null, distNext: b ? b.d : null, ratio });
  }
  return out.sort((x, y) => y.ratio - x.ratio || x.pos - y.pos);
}

// ---------------------------------------------------------------------------------------------------------------------
// G. Full verification pass

/**
 * Group ALL assigned LEDs into verification frames: at most maxLeds per frame, holds lit in the same frame more than
 * minSeparationPx apart (centre distance minus both hold radii), greedy first-fit in position order using a uniform
 * grid, so O(n * F) for n assigned holds and F frames.
 *
 * @param {Map<number, number>} assigned holdIndex -> pos
 * @param {Array<{cx:number, cy:number, poly:number[][]}>} holds
 * @param {{maxLeds?:number, minSeparationPx?:number, pxPerCm?:number}} [options]
 * @returns {Array<{leds:number[], holds:number[]}>} leds[i] is the position assigned to holds[i]
 */
export function confirmPlan(assigned, holds, { maxLeds = CONFIRM_MAX_LEDS, pxPerCm = 2.8, minSeparationPx = MIN_SEPARATION_CM * pxPerCm } = {}) {
  const items = [...assigned].filter(([k]) => holds[k]).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const radius = new Map(items.map(([k]) => [k, holdRadius(holds[k])]));
  const frames = [];
  for (const [k, pos] of items) {
    const h = holds[k], rk = radius.get(k);
    const fits = (f) => f.holds.length < maxLeds && f.holds.every((j) => Math.hypot(holds[j].cx - h.cx, holds[j].cy - h.cy) - rk - radius.get(j) > minSeparationPx);
    let frame = frames.find(fits);
    if (!frame) frames.push(frame = { leds: [], holds: [] });
    frame.leds.push(pos); frame.holds.push(k);
  }
  return frames;
}

/**
 * Check every assigned hold against the confirm frames (regionMeans per frame, same order as `plan`). A hold is ok when
 *  - 'dark'        its region is above the frame noise floor,
 *  - 'weak'        and >= CONFIRM_ON_REL x the 90th-percentile lit hold of the frame (a fainter response cannot be told
 *                  apart from bleed of an undetected neighbour; re-check such a LED by hand),
 *  - 'not-source'  it is >= CONFIRM_LOCAL_DOMINANCE x brighter than every other hold within bleedRadiusPx (the light
 *                  comes from ITS LED, not from a neighbour's),
 *  - 'lit-elsewhere' in every other frame where no lit hold is within bleedRadiusPx, it stays below
 *                  max(noise floor, CONFIRM_OFF_REL x its own on-value) (no other LED lights it).
 * Unassigned holds that light up far from every lit hold are reported in `unexpected` (a lit LED belongs to them).
 *
 * @param {ArrayLike<number>[]} means means[frame][hold] for the frames of `plan`
 * @param {Array<{leds:number[], holds:number[]}>} plan from confirmPlan
 * @param {Map<number, number>} assigned holdIndex -> pos (the mapping that was verified)
 * @param {Array<{cx:number, cy:number, poly:number[][]}>} holds
 * @param {{bleedRadiusPx?:number, pxPerCm?:number}} [options] bleedRadiusPx default 8 cm (beyond hold outlines)
 * @returns {{holds:Array<{holdIndex:number, pos:number, ok:boolean, on:number, reasons:string[]}>, unexpected:Array<{holdIndex:number, frame:number, value:number}>, ok:number, bad:number}}
 */
export function evaluateConfirm(means, plan, assigned, holds, { pxPerCm = 2.8, bleedRadiusPx = 8 * pxPerCm } = {}) {
  const H = holds.length, radius = holds.map(holdRadius);
  const near = (a, b) => Math.hypot(holds[a].cx - holds[b].cx, holds[a].cy - holds[b].cy) - radius[a] - radius[b] <= bleedRadiusPx;
  const floors = means.map((m) => noiseFloorOf(Array.from(m)));
  const frameOf = new Map();
  plan.forEach((f, fi) => f.holds.forEach((k) => frameOf.set(k, fi)));
  const neighbours = holds.map((_, a) => { const n = []; for (let b = 0; b < H; b++) if (b !== a && near(a, b)) n.push(b); return n; });
  const refs = plan.map((f, fi) => quantile(f.holds.map((k) => means[fi][k]), 0.9));
  const litNear = plan.map((f) => { const s = new Uint8Array(H); for (const k of f.holds) { s[k] = 1; for (const n of neighbours[k]) s[n] = 1; } return s; });
  const results = [];
  for (const [k, pos] of assigned) {
    const fi = frameOf.get(k);
    if (fi === undefined) continue;
    const on = means[fi][k], reasons = [];
    if (on < floors[fi]) reasons.push('dark');
    else if (on < CONFIRM_ON_REL * refs[fi]) reasons.push('weak');
    if (neighbours[k].some((n) => means[fi][n] * CONFIRM_LOCAL_DOMINANCE > on)) reasons.push('not-source');
    for (let g = 0; g < plan.length; g++) {
      if (g !== fi && !litNear[g][k] && means[g][k] > Math.max(floors[g], CONFIRM_OFF_REL * on)) { reasons.push('lit-elsewhere'); break; }
    }
    results.push({ holdIndex: k, pos, ok: reasons.length === 0, on, reasons });
  }
  const unexpected = [];
  for (let k = 0; k < H; k++) {
    if (assigned.has(k)) continue;
    for (let g = 0; g < plan.length; g++) if (!litNear[g][k] && means[g][k] > floors[g]) unexpected.push({ holdIndex: k, frame: g, value: means[g][k] });
  }
  const ok = results.filter((r) => r.ok).length;
  return { holds: results.sort((a, b) => a.pos - b.pos), unexpected, ok, bad: results.length - ok };
}
