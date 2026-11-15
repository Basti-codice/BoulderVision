// Small climbing games driven by the live hold contacts. Pure logic: no DOM, no Bluetooth, deterministic with a seeded
// random generator, so every rule can be unit tested.
//
// A game sees the holds (wall pixels), the current contacts per limb ({LH,RH,LF,RF} -> hold id | null) and the time.
// It reports what should light up (Map holdId -> {r,g,b}) and a small state for the HUD.

/** Light colours (3-3-2 bit friendly on the LED board). */
export const COLORS = {
  coin: { r: 255, g: 200, b: 0 },
  golden: { r: 255, g: 255, b: 255 },
  collected: { r: 0, g: 255, b: 0 },
  danger: { r: 255, g: 0, b: 0 },
  hit: { r: 255, g: 255, b: 255 },
};

export const GAMES = [
  { id: 'coins', title: 'Coins', blurb: 'Grab the lit coin holds with your hands. Quick grabs build a combo (up to x3). 60 seconds.' },
  { id: 'dodge', title: 'Dodge', blurb: 'Red bars fall from the top. Do not touch a red hold with a hand or foot. Three lives; it gets faster.' },
];

const HAND_LIMBS = ['LH', 'RH'];
const LIMBS = ['LH', 'RH', 'LF', 'RF'];

const COINS = {
  duration: 60_000,         // ms
  countdown: 2_000,         // ms of "get ready" before the first coin
  simultaneous: 2,          // coins visible at once
  ttl: 14_000,              // a coin disappears after this long
  reachMinCm: 35,           // a new coin is placed at least this far from the hands ...
  reachMaxCm: 110,          // ... and at most this far (a reachable move)
  comboWindow: 8_000,       // a grab within this time of the previous one raises the combo
  comboMax: 3,
  goldenEvery: 5,           // every 5th coin is worth more
  goldenValue: 3,
  flash: 450,               // ms a collected hold stays green
};

const DODGE = {
  lives: 3,
  countdown: 3_000,
  startSpeedCm: 9,          // bar speed (cm per second) at the start ...
  speedGainCm: 0.35,        // ... plus this per second survived ...
  maxSpeedCm: 28,           // ... up to this
  thicknessCm: 24,          // height of a bar
  blockWidthCm: 70,         // width of one red block inside a bar
  maxBlockedShare: 0.55,    // a bar never covers more than this share of the wall width (always a way through)
  gapSeconds: 4.2,          // time between bars at the start (shrinks with speed)
  minGapSeconds: 2.2,
  hitCooldown: 1_300,       // ms during which the same limb cannot lose another life
  hitFlash: 600,
};

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Base class: countdown, phases, shared helpers. */
class Game {
  /**
   * @param {{id:number, cx:number, cy:number}[]} holds real holds with a position (wall px)
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
    this.score = 0;
    this.prev = { LH: null, RH: null, LF: null, RF: null };
  }
  get over() { return this.phase === 'over'; }
  cm(px) { return px / this.wall.pxPerCm; }
  px(cm) { return cm * this.wall.pxPerCm; }
  /** Holds that are touched right now. */
  held(contacts) { return new Set(LIMBS.map((l) => contacts[l]).filter((id) => id != null)); }
  /** Limbs that grabbed a hold since the previous update: [{limb, holdId}]. */
  grabs(contacts) {
    const out = [];
    for (const l of LIMBS) if (contacts[l] != null && contacts[l] !== this.prev[l]) out.push({ limb: l, holdId: contacts[l] });
    return out;
  }
  remember(contacts) { for (const l of LIMBS) this.prev[l] = contacts[l] ?? null; }
}

/** Collect lit coin holds with a hand. */
export class CoinGame extends Game {
  constructor(holds, wall, rand) {
    super(holds, wall, rand);
    this.coins = [];        // {holdId, spawnedAt, value}
    this.flashes = [];      // {holdId, until}
    this.collected = 0;     // coins picked up
    this.spawned = 0;       // coins that appeared (for the golden rhythm)
    this.combo = 1;
    this.lastGrab = -Infinity;
  }

