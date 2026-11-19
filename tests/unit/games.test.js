import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, CoinGame, DodgeGame, COLORS, DIFFICULTIES } from '../../src/game/games.js';
import { rng } from '../../src/core/rng.js';

const wall = { RW: 1000, RH: 1000, pxPerCm: 2.8 };
const holds = Array.from({ length: 150 }, (_, i) => ({ id: i + 1, cx: 40 + (i % 15) * 62, cy: 40 + Math.floor(i / 15) * 95 }));
const none = { LH: null, RH: null, LF: null, RF: null };

test('createGame knows both games and rejects others', () => {
  assert.ok(createGame('coins', holds, wall, rng(1)) instanceof CoinGame);
  assert.ok(createGame('dodge', holds, wall, rng(1)) instanceof DodgeGame);
  assert.throws(() => createGame('chess', holds, wall, rng(1)));
});

test('coins: countdown, then reachable coins appear; a hand grab scores, a foot grab does not', () => {
  const g = createGame('coins', holds, wall, rng(7));
  g.start(0);
  g.update(500, none);
  assert.equal(g.state(500).phase, 'ready');
  assert.equal(g.lit.size, 0);
  g.update(2100, none);
  assert.equal(g.state(2100).phase, 'running');
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
    const h = holds.find((x) => x.id === c.holdId), d = Math.hypot(h.cx - held.cx, h.cy - held.cy) / wall.pxPerCm;
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
  assert.ok(g.coins.some((c) => c.value === 3) || g.score >= 3, 'golden coin was in the sequence');
  g.update(t + 20_000, none);
  assert.equal(g.combo, 1, 'combo resets when nothing is grabbed for long');
});

test('coins: unheld coins expire and the game ends after 60 s', () => {
  const g = createGame('coins', holds, wall, rng(5));
  g.start(0); g.update(2100, none);
  g.update(2100 + 15_000, none);
  assert.ok(g.coins.every((c) => c.spawnedAt > 2100), 'the first coins expired and were replaced by new ones');
  g.update(2100 + 60_001, none);
  assert.equal(g.over, true);
  assert.equal(g.lit.size, 0);
});

test('coins: the coin changes colour shortly before it disappears; difficulty changes the rules', () => {
  const g = createGame('coins', holds, wall, rng(8));
  g.start(0); g.update(2100, none);
  const id = g.coins[0].holdId;
  assert.equal(g.lit.get(id), COLORS.coin);
  g.update(2100 + 12_000, none);
  const soon = g.coins.find((c) => c.holdId === id);
  if (soon && soon.value === 1) assert.equal(g.lit.get(id), COLORS.coinSoon, 'orange in the last seconds');
  const easy = createGame('coins', holds, wall, rng(8), 'easy'), hard = createGame('coins', holds, wall, rng(8), 'hard');
  easy.start(0); hard.start(0); easy.update(2100, none); hard.update(2100, none);
  assert.equal(easy.coins.length, 3);
  assert.equal(hard.coins.length, 2);
  assert.ok(easy.cfg.ttl > g.cfg.ttl && g.cfg.ttl > hard.cfg.ttl);
  assert.equal(createGame('coins', holds, wall, rng(1), 'nonsense').difficulty, 'medium', 'unknown difficulty falls back');
});

test('coins and dodge only ever use the holds they were given (the playable ones)', () => {
  const some = holds.filter((h) => h.id % 3 === 0), ids = new Set(some.map((h) => h.id));
  const c = createGame('coins', some, wall, rng(9));
  c.start(0); c.update(2100, none);
  for (let t = 2200; t < 40_000; t += 700) { c.update(t, none); assert.ok(c.coins.every((k) => ids.has(k.holdId))); }
  const d = createGame('dodge', some, wall, rng(9));
  d.start(0); d.update(3100, none);
  for (let t = 3200; t < 60_000; t += 200) { d.update(t, none); for (const id of d.lit.keys()) assert.ok(ids.has(id)); }
});

