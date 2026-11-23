// Whole-body geometry for LED games: per-joint smoothing with hold/outlier logic, a capsule
// model of the climber for collisions, and a stick figure for display on the LED board.
// All coordinates are straightened-wall pixels (x right, y DOWN); radii are px unless named *Cm.
import { OneEuro2D } from '../core/filters.js';

/** MediaPipe pose landmark indices used by the body model (anatomical left/right). */
export const JOINT = Object.freeze({
  NOSE: 0, L_SHOULDER: 11, R_SHOULDER: 12, L_ELBOW: 13, R_ELBOW: 14, L_WRIST: 15, R_WRIST: 16,
  L_HIP: 23, R_HIP: 24, L_KNEE: 25, R_KNEE: 26, L_ANKLE: 27, R_ANKLE: 28, L_TOE: 31, R_TOE: 32,
});

/**
 * Tunable body dimensions in cm. Capsule radii per part; the torso half width is
 * clamp(torsoWidthFactor * shoulderWidth, torsoMin, torsoMax). When a torso end is estimated
 * it is placed torsoLengthFactor * (shoulder or hip width) away, with the width at least
 * minPairWidth. jump: max plausible joint travel between consecutive frames.
 */
export const BODY_CM = Object.freeze({
  upperArm: 6, foreArm: 5, thigh: 9, shin: 7, head: 9, foot: 4,
  torsoMin: 13, torsoMax: 30, torsoWidthFactor: 0.6,
  torsoLengthFactor: 1.5, minPairWidth: 25, jump: 120,
});

const J = JOINT;
const USED = Object.values(JOINT);
// Limb capsules: [kind, side, jointA, jointB].
const LIMBS = [
  ['upperArm', 'l', J.L_SHOULDER, J.L_ELBOW], ['upperArm', 'r', J.R_SHOULDER, J.R_ELBOW],
  ['foreArm', 'l', J.L_ELBOW, J.L_WRIST], ['foreArm', 'r', J.R_ELBOW, J.R_WRIST],
  ['thigh', 'l', J.L_HIP, J.L_KNEE], ['thigh', 'r', J.R_HIP, J.R_KNEE],
  ['shin', 'l', J.L_KNEE, J.L_ANKLE], ['shin', 'r', J.R_KNEE, J.R_ANKLE],
  ['foot', 'l', J.L_ANKLE, J.L_TOE], ['foot', 'r', J.R_ANKLE, J.R_TOE],
];
const JUMP_DT_MS = 150;
const JUMP_FRAMES = 3;

const fin = (n) => typeof n === 'number' && Number.isFinite(n);

/** Squared distance from (px,py) to segment (ax,ay)-(bx,by). */
function segDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = ax + t * dx - px, ey = ay + t * dy - py;
  return ex * ex + ey * ey;
}

/** Distance from a point to a rectangle (0 inside). */
function pointRectDist(px, py, x0, y0, x1, y1) {
  const dx = px < x0 ? x0 - px : px > x1 ? px - x1 : 0;
  const dy = py < y0 ? y0 - py : py > y1 ? py - y1 : 0;
  return Math.sqrt(dx * dx + dy * dy);
}

// Inside-distance of point at parameter t on the segment: min distance to the 4 edges
// (positive inside, negative outside). Piecewise linear and concave in t.
function insideAt(t, ax, ay, dx, dy, x0, y0, x1, y1) {
  const x = ax + t * dx, y = ay + t * dy;
  return Math.min(x - x0, x1 - x, y - y0, y1 - y);
}

/**
 * Signed distance from segment a-b to rectangle: >0 = Euclidean gap, <=0 = minus the deepest
 * penetration (largest distance from any segment point to the rect boundary, inside).
 */
