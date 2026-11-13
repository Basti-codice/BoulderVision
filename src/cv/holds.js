// Hold detection on a rectified (front-on) wall image. Pure JS, no OpenCV.
//
// Pipeline:  YCbCr -> local wall colour (per-cell histogram mode, interpolated)
//            -> colour distance map "dE" -> Otsu + hysteresis threshold
//            -> opening -> distance transform -> persistence watershed (splits touching holds)
//            -> per-region convex hull, filtered by size / shape.

import { convexHull, simplifyPolygon, offsetPolygon, polygonArea, polygonCentroid } from '../core/geometry.js';

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

function hysteresis(dE, w, h, low, high) {
  const out = new Uint8Array(w * h), stack = [];
  for (let i = 0; i < out.length; i++) if (dE[i] >= high) { out[i] = 1; stack.push(i); }
  while (stack.length) {
    const i = stack.pop(), x = i % w, y = (i / w) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (!out[j] && dE[j] >= low) { out[j] = 1; stack.push(j); }
    }
  }
  return out;
}

function regionsFromLabels(label, w, h) {
  const map = new Map();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const l = label[y * w + x];
    if (!l) continue;
    let r = map.get(l);
    if (!r) { r = { area: 0, sx: 0, sy: 0, sxx: 0, sxy: 0, syy: 0, edge: [], touches: false }; map.set(l, r); }
    r.area++; r.sx += x; r.sy += y; r.sxx += x * x; r.sxy += x * y; r.syy += y * y;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1) r.touches = true;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || label[y * w + x - 1] !== l || label[y * w + x + 1] !== l || label[(y - 1) * w + x] !== l || label[(y + 1) * w + x] !== l) r.edge.push([x + 0.5, y + 0.5]);
  }
  return map;
}

/** Elongation (major/minor axis ratio) from the second moments of a region. */
function elongation(r) {
  const n = r.area, mx = r.sx / n, my = r.sy / n;
  const cxx = r.sxx / n - mx * mx + 1 / 12, cyy = r.syy / n - my * my + 1 / 12, cxy = r.sxy / n - mx * my;
  const tr = cxx + cyy, det = cxx * cyy - cxy * cxy, d = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + d, l2 = Math.max(1e-6, tr / 2 - d);
  return Math.sqrt(l1 / l2);
}

function toHold(r, pxPerCm) {
  const hull = convexHull(r.edge);
  if (hull.length < 3) return null;
  const poly = simplifyPolygon(offsetPolygon(hull, 0.5), 10);
  const [cx, cy] = polygonCentroid(poly);
  const hullArea = polygonArea(hull);
  return {
    cx, cy, poly,
    area: r.area,
    solidity: r.area / Math.max(1, hullArea),
    diaCm: (2 * Math.sqrt(r.area / Math.PI)) / pxPerCm,
  };
}

/**
 * analysis: result of analyzeWall.  params:
 *  sensitivity 0..1 (default .5), minDiaCm, maxDiaCm, pxPerCm, region {x0,y0,x1,y1}? (only keep holds whose centre lies inside)
 */
export function detectHolds(analysis, params) {
  const { width: w, height: h, dE, otsu } = analysis;
  const { sensitivity = 0.5, minDiaCm = 0, maxDiaCm = 30, pxPerCm, region = null } = params;
  const high = Math.max(10, otsu * (1.3 - 0.7 * sensitivity));
  const low = high * 0.6;
  let mask = hysteresis(dE, w, h, low, high);
  mask = dilate(erode(mask, w, h), w, h); // opening: kills specks / thin streaks
  const dt = distanceTransform(mask, w, h);
  const label = watershed(dt, mask, w, h, Math.max(1.0, 0.28 * pxPerCm)); // small: touching holds must separate
  // candidates: plausible size and shape (wall frames, edges and streaks are long and thin)
  const cands = [];
  for (const r of regionsFromLabels(label, w, h).values()) {
    const dia = (2 * Math.sqrt(r.area / Math.PI)) / pxPerCm;
    if (dia < 1.2 || dia > maxDiaCm) continue;
    const el = elongation(r);
    if (el > 5 || (r.touches && el > 2.6)) continue;
    cands.push({ r, dia });
  }
  // minDiaCm = 0 means "automatic": a fraction of the typical hold, so specks never count whatever the wall size input
  const dias = cands.map((c) => c.dia).sort((a, b) => a - b);
  const median = dias.length ? dias[dias.length >> 1] : 0;
  const minEff = minDiaCm > 0 ? minDiaCm : Math.max(1.5, 0.4 * median);
  const out = [];
  for (const { r, dia } of cands) {
    if (dia < minEff) continue;
    const hold = toHold(r, pxPerCm);
    if (!hold || hold.solidity < 0.55) continue;
    if (region && (hold.cx < region.x0 || hold.cx > region.x1 || hold.cy < region.y0 || hold.cy > region.y1)) continue;
    out.push(hold);
  }
  return { holds: out, thresholds: { low, high, otsu, minDiaEff: minEff, medianDia: median } };
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
