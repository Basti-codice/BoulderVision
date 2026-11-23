// Climbing games driven by the live body and hand/foot contacts. Pure logic: no DOM, no Bluetooth, deterministic with a seeded
// random generator, so every rule can be unit tested.
//
// A game sees the playable holds (wall pixels), the climber's body (BodyModel from ./body.js, may be null) and the hand/foot
// contacts ({LH,RH,LF,RF} -> hold id | null). update(now, ctx) advances it (ctx = {contacts, body, tracked}); output(now) says what
// the wall shows:
//   lit      Map holdId -> {r,g,b}       target holds / flashes (also drawn on screen)
//   flash    Map holdId -> {r,g,b}       the short feedback inside lit (a collected coin): it stays visible under a hand
//   zones    [{x0,y0,x1,y1,color}]       rectangles in wall px; every LED inside lights, bound to a hold or not (obstacles)
//   marks    [{x,y,r,color}]             round things in wall px; every LED within r lights (the chaser)
//   hud      {top, left, bottom}         status strips for the wall (see wallhud.js)
//   fx       {kind: 'countdown'|'go'|'sweep'|'lost', ...} | null
//   bodyTint {r,g,b} | null              the stick figure flashes in this colour (a hit)
// state(now) is the small summary for the screen HUD.
//
// All timing is GAME time: it stops while the climber is not tracked for longer than TRACKING_GRACE_MS (a lost pose must never
// cost a life). Which holds are "playable" (they have an LED, they are not part of the status strips) is decided by the caller: a
// hold without light would be an invisible target or trap.

import { GO_MS } from './wallhud.js';

/** Light colours (3-3-2 bit friendly on the LED board). */
export const COLORS = {
  coin: { r: 255, g: 200, b: 0 },
  coinSoon: { r: 255, g: 90, b: 0 },
  golden: { r: 255, g: 255, b: 255 },
  collected: { r: 0, g: 255, b: 0 },
  danger: { r: 255, g: 0, b: 0 },
  warn: { r: 110, g: 40, b: 0 },
  hit: { r: 255, g: 255, b: 255 },
  speed: { r: 0, g: 120, b: 255 },
  time: { r: 0, g: 255, b: 0 },
  timeLow: { r: 255, g: 200, b: 0 },
  record: { r: 0, g: 255, b: 0 },
  body: { r: 0, g: 48, b: 150 },         // the stick figure: dim blue (hands and feet keep cyan / orange on top)
  overlap: { r: 255, g: 255, b: 0 },     // a body LED inside an obstacle: you are touching it (yellow: distinct from red, hunter and hand colours on the 3-3-2 board)
  hunter: { r: 255, g: 0, b: 255 },
  hunterFrozen: { r: 90, g: 0, b: 110 },
  freeze: { r: 120, g: 255, b: 0 },      // lime: neither the green flash nor the cyan of a hand
};

/**
 * The games on offer. A game is a class below with start / update / output / state; this list is what the Games area
 * shows. unit: how the score is written (and what "best" means); options: which settings the game uses (see OPTIONS).
 */
export const GAMES = [
  { id: 'coins', title: 'Coins', unit: 'points', options: ['difficulty'], blurb: 'Grab the lit coin holds with your hands. Quick grabs build a combo (up to x3). 60 seconds.' },
  { id: 'dodge', title: 'Dodge', unit: 'seconds', options: ['difficulty'], blurb: 'Blocks fall in rows, announced by a dim warning. There is always a free lane your whole body fits through, but it keeps moving. Any part of you in a red block costs a life.' },
  { id: 'chaser', title: 'Chaser', unit: 'seconds', options: ['difficulty'], blurb: 'A purple light hunts you across the wall and gets faster. Keep your whole body away from it; grab the green hold to freeze it for a few seconds.' },
];
/** Settings a game can ask for (GAMES[].options); the Games area draws them. */
export const OPTIONS = {
  difficulty: { id: 'difficulty', label: 'Difficulty', choices: [{ id: 'easy', title: 'Easy' }, { id: 'medium', title: 'Medium' }, { id: 'hard', title: 'Hard' }] },
};
export const DIFFICULTIES = OPTIONS.difficulty.choices;
/** Records are kept per game and difficulty. */
export const recordKey = (id, difficulty = 'medium') => `${id}:${difficulty}`;
/** "12 points" / "47 s" */
export const formatScore = (id, value) => { const g = GAMES.find((x) => x.id === id); return g?.unit === 'seconds' ? `${value} s` : `${value}`; };

const HAND_LIMBS = ['LH', 'RH'];
const LIMBS = ['LH', 'RH', 'LF', 'RF'];
const NO_CONTACTS = { LH: null, RH: null, LF: null, RF: null };

/** The game clock stops when the climber has not been tracked for this long. */
export const TRACKING_GRACE_MS = 1500;
/** A gap between two updates longer than this (hidden tab, stalled loop) does not count as game time. */
export const MAX_FRAME_GAP_MS = 250;

