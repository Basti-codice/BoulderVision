// Hold detection on a rectified (front-on) wall image. Pure JS, no OpenCV.
//
// Pipeline:  YCbCr -> local wall colour (per-cell histogram mode, interpolated) -> colour distance map "dE" (+ Otsu)
//            -> half-maximum mask (component tree: every blob cut at half its own contrast, gaps stay open)
//            -> opening -> bolt-hole filling -> distance transform -> persistence watershed (how many holds per blob)
//            -> re-flood from the basin cores along dE (boundary on the seam between touching holds)
//            -> per-region convex outline -> measurements + confidence. Sliders only filter (filterHolds).

import { convexHull, simplifyPolygon, offsetPolygon, polygonArea, polygonCentroid, pointInPolygon } from '../core/geometry.js';

// All tuning constants of the segmentation, with what they mean.

/** A blob's outline lies where its colour distance has fallen to this fraction of the blob's own mean (half-maximum). */
const HALF_MAX_FRACTION = 0.5;
/** Part of a watershed basin deeper than this fraction of its peak distance is unambiguously that basin's hold. */
const CORE_DEPTH = 0.5;
/** Core pixels must also reach this fraction of the deep part's mean dE: a seam between two holds is darker. */
const CORE_SEAM_FRACTION = 0.85;
/** Relative dE step of one flooding level when re-flooding from the cores (8 %: above noise, well below a seam). */
const REFLOOD_STEP = 0.08;
/** Seed level of the mask as a fraction of the photo's Otsu level (permissive: the sliders do the selecting)... */
const SEED_OTSU_FRACTION = 0.5;
/** ...but never below this colour distance... */
const MIN_SEED_LEVEL = 10;
/** ...and no foreground pixel below this fraction of the seed level. */
const FLOOR_SEED_FRACTION = 0.6;
/** Watershed persistence: necks shallower than this (cm, at least MIN_NECK_PX) do not split a blob. */
const NECK_CM = 0.6;
const MIN_NECK_PX = 1.5;
/** Persistence (px) of the second, finer split of glued groups. */
const RETRY_NECK_PX = 1.0;
/** Smallest region (equivalent diameter, cm) that becomes a candidate at all; the minimum-size slider does the rest. */
const MIN_DIA_CM = 1.2;
/** Largest plausible hold (volumes excluded), cm. */
const MAX_DIA_CM = 45;
/** Regions bigger than this (cm) or less solid than GLUED_SOLIDITY are glued groups and get split once more. */
const GLUED_DIA_CM = 22;
const GLUED_SOLIDITY = 0.65;
/** After the finer split a region still less solid than this is dropped. */
const MIN_SOLIDITY = 0.6;
/** Streaks: elongation above MAX_ELONG (or BORDER_MAX_ELONG for regions cut by the image border) is dropped. */
const MAX_ELONG = 5;
const BORDER_MAX_ELONG = 2.6;
/** A candidate whose centre lies inside a candidate more than 1/FRAGMENT_AREA_RATIO times bigger is a fragment of it. */
const FRAGMENT_AREA_RATIO = 0.6;
/** Edge contrast compares the outline with the wall this many px outside it (every EDGE_STRIDE-th edge pixel). */
const CONTRAST_PROBE_PX = 4;
const EDGE_STRIDE = 3;
/** Minimum number of wall samples next to the outline for a contrast value; fewer = surrounded by holds, no penalty. */
const MIN_WALL_SAMPLES = 6;
/** Candidates used for the photo's typical hold (median size / colour distance): solid and clearly coloured. */
const TYPICAL_MIN_SOLIDITY = 0.7;
const TYPICAL_MIN_SCORE_OTSU = 0.6;
/** Automatic minimum size: this fraction of the median hold diameter, at least MIN_AUTO_DIA_CM. */
const AUTO_MIN_DIA_FRACTION = 0.4;
const MIN_AUTO_DIA_CM = 1.5;
/**
 * Tail-free outline: the region's core is its pixels deeper than CORE_CUT_FRACTION of its own radius (at least
 * CORE_CUT_MIN_PX); its hull grown back by CORE_REGROW times that depth is used when the plain hull is more than
 * TAIL_AREA_RATIO times bigger (thin tails / bridges). Needs at least MIN_CORE_PIXELS core edge pixels.
 */
const CORE_CUT_FRACTION = 0.3;
const CORE_CUT_MIN_PX = 1.5;
const CORE_REGROW = 0.9;
const TAIL_AREA_RATIO = 1.15;
const MIN_CORE_PIXELS = 6;
/** Outline: at most this many vertices (UI editing). */
const OUTLINE_MAX_VERTS = 10;
/** Enclosed dark islands up to this diameter (cm) are bolt holes / T-nuts and become part of the hold. */
const BOLT_HOLE_MAX_DIA_CM = 2.5;
/** Default confidence below which filterHolds leaves a candidate out (uncertainHolds lists those). */
export const DEFAULT_MIN_CONFIDENCE = 0.5;
/**
 * Confidence cue ramps [value giving 0, value giving 1] (see confidenceOf), chosen from measured candidates on the
 * real fixtures: edge contrast as a fraction of the photo's Otsu level; solidity; area relative to the median hold
 * (ramps DOWN); elongation (ramps DOWN); for regions touching the image border, the smaller of their colour distance
 * and edge contrast relative to the median hold's, and a factor < 1.
 */
