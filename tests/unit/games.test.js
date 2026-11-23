import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, CoinGame, DodgeGame, ChaserGame, COLORS, DIFFICULTIES, TRACKING_GRACE_MS, GAMES } from '../../src/game/games.js';
import { rng } from '../../src/core/rng.js';

const PX = 2.8;
const wall = { RW: 1000, RH: 1000, pxPerCm: PX, field: { x0: 20, y0: 20, x1: 980, y1: 980 }, rowPitchPx: 40, colPitchPx: 40 };
const holds = Array.from({ length: 150 }, (_, i) => ({ id: i + 1, cx: 40 + (i % 15) * 62, cy: 40 + Math.floor(i / 15) * 95 }));
const none = { LH: null, RH: null, LF: null, RF: null };

/** A box-shaped stand-in for BodyModel: same interface the games use (tracked, centre, bounds, hitsRect, distanceTo). */
function box(cx, cy, wCm = 70, hCm = 170) {
  const w = wCm * PX, h = hCm * PX, b = { x0: cx - w / 2, x1: cx + w / 2, y0: cy - h / 2, y1: cy + h / 2 };
  return {
    tracked: true, centre: { x: cx, y: cy }, bounds: b,
    hitsRect(r, shrinkCm = 0) { const s = shrinkCm * PX; return { hit: b.x0 < r.x1 - s && b.x1 > r.x0 + s && b.y0 < r.y1 - s && b.y1 > r.y0 + s }; },
    distanceTo(p) { return Math.hypot(Math.max(b.x0 - p.x, 0, p.x - b.x1), Math.max(b.y0 - p.y, 0, p.y - b.y1)); },
  };
}
const ctx = (body, contacts = none, tracked = true) => ({ contacts, body, tracked });

test('createGame knows the games, difficulty falls back to medium, unknown games are rejected', () => {
  assert.ok(createGame('coins', holds, wall, rng(1)) instanceof CoinGame);
  assert.ok(createGame('dodge', holds, wall, rng(1)) instanceof DodgeGame);
  assert.ok(createGame('chaser', holds, wall, rng(1)) instanceof ChaserGame);
  assert.throws(() => createGame('chess', holds, wall, rng(1)));
  for (const g of GAMES) assert.equal(createGame(g.id, holds, wall, rng(1), 'nonsense').difficulty, 'medium');
});

// ---------- game clock ----------
test('game clock: stops when the climber is not tracked for longer than the grace period, runs on when they are back', () => {
  const g = createGame('coins', holds, wall, rng(1));
  g.start(0);
  g.update(1000, ctx(null, none, true));
  assert.equal(g.t, 1000);
  g.update(1500, ctx(null, none, false));
  g.update(1500 + TRACKING_GRACE_MS - 100, ctx(null, none, false));
  assert.equal(g.paused, false, 'a short loss does not pause');
  g.update(1500 + TRACKING_GRACE_MS + 500, ctx(null, none, false));
  assert.equal(g.paused, true);
  const tPaused = g.t;
  assert.equal(g.output().fx.kind, 'lost');
  g.update(1500 + TRACKING_GRACE_MS + 5000, ctx(null, none, false));
  assert.equal(g.t, tPaused, 'the clock stands still');
  g.update(1500 + TRACKING_GRACE_MS + 5100, ctx(null, none, true));
  assert.equal(g.paused, false);
  assert.ok(g.t - tPaused <= 100, 'continues from where it stopped');
});

// ---------- coins ----------
test('coins: countdown, then reachable coins appear; a hand grab scores, a foot grab does not', () => {
  const g = createGame('coins', holds, wall, rng(7));
  g.start(0);
  g.update(500, none);
  assert.equal(g.state().phase, 'ready');
  assert.equal(g.lit.size, 0);
  g.update(2100, none);
  assert.equal(g.state().phase, 'running');
  assert.equal(g.coins.length, 2);
  const [c1] = g.coins;
  g.update(2200, { ...none, LF: c1.holdId });                        // foot: no score
  assert.equal(g.score, 0);
  g.update(2300, none);
  g.update(2400, { ...none, RH: c1.holdId });                        // hand: score
  assert.equal(g.collected, 1);
  assert.equal(g.score, 1);
  assert.equal(g.coins.length, 2, 'a new coin replaces the collected one');
  assert.equal(g.lit.get(c1.holdId), COLORS.collected, 'collected hold flashes green');
});