/** Per difficulty. Medium is the reference. */
const COINS_LEVELS = {
  easy:   { duration: 60_000, simultaneous: 3, ttl: 18_000, reachMinCm: 25, reachMaxCm: 80,  comboWindow: 10_000 },
  medium: { duration: 60_000, simultaneous: 2, ttl: 14_000, reachMinCm: 35, reachMaxCm: 110, comboWindow: 8_000 },
  hard:   { duration: 60_000, simultaneous: 2, ttl: 9_000,  reachMinCm: 45, reachMaxCm: 150, comboWindow: 6_000 },
};
const COINS = {
  countdown: 2_000,         // ms of "get ready" before the first coin
  comboMax: 3,
  goldenEvery: 5,           // every 5th coin is worth more
  goldenValue: 3,
  flash: 450,               // ms a collected hold stays green
  soonMs: 3_000,            // a coin changes colour this long before it disappears
};

/**
 * Dodge. A row of blocks falls; a free LANE runs through every row and always fits the whole body. The lane wanders from row to
 * row by at most (laneCm - bodyCm), so two rows that overlap the body at the same time still share a corridor the body fits
 * through; rows are spaced so that at most two overlap a standing climber; a new lane is never further away than the climber
 * can get (comfortCmS) before the row arrives.
 */
const DODGE_LEVELS = {
  // laneCm: lane width at the start, narrowing by laneShrinkCmS per second of play down to bodyCm + laneMarginCm (the body measured wider than bodyCm widens it)
  easy:   { lives: 5, startSpeedCm: 10, speedGainCm: 0.3,  maxSpeedCm: 24, thicknessCm: 18, laneCm: 150, laneShrinkCmS: 0.15, laneMarginCm: 40, bodyCm: 75, comfortCmS: 15, spacingCm: 140, warnMs: 2500, graceMs: 900, maxBlocks: 2, blockMinCm: 50, blockMaxCm: 100, shrinkCm: 6 },
  medium: { lives: 3, startSpeedCm: 14, speedGainCm: 0.4,  maxSpeedCm: 32, thicknessCm: 18, laneCm: 125, laneShrinkCmS: 0.2,  laneMarginCm: 30, bodyCm: 75, comfortCmS: 22, spacingCm: 120, warnMs: 1800, graceMs: 700, maxBlocks: 3, blockMinCm: 50, blockMaxCm: 110, shrinkCm: 4 },
  hard:   { lives: 3, startSpeedCm: 18, speedGainCm: 0.6,  maxSpeedCm: 42, thicknessCm: 20, laneCm: 110, laneShrinkCmS: 0.2,  laneMarginCm: 25, bodyCm: 75, comfortCmS: 30, spacingCm: 105, warnMs: 1200, graceMs: 500, maxBlocks: 3, blockMinCm: 50, blockMaxCm: 120, shrinkCm: 3 },
};
const DODGE = {
  countdown: 3_000,
  invulnerableMs: 1_500,    // after a hit nothing else can cost a life for this long
  hitFlash: 600,
  secondsPerTick: 10,       // one LED of the score row per this many seconds survived
  firstRowMs: 1_000,        // the first row appears this long after the start
  reactMs: 3_000,           // a row never covers the climber's current column if it reaches the climber sooner than this
  humanReactS: 0.6,         // the lane planner assumes the climber starts moving this long after the warning
  maxBodyCm: 170,           // widest body the lane adapts to
};

/**
 * Chaser. The hunter flies towards the body centre; reaching the core of the body (torso, head) costs a life, then it restarts far
 * away and rests. It pauses for a moment every few seconds, which is the climber's chance to get away, and a green hold freezes it.
 * Its top speed stays below what a climber can keep up for a while (a hand-to-hand move of 60-80 cm takes 1.5-3 s).
 */
const CHASER_LEVELS = {
  easy:   { lives: 5, startSpeedCm: 4,   speedGainCm: 0.06, maxSpeedCm: 9,  catchCm: 9,  graceMs: 300, freezeMs: 5_000, dashMs: 5_000, pauseMs: 1_500 },
  medium: { lives: 3, startSpeedCm: 5,   speedGainCm: 0.09, maxSpeedCm: 12, catchCm: 10, graceMs: 250, freezeMs: 4_000, dashMs: 5_000, pauseMs: 1_200 },
  hard:   { lives: 3, startSpeedCm: 6.5, speedGainCm: 0.12, maxSpeedCm: 16, catchCm: 12, graceMs: 200, freezeMs: 3_000, dashMs: 5_000, pauseMs: 1_000 },
};
const CHASER = {
  countdown: 3_000,
  invulnerableMs: 2_500,    // after a catch the hunter restarts far away and rests this long
  spawnRestMs: 1_500,
  hitFlash: 600,
  secondsPerTick: 10,
  pickupEveryMs: 12_000,    // a freeze hold appears this often (when none is lit)
  pickupTtlMs: 14_000,
  pickupReachMinCm: 40,
  pickupReachMaxCm: 120,
  catchKinds: ['torso', 'head'],  // a trailing foot or hand cannot be caught: the climber can always get the legs out of the way
};

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Updates are called as update(now, {contacts, body, tracked}); a bare contacts object is accepted too. */
const contextOf = (arg) => (arg && 'contacts' in arg ? { contacts: arg.contacts ?? NO_CONTACTS, body: arg.body ?? null, tracked: arg.tracked ?? true } : { contacts: arg ?? NO_CONTACTS, body: null, tracked: true });

