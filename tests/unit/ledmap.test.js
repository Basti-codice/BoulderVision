import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scanLayout, holdRegions, regionMeans, decodeHolds, orphanSpots, expectedLocation, planProbes, evaluateProbe,
  pathCheck, confirmPlan, evaluateConfirm, estimateShift, DEFAULT_RING_CM, ACCEPT_CONF,
} from '../../src/cv/ledmap.js';
import { spotImage } from '../../src/cv/calibrate.js';
import { convexHull, pointInPolygon } from '../../src/core/geometry.js';
import { rng, gauss } from './helpers.js';

// ---------------------------------------------------------------------------------------------------------------------
// Synthetic wall
//
// Holds 8-14 cm on a jittered row layout with 1-3 cm gaps (2.8 px/cm). Positions run along a serpentine (bottom row right
// to left, next row left to right, ...) with random unused gaps. Some holds have no LED, some LEDs belong to holds that
// the detector missed (orphans). A lit LED renders as a bright ~1 cm rim around the TRUE outline (Gaussian falloff),
// a hold-specific interior level (dark .. saturated), a long faint bleed tail that is stronger on neighbouring hold
// surfaces, per-LED brightness 0.4..1, sensor noise and clipping at 255. The detector's polygons are slightly scaled
// and shifted versions of the true outlines.

const PX = 2.8;
const GAUSS = (() => { const r = rng(99), t = new Float32Array(1 << 14); for (let i = 0; i < t.length; i++) t[i] = gauss(r); return t; })();

function signedDistance(poly, x, y) {
  let m = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j], [bx, by] = poly[i], dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
    m = Math.min(m, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return pointInPolygon(poly, x, y) ? -m : m;
}