test('coins: a new coin is placed at a reachable distance from the hands', () => {
  const g = createGame('coins', holds, wall, rng(3));
  g.start(0); g.update(2100, none);
  const held = holds[70];
  g.update(2200, { ...none, LH: held.id, RH: held.id });
  g.coins.length = 0;
  g.update(2300, { ...none, LH: held.id, RH: held.id });
  for (const c of g.coins) {
    const h = holds.find((x) => x.id === c.holdId), d = Math.hypot(h.cx - held.cx, h.cy - held.cy) / PX;
    assert.ok(d >= 35 && d <= 110, `coin ${d.toFixed(0)} cm away`);
    assert.notEqual(c.holdId, held.id);
  }
});

test('coins: quick grabs build a combo up to x3, expiry resets it, golden coin every fifth', () => {
  const g = createGame('coins', holds, wall, rng(11));
  g.start(0); g.update(2100, none);
  let t = 2100, last = 0;
  for (let i = 0; i < 6; i++) {
    const coin = g.coins[0];
    t += 500; g.update(t, none);
    t += 100; g.update(t, { ...none, LH: coin.holdId });
    assert.ok(g.score > last);
    last = g.score;
  }
  assert.equal(g.combo, 3);
  g.update(t + 20_000, none);
  assert.equal(g.combo, 1, 'combo resets when nothing is grabbed for long');
});

test('coins: unheld coins expire, the coin turns orange before that, the game ends after 60 s of game time', () => {
  const g = createGame('coins', holds, wall, rng(5));
  g.start(0); g.update(2100, none);
  const id = g.coins[0].holdId;
  g.update(2100 + 12_000, none);
  const soon = g.coins.find((c) => c.holdId === id);
  if (soon && soon.value === 1) assert.equal(g.lit.get(id), COLORS.coinSoon);
  g.update(2100 + 15_000, none);
  assert.ok(g.coins.every((c) => c.spawnedAt > 2100), 'the first coins expired and were replaced');
  g.update(2100 + 60_001, none);
  assert.equal(g.over, true);
  assert.equal(g.lit.size, 0);
});

test('coins: the time bar and the effects follow the game clock; a lost climber freezes the 60 seconds', () => {
  const g = createGame('coins', holds, wall, rng(6));
  g.start(0);
  g.update(500, none);
  assert.deepEqual(g.output().fx, { kind: 'countdown', n: 2 });
  g.update(1500, none);
  assert.deepEqual(g.output().fx, { kind: 'countdown', n: 1 });
  g.update(2100, none);
  assert.equal(g.output().fx.kind, 'go');
  g.update(4000, none);
  assert.equal(g.output().fx, null);
  assert.ok(g.output().hud.top.value > 0.9);
  g.update(2100 + 25_000, none);
  assert.deepEqual(g.output().hud.top.color, COLORS.time);
  g.update(2100 + 40_000, none);
  assert.deepEqual(g.output().hud.top.color, COLORS.timeLow);
  // the climber disappears for 20 s: no time runs out
  const left = g.state().secondsLeft;
  g.update(2100 + 41_000, ctx(null, none, false));
  g.update(2100 + 61_000, ctx(null, none, false));
  assert.ok(g.state().secondsLeft >= left - 3, 'about the same time left');
  assert.equal(g.over, false);
});

