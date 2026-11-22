// Small climbing games driven by the live hold contacts. Pure logic: no DOM, no Bluetooth, deterministic with a seeded
// random generator, so every rule can be unit tested.
//
// A game sees the playable holds (wall pixels), the current contacts per limb ({LH,RH,LF,RF} -> hold id | null) and the
// time. update(now, contacts) advances it; output(now) says what to show:
//   lit    Map holdId -> {r,g,b}      target holds / flashes (also drawn on screen)
//   flash  Map holdId -> {r,g,b}      the short feedback inside lit (a hit, a collected coin): it stays visible under a hand
//   zones  [{x0,y0,x1,y1,color}]      areas in wall px; every LED inside lights, bound to a hold or not (obstacles)
//   hud    {top, left, bottom}        status strips for the wall (see wallhud.js)
//   fx     {kind: 'countdown'|'go'|'sweep', ...} | null
// state(now) is the small summary for the screen HUD. Which holds are "playable" (they have an LED, they are not part
// of the status strips) is decided by the caller: a hold without light would be an invisible target or trap.

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
};

/**
 * The games on offer. A game is a class below with start / update / output / state; this list is what the Games area
 * shows. unit: how the score is written (and what "best" means); options: which settings the game uses (see OPTIONS).
 */
export const GAMES = [
  { id: 'coins', title: 'Coins', unit: 'points', options: ['difficulty'], blurb: 'Grab the lit coin holds with your hands. Quick grabs build a combo (up to x3). 60 seconds.' },
  { id: 'dodge', title: 'Dodge', unit: 'seconds', options: ['difficulty'], blurb: 'Red bars fall from the top, announced by a dim warning. Do not stay on a red hold. Lives are shown at the top edge; it gets faster.' },
];
/** Settings a game can ask for (GAMES[].options); the Games area draws them. */
export const OPTIONS = {
  difficulty: { id: 'difficulty', label: 'Difficulty', choices: [{ id: 'easy', title: 'Easy' }, { id: 'medium', title: 'Medium' }, { id: 'hard', title: 'Hard' }] },
};
/** Records are kept per game and difficulty. */
export const recordKey = (id, difficulty = 'medium') => `${id}:${difficulty}`;
/** "12 points" / "47 s" */
export const formatScore = (id, value) => { const g = GAMES.find((x) => x.id === id); return g?.unit === 'seconds' ? `${value} s` : `${value}`; };

export const DIFFICULTIES = [
  { id: 'easy', title: 'Easy' },
  { id: 'medium', title: 'Medium' },
  { id: 'hard', title: 'Hard' },
];

const HAND_LIMBS = ['LH', 'RH'];
const LIMBS = ['LH', 'RH', 'LF', 'RF'];

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

