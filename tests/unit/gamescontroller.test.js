import test from 'node:test';
import assert from 'node:assert/strict';
import { GamesController } from '../../src/app/gamesController.js';
import { WallTest, WALL_TEST_MS } from '../../src/game/walltest.js';
import { COLORS } from '../../src/game/games.js';
import { MAX_GAME_LEDS } from '../../src/game/wallhud.js';
import { rng } from '../../src/core/rng.js';

/** 33 landmarks of a standing climber (wall px), centre (cx, cy), 170 cm tall. */
function figure(cx = 500, cy = 500, PX = 2.8) {
  const h = 170 * PX, j = Array.from({ length: 33 }, () => ({ x: cx, y: cy, v: 1 }));
  const set = (i, dx, dy) => { j[i] = { x: cx + dx * PX, y: cy + dy * PX, v: 1 }; };
  set(0, 0, -75); set(11, -20, -55); set(12, 20, -55); set(13, -30, -30); set(14, 30, -30); set(15, -32, -5); set(16, 32, -5);
  set(23, -12, 0); set(24, 12, 0); set(25, -13, 38); set(26, 13, 38); set(27, -13, 78); set(28, 13, 78); set(31, -15, 84); set(32, 15, 84);
  return j;
}
/** One pose frame at time t, then one game frame. */
function tick(app, t, joints = figure()) { app.liveBody = { t, joints }; app.games.tick(t); }

// a 24 x 24 LED field, a hold on every LED except a few unmapped ones (no LED) and a ghost marker
function makeApp({ connected = true, tracking = true } = {}) {
  const r = rng(5), leds = [], holds = [];
  let pos = 1, id = 1;
  for (let row = 0; row < 24; row++) for (let col = 0; col < 24; col++) {
    const x = 60 + col * 39 + (r() - 0.5) * 4, y = 50 + row * 39 + (r() - 0.5) * 4;
    leds.push({ pos, x, y, conf: 1 });
    holds.push({ id: id++, cx: x, cy: y, label: id, led: pos % 17 === 0 ? undefined : pos, ghost: false });
    pos++;
  }
  holds.push({ id: 9999, cx: 500, cy: 500, ghost: true, led: 5 });
  const log = [], toasts = [], frames = [], store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const app = {
    s: { game: { id: 'coins', current: null, active: false, state: null, best: {}, opts: { difficulty: 'medium', hud: true }, info: {} }, board: { leds }, live: { running: tracking, lightBoard: false } },
    holds, wallDims: { RW: 1000, RH: 1000, pxPerCm: 2.8 }, board: { connected }, tracking, tracker: { contacts: { LH: null, RH: null, LF: null, RF: null } },
    game: null, showLit: null, showZones: null, showLeds: null, liveBody: null,
    kilterSink: { enabled: null, setEnabled(v) { this.enabled = v; } },
    set(p) { Object.assign(this.s, p); },
    log(k, d) { log.push([k, d]); }, toast(m, kind) { toasts.push([m, kind]); },
    _pushLeds(f) { frames.push(f); }, async _ledsOff() { frames.push('off'); },
  };
  app.games = new GamesController(app);
  return { app, log, toasts, frames, store };
}

test('plan: only holds with an LED, not the status strips; ghosts never; no LED map -> everything, screen only', () => {
  const { app } = makeApp();
  const p = app.games.plan();
  assert.equal(p.onWall, true);
  assert.equal(p.hud, true);
  assert.ok(p.holds.every((h) => h.led != null && !h.ghost));
  assert.ok(p.holds.length > 400 && p.holds.length < 576 - 60, `${p.holds.length} playable`);
  const noStrips = app.games.plan({ hud: false });
  assert.equal(noStrips.hud, false);
  assert.ok(noStrips.holds.length > p.holds.length, 'with the strips off those holds are playable');
  const disconnected = makeApp({ connected: false }).app.games.plan();
  assert.equal(disconnected.onWall, false);
  assert.equal(disconnected.layout, null);
  const noLeds = makeApp().app;
  noLeds.holds.forEach((h) => { delete h.led; });
  const q = noLeds.games.plan();
  assert.equal(q.onWall, false);
  assert.equal(q.holds.length, 576, 'screen only: every real hold');
});