  start(now) { this.startedAt = now; this.phase = 'ready'; }

  /** Pick a hold at a reachable distance from the hands (or from the middle of the wall when nothing is held yet). */
  _pickHold(now, contacts) {
    const hands = HAND_LIMBS.map((l) => this.byId.get(contacts[l])).filter(Boolean);
    const ref = hands.length
      ? { x: hands.reduce((s, h) => s + h.cx, 0) / hands.length, y: hands.reduce((s, h) => s + h.cy, 0) / hands.length }
      : { x: this.wall.RW / 2, y: this.wall.RH * 0.55 };
    const taken = new Set([...this.coins.map((c) => c.holdId), ...this.held(contacts)]);
    const reachable = this.holds.filter((h) => !taken.has(h.id) && (() => { const d = this.cm(dist(ref, { x: h.cx, y: h.cy })); return d >= COINS.reachMinCm && d <= COINS.reachMaxCm; })());
    const pool = reachable.length ? reachable : this.holds.filter((h) => !taken.has(h.id));
    return pool.length ? pool[Math.floor(this.rand() * pool.length)] : null;
  }

  update(now, contacts) {
    const t = now - this.startedAt;
    if (this.phase === 'ready' && t >= COINS.countdown) { this.phase = 'running'; this.runStart = now; }
    if (this.phase === 'running') {
      if (now - this.runStart >= COINS.duration) this.phase = 'over';
      else {
        this.coins = this.coins.filter((c) => now - c.spawnedAt < COINS.ttl);
        if (this.coins.length === 0 && this.combo > 1 && now - this.lastGrab > COINS.comboWindow) this.combo = 1;
        for (const g of this.grabs(contacts)) {
          if (!HAND_LIMBS.includes(g.limb)) continue;
          const i = this.coins.findIndex((c) => c.holdId === g.holdId);
          if (i < 0) continue;
          const [coin] = this.coins.splice(i, 1);
          this.combo = now - this.lastGrab <= COINS.comboWindow ? Math.min(COINS.comboMax, this.combo + 1) : 1;
          this.lastGrab = now;
          this.score += coin.value * this.combo;
          this.collected++;
          this.flashes.push({ holdId: coin.holdId, until: now + COINS.flash });
        }
        while (this.coins.length < COINS.simultaneous) {
          const h = this._pickHold(now, contacts);
          if (!h) break;
          this.spawned++;
          this.coins.push({ holdId: h.id, spawnedAt: now, value: this.spawned % COINS.goldenEvery === 0 ? COINS.goldenValue : 1 });
        }
      }
    }
    this.flashes = this.flashes.filter((f) => f.until > now);
    this.remember(contacts);
  }

  get lit() {
    const m = new Map();
    if (this.phase !== 'running') return m;
    for (const c of this.coins) m.set(c.holdId, c.value > 1 ? COLORS.golden : COLORS.coin);
    for (const f of this.flashes) m.set(f.holdId, COLORS.collected);
    return m;
  }

  state(now) {
    const left = this.phase === 'ready' ? COINS.duration : this.phase === 'over' ? 0 : Math.max(0, COINS.duration - (now - this.runStart));
    return { phase: this.phase, score: this.score, combo: this.combo, collected: this.collected, secondsLeft: Math.ceil(left / 1000), countdown: this.phase === 'ready' ? Math.max(0, Math.ceil((COINS.countdown - (now - this.startedAt)) / 1000)) : 0 };
  }
}

/** Red bars fall down the wall; do not touch a red hold. */
export class DodgeGame extends Game {
  constructor(holds, wall, rand) {
    super(holds, wall, rand);
    this.lives = DODGE.lives;
    this.bars = [];          // {y (px, centre), blocks:[{x0,x1}]}
    this.nextBarAt = 0;
    this.lastTick = null;
    this.cooldown = { LH: -Infinity, RH: -Infinity, LF: -Infinity, RF: -Infinity };
    this.flashes = [];
    this.survived = 0;       // seconds
  }