test('coins: easy has more coins for longer, hard fewer for shorter; records need a hand', () => {
  const easy = createGame('coins', holds, wall, rng(8), 'easy'), hard = createGame('coins', holds, wall, rng(8), 'hard');
  easy.start(0); hard.start(0); easy.update(2100, none); hard.update(2100, none);
  assert.equal(easy.coins.length, 3);
  assert.equal(hard.coins.length, 2);
  assert.ok(easy.cfg.ttl > hard.cfg.ttl);
});

test('games only ever use the holds they were given (the playable ones)', () => {
  const some = holds.filter((h) => h.id % 3 === 0), ids = new Set(some.map((h) => h.id));
  const c = createGame('coins', some, wall, rng(9));
  c.start(0); c.update(2100, none);
  for (let t = 2200; t < 40_000; t += 700) { c.update(t, none); assert.ok(c.coins.every((k) => ids.has(k.holdId))); }
  const k = createGame('chaser', some, wall, rng(9));
  k.start(0); k.update(3100, ctx(box(500, 500)));
  for (let t = 3200; t < 90_000; t += 200) { k.update(t, ctx(box(500, 500))); for (const id of k.lit.keys()) assert.ok(ids.has(id)); }
});

// ---------- dodge ----------
const dodge = (difficulty = 'medium', seed = 2, body = box(500, 600)) => {
  const g = createGame('dodge', holds, wall, rng(seed), difficulty);
  g.start(0);
  g.update(3100, ctx(body));   // countdown over
  return g;
};
const laneW = (g) => g.px(g._laneCm());
/** Stop the rows (speed 0) and the spawning so a test can place them by hand. */
const still = (g) => { g.cfg.startSpeedCm = 0; g.cfg.speedGainCm = 0; g.cfg.maxSpeedCm = 0; g.nextRowAt = Infinity; return g; };

test('dodge: a row first warns (dim, still, harmless), then falls red', () => {
  const g = dodge();
  assert.equal(g.state().phase, 'running');
  assert.equal(g.rows.length, 0, 'the first row comes a moment after the start');
  g.update(3100 + g.cfg.firstRowMs + 50, ctx(box(500, 600)));
  assert.equal(g.rows.length, 1);
  assert.equal(g.rows[0].live, false);
  const y0 = g.rows[0].y;
  g.update(3100 + g.cfg.firstRowMs + 1000, ctx(box(500, 600)));
  assert.equal(g.rows[0].y, y0, 'does not move while warning');
  assert.equal(g.lit.size, 0, 'no hold is red yet');
  assert.ok(g.zones.length >= 0 && g.zones.every((z) => z.color === COLORS.warn));
  let t = 3100 + g.cfg.firstRowMs + 50 + g.cfg.warnMs + 100;
  g.update(t, ctx(box(500, 600)));
  assert.equal(g.rows[0].live, true);
  g.update(t + 1000, ctx(box(500, 600)));
  assert.ok(g.rows[0].y > y0, 'now it falls');
  assert.ok(g.zones.every((z) => z.color === COLORS.danger));
});

test('dodge: every row has a free lane at least as wide as the body; blocks never reach into it; the lane stays in the field', () => {
  for (const level of DIFFICULTIES.map((d) => d.id)) {
    const g = dodge(level, 3);
    for (let i = 0; i < 300; i++) {
      const row = g._planRow(box(g.lane ?? 500, 600));
      g.lane = (row.lane.x0 + row.lane.x1) / 2;
      assert.ok(row.lane.x1 - row.lane.x0 >= g.px(g.cfg.bodyCm), `${level}: lane ${(row.lane.x1 - row.lane.x0) / PX} cm`);
      assert.ok(row.lane.x0 >= wall.field.x0 - 1e-6 && row.lane.x1 <= wall.field.x1 + 1e-6, 'lane inside the field');
      for (const b of row.blocks) assert.ok(b.x1 <= row.lane.x0 + 1e-6 || b.x0 >= row.lane.x1 - 1e-6, `${level}: block in the lane`);
      assert.ok(row.blocks.length <= g.cfg.maxBlocks);
    }
  }
});

