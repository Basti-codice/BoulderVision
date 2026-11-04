import test from 'node:test';
import assert from 'node:assert/strict';
import { SHOWS, showFrame, hsv } from '../../src/outputs/lightshow.js';

const wall = { RW: 1000, RH: 1000 };
const holds = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, label: i + 1, cx: 50 + (i % 10) * 100, cy: 50 + Math.floor(i / 10) * 100 }));

test('every pattern lights something over a few seconds and never returns invalid colours', () => {
  for (const s of SHOWS) {
    let lit = 0;
    for (let t = 0; t < 4; t += 0.1) for (const c of showFrame(s.id, t, holds, wall).values()) { lit++; for (const k of ['r', 'g', 'b']) assert.ok(c[k] >= 0 && c[k] <= 255 && Number.isInteger(c[k]), `${s.id} ${k}=${c[k]}`); }
    assert.ok(lit > 0, `${s.id} never lit`);
  }
});

test('number walk lights exactly one hold, in label order', () => {
  const seq = [0, 0.17, 0.34].map((t) => [...showFrame('numbers', t, holds, wall).keys()]);
  assert.deepEqual(seq, [[1], [2], [3]]);
});

test('sweep-up moves from the bottom to the top', () => {
  const meanY = (t) => { const f = showFrame('sweep-up', t, holds, wall); const ys = holds.filter((h) => f.has(h.id)).map((h) => 1 - h.cy / 1000); return ys.reduce((s, v) => s + v, 0) / ys.length; };
  assert.ok(meanY(2.0) > meanY(0.5) + 0.3);
});

test('hsv basics', () => { assert.deepEqual(hsv(0, 1, 1), { r: 255, g: 0, b: 0 }); assert.deepEqual(hsv(1 / 3, 1, 1), { r: 0, g: 255, b: 0 }); });
