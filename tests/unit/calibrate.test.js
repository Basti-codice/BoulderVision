import test from 'node:test';
import assert from 'node:assert/strict';
import { scanLayout, spotImage, findSpots, decodeSpots, verifyMapping, pickVerifySet } from '../../src/cv/calibrate.js';
import { rng, gauss } from './helpers.js';

test('layout: every position is lit in exactly one x- and one y-pattern, few LEDs at a time', () => {
  for (const N of [64, 500, 820, 1024, 1500]) {
    const L = scanLayout(N), seen = new Map();
    for (const f of L.frames) for (const p of f.positions) { const e = seen.get(p) || { x: 0, y: 0 }; e[f.axis]++; seen.set(p, e); }
    assert.equal(seen.size, N);
    assert.ok([...seen.values()].every((e) => e.x === 1 && e.y === 1));
    const maxLit = Math.max(...L.frames.map((f) => f.positions.length));
    assert.ok(maxLit <= Math.ceil(Math.sqrt(N)) + 1, `N=${N}: ${maxLit} LEDs at once`);
    assert.ok(L.frames.length <= 2 * Math.ceil(Math.sqrt(N)) + 2);
  }
});

/** Simulated camera signal per pattern: glow per lit LED (+ noise). ring: bright ring around a dimmer centre. */
function simulate({ layout, leds, w = 1000, h = 1000, pxPerCm = 2.8, sigmaCm = 1.6, ring = false, seed = 4 }) {
  const r = rng(seed), byPos = new Map(leds.map((l) => [l.pos, l]));
  return layout.frames.map((f) => {
    const img = new Float32Array(w * h), sigma = sigmaCm * pxPerCm;
    for (const p of f.positions) {
      const l = byPos.get(p); if (!l) continue;
      const R = Math.ceil((ring ? sigmaCm * 1.9 * pxPerCm : sigma) * 3);
      for (let y = Math.max(0, Math.round(l.y) - R); y <= Math.min(h - 1, Math.round(l.y) + R); y++) for (let x = Math.max(0, Math.round(l.x) - R); x <= Math.min(w - 1, Math.round(l.x) + R); x++) {
        const d2 = (x - l.x) ** 2 + (y - l.y) ** 2;
        img[y * w + x] += ring ? l.amp * (0.35 + 0.65 * Math.exp(-((Math.sqrt(d2) - 1.6 * pxPerCm * 1.5) ** 2) / (2 * (0.9 * pxPerCm) ** 2))) * Math.exp(-d2 / (2 * (sigmaCm * 1.9 * pxPerCm) ** 2)) : l.amp * Math.exp(-d2 / (2 * sigma * sigma));
      }
    }
    const out = new Uint8Array(w * h);
    for (let i = 0; i < img.length; i++) out[i] = Math.max(0, Math.min(255, img[i] + 2 + gauss(r) * 2.5));
    return out;
  });
}

function grid({ n, spacing, N, seed, amp = [90, 210], jitter = 8 }) {
  const r = rng(seed), used = new Set(), leds = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    let pos; do { pos = Math.floor(r() * N); } while (used.has(pos)); used.add(pos);
    leds.push({ pos, x: 60 + i * spacing + (r() - 0.5) * jitter, y: 60 + j * spacing + (r() - 0.5) * jitter, amp: amp[0] + r() * (amp[1] - amp[0]) });
  }
  return leds;
}
const run = (layout, leds, opts = {}) => {
  const sig = simulate({ layout, leds, ...opts });
  const spots = findSpots(spotImage(layout, sig), 1000, 1000, 2.8);
  return { sig, spots, ...decodeSpots(spots, sig, layout) };
};
const dist = (truth, o) => { const t = truth.get(o.pos); return t ? Math.hypot(t.x - o.x, t.y - o.y) : Infinity; };

test('decodes 400 LEDs out of 1024 positions exactly', () => {
  const layout = scanLayout(1024), leds = grid({ n: 20, spacing: 46, N: 1024, seed: 11 });
  const { spots, leds: out, rejected } = run(layout, leds);
  assert.equal(spots.length, 400);
  assert.equal(rejected.length, 0);
  const truth = new Map(leds.map((l) => [l.pos, l]));
  assert.equal(out.length, 400);
  assert.ok(out.every((o) => dist(truth, o) < 4), 'every LED has the right number and place');
});