const CONF = {
  contrast: [0.15, 0.45],
  solidity: [0.65, 0.85],
  bigArea: [3, 6],
  elong: [3, 4.5],
  borderLike: [0.5, 0.8],
  borderFactor: 0.8,
};

// ---------- analysis (expensive, once per snapshot) ----------

/**
 * Per grid cell: the two biggest colour clusters (by luma, +-8 bins) with their mean Y/Cb/Cr and share of the cell.
 * Mean colours come from per-bin sums, so no second pass over the pixels is needed.
 */
function cellClusters(Y, Cb, Cr, w, h, gx, gy) {
  const cw = w / gx, chh = h / gy, cells = [], cnt = new Uint32Array(256), sCb = new Float64Array(256), sCr = new Float64Array(256);
  const R = 8;
  for (let cy = 0; cy < gy; cy++) for (let cx = 0; cx < gx; cx++) {
    cnt.fill(0); sCb.fill(0); sCr.fill(0);
    const x0 = Math.floor(cx * cw), x1 = Math.floor((cx + 1) * cw), y0 = Math.floor(cy * chh), y1 = Math.floor((cy + 1) * chh);
    let n = 0;
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { const i = y * w + x, b = Y[i]; cnt[b]++; sCb[b] += Cb[i]; sCr[b] += Cr[i]; n++; }
    const mass = (c) => { let m = 0; for (let k = Math.max(0, c - R); k <= Math.min(255, c + R); k++) m += cnt[k]; return m; };
    const pick = (excl) => {
      let best = -1, bm = 0;
      for (let c = 0; c < 256; c++) { if (excl >= 0 && Math.abs(c - excl) <= 2 * R) continue; const m = mass(c); if (m > bm) { bm = m; best = c; } }
      if (best < 0 || bm < 0.08 * n) return null;
      let m = 0, sy = 0, scb = 0, scr = 0;
      for (let k = Math.max(0, best - R); k <= Math.min(255, best + R); k++) { m += cnt[k]; sy += k * cnt[k]; scb += sCb[k]; scr += sCr[k]; }
      return { y: sy / m, cb: scb / m, cr: scr / m, share: m / n };
    };
    const c1 = pick(-1), c2 = c1 ? pick(Math.round(c1.y)) : null;
    cells.push({ c1: c1 || { y: 0, cb: 128, cr: 128, share: 0 }, c2 });
  }
  return cells;
}

/**
 * Wall colour changes smoothly (lighting, vignette). Fit a smooth surface (quadratic, Tukey-weighted) to the cells
 * where one colour clearly dominates (those are wall), then in crowded cells pick the colour cluster that matches it.
 * In a crowded cell the holds can be the biggest cluster; this keeps them from becoming "background".
 */
function robustSurface(values, gx, gy, w0) {
  const P = 6, n = gx * gy, basis = (u, v) => [1, u, v, u * u, u * v, v * v];
  const U = [], V = [];
  for (let j = 0; j < gy; j++) for (let i = 0; i < gx; i++) { U.push((i + 0.5) / gx * 2 - 1); V.push((j + 0.5) / gy * 2 - 1); }
  let wts = Float64Array.from(w0), coef = new Float64Array(P), scale = 5;
  for (let it = 0; it < 8; it++) {
    const A = Array.from({ length: P }, () => new Float64Array(P + 1));
    for (let k = 0; k < n; k++) { if (!wts[k]) continue; const b = basis(U[k], V[k]); for (let r = 0; r < P; r++) { for (let c = 0; c < P; c++) A[r][c] += wts[k] * b[r] * b[c]; A[r][P] += wts[k] * b[r] * values[k]; } }
    for (let c = 0; c < P; c++) A[c][c] += 1e-6;
    for (let c = 0; c < P; c++) {
      let piv = c; for (let r = c + 1; r < P; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      [A[c], A[piv]] = [A[piv], A[c]];
      for (let r = 0; r < P; r++) { if (r === c) continue; const f = A[r][c] / A[c][c]; for (let k = c; k <= P; k++) A[r][k] -= f * A[c][k]; }
    }
    for (let c = 0; c < P; c++) coef[c] = A[c][P] / A[c][c];
    const res = Array.from({ length: n }, (_, k) => values[k] - basis(U[k], V[k]).reduce((s, v, c) => s + v * coef[c], 0));
    const used = res.filter((_, k) => w0[k]).map(Math.abs).sort((a, b) => a - b);
    scale = Math.max(2.5, 1.4826 * (used[used.length >> 1] || 0));
    wts = Float64Array.from(res, (r, k) => { if (!w0[k]) return 0; const t = r / (4.685 * scale); return Math.abs(t) < 1 ? (1 - t * t) ** 2 : 0; });
  }
  return (k) => basis(U[k], V[k]).reduce((s, v, c) => s + v * coef[c], 0);
}

function backgroundGrid(Y, Cb, Cr, w, h, gx, gy) {
  const cells = cellClusters(Y, Cb, Cr, w, h, gx, gy), n = cells.length;
  let w0 = Float64Array.from(cells, (c) => (c.c1.share >= 0.6 ? 1 : 0));
  if (w0.reduce((s, v) => s + v, 0) < 8) w0 = new Float64Array(n).fill(1); // everything is crowded: trust all cells
  const sy = robustSurface(cells.map((c) => c.c1.y), gx, gy, w0), scb = robustSurface(cells.map((c) => c.c1.cb), gx, gy, w0), scr = robustSurface(cells.map((c) => c.c1.cr), gx, gy, w0);
  const oy = new Float32Array(n), ocb = new Float32Array(n), ocr = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const py = sy(k), pcb = scb(k), pcr = scr(k);
    const err = (c) => Math.abs(c.y - py) + 0.8 * (Math.abs(c.cb - pcb) + Math.abs(c.cr - pcr));
    const cand = [cells[k].c1, cells[k].c2].filter(Boolean).sort((a, b) => err(a) - err(b))[0];
    if (cand && err(cand) < 28) { oy[k] = cand.y; ocb[k] = cand.cb; ocr[k] = cand.cr; } else { oy[k] = py; ocb[k] = pcb; ocr[k] = pcr; }
  }
  return { oy, ocb, ocr };
}