/** Base class: game clock, countdown, phases, shared helpers. */
class Game {
  /**
   * @param {{id:number, cx:number, cy:number}[]} holds playable holds with a position (wall px)
   * @param {{RW:number, RH:number, pxPerCm:number, field?:{x0,y0,x1,y1}, rowPitchPx?:number, colPitchPx?:number}} wall
   *   field: the part of the wall the game plays in (not the status strips); pitches: LED spacing in px (0 / missing: unknown)
   * @param {() => number} rand uniform random in [0,1)
   */
  constructor(holds, wall, rand) {
    if (!(wall.pxPerCm > 0)) throw new Error('A game needs the wall scale (pxPerCm)');
    this.holds = holds;
    this.byId = new Map(holds.map((h) => [h.id, h]));
    this.wall = wall;
    this.field = wall.field ?? { x0: 0, y0: 0, x1: wall.RW, y1: wall.RH };
    this.rand = rand;
    this.phase = 'ready';   // 'ready' -> 'running' -> 'over'
    this.t = 0;             // game time (ms)
    this.lastNow = null;
    this.lostSince = null;
    this.paused = false;    // the climber is not tracked: the clock is stopped
    this.runStart = null;   // game time the run began
    this.overAt = null;
    this.score = 0;
    this.record = false;    // set by the caller when the final score beats the best (changes the game-over effect)
    this.prev = { LH: null, RH: null, LF: null, RF: null };
  }
  get over() { return this.phase === 'over'; }
  /** Does the wall show the climber's stick figure? (costs LEDs: only where the body matters) */
  get showsBody() { return false; }
  /** Does the game need the body model (pauses when the torso is lost)? Otherwise "a person is seen" is enough. */
  get needsBody() { return false; }
  cm(px) { return px / this.wall.pxPerCm; }
  px(cm) { return cm * this.wall.pxPerCm; }
  start(now) { this.lastNow = now; this.t = 0; this.phase = 'ready'; }
  /** Advance the game clock by the real time since the last call, unless tracking has been lost for a while. Returns the game dt (ms). */
  advance(now, tracked) {
    const gap = this.lastNow == null ? 0 : Math.max(0, now - this.lastNow), dt = gap > MAX_FRAME_GAP_MS ? 0 : gap;
    this.lastNow = now;
    if (tracked) this.lostSince = null; else this.lostSince ??= now;
    this.paused = this.phase !== 'over' && !tracked && now - this.lostSince > TRACKING_GRACE_MS; // the game-over sweep always finishes
    if (!this.paused) this.t += dt;
    return this.paused ? 0 : dt;
  }
  finish() { this.phase = 'over'; this.overAt = this.t; }
  /** Holds that are touched right now. */
  held(contacts) { return new Set(LIMBS.map((l) => contacts[l]).filter((id) => id != null)); }
  /** Limbs that grabbed a hold since the previous update: [{limb, holdId}]. */
  grabs(contacts) {
    const out = [];
    for (const l of LIMBS) if (contacts[l] != null && contacts[l] !== this.prev[l]) out.push({ limb: l, holdId: contacts[l] });
    return out;
  }
  remember(contacts) { for (const l of LIMBS) this.prev[l] = contacts[l] ?? null; }
  /** A playable hold at a reachable distance from the hands (or from the middle of the wall when nothing is held), not in `taken`. */
  pickHold(contacts, taken, minCm, maxCm, around = null) {
    const hands = HAND_LIMBS.map((l) => this.byId.get(contacts[l])).filter(Boolean);
    const ref = hands.length
      ? { x: hands.reduce((s, h) => s + h.cx, 0) / hands.length, y: hands.reduce((s, h) => s + h.cy, 0) / hands.length }
      : around ?? { x: this.wall.RW / 2, y: this.wall.RH * 0.55 };
    const free = this.holds.filter((h) => !taken.has(h.id));
    const reachable = free.filter((h) => { const d = this.cm(dist(ref, { x: h.cx, y: h.cy })); return d >= minCm && d <= maxCm; });
    const pool = reachable.length ? reachable : free;
    return pool.length ? pool[Math.floor(this.rand() * pool.length)] : null;
  }
  /** Effect for the wall: tracking lost, countdown while getting ready, a green flash at the start, a sweep at the end. */
  effect(countdownMs, goMs = GO_MS) {
    if (this.paused && this.phase !== 'over') return { kind: 'lost' };
    if (this.phase === 'ready') return { kind: 'countdown', n: Math.max(1, Math.ceil((countdownMs - this.t) / 1000)) };
    if (this.phase === 'running' && this.t - this.runStart < goMs) return { kind: 'go' };
    if (this.phase === 'over') return { kind: 'sweep', color: this.record ? COLORS.record : this.sweepColor, t: Math.max(0, (this.t - this.overAt) / 1000) };
    return null;
  }
  countdownLeft(countdownMs) { return this.phase === 'ready' ? Math.max(0, Math.ceil((countdownMs - this.t) / 1000)) : 0; }
}

