// LED <-> wall-position calibration for Aurora/Kilter boards.
//
// Row/column scan: every position p is written as p = x + q*y. One pattern per x value lights all LEDs with that x
// (they are spread far apart over the wall), one pattern per y value lights q consecutive LEDs. Each LED therefore
// lights up in exactly one x-pattern and one y-pattern; the camera sees which. Never more than ~sqrt(N) LEDs are lit
// at once (about 30 of 1000), which matters: boards run from small power supplies and dim or reset when many LEDs
// are on. Decisions are "which pattern is brightest", so no brightness thresholds are needed.
// All maths here is pure and testable.

/** Patterns for N LED positions: {q, Q, N, frames:[{axis:'x'|'y', index, positions[]}]}. */
export function scanLayout(N) {
  const q = Math.max(2, Math.ceil(Math.sqrt(N))), Q = Math.ceil(N / q), frames = [];
  for (let i = 0; i < q; i++) { const positions = []; for (let y = 0; y < Q; y++) { const p = i + q * y; if (p < N) positions.push(p); } frames.push({ axis: 'x', index: i, positions }); }
  for (let j = 0; j < Q; j++) { const positions = []; for (let x = 0; x < q; x++) { const p = x + q * j; if (p < N) positions.push(p); } frames.push({ axis: 'y', index: j, positions }); }
  return { q, Q, N, frames };
}

function boxBlurU8(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h), n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let x = -r; x <= r; x++) s += src[y * w + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) { tmp[y * w + x] = s / n; s += src[y * w + Math.min(w - 1, x + r + 1)] - src[y * w + Math.max(0, x - r)]; }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) { out[y * w + x] = s / n; s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x]; }
  }
  return out;
}

/**
 * Glow spots in a signal image (single channel: lit frame minus dark frame).
 * Uses intensity maxima of a smoothed image (robust against overlapping glows and ring-shaped glows).
 * Returns [{x, y, peak, area, pix}] sorted top-to-bottom; `pix` = pixels of a small disk around the centre,
 * which is where brightness is later sampled for every pattern frame.
 */
