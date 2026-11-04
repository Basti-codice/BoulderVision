import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMessage, decodeStream, encodeColor, AuroraBoard, MockTransport, decodeColor } from '../../src/board/aurora.js';

// Reference implementation copied 1:1 from the supplied board.js, to guard against regressions.
function refMessage(leds) {
  const enc = (r, g, b) => ((r >> 5) << 5) | ((g >> 5) << 2) | (b >> 6);
  const fr = (payload) => { let s = 0; for (const x of payload) s = (s + x) & 0xff; return [0x01, payload.length & 0xff, ~s & 0xff, 0x02, ...payload, 0x03]; };
  const groups = [];
  if (leds.length <= 84) groups.push(leds); else for (let i = 0; i < leds.length; i += 84) groups.push(leds.slice(i, i + 84));
  const out = [];
  groups.forEach((g, i) => {
    const cmd = groups.length === 1 ? 84 : i === 0 ? 82 : i === groups.length - 1 ? 83 : 81;
    const p = [cmd]; for (const l of g) p.push(l.pos & 0xff, (l.pos >> 8) & 0xff, enc(l.r, l.g, l.b)); out.push(...fr(p));
  });
  return Uint8Array.from(out);
}

test('buildMessage matches the reference implementation', () => {
  for (const n of [0, 1, 5, 84, 85, 168, 169, 500]) {
    const leds = Array.from({ length: n }, (_, i) => ({ pos: i * 3, r: (i * 37) % 256, g: (i * 91) % 256, b: (i * 53) % 256 }));
    assert.deepEqual([...buildMessage(leds)], [...refMessage(leds)]);
  }
  assert.equal(Buffer.from(buildMessage([])).toString('hex'), '0101ab025403');
  assert.equal(Buffer.from(buildMessage([{ pos: 12, r: 0, g: 255, b: 0 }])).toString('hex'), '01048302540c001c03');
});

test('colour encoding 3-3-2', () => {
  assert.equal(encodeColor(255, 0, 0), 0xe0);
  assert.equal(encodeColor(0, 255, 0), 0x1c);
  assert.equal(encodeColor(0, 0, 255), 0x03);
  assert.equal(encodeColor(255, 255, 255), 0xff);
  assert.deepEqual(decodeColor(0x1c), { r: 0, g: 252, b: 0 });
});

test('multi-frame commands and stream decoding', () => {
  const leds = Array.from({ length: 200 }, (_, i) => ({ pos: i, r: 255, g: 0, b: 0 }));
  const frames = decodeStream(buildMessage(leds));
  assert.deepEqual(frames.map((f) => [f.cmd, f.leds.length]), [[82, 84], [81, 84], [83, 32]]);
  assert.equal(frames[2].leds[31].pos, 199);
  assert.throws(() => buildMessage([{ pos: 70000, r: 0, g: 0, b: 0 }]), RangeError);
  assert.throws(() => buildMessage([{ pos: 1, r: 300, g: 0, b: 0 }]), RangeError);
});

test('board: chunking, safe diff updates, allOff', async () => {
  const frames = [], sizes = [];
  const t = new MockTransport((bytes) => frames.push(...decodeStream(bytes)));
  const origWrite = t.write.bind(t);
  t.write = async (c) => { sizes.push(c.length); return origWrite(c); };
  const b = new AuroraBoard(t);
  b.delay = 0;
  await b.connect();
  await b.setLeds([{ pos: 5, r: 0, g: 255, b: 0 }, { pos: 9, r: 0, g: 255, b: 0 }]);
  await b.setLeds([{ pos: 9, r: 255, g: 0, b: 0 }]);
  // second frame must switch 5 off explicitly (black) and recolour 9
  const last = frames.at(-1).leds.map((l) => [l.pos, l.color]);
  assert.deepEqual(last, [[5, 0], [9, 0xe0]]);
  assert.ok(sizes.every((s) => s <= 20));
  b.setKnownPositions([1, 2, 3]);
  await b.allOff();
  assert.deepEqual(frames.at(-2).leds, []); // clear frame
  assert.deepEqual(frames.at(-1).leds.map((l) => l.pos), [1, 2, 3, 9]);
  assert.equal(b.lit.size, 0);
});

test('board: retries a failing chunk and slows down', async () => {
  let fail = 1, got = [];
  const t = new MockTransport((bytes) => got.push(bytes));
  const w = t.write.bind(t);
  t.write = async (c) => { if (fail-- > 0) throw new Error('GATT busy'); return w(c); };
  const b = new AuroraBoard(t);
  b.delay = 0;
  await b.connect();
  await b.setLeds([{ pos: 1, r: 255, g: 255, b: 255 }]);
  assert.equal(got.length, 1);
  assert.ok(b.delay >= 20);
});
