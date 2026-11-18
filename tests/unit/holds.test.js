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

// ---------- precision: one outline per hold, no doubled / merged / gap-spanning outlines ----------

import { intersectionArea, polygonArea } from '../../src/core/geometry.js';
import { uncertainHolds, DEFAULT_MIN_CONFIDENCE } from '../../src/cv/holds.js';

function loadFixture(name, w, h) {
  const raw = zlib.gunzipSync(fs.readFileSync(new URL(`../fixtures/${name}.rgba.gz`, import.meta.url)));
  return { data: new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.length), width: w, height: h };
}

/** Pairs of outlines whose overlap exceeds `frac` of the smaller one (doubled or merged outlines), before any cutting. */
function overlappingPairs(hs, frac = 0.1) {
  let n = 0;
  for (let i = 0; i < hs.length; i++) for (let j = i + 1; j < hs.length; j++) {
    const a = hs[i], b = hs[j];
    if (Math.hypot(a.cx - b.cx, a.cy - b.cy) > 4 * Math.sqrt(Math.max(a.area, b.area))) continue;
    if (intersectionArea(a.poly, b.poly) > frac * Math.min(polygonArea(a.poly), polygonArea(b.poly))) n++;
  }
  return n;
}

const nestedCount = (hs) => hs.filter((a, i) => hs.some((b, j) => j !== i && b.area > a.area && pointInPolygon(b.poly, a.cx, a.cy))).length;

test('two holds separated by a 1-3 px gap get one outline each, cut on the gap', () => {
  const img = renderWall({ holds: [] });
  const { data, width: w } = img;
  const rect = (x0, y0, x1, y1) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * w + x) * 4; data[i] = data[i + 1] = data[i + 2] = 190; } };
  for (const gap of [1, 2, 3]) { const y = 200 + gap * 200; rect(300, y, 360, y + 30); rect(360 + gap, y, 420 + gap, y + 30); } // 60x30 px each
  const { holds } = detectHolds(analyzeWall(img), { pxPerCm: PX });
  assert.equal(holds.length, 6, holds.map((h) => `${h.cx | 0},${h.cy | 0}:${h.area}`).join(' '));
  for (const h of holds) assert.ok(h.area > 1500 && h.area < 2200, `outline ${h.cx | 0},${h.cy | 0} area ${h.area} (a block is 1800 px)`);
  assert.equal(overlappingPairs(holds, 0.02), 0);
});

// Real photo: ~305 light grey holds with a bolt hole and a darker rim on a black board, many only 1-3 px apart.
// 440x600, wall 2.4 m. Every hold was checked by eye on overlays: one outline per hold, touching pairs cut on the seam.
test('real grey-holds wall: one tight outline per hold, stable over the sensitivity range', () => {
  const seg = segmentHolds(analyzeWall(loadFixture('grey-holds-wall', 440, 600)), 440 / 240);
  const counts = [0.3, 0.4, 0.5, 0.6, 0.8].map((s) => filterHolds(seg, { sensitivity: s }).length);
  console.log('grey-holds wall counts', counts, 'candidates', seg.candidates.length);
  assert.ok(counts.every((n) => n >= 290 && n <= 320), `counts ${counts}`);
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 3, `count varies: ${counts}`);
  const hs = filterHolds(seg, { sensitivity: 0.5 }).map((h) => ({ ...h, poly: h.poly.map((p) => [...p]) }));
  assert.equal(nestedCount(hs), 0, 'nested outlines');
  assert.ok(overlappingPairs(hs) <= 2, `${overlappingPairs(hs)} outline pairs overlap by >10 %`);
  const med = seg.medianArea;
  for (const h of hs) assert.ok(h.area > 0.15 * med && h.area < 3 * med, `outline at ${h.cx | 0},${h.cy | 0}: area ${h.area}, median ${med}`);
  assert.ok(uncertainHolds(seg).length <= 3, 'a clean photo has (almost) no uncertain candidates');
  resolveOverlaps(hs);
  for (let i = 0; i < hs.length; i++) for (let j = i + 1; j < hs.length; j++) assert.ok(!polygonsOverlap(hs[i].poly, hs[j].poly), 'outlines must not overlap');
});

