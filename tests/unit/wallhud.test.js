import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLayout, composeWall, isReserved, MAX_GAME_LEDS, GO_MS } from '../../src/game/wallhud.js';
import { rng } from '../../src/core/rng.js';

const PX = 2.8;
/** 24 x 24 LEDs at ~14 cm spacing with a little position jitter (hold centres are not exact), plus two junk LEDs outside. */
function board(seed = 3) {
  const r = rng(seed), leds = [];
  let pos = 1;
  for (let row = 0; row < 24; row++) for (let col = 0; col < 24; col++) leds.push({ pos: pos++, x: 60 + col * 39 + (r() - 0.5) * 5, y: 50 + row * 39 + (r() - 0.5) * 5 });
  leds.push({ pos: 900, x: 500, y: 5 }, { pos: 901, x: 4, y: 500 }); // stray LEDs at the border
  return leds;
}
const L = buildLayout(board(), PX);
const posOf = (leds) => new Set(leds.map((l) => l.pos));
const cnt = (frame, f) => frame.filter(f).length;

test('layout: rows, strips and the playing field are found; stray LEDs do not count', () => {
  assert.equal(L.rows.length, 24);
  assert.equal(L.top.length, 24);
  assert.equal(L.bottom.length, 24);
  assert.equal(L.left.length, 22, 'left column without the corners (they belong to the rows)');
  assert.ok(L.top.every((l, i) => i === 0 || l.x > L.top[i - 1].x), 'top strip runs left to right');
  assert.ok(L.left.every((l, i) => i === 0 || l.y > L.left[i - 1].y), 'left strip runs top to bottom');
  assert.ok(L.top[0].y < L.middle[0].y && L.middle[0].y < L.bottom[0].y);
  assert.ok(Math.abs(L.middle[0].y - (L.top[0].y + L.bottom[0].y) / 2) < 40, 'middle row is near the middle');
  assert.equal(L.hud, true);
  assert.equal(L.hudPos.size, 24 + 24 + 22);
  assert.ok(isReserved(L, L.top[3].pos) && !isReserved(L, L.middle[3].pos) && !isReserved(null, 1));
});

test('layout: too few LEDs or no rows -> no strips', () => {
  assert.equal(buildLayout(board().slice(0, 10), PX).hud, false);
  assert.equal(buildLayout([], PX).hud, false);
  assert.equal(buildLayout(board().filter((l) => l.pos % 24 === 5), PX).hud, false, 'a single column is not a field');
});

test('bar: a share of the strip lights from the left; segments are blocks with a dark LED between them', () => {
  const half = composeWall(L, { hud: { top: { kind: 'bar', value: 0.5, color: { r: 0, g: 255, b: 0 } } } });
  assert.equal(half.length, 6, 'every second LED: 12 slots, half of them lit');
  assert.ok(half.every((l) => L.top.slice(0, 12).some((t) => t.pos === l.pos)));
  assert.equal(composeWall(L, { hud: { top: { kind: 'bar', value: 0, color: { r: 1, g: 1, b: 1 } } } }).length, 0);
  assert.equal(composeWall(L, { hud: { top: { kind: 'bar', value: 1, color: { r: 1, g: 1, b: 1 } } } }).length, 12);
  const seg = composeWall(L, { hud: { top: { kind: 'segments', count: 3, lit: 2, color: { r: 255, g: 0, b: 0 } } } });
  assert.equal(seg.length, 4, 'two blocks of two LEDs');
  const index = seg.map((l) => L.top.findIndex((t) => t.pos === l.pos)).sort((a, b) => a - b);
  assert.ok(index.some((v, i) => i && v - index[i - 1] === 2), 'a dark LED between the blocks');
});

test('ticks: one slot per point (every second LED), a second lap restarts the row in another colour', () => {
  const at = (n) => composeWall(L, { hud: { bottom: { kind: 'ticks', count: n } } });
  assert.equal(at(0).length, 0);
  assert.equal(at(7).length, 7);
  assert.equal(at(12).length, 12, 'a full row of 12 slots');
  const lap2 = at(15), first = lap2.find((l) => l.pos === L.bottom[0].pos), last = lap2.find((l) => l.pos === L.bottom[22].pos);
  assert.equal(lap2.length, 12, 'the rest of the row keeps the colour of the lap before');
  assert.notDeepEqual([first.r, first.g, first.b], [last.r, last.g, last.b], 'the 3 slots of the new lap differ from the rest');
  assert.equal(lap2.filter((l) => l.g === first.g && l.r === first.r && l.b === first.b).length, 3);
});