test('dense board (10 cm spacing), overlapping glows, very uneven brightness', () => {
  const layout = scanLayout(1024), leds = grid({ n: 14, spacing: 28, N: 1024, seed: 21, amp: [60, 210], jitter: 4 });
  const { leds: out } = run(layout, leds, { sigmaCm: 2.6 });
  const truth = new Map(leds.map((l) => [l.pos, l]));
  const good = out.filter((o) => dist(truth, o) < 6).length, codeErrors = out.filter((o) => dist(truth, o) > 15);
  assert.ok(good >= 185, `good ${good}/196`);
  assert.ok(codeErrors.every((o) => o.conf < 0.45), 'LED-number errors must be flagged low-confidence');
});

test('ring-shaped glows are located at the ring centre', () => {
  const layout = scanLayout(1024), leds = grid({ n: 14, spacing: 62, N: 1024, seed: 33, amp: [80, 200], jitter: 6 });
  const { spots, leds: out } = run(layout, leds, { ring: true });
  const truth = new Map(leds.map((l) => [l.pos, l]));
  const err = out.map((o) => dist(truth, o)).sort((a, b) => a - b);
  assert.equal(spots.length, 196, 'one spot per ring');
  assert.equal(out.length, 196);
  assert.ok(err[Math.floor(err.length * 0.95)] < 4);
  assert.ok(err.at(-1) < Infinity);
});

test('a dropped pattern (camera glitch) is flagged instead of silently mislabelled', () => {
  const layout = scanLayout(1024), leds = grid({ n: 10, spacing: 80, N: 1024, seed: 5 });
  const sig = simulate({ layout, leds });
  const victim = leds[17], xi = victim.pos % layout.q;
  sig[xi] = new Uint8Array(sig[xi].length); // the x-pattern of one LED is missing
  const spots = findSpots(spotImage(layout, sig.map((s, i) => (i === xi ? sig[(xi + 1) % layout.q] : s))), 1000, 1000, 2.8);
  const { leds: out } = decodeSpots(spots, sig, layout);
  const bad = out.find((o) => Math.hypot(o.x - victim.x, o.y - victim.y) < 6);
  assert.ok(!bad || bad.pos === victim.pos || bad.conf < 0.45, 'wrong label must carry low confidence');
});

test('verification frame detects a wrong mapping', () => {
  const layout = scanLayout(1024), leds = grid({ n: 10, spacing: 80, N: 1024, seed: 8 });
  const { leds: out, sig } = run(layout, leds);
  const lit = pickVerifySet(out, 20, 3), real = simulate({ layout: { frames: [{ positions: [...lit] }] }, leds, seed: 9 })[0];
  assert.deepEqual(verifyMapping(out, lit, real), { ok: out.length, bad: 0, wrong: [] });
  // swap the labels of two LEDs: lighting the "right" positions now lights the wrong spots
  const a = out.find((l) => lit.has(l.pos)), b = out.find((l) => !lit.has(l.pos) && l !== a);
  const swapped = out.map((l) => (l === a ? { ...l, pos: b.pos } : l === b ? { ...l, pos: a.pos } : l));
  assert.ok(verifyMapping(swapped, lit, real).bad >= 2);
});

test('out-of-range codes are rejected', () => {
  const layout = scanLayout(40); // q = 7, Q = 6 -> positions up to 41 exist as codes
  const w = 200, h = 100, sig = layout.frames.map(() => new Uint8Array(w * h));
  const paint = (k, x, y) => { for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) sig[k][(y + dy) * w + x + dx] = 150; };
  paint(layout.q - 1, 100, 50); paint(layout.q + layout.Q - 1, 100, 50); // x = 6, y = 5 -> 41 >= 40
  const spots = findSpots(spotImage(layout, sig), w, h, 2.8);
  const res = decodeSpots(spots, sig, layout);
  assert.ok(res.rejected.some((x) => x.reason === 'out-of-range'));
  assert.equal(res.leds.length, 0);
});