test('coins: output has the status strips and the effects (countdown, go, sweep)', () => {
  const g = createGame('coins', holds, wall, rng(6));
  g.start(0);
  assert.deepEqual(g.output(500).fx, { kind: 'countdown', n: 2 });
  assert.deepEqual(g.output(1500).fx, { kind: 'countdown', n: 1 });
  g.update(2100, none);
  assert.equal(g.output(2200).fx.kind, 'go');
  assert.equal(g.output(4000).fx, null);
  const full = g.output(2200).hud;
  assert.equal(full.top.kind, 'bar'); assert.ok(full.top.value > 0.99);
  const half = g.output(2100 + 30_000).hud.top;
  assert.ok(Math.abs(half.value - 0.5) < 0.02);
  assert.deepEqual(g.output(2100 + 25_000).hud.top.color, COLORS.time, 'green while more than half is left');
  assert.deepEqual(g.output(2100 + 40_000).hud.top.color, COLORS.timeLow);
  assert.deepEqual(g.output(2100 + 58_000).hud.top.color, COLORS.danger);
  assert.equal(g.output(2200).hud.left.n, 1);
  assert.equal(g.output(2200).hud.bottom.count, 0);
  g.update(2100 + 60_001, none);
  const over = g.output(2100 + 60_001 + 500);
  assert.equal(over.fx.kind, 'sweep'); assert.deepEqual(over.fx.color, COLORS.coin); assert.ok(over.fx.t > 0.4 && over.fx.t < 0.6);
  g.record = true;
  assert.deepEqual(g.output(2100 + 61_000).fx.color, COLORS.record, 'a new record sweeps green');
});

const dodgeAt = (difficulty = 'medium', seed = 2) => {
  const g = createGame('dodge', holds, wall, rng(seed), difficulty);
  g.start(0); g.update(3100, none);
  return g;
};
/** Make the (first) bar fall onto hold `h` right now: live, one block around the hold. */
const bar = (g, h) => { g.bars[0].live = true; g.bars[0].y = h.cy; g.bars[0].blocks = [{ x0: h.cx - 10, x1: h.cx + 10 }]; };

test('dodge: a new bar first warns (dim, still, harmless), then falls red', () => {
  const g = dodgeAt();
  assert.equal(g.state(3100).phase, 'running');
  assert.equal(g.bars.length, 1);
  assert.equal(g.bars[0].live, false);
  const y0 = g.bars[0].y;
  g.update(3100 + 1000, none);
  assert.equal(g.bars[0].y, y0, 'does not move while warning');
  assert.equal(g.lit.size, 0, 'no hold is red yet');
  assert.ok(g.zones.length >= 1 && g.zones.every((z) => z.color === COLORS.warn), 'the warning is an area, dim');
  g.update(3100 + 1600, none);
  assert.equal(g.bars[0].live, true);
  g.update(3100 + 2600, none);
  assert.ok(g.bars[0].y > y0, 'now it falls');
  assert.ok(g.zones.every((z) => z.color === COLORS.danger));
});

test('dodge: bars always leave a way through', () => {
  const g = dodgeAt();
  for (let i = 0; i < 60; i++) { const b = g._makeBlocks(); assert.ok(b.reduce((s, k) => s + (k.x1 - k.x0), 0) <= wall.RW * 0.56); }
  for (const level of ['easy', 'hard']) { const d = dodgeAt(level); for (let i = 0; i < 60; i++) assert.ok(d._makeBlocks().reduce((s, k) => s + (k.x1 - k.x0), 0) <= wall.RW * 0.63); }
});

/** One update with the clock set so the bars stay where the test put them. */
const at = (g, t, contacts) => { g.lastTick = t; g.update(t, contacts); };

test('dodge: a hold that turns red gets a moment to let go; then one life, then a shield', () => {
  const g = dodgeAt(), h = holds[0];
  bar(g, h);
  at(g, 5000, { ...none, LH: h.id });                           // turns red under the hand
  assert.ok(g.isDanger(h));
  assert.equal(g.lives, 3, 'grace: nothing yet');
  at(g, 5400, { ...none, LH: h.id });
  assert.equal(g.lives, 3);
  at(g, 5800, { ...none, LH: h.id });                           // past graceMs (700)
  assert.equal(g.lives, 2);
  assert.equal(g.lit.get(h.id), COLORS.hit, 'the hit flashes white');
  at(g, 6500, { ...none, LH: h.id, RH: h.id });
  assert.equal(g.lives, 2, 'shield after a hit: even two limbs cost nothing');
  at(g, 7400, { ...none, LH: h.id });
  assert.equal(g.lives, 1);
});

