import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeWall, detectHolds, fitHoldAt } from '../../src/cv/holds.js';
import { renderWall, gridHolds, rng } from './helpers.js';
import { pointInPolygon } from '../../src/core/geometry.js';

const PX = 2.8; // 1000px / 3.6m

function score(truth, found) {
  let hit = 0;
  const used = new Set();
  for (const t of truth) {
    const i = found.findIndex((f, k) => !used.has(k) && pointInPolygon(f.poly, t.x, t.y));
    if (i >= 0) { used.add(i); hit++; }
  }
  return { recall: hit / truth.length, precision: used.size / Math.max(1, found.length), found: found.length };
}

test('dark wall, light holds, specks and T-nut dots are ignored', () => {
  const holds = gridHolds({ cols: 14, rows: 14, minR: 11, maxR: 22 });
  const r = rng(9), specks = [];
  for (let i = 0; i < 60; i++) specks.push({ x: r() * 1000, y: r() * 1000, r: 1.2 + r() * 1.5, col: [150, 150, 150] }); // < 1.5cm chalk dust
  const img = renderWall({ holds, specks });
  const res = detectHolds(analyzeWall(img), { pxPerCm: PX, sensitivity: 0.5, minDiaCm: 2.5 });
  const s = score(holds, res.holds);
  console.log('dark wall', s);
  assert.ok(s.recall > 0.97, `recall ${s.recall}`);
  assert.ok(s.precision > 0.97, `precision ${s.precision}`);
});

test('wood-coloured wall with lighting gradient and grey holds', () => {
  const holds = gridHolds({ cols: 12, rows: 12, minR: 12, maxR: 22, seed: 8 });
  const img = renderWall({ bg: [205, 160, 100], holdCol: [150, 150, 148], holds, gradient: 0.35, noise: 4, seed: 6 });
  const res = detectHolds(analyzeWall(img), { pxPerCm: PX, sensitivity: 0.5 });
  const s = score(holds, res.holds);
  console.log('wood wall', s);
  assert.ok(s.recall > 0.95, `recall ${s.recall}`);
  assert.ok(s.precision > 0.95, `precision ${s.precision}`);
});

test('touching holds are split by the watershed', () => {
  const holds = [{ x: 400, y: 500, rx: 22, ry: 20, rot: 0 }, { x: 436, y: 500, rx: 20, ry: 20, rot: 0 }, { x: 700, y: 300, rx: 40, ry: 16, rot: 0.5 }];
  const img = renderWall({ holds });
  const res = detectHolds(analyzeWall(img), { pxPerCm: PX });
  assert.equal(res.holds.length, 3);
});

test('sensitivity slider and min size filter behave monotonically', () => {
  const holds = gridHolds({ cols: 10, rows: 10, minR: 6, maxR: 24, seed: 2 });
  const an = analyzeWall(renderWall({ holds }));
  const a = detectHolds(an, { pxPerCm: PX, minDiaCm: 2.5 }).holds.length;
  const auto = detectHolds(an, { pxPerCm: PX }).holds.length; // automatic minimum
  assert.ok(auto <= a && auto > 0);
  const b = detectHolds(an, { pxPerCm: PX, minDiaCm: 6 }).holds.length;
  assert.ok(b < a, `${b} < ${a}`);
});

test('fitHoldAt grows a hold from a single click, returns null on bare wall', () => {
  const holds = [{ x: 500, y: 500, rx: 20, ry: 14, rot: 0.3 }];
  const an = analyzeWall(renderWall({ holds, seed: 2 }));
  const h = fitHoldAt(an, 505, 497, PX);
  assert.ok(h && pointInPolygon(h.poly, 500, 500));
  assert.equal(fitHoldAt(an, 100, 100, PX), null);
});

test('wall-edge strips and long thin streaks are not holds', () => {
  const holds = gridHolds({ cols: 8, rows: 8, minR: 12, maxR: 20, seed: 4 });
  const img = renderWall({ holds, seed: 7 });
  const { data, width: w } = img;
  for (let y = 0; y < 1000; y++) for (let x = 0; x < 14; x++) { const i = (y * w + x) * 4; data[i] = data[i + 1] = data[i + 2] = 215; } // bright strip at the left edge
  for (let x = 300; x < 700; x++) for (let y = 500; y < 508; y++) { const i = (y * w + x) * 4; data[i] = data[i + 1] = data[i + 2] = 170; } // 8px x 400px streak
  const res = detectHolds(analyzeWall(img), { pxPerCm: PX });
  const s = score(holds, res.holds);
  assert.ok(res.holds.every((h) => !(h.cx < 20 && h.diaCm > 8)), 'edge strip rejected');
  assert.ok(s.precision > 0.97 && s.recall > 0.95, JSON.stringify(s));
});
