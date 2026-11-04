import test from 'node:test';
import assert from 'node:assert/strict';
import { gray, grayInv, bitCount, positionsForBit, findSpots, decodeSpots } from '../../src/cv/calibrate.js';
import { rng, gauss } from './helpers.js';

test('gray code round trip, single-bit steps', () => {
  for (let p = 0; p < 2048; p++) { assert.equal(grayInv(gray(p)), p); if (p) assert.equal(bitCount(2) && popcount(gray(p) ^ gray(p - 1)), 1); }
  assert.equal(bitCount(500), 9);
  assert.equal(bitCount(512), 9);
  assert.equal(bitCount(513), 10);
});
const popcount = (v) => { let c = 0; for (; v; v &= v - 1) c++; return c; };

/** Simulated camera signal: Gaussian glow per lit LED (+ bleed + noise). */
function simulate({ N, leds, w = 1000, h = 1000, pxPerCm = 2.8, sigmaCm = 1.6, seed = 4, ring = false }) {
  const r = rng(seed);
  const frame = (litSet) => {
    const img = new Float32Array(w * h);
    const sigma = sigmaCm * pxPerCm;
    for (const l of leds) {
      const amp = (litSet.has(l.pos) ? 1 : 0) * l.amp;
      if (!amp) continue;
      const R = Math.ceil(sigma * 3.2);
      for (let y = Math.max(0, Math.round(l.y) - R); y <= Math.min(h - 1, Math.round(l.y) + R); y++) for (let x = Math.max(0, Math.round(l.x) - R); x <= Math.min(w - 1, Math.round(l.x) + R); x++)
        { const d2 = (x - l.x) ** 2 + (y - l.y) ** 2; img[y * w + x] += ring ? amp * (0.35 + 0.65 * Math.exp(-((Math.sqrt(d2) - 1.6 * pxPerCm * 1.5) ** 2) / (2 * (0.9 * pxPerCm) ** 2))) * Math.exp(-d2 / (2 * (sigmaCm * 1.9 * pxPerCm) ** 2)) : amp * Math.exp(-d2 / (2 * sigma * sigma)); }
    }
    const out = new Uint8Array(w * h);
    for (let i = 0; i < img.length; i++) out[i] = Math.max(0, Math.min(255, img[i] + 2 + gauss(r) * 2.5));
    return out;
  };
  const all = new Set(leds.map((l) => l.pos));
  return { all: frame(all), bits: Array.from({ length: bitCount(N) }, (_, k) => frame(new Set(positionsForBit(N, k)))) };
}

test('decodes a 400-LED board with noise and spots every ~11cm', () => {
  const r = rng(11), N = 500, leds = [], pxPerCm = 2.8;
  const used = new Set();
  // 20x20 jittered grid, 10..11 cm spacing; positions are a random subset of 0..N-1 (some LEDs missing)
  for (let j = 0; j < 20; j++) for (let i = 0; i < 20; i++) {
    let pos; do { pos = Math.floor(r() * N); } while (used.has(pos)); used.add(pos);
    leds.push({ pos, x: 60 + i * 46 + (r() - 0.5) * 8, y: 60 + j * 46 + (r() - 0.5) * 8, amp: 90 + r() * 120 });
  }
  const sim = simulate({ N, leds, pxPerCm });
  const spots = findSpots(sim.all, 1000, 1000, pxPerCm);
  assert.equal(spots.length, 400);
  const { leds: out, rejected } = decodeSpots(spots, sim.all, sim.bits, N);
  assert.equal(rejected.length, 0);
  assert.equal(out.length, 400);
  const truth = new Map(leds.map((l) => [l.pos, l]));
  let wrong = 0;
  for (const o of out) { const t = truth.get(o.pos); if (!t || Math.hypot(t.x - o.x, t.y - o.y) > 4) wrong++; }
  assert.equal(wrong, 0);
});

test('rejects duplicates and out-of-range codes instead of guessing', () => {
  const N = 40, w = 200, h = 100, pxPerCm = 2.8;
  const leds = [{ pos: 3, x: 40, y: 50, amp: 150 }, { pos: 20, x: 120, y: 50, amp: 150 }];
  const sim = simulate({ N, leds, w, h, pxPerCm });
  // corrupt: make bit frames for spot 2 look like code of pos 63 (>= N)
  const spots = findSpots(sim.all, w, h, pxPerCm);
  const fake = sim.bits.map((b, k) => { const c = b.slice(); for (const i of spots[1].pix) c[i] = 200; return c; });
  const res = decodeSpots(spots, sim.all, fake, N);
  assert.ok(res.rejected.some((x) => x.reason === 'out-of-range'));
  assert.equal(res.leds.length, 1);
});

test('dense board (10 cm LED spacing), overlapping glows and very uneven brightness', () => {
  const r = rng(21), N = 300, leds = [], pxPerCm = 2.8, used = new Set();
  for (let j = 0; j < 14; j++) for (let i = 0; i < 14; i++) {
    let pos; do { pos = Math.floor(r() * N); } while (used.has(pos)); used.add(pos);
    leds.push({ pos, x: 60 + i * 28 + (r() - 0.5) * 4, y: 60 + j * 28 + (r() - 0.5) * 4, amp: 60 + r() * 150 }); // 28px = 10cm spacing
  }
  const sim = simulate({ N, leds, pxPerCm, sigmaCm: 2.6 });
  const spots = findSpots(sim.all, 1000, 1000, pxPerCm);
  const { leds: out } = decodeSpots(spots, sim.all, sim.bits, N);
  const truth = new Map(leds.map((l) => [l.pos, l]));
  const dist = (o) => { const t = truth.get(o.pos); return t ? Math.hypot(t.x - o.x, t.y - o.y) : Infinity; };
  const good = out.filter((o) => dist(o) < 6).length;
  const codeErrors = out.filter((o) => dist(o) > 15);          // wrong LED number
  assert.ok(good >= 185, `good ${good}/196 (within 6 px / 2 cm)`);
  assert.ok(out.every((o) => dist(o) < 12), 'no position off by more than ~4 cm');
  assert.ok(codeErrors.every((o) => o.conf < 0.45), 'LED-number errors must be flagged low-confidence');
});

test('ring-shaped glows (bright ring around a dimmer, saturated hold) are located at the ring centre', () => {
  const r = rng(33), N = 400, leds = [], pxPerCm = 2.8, used = new Set();
  for (let j = 0; j < 14; j++) for (let i = 0; i < 14; i++) {
    let pos; do { pos = Math.floor(r() * N); } while (used.has(pos)); used.add(pos);
    leds.push({ pos, x: 60 + i * 62 + (r() - 0.5) * 6, y: 60 + j * 62 + (r() - 0.5) * 6, amp: 80 + r() * 120 });
  }
  const sim = simulate({ N, leds, pxPerCm, ring: true });
  const spots = findSpots(sim.all, 1000, 1000, pxPerCm);
  const { leds: out } = decodeSpots(spots, sim.all, sim.bits, N);
  const truth = new Map(leds.map((l) => [l.pos, l]));
  const err = out.map((o) => { const t = truth.get(o.pos); return t ? Math.hypot(t.x - o.x, t.y - o.y) : 99; }).sort((a, b) => a - b);
  assert.equal(spots.length, 196, 'one spot per ring, no duplicates');
  assert.equal(out.length, 196);
  assert.ok(err[Math.floor(err.length * 0.95)] < 4, `p95 error ${err[Math.floor(err.length * 0.95)]}px`);
  assert.ok(err.at(-1) < 99, 'every decoded position exists');
});
