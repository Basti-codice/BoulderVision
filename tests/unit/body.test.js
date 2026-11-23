import test from 'node:test';
import assert from 'node:assert/strict';
import { BodyModel, JOINT, BODY_CM } from '../../src/game/body.js';
import { rng } from './helpers.js';

const PPC = 2.8;
const J = JOINT;

// Standing climber facing the wall, in wall px (y down).
const STAND = {
  [J.NOSE]: [500, 480], [J.L_SHOULDER]: [460, 530], [J.R_SHOULDER]: [540, 530],
  [J.L_ELBOW]: [440, 610], [J.R_ELBOW]: [560, 610], [J.L_WRIST]: [430, 690], [J.R_WRIST]: [570, 690],
  [J.L_HIP]: [475, 700], [J.R_HIP]: [525, 700], [J.L_KNEE]: [470, 820], [J.R_KNEE]: [530, 820],
  [J.L_ANKLE]: [470, 930], [J.R_ANKLE]: [530, 930], [J.L_TOE]: [465, 950], [J.R_TOE]: [535, 950],
};

/** 33-landmark array; unspecified landmarks get v=0. over: {index: [x,y,v?]}. */
function pose(over = {}, base = STAND) {
  const out = [];
  for (let i = 0; i < 33; i++) {
    const p = over[i] ?? base[i];
    out.push(p ? { x: p[0], y: p[1], v: p[2] ?? 0.99 } : { x: 0, y: 0, v: 0 });
  }
  return out;
}