function interpolate(modes, gx, gy, w, h) {
  const out = new Float32Array(w * h), cw = w / gx, chh = h / gy;
  for (let y = 0; y < h; y++) {
    const fy = Math.min(gy - 1, Math.max(0, y / chh - 0.5)), y0 = Math.floor(fy), y1 = Math.min(gy - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(gx - 1, Math.max(0, x / cw - 0.5)), x0 = Math.floor(fx), x1 = Math.min(gx - 1, x0 + 1), tx = fx - x0;
      out[y * w + x] = (modes[y0 * gx + x0] * (1 - tx) + modes[y0 * gx + x1] * tx) * (1 - ty) + (modes[y1 * gx + x0] * (1 - tx) + modes[y1 * gx + x1] * tx) * ty;
    }
  }
  return out;
}

function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h), n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let x = -r; x <= r; x++) s += src[y * w + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = s / n;
      s += src[y * w + Math.min(w - 1, x + r + 1)] - src[y * w + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s / n;
      s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

/** img: {data: RGBA Uint8ClampedArray, width, height}. Returns the colour-distance map. */
export function analyzeWall(img) {
  const { data, width: w, height: h } = img, N = w * h;
  const Y = new Uint8Array(N), Cb = new Uint8Array(N), Cr = new Uint8Array(N);
  for (let i = 0, p = 0; i < N; i++, p += 4) {
    const r = data[p], g = data[p + 1], b = data[p + 2];
    Y[i] = (77 * r + 150 * g + 29 * b) >> 8;
    Cb[i] = ((-43 * r - 85 * g + 128 * b) >> 8) + 128;
    Cr[i] = ((128 * r - 107 * g - 21 * b) >> 8) + 128;
  }
  const gx = 10, gy = Math.max(3, Math.round(h / (w / 10)));
  const g = backgroundGrid(Y, Cb, Cr, w, h, gx, gy);
  const bgY = interpolate(g.oy, gx, gy, w, h), bgCb = interpolate(g.ocb, gx, gy, w, h), bgCr = interpolate(g.ocr, gx, gy, w, h);
  const raw = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const dy = Y[i] - bgY[i], db = Cb[i] - bgCb[i], dr = Cr[i] - bgCr[i];
    raw[i] = Math.sqrt(dy * dy + 1.2 * (db * db + dr * dr));
  }
  const dE = boxBlur(raw, w, h, 1);
  // Otsu on the clipped histogram
  const hist = new Float64Array(256);
  for (let i = 0; i < N; i++) hist[Math.min(255, dE[i] | 0)]++;
  let sumAll = 0;
  for (let k = 0; k < 256; k++) sumAll += k * hist[k];
  let wB = 0, sumB = 0, best = -1, otsu = 20;
  for (let k = 0; k < 256; k++) {
    wB += hist[k];
    if (!wB) continue;
    const wF = N - wB;
    if (!wF) break;
    sumB += k * hist[k];
    const mB = sumB / wB, mF = (sumAll - sumB) / wF, v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) { best = v; otsu = k; }
  }
  return { width: w, height: h, dE, otsu };
}

// ---------- segmentation ----------

function distanceTransform(mask, w, h) {
  const d = new Float32Array(w * h), B = Math.SQRT2;
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? 1e9 : 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!mask[i]) continue;
    let v = d[i];
    if (x > 0) v = Math.min(v, d[i - 1] + 1);
    if (y > 0) {
      v = Math.min(v, d[i - w] + 1);
      if (x > 0) v = Math.min(v, d[i - w - 1] + B);
      if (x < w - 1) v = Math.min(v, d[i - w + 1] + B);
    }
    d[i] = v;
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x;
    if (!mask[i]) continue;
    let v = d[i];
    if (x < w - 1) v = Math.min(v, d[i + 1] + 1);
    if (y < h - 1) {
      v = Math.min(v, d[i + w] + 1);
      if (x < w - 1) v = Math.min(v, d[i + w + 1] + B);
      if (x > 0) v = Math.min(v, d[i + w - 1] + B);
    }
    d[i] = v;
  }
  return d;
}