/** Collect lit coin holds with a hand. */
export class CoinGame extends Game {
  constructor(holds, wall, rand, difficulty = 'medium') {
    super(holds, wall, rand);
    this.difficulty = COINS_LEVELS[difficulty] ? difficulty : 'medium';
    this.cfg = { ...COINS, ...COINS_LEVELS[this.difficulty] };
    this.sweepColor = COLORS.coin;
    this.coins = [];        // {holdId, spawnedAt, value}
    this.flashes = [];      // {holdId, until}
    this.collected = 0;     // coins picked up
    this.spawned = 0;       // coins that appeared (for the golden rhythm)
    this.combo = 1;
    this.lastGrab = -Infinity;
  }

  update(now, arg) {
    const { contacts, tracked } = contextOf(arg);
    this.advance(now, tracked);
    const t = this.t;
    if (this.phase === 'ready' && t >= this.cfg.countdown) { this.phase = 'running'; this.runStart = t; }
    if (this.phase === 'running' && !this.paused) {
      if (t - this.runStart >= this.cfg.duration) this.finish();
      else {
        this.coins = this.coins.filter((c) => t - c.spawnedAt < this.cfg.ttl);
        if (this.combo > 1 && t - this.lastGrab > this.cfg.comboWindow) this.combo = 1;   // the combo runs out when nothing was grabbed for a while
        for (const g of this.grabs(contacts)) {
          if (!HAND_LIMBS.includes(g.limb)) continue;
          const i = this.coins.findIndex((c) => c.holdId === g.holdId);
          if (i < 0) continue;
          const [coin] = this.coins.splice(i, 1);
          this.combo = t - this.lastGrab <= this.cfg.comboWindow ? Math.min(this.cfg.comboMax, this.combo + 1) : 1;
          this.lastGrab = t;
          this.score += coin.value * this.combo;
          this.collected++;
          this.flashes.push({ holdId: coin.holdId, until: t + this.cfg.flash });
        }
        while (this.coins.length < this.cfg.simultaneous) {
          const taken = new Set([...this.coins.map((c) => c.holdId), ...this.held(contacts)]);
          const h = this.pickHold(contacts, taken, this.cfg.reachMinCm, this.cfg.reachMaxCm);
          if (!h) break;
          this.spawned++;
          this.coins.push({ holdId: h.id, spawnedAt: t, value: this.spawned % this.cfg.goldenEvery === 0 ? this.cfg.goldenValue : 1 });
        }
      }
    }
    this.flashes = this.flashes.filter((f) => f.until > t);
    this.remember(contacts);
  }

  /** Short feedback that must stay visible even under a hand: a collected coin flashes green. */
  get flashLit() {
    const m = new Map();
    if (this.phase === 'running') for (const f of this.flashes) m.set(f.holdId, COLORS.collected);
    return m;
  }

  get lit() {
    const m = new Map();
    if (this.phase !== 'running') return m;
    for (const c of this.coins) {
      const soon = this.t - c.spawnedAt > this.cfg.ttl - this.cfg.soonMs;
      m.set(c.holdId, c.value > 1 ? COLORS.golden : soon ? COLORS.coinSoon : COLORS.coin);
    }
    for (const f of this.flashes) m.set(f.holdId, COLORS.collected);
    return m;
  }

  _left() { return this.phase === 'ready' ? this.cfg.duration : this.phase === 'over' ? 0 : Math.max(0, this.cfg.duration - (this.t - this.runStart)); }

  output() {
    const frac = this._left() / this.cfg.duration;
    return {
      lit: this.lit,
      flash: this.flashLit,
      zones: [], marks: [], bodyTint: null,
      hud: {
        top: { kind: 'bar', value: frac, color: frac > 0.5 ? COLORS.time : frac > 0.2 ? COLORS.timeLow : COLORS.danger },
        left: { kind: 'count', n: this.combo, color: COLORS.coin },
        bottom: { kind: 'ticks', count: this.score },
      },
      fx: this.effect(this.cfg.countdown),
    };
  }

  state() {
    return { phase: this.phase, paused: this.paused, score: this.score, combo: this.combo, collected: this.collected, secondsLeft: Math.ceil(this._left() / 1000), countdown: this.countdownLeft(this.cfg.countdown) };
  }
}