function segRectSigned(ax, ay, bx, by, x0, y0, x1, y1) {
  const dx = bx - ax, dy = by - ay;
  // Max of a concave piecewise-linear function lies at an endpoint or where two of the
  // four edge functions cross: x-x0 = x1-x (t where x = mid-x), y likewise, and the 4 mixed pairs.
  let best = Math.max(insideAt(0, ax, ay, dx, dy, x0, y0, x1, y1), insideAt(1, ax, ay, dx, dy, x0, y0, x1, y1));
  const fx = [ax - x0, dx, x1 - ax, -dx], fy = [ay - y0, dy, y1 - ay, -dy]; // value, slope pairs
  const lin = [fx[0], fx[1], fx[2], fx[3], fy[0], fy[1], fy[2], fy[3]];
  for (let i = 0; i < 4; i++) for (let k = i + 1; k < 4; k++) {
    const ci = lin[i * 2], si = lin[i * 2 + 1], ck = lin[k * 2], sk = lin[k * 2 + 1];
    const ds = si - sk;
    if (ds === 0) continue;
    const t = (ck - ci) / ds;
    if (t > 0 && t < 1) { const v = insideAt(t, ax, ay, dx, dy, x0, y0, x1, y1); if (v > best) best = v; }
  }
  if (best >= 0) return -best;
  // Disjoint convex sets: closest pair involves a segment endpoint or a rect corner.
  let d2 = Math.min(segDist2(x0, y0, ax, ay, bx, by), segDist2(x1, y0, ax, ay, bx, by),
    segDist2(x0, y1, ax, ay, bx, by), segDist2(x1, y1, ax, ay, bx, by));
  const da = pointRectDist(ax, ay, x0, y0, x1, y1), db = pointRectDist(bx, by, x0, y0, x1, y1);
  return Math.min(Math.sqrt(d2), da, db);
}

class JointState {
  constructor(filterOpts) { this.f = new OneEuro2D(filterOpts); this.clear(); }
  clear() {
    this.f.reset();
    this.x = 0; this.y = 0;          // smoothed
    this.rx = 0; this.ry = 0;        // last accepted raw (jump reference)
    this.t = null;                   // time of last accepted raw sample (null = dropped)
    this.cx = 0; this.cy = 0; this.cn = 0; // outlier candidate and its consecutive count
  }
}

/** Tracks one climber's body from pose frames. See the module header for units. */
export class BodyModel {
  /**
   * @param {{pxPerCm:number, minVisibility?:number, holdMs?:number, lostMs?:number,
   *   filter?:{minCutoff:number, beta:number}}} o
   *   pxPerCm: wall px per cm; minVisibility (0.35): below it a landmark counts as missing;
   *   holdMs (300): how long a missing joint keeps its last value; lostMs (500): how long the
   *   torso may go without fresh data before `tracked` turns false; filter: One-Euro params.
   */
  constructor(o = {}) {
    o = o || {};
    this.pxPerCm = fin(o.pxPerCm) && o.pxPerCm > 0 ? o.pxPerCm : 2.8;
    this.minVisibility = fin(o.minVisibility) ? o.minVisibility : 0.35;
    this.holdMs = fin(o.holdMs) ? o.holdMs : 300;
    this.lostMs = fin(o.lostMs) ? o.lostMs : 500;
    const f = o.filter || {};
    this.filterOpts = { minCutoff: fin(f.minCutoff) ? f.minCutoff : 1.5, beta: fin(f.beta) ? f.beta : 0.05 };
    this.js = new Array(33);
    for (const i of USED) this.js[i] = new JointState(this.filterOpts);
    this.reset();
  }

  /** Forget everything (all joints dropped, filters reset, not tracked). */
  reset() {
    for (const i of USED) this.js[i].clear();
    this.now = null;
    this.torsoGoodAt = null;
    this._parts = []; this._segs = []; this._centre = null; this._bounds = null;
  }