/** Watershed on the distance map with persistence: shallow necks (< hMerge) do not split a region. */
function watershed(dt, mask, w, h, hMerge) {
  const label = new Int32Array(w * h), parent = [0], peak = [0];
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  let maxB = 0, cnt = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) { cnt++; maxB = Math.max(maxB, Math.round(dt[i] * 4)); }
  const counts = new Int32Array(maxB + 2);
  for (let i = 0; i < mask.length; i++) if (mask[i]) counts[maxB - Math.round(dt[i] * 4) + 1]++;
  for (let b = 1; b < counts.length; b++) counts[b] += counts[b - 1];
  const order = new Int32Array(cnt);
  for (let i = 0; i < mask.length; i++) if (mask[i]) order[counts[maxB - Math.round(dt[i] * 4)]++] = i;
  const roots = [];
  for (let k = 0; k < cnt; k++) {
    const i = order[k], x = i % w, y = (i / w) | 0, L = dt[i];
    roots.length = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const l = label[ny * w + nx];
      if (!l) continue;
      const r = find(l);
      if (!roots.includes(r)) roots.push(r);
    }
    if (!roots.length) { const id = parent.length; parent.push(id); peak.push(L); label[i] = id; continue; }
    let main = roots[0];
    for (const r of roots) if (peak[r] > peak[main]) main = r;
    for (const r of roots) if (r !== main && peak[r] - L < hMerge) parent[r] = main;
    label[i] = main;
  }
  for (let i = 0; i < label.length; i++) if (label[i]) label[i] = find(label[i]);
  return label;
}

function erode(mask, w, h) {
  const out = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    out[i] = mask[i] && mask[i - 1] && mask[i + 1] && mask[i - w] && mask[i + w] ? 1 : 0;
  }
  return out;
}
function dilate(mask, w, h) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    out[i] = mask[i] || (x > 0 && mask[i - 1]) || (x < w - 1 && mask[i + 1]) || (y > 0 && mask[i - w]) || (y < h - 1 && mask[i + w]) ? 1 : 0;
  }
  return out;
}

/**
 * Foreground mask in which every blob is thresholded at HALF ITS OWN contrast instead of at one global level.
 *
 * A single permissive threshold lets the blurred, half-bright pixels in a narrow gap between two holds connect them.
 * The true outline of an object lies where the colour distance has dropped to about half of the object's own level
 * (half-maximum edge), so each blob is cut there. Implemented with a component tree (max-tree) of the upper level sets
 * of dE: pixels are added from the highest dE down, components merge as the level drops. A component is selected as
 * foreground when its level is at least HALF_MAX_FRACTION of its own mean dE, it contains a seed pixel (>= seed), and
 * it is not larger than maxArea; the LARGEST such component on each branch wins. Two holds separated by a gap therefore
 * stay apart as long as the gap is darker than half their brightness, however narrow it is. Pixels below `floor` are
 * never foreground.
 * @param {Float32Array} dE colour-distance map
 * @param {number} w @param {number} h image size
 * @param {number} floor lowest level that can be foreground
 * @param {number} seed a component must contain at least one pixel this strong
 * @param {number} maxArea components bigger than this (px) are never selected as a whole
 * @returns {Uint8Array} mask (1 = hold)
 */
function halfMaxMask(dE, w, h, floor, seed, maxArea) {
  const N = w * h, lev = new Uint8Array(N), cnt = new Int32Array(257);
  for (let i = 0; i < N; i++) { const l = Math.min(255, dE[i] | 0); lev[i] = l; cnt[255 - l + 1]++; }
  for (let b = 1; b < 257; b++) cnt[b] += cnt[b - 1];
  const order = new Int32Array(N);
  for (let i = 0; i < N; i++) order[cnt[255 - lev[i]]++] = i;
  // union-find over pixels (uf < 0: not yet added) and tree nodes (one per distinct component and level)
  const uf = new Int32Array(N).fill(-1), compNode = new Int32Array(N), pixNode = new Int32Array(N).fill(-1);
  const nLevel = new Uint8Array(N), nArea = new Int32Array(N), nSum = new Float64Array(N), nMax = new Float32Array(N);
  const nParent = new Int32Array(N).fill(-1), alias = new Int32Array(N); // alias: nodes merged at the same level
  let nodes = 0;
  const find = (a) => { while (uf[a] !== a) { uf[a] = uf[uf[a]]; a = uf[a]; } return a; };
  const resolve = (n) => { while (alias[n] !== n) { alias[n] = alias[alias[n]]; n = alias[n]; } return n; };
  const absorb = (t, n) => { nArea[t] += nArea[n]; nSum[t] += nSum[n]; if (nMax[n] > nMax[t]) nMax[t] = nMax[n]; };
  const roots = [];
  for (let k = 0; k < N; k++) {
    const p = order[k], L = lev[p];
    if (L < floor) break;
    const x = p % w, y = (p / w) | 0;
    roots.length = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const q = ny * w + nx;
      if (uf[q] < 0) continue;
      const r = find(q);
      if (!roots.includes(r)) roots.push(r);
    }
    // the node at this level: an existing one at level L (others at level L are merged into it) or a new one
    let t = -1;
    for (const r of roots) {
      const n = resolve(compNode[r]);
      if (nLevel[n] !== L || n === t) continue;
      if (t < 0) t = n; else { alias[n] = t; absorb(t, n); }
    }
    if (t < 0) { t = nodes++; nLevel[t] = L; alias[t] = t; }
    for (const r of roots) { const n = resolve(compNode[r]); if (n !== t) { nParent[n] = t; absorb(t, n); } }
    nArea[t]++; nSum[t] += dE[p]; if (dE[p] > nMax[t]) nMax[t] = dE[p];
    uf[p] = p;
    for (const r of roots) uf[r] = p;
    compNode[p] = t; pixNode[p] = t;
  }
  // parents are always created after their children, so a descending pass visits every ancestor first
  const chosen = new Uint8Array(nodes);
  for (let n = nodes - 1; n >= 0; n--) {
    if (alias[n] !== n) continue;
    const par = nParent[n] >= 0 ? resolve(nParent[n]) : -1;
    if (par >= 0 && chosen[par]) { chosen[n] = 1; continue; }
    if (nMax[n] >= seed && nArea[n] <= maxArea && nLevel[n] >= HALF_MAX_FRACTION * (nSum[n] / nArea[n])) chosen[n] = 1;
  }
  const mask = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (pixNode[i] >= 0 && chosen[resolve(pixNode[i])]) mask[i] = 1;
  return mask;
}

