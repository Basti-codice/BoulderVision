// Simulated wall, LED board and climber for the demo mode and automated tests.
// Lets the whole pipeline (align -> detect -> LED scan -> live contacts -> LED output) run without hardware.
import { solveHomography, applyH, ellipsePolygon } from '../core/geometry.js';
import { decodeStream, decodeColor, MockTransport } from '../board/aurora.js';
import { rng } from './rng.js';

const W = 1280, H = 720;
const CORNERS = [[360, 50], [930, 40], [965, 690], [325, 672]]; // TL TR BR BL in the camera image

export class DemoWorld {
  constructor({ seed = 7, cols = 15, rows = 14, ledSlots = 500, replaceOnFirst = true, glow = 13 } = {}) {
    this.glow = glow; // glow radius in camera pixels (~8 cm at the default framing)
    this.width = W; this.height = H; this.wall = { RW: 1000, RH: 1000, widthM: 3.6, heightM: 3.6 };
    this.corners = CORNERS.map((c) => c.slice());
    this.H = solveHomography([[0, 0], [1000, 0], [1000, 1000], [0, 1000]], this.corners); // wall -> image
    this.replaceOnFirst = replaceOnFirst;
    this.lit = new Map(); this.climber = false; this.t0 = null; this.ledSlots = ledSlots;
    const r = rng(seed);
    this.holds = []; this.empty = [];
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const x = ((i + 0.5 + (j % 2) * 0.3 - 0.15) / cols) * 960 + 20 + (r() - 0.5) * 14;
      const y = ((j + 0.5) / rows) * 960 + 20 + (r() - 0.5) * 14;
      if (r() < 0.04) { this.empty.push({ x, y }); continue; } // hole without a hold
      const rx = 11 + r() * 12, ry = Math.max(9, rx * (0.6 + r() * 0.4)), rot = r() * Math.PI;
      this.holds.push({ x, y, rx, ry, rot, shade: 165 + Math.floor(r() * 50) });
    }
    // LED positions: increasing along snake rows with random gaps inside 0..ledSlots-1
    const all = [...this.holds.map((h) => h), ...this.empty.map((e) => e)];
    all.sort((a, b) => Math.round(b.y / 66) - Math.round(a.y / 66) || a.x - b.x);
    const total = all.length, pool = new Set();
    while (pool.size < total) pool.add(Math.floor(r() * ledSlots));
    const positions = [...pool].sort((a, b) => a - b);
    all.forEach((e, i) => { e.led = positions[i]; });
    this.holds.forEach((h, i) => { h.id = i + 1; });
    this.leds = all.map((e) => ({ pos: e.led, x: e.x, y: e.y }));
    this._buildRoute();
    this.transport = new MockTransport((bytes) => this.applyBytes(bytes));
    this.dust = Array.from({ length: 40 }, () => ({ x: r() * 1000, y: r() * 1000, r: 1.5 + r() * 2 })); // chalk specks
    this.nuts = []; // T-nut holes grid
    for (let j = 0; j < 30; j++) for (let i = 0; i < 30; i++) this.nuts.push({ x: 17 + i * 33.5, y: 17 + j * 33.5 });
  }

  applyBytes(bytes) {
    let frames;
    try { frames = decodeStream(bytes); } catch (e) { console.warn('demo board: bad frame', e.message); return; }
    for (const f of frames) {
      if ((f.cmd === 82 || f.cmd === 84) && this.replaceOnFirst) this.lit.clear();
      for (const l of f.leds) { if (l.color === 0) this.lit.delete(l.pos); else this.lit.set(l.pos, l.color); }
    }
  }

  // ----- climber -----
  _buildRoute() {
    const mid = this.holds.filter((h) => h.x > 330 && h.x < 650).sort((a, b) => b.y - a.y);
    const near = (y, side) => mid.filter((h) => Math.abs(h.y - y) < 45 && (side < 0 ? h.x < 480 : h.x >= 480)).sort((a, b) => Math.abs(a.x - (side < 0 ? 420 : 560)) - Math.abs(b.x - (side < 0 ? 420 : 560)))[0];
    const steps = [];
    for (let k = 0; k < 7; k++) { const y = 840 - k * 105; steps.push({ LH: near(y - 330, -1), RH: near(y - 380, 1), LF: near(y, -1), RF: near(y + 40, 1) }); }
    this.route = steps.filter((s) => s.LH && s.RH && s.LF && s.RF);
    this.limbs = ['RF', 'LF', 'RH', 'LH'];
  }
  limbTarget(limb, t) {
    // One limb moves per 1.8 s slot (0.5 s motion); limbs earlier in this step's order already sit on the new hold.
    const cyc = 1.8, n = this.route.length, tt = t % (n * 4 * cyc);
    const ev = Math.floor(tt / cyc), step = Math.floor(ev / 4), which = this.limbs[ev % 4];
    const prev = this.route[Math.max(0, step - 1)][limb], next = this.route[step][limb];
    let from, to, p = 1;
    if (limb === which) { from = prev; to = next; p = Math.min(1, (tt - ev * cyc) / 0.5); }
    else if (this.limbs.indexOf(limb) < ev % 4) { from = to = next; }
    else { from = to = prev; }
    const e = p * p * (3 - 2 * p);
    return { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, hold: p >= 1 ? to.id : null };
  }
  expectedContacts(t) { const o = {}; for (const l of ['LH', 'RH', 'LF', 'RF']) o[l] = this.limbTarget(l, t).hold; return o; }

  skeletonWall(t) {
    const L = {}; for (const l of ['LH', 'RH', 'LF', 'RF']) L[l] = this.limbTarget(l, t);
    const hands = { x: (L.LH.x + L.RH.x) / 2, y: (L.LH.y + L.RH.y) / 2 }, feet = { x: (L.LF.x + L.RF.x) / 2, y: (L.LF.y + L.RF.y) / 2 };
    const S = { x: hands.x * 0.45 + feet.x * 0.55, y: hands.y * 0.55 + feet.y * 0.45 + 10 };
    const P = { x: S.x, y: S.y + 130 };
    const j = {};
    j.LSH = { x: S.x - 55, y: S.y }; j.RSH = { x: S.x + 55, y: S.y };
    j.LHIP = { x: P.x - 40, y: P.y }; j.RHIP = { x: P.x + 40, y: P.y };
    const hand = (l) => ({ x: L[l].x, y: L[l].y });
    j.LP = { x: L.LH.x + 8, y: L.LH.y - 4 }; j.LI = { x: L.LH.x - 8, y: L.LH.y - 10 };
    j.RP = { x: L.RH.x - 8, y: L.RH.y - 4 }; j.RI = { x: L.RH.x + 8, y: L.RH.y - 10 };
    // mid(index,pinky) is 7px above the hand target, so move targets by 7 to keep it on the hold centre
    for (const k of ['LP', 'LI', 'RP', 'RI']) j[k].y += 7;
    j.LW = { x: L.LH.x, y: L.LH.y + 19 }; j.RW = { x: L.RH.x, y: L.RH.y + 19 };
    j.LELB = { x: (j.LSH.x + j.LW.x) / 2 - 28, y: (j.LSH.y + j.LW.y) / 2 }; j.RELB = { x: (j.RSH.x + j.RW.x) / 2 + 28, y: (j.RSH.y + j.RW.y) / 2 };
    j.LFI = { x: L.LF.x, y: L.LF.y }; j.RFI = { x: L.RF.x, y: L.RF.y };
    j.LA = { x: L.LF.x - 2, y: L.LF.y + 22 }; j.RA = { x: L.RF.x + 2, y: L.RF.y + 22 };
    j.LHEEL = { x: L.LF.x - 3, y: L.LF.y + 32 }; j.RHEEL = { x: L.RF.x + 3, y: L.RF.y + 32 };
    j.LKNEE = { x: (j.LHIP.x + j.LA.x) / 2 - 24, y: (j.LHIP.y + j.LA.y) / 2 }; j.RKNEE = { x: (j.RHIP.x + j.RA.x) / 2 + 24, y: (j.RHIP.y + j.RA.y) / 2 };
    j.HEAD = { x: S.x, y: S.y - 70 };
    return j;
  }

  /** MediaPipe-style landmarks (normalised image coords) for the simulated climber. */
  poseAt(now) {
    if (!this.climber) return [];
    const j = this.skeletonWall(this.time(now)), lm = Array.from({ length: 33 }, () => ({ x: 0, y: 0, v: 0 }));
    const idx = { LSH: 11, RSH: 12, LELB: 13, RELB: 14, LW: 15, RW: 16, LP: 17, RP: 18, LI: 19, RI: 20, LHIP: 23, RHIP: 24, LKNEE: 25, RKNEE: 26, LA: 27, RA: 28, LHEEL: 29, RHEEL: 30, LFI: 31, RFI: 32 };
    const put = (i, p) => { const [x, y] = applyH(this.H, p.x, p.y); lm[i] = { x: x / W, y: y / H, v: 0.95 }; };
    for (const [k, i] of Object.entries(idx)) put(i, j[k]);
    for (let i = 0; i <= 10; i++) put(i, j.HEAD);
    return [{ lm }];
  }
  time(now) { if (this.t0 === null) this.t0 = now; return (now - this.t0) / 1000; }

  // ----- rendering -----
  render(ctx, now = performance.now()) {
    const m = (x, y) => applyH(this.H, x, y);
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#9a9a96'); g.addColorStop(1, '#6d6c68');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#4b4a47'; ctx.fillRect(0, 640, W, 80);
    ctx.beginPath(); this.corners.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath();
    ctx.fillStyle = '#17191c'; ctx.fill();
    ctx.fillStyle = '#23262a';
    for (const n of this.nuts) { const [x, y] = m(n.x, n.y); ctx.beginPath(); ctx.arc(x, y, 1.7, 0, 7); ctx.fill(); }
    for (const d of this.dust) { const [x, y] = m(d.x, d.y); ctx.fillStyle = '#7c7c78'; ctx.beginPath(); ctx.arc(x, y, d.r * 0.5, 0, 7); ctx.fill(); }
    for (const h of this.holds) {
      const poly = ellipsePolygon(h.x, h.y, h.rx, h.ry, 20, h.rot).map(([x, y]) => m(x, y));
      ctx.beginPath(); poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath();
      ctx.fillStyle = `rgb(${h.shade},${h.shade},${h.shade - 6})`; ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 1.2; ctx.stroke();
    }
    ctx.globalCompositeOperation = 'lighter';
    for (const [pos, color] of this.lit) {
      const led = this.leds.find((l) => l.pos === pos);
      if (!led) continue;
      const c = decodeColor(color), [x, y] = m(led.x, led.y), s = this.glow;
      const gr = ctx.createRadialGradient(x, y, 2, x, y, s);
      const col = (a) => `rgba(${Math.min(255, c.r * 1.1)},${Math.min(255, c.g * 1.1)},${Math.min(255, c.b * 1.1 + 25)},${a})`;
      gr.addColorStop(0, col(0.95)); gr.addColorStop(0.5, col(0.5)); gr.addColorStop(1, col(0));
      ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(x, y, s, 0, 7); ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    if (this.climber) this._drawClimber(ctx, this.time(now), m);
  }
  _drawClimber(ctx, t, m) {
    const j = this.skeletonWall(t), P = (k) => m(j[k].x, j[k].y);
    const line = (a, b, w, col) => { const A = P(a), B = P(b); ctx.strokeStyle = col; ctx.lineWidth = w; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(...A); ctx.lineTo(...B); ctx.stroke(); };
    line('LHIP', 'LKNEE', 17, '#2a2f3a'); line('LKNEE', 'LA', 15, '#2a2f3a'); line('RHIP', 'RKNEE', 17, '#2a2f3a'); line('RKNEE', 'RA', 15, '#2a2f3a');
    line('LHIP', 'RHIP', 24, '#2a2f3a');
    line('LSH', 'RSH', 30, '#2f7f86'); line('LSH', 'LHIP', 26, '#2f7f86'); line('RSH', 'RHIP', 26, '#2f7f86');
    line('LSH', 'LELB', 13, '#c99772'); line('LELB', 'LW', 11, '#c99772'); line('RSH', 'RELB', 13, '#c99772'); line('RELB', 'RW', 11, '#c99772');
    line('LA', 'LFI', 11, '#d6d2c8'); line('RA', 'RFI', 11, '#d6d2c8');
    const [hx, hy] = P('HEAD'); ctx.fillStyle = '#c99772'; ctx.beginPath(); ctx.arc(hx, hy, 17, 0, 7); ctx.fill();
  }
}

export class DemoPose {
  constructor(world) { this.world = world; this.variant = 'demo'; this.delegate = 'sim'; }
  async load() {}
  detect(source, ts) { return this.world.poseAt(ts); }
  close() {}
}