  start(now) { this.startedAt = now; this.phase = 'ready'; this.lastTick = now; }

  speedCm() { return Math.min(DODGE.maxSpeedCm, DODGE.startSpeedCm + DODGE.speedGainCm * this.survived); }

  /** Random red blocks for one bar; together they never cover more than maxBlockedShare of the width. */
  _makeBlocks() {
    const W = this.wall.RW, bw = this.px(DODGE.blockWidthCm);
    const count = Math.max(1, Math.min(Math.floor((W * DODGE.maxBlockedShare) / bw), 2 + Math.floor(this.survived / 25)));
    const blocks = [];
    for (let i = 0, guard = 0; i < count && guard < 40; guard++) {
      const x0 = this.rand() * (W - bw);
      if (blocks.every((b) => x0 + bw < b.x0 || x0 > b.x1)) { blocks.push({ x0, x1: x0 + bw }); i++; }
    }
    return blocks;
  }

  isDanger(h) {
    const half = this.px(DODGE.thicknessCm) / 2;
    return this.bars.some((b) => Math.abs(h.cy - b.y) <= half && b.blocks.some((k) => h.cx >= k.x0 && h.cx <= k.x1));
  }

  update(now, contacts) {
    const dt = Math.max(0, (now - this.lastTick) / 1000);
    this.lastTick = now;
    if (this.phase === 'ready' && now - this.startedAt >= DODGE.countdown) { this.phase = 'running'; this.runStart = now; this.nextBarAt = now; }
    if (this.phase === 'running') {
      this.survived = (now - this.runStart) / 1000;
      const v = this.px(this.speedCm());
      for (const b of this.bars) b.y += v * dt;
      this.bars = this.bars.filter((b) => b.y < this.wall.RH + this.px(DODGE.thicknessCm));
      if (now >= this.nextBarAt) {
        this.bars.push({ y: -this.px(DODGE.thicknessCm) / 2, blocks: this._makeBlocks() });
        const gap = Math.max(DODGE.minGapSeconds, DODGE.gapSeconds * (DODGE.startSpeedCm / this.speedCm()) ** 0.6);
        this.nextBarAt = now + gap * 1000;
      }
      for (const l of LIMBS) {
        const h = contacts[l] != null ? this.byId.get(contacts[l]) : null;
        if (h && this.isDanger(h) && now - this.cooldown[l] >= DODGE.hitCooldown) {
          this.cooldown[l] = now;
          this.lives--;
          this.flashes.push({ holdId: h.id, until: now + DODGE.hitFlash });
          if (this.lives <= 0) { this.phase = 'over'; break; }
        }
      }
      this.score = Math.floor(this.survived);
    }
    this.flashes = this.flashes.filter((f) => f.until > now);
    this.remember(contacts);
  }

  get lit() {
    const m = new Map();
    if (this.phase === 'ready') return m;
    for (const h of this.holds) if (this.isDanger(h)) m.set(h.id, COLORS.danger);
    for (const f of this.flashes) m.set(f.holdId, COLORS.hit);
    return m;
  }

  state(now) {
    return { phase: this.phase, score: this.score, lives: this.lives, countdown: this.phase === 'ready' ? Math.max(0, Math.ceil((DODGE.countdown - (now - this.startedAt)) / 1000)) : 0, speedCm: Math.round(this.speedCm()) };
  }
}

/** @param {'coins'|'dodge'} id */
export function createGame(id, holds, wall, rand) {
  if (id === 'coins') return new CoinGame(holds, wall, rand);
  if (id === 'dodge') return new DodgeGame(holds, wall, rand);
  throw new Error(`Unknown game "${id}"`);
}