test('zones: every LED inside lights, hold or not; the HUD strips are not painted over; targets win', () => {
  const red = { r: 255, g: 0, b: 0 }, white = { r: 255, g: 255, b: 255 };
  const x0 = L.middle[4].x - 15, x1 = L.middle[9].x + 15, y0 = L.rows[3][0].y - 15, y1 = L.rows[6][0].y + 15; // LED positions jitter by a few px
  const zone = [{ x0, x1, y0, y1, color: red }];
  const f = composeWall(L, { zones: zone }, { hudOn: true });
  assert.equal(f.length, 6 * 4, '6 columns x 4 rows');
  const target = L.rows[4][6].pos, f2 = composeWall(L, { holdLeds: [{ pos: target, color: white }], zones: zone });
  assert.deepEqual(f2.find((l) => l.pos === target), { pos: target, ...white }, 'a flash on a red hold shows white');
  const onTop = composeWall(L, { zones: [{ x0: 0, x1: 2000, y0: L.top[0].y - 5, y1: L.rows[1][0].y + 5, color: red }] }, { hudOn: true });
  assert.ok(onTop.every((l) => !L.hudPos.has(l.pos)), 'with the strips on, a zone leaves them alone');
  const noHud = composeWall(L, { zones: [{ x0: 0, x1: 2000, y0: L.top[0].y - 12, y1: L.top[0].y + 12, color: red }] }, { hudOn: false });
  assert.equal(noHud.length, 24, 'with the strips off the zone may light the top row');
});

test('a frame never exceeds the LED cap and keeps the targets', () => {
  const targets = L.middle.slice(0, 3).map((l) => ({ pos: l.pos, color: { r: 255, g: 200, b: 0 } }));
  const f = composeWall(L, { holdLeds: targets, zones: [{ x0: 0, x1: 5000, y0: 0, y1: 5000, color: { r: 255, g: 0, b: 0 } }], hud: { top: { kind: 'bar', value: 1, color: { r: 0, g: 255, b: 0 } } } });
  assert.equal(f.length, MAX_GAME_LEDS);
  for (const t of targets) assert.deepEqual(f.find((l) => l.pos === t.pos), { pos: t.pos, ...t.color });
});

test('countdown lights one row in traffic-light colours, go flashes green, then the normal picture', () => {
  const colour = (n) => { const f = composeWall(L, { fx: { kind: 'countdown', n }, hud: { top: { kind: 'bar', value: 1, color: { r: 0, g: 255, b: 0 } } } }); return { n: f.length, c: f[0] }; };
  assert.ok(colour(3).n >= 24 && colour(3).n <= 25, 'one row'); assert.equal(colour(3).c.r, 255); assert.equal(colour(3).c.g, 0);
  assert.ok(colour(2).c.g > 0 && colour(2).c.r === 255);
  const go = composeWall(L, { fx: { kind: 'go' } });
  assert.ok(go.length >= 48 && go.length <= 49, 'middle and top row');
  assert.ok(go.every((l) => l.g === 255 && l.r === 0));
  assert.ok(GO_MS > 300);
});

test('sweep runs a row at a time from the top and hands over to the normal picture when finished', () => {
  const red = { r: 255, g: 0, b: 0 };
  const at = (t) => composeWall(L, { fx: { kind: 'sweep', color: red, t }, hud: { bottom: { kind: 'ticks', count: 3 } } });
  const early = at(0.001);
  assert.deepEqual(new Set(early.map((l) => l.pos)), posOf(L.rows[0]), 'first row at the start');
  const later = at(0.5), idx = L.rows.findIndex((r) => r.some((l) => l.pos === later[0].pos));
  assert.ok(idx > 0, 'moves down');
  assert.ok(later.every((l) => l.r === 255 && l.g === 0));
  const done = at(10);
  assert.equal(done.length, 3, 'afterwards only the final status (score) stays');
});

test('without a layout only the target LEDs are returned', () => {
  const f = composeWall(null, { holdLeds: [{ pos: 5, color: { r: 1, g: 2, b: 3 } }], zones: [{ x0: 0, x1: 9, y0: 0, y1: 9, color: { r: 9, g: 9, b: 9 } }], hud: { top: { kind: 'bar', value: 1, color: { r: 1, g: 1, b: 1 } } }, fx: { kind: 'go' } });
  assert.deepEqual(f, [{ pos: 5, r: 1, g: 2, b: 3 }]);
});

test('priority on one LED: effect > flash > hand/foot > target > zone > status strip', () => {
  const c = (n) => ({ r: n, g: n, b: n });
  const pos = L.middle[5].pos, z = [{ x0: 0, x1: 5000, y0: L.middle[5].y - 3, y1: L.middle[5].y + 3, color: c(10) }];
  const at = (parts) => composeWall(L, parts).find((l) => l.pos === pos)?.r;
  assert.equal(at({ zones: z }), 10);
  assert.equal(at({ zones: z, holdLeds: [{ pos, color: c(20) }] }), 20);
  assert.equal(at({ zones: z, holdLeds: [{ pos, color: c(20) }], limbLeds: [{ pos, color: c(30) }] }), 30);
  assert.equal(at({ zones: z, holdLeds: [{ pos, color: c(20) }], limbLeds: [{ pos, color: c(30) }], flashLeds: [{ pos, color: c(40) }] }), 40);
  assert.equal(at({ flashLeds: [{ pos, color: c(40) }], fx: { kind: 'countdown', n: 3 } }), 255, 'an effect covers everything (the row is red)');
});