/** Background islands that are fully enclosed and small (bolt holes, dark centre of a hold) become foreground. */
function fillSmallHoles(mask, w, h, maxArea) {
  const seen = new Uint8Array(w * h), out = mask.slice();
  for (let s = 0; s < w * h; s++) {
    if (mask[s] || seen[s]) continue;
    const stack = [s], comp = [];
    let touches = false;
    seen[s] = 1;
    while (stack.length) {
      const i = stack.pop(), x = i % w, y = (i / w) | 0;
      comp.push(i);
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touches = true;
      if (comp.length > maxArea) { touches = true; } // too big to be a hole: stop caring about its exact extent
      if (x > 0 && !mask[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack.push(i - 1); }
      if (x < w - 1 && !mask[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack.push(i + 1); }
      if (y > 0 && !mask[i - w] && !seen[i - w]) { seen[i - w] = 1; stack.push(i - w); }
      if (y < h - 1 && !mask[i + w] && !seen[i + w]) { seen[i + w] = 1; stack.push(i + w); }
    }
    if (!touches) for (const i of comp) out[i] = 1;
  }
  return out;
}

/**
 * The distance-transform watershed decides HOW MANY holds a blob holds, but its cut follows the blob's geometry, not
 * the visible seam between two touching holds. Keep only each basin's unambiguous core (deeper than CORE_DEPTH of its
 * own peak) and re-flood the rest of the blob from those cores in order of decreasing colour distance, so the
 * darker seam between two holds is reached last and becomes the boundary. Returns a new label image.
 */
function refloodBySeams(label, dt, dE, w, h) {
  const N = w * h, peak = new Float32Array(N + 1), out = new Int32Array(N);
  for (let i = 0; i < N; i++) if (label[i] && dt[i] > peak[label[i]]) peak[label[i]] = dt[i];
  // bucket queue, brightest first; buckets are REFLOOD_STEP relative steps of dE (noise on a flat hold stays in one
  // bucket, so growth there is breadth-first and even), FIFO within a bucket
  const nb = Math.ceil(Math.log(256) / Math.log(1 + REFLOOD_STEP)) + 1, buckets = Array.from({ length: nb }, () => []), heads = new Int32Array(nb);
  let top = -1;
  const push = (j) => { const q = Math.min(nb - 1, Math.round(Math.log(1 + Math.max(0, dE[j])) / Math.log(1 + REFLOOD_STEP))); buckets[q].push(j); if (q > top) top = q; };
  const pushNeighbours = (i) => {
    const x = i % w, y = (i / w) | 0;
    if (x > 0 && label[i - 1] && !out[i - 1]) push(i - 1);
    if (x < w - 1 && label[i + 1] && !out[i + 1]) push(i + 1);
    if (y > 0 && label[i - w] && !out[i - w]) push(i - w);
    if (y < h - 1 && label[i + w] && !out[i + w]) push(i + w);
  };
  // core: deep in the basin AND not on a seam (dE at least CORE_SEAM_FRACTION of the deep part's mean), connected to
  // the basin's deepest pixel (a core must not reach across a seam into the neighbouring hold)
  const deepSum = new Float64Array(N + 1), deepCnt = new Int32Array(N + 1), seedPix = new Int32Array(N + 1).fill(-1);
  for (let i = 0; i < N; i++) { const l = label[i]; if (l && dt[i] >= CORE_DEPTH * peak[l]) { deepSum[l] += dE[i]; deepCnt[l]++; } }
  const isCoreOf = (j, l) => dt[j] >= CORE_DEPTH * peak[l] && dE[j] >= CORE_SEAM_FRACTION * deepSum[l] / deepCnt[l];
  // seed: the deepest core pixel (the deepest pixel itself can be a filled bolt hole, which is dark)
  for (let i = 0; i < N; i++) { const l = label[i]; if (l && isCoreOf(i, l) && (seedPix[l] < 0 || dt[i] > dt[seedPix[l]])) seedPix[l] = i; }
  const isCore = (j, l) => label[j] === l && !out[j] && isCoreOf(j, l);
  const stack = [];
  for (let l = 1; l <= N; l++) {
    const s0 = seedPix[l];
    if (s0 < 0) continue;
    out[s0] = l; stack.push(s0);
    while (stack.length) {
      const i = stack.pop(), x = i % w, y = (i / w) | 0;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) if (j >= 0 && isCore(j, l)) { out[j] = l; stack.push(j); }
    }
  }
  for (let i = 0; i < N; i++) if (out[i]) pushNeighbours(i);
  while (top >= 0) {
    if (heads[top] === buckets[top].length) { buckets[top].length = 0; heads[top] = 0; top--; continue; }
    const i = buckets[top][heads[top]++];
    if (out[i]) continue;
    const x = i % w, y = (i / w) | 0;
    // join the neighbouring region that reached this pixel through the brightest path (first labelled neighbour)
    out[i] = (x > 0 && out[i - 1]) || (x < w - 1 && out[i + 1]) || (y > 0 && out[i - w]) || (y < h - 1 && out[i + w]);
    pushNeighbours(i);
  }
  return out;
}

/**
 * Statistics per watershed region: area, moments, edge pixels, mean colour distance, deepest distance-transform value,
 * and whether it touches the image border.
 */
function extractRegions(label, dt, dE, w, h) {
  const map = new Map();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, l = label[i];
    if (!l) continue;
    let r = map.get(l);
    if (!r) { r = { id: l, area: 0, sx: 0, sy: 0, sxx: 0, sxy: 0, syy: 0, dE: 0, maxDt: 0, edge: [], core: [], touches: false }; map.set(l, r); }
    r.area++; r.sx += x; r.sy += y; r.sxx += x * x; r.sxy += x * y; r.syy += y * y; r.dE += dE[i];
    if (dt[i] > r.maxDt) r.maxDt = dt[i];
    const border = x === 0 || y === 0 || x === w - 1 || y === h - 1;
    if (border) r.touches = true;
    if (border || label[i - 1] !== l || label[i + 1] !== l || label[i - w] !== l || label[i + w] !== l) r.edge.push([x + 0.5, y + 0.5]);
  }
  // "core" outline: pixels deeper than a fraction of the region's own radius. Thin tails and bridges to neighbours
  // are shallower than that, so the outline built from it follows the hold and not the tails.
  for (const r of map.values()) r.cut = Math.max(CORE_CUT_MIN_PX, CORE_CUT_FRACTION * r.maxDt);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x, l = label[i];
    if (!l) continue;
    const r = map.get(l);
    if (dt[i] < r.cut) continue;
    const deep = (j) => label[j] === l && dt[j] >= r.cut;
    if (!deep(i - 1) || !deep(i + 1) || !deep(i - w) || !deep(i + w)) r.core.push([x + 0.5, y + 0.5]);
  }
  return [...map.values()];
}