function buildWall({ w, h, seed, pNoLed = 0.03, pUndetected = 0.03, pDim = 0, gapProb = 0.25, bleed = 0.12, detScale = [0.92, 1.08], shiftPx = 0, gainJitter = 0 }) {
  const r = rng(seed), U = (a, b) => a + r() * (b - a), truth = [];
  const pitchY = 14 * PX;
  for (let y = h - pitchY / 2 - 4; y > pitchY / 2; y -= pitchY) {
    const row = [];
    let x = U(1, 4) * PX;
    for (;;) {
      const rx = (U(8, 14) * PX) / 2;
      const cx = x + rx;
      if (cx + rx > w - 3) break;
      const ry = Math.min(rx * U(0.6, 1), (pitchY - 1.2 * PX) / 2), cy = y + U(-1, 1) * PX, rot = U(-0.3, 0.3);
      const pts = [];
      for (let k = 0; k < 10; k++) {
        const a = (k / 10) * 2 * Math.PI, f = U(0.93, 1.03), ex = Math.cos(a) * rx * f, ey = Math.sin(a) * ry * f;
        pts.push([cx + ex * Math.cos(rot) - ey * Math.sin(rot), cy + ex * Math.sin(rot) + ey * Math.cos(rot)]);
      }
      row.push({ cx, cy, poly: convexHull(pts), rx });
      x = cx + rx + U(1, 3) * PX;
    }
    truth.push(row);
  }
  // serpentine positions
  let pos = Math.floor(U(0, 3));
  const leds = [];
  truth.forEach((row, j) => {
    const order = j % 2 === 0 ? row.slice().reverse() : row;
    for (const t of order) {
      if (r() < pNoLed) continue;
      t.pos = pos;
      t.amp = 170 * U(0.4, 1) * (r() < pDim ? U(0.1, 0.2) : 1);
      t.dim = t.amp < 60;
      t.interior = r() < 0.15 ? U(1.2, 2) : U(0.05, 0.7);
      leds.push(t);
      pos += 1 + (r() < gapProb ? 1 + Math.floor(r() * 3) : 0);
    }
  });
  const N = pos + 5;
  const all = truth.flat();
  // detected holds: everything but a few LED holds (orphans); slightly wrong outlines
  const detected = [], orphanTruth = [];
  for (const t of all) {
    if (t.pos !== undefined && r() < pUndetected) { orphanTruth.push(t); continue; }
    const s = U(detScale[0], detScale[1]), dx = U(-1.5, 1.5) + shiftPx, dy = U(-1.5, 1.5) - shiftPx;
    const poly = t.poly.map(([x, y]) => [t.cx + (x - t.cx) * s + dx, t.cy + (y - t.cy) * s + dy]);
    t.detIndex = detected.length;
    detected.push({ id: detected.length, cx: t.cx + dx, cy: t.cy + dy, poly, area: Math.PI * t.rx * t.rx * s * s });
  }
  // truth label image (true outlines) for surface-dependent bleed
  const holdAt = new Int32Array(w * h).fill(-1);
  all.forEach((t, k) => {
    const xs = t.poly.map((p) => p[0]), ys = t.poly.map((p) => p[1]);
    for (let y = Math.max(0, Math.floor(Math.min(...ys))); y <= Math.min(h - 1, Math.ceil(Math.max(...ys))); y++) for (let x = Math.max(0, Math.floor(Math.min(...xs))); x <= Math.min(w - 1, Math.ceil(Math.max(...xs))); x++) if (pointInPolygon(t.poly, x + 0.5, y + 0.5)) holdAt[y * w + x] = k;
  });
  all.forEach((t, k) => { t.k = k; });
  // glow patch per LED
  const rimOff = 0.3 * PX, rimSig = 0.5 * PX, tail = 2.5 * PX, margin = Math.ceil(7 * PX);
  for (const t of leds) {
    const xs = t.poly.map((p) => p[0]), ys = t.poly.map((p) => p[1]), idx = [], val = [];
    for (let y = Math.max(0, Math.floor(Math.min(...ys)) - margin); y <= Math.min(h - 1, Math.ceil(Math.max(...ys)) + margin); y++) for (let x = Math.max(0, Math.floor(Math.min(...xs)) - margin); x <= Math.min(w - 1, Math.ceil(Math.max(...xs)) + margin); x++) {
      const sd = signedDistance(t.poly, x + 0.5, y + 0.5), i = y * w + x;
      let v;
      if (sd <= 0) v = t.interior * Math.exp(sd / (2 * PX)) + Math.exp(-(sd * sd) / (2 * (0.4 * PX) ** 2));
      else {
        const other = holdAt[i] >= 0 && holdAt[i] !== t.k;
        v = Math.exp(-((sd - rimOff) ** 2) / (2 * rimSig * rimSig)) + bleed * (other ? 2 : 1) * Math.exp(-sd / tail);
      }
      if (v * t.amp > 0.3) { idx.push(i); val.push(v * t.amp); }
    }
    t.patchIdx = Int32Array.from(idx); t.patchVal = Float32Array.from(val);
  }
  return { w, h, N, truth: all, leds, detected, orphanTruth, gainJitter };
}

/** Signal image with the given positions lit (frame gain, noise, clipping). */
function render(wall, positions, seed) {
  const { w, h } = wall, img = new Float32Array(w * h), lit = new Set(positions);
  const gain = 1 + wall.gainJitter * (((seed * 7919) % 1000) / 500 - 1); // frame-to-frame brightness (power supply, exposure)
  for (const t of wall.leds) if (lit.has(t.pos)) for (let k = 0; k < t.patchIdx.length; k++) img[t.patchIdx[k]] += gain * t.patchVal[k];
  const out = new Uint8Array(w * h);
  let s = (seed * 2654435761) >>> 0;
  for (let i = 0; i < out.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const v = img[i] + 1 + 2 * GAUSS[s >>> 18];
    out[i] = v <= 0 ? 0 : v >= 255 ? 255 : v;
  }
  return out;
}

/** Ground truth: detected hold index -> pos. */
const truthMap = (wall) => new Map(wall.leds.filter((t) => t.detIndex !== undefined).map((t) => [t.detIndex, t.pos]));