const close = (a, b, eps = 1e-6, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} ${a} vs ${b}`);
const part = (m, kind, side = '') => m.parts.find((p) => p.kind === kind && p.side === side);

test('standing figure: parts, centre, bounds', () => {
  const m = new BodyModel({ pxPerCm: PPC });
  assert.equal(m.tracked, false); assert.equal(m.centre, null); assert.equal(m.bounds, null);
  for (let t = 0; t <= 100; t += 33) m.update(t, pose());
  assert.equal(m.tracked, true);
  const kinds = m.parts.map((p) => p.kind + p.side).sort();
  assert.deepEqual(kinds, ['footl', 'footr', 'foreArml', 'foreArmr', 'head', 'shinl', 'shinr', 'thighl', 'thighr', 'torso', 'upperArml', 'upperArmr']);
  const torso = part(m, 'torso');
  assert.deepEqual([torso.a.x, torso.a.y, torso.b.x, torso.b.y], [500, 530, 500, 700]);
  close(torso.r, 48); // 0.6 * 80 px shoulder width > 13 cm
  assert.equal(torso.estimated, undefined);
  close(part(m, 'head').r, BODY_CM.head * PPC);
  assert.deepEqual(m.centre, { x: 500, y: 615 });
  const b = m.bounds;
  close(b.x0, 430 - 5 * PPC); close(b.x1, 570 + 5 * PPC);
  close(b.y0, 480 - 9 * PPC); close(b.y1, 950 + 4 * PPC);
  const segKinds = m.segments().map((s) => s.kind);
  for (const k of ['torso', 'shoulders', 'hips', 'head', 'upperArm', 'foreArm', 'thigh', 'shin']) assert.ok(segKinds.includes(k), k);
  const head = m.segments().find((s) => s.kind === 'head');
  assert.deepEqual(head.a, head.b);
});

test('narrow shoulders use torsoMin', () => {
  const m = new BodyModel({ pxPerCm: PPC });
  m.update(0, pose({ [J.L_SHOULDER]: [490, 530], [J.R_SHOULDER]: [510, 530] }));
  close(part(m, 'torso').r, 13 * PPC);
});

// ---- capsule vs rect --------------------------------------------------------------------
function rectDist(px, py, r) {
  const dx = Math.max(r.x0 - px, 0, px - r.x1), dy = Math.max(r.y0 - py, 0, py - r.y1);
  return Math.hypot(dx, dy);
}
function inside(px, py, r) { return Math.min(px - r.x0, r.x1 - px, py - r.y0, r.y1 - py); }
/** Sampled signed distance (+gap / -penetration) and its max sampling error. */
function bruteSigned(c, r, N = 600) {
  let gap = Infinity, pen = -Infinity;
  for (let i = 0; i <= N; i++) {
    const t = i / N, x = c.a.x + t * (c.b.x - c.a.x), y = c.a.y + t * (c.b.y - c.a.y);
    gap = Math.min(gap, rectDist(x, y, r)); pen = Math.max(pen, inside(x, y, r));
  }
  const err = Math.hypot(c.b.x - c.a.x, c.b.y - c.a.y) / N + 1e-9;
  return { s: pen >= 0 ? -pen : gap, err };
}
function withCapsule(c, ppc = 1) { const m = new BodyModel({ pxPerCm: ppc }); m._parts = [{ kind: 'test', side: '', ...c }]; return m; }

test('hitsRect matches brute-force sampling on random capsules', () => {
  const r = rng(7);
  const ri = (a, b) => Math.round(a + r() * (b - a)); // integer grid: makes exact touching common
  let hits = 0, misses = 0, checked = 0;
  for (let n = 0; n < 3000; n++) {
    const mode = n % 6;
    let a = { x: ri(0, 200), y: ri(0, 200) }, b = mode === 0 ? { ...a } : { x: ri(0, 200), y: ri(0, 200) };
    let rad = ri(0, 40);
    let rect = { x0: ri(0, 150), y0: ri(0, 150) }; rect.x1 = rect.x0 + ri(0, 80); rect.y1 = rect.y0 + ri(0, 80);
    if (mode === 1) { a = { x: rect.x0 + 1, y: rect.y0 + 1 }; b = { x: rect.x1 - 1, y: rect.y1 - 1 }; } // inside / on edges
    if (mode === 2) { rad = 200; } // rect inside a fat capsule
    if (mode === 3) { a = { x: rect.x0 - 30, y: ri(-20, 250) }; b = { x: a.x, y: ri(-20, 250) }; rad = 30; } // exactly touching left edge
    if (mode === 4) { a = { x: ri(rect.x0, rect.x1), y: rect.y1 }; b = { x: ri(-50, 250), y: rect.y1 }; } // along an edge
    const c = { a, b, r: rad };
    const got = withCapsule(c).hitsRect(rect);
    const { s, err } = bruteSigned(c, rect);
    if (mode === 3 && a.y >= rect.y0 && a.y <= rect.y1) { assert.equal(got.hit, true, 'exact touch'); close(got.depth, 0, 1e-9); }
    if (Math.abs(s - rad) <= err) continue; // sampling cannot decide
    checked++;
    assert.equal(got.hit, s < rad, JSON.stringify({ c, rect, s, got }));
    if (got.hit) { hits++; close(got.depth, rad - s, err + 1e-9, 'depth'); assert.equal(got.kind, 'test'); } else { misses++; assert.equal(got.depth, 0); assert.equal(got.kind, null); }
  }
  assert.ok(checked > 2500 && hits > 300 && misses > 300, `${checked} ${hits} ${misses}`);
});

test('hitsRect special cases', () => {
  const rect = { x0: 100, y0: 100, x1: 200, y1: 200 };
  // fully inside: depth = r + deepest point's distance to the boundary
  let g = withCapsule({ a: { x: 150, y: 150 }, b: { x: 150, y: 150 }, r: 5 }).hitsRect(rect);
  assert.equal(g.hit, true); close(g.depth, 55);
  // diagonal through the centre: deepest point is the centre
  g = withCapsule({ a: { x: 0, y: 0 }, b: { x: 300, y: 300 }, r: 0 }).hitsRect(rect);
  close(g.depth, 50);
  // rect fully inside a fat capsule
  g = withCapsule({ a: { x: 150, y: 150 }, b: { x: 150, y: 150 }, r: 500 }).hitsRect(rect);
  assert.equal(g.hit, true);
  // corner distance
  g = withCapsule({ a: { x: 230, y: 240 }, b: { x: 230, y: 240 }, r: 49.9 }).hitsRect(rect);
  assert.equal(g.hit, false);
  g = withCapsule({ a: { x: 230, y: 240 }, b: { x: 230, y: 240 }, r: 50 }).hitsRect(rect);
  assert.equal(g.hit, true);
  // empty / garbage rect
  assert.equal(withCapsule({ a: { x: 150, y: 150 }, b: { x: 150, y: 150 }, r: 5 }).hitsRect({ x0: NaN, y0: 0, x1: 1, y1: 1 }).hit, false);
  assert.equal(new BodyModel({ pxPerCm: 2 }).hitsRect(rect).hit, false);
});

test('shrinkCm makes a borderline overlap pass, exact touch still counts', () => {
  const m = new BodyModel({ pxPerCm: 2 });
  m.update(0, pose({ [J.NOSE]: [500, 400] })); // head r = 18 px at (500, 400), well clear of the torso
  const rect = { x0: 513, y0: 390, x1: 700, y1: 410 }; // head reaches x=518 -> 5 px overlap
  const r0 = m.hitsRect(rect);
  assert.equal(r0.hit, true); assert.equal(r0.kind, 'head'); close(r0.depth, 5);
  assert.equal(m.hitsRect(rect, 3).hit, false); // shrinks by 6 px
  // after shrinking by 10 cm = 20 px the rect's left edge is exactly at x = 518, y 320..400
  const r2 = m.hitsRect({ x0: 518 - 20, y0: 300, x1: 720, y1: 420 }, 10);
  assert.equal(r2.hit, true); assert.equal(r2.kind, 'head'); close(r2.depth, 0);
  assert.equal(m.hitsRect({ x0: 518.001 - 20, y0: 300, x1: 720, y1: 420 }, 10).hit, false);
});

// ---- temporal behaviour ----------------------------------------------------------------
test('held joints expire after holdMs; null frames keep held values', () => {
  const m = new BodyModel({ pxPerCm: PPC, holdMs: 300 });
  let t = 0;
  for (; t <= 99; t += 33) m.update(t, pose()); // last good t = 99
  for (; t <= 399; t += 33) {
    m.update(t, pose({ [J.L_ELBOW]: [440, 610, 0.1] }));
    assert.equal(!!part(m, 'upperArm', 'l'), t - 99 <= 300, `t=${t}`);
    assert.ok(part(m, 'upperArm', 'r'));
  }
  const m2 = new BodyModel({ pxPerCm: PPC, holdMs: 300, lostMs: 500 });
  m2.update(0, pose());
  m2.update(200, null);
  assert.equal(m2.parts.length, 12); assert.equal(m2.tracked, true);
  m2.update(301, null);
  assert.equal(m2.parts.length, 0); assert.equal(m2.centre, null);
});

test('a joint that reappears far away does not slide in', () => {
  const m = new BodyModel({ pxPerCm: PPC });
  let t = 0;
  for (; t < 200; t += 33) m.update(t, pose());
  for (; t < 600; t += 33) m.update(t, pose({ [J.L_WRIST]: [0, 0, 0] }));
  assert.equal(part(m, 'foreArm', 'l'), undefined);
  m.update(t, pose({ [J.L_WRIST]: [300, 400] }));
  assert.deepEqual(part(m, 'foreArm', 'l').b, { x: 300, y: 400 });
});

test('outlier rejection: single-frame jump ignored, persistent jump accepted on 3rd frame', () => {
  const m = new BodyModel({ pxPerCm: PPC });
  let t = 0;
  for (; t < 200; t += 33) m.update(t, pose());
  const far = [430, 690 - 400]; // 400 px > 120 cm * 2.8
  m.update((t += 33), pose({ [J.L_WRIST]: far }));
  assert.deepEqual(part(m, 'foreArm', 'l').b, { x: 430, y: 690 });
  m.update((t += 33), pose());
  assert.deepEqual(part(m, 'foreArm', 'l').b, { x: 430, y: 690 });
  m.update((t += 33), pose({ [J.L_WRIST]: far }));
  m.update((t += 33), pose({ [J.L_WRIST]: far }));
  assert.deepEqual(part(m, 'foreArm', 'l').b, { x: 430, y: 690 });
  m.update((t += 33), pose({ [J.L_WRIST]: far }));
  assert.deepEqual(part(m, 'foreArm', 'l').b, { x: far[0], y: far[1] });
  // a moderate move is smoothed normally (moves, but not all the way at once)
  m.update((t += 33), pose({ [J.L_WRIST]: [far[0] + 30, far[1]] }));
  const x = part(m, 'foreArm', 'l').b.x;
  assert.ok(x > far[0] && x <= far[0] + 30);
});

test('outlier frames count against holdMs', () => {
  const m = new BodyModel({ pxPerCm: PPC, holdMs: 100 });
  m.update(0, pose());
  // alternate between two far positions: never 3 consistent frames, never accepted
  m.update(33, pose({ [J.L_WRIST]: [430, 100] }));
  m.update(66, pose({ [J.L_WRIST]: [900, 100] }));
  m.update(99, pose({ [J.L_WRIST]: [430, 100] }));
  assert.ok(part(m, 'foreArm', 'l'));
  m.update(132, pose({ [J.L_WRIST]: [900, 900] }));
  assert.equal(part(m, 'foreArm', 'l'), undefined);
});

test('torso estimation when hips or shoulders are hidden', () => {
  const m = new BodyModel({ pxPerCm: PPC });
  m.update(0, pose({ [J.L_HIP]: [475, 700, 0.1], [J.R_HIP]: [525, 700, 0.2] }));
  let t = part(m, 'torso');
  assert.equal(t.estimated, true);
  assert.deepEqual(t.a, { x: 500, y: 530 });
  close(t.b.x, 500); close(t.b.y, 530 + 1.5 * 80);
  assert.equal(m.tracked, true);
  assert.equal(part(m, 'thigh', 'l'), undefined);
  assert.ok(!m.segments().some((s) => s.kind === 'hips'));

  // tilted shoulders: estimate is perpendicular and points down
  const m2 = new BodyModel({ pxPerCm: PPC });
  m2.update(0, pose({ [J.L_SHOULDER]: [540, 530], [J.R_SHOULDER]: [460, 560], [J.L_HIP]: [0, 0, 0], [J.R_HIP]: [0, 0, 0] }));
  t = part(m2, 'torso');
  const dx = t.b.x - t.a.x, dy = t.b.y - t.a.y;
  assert.ok(dy > 0); close(dx * -80 + dy * 30, 0, 1e-6); close(Math.hypot(dx, dy), 1.5 * Math.hypot(80, 30), 1e-6);

  // only hips known (narrow hips -> minPairWidth)
  const m3 = new BodyModel({ pxPerCm: PPC });
  m3.update(0, pose({ [J.L_SHOULDER]: [0, 0, 0], [J.R_SHOULDER]: [0, 0, 0] }));
  t = part(m3, 'torso');
  assert.equal(t.estimated, true);
  assert.deepEqual(t.b, { x: 500, y: 700 });
  close(t.a.x, 500); close(t.a.y, 700 - 1.5 * 25 * PPC);
  assert.ok(part(m3, 'thigh', 'r'));
  assert.equal(m3.tracked, true);

  // limbs only: not tracked
  const m4 = new BodyModel({ pxPerCm: PPC });
  m4.update(0, pose({ [J.L_SHOULDER]: [0, 0, 0], [J.L_HIP]: [0, 0, 0] }));
  assert.equal(part(m4, 'torso'), undefined);
  assert.equal(m4.centre, null);
  assert.equal(m4.tracked, false);
  assert.ok(m4.parts.length > 0);
});

test('tracked / trackedAt follow lostMs', () => {
  const m = new BodyModel({ pxPerCm: PPC, holdMs: 300, lostMs: 500 });
  m.update(0, pose()); m.update(33, pose());
  assert.equal(m.trackedAt(533), true);
  assert.equal(m.trackedAt(534), false);
  m.update(400, null);
  assert.equal(m.tracked, true);
  m.update(533, null);
  assert.equal(m.tracked, true);
  m.update(534, null);
  assert.equal(m.tracked, false);
  // hips hidden but shoulders fresh keeps tracking
  m.update(600, pose({ [J.L_HIP]: [0, 0, 0], [J.R_HIP]: [0, 0, 0] }));
  assert.equal(m.tracked, true);
  m.reset();
  assert.equal(m.tracked, false); assert.equal(m.parts.length, 0);
});

test('distanceTo', () => {
  const m = new BodyModel({ pxPerCm: PPC });
  assert.equal(m.distanceTo({ x: 0, y: 0 }), Infinity);
  m.update(0, pose());
  assert.equal(m.distanceTo({ x: 500, y: 615 }), 0);
  close(m.distanceTo({ x: 500, y: 480 - 9 * PPC - 10 }), 10); // above the head
  close(m.distanceTo({ x: 800, y: 615 }), Math.min(300 - 48, ...m.parts.map((p) => {
    const t = Math.max(0, Math.min(1, ((800 - p.a.x) * (p.b.x - p.a.x) + (615 - p.a.y) * (p.b.y - p.a.y)) / (((p.b.x - p.a.x) ** 2 + (p.b.y - p.a.y) ** 2) || 1)));
    return Math.hypot(p.a.x + t * (p.b.x - p.a.x) - 800, p.a.y + t * (p.b.y - p.a.y) - 615) - p.r;
  })));
  assert.equal(m.distanceTo(null), Infinity);
});

// ---- LEDs -------------------------------------------------------------------------------
const SP = 39;
const LEDS = [];
for (let i = 0; i < 24; i++) for (let k = 0; k < 24; k++) LEDS.push({ pos: i * 24 + k, x: 20 + k * SP, y: 20 + i * SP, gi: i, gk: k });

test('boneLeds draws a connected, plausible stick figure', () => {
  const m = new BodyModel({ pxPerCm: PPC });
  assert.equal(m.boneLeds(LEDS, 20).size, 0);
  m.update(0, pose());
  const rad = 0.55 * SP;
  const set = m.boneLeds(LEDS, rad);
  assert.ok(set.size >= 10 && set.size <= 40, `count ${set.size}`); // 34 for this 175 cm figure
  const chosen = LEDS.filter((l) => set.has(l.pos));
  const segs = m.segments();
  const dseg = (l, s) => {
    const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y, L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((l.x - s.a.x) * dx + (l.y - s.a.y) * dy) / L2)) : 0;
    return Math.hypot(s.a.x + t * dx - l.x, s.a.y + t * dy - l.y);
  };
  for (const l of LEDS) {
    const d = Math.min(...segs.map((s) => dseg(l, s)));
    assert.equal(set.has(l.pos), d <= rad, `led ${l.pos} d=${d}`);
  }
  // 8-connected on the lattice
  const seen = new Set([chosen[0].pos]), stack = [chosen[0]];
  while (stack.length) {
    const c = stack.pop();
    for (const o of chosen) if (!seen.has(o.pos) && Math.abs(o.gi - c.gi) <= 1 && Math.abs(o.gk - c.gk) <= 1) { seen.add(o.pos); stack.push(o); }
  }
  assert.equal(seen.size, chosen.length, 'stick figure is one connected blob');
  // tolerant of garbage LEDs
  assert.doesNotThrow(() => m.boneLeds([null, { pos: 1, x: NaN, y: 3 }, {}, ...LEDS], rad));
  assert.equal(m.boneLeds(null, rad).size, 0);
  assert.equal(m.boneLeds(LEDS, NaN).size, 0);
});

// ---- robustness ---------------------------------------------------------------------------
test('garbage input never throws', () => {
  const m = new BodyModel({ pxPerCm: PPC });
  const inputs = [
    null, undefined, [], 42, 'x', {}, { length: 33 }, new Array(33), Array(10).fill({ x: 1, y: 2, v: 1 }),
    pose().map((p, i) => (i % 3 ? p : undefined)), pose().map((p) => ({ x: NaN, y: p.y, v: p.v })),
    pose().map((p) => ({ x: p.x, y: p.y, v: NaN })), pose().map(() => null), pose().map(() => 5),
    pose().map((p) => ({ x: Infinity, y: -Infinity })), pose().map((p) => ({ x: String(p.x), y: p.y })),
  ];
  let t = 0;
  for (const inp of inputs) {
    for (const now of [t += 33, NaN, undefined, t += 33]) {
      assert.doesNotThrow(() => {
        m.update(now, inp);
        void m.tracked; void m.centre; void m.bounds; void m.parts; m.segments();
        m.trackedAt(NaN); m.hitsRect(null); m.hitsRect({}); m.hitsRect({ x0: 0, y0: 0, x1: 1000, y1: 1000 }, NaN);
        m.distanceTo({}); m.distanceTo(undefined); m.boneLeds(LEDS, 20); m.boneLeds(undefined, undefined);
      });
      for (const p of m.parts) for (const v of [p.a.x, p.a.y, p.b.x, p.b.y, p.r]) assert.ok(Number.isFinite(v));
    }
  }
  m.update(t += 33, pose());
  m.update(t - 1000, pose()); // clock going backwards resets
  assert.ok(m.parts.length > 0);
  assert.doesNotThrow(() => new BodyModel());
  assert.doesNotThrow(() => new BodyModel(null));
});

test('performance: hitsRect + boneLeds on 500 LEDs', () => {
  const leds = LEDS.slice(0, 500);
  const m = new BodyModel({ pxPerCm: PPC });
  m.update(0, pose());
  const t0 = performance.now();
  let n = 0;
  for (let i = 0; i < 2000; i++) {
    if (m.hitsRect({ x0: (i * 7) % 900, y0: 400, x1: (i * 7) % 900 + 60, y1: 460 }).hit) n++;
    n += m.boneLeds(leds, 21).size;
    m.distanceTo({ x: i % 900, y: 500 });
  }
  const ms = performance.now() - t0;
  assert.ok(n > 0);
  assert.ok(ms < 600, `${ms.toFixed(1)} ms`);
});