/** Blocks fall in rows with a free lane for the whole body; any body part in a red block (after a short grace) costs a life. */
export class DodgeGame extends Game {
  constructor(holds, wall, rand, difficulty = 'medium') {
    super(holds, wall, rand);
    this.difficulty = DODGE_LEVELS[difficulty] ? difficulty : 'medium';
    this.cfg = { ...DODGE, ...DODGE_LEVELS[this.difficulty] };
    this.sweepColor = COLORS.danger;
    this.lives = this.cfg.lives;
    this.rows = [];          // {y (px, centre), blocks:[{x0,x1}], lane:{x0,x1}, warnUntil, live}: a row first warns (dim, still), then falls (red)
    this.nextRowAt = 0;
    this.lane = null;        // centre of the last lane (px)
    this.inBlockSince = null;
    this.invulnerableUntil = -Infinity;
    this.hitUntil = -Infinity;
    this.flashes = [];       // hold flashes of the contact fallback
    this.survived = 0;       // seconds
    this.bodyCm = this.cfg.bodyCm;
  }

  get showsBody() { return true; }
  get needsBody() { return true; }
  speedCm() { return Math.min(this.cfg.maxSpeedCm, this.cfg.startSpeedCm + this.cfg.speedGainCm * this.survived); }
  /** Bar thickness in px: at least about 1.15 LED rows, so that every row of LEDs is passed (never skipped between two rows). */
  get thicknessPx() { return Math.max(this.px(this.cfg.thicknessCm), 1.15 * (this.wall.rowPitchPx || 0)); }
  get halfRow() { return this.thicknessPx / 2; }

  /** Lane width: the configured one narrowing over time, never less than the (measured) body plus a margin. */
  _laneCm() { return Math.max(this.cfg.laneCm - this.cfg.laneShrinkCmS * this.survived, this.bodyCm + this.cfg.laneMarginCm); }

  /**
   * The next row: where its lane is and which blocks it has. The lane moves by at most (laneW - bodyW) from the previous one (so two
   * rows on the body at the same time share a corridor the body fits through), stays inside the field, and - as far as that rule
   * allows - never ends up further from the climber than they can get before the row arrives (comfortCmS, after a reaction time).
   * When the climber was knocked far away from the lane the lane moves towards them by the maximum. Blocks fill part of the space
   * left and right of the lane, never in it.
   */
  _planRow(body) {
    const f = this.field, laneW = Math.min(this.px(this._laneCm()), f.x1 - f.x0), half = laneW / 2, speed = this.px(this.speedCm());
    const minC = f.x0 + half, maxC = f.x1 - half, bodyPx = this.px(this.bodyCm);
    const anchor = body?.centre?.x ?? this.lane ?? (f.x0 + f.x1) / 2;
    const prev = this.lane ?? clamp(anchor, minC, maxC);
    const maxShift = Math.max(0, laneW - bodyPx);
    const shift = (this.rand() * 2 - 1) * maxShift * (0.5 + 0.5 * this.rand());   // random walk: a climber who stands still is eventually left behind
    // time the climber has before the row's lower edge reaches the top of their body, minus a reaction time
    const topOfBody = body?.bounds?.y0 ?? this.wall.RH / 2;
    const arrivalS = Math.max(0, this.cfg.warnMs / 1000 + Math.max(0, topOfBody - f.y0 - this.thicknessPx) / Math.max(1, speed) - this.cfg.humanReactS);
    const reach = this.px(this.cfg.comfortCmS) * arrivalS + Math.max(0, half - bodyPx / 2);
    const lo = Math.max(prev - maxShift, anchor - reach, minC), hi = Math.min(prev + maxShift, anchor + reach, maxC);
    const c = lo <= hi ? clamp(prev + shift, lo, hi) : clamp(clamp(anchor, prev - maxShift, prev + maxShift), minC, maxC);
    const lane = { x0: c - half, x1: c + half };
    return { lane, blocks: this._blocksAround(lane, body, arrivalS * 1000 < this.cfg.reactMs) };
  }

  /** Random blocks left and right of the lane (1..maxBlocks); a row without any block is possible and fine. */
  _blocksAround(lane, body, tooSoon) {
    const f = this.field, blocks = [];
    const bw = () => this.px(this.cfg.blockMinCm + this.rand() * (this.cfg.blockMaxCm - this.cfg.blockMinCm));
    const sides = [{ x0: f.x0, x1: lane.x0 }, { x1: f.x1, x0: lane.x1 }];
    const n = 1 + Math.floor(this.rand() * this.cfg.maxBlocks);
    for (let i = 0; i < n; i++) {
      const side = sides[Math.floor(this.rand() * 2)], room = side.x1 - side.x0, w = Math.min(bw(), room);
      if (room < this.px(this.cfg.blockMinCm) * 0.8) continue;
      const x0 = side.x0 + this.rand() * (room - w);
      const b = { x0, x1: x0 + w };
      if (blocks.some((o) => b.x0 < o.x1 + this.px(15) && b.x1 > o.x0 - this.px(15))) continue; // blocks keep some air between them
      if (tooSoon && body?.bounds && b.x1 > body.bounds.x0 - this.px(20) && b.x0 < body.bounds.x1 + this.px(20)) continue; // a row that arrives very soon stays off the climber
      blocks.push(b);
    }
    if (!blocks.length) {            // a row should not be empty: one block at the outer end of the roomier side (away from the lane)
      const side = sides.slice().sort((a, b) => (b.x1 - b.x0) - (a.x1 - a.x0))[0], w = Math.min(this.px(this.cfg.blockMinCm), side.x1 - side.x0);
      if (w > 0) {
        const left = side.x0 === f.x0, b = left ? { x0: side.x0, x1: side.x0 + w } : { x0: side.x1 - w, x1: side.x1 };
        if (!(tooSoon && body?.bounds && b.x1 > body.bounds.x0 - this.px(20) && b.x0 < body.bounds.x1 + this.px(20))) blocks.push(b);
      }
    }
    return blocks;
  }

