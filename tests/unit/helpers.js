export function rng(seed = 1) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function gauss(r) { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); }

/** Synthetic wall: background colour fn + filled ellipses. Returns RGBA image and ground truth. */
export function renderWall({ w = 1000, h = 1000, bg = [30, 30, 32], holdCol = [190, 190, 185], holds = [], specks = [], gradient = 0, noise = 3, seed = 3 }) {
  const r = rng(seed), data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, g = 1 + gradient * (x / w - 0.5);
    for (let c = 0; c < 3; c++) data[i + c] = bg[c] * g + gauss(r) * noise;
    data[i + 3] = 255;
  }
  const fill = (cx, cy, rx, ry, rot, col) => {
    const R = Math.ceil(Math.max(rx, ry)) + 1, cs = Math.cos(rot), sn = Math.sin(rot);
    for (let y = Math.max(0, Math.floor(cy - R)); y <= Math.min(h - 1, cy + R); y++) for (let x = Math.max(0, Math.floor(cx - R)); x <= Math.min(w - 1, cx + R); x++) {
      const dx = x - cx, dy = y - cy, u = dx * cs + dy * sn, v = -dx * sn + dy * cs;
      if ((u / rx) ** 2 + (v / ry) ** 2 <= 1) {
        const i = (y * w + x) * 4, g = 1 + gradient * (x / w - 0.5);
        for (let c = 0; c < 3; c++) data[i + c] = col[c] * g + gauss(r) * noise;
      }
    }
  };
  for (const s of specks) fill(s.x, s.y, s.r, s.r, 0, s.col || holdCol);
  for (const k of holds) fill(k.x, k.y, k.rx, k.ry, k.rot || 0, k.col || holdCol);
  return { data, width: w, height: h };
}

/** Jittered grid of holds with random size/orientation. */
export function gridHolds({ cols = 14, rows = 14, w = 1000, h = 1000, seed = 5, minR = 11, maxR = 24 }) {
  const r = rng(seed), out = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const x = ((i + 0.5 + (j % 2) * 0.25 - 0.12) / cols) * w + (r() - 0.5) * 10;
    const y = ((j + 0.5) / rows) * h + (r() - 0.5) * 12;
    const rx = minR + r() * (maxR - minR), ry = Math.max(minR * 0.8, rx * (0.6 + r() * 0.4));
    out.push({ x, y, rx, ry, rot: r() * Math.PI });
  }
  return out;
}