/** Elongation (major/minor axis ratio) from the second moments of a region. */
function elongation(r) {
  const n = r.area, mx = r.sx / n, my = r.sy / n;
  const cxx = r.sxx / n - mx * mx + 1 / 12, cyy = r.syy / n - my * my + 1 / 12, cxy = r.sxy / n - mx * my;
  const tr = cxx + cyy, det = cxx * cyy - cxy * cxy, d = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + d, l2 = Math.max(1e-6, tr / 2 - d);
  return Math.sqrt(l1 / l2);
}

function regionToCandidate(r, pxPerCm) {
  const edgeHull = convexHull(r.edge);
  if (edgeHull.length < 3) return null;
  const coreHull = r.core.length >= MIN_CORE_PIXELS ? convexHull(r.core) : [];
  // Prefer the tail-free outline (core grown back by its cut depth) when the region has tails; else the plain hull.
  const grown = coreHull.length >= 3 ? offsetPolygon(coreHull, r.cut * CORE_REGROW) : null;
  const useCore = grown && polygonArea(edgeHull) > TAIL_AREA_RATIO * polygonArea(grown);
  // hull through the outer pixel corners (pixel centres + half a pixel), so a filled convex region has solidity ~1
  const hull = offsetPolygon(useCore ? grown : edgeHull, 0.5), poly = simplifyPolygon(hull, OUTLINE_MAX_VERTS);
  const [cx, cy] = polygonCentroid(poly);
  return {
    cx, cy, poly, area: r.area, solidity: r.area / Math.max(1, polygonArea(hull)), diaCm: (2 * Math.sqrt(r.area / Math.PI)) / pxPerCm,
    score: r.dE / r.area, edge: r.edge, elong: elongation(r), touches: r.touches,
  };
}

/** 0 at or below `lo`, 1 at or above `hi`, linear in between. */
function ramp(v, lo, hi) { return Math.min(1, Math.max(0, (v - lo) / (hi - lo))); }

/**
 * Independent cues (each 0..1, 1 = no doubt) and their product, the candidate's confidence:
 *  - contrast: stands out from the wall right next to its outline (edge contrast / Otsu level of the photo);
 *  - solidity: compact (pixel area / convex outline area); glued groups, tails and shadows are not;
 *  - size: not much bigger than the photo's median hold (glued groups, wall patches); small candidates are left to
 *    the minimum-size slider;
 *  - shape: not a streak (elongation);
 *  - border: a region cut by the image border is either a hold at the wall edge or the surroundings beyond the wall
 *    (frame, floor, ceiling). The latter differ from the holds, so it must stand out from the wall (colour distance
 *    and edge contrast) about as much as the photo's median hold does, and even then stays a little less certain.
 */
function confidenceOf(c, otsu, med) {
  const cues = {
    contrast: ramp(c.contrast / otsu, CONF.contrast[0], CONF.contrast[1]),
    solidity: ramp(c.solidity, CONF.solidity[0], CONF.solidity[1]),
    size: 1 - ramp(c.area / Math.max(1, med.area), CONF.bigArea[0], CONF.bigArea[1]),
    shape: 1 - ramp(c.elong, CONF.elong[0], CONF.elong[1]),
    border: c.touches ? CONF.borderFactor * ramp(Math.min(c.score / Math.max(1, med.score), c.contrast / Math.max(1, med.contrast)), CONF.borderLike[0], CONF.borderLike[1]) : 1,
  };
  return { cues, confidence: Object.values(cues).reduce((p, v) => p * v, 1) };
}

