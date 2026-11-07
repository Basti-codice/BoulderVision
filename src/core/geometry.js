// Pure geometry helpers: homography, polygons, corner ordering. No DOM access.

const mul3 = (A, B) => {
  const C = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) C[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j];
  return C;
};

export function invert3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-14) return null;
  const s = 1 / det;
  return [A * s, -(b * i - c * h) * s, (b * f - c * e) * s,
    B * s, (a * i - c * g) * s, -(a * f - c * d) * s,
    C * s, -(a * h - b * g) * s, (a * e - b * d) * s];
}

export function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

function normalizer(pts) {
  let cx = 0, cy = 0;
  for (const [x, y] of pts) { cx += x; cy += y; }
  cx /= pts.length; cy /= pts.length;
  let d = 0;
  for (const [x, y] of pts) d += Math.hypot(x - cx, y - cy);
  d /= pts.length;
  const s = d > 1e-9 ? Math.SQRT2 / d : 1;
  return [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1];
}

/** Least-squares homography mapping src[i] -> dst[i] (n >= 4). Returns flat row-major 3x3 or null. */
export function solveHomography(src, dst) {
  const n = src.length;
  if (n < 4 || dst.length !== n) return null;
  const Ts = normalizer(src), Td = normalizer(dst);
  const S = src.map(([x, y]) => applyH(Ts, x, y));
  const D = dst.map(([x, y]) => applyH(Td, x, y));
  // Normal equations (8x8) for h with h8 = 1.
  const M = Array.from({ length: 8 }, () => new Array(9).fill(0));
  const acc = (row, rhs) => {
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) M[i][j] += row[i] * row[j];
      M[i][8] += row[i] * rhs;
    }
  };
  for (let k = 0; k < n; k++) {
    const [x, y] = S[k], [u, v] = D[k];
    acc([x, y, 1, 0, 0, 0, -x * u, -y * u], u);
    acc([0, 0, 0, x, y, 1, -x * v, -y * v], v);
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let j = c; j < 9; j++) M[r][j] -= f * M[c][j];
    }
  }
  const h = [];
  for (let i = 0; i < 8; i++) h.push(M[i][8] / M[i][i]);
  h.push(1);
  const Tdi = invert3(Td);
  if (!Tdi) return null;
  const H = mul3(Tdi, mul3(h, Ts));
  const s = H[8] || 1;
  return H.map((v) => v / s);
}

/** Homography image -> wall pixels for corners [TL,TR,BR,BL] (image coords). */
export function wallHomography(corners, RW, RH) {
  return solveHomography(corners, [[0, 0], [RW, 0], [RW, RH], [0, RH]]);
}

export function polygonArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

export function polygonCentroid(poly) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    const cr = x1 * y2 - x2 * y1;
    a += cr; cx += (x1 + x2) * cr; cy += (y1 + y2) * cr;
  }
  if (Math.abs(a) < 1e-9) {
    const n = poly.length || 1;
    return [poly.reduce((s, p) => s + p[0], 0) / n, poly.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

export function pointInPolygon(poly, x, y) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** 0 when inside, otherwise distance to the polygon outline. */
export function polygonDistance(poly, x, y) {
  if (pointInPolygon(poly, x, y)) return 0;
  let m = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length];
    m = Math.min(m, distSeg(x, y, ax, ay, bx, by));
  }
  return m;
}

/** Andrew monotone chain. Points: [[x,y],...]. */
export function convexHull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  const up = [];
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  lo.pop(); up.pop();
  return lo.concat(up);
}

/** Visvalingam-style reduction of a (convex) polygon to at most maxVerts vertices. */
export function simplifyPolygon(poly, maxVerts = 8) {
  const pts = poly.slice();
  const tri = (a, b, c) => Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
  while (pts.length > maxVerts) {
    let best = 0, bestA = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const a = tri(pts[(i + pts.length - 1) % pts.length], pts[i], pts[(i + 1) % pts.length]);
      if (a < bestA) { bestA = a; best = i; }
    }
    pts.splice(best, 1);
  }
  return pts;
}

/** Push every vertex away from the centroid by d (approximate outward offset / inward when negative). */
export function offsetPolygon(poly, d) {
  const [cx, cy] = polygonCentroid(poly);
  return poly.map(([x, y]) => {
    const l = Math.hypot(x - cx, y - cy) || 1;
    const k = Math.max(0.2, 1 + d / l);
    return [cx + (x - cx) * k, cy + (y - cy) * k];
  });
}

export function ellipsePolygon(cx, cy, rx, ry, n = 8, rot = 0) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const x = Math.cos(a) * rx, y = Math.sin(a) * ry;
    out.push([cx + x * Math.cos(rot) - y * Math.sin(rot), cy + x * Math.sin(rot) + y * Math.cos(rot)]);
  }
  return out;
}

export function bbox(poly) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of poly) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { x0, y0, x1, y1 };
}

/** Sort four points into [TL, TR, BR, BL] (screen coordinates, y down). */
export function orderCorners(pts) {
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const sorted = pts.slice().sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  let start = 0, m = Infinity;
  sorted.forEach((p, i) => { if (p[0] + p[1] < m) { m = p[0] + p[1]; start = i; } });
  return sorted.slice(start).concat(sorted.slice(0, start));
}

/** True when the quad is convex and has non-trivial area (usable for a homography). */
export function isValidQuad(q) {
  if (q.length !== 4) return false;
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
    const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cr) < 1e-6) return false;
    const s = Math.sign(cr);
    if (sign && s !== sign) return false;
    sign = s;
  }
  return polygonArea(q) > 100;
}

/**
 * Holds that touch can end up with overlapping outlines (their hulls overlap). Pull vertices that lie inside a
 * neighbour back towards their own centre until the outlines separate. Mutates the given holds ({poly, cx, cy}).
 */
export function resolveOverlaps(holds, iterations = 12) {
  const boxes = holds.map((h) => bbox(h.poly));
  const hit = (a, b) => !(a.x1 < b.x0 || b.x1 < a.x0 || a.y1 < b.y0 || b.y1 < a.y0);
  for (let it = 0; it < iterations; it++) {
    let changed = false;
    for (let i = 0; i < holds.length; i++) for (let j = i + 1; j < holds.length; j++) {
      if (!hit(boxes[i], boxes[j])) continue;
      for (const [a, b] of [[holds[i], holds[j]], [holds[j], holds[i]]]) {
        const [cx, cy] = polygonCentroid(a.poly);
        let moved = false;
        a.poly = a.poly.map(([x, y]) => { if (!pointInPolygon(b.poly, x, y)) return [x, y]; moved = true; return [cx + (x - cx) * 0.85, cy + (y - cy) * 0.85]; });
        if (moved) { changed = true; boxes[holds.indexOf(a)] = bbox(a.poly); }
      }
    }
    if (!changed) break;
  }
  for (const h of holds) { const [cx, cy] = polygonCentroid(h.poly); h.cx = cx; h.cy = cy; h.area = polygonArea(h.poly); }
  return holds;
}