// Far, low-resolution photo of a black overhang panel (~470 white holds incl. small foot chips), rectified by hand from
// a perspective view: 600x600, 3.6 m. The right edge shows a strip of the room wall. Looser: nothing outrageous.
test('real far overhang photo: no huge, nested or duplicated outlines, room wall at the border not taken', () => {
  const seg = segmentHolds(analyzeWall(loadFixture('overhang-far', 600, 600)), 600 / 360);
  const hs = filterHolds(seg, { sensitivity: 0.5 });
  console.log('overhang count', hs.length, 'uncertain', uncertainHolds(seg).length);
  assert.ok(hs.length >= 430 && hs.length <= 500, `count ${hs.length}`);
  assert.ok(hs.every((h) => h.area < 4 * seg.medianArea), 'no huge outline');
  assert.equal(nestedCount(hs), 0, 'nested outlines');
  assert.ok(overlappingPairs(hs) <= 3, `${overlappingPairs(hs)} outline pairs overlap by >10 %`);
  assert.ok(!hs.some((h) => h.cx > 585 && h.area > 0.5 * seg.medianArea), 'room-wall strip at the right border');
});

test('confidence: uncertain candidates are hidden by default, available on request, and are the wall-edge junk', () => {
  const seg = segmentHolds(analyzeWall(loadFixture('dense-wall', 800, 800)), 800 / 360);
  for (const c of seg.candidates) {
    assert.ok(c.confidence >= 0 && c.confidence <= 1);
    assert.ok(Object.values(c.cues).every((v) => v >= 0 && v <= 1));
  }
  const shown = filterHolds(seg, { sensitivity: 1 }), all = filterHolds(seg, { sensitivity: 1, minConfidence: 0 }), unc = uncertainHolds(seg, { sensitivity: 1 });
  assert.ok(shown.every((c) => c.confidence >= DEFAULT_MIN_CONFIDENCE));
  assert.equal(all.length, shown.length + unc.length);
  assert.ok(unc.length >= 1 && unc.length <= 10, `${unc.length} uncertain`);
  // what the default hides here (checked by eye) is junk cut by the image border: a faint smudge at the bottom edge
  // (the dark strip beyond the wall at the right edge no longer produces candidates: the wall colour there is right now)
  assert.ok(unc.every((c) => c.touches), unc.map((c) => `${c.cx | 0},${c.cy | 0}`).join(' '));
  assert.ok(!shown.some((c) => c.cx > 785 && c.cy > 90 && c.cy < 150), 'no outline in the dark strip beyond the right edge');
});

// A light wall with grey holds: dense (holds cover about half of the lower rows), faint light-grey holds in the upper
// left. The wall colour used to be taken from the holds in the crowded lower half (inverted result: only gaps between
// holds were outlined) and the faint holds fell under the global thresholds. 679x680 px, 3.6 m.
test('real light wall: the holds are outlined, not the gaps between them; faint holds are found too', () => {
  const W = 679, px = W / 360, seg = segmentHolds(analyzeWall(loadFixture('light-wall', 679, 680)), px);
  const hs = filterHolds(seg, { sensitivity: 0.5 }), dia = (h) => (2 * Math.sqrt(h.area / Math.PI)) / px;
  const med = hs.map(dia).sort((a, b) => a - b)[hs.length >> 1];
  console.log('light wall count', hs.length, 'median dia', med.toFixed(1));
  assert.ok(hs.length >= 420 && hs.length <= 520, `count ${hs.length}`);
  assert.ok(med > 8, `median diameter ${med.toFixed(1)} cm: outlines of gaps are small`);
  assert.ok(hs.filter((h) => dia(h) < 3.5).length <= 5, 'tiny outlines in the gaps');
  assert.ok(hs.filter((h) => h.cx < 340 && h.cy < 340).length >= 90, 'faint holds in the upper left');
  assert.equal(nestedCount(hs), 0, 'nested outlines');
  assert.ok(overlappingPairs(hs) <= 6, `${overlappingPairs(hs)} outline pairs overlap (cut apart later by resolveOverlaps)`);
});