const DODGE_LEVELS = {
  easy:   { lives: 5, startSpeedCm: 6,  speedGainCm: 0.25, maxSpeedCm: 18, thicknessCm: 20, blockWidthCm: 55, maxBlockedShare: 0.4,  gapSeconds: 5.5, minGapSeconds: 3.0, minClearCm: 40, warnMs: 2200, graceMs: 900 },
  medium: { lives: 3, startSpeedCm: 9,  speedGainCm: 0.35, maxSpeedCm: 28, thicknessCm: 24, blockWidthCm: 70, maxBlockedShare: 0.55, gapSeconds: 4.2, minGapSeconds: 2.2, minClearCm: 30, warnMs: 1500, graceMs: 700 },
  hard:   { lives: 3, startSpeedCm: 12, speedGainCm: 0.5,  maxSpeedCm: 38, thicknessCm: 28, blockWidthCm: 85, maxBlockedShare: 0.62, gapSeconds: 3.4, minGapSeconds: 1.8, minClearCm: 20, warnMs: 1000, graceMs: 500 },
};
const DODGE = {
  countdown: 3_000,
  invulnerableMs: 1_500,    // after a hit nothing else can cost a life for this long
  hitFlash: 600,
  secondsPerTick: 5,        // one LED of the score row per this many seconds survived
};

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Base class: countdown, phases, shared helpers. */
class Game {
  /**
   * @param {{id:number, cx:number, cy:number}[]} holds playable holds with a position (wall px)
   * @param {{RW:number, RH:number, pxPerCm:number}} wall
   * @param {() => number} rand uniform random in [0,1)
   */
  constructor(holds, wall, rand) {
    this.holds = holds;
    this.byId = new Map(holds.map((h) => [h.id, h]));
    this.wall = wall;
    this.rand = rand;
    this.phase = 'ready';   // 'ready' -> 'running' -> 'over'
    this.startedAt = null;
    this.runStart = null;
    this.overAt = null;
    this.clock = 0;         // time of the last update
    this.score = 0;
    this.record = false;    // set by the caller when the final score beats the best (changes the game-over effect)
    this.prev = { LH: null, RH: null, LF: null, RF: null };
  }
  get over() { return this.phase === 'over'; }
  cm(px) { return px / this.wall.pxPerCm; }
  px(cm) { return cm * this.wall.pxPerCm; }
  finish(now) { this.phase = 'over'; this.overAt = now; }
  /** Holds that are touched right now. */
  held(contacts) { return new Set(LIMBS.map((l) => contacts[l]).filter((id) => id != null)); }
  /** Limbs that grabbed a hold since the previous update: [{limb, holdId}]. */
  grabs(contacts) {
    const out = [];
    for (const l of LIMBS) if (contacts[l] != null && contacts[l] !== this.prev[l]) out.push({ limb: l, holdId: contacts[l] });
    return out;
  }
  remember(contacts) { for (const l of LIMBS) this.prev[l] = contacts[l] ?? null; }
  /** Effect for the wall: countdown while getting ready, a green flash at the start, a sweep at the end. */
  effect(now, countdownMs, goMs = GO_MS) {
    if (this.phase === 'ready') return { kind: 'countdown', n: Math.max(1, Math.ceil((countdownMs - (now - this.startedAt)) / 1000)) };
    if (this.phase === 'running' && now - this.runStart < goMs) return { kind: 'go' };
    if (this.phase === 'over') return { kind: 'sweep', color: this.record ? COLORS.record : this.sweepColor, t: Math.max(0, (now - this.overAt) / 1000) };
    return null;
  }
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

  start(now) { this.startedAt = now; this.clock = now; this.phase = 'ready'; }

  /** Pick a hold at a reachable distance from the hands (or from the middle of the wall when nothing is held yet). */
  _pickHold(now, contacts) {
    const hands = HAND_LIMBS.map((l) => this.byId.get(contacts[l])).filter(Boolean);
    const ref = hands.length
      ? { x: hands.reduce((s, h) => s + h.cx, 0) / hands.length, y: hands.reduce((s, h) => s + h.cy, 0) / hands.length }
      : { x: this.wall.RW / 2, y: this.wall.RH * 0.55 };
    const taken = new Set([...this.coins.map((c) => c.holdId), ...this.held(contacts)]);
    const free = this.holds.filter((h) => !taken.has(h.id));
    const reachable = free.filter((h) => { const d = this.cm(dist(ref, { x: h.cx, y: h.cy })); return d >= this.cfg.reachMinCm && d <= this.cfg.reachMaxCm; });
    const pool = reachable.length ? reachable : free;
    return pool.length ? pool[Math.floor(this.rand() * pool.length)] : null;
  }