test('dodge: the lane moves by at most (lane - body) from one row to the next', () => {
  const g = dodge('medium', 4);
  let prev = null;
  for (let i = 0; i < 300; i++) {
    const row = g._planRow(box(prev ?? 500, 600));
    const c = (row.lane.x0 + row.lane.x1) / 2;
    if (prev != null) assert.ok(Math.abs(c - prev) <= laneW(g) - g.px(g.cfg.bodyCm) + 1e-6, `moved ${Math.abs(c - prev) / PX} cm`);
    prev = c; g.lane = c;
  }
});

test('dodge: a lane is never planned further from the climber than they can get before the row arrives', () => {
  const g = dodge('hard', 5);
  for (let i = 0; i < 300; i++) {
    const x = 100 + (i * 37) % 800, body = box(x, 500);
    g.lane = null;
    const row = g._planRow(body), c = (row.lane.x0 + row.lane.x1) / 2;
    const arrival = g.cfg.warnMs / 1000 + Math.max(0, body.bounds.y0 - wall.field.y0) / g.px(g.speedCm());
    const reach = g.px(g.cfg.comfortCmS) * arrival + (laneW(g) - g.px(g.cfg.bodyCm)) / 2;
    assert.ok(Math.abs(c - x) <= reach + 1e-6 || c === wall.field.x0 + laneW(g) / 2 || c === wall.field.x1 - laneW(g) / 2, `lane ${(Math.abs(c - x) / PX).toFixed(0)} cm from the climber`);
  }
});

test('dodge: a row that arrives very soon stays off the climber', () => {
  const g = dodge('medium', 6);
  const body = box(500, 60 * PX / PX + 140);            // the head is near the top: no time to react
  body.bounds.y0 = wall.field.y0 + 10;
  for (let i = 0; i < 200; i++) {
    g.lane = null;
    const row = g._planRow(body);
    for (const b of row.blocks) assert.ok(b.x1 < body.bounds.x0 || b.x0 > body.bounds.x1, 'no block on the climber');
  }
});

test('dodge: any body part in a falling block gets a moment to leave; then one life, then a shield', () => {
  const g = still(dodge()), body = box(500, 500);
  g.rows = [{ y: 500, blocks: [{ x0: 480, x1: 620 }], lane: { x0: 0, x1: 100 }, warnUntil: 0, live: true }];
  let t = 4000;
  g.update(t, ctx(body));
  assert.equal(g.lives, 3, 'grace: nothing yet');
  g.update(t += 400, ctx(body));
  assert.equal(g.lives, 3);
  g.update(t += 400, ctx(body));                                 // past graceMs (700)
  assert.equal(g.lives, 2);
  assert.deepEqual(g.output().bodyTint, COLORS.hit, 'the stick figure flashes');
  g.update(t += 700, ctx(body));
  assert.equal(g.lives, 2, 'shield after a hit');
  g.update(t += 1500, ctx(body));
  g.update(t += 800, ctx(body));
  assert.equal(g.lives, 1);
});

test('dodge: an arm in the block counts, a body beside it does not, leaving in time costs nothing', () => {
  const g = still(dodge());
  g.rows = [{ y: 500, blocks: [{ x0: 700, x1: 800 }], lane: { x0: 0, x1: 100 }, warnUntil: 0, live: true }];
  g.update(4000, ctx(box(500, 500, 70)));
  g.update(5500, ctx(box(500, 500, 70)));
  assert.equal(g.lives, 3, 'beside the block');
  const wide = box(500, 500, 170);                                // arms out: reaches x = 738
  g.update(5600, ctx(wide)); g.update(6500, ctx(wide));
  assert.equal(g.lives, 2, 'a part of the body is in the block');
  const g2 = still(dodge('medium', 3));
  g2.rows = [{ y: 500, blocks: [{ x0: 480, x1: 620 }], lane: { x0: 0, x1: 100 }, warnUntil: 0, live: true }];
  g2.update(4000, ctx(box(500, 500))); g2.update(4300, ctx(box(100, 500))); g2.update(5200, ctx(box(100, 500)));
  assert.equal(g2.lives, 3, 'stepped out within the grace time');
});