  /** The red areas that count right now (falling rows only), as rectangles. */
  _dangerRects() {
    const half = this.halfRow, out = [];
    for (const r of this.rows) if (r.live) for (const b of r.blocks) out.push({ x0: b.x0, x1: b.x1, y0: r.y - half, y1: r.y + half });
    return out;
  }

  /** Is the hold under a falling block? (used by the contact fallback and the screen mirror) */
  isDanger(h) { return this._dangerRects().some((z) => h.cx >= z.x0 && h.cx <= z.x1 && h.cy >= z.y0 && h.cy <= z.y1); }

  /** Is any part of the climber in a falling block? Uses the body when known, else the holds the hands and feet are on. */
  _touching(ctx) {
    const rects = this._dangerRects();
    if (!rects.length) return false;
    if (ctx.body?.tracked) return rects.some((z) => ctx.body.hitsRect(z, this.cfg.shrinkCm).hit);
    for (const id of this.held(ctx.contacts)) { const h = this.byId.get(id); if (h && this.isDanger(h)) return true; }
    return false;
  }

  update(now, arg) {
    const ctx = contextOf(arg), dt = this.advance(now, ctx.tracked) / 1000, t = this.t;
    if (ctx.body?.bounds) this.bodyCm = clamp(this.cm(ctx.body.bounds.x1 - ctx.body.bounds.x0), this.cfg.bodyCm, this.cfg.maxBodyCm);
    if (this.phase === 'ready' && t >= this.cfg.countdown) { this.phase = 'running'; this.runStart = t; this.nextRowAt = t + this.cfg.firstRowMs; }
    if (this.phase === 'running' && !this.paused) {
      this.survived = (t - this.runStart) / 1000;
      const v = this.px(this.speedCm());
      for (const r of this.rows) {
        if (!r.live && t >= r.warnUntil) r.live = true;
        if (r.live) r.y += v * dt;
      }
      // a row leaves once its upper edge is below the last LED row: below that it would be deadly but invisible
      this.rows = this.rows.filter((r) => r.y - this.halfRow < this.field.y1 - (this.wall.rowPitchPx || 0) / 2);
      if (t >= this.nextRowAt) {
        const row = this._planRow(ctx.body?.tracked ? ctx.body : null);
        this.lane = (row.lane.x0 + row.lane.x1) / 2;
        this.rows.push({ y: this.field.y0 + this.halfRow, blocks: row.blocks, lane: row.lane, warnUntil: t + this.cfg.warnMs, live: false });
        // rows are spaced so that at most two overlap a standing climber (spacingCm) and never closer than the warning allows
        this.nextRowAt = t + Math.max(this.cfg.warnMs, (this.cfg.spacingCm / this.speedCm()) * 1000);
      }
      // any body part in a falling block gets a moment to get out (graceMs); one hit at a time, then a short shield
      if (this._touching(ctx)) {
        this.inBlockSince ??= t;
        // the grace time counts from the end of the shield: one block that stays on the climber costs a life per grace period, not per shield
        if (t - Math.max(this.inBlockSince, this.invulnerableUntil) >= this.cfg.graceMs) {
          this.lives--;
          this.invulnerableUntil = t + this.cfg.invulnerableMs;
          this.hitUntil = t + this.cfg.hitFlash;
          this.inBlockSince = null;
          if (this.lives <= 0) this.finish();
        }
      } else this.inBlockSince = null;
      this.score = Math.floor(this.survived);
    }
    this.flashes = this.flashes.filter((f) => f.until > t);
    this.remember(ctx.contacts);
  }

  /** Holds under a falling block (screen mirror, and the lit holds when there is no LED field). */
  get lit() {
    const m = new Map();
    if (this.phase !== 'running') return m;
    for (const h of this.holds) if (this.isDanger(h)) m.set(h.id, COLORS.danger);
    return m;
  }
  get flashLit() { return new Map(); }

  /** Blocks as areas: falling ones red (first, they win), announced ones dim. */
  get zones() {
    if (this.phase !== 'running') return [];
    const half = this.halfRow, out = [];
    for (const live of [true, false]) for (const r of this.rows) if (r.live === live) for (const b of r.blocks) out.push({ x0: b.x0, x1: b.x1, y0: r.y - half, y1: r.y + half, color: live ? COLORS.danger : COLORS.warn, soft: !live });
    return out;
  }