  update(now, contacts) {
    this.clock = now;
    const t = now - this.startedAt;
    if (this.phase === 'ready' && t >= this.cfg.countdown) { this.phase = 'running'; this.runStart = now; }
    if (this.phase === 'running') {
      if (now - this.runStart >= this.cfg.duration) this.finish(now);
      else {
        this.coins = this.coins.filter((c) => now - c.spawnedAt < this.cfg.ttl);
        if (this.coins.length === 0 && this.combo > 1 && now - this.lastGrab > this.cfg.comboWindow) this.combo = 1;
        for (const g of this.grabs(contacts)) {
          if (!HAND_LIMBS.includes(g.limb)) continue;
          const i = this.coins.findIndex((c) => c.holdId === g.holdId);
          if (i < 0) continue;
          const [coin] = this.coins.splice(i, 1);
          this.combo = now - this.lastGrab <= this.cfg.comboWindow ? Math.min(this.cfg.comboMax, this.combo + 1) : 1;
          this.lastGrab = now;
          this.score += coin.value * this.combo;
          this.collected++;
          this.flashes.push({ holdId: coin.holdId, until: now + this.cfg.flash });
        }
        while (this.coins.length < this.cfg.simultaneous) {
          const h = this._pickHold(now, contacts);
          if (!h) break;
          this.spawned++;
          this.coins.push({ holdId: h.id, spawnedAt: now, value: this.spawned % this.cfg.goldenEvery === 0 ? this.cfg.goldenValue : 1 });
        }
      }
    }
    this.flashes = this.flashes.filter((f) => f.until > now);
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
      const soon = this.clock - c.spawnedAt > this.cfg.ttl - this.cfg.soonMs;
      m.set(c.holdId, c.value > 1 ? COLORS.golden : soon ? COLORS.coinSoon : COLORS.coin);
    }
    for (const f of this.flashes) m.set(f.holdId, COLORS.collected);
    return m;
  }

  _left(now) { return this.phase === 'ready' ? this.cfg.duration : this.phase === 'over' ? 0 : Math.max(0, this.cfg.duration - (now - this.runStart)); }

  output(now) {
    const frac = this._left(now) / this.cfg.duration;
    return {
      lit: this.lit,
      flash: this.flashLit,
      zones: [],
      hud: {
        top: { kind: 'bar', value: frac, color: frac > 0.5 ? COLORS.time : frac > 0.2 ? COLORS.timeLow : COLORS.danger },
        left: { kind: 'count', n: this.combo, color: COLORS.coin },
        bottom: { kind: 'ticks', count: this.score },
      },
      fx: this.effect(now, this.cfg.countdown),
    };
  }

  state(now) {
    return { phase: this.phase, score: this.score, combo: this.combo, collected: this.collected, secondsLeft: Math.ceil(this._left(now) / 1000), countdown: this.phase === 'ready' ? Math.max(0, Math.ceil((this.cfg.countdown - (now - this.startedAt)) / 1000)) : 0 };
  }
}

/** Red bars fall down the wall; do not stay on a red hold. */
export class DodgeGame extends Game {
  constructor(holds, wall, rand, difficulty = 'medium') {
    super(holds, wall, rand);
    this.difficulty = DODGE_LEVELS[difficulty] ? difficulty : 'medium';
    this.cfg = { ...DODGE, ...DODGE_LEVELS[this.difficulty] };
    this.sweepColor = COLORS.danger;
    this.lives = this.cfg.lives;
    this.bars = [];          // {y (px, centre), blocks:[{x0,x1}], warnUntil, live}: a bar first warns (dim, still), then falls (red)
    this.nextBarAt = 0;
    this.lastTick = null;
    this.invulnerableUntil = -Infinity;
    this.dangerSince = new Map(); // hold id -> time it turned red
    this.flashes = [];
    this.survived = 0;       // seconds
  }

  start(now) { this.startedAt = now; this.clock = now; this.phase = 'ready'; this.lastTick = now; }

  speedCm() { return Math.min(this.cfg.maxSpeedCm, this.cfg.startSpeedCm + this.cfg.speedGainCm * this.survived); }

  /** Random red blocks for one bar; together they never cover more than maxBlockedShare of the width. */
  _makeBlocks() {
    const W = this.wall.RW, bw = this.px(this.cfg.blockWidthCm);
    const count = Math.max(1, Math.min(Math.floor((W * this.cfg.maxBlockedShare) / bw), 2 + Math.floor(this.survived / 25)));
    const blocks = [];
    for (let i = 0, guard = 0; i < count && guard < 40; guard++) {
      const x0 = this.rand() * (W - bw);
      if (blocks.every((b) => x0 + bw < b.x0 || x0 > b.x1)) { blocks.push({ x0, x1: x0 + bw }); i++; }
    }
    return blocks;
  }

  get halfBar() { return this.px(this.cfg.thicknessCm) / 2; }

  /** Is the hold under a bar that is falling (not just warning)? */
  isDanger(h) {
    const half = this.halfBar;
    return this.bars.some((b) => b.live && Math.abs(h.cy - b.y) <= half && b.blocks.some((k) => h.cx >= k.x0 && h.cx <= k.x1));
  }

