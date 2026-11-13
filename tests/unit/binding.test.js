import test from 'node:test';
import assert from 'node:assert/strict';
import { bindLeds } from '../../src/core/binding.js';
import { ellipsePolygon } from '../../src/core/geometry.js';

const hold = (id, x, y, r = 20) => ({ id, cx: x, cy: y, poly: ellipsePolygon(x, y, r, r, 12) });
const PX = 2.8;

test('one LED per hold even when outlines overlap', () => {
  const holds = [hold(1, 100, 100, 30), hold(2, 140, 100, 30)]; // overlapping outlines
  const leds = [{ pos: 7, x: 102, y: 100 }, { pos: 9, x: 138, y: 101 }];
  const { byHold, unmatched } = bindLeds(holds, leds, PX);
  assert.equal(byHold.get(1).pos, 7);
  assert.equal(byHold.get(2).pos, 9);
  assert.equal(unmatched.length, 0);
});

test('an LED in the overlap goes to the closer centre; the other LED keeps its own hold', () => {
  const holds = [hold(1, 100, 100, 30), hold(2, 140, 100, 30)];
  const leds = [{ pos: 1, x: 125, y: 100 }, { pos: 2, x: 92, y: 100 }]; // 25 from hold 1, 15 from hold 2 / clearly hold 1
  const { byHold } = bindLeds(holds, leds, PX);
  assert.equal(byHold.get(2).pos, 1);
  assert.equal(byHold.get(1).pos, 2);
});

test('LEDs without a hold stay unmatched; each LED is used once', () => {
  const holds = [hold(1, 100, 100)];
  const leds = [{ pos: 5, x: 101, y: 99 }, { pos: 6, x: 108, y: 100 }, { pos: 7, x: 400, y: 400 }];
  const { byHold, unmatched } = bindLeds(holds, leds, PX);
  assert.equal(byHold.size, 1);
  assert.equal(byHold.get(1).pos, 5);
  assert.deepEqual(unmatched.map((l) => l.pos).sort(), [6, 7]);
});

test('off-centre ring (bolt hole at the end of a long hold) still binds', () => {
  const long = { id: 1, cx: 200, cy: 100, poly: [[150, 90], [250, 90], [250, 110], [150, 110]] };
  const { byHold } = bindLeds([long], [{ pos: 3, x: 240, y: 100 }], PX);
  assert.equal(byHold.get(1).pos, 3);
});
