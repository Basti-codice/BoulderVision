import test from 'node:test';
import assert from 'node:assert/strict';
import { LatencyMeter } from '../../src/core/latency.js';
import { PRESETS, DEFAULT_PRESET, LIMITS, sanitize, withPreset, withValue, filterParams, resolve } from '../../src/core/responsiveness.js';
import { ContactTracker } from '../../src/core/contact.js';

test('latency meter: median, p95, last and the number of samples ever; the buffer is bounded', () => {
  const m = new LatencyMeter(100);
  assert.equal(m.stats('pose'), null);
  for (let i = 1; i <= 200; i++) m.add('pose', i);
  const s = m.stats('pose');
  assert.equal(s.n, 200, 'counts every sample');
  assert.equal(s.last, 200);
  assert.ok(s.median > 140 && s.median < 160, `median of the last 100 samples (${s.median})`);
  assert.ok(s.p95 >= 195);
  m.add('bad', NaN); m.add('bad', -3); m.add('bad', Infinity);
  assert.equal(m.stats('bad'), null, 'invalid samples are ignored');
  assert.deepEqual(Object.keys(m.snapshot()), ['pose']);
  m.reset();
  assert.equal(m.stats('pose'), null);
});

test('responsiveness: presets are complete and ordered from precise to fast', () => {
  for (const p of Object.values(PRESETS)) for (const k of Object.keys(LIMITS)) assert.ok(p[k] >= LIMITS[k][0] && p[k] <= LIMITS[k][1], k);
  assert.ok(PRESETS.fast.holdMs < PRESETS.balanced.holdMs && PRESETS.balanced.holdMs < PRESETS.precise.holdMs);
  assert.ok(PRESETS.fast.smoothing < PRESETS.balanced.smoothing && PRESETS.balanced.smoothing < PRESETS.precise.smoothing);
  assert.equal(DEFAULT_PRESET, 'balanced');
});

test('responsiveness: sanitize repairs junk, clamps, and keeps custom values', () => {
  assert.deepEqual(sanitize(), { preset: 'balanced', ...PRESETS.balanced });
  assert.deepEqual(sanitize({ preset: 'nonsense', holdMs: 'abc' }), { preset: 'balanced', ...PRESETS.balanced });
  const c = sanitize({ preset: 'custom', holdMs: 5, releaseMs: 9999, maxSpeed: '150', smoothing: 7 });
  assert.deepEqual(c, { preset: 'custom', holdMs: 20, releaseMs: 400, maxSpeed: 150, smoothing: 1 });
  assert.deepEqual(sanitize({ preset: 'fast' }), { preset: 'fast', ...PRESETS.fast });
  assert.equal(sanitize({ preset: 'custom', holdMs: null }).holdMs, PRESETS.balanced.holdMs, 'null is "not set"');
});

test('responsiveness: a preset replaces all numbers, one changed number makes it custom, matching a preset again returns to it', () => {
  const fast = withPreset('fast');
  assert.equal(fast.preset, 'fast');
  const tweaked = withValue(fast, 'holdMs', 45);
  assert.equal(tweaked.preset, 'custom');
  assert.equal(tweaked.holdMs, 45);
  assert.equal(tweaked.releaseMs, PRESETS.fast.releaseMs);
  assert.equal(withValue(tweaked, 'holdMs', PRESETS.fast.holdMs).preset, 'fast');
  assert.deepEqual(withPreset('nope'), sanitize({}));
});

test('responsiveness: more smoothing = lower cut-off and slower opening; resolve() feeds tracker and filter', () => {
  const lo = filterParams(0), hi = filterParams(1);
  assert.ok(Math.abs(lo.minCutoff - 4) < 1e-9 && Math.abs(hi.minCutoff - 1) < 1e-9);
  assert.ok(Math.abs(lo.beta - 0.5) < 1e-9 && Math.abs(hi.beta - 0.02) < 1e-9);
  assert.ok(filterParams(0.5).minCutoff < lo.minCutoff && filterParams(0.5).minCutoff > hi.minCutoff);
  assert.deepEqual(filterParams(9), hi, 'clamped');
  const r = resolve(withPreset('fast'));
  assert.deepEqual(r.tracker, { onMs: 30, offMs: 90, maxSpeedCmS: 160 });
  assert.ok(r.filter.minCutoff > 2.5);
});

test('contact tracker: a contact event says when the limb first hovered over the hold', () => {
  const holds = [{ id: 7, poly: [[0, 0], [20, 0], [20, 20], [0, 20]] }];
  const t = new ContactTracker(holds, 2, { tolCm: 2.5, onMs: 60 });
  const none = t.update(0, { LH: [{ x: 10, y: 10 }] });
  assert.deepEqual(none, []);
  assert.deepEqual(t.update(30, { LH: [{ x: 10, y: 10 }] }), []);
  const ev = t.update(70, { LH: [{ x: 10, y: 10 }] });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].on, true);
  assert.equal(ev[0].since, 0);
  assert.equal(ev[0].t - ev[0].since, 70, 'the debounce the player waited');
  const fast = new ContactTracker(holds, 2, { tolCm: 2.5, onMs: 20 });
  fast.update(0, { LH: [{ x: 10, y: 10 }] });
  assert.equal(fast.update(25, { LH: [{ x: 10, y: 10 }] }).length, 1, 'a shorter hold time counts sooner');
});