  /**
   * Feed one pose frame. `joints`: 33 {x,y,v} in wall px (v = visibility 0..1, missing v = 1),
   * or null/undefined when nobody is seen. Never throws.
   * @param {number} now ms timestamp
   * @param {Array<{x:number,y:number,v?:number}>|null|undefined} joints
   */
  update(now, joints) {
    if (!fin(now)) return;
    if (this.now !== null && now < this.now) this.reset(); // clock went backwards
    this.now = now;
    const jump = BODY_CM.jump * this.pxPerCm, jump2 = jump * jump;
    const arr = joints && typeof joints === 'object' && typeof joints.length === 'number' ? joints : null;
    for (const i of USED) {
      const s = this.js[i];
      let p = null;
      if (arr && i < arr.length) { try { p = arr[i]; } catch { p = null; } }
      let x = NaN, y = NaN, v = NaN;
      if (p && typeof p === 'object') { x = p.x; y = p.y; v = p.v === undefined || p.v === null ? 1 : p.v; }
      if (fin(x) && fin(y) && fin(v) && v >= this.minVisibility) this._observe(s, now, x, y, jump2);
      else s.cn = 0; // a gap breaks an outlier streak
      if (s.t !== null && now - s.t > this.holdMs) s.clear(); // drop: next sighting starts fresh
    }
    this._rebuild();
  }

  _observe(s, now, x, y, jump2) {
    if (s.t === null) { s.f.reset(); this._accept(s, now, x, y); return; }
    const d2 = (x - s.rx) ** 2 + (y - s.ry) ** 2;
    if (d2 <= jump2 || now - s.t >= JUMP_DT_MS) {
      if (d2 > jump2) s.f.reset(); // long gap and far away: snap, do not slide
      this._accept(s, now, x, y);
      return;
    }
    // Implausible jump: hold the previous value unless the new position persists.
    const c2 = (x - s.cx) ** 2 + (y - s.cy) ** 2;
    if (s.cn > 0 && c2 <= jump2) s.cn++; else s.cn = 1;
    s.cx = x; s.cy = y;
    if (s.cn >= JUMP_FRAMES) { s.f.reset(); this._accept(s, now, x, y); }
  }

  _accept(s, now, x, y) {
    const r = s.f.filter(x, y, now / 1000);
    s.x = r[0]; s.y = r[1]; s.rx = x; s.ry = y; s.t = now; s.cn = 0;
  }

  _ok(i) { return this.js[i].t !== null; }

