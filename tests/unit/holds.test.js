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

import { resolveOverlaps, polygonsOverlap } from '../../src/core/geometry.js';

for (const [name, o] of [['dense wall with strong vignette (crowded edge cells)', { cols: 22, rows: 22, minR: 12, maxR: 21, seed: 5, vig: 0.7 }], ['very dense wall, holds nearly touching', { cols: 26, rows: 26, minR: 11, maxR: 19, seed: 9, vig: 0.4 }]]) {
  test(name, () => {
    const holds = gridHolds({ cols: o.cols, rows: o.rows, minR: o.minR, maxR: o.maxR, seed: o.seed });
    const img = renderWall({ holds, vignette: o.vig, noise: 5, bg: [70, 70, 74], holdCol: [205, 205, 200] });
    const res = detectHolds(analyzeWall(img), { pxPerCm: PX });
    resolveOverlaps(res.holds);
    const s = score(holds, res.holds);
    let overlaps = 0;
    for (let i = 0; i < res.holds.length; i++) for (let j = i + 1; j < res.holds.length; j++) if (polygonsOverlap(res.holds[i].poly, res.holds[j].poly)) overlaps++;
    assert.ok(s.recall > 0.97, `recall ${s.recall}`);
    assert.ok(s.precision > 0.97, `precision ${s.precision}`);
    assert.equal(overlaps, 0, 'outlines must not overlap');
  });
}

import fs from 'node:fs';
import zlib from 'node:zlib';
import { segmentHolds, filterHolds } from '../../src/cv/holds.js';

// Real photo of a very dense wall (bolt-hole in every hold, holds almost touching, ~490 holds) that exposed duplicate
// outlines and a chaotic sensitivity slider. 800x800, wall assumed 3.6 m.
test('real dense wall photo: stable count, monotone sliders, no duplicate outlines', () => {
  const raw = zlib.gunzipSync(fs.readFileSync(new URL('../fixtures/dense-wall.rgba.gz', import.meta.url)));
  const img = { data: new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.length), width: 800, height: 800 };
  const seg = segmentHolds(analyzeWall(img), 800 / 360);
  const at = (s) => filterHolds(seg, { sensitivity: s });
  const counts = [0.2, 0.4, 0.5, 0.6, 0.8].map((s) => at(s).length);
  assert.ok(counts.every((n) => n > 440 && n < 540), `counts ${counts}`);
  assert.ok((Math.max(...counts) - Math.min(...counts)) / Math.min(...counts) < 0.06, `count varies too much: ${counts}`);
  // monotone: a more sensitive setting never loses a hold
  const ids = [0, 0.25, 0.5, 0.75, 1].map((s) => new Set(at(s).map((h) => h.idx)));
  for (let i = 1; i < ids.length; i++) for (const id of ids[i - 1]) assert.ok(ids[i].has(id), 'sensitivity must only add holds');
  // one outline per hold
  const hs = at(0.5).map((h) => ({ ...h }));
  const nested = hs.filter((a, i) => hs.some((b, j) => j !== i && b.area > a.area && pointInPolygon(b.poly, a.cx, a.cy))).length;
  assert.ok(nested <= hs.length * 0.01, `${nested} nested outlines`);
  resolveOverlaps(hs);
  for (let i = 0; i < hs.length; i++) for (let j = i + 1; j < hs.length; j++) assert.ok(!polygonsOverlap(hs[i].poly, hs[j].poly), 'outlines must not overlap');
  // the automatic minimum size is fixed per photo: the sliders cannot change it
  assert.equal(filterHolds(seg, { sensitivity: 1 }).length >= filterHolds(seg, { sensitivity: 0 }).length, true);
});