export function findSpots(signal, w, h, pxPerCm, { minAbs = 7, sigmaK = 8, nmsCm = 4.5, blurCm = 2.8, diskCm = 3, bgCm = 7 } = {}) {
  const sm = boxBlurU8(signal, w, h, Math.max(1, Math.round(blurCm * pxPerCm)));
  // Difference of box blurs: removes the plateau that overlapping glows form, keeps each glow's own peak.
  const bg = boxBlurU8(signal, w, h, Math.max(3, Math.round(bgCm * pxPerCm)));
  const blur = new Float32Array(sm.length);
  for (let i = 0; i < blur.length; i++) blur[i] = Math.max(0, sm[i] - bg[i] * 0.9);
  // Threshold: background level (10th percentile; glows never cover most of the wall) + a noise margin.
  // Noise comes from the high-frequency residual (signal - blur), which glows do not contribute to.
  const hist = new Uint32Array(256);
  for (let i = 0; i < blur.length; i++) hist[Math.min(255, blur[i] | 0)]++;
  let acc = 0, base = 0;
  for (let k = 0; k < 256; k++) { acc += hist[k]; if (acc >= blur.length * 0.1) { base = k; break; } }
  const rh = new Uint32Array(511);
  for (let i = 0; i < blur.length; i += 7) rh[Math.round(signal[i] - blur[i]) + 255]++;
  let rn = 0, rmed = 255;
  for (let k = 0; k < 511; k++) rn += rh[k];
  acc = 0;
  for (let k = 0; k < 511; k++) { acc += rh[k]; if (acc >= rn / 2) { rmed = k; break; } }
  const rdev = new Uint32Array(256);
  for (let k = 0; k < 511; k++) rdev[Math.min(255, Math.abs(k - rmed))] += rh[k];
  acc = 0;
  let rmad = 0;
  for (let k = 0; k < 256; k++) { acc += rdev[k]; if (acc >= rn / 2) { rmad = k; break; } }
  const sigmaBlur = (1.4826 * rmad) / (2 * Math.max(1, Math.round(blurCm * pxPerCm)) + 1);
  const thr = Math.max(minAbs * 0.6, base + sigmaK * sigmaBlur);

  // candidates: local maxima of the smoothed image above threshold, greedy non-maximum suppression
  const R = Math.max(2, Math.round(nmsCm * pxPerCm)), cand = [];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x, v = blur[i];
    if (v >= thr && v >= blur[i - 1] && v >= blur[i + 1] && v >= blur[i - w] && v >= blur[i + w]) cand.push(i);
  }
  cand.sort((a, b) => blur[b] - blur[a]);
  const cell = R, gw = Math.ceil(w / cell) + 1, grid = new Map(), peaks = [];
  for (const i of cand) {
    const x = i % w, y = (i / w) | 0, cx = (x / cell) | 0, cy = (y / cell) | 0;
    let ok = true;
    for (let gy = cy - 1; gy <= cy + 1 && ok; gy++) for (let gx = cx - 1; gx <= cx + 1 && ok; gx++) {
      const list = grid.get(gy * gw + gx);
      if (list) for (const p of list) if ((p.x - x) ** 2 + (p.y - y) ** 2 < R * R) { ok = false; break; }
    }
    if (!ok) continue;
    const p = { x, y, v: blur[i] };
    peaks.push(p);
    const key = cy * gw + cx; (grid.get(key) || grid.set(key, []).get(key)).push(p);
  }
  // Refine each peak: intensity-weighted centroid of the area above 60% of the local peak. This also centres
  // saturated (flat-topped) glows correctly. Then build the disk used for brightness sampling.
  const rc = Math.max(3, Math.round(4.5 * pxPerCm)), rd = Math.max(2, Math.round(diskCm * pxPerCm)), out = [];
  for (const p of peaks) {
    const pk = sm[p.y * w + p.x] || 1;
    let cx = p.x, cy = p.y;
    for (let it = 0; it < 3; it++) { // re-centre: the first maximum of a saturated plateau can sit anywhere on it
      let sw = 0, sx = 0, sy = 0;
      for (let y = Math.max(0, Math.round(cy) - rc); y <= Math.min(h - 1, Math.round(cy) + rc); y++) for (let x = Math.max(0, Math.round(cx) - rc); x <= Math.min(w - 1, Math.round(cx) + rc); x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 > rc * rc) continue;
        const v = sm[y * w + x] - pk * 0.6;
        if (v > 0) { sw += v; sx += x * v; sy += y * v; }
      }
      if (sw <= 0) break;
      cx = sx / sw; cy = sy / sw;
    }
    const pix = [];
    for (let y = Math.max(0, Math.round(cy) - rd); y <= Math.min(h - 1, Math.round(cy) + rd); y++) for (let x = Math.max(0, Math.round(cx) - rd); x <= Math.min(w - 1, Math.round(cx) + rd); x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= rd * rd) pix.push(y * w + x);
    out.push({ x: cx, y: cy, peak: p.v, area: pix.length, pix: Int32Array.from(pix) });
  }
  // A ring-shaped glow can yield two maxima; after re-centring they coincide: keep the stronger one.
  out.sort((a, b) => b.peak - a.peak);
  const merged = [], minD = 0.5 * nmsCm * pxPerCm;
  for (const sp of out) if (!merged.some((m) => (m.x - sp.x) ** 2 + (m.y - sp.y) ** 2 < minD * minD)) merged.push(sp);
  return merged.sort((a, b) => a.y - b.y || a.x - b.x);
}

const meanOver = (sig, pix) => { let s = 0; for (let k = 0; k < pix.length; k++) s += sig[pix[k]]; return s / pix.length; };

const best2 = (arr, from, to) => {
  let bi = from, bv = -Infinity, sv = -Infinity;
  for (let i = from; i < to; i++) { const v = arr[i]; if (v > bv) { sv = bv; bv = v; bi = i; } else if (v > sv) sv = v; }
  return { index: bi - from, top: bv, second: Math.max(0, sv) };
};

/** Signal image for spot finding: pixel-wise maximum over the x-patterns (the LEDs lit together there are far apart). */
export function spotImage(layout, signals) {
  const out = new Uint8Array(signals[0].length);
  for (let f = 0; f < layout.q; f++) { const s = signals[f]; for (let i = 0; i < out.length; i++) if (s[i] > out[i]) out[i] = s[i]; }
  return out;
}