  output() {
    return {
      lit: this.lit,
      wallLit: new Map(),      // the obstacles are areas on the wall (zones): no extra hold colours that would hide the overlap colour
      flash: this.flashLit,
      zones: this.zones, marks: [],
      bodyTint: this.t < this.hitUntil ? COLORS.hit : null,
      hud: {
        top: { kind: 'segments', count: this.cfg.lives, lit: this.lives, color: COLORS.danger },
        bottom: { kind: 'ticks', count: Math.floor(this.survived / this.cfg.secondsPerTick) },
      },
      fx: this.effect(this.cfg.countdown),
    };
  }

  state() {
    return { phase: this.phase, paused: this.paused, score: this.score, lives: this.lives, maxLives: this.cfg.lives, countdown: this.countdownLeft(this.cfg.countdown), speedCm: Math.round(this.speedCm()) };
  }
}

/** A light hunts the climber; any body part it reaches (for a moment) costs a life; a green hold freezes it. */
export class ChaserGame extends Game {
  constructor(holds, wall, rand, difficulty = 'medium') {
    super(holds, wall, rand);
    this.difficulty = CHASER_LEVELS[difficulty] ? difficulty : 'medium';
    this.cfg = { ...CHASER, ...CHASER_LEVELS[this.difficulty] };
    this.sweepColor = COLORS.hunter;
    this.lives = this.cfg.lives;
    this.hunter = null;         // {x, y} in wall px, once running
    this.restUntil = -Infinity; // it rests (spawn, after a catch, a short breather, a freeze) until this game time
    this.nextBreakAt = Infinity;
    this.frozenByPickup = false;
    this.invulnerableUntil = -Infinity;
    this.hitUntil = -Infinity;
    this.inRangeSince = null;
    this.pickup = null;         // {holdId, spawnedAt}
    this.nextPickupAt = 0;
    this.flashes = [];
    this.freezes = 0;
    this.survived = 0;
  }

  get showsBody() { return true; }
  get needsBody() { return true; }
  speedCm() { return Math.min(this.cfg.maxSpeedCm, this.cfg.startSpeedCm + this.cfg.speedGainCm * this.survived); }
  get _pitch() { return Math.max(this.wall.rowPitchPx || 0, this.wall.colPitchPx || 0); }
  /** Radius of the hunter's light: with 0.9 x the LED spacing at least one LED of a lattice is always within it (the worst case is 0.71). */
  get markRadiusPx() { return Math.max(this.px(8), 0.9 * this._pitch); }

