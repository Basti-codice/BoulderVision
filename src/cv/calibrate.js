// LED <-> wall-position calibration for Aurora/Kilter boards.
//
// Idea: light LEDs in Gray-code bit patterns; every glow spot on the (static) camera image
// shows a unique on/off sequence = the LED position. ceil(log2 N) pattern frames + one
// "all on" reference are enough (instead of N frames). All maths here is pure and testable.

export const gray = (p) => p ^ (p >> 1);
export function grayInv(g) { let n = 0; for (; g; g >>= 1) n ^= g; return n; }
export const bitCount = (N) => Math.max(1, Math.ceil(Math.log2(Math.max(2, N))));
export function positionsForBit(N, k) {
  const out = [];
  for (let p = 0; p < N; p++) if ((gray(p) >> k) & 1) out.push(p);
  return out;
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

/** Otsu split of ratio values; returns {t, sep}. Falls back to 0.5 when the two groups are not clearly separated. */
function splitRatios(vals) {
  const bins = 48, hi = 1.5, hist = new Float64Array(bins);
  for (const v of vals) hist[Math.max(0, Math.min(bins - 1, Math.floor((v / hi) * bins)))]++;
  const n = vals.length;
  let sumAll = 0;
  for (let k = 0; k < bins; k++) sumAll += k * hist[k];
  let wB = 0, sumB = 0, best = -1, bt = 0;
  for (let k = 0; k < bins - 1; k++) {
    wB += hist[k]; sumB += k * hist[k];
    const wF = n - wB;
    if (!wB || !wF) continue;
    const mB = sumB / wB, mF = (sumAll - sumB) / wF, v = wB * wF * (mB - mF) ** 2;
    if (v > best) { best = v; bt = k; }
  }
  let lo = 0, loN = 0, up = 0, upN = 0;
  for (const v of vals) { if (v <= ((bt + 1) / bins) * hi) { lo += v; loN++; } else { up += v; upN++; } }
  const mLo = loN ? lo / loN : 0, mHi = upN ? up / upN : 1, sep = mHi - mLo;
  if (!(sep > 0.3) || loN < 3 || upN < 3) return { t: 0.5, sep: 1 };
  return { t: (mLo + mHi) / 2, sep };
}

/**
 * spots: from findSpots(allOnSignal). bitSignals[k]: signal image for bit k pattern.
 * Every spot's brightness in pattern k is compared with its all-on brightness; the on/off threshold is found per
 * pattern from all spots together (so global stray light does not matter).
 * Returns { leds: [{pos,x,y,conf}], rejected: [{reason,x,y,pos?}] }
 */
export function decodeSpots(spots, allSignal, bitSignals, N) {
  const found = [], rejected = [], live = [];
  for (const sp of spots) {
    const iAll = meanOver(allSignal, sp.pix);
    if (iAll <= 0) { rejected.push({ reason: 'dark', x: sp.x, y: sp.y }); continue; }
    live.push({ sp, iAll });
  }
  const ratios = bitSignals.map((sig) => live.map(({ sp, iAll }) => meanOver(sig, sp.pix) / iAll));
  const splits = ratios.map(splitRatios);
  live.forEach(({ sp }, j) => {
    let code = 0, conf = 1;
    bitSignals.forEach((_, k) => {
      const r = ratios[k][j], { t, sep } = splits[k];
      if (r > t) code |= 1 << k;
      conf = Math.min(conf, Math.min(1, Math.abs(r - t) / (sep / 2)));
    });
    const pos = grayInv(code);
    if (pos >= N) { rejected.push({ reason: 'out-of-range', x: sp.x, y: sp.y, pos }); return; }
    found.push({ pos, x: sp.x, y: sp.y, conf, area: sp.area, pix: sp.pix });
  });
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

/** Compare the predicted on/off state of a verification pattern with the measured brightness of every located LED. */
export function verifyMapping(leds, allSignal, pattern, patternSignal) {
  const on = new Set(pattern);
  const ratios = leds.map((l) => meanOver(patternSignal, l.pix) / Math.max(1e-6, meanOver(allSignal, l.pix)));
  const { t } = splitRatios(ratios);
  let ok = 0, bad = 0;
  const wrong = [];
  leds.forEach((l, i) => { if ((ratios[i] > t) === on.has(l.pos)) ok++; else { bad++; wrong.push(l.pos); } });
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
