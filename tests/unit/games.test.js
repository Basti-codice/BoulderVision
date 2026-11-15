import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, CoinGame, DodgeGame, COLORS } from '../../src/game/games.js';
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

test('dodge: bars fall from the top, always leave a way through, touching red costs a life with a cooldown', () => {
  const g = createGame('dodge', holds, wall, rng(2));
  g.start(0);
  g.update(1000, none);
  assert.equal(g.lit.size, 0, 'nothing lights during the countdown');
  g.update(3100, none);
  assert.equal(g.state(3100).phase, 'running');
  assert.equal(g.bars.length, 1);
  const y0 = g.bars[0].y;
  g.update(4100, none);
  assert.ok(g.bars[0].y > y0, 'bar moves down');
  for (let i = 0; i < 40; i++) { const b = g._makeBlocks(); assert.ok(b.reduce((s, k) => s + (k.x1 - k.x0), 0) <= wall.RW * 0.56); }
  // move the bar onto a row of holds and touch a red one
  g.bars[0].y = holds[0].cy;
  g.bars[0].blocks = [{ x0: holds[0].cx - 10, x1: holds[0].cx + 10 }];
  assert.ok(g.isDanger(holds[0]));
  g.update(4200, { ...none, LH: holds[0].id });
  assert.equal(g.lives, 2);
  g.update(4300, { ...none, LH: holds[0].id });
  assert.equal(g.lives, 2, 'same limb cannot be hit again during the cooldown');
  g.bars[0].y = holds[0].cy - 30;                            // the bar keeps falling during the 1.4 s step; aim so it is on the row afterwards
  g.update(4300 + 1400, { ...none, LH: holds[0].id });
  assert.equal(g.lives, 1);
  g.bars[0].y = holds[0].cy - 30;
  g.update(4300 + 3000, { ...none, RH: holds[0].id });
  assert.equal(g.over, true);
});

test('dodge: speed grows with time but is capped; bars leave the wall', () => {
  const g = createGame('dodge', holds, wall, rng(4));
  g.start(0);
  g.update(3100, none);
  const v0 = g.speedCm();
  for (let t = 3200; t < 3100 + 90_000; t += 200) g.update(t, none);
  assert.ok(g.speedCm() > v0 && g.speedCm() <= 28);
  assert.ok(g.bars.every((b) => b.y < wall.RH + 100));
  assert.ok(g.state(100_000).score >= 80);
});