/**
 * spots: from findSpots(spotImage(...)). signals[k]: signal image of pattern k (same order as layout.frames).
 * An LED's x is the x-pattern in which its spot is brightest, y likewise. conf = how much brighter the winner is than the
 * runner-up (both axes), so a spot that lights in several patterns (glare, neighbour bleed) gets a low confidence.
 * Returns { leds: [{pos,x,y,conf,pix,ref}], rejected: [{reason,x,y,pos?}] }
 */
export function decodeSpots(spots, signals, layout) {
  const { q, Q, N } = layout, found = [], rejected = [];
  for (const sp of spots) {
    const iv = signals.map((sig) => meanOver(sig, sp.pix));
    const bx = best2(iv, 0, q), by = best2(iv, q, q + Q), ref = Math.max(bx.top, by.top);
    if (ref < 4) { rejected.push({ reason: 'dark', x: sp.x, y: sp.y }); continue; }
    let conf = Math.min(1 - bx.second / bx.top, 1 - by.second / by.top);
    if (Math.min(bx.top, by.top) < 0.5 * ref) conf = Math.min(conf, 0.2); // the two axes disagree on brightness
    const pos = bx.index + q * by.index;
    if (pos >= N) { rejected.push({ reason: 'out-of-range', x: sp.x, y: sp.y, pos }); continue; }
    found.push({ pos, x: sp.x, y: sp.y, conf: Math.max(0, conf), area: sp.area, pix: sp.pix, ref });
  }
  found.sort((a, b) => b.conf - a.conf);
  const byPos = new Map(), leds = [];
  for (const f of found) {
    if (byPos.has(f.pos)) { rejected.push({ reason: 'duplicate', x: f.x, y: f.y, pos: f.pos }); continue; }
    byPos.set(f.pos, f);
    leds.push(f);
  }
  leds.sort((a, b) => a.pos - b.pos);
  return { leds, rejected };
}

/** Choose a sparse, well-spread subset of located LEDs for the verification frame. */
export function pickVerifySet(leds, count = 36, seed = 1) {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const pool = leds.slice(), out = [];
  while (out.length < count && pool.length) out.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
  return new Set(out.map((l) => l.pos));
}

/** One sparse pattern lit: every located LED must be on if it was lit and off otherwise. */
export function verifyMapping(leds, litSet, patternSignal) {
  let ok = 0, bad = 0;
  const wrong = [];
  for (const l of leds) {
    const on = meanOver(patternSignal, l.pix) / Math.max(1e-6, l.ref) > 0.5;
    if (on === litSet.has(l.pos)) ok++; else { bad++; wrong.push(l.pos); }
  }
  return { ok, bad, wrong };
}

/** Brightest blob centroid of a signal image (LED auto-alignment on the raw camera frame). Handles saturated glows. */
export function brightestSpot(signal, w, h, minPeak = 25) {
  const blur = boxBlurU8(signal, w, h, 2);
  let bi = 0, bv = -1;
  for (let i = 0; i < blur.length; i++) if (blur[i] > bv) { bv = blur[i]; bi = i; }
  if (bv < minPeak) return null;
  let cx = bi % w, cy = (bi / w) | 0;
  const r = Math.max(24, Math.round(Math.min(w, h) * 0.04)), thr = bv * 0.6;
  for (let it = 0; it < 4; it++) { // re-centre on the centroid of the connected-ish bright area
    let sw = 0, sx = 0, sy = 0;
    for (let y = Math.max(0, Math.round(cy) - r); y <= Math.min(h - 1, Math.round(cy) + r); y++) for (let x = Math.max(0, Math.round(cx) - r); x <= Math.min(w - 1, Math.round(cx) + r); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
      const v = blur[y * w + x] - thr;
      if (v > 0) { sw += v; sx += x * v; sy += y * v; }
    }
    if (sw <= 0) break;
    cx = sx / sw; cy = sy / sw;
  }
  return { x: cx, y: cy, peak: bv };
}