function scan(wall, { ringCm = DEFAULT_RING_CM, ...opts } = {}) {
  const layout = scanLayout(wall.N), H = wall.detected.length;
  const signals = layout.frames.map((f, i) => render(wall, f.positions, 100 + i));
  const labels = holdRegions(wall.detected, wall.w, wall.h, Math.round(ringCm * PX));
  const means = signals.map((s) => regionMeans(labels, H, s, opts));
  const dec = decodeHolds(means, layout);
  const assigned = new Map();
  dec.holds.forEach((r, k) => { if (r.pos !== null) assigned.set(k, r.pos); });
  const orphans = orphanSpots(labels, signals, layout, wall.w, wall.h, PX, { decoded: dec.holds });
  for (const o of orphans) if (o.supersedes !== undefined) assigned.delete(o.supersedes);
  return { layout, signals, labels, means, dec, assigned, orphans };
}

function probeRounds(wall, labels, assigned, excludePos, rounds = 2) {
  const H = wall.detected.length, log = [];
  for (let round = 0; round < rounds; round++) {
    const used = new Set(assigned.values()), unassigned = [], missing = [];
    for (let k = 0; k < H; k++) if (!assigned.has(k)) unassigned.push(k);
    for (let p = 0; p < wall.N; p++) if (!used.has(p) && !excludePos.has(p)) missing.push(p);
    const probes = planProbes(assigned, unassigned, missing, wall.detected, { pxPerCm: PX });
    probes.forEach((pr, i) => {
      const m = regionMeans(labels, H, render(wall, pr.leds, 5000 + round * 100 + i));
      for (const r of evaluateProbe(m, pr)) if (r.holdIndex !== null && !assigned.has(r.holdIndex)) { assigned.set(r.holdIndex, r.pos); log.push(r); }
    });
    log.push({ round, frames: probes.length, maxLeds: Math.max(0, ...probes.map((p) => p.leds.length)) });
  }
  return log;
}

function score(assigned, truth) {
  let right = 0, wrong = 0;
  for (const [k, p] of assigned) if (truth.get(k) === p) right++; else wrong++;
  return { right, wrong, total: truth.size };
}

let mainCache = null;
const mainWall = () => mainCache ??= (() => { const wall = buildWall({ w: 800, h: 800, seed: 7, gainJitter: 0.2 }); return { wall, ...scan(wall) }; })();

// ---------------------------------------------------------------------------------------------------------------------

test('holdRegions: polygons plus a ring, nearest hold wins, rings never overlap', () => {
  const holds = [
    { cx: 20, cy: 20, poly: [[10, 10], [30, 10], [30, 30], [10, 30]] },
    { cx: 44, cy: 20, poly: [[36, 10], [52, 10], [52, 30], [36, 30]] },
  ];
  const w = 70, h = 40, L = holdRegions(holds, w, h, 5);
  assert.equal(L[20 * w + 20], 1);
  assert.equal(L[20 * w + 44], 2);
  assert.equal(L[20 * w + 32], 1, 'gap pixel nearer to hold 0');
  assert.equal(L[20 * w + 34], 2, 'gap pixel nearer to hold 1');
  assert.equal(L[20 * w + 55], 2, 'inside the 5 px ring');
  assert.equal(L[20 * w + 60], 0, 'outside the ring');
  assert.equal(L[2 * w + 2], 0);
  assert.equal(holdRegions([], 10, 10, 3).every((v) => v === 0), true);
});

test('regionMeans: plain mean and top fraction', () => {
  const L = Int32Array.from([1, 1, 1, 1, 2, 2, 0, 0]), s = Uint8Array.from([0, 0, 0, 100, 10, 30, 255, 255]);
  assert.deepEqual([...regionMeans(L, 3, s, { topFraction: 1 })], [25, 20, 0]);
  assert.deepEqual([...regionMeans(L, 3, s, { topFraction: 0.25 })], [100, 30, 0]);
});