  update(now, contacts) {
    const dt = Math.max(0, (now - this.lastTick) / 1000);
    this.lastTick = now; this.clock = now;
    if (this.phase === 'ready' && now - this.startedAt >= this.cfg.countdown) { this.phase = 'running'; this.runStart = now; this.nextBarAt = now; }
    if (this.phase === 'running') {
      this.survived = (now - this.runStart) / 1000;
      const v = this.px(this.speedCm());
      for (const b of this.bars) {
        if (!b.live && now >= b.warnUntil) b.live = true;
        if (b.live) b.y += v * dt;
      }
      this.bars = this.bars.filter((b) => b.y < this.wall.RH + this.px(this.cfg.thicknessCm));
      if (now >= this.nextBarAt) {
        this.bars.push({ y: this.halfBar, blocks: this._makeBlocks(), warnUntil: now + this.cfg.warnMs, live: false });
        // later bars wait long enough that two never touch: the clear space between them stays at least minClearCm
        const gap = Math.max(this.cfg.minGapSeconds, this.cfg.gapSeconds * (this.cfg.startSpeedCm / this.speedCm()) ** 0.6, (this.cfg.thicknessCm + this.cfg.minClearCm) / this.speedCm());
        this.nextBarAt = now + gap * 1000;
      }
      // a hold that turns red under a hand gets a moment to let go (graceMs); one hit at a time, then a short shield
      const since = new Map();
      for (const h of this.holds) if (this.isDanger(h)) since.set(h.id, this.dangerSince.get(h.id) ?? now);
      this.dangerSince = since;
      if (now >= this.invulnerableUntil) {
        for (const l of LIMBS) {
          const id = contacts[l];
          if (id == null || !since.has(id) || now - since.get(id) < this.cfg.graceMs) continue;
          this.lives--;
          this.invulnerableUntil = now + this.cfg.invulnerableMs;
          this.flashes.push({ holdId: id, until: now + this.cfg.hitFlash });
          if (this.lives <= 0) this.finish(now);
          break;
        }
      }
      this.score = Math.floor(this.survived);
    }
    this.flashes = this.flashes.filter((f) => f.until > now);
    this.remember(contacts);
  }

  get flashLit() {
    const m = new Map();
    if (this.phase === 'running') for (const f of this.flashes) m.set(f.holdId, COLORS.hit);
    return m;
  }

  get lit() {
    const m = new Map();
    if (this.phase !== 'running') return m;
    for (const h of this.holds) if (this.isDanger(h)) m.set(h.id, COLORS.danger);
    for (const f of this.flashes) m.set(f.holdId, COLORS.hit);
    return m;
  }

  /** Bars as areas: falling ones red (first, they win), announced ones dim. */
  get zones() {
    if (this.phase !== 'running') return [];
    const half = this.halfBar, out = [];
    for (const live of [true, false]) for (const b of this.bars) if (b.live === live) for (const k of b.blocks) out.push({ x0: k.x0, x1: k.x1, y0: b.y - half, y1: b.y + half, color: live ? COLORS.danger : COLORS.warn });
    return out;
  }

  output(now) {
    return {
      lit: this.lit,
      flash: this.flashLit,
      zones: this.zones,
      hud: {
        top: { kind: 'segments', count: this.cfg.lives, lit: this.lives, color: COLORS.danger },
        left: { kind: 'bar', value: this.speedCm() / this.cfg.maxSpeedCm, color: COLORS.speed },
        bottom: { kind: 'ticks', count: Math.floor(this.survived / this.cfg.secondsPerTick) },
      },
      fx: this.effect(now, this.cfg.countdown),
    };
  }

  state(now) {
    return { phase: this.phase, score: this.score, lives: this.lives, maxLives: this.cfg.lives, countdown: this.phase === 'ready' ? Math.max(0, Math.ceil((this.cfg.countdown - (now - this.startedAt)) / 1000)) : 0, speedCm: Math.round(this.speedCm()) };
  }
}

/** @param {'coins'|'dodge'} id @param {'easy'|'medium'|'hard'} [difficulty] */
export function createGame(id, holds, wall, rand, difficulty = 'medium') {
  if (id === 'coins') return new CoinGame(holds, wall, rand, difficulty);
  if (id === 'dodge') return new DodgeGame(holds, wall, rand, difficulty);
  throw new Error(`Unknown game "${id}"`);
}