test('start needs tracking and enough playable holds; wall test needs the board', () => {
  const off = makeApp({ tracking: false });
  off.app.games.start('coins');
  assert.equal(off.app.game, null);
  assert.match(off.toasts[0][0], /tracking/i);
  const noBoard = makeApp({ connected: false });
  noBoard.app.games.startWallTest();
  assert.equal(noBoard.app.game, null);
  assert.equal(noBoard.toasts[0][1], 'error');
  const few = makeApp();
  few.app.holds.forEach((h, i) => { if (i > 5) delete h.led; });
  few.app.games.start('coins');
  assert.equal(few.app.game, null, 'too few playable holds');
});

test('a running game shows the hands and feet on the wall at all times, above targets', () => {
  const { app, frames } = makeApp();
  app.games.start('coins');
  assert.ok(app.game);
  assert.equal(app.kilterSink.enabled, false, 'the sink is off, the game draws the limbs itself');
  const rgb = (f, pos) => { const l = f.find((x) => x.pos === pos); return l ? [l.r, l.g, l.b] : null; };
  let t = performance.now();
  app.game.start(t);
  tick(app, t + 2200);                      // past the countdown: coins are on (the GO flash covers the wall for a moment)
  const coin = app.game.coins[0], coinHold = app.holds.find((h) => h.id === coin.holdId);
  const other = app.holds.find((h) => h.led != null && h.id !== coin.holdId && !app.game.coins.some((c) => c.holdId === h.id) && app.games.byId.has(h.id));
  const rest = app.holds.find((h) => h.led != null && h.id !== coinHold.id && h.id !== other.id && app.games.byId.has(h.id));
  app.tracker.contacts = { LH: rest.id, RH: null, LF: other.id, RF: null };
  tick(app, t + 3000);
  const f = frames.at(-1);
  assert.deepEqual(rgb(f, other.led), [255, 140, 0], 'a foot is shown in orange');
  assert.deepEqual(rgb(f, rest.led), [0, 255, 255], 'a hand is shown in cyan');
  assert.ok(rgb(f, coinHold.led), 'the coin itself is lit too');
  // the hand grabs the coin: the flash must still be visible
  app.tracker.contacts = { LH: null, RH: null, LF: null, RF: null };
  tick(app, t + 3100);
  app.tracker.contacts = { LH: coinHold.id, RH: null, LF: null, RF: null };
  tick(app, t + 3200);
  assert.equal(app.game.collected, 1);
  assert.deepEqual(rgb(frames.at(-1), coinHold.led), [COLORS.collected.r, COLORS.collected.g, COLORS.collected.b], 'collected flash wins over the hand colour');
  tick(app, t + 3900);
  assert.deepEqual(rgb(frames.at(-1), coinHold.led), [0, 255, 255], 'afterwards the hand colour again');
  assert.ok(app.showLeds.length > 0 && app.showLeds.every((l) => Number.isFinite(l.x)), 'the screen mirrors what the wall shows');
});

test('hand beats foot on the same hold; the frame stays within the LED cap', () => {
  const { app, frames } = makeApp();
  app.games.start('dodge');
  const t = performance.now();
  app.game.start(t);
  const h = [...app.games.byId.values()][100];
  app.tracker.contacts = { LH: null, RH: h.id, LF: h.id, RF: null };
  for (let k = 0; k < 400; k++) tick(app, t + 3100 + k * 100);
  assert.ok(frames.filter((f) => Array.isArray(f)).every((f) => f.length <= MAX_GAME_LEDS), 'never more than the cap');
  assert.deepEqual([frames.at(-1).find((l) => l.pos === h.led)].map((l) => [l.r, l.g, l.b])[0], [0, 255, 255]);
});