test('scan decode: >= 99 % of LEDs with a detected hold mapped right, no wrong label above ACCEPT_CONF', () => {
  const { wall, dec, assigned } = mainWall(), truth = truthMap(wall), sc = score(assigned, truth);
  const wrongGuesses = dec.holds.filter((r, k) => r.guess !== null && truth.has(k) && truth.get(k) !== r.guess);
  console.log(`# holds ${wall.detected.length}, LEDs with hold ${truth.size}, N ${wall.N}: right ${sc.right}, wrong ${sc.wrong}, wrong guesses ${wrongGuesses.length} (max conf ${Math.max(0, ...wrongGuesses.map((r) => r.conf)).toFixed(2)})`);
  assert.ok(wall.detected.length >= 300);
  assert.ok(sc.right >= 0.99 * truth.size, `right ${sc.right}/${truth.size}`);
  assert.equal(sc.wrong, 0);
  assert.ok(wrongGuesses.every((r) => r.conf < ACCEPT_CONF));
  // holds without LED stay unassigned
  for (let k = 0; k < wall.detected.length; k++) if (!truth.has(k)) assert.ok(!assigned.has(k), `hold ${k} has no LED`);
});

test('robust region statistic: top 50 % vs plain mean and top 10 %', () => {
  const confP05 = (wall, dec) => {
    const c = [...truthMap(wall)].map(([k, p]) => (dec.holds[k].guess === p ? dec.holds[k].conf : 0)).sort((x, y) => x - y);
    return c[Math.floor(c.length * 0.05)];
  };
  // outlines detected 10-25 % too small: most of the rim falls outside the polygon, a plain mean is diluted
  const small = buildWall({ w: 800, h: 800, seed: 7, detScale: [0.75, 0.9] }), truthS = truthMap(small);
  const half = score(scan(small, { topFraction: 0.5 }).assigned, truthS), mean = score(scan(small, { topFraction: 1 }).assigned, truthS);
  // strong bleed onto neighbours: a small top fraction picks up the lit side of a neighbour's region
  const bleed = buildWall({ w: 800, h: 800, seed: 8, bleed: 0.3 });
  const pHalf = confP05(bleed, scan(bleed, { topFraction: 0.5 }).dec), pTenth = confP05(bleed, scan(bleed, { topFraction: 0.1 }).dec);
  console.log(`# small outlines: top50% ${half.right}/${half.total}, mean ${mean.right}/${mean.total}; strong bleed conf p05: top50% ${pHalf.toFixed(2)}, top10% ${pTenth.toFixed(2)}`);
  assert.ok(half.right > mean.right && half.wrong === 0 && mean.wrong === 0);
  assert.ok(pHalf > pTenth + 0.05);
});

test('orphans: LEDs of undetected holds are found with the right position', () => {
  const { wall, orphans } = mainWall();
  const truePos = new Map(wall.orphanTruth.map((t) => [t.pos, t]));
  const good = orphans.filter((o) => truePos.has(o.pos) && Math.hypot(truePos.get(o.pos).cx - o.x, truePos.get(o.pos).cy - o.y) < 8 * PX);
  console.log(`# orphans: truth ${truePos.size}, found ${orphans.length}, right ${good.length}`);
  assert.ok(truePos.size >= 3);
  assert.ok(good.length >= truePos.size - 1, `found ${good.length}/${truePos.size}`);
  assert.ok(orphans.length - good.length <= 1, 'at most one spurious orphan');
});

