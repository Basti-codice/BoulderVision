import test from 'node:test';
import assert from 'node:assert/strict';
import { ContactTracker } from '../../src/core/contact.js';
import { ellipsePolygon } from '../../src/core/geometry.js';

const holds = [1, 2, 3].map((id) => ({ id, poly: ellipsePolygon(100 + id * 100, 500, 14, 14, 8) })); // x=200,300,400 (r=14px = 5cm at 2.8px/cm)
const PX = 2.8;
const at = (x, y) => [{ x, y }];

function run(tr, frames, dt = 33) { const ev = []; let t = 0; for (const f of frames) { ev.push(...tr.update(t, f)); t += dt; } return ev; }

test('hand dwelling on a hold triggers on, leaving triggers off (hysteresis)', () => {
  const tr = new ContactTracker(holds, PX);
  const frames = [];
  for (let i = 0; i < 10; i++) frames.push({ LH: at(200 + 2 * i, 500) });         // approaching, slow
  for (let i = 0; i < 15; i++) frames.push({ LH: at(204, 500) });                  // dwell
  for (let i = 0; i < 12; i++) frames.push({ LH: at(204, 500 + 8 * i) });         // leaving downward
  const ev = run(tr, frames);
  assert.deepEqual(ev.map((e) => [e.limb, e.hold, e.on]), [['LH', 1, true], ['LH', 1, false]]);
});

test('fast swipe across holds does not trigger', () => {
  const tr = new ContactTracker(holds, PX);
  const frames = [];
  for (let i = 0; i < 40; i++) frames.push({ RH: at(150 + i * 12, 500) }); // 12px/33ms = 130 cm/s
  assert.deepEqual(run(tr, frames), []);
});

test('jitter near the outline does not flicker; short occlusion keeps the contact', () => {
  const tr = new ContactTracker(holds, PX);
  const frames = [];
  for (let i = 0; i < 12; i++) frames.push({ LF: at(300, 500) });
  for (let i = 0; i < 30; i++) frames.push({ LF: at(300 + 22 + (i % 2) * 6, 500) }); // hovering 8-14px right of centre (outline at 14px)
  for (let i = 0; i < 8; i++) frames.push({ LF: null });                              // 264ms lost
  for (let i = 0; i < 5; i++) frames.push({ LF: at(300, 500) });
  const ev = run(tr, frames);
  assert.deepEqual(ev.map((e) => e.on), [true]);
});

test('lost tracking releases after lostMs; hold-to-hold move gives off then on', () => {
  const tr = new ContactTracker(holds, PX, { lostMs: 300 });
  const frames = [];
  for (let i = 0; i < 12; i++) frames.push({ LH: at(200, 500) });
  for (let i = 0; i < 14; i++) frames.push({ LH: null });
  for (let i = 0; i < 12; i++) frames.push({ LH: at(300, 500) });
  const ev = run(tr, frames);
  assert.deepEqual(ev.map((e) => [e.hold, e.on]), [[1, true], [1, false], [2, true]]);
});

test('ghost holds are ignored', () => {
  const tr = new ContactTracker([{ ...holds[0], ghost: true }], PX);
  const frames = []; for (let i = 0; i < 20; i++) frames.push({ LH: at(200, 500) });
  assert.deepEqual(run(tr, frames), []);
});