test('dodge: without a body the holds the hands and feet are on decide (fallback)', () => {
  const g = still(dodge('medium', 2, null)), h = holds[0];
  g.rows = [{ y: h.cy, blocks: [{ x0: h.cx - 20, x1: h.cx + 20 }], lane: { x0: 0, x1: 10 }, warnUntil: 0, live: true }];
  const c = { contacts: { ...none, LH: h.id }, body: null, tracked: true };
  g.update(4000, c); g.update(4900, c);
  assert.equal(g.lives, 2);
  const notGiven = still(createGame('dodge', holds.filter((x) => x.id !== h.id), wall, rng(2)));
  notGiven.start(0); notGiven.update(3100, ctx(null));
  still(notGiven);
  notGiven.rows = [{ y: h.cy, blocks: [{ x0: h.cx - 20, x1: h.cx + 20 }], lane: { x0: 0, x1: 10 }, warnUntil: 0, live: true }];
  notGiven.update(4000, c); notGiven.update(5000, c);
  assert.equal(notGiven.lives, 3, 'a hold without light is never a trap');
});

test('dodge: lives run out -> game over with the red sweep; nothing is red after', () => {
  const g = still(dodge('easy'));
  g.rows = [{ y: 500, blocks: [{ x0: 400, x1: 700 }], lane: { x0: 0, x1: 10 }, warnUntil: 0, live: true }];
  let t = 4000;
  const body = box(500, 500);
  g.update(t, ctx(body));
  for (let i = 0; i < 12 && !g.over; i++) { t += 2500; g.update(t, ctx(body)); }
  assert.equal(g.lives, 0);
  assert.equal(g.over, true);
  assert.equal(g.output().fx.kind, 'sweep');
  assert.deepEqual(g.output().fx.color, COLORS.danger);
  assert.equal(g.lit.size, 0);
});

test('dodge: a lost climber stops the rows and costs nothing', () => {
  const g = dodge();
  g.update(3100 + 2600, ctx(box(500, 600)));
  const rows = g.rows.length, y = g.rows[0]?.y, lives = g.lives;
  g.update(3100 + 2700, ctx(null, none, false));
  g.update(3100 + 2700 + TRACKING_GRACE_MS + 200, ctx(null, none, false));
  g.update(3100 + 40_000, ctx(null, none, false));
  assert.equal(g.paused, true);
  assert.equal(g.rows.length, rows);
  assert.ok(Math.abs(g.rows[0].y - y) < g.px(40), 'the rows stand still');
  assert.equal(g.lives, lives);
});

/**
 * A climber who plays well: stays inside the lane of every row that is on their body, and heads for the lane of the next row
 * early, at 80 % of the comfortable sideways speed. Returns the lives lost and the worst shortage of reaction time seen.
 */
function playWell(level, seed, seconds = 180, { y = 600, bodyCm = 70, heightCm = 170, speedShare = 0.8 } = {}) {
  const g = createGame('dodge', holds, wall, rng(seed), level);
  g.start(0);
  let x = 500;
  const hw = (bodyCm * PX) / 2, top = () => y - (heightCm * PX) / 2, bottom = () => y + (heightCm * PX) / 2;
  for (let t = 0; t < seconds * 1000; t += 50) {
    const on = g.rows.filter((r) => r.y + g.halfRow > top() && r.y - g.halfRow < bottom());      // rows on the body now
    const coming = g.rows.filter((r) => r.y + g.halfRow <= top()).sort((a, b) => b.y - a.y)[0];  // the next one above
    let lo = -Infinity, hi = Infinity;
    for (const r of on) { lo = Math.max(lo, r.lane.x0 + hw); hi = Math.min(hi, r.lane.x1 - hw); }
    if (coming) { const l2 = coming.lane.x0 + hw, h2 = coming.lane.x1 - hw; if (Math.max(lo, l2) <= Math.min(hi, h2)) { lo = Math.max(lo, l2); hi = Math.min(hi, h2); } }
    const goal = lo <= hi ? clamp(x, lo, hi) : (lo + hi) / 2;
    const step = g.px(g.cfg.comfortCmS * speedShare) * 0.05;
    x += clamp(goal - x, -step, step);
    g.update(t, ctx(box(x, y, bodyCm, heightCm)));
    if (g.over) break;
  }
  return g;
}