const SEG_VERSION = 4;

/**
 * Segment the wall ONCE per photo into hold candidates, each with measurements (colour distance to the wall, edge
 * contrast, size, shape) and a confidence. The sliders only filter these candidates (filterHolds), so they are
 * instant, monotone (more sensitive = superset) and never re-segment. Result is cached on the analysis.
 *
 * Steps: half-maximum mask (every blob cut at half its own contrast, so narrow gaps between holds stay open) ->
 * opening -> bolt-hole filling -> distance-transform watershed (how many holds a blob holds) -> re-flood from the
 * basin cores along the colour distance (where the boundary between touching holds lies) -> per-region outline ->
 * nested-fragment merge -> edge contrast -> confidence.
 *
 * @param {{width:number,height:number,dE:Float32Array,otsu:number}} analysis result of analyzeWall
 * @param {number} pxPerCm image scale
 * @returns {{version:number,pxPerCm:number,candidates:object[],medianDia:number,medianArea:number,minDiaEff:number,otsu:number}}
 *   candidates[i]: {idx, cx, cy, poly, area (px), diaCm, score (mean colour distance), contrast (score minus the wall
 *   next to the outline), solidity, elong, touches (image border), confidence (0..1),
 *   cues {contrast, solidity, size, shape, border} (each 0..1; confidence is their product)}
 */
export function segmentHolds(analysis, pxPerCm) {
  if (analysis._seg && analysis._seg.pxPerCm === pxPerCm && analysis._seg.version === SEG_VERSION) return analysis._seg;
  const { width: w, height: h, dE, otsu } = analysis;
  const seed = Math.max(MIN_SEED_LEVEL, otsu * SEED_OTSU_FRACTION), floor = seed * FLOOR_SEED_FRACTION;
  let mask = halfMaxMask(dE, w, h, floor, seed, Math.PI * (MAX_DIA_CM / 2 * pxPerCm) ** 2);
  mask = dilate(erode(mask, w, h), w, h);                             // opening: kills specks / thin streaks
  mask = fillSmallHoles(mask, w, h, Math.round(Math.PI * (BOLT_HOLE_MAX_DIA_CM / 2 * pxPerCm) ** 2)); // bolt holes must not split a hold
  const dt = distanceTransform(mask, w, h);
  const label = refloodBySeams(watershed(dt, mask, w, h, Math.max(MIN_NECK_PX, NECK_CM * pxPerCm)), dt, dE, w, h);
  const cands = [], retry = new Set();
  const accept = (r, strict) => {
    const dia = (2 * Math.sqrt(r.area / Math.PI)) / pxPerCm;
    if (dia < MIN_DIA_CM || dia > MAX_DIA_CM) return 'drop';
    const el = elongation(r);
    if (el > MAX_ELONG || (r.touches && el > BORDER_MAX_ELONG)) return 'drop';
    const c = regionToCandidate(r, pxPerCm);
    if (!c) return 'drop';
    if (c.solidity < (strict ? MIN_SOLIDITY : GLUED_SOLIDITY) || (!strict && dia > GLUED_DIA_CM)) return strict ? 'drop' : 'retry'; // glued group: split harder
    cands.push(c);
    return 'ok';
  };
  for (const r of extractRegions(label, dt, dE, w, h)) if (accept(r, false) === 'retry') retry.add(r.id);
  if (retry.size) { // second chance: re-split only the glued groups with the finest setting instead of throwing them away
    const m2 = new Uint8Array(w * h);
    for (let i = 0; i < m2.length; i++) if (retry.has(label[i])) m2[i] = 1;
    const dt2 = distanceTransform(m2, w, h), label2 = refloodBySeams(watershed(dt2, m2, w, h, RETRY_NECK_PX), dt2, dE, w, h);
    for (const r of extractRegions(label2, dt2, dE, w, h)) accept(r, true);
  }
  // a fragment that lies inside a clearly bigger candidate is part of that hold
  cands.sort((a, b) => b.area - a.area);
  const kept = [];
  for (const c of cands) if (!kept.some((b) => c.area < FRAGMENT_AREA_RATIO * b.area && pointInPolygon(b.poly, c.cx, c.cy))) kept.push(c);
  // edge contrast: colour distance inside minus the wall right next to the outline (not neighbouring holds)
  for (const c of kept) {
    let sum = 0, n = 0;
    for (let k = 0; k < c.edge.length; k += EDGE_STRIDE) {
      const [ex, ey] = c.edge[k];
      for (const [dx, dy] of [[CONTRAST_PROBE_PX, 0], [-CONTRAST_PROBE_PX, 0], [0, CONTRAST_PROBE_PX], [0, -CONTRAST_PROBE_PX]]) {
        const x = Math.round(ex + dx), y = Math.round(ey + dy);
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const j = y * w + x;
        if (!label[j] && !mask[j]) { sum += dE[j]; n++; }
      }
    }
    c.contrast = n >= MIN_WALL_SAMPLES ? c.score - sum / n : c.score; // fully surrounded by holds: nothing to compare with, no penalty
    delete c.edge;
  }
  kept.sort((a, b) => a.cy - b.cy || a.cx - b.cx);
  kept.forEach((c, i) => { c.idx = i; });
  const good = kept.filter((c) => c.solidity >= TYPICAL_MIN_SOLIDITY && c.score >= TYPICAL_MIN_SCORE_OTSU * otsu);
  const median = (v) => (v.length ? v.sort((a, b) => a - b)[v.length >> 1] : 0);
  const medianDia = median(good.map((c) => c.diaCm)), medianArea = median(good.map((c) => c.area));
  const med = { area: medianArea, score: median(good.map((c) => c.score)), contrast: median(good.map((c) => c.contrast)) };
  for (const c of kept) Object.assign(c, confidenceOf(c, otsu, med));
  analysis._seg = { version: SEG_VERSION, pxPerCm, candidates: kept, medianDia, medianArea, minDiaEff: Math.max(MIN_AUTO_DIA_CM, AUTO_MIN_DIA_FRACTION * medianDia), otsu };
  return analysis._seg;
}