test('records are kept per game and difficulty, only a better score replaces them, old records count as medium', () => {
  const { app, store } = makeApp();
  store.set('bv.game.best', JSON.stringify({ coins: 12, dodge: 40 }));
  app.games.load();
  assert.deepEqual(app.s.game.best, { 'coins:medium': 12, 'dodge:medium': 40 });
  app.games.setOpts({ difficulty: 'hard', hud: false });
  assert.deepEqual(app.s.game.opts, { difficulty: 'hard', hud: false });
  app.games.setOpts({ difficulty: 'nonsense' });
  assert.equal(app.s.game.opts.difficulty, 'hard', 'unknown difficulty is ignored');
  app.games.start('coins');
  const g = app.game, t = performance.now();
  g.start(t); g.score = 7;
  tick(app, t + 2100);
  tick(app, t + 2100 + 60_001);            // time is up
  assert.equal(g.over, true);
  assert.equal(app.s.game.best['coins:hard'], 7, 'new record for hard');
  assert.equal(app.s.game.best['coins:medium'], 12, 'medium untouched');
  assert.equal(g.record, true);
  assert.equal(JSON.parse(store.get('bv.game.best'))['coins:hard'], 7);
  tick(app, t + 2100 + 61_000);
  // a worse score later does not replace it
  app.games.stop();
  app.s.game.opts.hud = false;
  app.games.start('coins');
  const g2 = app.game; g2.start(t); g2.score = 3;
  tick(app, t + 2100);
  tick(app, t + 2100 + 60_001);
  assert.equal(app.s.game.best['coins:hard'], 7);
  assert.equal(g2.record, false);
  // selecting and settings are locked while a game runs
  app.games.select('dodge');
  assert.equal(app.s.game.id, 'coins');
  app.games.setOpts({ difficulty: 'easy' });
  assert.equal(app.s.game.opts.difficulty, 'hard');
});

test('corrupt stored records and settings do not break loading', () => {
  const { app, store } = makeApp();
  store.set('bv.game.best', '{not json'); store.set('bv.game.opts', 'x');
  assert.doesNotThrow(() => app.games.load());
  assert.deepEqual(app.s.game.best, {});
  assert.equal(app.s.game.opts.difficulty, 'medium');
});

test('stop clears the wall and the mirror and hands hand/foot lighting back', async () => {
  const { app, frames } = makeApp();
  app.s.live.lightBoard = true;
  app.games.start('coins');
  tick(app, performance.now() + 100);
  await app.games.stop();
  assert.equal(app.game, null);
  assert.equal(app.showLeds, null);
  assert.equal(app.s.game.active, false);
  assert.equal(frames.at(-1), 'off');
  assert.equal(app.kilterSink.enabled, true, 'hands and feet are lit by the normal sink again');
});

test('wall test: runs through every display once, within the LED cap, and ends', () => {
  const { app, frames, toasts } = makeApp({ tracking: false });
  app.games.startWallTest();
  assert.ok(app.game instanceof WallTest, toasts.join());
  assert.equal(app.s.game.current, 'walltest');
  const t0 = performance.now();
  app.game.start(t0);
  const kinds = new Set(), seen = { zonesWarn: false, zonesRed: false, strips: false, targets: false };
  for (let t = 0; t <= WALL_TEST_MS + 500; t += 100) {
    tick(app, t0 + t);
    const out = app.game.output(t0 + t);
    if (out.fx) kinds.add(out.fx.kind);
    if (out.zones.some((z) => z.color === COLORS.warn)) seen.zonesWarn = true;
    if (out.zones.some((z) => z.color === COLORS.danger)) seen.zonesRed = true;
    if (out.hud && !out.fx) seen.strips = true;
    if (out.lit.size) seen.targets = true;
  }
  assert.deepEqual([...kinds].sort(), ['countdown', 'go', 'sweep']);
  assert.deepEqual(seen, { zonesWarn: true, zonesRed: true, strips: true, targets: true });
  assert.ok(frames.filter(Array.isArray).every((f) => f.length <= MAX_GAME_LEDS));
  assert.ok(frames.filter(Array.isArray).some((f) => f.length >= 15), 'something real was shown');
  assert.equal(app.game.over, true);
  assert.equal(app.s.game.best['walltest:medium'], undefined, 'a practice run is no record');
});