test('dodge: a climber who stays in the lane is never hit, on every difficulty (3 minutes, several seeds)', () => {
  for (const level of DIFFICULTIES.map((d) => d.id)) for (const seed of [21, 22, 23]) {
    const g = playWell(level, seed);
    assert.equal(g.lives, g.cfg.lives, `${level}/${seed}: lost ${g.cfg.lives - g.lives} life(s) although the climber stayed in the lane`);
  }
});

test('dodge: the lane is also passable for climbers at the top and the bottom of the wall and for a wide climber', () => {
  for (const y of [300, 500, 800]) {
    const g = playWell('hard', 31, 120, { y, heightCm: 150 });
    assert.equal(g.lives, g.cfg.lives, `hard, centre y=${y}`);
  }
  const wide = playWell('medium', 32, 120, { bodyCm: 100 });
  assert.equal(wide.lives, wide.cfg.lives, 'a 100 cm wide climber: the lane widens');
});

test('dodge: standing still in the first lane for the whole game gets hit (it is a game)', () => {
  const g = createGame('dodge', holds, wall, rng(41), 'hard');
  g.start(0);
  for (let t = 0; t < 240_000 && !g.over; t += 50) g.update(t, ctx(box(500, 600)));
  assert.ok(g.lives < g.cfg.lives, 'a climber who never moves loses lives');
});
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

test('dodge: harder levels are faster and narrower; speed grows but is capped; rows leave the field', () => {
  const speeds = {}, lanes = {};
  for (const level of DIFFICULTIES.map((d) => d.id)) {
    const g = dodge(level, 4), v0 = g.speedCm();
    for (let t = 3200; t < 3100 + 200_000; t += 200) g.update(t, ctx(box(500, 600)));
    assert.ok(g.speedCm() > v0 && g.speedCm() <= g.cfg.maxSpeedCm);
    assert.ok(g.rows.every((r) => r.y - g.halfRow < wall.field.y1 + 1));
    speeds[level] = g.cfg.startSpeedCm; lanes[level] = g.cfg.laneCm;
  }
  assert.ok(speeds.easy < speeds.medium && speeds.medium < speeds.hard);
  assert.ok(lanes.easy > lanes.medium && lanes.medium > lanes.hard);
});

test('dodge: the lane widens for a wide body so it always fits', () => {
  const g = dodge('hard', 7);
  g.update(3200, ctx(box(500, 600, 130)));
  assert.ok(g._laneCm() >= 130 + g.cfg.laneMarginCm);
  g.update(3300, ctx(box(500, 600, 70)));
  assert.equal(g.bodyCm, g.cfg.bodyCm, 'never narrower than the assumed body');
});

test('dodge: bars are at least one LED row thick so no row of LEDs is skipped, spacing keeps at most two rows on a climber', () => {
  const g = dodge();
  assert.ok(g.thicknessPx >= 1.15 * wall.rowPitchPx);
  for (const level of DIFFICULTIES.map((d) => d.id)) {
    const d = dodge(level, 9);
    for (let t = 3200; t < 3100 + 120_000; t += 100) {
      d.update(t, ctx(box(500, 600)));
      const y = d.rows.filter((r) => r.live).map((r) => r.y).sort((a, b) => a - b);
      for (let i = 1; i < y.length; i++) assert.ok(y[i] - y[i - 1] >= d.px(d.cfg.spacingCm) * 0.8, `${level}: rows ${((y[i] - y[i - 1]) / PX).toFixed(0)} cm apart`);
    }
  }
});