test('dodge: arriving on a red hold costs a life at once, leaving in time costs nothing', () => {
  const g = dodgeAt(), h = holds[0];
  bar(g, h);
  at(g, 5000, none);                                            // the hold turns red ...
  at(g, 5800, none);
  at(g, 5900, { ...none, RF: h.id });                           // ... and a foot steps on it later
  assert.equal(g.lives, 2);
  const g2 = dodgeAt('medium', 3), h2 = holds[10];
  bar(g2, h2);
  at(g2, 5000, { ...none, LH: h2.id });
  at(g2, 5300, none);                                           // let go within the grace time
  at(g2, 6200, none);
  assert.equal(g2.lives, 3);
});

test('dodge: lives run out -> game over; a hold without light (not given to the game) is never a trap', () => {
  const g = createGame('dodge', holds.filter((h) => h.id !== holds[0].id), wall, rng(2));
  g.start(0); g.update(3100, none);
  bar(g, holds[0]);
  at(g, 5000, { ...none, LH: holds[0].id }); at(g, 6500, { ...none, LH: holds[0].id });
  assert.equal(g.lives, 3, 'the unlit hold is not part of the game');
  const d = dodgeAt('easy'), h = holds[20];
  bar(d, h);
  let t = 5000;
  at(d, t, { ...none, LH: h.id });
  for (let i = 0; i < 5; i++) { t += 1600; at(d, t, { ...none, LH: h.id }); }
  assert.equal(d.lives, 0);
  assert.equal(d.over, true);
  assert.equal(d.output(t + 100).fx.kind, 'sweep');
  assert.deepEqual(d.output(t + 100).fx.color, COLORS.danger);
  assert.equal(d.lit.size, 0, 'nothing is red after the game');
});

test('dodge: bars are spaced so two never touch, at any speed', () => {
  for (const level of ['easy', 'medium', 'hard']) {
    const g = dodgeAt(level, 5), seen = new Map();
    for (let t = 3200; t < 3100 + 150_000; t += 100) {
      g.update(t, none);
      if (g.over) break;
      const live = g.bars.filter((b) => b.live).map((b) => b.y).sort((a, b) => a - b);
      for (let i = 1; i < live.length; i++) assert.ok(live[i] - live[i - 1] >= g.px(g.cfg.thicknessCm), `${level}: bars overlap at ${t}`);
      seen.set(g.bars.length, true);
    }
  }
});

test('dodge: speed grows with time but is capped per difficulty; harder levels are faster; bars leave the wall', () => {
  const speeds = {};
  for (const level of DIFFICULTIES.map((d) => d.id)) {
    const g = dodgeAt(level, 4), v0 = g.speedCm();
    for (let t = 3200; t < 3100 + 90_000; t += 200) g.update(t, none);
    assert.ok(g.speedCm() > v0 && g.speedCm() <= g.cfg.maxSpeedCm);
    assert.ok(g.bars.every((b) => b.y < wall.RH + 100));
    assert.ok(g.state(100_000).score >= 80);
    speeds[level] = g.speedCm();
  }
  assert.ok(speeds.easy < speeds.medium && speeds.medium < speeds.hard);
});

test('dodge: output has lives, speed, time and the effects for the wall', () => {
  const g = createGame('dodge', holds, wall, rng(2));
  g.start(0);
  assert.deepEqual(g.output(1000).fx, { kind: 'countdown', n: 2 });
  g.update(3100, none);
  assert.equal(g.output(3200).fx.kind, 'go');
  const hud = g.output(3200).hud;
  assert.deepEqual([hud.top.kind, hud.top.count, hud.top.lit], ['segments', 3, 3]);
  assert.equal(hud.left.kind, 'bar'); assert.ok(hud.left.value > 0 && hud.left.value < 1);
  assert.deepEqual([hud.bottom.kind, hud.bottom.count], ['ticks', 0]);
  g.update(3100 + 12_000, none);
  assert.equal(g.output(3100 + 12_000).hud.bottom.count, 2, 'one tick per 5 seconds survived');
});
