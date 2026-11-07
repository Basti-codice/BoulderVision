import test from 'node:test';
import assert from 'node:assert/strict';
import { solveHomography, applyH, invert3, orderCorners, isValidQuad, polygonDistance, convexHull, simplifyPolygon, wallHomography } from '../../src/core/geometry.js';

test('homography maps quad to rectangle and back', () => {
  const quad = [[212, 130], [1010, 188], [980, 760], [160, 690]];
  const H = wallHomography(quad, 1000, 800);
  [[0, 0], [1000, 0], [1000, 800], [0, 800]].forEach(([u, v], i) => {
    const [x, y] = applyH(invert3(H), u, v);
    assert.ok(Math.hypot(x - quad[i][0], y - quad[i][1]) < 1e-6);
  });
  const [cx, cy] = applyH(H, 600, 440);
  const [bx, by] = applyH(invert3(H), cx, cy);
  assert.ok(Math.hypot(bx - 600, by - 440) < 1e-6);
});

test('least squares homography with noisy over-determined points', () => {
  const Ht = [1.1, 0.12, 30, -0.05, 0.95, 12, 0.0004, 0.0002, 1];
  const src = [], dst = [];
  for (let i = 0; i < 12; i++) { const x = 50 + (i % 4) * 300, y = 40 + Math.floor(i / 4) * 250; src.push([x, y]); const [u, v] = applyH(Ht, x, y); dst.push([u + (i % 3 - 1) * 0.2, v - (i % 2) * 0.2]); }
  const H = solveHomography(src, dst);
  const [u, v] = applyH(H, 400, 300), [ue, ve] = applyH(Ht, 400, 300);
  assert.ok(Math.hypot(u - ue, v - ve) < 1);
});

test('degenerate input returns null', () => {
  assert.equal(solveHomography([[0, 0], [1, 1], [2, 2], [3, 3]], [[0, 0], [1, 0], [1, 1], [0, 1]]), null);
});

test('orderCorners + isValidQuad', () => {
  const o = orderCorners([[900, 700], [100, 90], [110, 800], [880, 60]]);
  assert.deepEqual(o, [[100, 90], [880, 60], [900, 700], [110, 800]]);
  assert.ok(isValidQuad(o));
  assert.ok(!isValidQuad([[0, 0], [100, 100], [100, 0], [0, 100]])); // bow-tie
});

test('polygon helpers', () => {
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.equal(polygonDistance(sq, 5, 5), 0);
  assert.equal(polygonDistance(sq, 13, 5), 3);
  assert.ok(Math.abs(polygonDistance(sq, 13, 14) - 5) < 1e-9);
  const hull = convexHull([[0, 0], [5, 1], [10, 0], [9, 5], [10, 10], [0, 10], [4, 4]]);
  assert.equal(hull.length, 4);
  assert.equal(simplifyPolygon(hull, 3).length, 3);
});

import { resolveOverlaps, ellipsePolygon, pointInPolygon } from '../../src/core/geometry.js';
import { numberHolds } from '../../src/core/numbering.js';

test('overlapping hold outlines are separated', () => {
  const mk = (id, x) => ({ id, cx: x, cy: 100, poly: ellipsePolygon(x, 100, 30, 20, 10), area: 1800, source: 'auto' });
  const a = mk(1, 100), b = mk(2, 140);
  assert.ok(a.poly.some(([x, y]) => pointInPolygon(b.poly, x, y)), 'test setup overlaps');
  resolveOverlaps([a, b]);
  assert.ok(!a.poly.some(([x, y]) => pointInPolygon(b.poly, x, y)));
  assert.ok(!b.poly.some(([x, y]) => pointInPolygon(a.poly, x, y)));
});

test('numbering is always consecutive and starts at 0 or 1, LED order only changes the order', () => {
  const holds = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, cx: (i % 6) * 100, cy: Math.floor(i / 6) * 100, area: 900, led: i % 3 === 0 ? 700 - i * 20 : undefined }));
  for (const mode of ['rows', 'columns', 'snake', 'size', 'led']) for (const start of [0, 1]) {
    const labels = numberHolds(holds, mode, start).map((h) => h.label).sort((a, b) => a - b);
    assert.deepEqual(labels, Array.from({ length: 30 }, (_, i) => i + start), `${mode} start ${start}`);
  }
  const byLed = numberHolds(holds, 'led', 1).filter((h) => h.led != null).sort((a, b) => a.label - b.label).map((h) => h.led);
  assert.deepEqual(byLed, byLed.slice().sort((a, b) => a - b));
});