test('dodge: output has lives, speed, score ticks and the effects for the wall', () => {
  const g = createGame('dodge', holds, wall, rng(2));
  g.start(0);
  g.update(1000, ctx(box(500, 600)));
  assert.deepEqual(g.output().fx, { kind: 'countdown', n: 2 });
  g.update(3100, ctx(box(500, 600)));
  assert.equal(g.output().fx.kind, 'go');
  const hud = g.output().hud;
  assert.deepEqual([hud.top.kind, hud.top.count, hud.top.lit], ['segments', 3, 3]);
  assert.equal(hud.left.kind, 'bar'); assert.ok(hud.left.value > 0 && hud.left.value < 1);
  assert.deepEqual([hud.bottom.kind, hud.bottom.count], ['ticks', 0]);
  g.update(3100 + 12_000, ctx(box(500, 600)));
  assert.equal(g.output().hud.bottom.count, 2, 'one tick per 5 seconds survived');
  assert.equal(g.showsBody, true);
});

// ---------- chaser ----------
const chaser = (difficulty = 'medium', seed = 3) => { const g = createGame('chaser', holds, wall, rng(seed), difficulty); g.start(0); return g; };

test('chaser: the hunter starts far from the climber and hunts them; speed grows to the cap', () => {
  const g = chaser();
  g.update(3100, ctx(box(200, 300)));
  g.update(3200, ctx(box(200, 300)));
  assert.ok(g.hunter, 'hunter exists once running');
  const d0 = Math.hypot(g.hunter.x - 200, g.hunter.y - 300);
  assert.ok(d0 / PX > 300, `starts ${(d0 / PX).toFixed(0)} cm away`);
  let t = 3200, last = d0;
  for (let i = 0; i < 100; i++) { t += 100; g.update(t, ctx(box(200, 300))); }
  assert.ok(Math.hypot(g.hunter.x - 200, g.hunter.y - 300) < last, 'comes closer');
  const v0 = g.speedCm();
  for (let k = 0; k < 2000; k++) { t += 500; g.update(t, ctx(box(900, 900))); if (g.over) { g.lives = 99; g.phase = 'running'; } }
  assert.ok(g.speedCm() > v0 && g.speedCm() <= g.cfg.maxSpeedCm);
});

test('chaser: it rests at the start and after a catch, and never leaves the field', () => {
  const g = chaser();
  g.update(3100, ctx(box(500, 500)));
  const start = { ...g.hunter };
  g.update(3200, ctx(box(500, 500)));
  g.update(4000, ctx(box(500, 500)));
  assert.deepEqual(g.hunter, start, 'rests for a moment first');
  for (let t = 4100; t < 60_000; t += 100) { g.update(t, ctx(box(500 + (t % 7000) / 10, 500))); assert.ok(g.hunter.x >= wall.field.x0 && g.hunter.x <= wall.field.x1 && g.hunter.y >= wall.field.y0 && g.hunter.y <= wall.field.y1); if (g.over) break; }
});

test('chaser: reaching any body part for a moment costs a life, then it restarts far away and rests; a shield follows', () => {
  const g = chaser();
  g.update(3100, ctx(box(500, 500)));
  g.update(3200, ctx(box(500, 500)));
  g.restUntil = 0;
  g.hunter = { x: 500 + 35 * PX + 5, y: 500 };            // 5 px from the edge of the box
  g.update(3300, ctx(box(500, 500)));
  assert.equal(g.lives, 3, 'a moment of grace');
  g.update(3300 + g.cfg.graceMs + 20, ctx(box(500, 500)));
  assert.equal(g.lives, 2);
  assert.deepEqual(g.output().bodyTint, COLORS.hit);
  assert.ok(Math.hypot(g.hunter.x - 500, g.hunter.y - 500) / PX > 200, 'restarted far away');
  assert.ok(g.resting);
  g.hunter = { x: 500 + 35 * PX + 5, y: 500 };
  g.update(4500, ctx(box(500, 500))); g.update(4900, ctx(box(500, 500)));
  assert.equal(g.lives, 2, 'shield');
});