test('estimateShift: recovers a camera shift of 2.5 cm and decoding is restored', () => {
  const wall = buildWall({ w: 800, h: 800, seed: 13, shiftPx: 7 }), truth = truthMap(wall), layout = scanLayout(wall.N);
  const xSignals = layout.frames.slice(0, layout.q).map((f, i) => render(wall, f.positions, 100 + i));
  const before = score(scan(wall).assigned, truth);
  const e = estimateShift(wall.detected, spotImage(layout, xSignals), wall.w, wall.h, { pxPerCm: PX });
  assert.deepEqual([e.dx, e.dy], [-7, 7]);
  assert.ok(e.gain > 1.5);
  wall.detected = wall.detected.map((h) => ({ ...h, cx: h.cx + e.dx, cy: h.cy + e.dy, poly: h.poly.map(([x, y]) => [x + e.dx, y + e.dy]) }));
  const after = score(scan(wall).assigned, truth);
  console.log(`# shift (-7, 7) px: right ${before.right}/${truth.size} (wrong ${before.wrong}) -> ${after.right} (wrong ${after.wrong}) after correction`);
  assert.ok(after.right >= 0.99 * truth.size && after.wrong === 0);
  const aligned = estimateShift(wall.detected, spotImage(layout, xSignals), wall.w, wall.h, { pxPerCm: PX });
  assert.deepEqual([aligned.dx, aligned.dy, aligned.gain], [0, 0, 1]);
});

test('expectedLocation interpolates along the strip and grows with the gap', () => {
  const holds = [0, 1, 2, 3, 4, 5].map((i) => ({ cx: 100 + 40 * i, cy: 50, poly: [] }));
  const assigned = new Map([[0, 10], [1, 11], [2, 12], [5, 16], [4, 15]]);
  const e = expectedLocation(13, assigned, holds), e2 = expectedLocation(14, assigned, holds);
  assert.ok(Math.abs(e.x - (180 + 80 / 3)) < 1e-9 && e.y === 50);
  assert.ok(e.radiusPx >= 40 && e2.radiusPx >= e.radiusPx);
  const ex = expectedLocation(18, assigned, holds);
  assert.ok(Math.abs(ex.x - 380) < 1e-9 && ex.radiusPx > e.radiusPx, 'extrapolation');
  assert.equal(expectedLocation(3, new Map(), holds), null);
});

test('dimmed LEDs (8 %): probing recovers them or leaves them unassigned, never mislabelled', () => {
  const wall = buildWall({ w: 800, h: 800, seed: 21, pDim: 0.08, gainJitter: 0.2 }), truth = truthMap(wall);
  const { assigned, labels, orphans } = scan(wall);
  const dim = wall.leds.filter((t) => t.dim && t.detIndex !== undefined);
  const before = dim.filter((t) => assigned.get(t.detIndex) === t.pos).length, s0 = score(assigned, truth);
  const log = probeRounds(wall, labels, assigned, new Set(orphans.map((o) => o.pos)));
  const after = dim.filter((t) => assigned.get(t.detIndex) === t.pos).length, s1 = score(assigned, truth);
  const rounds = log.filter((l) => l.round !== undefined);
  console.log(`# dim ${dim.length}: right after scan ${before}, after probing ${after}; total right ${s0.right} -> ${s1.right}/${truth.size}, wrong ${s1.wrong}; probe frames ${rounds.map((r) => `${r.frames} (max ${r.maxLeds} LEDs)`).join(', ')}`);
  assert.equal(s1.wrong, 0);
  assert.ok(after > before, 'probing recovers dimmed holds');
  assert.ok(rounds.every((r) => r.maxLeds <= 25));
});

