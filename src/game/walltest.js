// "Wall test": plays every kind of display a game uses, in a fixed order, so you can check the physical wall without
// playing: countdown, go flash, status strips (time bar, combo, score ticks), lives, a warning bar that turns red and falls,
// target holds and the game-over sweep. No contacts needed. Same interface as the games (start / update / output / state).

import { COLORS } from './games.js';
import { GO_MS, SWEEP_MAX_MS } from './wallhud.js';

const COUNTDOWN_MS = 3000;
const SCORE_PHASE_MS = 4000;   // time bar emptying, combo and score filling
const BAR_PHASE_MS = 5000;     // lives going out, a bar warning then falling
const WARN_SHARE = 0.2;        // first fifth of the bar phase: the bar only warns
const TOTAL_MS = COUNTDOWN_MS + GO_MS + SCORE_PHASE_MS + BAR_PHASE_MS + SWEEP_MAX_MS;
const DEMO_LIVES = 3;
const DEMO_SCORE_TICKS = 30;   // more than a row, so the second lap shows

export class WallTest {
  /** @param {{id:number, cx:number, cy:number}[]} holds playable holds @param {{RW:number, RH:number, pxPerCm:number}} wall */
  constructor(holds, wall) {
    this.id = 'walltest';
    this.practice = true;   // no score, no record
    this.holds = holds;
    this.wall = wall;
    this.phase = 'running';
    this.startedAt = null;
    this.clock = 0;
    this.record = false;
    this.score = 0;
    // two target holds near the middle of the wall
    const cx = wall.RW / 2, cy = wall.RH / 2;
    this.targets = [...holds].sort((a, b) => Math.hypot(a.cx - cx, a.cy - cy) - Math.hypot(b.cx - cx, b.cy - cy)).slice(0, 2);
  }
  get over() { return this.phase === 'over'; }
  start(now) { this.startedAt = now; this.clock = now; this.phase = 'running'; }
  update(now) { this.clock = now; if (this.phase === 'running' && now - this.startedAt >= TOTAL_MS) this.phase = 'over'; }
  get lit() { return new Map(); }
  get flashLit() { return new Map(); }

  output(now) {
    const t = Math.max(0, now - this.startedAt), out = { lit: new Map(), flash: new Map(), zones: [], hud: null, fx: null };
    const sweepAt = TOTAL_MS - SWEEP_MAX_MS;
    if (this.phase === 'over' || t >= sweepAt) {
      out.fx = { kind: 'sweep', color: COLORS.coin, t: Math.max(0, (t - sweepAt) / 1000) };
      out.hud = this._hud({ lives: 0, combo: 1, ticks: DEMO_SCORE_TICKS });
      return out;
    }
    if (t < COUNTDOWN_MS) { out.fx = { kind: 'countdown', n: Math.max(1, Math.ceil((COUNTDOWN_MS - t) / 1000)) }; return out; }
    if (t < COUNTDOWN_MS + GO_MS) { out.fx = { kind: 'go' }; return out; }
    const u0 = t - COUNTDOWN_MS - GO_MS;
    if (u0 < SCORE_PHASE_MS) {                       // time bar empties, combo and score fill
      const u = u0 / SCORE_PHASE_MS;
      for (const h of this.targets) out.lit.set(h.id, COLORS.coin);
      out.hud = this._hud({ time: 1 - u, combo: 1 + Math.floor(u * 3), ticks: Math.floor(u * DEMO_SCORE_TICKS) });
      return out;
    }
    const u = (u0 - SCORE_PHASE_MS) / BAR_PHASE_MS, half = this.wall.pxPerCm * 12, live = u >= WARN_SHARE;   // lives go out, a bar warns, then falls
    const fall = live ? (u - WARN_SHARE) / (1 - WARN_SHARE) : 0, y = half + fall * (this.wall.RH - 2 * half);
    out.zones = [{ x0: this.wall.RW * 0.2, x1: this.wall.RW * 0.6, y0: y - half, y1: y + half, color: live ? COLORS.danger : COLORS.warn }];
    out.hud = this._hud({ lives: Math.max(0, DEMO_LIVES - Math.floor(u * (DEMO_LIVES + 1))), speed: Math.max(0.05, u), ticks: DEMO_SCORE_TICKS });
    return out;
  }
  /** Status strips: time bar (or lives when `lives` is given), combo (or speed), score ticks. */
  _hud({ time = 0, lives = null, combo = 1, speed = 0, ticks = 0 }) {
    return {
      top: lives != null ? { kind: 'segments', count: DEMO_LIVES, lit: lives, color: COLORS.danger } : { kind: 'bar', value: time, color: COLORS.time },
      left: speed > 0 ? { kind: 'bar', value: speed, color: COLORS.speed } : { kind: 'count', n: combo, color: COLORS.coin },
      bottom: { kind: 'ticks', count: ticks },
    };
  }
  state(now) { return { phase: this.phase, score: 0, secondsLeft: Math.max(0, Math.ceil((TOTAL_MS - (now - this.startedAt)) / 1000)), countdown: 0 }; }
}
export const WALL_TEST_MS = TOTAL_MS;