test('chaser: a limb on the green hold freezes the hunter; it comes back; lives run out -> game over', () => {
  const g = chaser();
  g.update(3100, ctx(box(500, 500)));
  g.update(3200, ctx(box(500, 500)));
  g.restUntil = 0; g.nextPickupAt = 0;
  g.update(3300, ctx(box(500, 500)));
  assert.ok(g.pickup, 'a freeze hold is lit');
  assert.equal(g.lit.get(g.pickup.holdId), COLORS.freeze);
  const id = g.pickup.holdId;
  g.update(3400, ctx(box(500, 500), { ...none, RF: id }));
  assert.equal(g.pickup, null);
  assert.ok(g.resting && g.frozenByPickup);
  const before = { ...g.hunter };
  g.update(5000, ctx(box(500, 500)));
  assert.deepEqual(g.hunter, before, 'frozen');
  assert.deepEqual(g.output().marks[0].color, COLORS.hunterFrozen);
  g.update(3400 + g.cfg.freezeMs + 200, ctx(box(500, 500)));
  assert.equal(g.resting, false);
  g.lives = 1; g.restUntil = 0; g.invulnerableUntil = 0;
  g.hunter = { x: 500, y: 500 };
  g.update(30_000, ctx(box(500, 500))); g.update(31_000, ctx(box(500, 500)));
  assert.equal(g.over, true);
  assert.deepEqual(g.output().fx.color, COLORS.hunter);
});

test('chaser: the hunter is drawn as a mark that always covers at least one LED of a lattice', () => {
  const g = chaser();
  g.update(3100, ctx(box(500, 500))); g.update(3200, ctx(box(500, 500)));
  const lattice = [];
  for (let r = 0; r < 24; r++) for (let c = 0; c < 24; c++) lattice.push({ x: 40 + c * 40, y: 40 + r * 40 });
  for (let k = 0; k < 400; k++) {
    g.hunter = { x: 60 + (k * 13.7) % 880, y: 60 + (k * 29.3) % 880 };
    const m = g.output().marks[0];
    assert.ok(lattice.some((l) => Math.hypot(l.x - m.x, l.y - m.y) <= m.r), `no LED within the mark at ${m.x | 0},${m.y | 0}`);
  }
});

test('chaser: without a body the hands and feet decide; a lost climber freezes everything', () => {
  const g = chaser();
  const h = holds[40];
  g.update(3100, { contacts: { ...none, LH: h.id }, body: null, tracked: true });
  g.update(3200, { contacts: { ...none, LH: h.id }, body: null, tracked: true });
  assert.ok(g.hunter);
  g.restUntil = 0;
  g.hunter = { x: h.cx + 5, y: h.cy };
  g.update(3300, { contacts: { ...none, LH: h.id }, body: null, tracked: true });
  g.update(3300 + g.cfg.graceMs + 20, { contacts: { ...none, LH: h.id }, body: null, tracked: true });
  assert.equal(g.lives, 2);
  const pos = { ...g.hunter };
  g.update(4000, ctx(null, none, false)); g.update(4000 + TRACKING_GRACE_MS + 300, ctx(null, none, false)); g.update(20_000, ctx(null, none, false));
  assert.deepEqual(g.hunter, pos);
  assert.equal(g.output().fx.kind, 'lost');
});

test('chaser: output has lives, speed and score ticks', () => {
  const g = chaser();
  g.update(3100, ctx(box(500, 500)));
  const hud = g.output().hud;
  assert.deepEqual([hud.top.kind, hud.top.count, hud.top.lit], ['segments', 3, 3]);
  assert.equal(hud.left.kind, 'bar');
  assert.equal(g.showsBody, true);
  assert.equal(g.state().maxLives, 3);
});