test('probe frames separate the candidate sets of LEDs lit together', () => {
  const { wall, assigned } = mainWall(), H = wall.detected.length;
  const partial = new Map([...assigned].filter(([k]) => k % 9 !== 0)), un = [], used = new Set(partial.values()), missing = [];
  for (let k = 0; k < H; k++) if (!partial.has(k)) un.push(k);
  for (let p = 0; p < wall.N; p++) if (!used.has(p)) missing.push(p);
  const sep = 25 * PX, probes = planProbes(partial, un, missing, wall.detected, { pxPerCm: PX });
  const truth = truthMap(wall);
  for (const pr of probes) {
    assert.ok(pr.leds.length <= 25);
    for (let a = 0; a < pr.targets.length; a++) for (let b = a + 1; b < pr.targets.length; b++) {
      for (const i of [...pr.targets[a].candidates, ...pr.targets[a].context]) for (const j of [...pr.targets[b].candidates, ...pr.targets[b].context]) {
        const A = wall.detected[i], B = wall.detected[j];
        assert.ok(Math.hypot(A.cx - B.cx, A.cy - B.cy) > sep);
      }
    }
  }
  // the true hold of a removed assignment is among the candidates of its position (the prior is good enough)
  const targets = probes.flatMap((p) => p.targets), byPos = new Map(targets.map((t) => [t.pos, t]));
  const removed = [...assigned].filter(([k]) => k % 9 === 0), covered = removed.filter(([k, p]) => byPos.get(p)?.candidates.includes(k));
  console.log(`# probing ${removed.length} removed holds: ${probes.length} frames, ${targets.length} targets, true hold in candidates for ${covered.length}`);
  assert.ok(covered.length >= 0.9 * removed.length);
  const log = probeRounds(wall, holdRegions(wall.detected, wall.w, wall.h, Math.round(DEFAULT_RING_CM * PX)), partial, new Set(), 1);
  const s = score(partial, truth);
  assert.equal(s.wrong, 0);
  assert.ok(s.right >= assigned.size - 3, `recovered to ${s.right}/${assigned.size}`);
  assert.ok(log.length > 0);
});

test('pathCheck flags an injected swap, not the strip row ends', () => {
  const { wall, assigned } = mainWall();
  assert.deepEqual(pathCheck(assigned, wall.detected), [], 'clean mapping has no suspects');
  const keys = [...assigned.keys()], a = keys[20], b = keys[Math.floor(keys.length * 0.7)];
  const swapped = new Map(assigned); swapped.set(a, assigned.get(b)); swapped.set(b, assigned.get(a));
  const flagged = new Set(pathCheck(swapped, wall.detected).map((s) => s.holdIndex));
  assert.ok(flagged.has(a) && flagged.has(b));
  assert.ok(flagged.size <= 2);
});

test('confirm pass: clean mapping all ok, injected errors reported', () => {
  const { wall, labels, assigned } = mainWall(), H = wall.detected.length;
  const runConfirm = (map) => {
    const plan = confirmPlan(map, wall.detected, { pxPerCm: PX });
    assert.ok(plan.every((f) => f.leds.length <= 30));
    const m = plan.map((f, i) => regionMeans(labels, H, render(wall, f.leds, 9000 + i)));
    return { plan, ver: evaluateConfirm(m, plan, map, wall.detected, { pxPerCm: PX }) };
  };
  const clean = runConfirm(assigned);
  console.log(`# confirm: ${clean.plan.length} frames for ${assigned.size} LEDs, ok ${clean.ver.ok}, bad ${clean.ver.bad}, unexpected ${clean.ver.unexpected.length}`);
  assert.equal(clean.ver.bad, 0);
  // (1) swap of two adjacent strip positions (invisible to pathCheck), (2) a hold given its neighbour's position
  const byPos = new Map([...assigned].map(([k, p]) => [p, k])), sorted = [...byPos.keys()].sort((x, y) => x - y);
  const p = sorted.find((x, i) => i > 30 && byPos.has(x + 1)), ka = byPos.get(p), kb = byPos.get(p + 1);
  const bad = new Map(assigned); bad.set(ka, p + 1); bad.set(kb, p);
  const r = runConfirm(bad), flagged = new Set(r.ver.holds.filter((x) => !x.ok).map((x) => x.holdIndex));
  assert.ok(flagged.has(ka) && flagged.has(kb), 'adjacent swap detected');
  assert.ok(r.ver.bad <= 4);
  const p2 = sorted.find((x, i) => i > 100 && byPos.has(x + 1)), kc = byPos.get(p2), kd = byPos.get(p2 + 1);
  const bad2 = new Map(assigned); bad2.delete(kd); bad2.set(kc, p2 + 1); // kc now claims the LED of its neighbour kd
  const r2 = runConfirm(bad2);
  assert.ok(r2.ver.holds.some((x) => x.holdIndex === kc && !x.ok), 'stolen position detected');
});