test('the status strips are complete even when obstacles use up the cap; limbs on a strip hold are not drawn', () => {
  const red = { r: 255, g: 0, b: 0 };
  const hud = { top: { kind: 'bar', value: 0.5, color: { r: 0, g: 255, b: 0 } }, left: { kind: 'count', n: 3, color: { r: 0, g: 0, b: 255 } }, bottom: { kind: 'ticks', count: 10 } };
  const everything = [{ x0: 0, x1: 5000, y0: 0, y1: 5000, color: red }];
  const f = composeWall(L, { zones: everything, hud, limbLeds: [{ pos: L.top[4].pos, color: { r: 0, g: 255, b: 255 } }, { pos: L.middle[3].pos, color: { r: 0, g: 255, b: 255 } }] });
  assert.equal(f.length, MAX_GAME_LEDS);
  const stripPos = [...L.top.filter((_, i) => i % 2 === 0).slice(0, 6), ...L.left.slice(0, 3), ...L.bottom.filter((_, i) => i % 2 === 0).slice(0, 10)].map((l) => l.pos);
  for (const pos of stripPos) assert.ok(f.some((l) => l.pos === pos), `strip LED ${pos} missing`);
  const topLed = f.find((l) => l.pos === L.top[4].pos);
  assert.deepEqual([topLed.r, topLed.g, topLed.b], [0, 255, 0], 'the strip colour, not the limb colour');
  const hand = f.find((l) => l.pos === L.middle[3].pos);
  assert.deepEqual([hand.r, hand.g, hand.b], [0, 255, 255], 'a limb inside the field is still shown');
});

test('even completely full status strips leave room for targets and limbs', () => {
  const full = { top: { kind: 'bar', value: 1, color: { r: 0, g: 255, b: 0 } }, left: { kind: 'bar', value: 1, color: { r: 0, g: 0, b: 255 } }, bottom: { kind: 'ticks', count: 24 } };
  const targets = L.middle.slice(2, 8).map((l) => ({ pos: l.pos, color: { r: 255, g: 200, b: 0 } }));
  const f = composeWall(L, { holdLeds: targets, hud: full });
  assert.ok(f.length <= MAX_GAME_LEDS);
  for (const t of targets) assert.ok(f.some((l) => l.pos === t.pos), 'target kept');
});

test('body: the stick figure is dim, a figure LED inside an obstacle shows the overlap colour, limbs and targets stay on top', () => {
  const dim = { r: 0, g: 48, b: 150 }, magenta = { r: 255, g: 0, b: 200 }, red = { r: 255, g: 0, b: 0 };
  const figure = L.rows[8].slice(5, 10).map((l) => l.pos);                 // five LEDs in a row
  const zone = [{ x0: L.rows[8][7].x - 5, x1: L.rows[8][11].x + 5, y0: L.rows[8][7].y - 15, y1: L.rows[8][7].y + 15, color: red }];
  const f = composeWall(L, { zones: zone, body: { leds: figure, color: dim, overlapColor: magenta }, limbLeds: [{ pos: figure[0], color: { r: 0, g: 255, b: 255 } }] });
  const at = (i) => f.find((l) => l.pos === figure[i]);
  assert.deepEqual([at(1).r, at(1).g, at(1).b], [0, 48, 150], 'outside the obstacle: dim blue');
  assert.deepEqual([at(2).r, at(2).g, at(2).b], [255, 0, 200], 'inside: the overlap colour');
  assert.deepEqual([at(0).r, at(0).g, at(0).b], [0, 255, 255], 'a hand beats the figure');
  const redOnly = f.filter((l) => l.r === 255 && l.g === 0 && l.b === 0);
  assert.ok(redOnly.length >= 1, 'the rest of the obstacle is red');
  assert.equal(composeWall(L, { body: { leds: L.top.map((l) => l.pos), color: dim } }).length, 0, 'the figure never paints the status strips');
  const hudOff = composeWall(L, { body: { leds: L.top.map((l) => l.pos), color: dim } }, { hudOn: false });
  assert.equal(hudOff.length, 24, 'but may when the strips are off');
});

test('marks light every LED within their radius, with target priority; the lost effect is one dim row', () => {
  const c = L.middle[6], mark = { x: c.x, y: c.y, r: 30, color: { r: 255, g: 0, b: 255 } };
  const f = composeWall(L, { marks: [mark], zones: [{ x0: 0, x1: 5000, y0: c.y - 5, y1: c.y + 5, color: { r: 255, g: 0, b: 0 } }] });
  const hit = f.find((l) => l.pos === c.pos);
  assert.deepEqual([hit.r, hit.g, hit.b], [255, 0, 255], 'the mark wins over the zone');
  assert.ok(f.filter((l) => l.b === 255).length >= 1);
  const lost = composeWall(L, { fx: { kind: 'lost' }, marks: [mark] });
  assert.ok(lost.length >= 24 && lost.length <= 25);
  assert.ok(lost.every((l) => l.r === 120 && l.g === 50 && l.b === 0));
});

test('layout exposes the LED spacing in px', () => {
  assert.ok(Math.abs(L.pitchX - 39) < 4 && Math.abs(L.pitchY - 39) < 4, `${L.pitchX} x ${L.pitchY}`);
});