  /** Start position: the corner of the field (or its top middle) furthest from the climber, half an LED spacing inside so it always lights an LED. */
  _spawnPoint(ref) {
    const f = this.field, inset = this._pitch / 2;
    const x0 = f.x0 + inset, x1 = f.x1 - inset, y0 = f.y0 + inset, y1 = f.y1 - inset;
    const spots = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x0, y: y1 }, { x: x1, y: y1 }, { x: (x0 + x1) / 2, y: y0 }];
    const from = ref ?? { x: (f.x0 + f.x1) / 2, y: (f.y0 + f.y1) / 2 };
    return spots.reduce((best, s) => (dist(s, from) > dist(best, from) ? s : best));
  }

  /** Distance (px) from the hunter to the core of the climber's body; falls back to the hands' and feet's holds without a body. */
  _distanceToClimber(ctx) {
    if (ctx.body?.tracked) return ctx.body.distanceTo(this.hunter, this.cfg.catchKinds);
    let d = Infinity;
    for (const id of this.held(ctx.contacts)) { const h = this.byId.get(id); if (h) d = Math.min(d, dist(this.hunter, { x: h.cx, y: h.cy })); }
    return d;
  }
  _climberCentre(ctx) {
    if (ctx.body?.tracked && ctx.body.centre) return ctx.body.centre;
    const hs = [...this.held(ctx.contacts)].map((id) => this.byId.get(id)).filter(Boolean);
    return hs.length ? { x: hs.reduce((s, h) => s + h.cx, 0) / hs.length, y: hs.reduce((s, h) => s + h.cy, 0) / hs.length } : null;
  }

  update(now, arg) {
    const ctx = contextOf(arg), dt = this.advance(now, ctx.tracked) / 1000, t = this.t;
    if (this.phase === 'ready' && t >= this.cfg.countdown) { this.phase = 'running'; this.runStart = t; this.nextPickupAt = t + 4_000; }
    if (this.phase === 'running' && !this.paused) {
      this.survived = (t - this.runStart) / 1000;
      const centre = this._climberCentre(ctx);
      if (!this.hunter && centre) { this.hunter = this._spawnPoint(centre); this.restUntil = t + this.cfg.spawnRestMs; this.nextBreakAt = this.restUntil + this.cfg.dashMs; }
      if (this.hunter) {
        if (t >= this.restUntil) this.frozenByPickup = false;
        if (t >= this.nextBreakAt && t >= this.restUntil) { this.restUntil = t + this.cfg.pauseMs; this.nextBreakAt = this.restUntil + this.cfg.dashMs; } // a breather: the climber's chance to get away
        if (centre && t >= this.restUntil) {          // hunt: straight at the climber, never outside the field
          const step = this.px(this.speedCm()) * dt, d = dist(this.hunter, centre);
          if (d > 1e-6) { const k = Math.min(1, step / d); this.hunter = { x: this.hunter.x + (centre.x - this.hunter.x) * k, y: this.hunter.y + (centre.y - this.hunter.y) * k }; }
          this.hunter = { x: clamp(this.hunter.x, this.field.x0, this.field.x1), y: clamp(this.hunter.y, this.field.y0, this.field.y1) };
        }
        const near = this._distanceToClimber(ctx) <= this.px(this.cfg.catchCm);
        if (t < this.invulnerableUntil || t < this.restUntil) this.inRangeSince = null;     // the grace time starts when it can catch again
        else if (near) {
          this.inRangeSince ??= t;
          if (t - this.inRangeSince >= this.cfg.graceMs) this._caught(centre);
        } else this.inRangeSince = null;
      }
      this._pickups(t, ctx, centre);
      this.score = Math.floor(this.survived);
    }
    this.flashes = this.flashes.filter((f) => f.until > t);
    this.remember(ctx.contacts);
  }

  _caught(centre) {
    const t = this.t;
    this.lives--;
    this.hitUntil = t + this.cfg.hitFlash;
    this.invulnerableUntil = t + this.cfg.invulnerableMs;
    this.restUntil = t + this.cfg.invulnerableMs;
    this.nextBreakAt = this.restUntil + this.cfg.dashMs;
    this.inRangeSince = null;
    this.hunter = this._spawnPoint(centre);
    if (this.lives <= 0) this.finish();
  }

  /** A freeze hold appears now and then (near the climber); any limb on it freezes the hunter. */
  _pickups(t, ctx, centre) {
    if (this.pickup && t - this.pickup.spawnedAt > this.cfg.pickupTtlMs) { this.pickup = null; this.nextPickupAt = t + 3_000; }
    if (!this.pickup && t >= this.nextPickupAt) {
      const h = this.pickHold(ctx.contacts, this.held(ctx.contacts), this.cfg.pickupReachMinCm, this.cfg.pickupReachMaxCm, centre);
      if (h) this.pickup = { holdId: h.id, spawnedAt: t };
    }
    if (this.pickup) {
      for (const g of this.grabs(ctx.contacts)) {
        if (g.holdId !== this.pickup.holdId) continue;
        this.flashes.push({ holdId: g.holdId, until: t + 450 });
        this.pickup = null; this.nextPickupAt = t + this.cfg.pickupEveryMs; this.freezes++;
        this.restUntil = Math.max(this.restUntil, t + this.cfg.freezeMs); this.frozenByPickup = true;
        this.nextBreakAt = Math.max(this.nextBreakAt, this.restUntil + this.cfg.dashMs);
        break;
      }
    }
  }

  get flashLit() {
    const m = new Map();
    if (this.phase === 'running') for (const f of this.flashes) m.set(f.holdId, COLORS.collected);
    return m;
  }
  get lit() {
    const m = new Map();
    if (this.phase !== 'running') return m;
    if (this.pickup) m.set(this.pickup.holdId, COLORS.freeze);
    for (const f of this.flashes) m.set(f.holdId, COLORS.collected);
    return m;
  }
  get resting() { return this.phase === 'running' && this.t < this.restUntil; }

  output() {
    const marks = [];
    if (this.phase === 'running' && this.hunter) marks.push({ x: this.hunter.x, y: this.hunter.y, r: this.markRadiusPx, color: this.resting ? COLORS.hunterFrozen : COLORS.hunter });
    return {
      lit: this.lit,
      flash: this.flashLit,
      zones: [], marks,
      bodyTint: this.t < this.hitUntil ? COLORS.hit : null,
      hud: {
        top: { kind: 'segments', count: this.cfg.lives, lit: this.lives, color: COLORS.danger },
        bottom: { kind: 'ticks', count: Math.floor(this.survived / this.cfg.secondsPerTick) },
      },
      fx: this.effect(this.cfg.countdown),
    };
  }

  state() {
    return { phase: this.phase, paused: this.paused, score: this.score, lives: this.lives, maxLives: this.cfg.lives, countdown: this.countdownLeft(this.cfg.countdown), speedCm: Math.round(this.speedCm()), frozen: this.frozenByPickup && this.resting };
  }
}

/** @param {'coins'|'dodge'|'chaser'} id @param {'easy'|'medium'|'hard'} [difficulty] */
export function createGame(id, holds, wall, rand, difficulty = 'medium') {
  if (id === 'coins') return new CoinGame(holds, wall, rand, difficulty);
  if (id === 'dodge') return new DodgeGame(holds, wall, rand, difficulty);
  if (id === 'chaser') return new ChaserGame(holds, wall, rand, difficulty);
  throw new Error(`Unknown game "${id}"`);
}