test('timing: full pipeline on 1000x1000 with ~700 holds', () => {
  const wall = buildWall({ w: 1000, h: 1000, seed: 3 }), layout = scanLayout(wall.N), H = wall.detected.length;
  const signals = layout.frames.map((f, i) => render(wall, f.positions, i));
  const t0 = performance.now();
  const labels = holdRegions(wall.detected, wall.w, wall.h, Math.round(DEFAULT_RING_CM * PX));
  const t1 = performance.now();
  const means = signals.map((s) => regionMeans(labels, H, s));
  const t2 = performance.now();
  const dec = decodeHolds(means, layout), assigned = new Map();
  dec.holds.forEach((r, k) => { if (r.pos !== null) assigned.set(k, r.pos); });
  for (const o of orphanSpots(labels, signals, layout, wall.w, wall.h, PX, { decoded: dec.holds })) if (o.supersedes !== undefined) assigned.delete(o.supersedes);
  const t3 = performance.now();
  pathCheck(assigned, wall.detected);
  const un = [], used = new Set(assigned.values()), missing = [];
  for (let k = 0; k < H; k++) if (!assigned.has(k)) un.push(k);
  for (let p = 0; p < wall.N; p++) if (!used.has(p)) missing.push(p);
  planProbes(assigned, un, missing, wall.detected, { pxPerCm: PX });
  const plan = confirmPlan(assigned, wall.detected, { pxPerCm: PX });
  evaluateConfirm(plan.map(() => means[0]), plan, assigned, wall.detected, { pxPerCm: PX });
  const t4 = performance.now(), sc = score(assigned, truthMap(wall));
  console.log(`# 1000x1000, ${H} holds, N ${wall.N}, ${signals.length} frames: regions ${(t1 - t0).toFixed(0)} ms, means ${(t2 - t1).toFixed(0)} ms, decode+orphans ${(t3 - t2).toFixed(0)} ms, path/probe/confirm ${(t4 - t3).toFixed(0)} ms; right ${sc.right}/${sc.total}, wrong ${sc.wrong}`);
  assert.ok(t4 - t0 < 4000);
  assert.equal(sc.wrong, 0);
});

test('edge cases: no holds, tiny N, duplicates, out of range', () => {
  const layout = scanLayout(4); // q = 2, Q = 2
  assert.deepEqual(decodeHolds(layout.frames.map(() => new Float64Array(0)), layout).holds, []);
  assert.deepEqual(planProbes(new Map(), [], [1, 2], []), []);
  assert.deepEqual(confirmPlan(new Map(), []), []);
  assert.deepEqual(pathCheck(new Map(), []), []);
  // two holds both brightest in the frames of position 3 -> the clearer one keeps it
  const means = [[0, 0, 0], [90, 60, 0], [0, 0, 0], [90, 60, 0]].map((a) => Float64Array.from(a));
  const r = decodeHolds(means, layout, { noiseFloor: 10 }).holds;
  assert.equal(r[0].pos, 3);
  assert.equal(r[1].pos, null);
  assert.ok(r[1].reasons.includes('duplicate'));
  assert.ok(r[2].reasons.includes('dark'));
  assert.ok(r.every((x) => (x.pos === null) === (x.conf < ACCEPT_CONF)), 'conf is below ACCEPT_CONF exactly when unassigned');
  const l5 = scanLayout(5); // q = 3, Q = 2: code 5 = x 2 + 3 * y 1 is out of range
  const m5 = [[0], [0], [80], [0], [80]].map((a) => Float64Array.from(a));
  assert.ok(decodeHolds(m5, l5, { noiseFloor: 10 }).holds[0].reasons.includes('out-of-range'));
  assert.throws(() => decodeHolds([new Float64Array(1)], l5));
});