/**
 * Pick candidates by the slider values. All criteria are simple thresholds on measurements, so raising sensitivity
 * can only ADD holds.
 * @param {object} seg result of segmentHolds
 * @param {object} [o]
 * @param {number} [o.sensitivity=0.5] 0..1: weakest accepted colour distance
 * @param {number} [o.contrast=0.25] 0..1: weakest accepted edge contrast (0 = off)
 * @param {number} [o.minDiaCm=0] 0 = automatic (fixed per photo)
 * @param {number} [o.maxDiaCm=30]
 * @param {{x0:number,y0:number,x1:number,y1:number}|null} [o.region] only holds centred inside
 * @param {number} [o.minConfidence=DEFAULT_MIN_CONFIDENCE] candidates below this confidence are left out; pass 0 to
 *   include the uncertain ones too ("show uncertain")
 * @returns {object[]} the selected candidates (the stored objects, not copies)
 */
export function filterHolds(seg, { sensitivity = 0.5, contrast = 0.25, minDiaCm = 0, maxDiaCm = 30, region = null, minConfidence = DEFAULT_MIN_CONFIDENCE } = {}) {
  const minScore = seg.otsu * (1.05 - 0.75 * sensitivity), minContrast = seg.otsu * 0.7 * contrast, minDia = minDiaCm > 0 ? minDiaCm : seg.minDiaEff;
  return seg.candidates.filter((c) => c.score >= minScore && c.contrast >= minContrast && c.diaCm >= minDia && c.diaCm <= maxDiaCm
    && c.confidence >= minConfidence
    && !(region && (c.cx < region.x0 || c.cx > region.x1 || c.cy < region.y0 || c.cy > region.y1)));
}

/**
 * Candidates that pass the sliders but NOT the confidence threshold: what a "show uncertain" view adds.
 * @param {object} seg result of segmentHolds
 * @param {object} [params] same options as filterHolds
 * @returns {object[]}
 */
export function uncertainHolds(seg, params = {}) {
  const minConfidence = params.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  return filterHolds(seg, { ...params, minConfidence: 0 }).filter((c) => c.confidence < minConfidence);
}

/**
 * Convenience (tests, single calls): segment (cached) and filter.
 * @param {object} analysis result of analyzeWall
 * @param {object} params filterHolds options plus pxPerCm
 * @returns {{holds: object[], thresholds: {otsu:number, minDiaEff:number, medianDia:number}}} holds are copies
 */
export function detectHolds(analysis, params) {
  const seg = segmentHolds(analysis, params.pxPerCm);
  return { holds: filterHolds(seg, params).map((c) => ({ ...c })), thresholds: { otsu: seg.otsu, minDiaEff: seg.minDiaEff, medianDia: seg.medianDia } };
}

/** Grow a single hold around a click. Returns a hold or null. */
export function fitHoldAt(analysis, x, y, pxPerCm) {
  const { width: w, height: h, dE } = analysis;
  const R = Math.round(9 * pxPerCm);
  let bx = Math.round(x), by = Math.round(y), bv = -1;
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
    const px = bx + dx, py = by + dy;
    if (px < 0 || py < 0 || px >= w || py >= h) continue;
    const v = dE[py * w + px];
    if (v > bv) { bv = v; bx = px; by = py; }
  }
  if (bv < 6) return null;
  const maxArea = Math.PI * Math.pow(7 * pxPerCm, 2);
  let thr = Math.max(5, bv * 0.45);
  for (let attempt = 0; attempt < 6; attempt++, thr *= 1.25) {
    const seen = new Uint8Array(w * h), stack = [by * w + bx], pts = [];
    seen[by * w + bx] = 1;
    let area = 0, tooBig = false;
    while (stack.length) {
      const i = stack.pop(), px = i % w, py = (i / w) | 0;
      area++; pts.push([px + 0.5, py + 0.5]);
      if (area > maxArea) { tooBig = true; break; }
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = px + dx, ny = py + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || Math.abs(nx - bx) > R || Math.abs(ny - by) > R) continue;
        const j = ny * w + nx;
        if (!seen[j] && dE[j] >= thr) { seen[j] = 1; stack.push(j); }
      }
    }
    if (tooBig) continue;
    if (area < Math.PI * Math.pow(0.8 * pxPerCm, 2)) return null;
    const hull = convexHull(pts);
    if (hull.length < 3) return null;
    const poly = simplifyPolygon(offsetPolygon(hull, 0.5), 10);
    const [cx, cy] = polygonCentroid(poly);
    return { cx, cy, poly, area, solidity: area / Math.max(1, polygonArea(hull)), diaCm: (2 * Math.sqrt(area / Math.PI)) / pxPerCm };
  }
  return null;
}