  _rebuild() {
    const js = this.js, ppc = this.pxPerCm, parts = [], segs = [];
    const pt = (i) => ({ x: js[i].x, y: js[i].y });
    const sh = this._ok(J.L_SHOULDER) && this._ok(J.R_SHOULDER);
    const hp = this._ok(J.L_HIP) && this._ok(J.R_HIP);
    let centre = null;
    if (sh || hp) {
      const pair = (a, b) => {
        const A = js[a], B = js[b];
        return { mx: (A.x + B.x) / 2, my: (A.y + B.y) / 2, dx: B.x - A.x, dy: B.y - A.y, w: Math.hypot(B.x - A.x, B.y - A.y), t: Math.min(A.t, B.t) };
      };
      const S = sh ? pair(J.L_SHOULDER, J.R_SHOULDER) : null;
      const H = hp ? pair(J.L_HIP, J.R_HIP) : null;
      let a, b, estimated = false;
      if (S && H) { a = { x: S.mx, y: S.my }; b = { x: H.mx, y: H.my }; }
      else {
        // Only one pair: put the other torso end along the pair line's perpendicular, pointing
        // down (+y) from the shoulders or up from the hips, at 1.5 x the pair width.
        const P = S || H, w = Math.max(P.w, BODY_CM.minPairWidth * ppc);
        let nx = 0, ny = 1;
        if (P.w > 1e-6) { nx = -P.dy / P.w; ny = P.dx / P.w; if (ny < 0) { nx = -nx; ny = -ny; } }
        const L = BODY_CM.torsoLengthFactor * w, sgn = S ? 1 : -1;
        const m = { x: P.mx, y: P.my }, o = { x: P.mx + sgn * nx * L, y: P.my + sgn * ny * L };
        if (S) { a = m; b = o; } else { a = o; b = m; }
        estimated = true;
      }
      const width = S ? S.w : H.w;
      const r = Math.min(BODY_CM.torsoMax * ppc, Math.max(BODY_CM.torsoMin * ppc, BODY_CM.torsoWidthFactor * width));
      const torso = { kind: 'torso', side: '', a, b, r };
      if (estimated) torso.estimated = true;
      parts.push(torso);
      segs.push({ kind: 'torso', a, b });
      if (S) segs.push({ kind: 'shoulders', a: pt(J.L_SHOULDER), b: pt(J.R_SHOULDER) });
      if (H) segs.push({ kind: 'hips', a: pt(J.L_HIP), b: pt(J.R_HIP) });
      centre = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const good = Math.max(S ? S.t : -Infinity, H ? H.t : -Infinity);
      if (this.torsoGoodAt === null || good > this.torsoGoodAt) this.torsoGoodAt = good;
    }
    if (this._ok(J.NOSE)) {
      const n = pt(J.NOSE);
      parts.push({ kind: 'head', side: '', a: n, b: n, r: BODY_CM.head * ppc });
      segs.push({ kind: 'head', a: n, b: n });
    }
    for (const [kind, side, ia, ib] of LIMBS) {
      if (!this._ok(ia) || !this._ok(ib)) continue;
      const a = pt(ia), b = pt(ib);
      parts.push({ kind, side, a, b, r: BODY_CM[kind] * ppc });
      if (kind !== 'foot') segs.push({ kind, a, b });
    }
    let bounds = null;
    if (parts.length) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of parts) {
        x0 = Math.min(x0, p.a.x - p.r, p.b.x - p.r); y0 = Math.min(y0, p.a.y - p.r, p.b.y - p.r);
        x1 = Math.max(x1, p.a.x + p.r, p.b.x + p.r); y1 = Math.max(y1, p.a.y + p.r, p.b.y + p.r);
      }
      bounds = { x0, y0, x1, y1 };
    }
    this._parts = parts; this._segs = segs; this._centre = centre; this._bounds = bounds;
  }

  /**
   * True when a torso had fresh (non-held) data within lostMs of the last update's `now`.
   * Note: with holdMs < lostMs, parts/centre may already be empty while this is still true.
   */
  get tracked() { return this.now !== null && this.trackedAt(this.now); }

  /**
   * Same test as `tracked` against an arbitrary time (e.g. the animation frame between poses).
   * @param {number} now ms
   */
  trackedAt(now) {
    return this.torsoGoodAt !== null && fin(now) && now - this.torsoGoodAt <= this.lostMs;
  }

  /** Torso centre {x,y} in px, or null when there is no torso. */
  get centre() { return this._centre; }

  /** {x0,y0,x1,y1} px box around all capsules including radii, or null. */
  get bounds() { return this._bounds; }

  /**
   * Capsules of all currently known parts (shared array; do not mutate):
   * {kind, side:'l'|'r'|'', a:{x,y}, b:{x,y}, r:px, estimated?:true (torso only)}.
   */
  get parts() { return this._parts; }

  /**
   * Exact capsule-vs-rectangle test against `rect` shrunk by shrinkCm on every side.
   * depth = how far (px) the deepest capsule surface reaches into the rect (0 when no hit).
   * @param {{x0:number,y0:number,x1:number,y1:number}} rect
   * @param {number} [shrinkCm=0]
   * @returns {{hit:boolean, kind:string|null, depth:number}}
   */
  hitsRect(rect, shrinkCm = 0) {
    const miss = { hit: false, kind: null, depth: 0 };
    if (!rect || !this._parts.length) return miss;
    const s = fin(shrinkCm) ? shrinkCm * this.pxPerCm : 0;
    const x0 = Math.min(rect.x0, rect.x1) + s, x1 = Math.max(rect.x0, rect.x1) - s;
    const y0 = Math.min(rect.y0, rect.y1) + s, y1 = Math.max(rect.y0, rect.y1) - s;
    if (!(x0 <= x1 && y0 <= y1)) return miss; // also rejects NaN
    let best = -Infinity, kind = null;
    for (const p of this._parts) {
      // Cheap reject on the capsule's bounding box.
      if (Math.min(p.a.x, p.b.x) - p.r > x1 || Math.max(p.a.x, p.b.x) + p.r < x0 ||
        Math.min(p.a.y, p.b.y) - p.r > y1 || Math.max(p.a.y, p.b.y) + p.r < y0) continue;
      const depth = p.r - segRectSigned(p.a.x, p.a.y, p.b.x, p.b.y, x0, y0, x1, y1);
      if (depth >= 0 && depth > best) { best = depth; kind = p.kind; }
    }
    return kind === null ? miss : { hit: true, kind, depth: best };
  }

  /**
   * Min distance in px from p to any part's surface (0 inside), Infinity without parts.
   * @param {{x:number,y:number}} p
   */
  distanceTo(p) {
    if (!p || !fin(p.x) || !fin(p.y)) return Infinity;
    let best = Infinity;
    for (const c of this._parts) {
      const d = Math.sqrt(segDist2(p.x, p.y, c.a.x, c.a.y, c.b.x, c.b.y)) - c.r;
      if (d < best) best = d;
    }
    return best < 0 ? 0 : best;
  }

  /**
   * Stick-figure bones for display (shared array): torso axis, 'shoulders' and 'hips' lines
   * (real joints only), arms, thighs, shins, and 'head' as a degenerate segment (a === b).
   * @returns {Array<{kind:string, a:{x:number,y:number}, b:{x:number,y:number}}>}
   */
  segments() { return this._segs; }

  /**
   * LEDs within radiusPx of any bone segment.
   * @param {Array<{pos:number,x:number,y:number}>} leds
   * @param {number} radiusPx
   * @returns {Set<number>} the matching leds' `pos`
   */
  boneLeds(leds, radiusPx) {
    const out = new Set(), segs = this._segs, n = segs.length;
    if (!n || !leds || typeof leds.length !== 'number' || !fin(radiusPx) || radiusPx < 0) return out;
    const r2 = radiusPx * radiusPx;
    // Expanded bounding boxes of all segments, plus their union, as flat numbers.
    const bb = new Float64Array(n * 4);
    let ux0 = Infinity, uy0 = Infinity, ux1 = -Infinity, uy1 = -Infinity;
    for (let k = 0; k < n; k++) {
      const { a, b } = segs[k];
      const x0 = Math.min(a.x, b.x) - radiusPx, y0 = Math.min(a.y, b.y) - radiusPx;
      const x1 = Math.max(a.x, b.x) + radiusPx, y1 = Math.max(a.y, b.y) + radiusPx;
      bb[k * 4] = x0; bb[k * 4 + 1] = y0; bb[k * 4 + 2] = x1; bb[k * 4 + 3] = y1;
      if (x0 < ux0) ux0 = x0; if (y0 < uy0) uy0 = y0; if (x1 > ux1) ux1 = x1; if (y1 > uy1) uy1 = y1;
    }
    for (let i = 0; i < leds.length; i++) {
      const l = leds[i];
      if (!l) continue;
      const x = l.x, y = l.y;
      if (!(x >= ux0 && x <= ux1 && y >= uy0 && y <= uy1)) continue;
      for (let k = 0; k < n; k++) {
        if (x < bb[k * 4] || y < bb[k * 4 + 1] || x > bb[k * 4 + 2] || y > bb[k * 4 + 3]) continue;
        const { a, b } = segs[k];
        if (segDist2(x, y, a.x, a.y, b.x, b.y) <= r2) { out.add(l.pos); break; }
      }
    }
    return out;
  }
}
