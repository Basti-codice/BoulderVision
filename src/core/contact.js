// Turns per-frame limb positions (wall pixels) into debounced hold contacts.

import { polygonDistance } from './geometry.js';

export const LIMBS = ['LH', 'RH', 'LF', 'RF'];

export const DEFAULTS = {
  tolCm: 2.5,      // a limb point within this distance of a hold outline counts as "on" it
  releaseK: 1.8,   // contact is kept until the point is > tolCm*releaseK away
  onMs: 120,       // must hover over the same hold this long
  offMs: 160,      // must be away this long to release
  lostMs: 500,     // keep a contact this long while the limb is not tracked
  maxSpeedCmS: 90, // faster than this = swiping past, not touching
};

export class ContactTracker {
  /**
   * holds: [{id, poly, ghost?}], pxPerCm. Limb state is keyed by limb name.
   */
  constructor(holds, pxPerCm, options = {}) {
    this.pxPerCm = pxPerCm;
    this.opt = { ...DEFAULTS, ...options };
    this.setHolds(holds);
    this.reset();
  }
  setHolds(holds) { this.holds = holds.filter((h) => !h.ghost && !h.ignored); this.byId = new Map(holds.map((h) => [h.id, h])); }
  setOptions(o) { Object.assign(this.opt, o); }
  reset() {
    this.state = {};
    for (const l of LIMBS) this.state[l] = { hold: null, cand: null, candSince: 0, awaySince: null, lastSeen: -1e9, last: null };
  }
  get contacts() { const o = {}; for (const l of LIMBS) o[l] = this.state[l].hold; return o; }

  nearest(points) {
    let best = null, bd = Infinity;
    for (const h of this.holds) {
      let d = Infinity;
      for (const p of points) d = Math.min(d, polygonDistance(h.poly, p.x, p.y));
      if (d < bd) { bd = d; best = h; }
    }
    return best ? { hold: best, dist: bd } : null;
  }
  distTo(holdId, points) {
    const h = this.byId.get(holdId);
    if (!h) return Infinity;
    let d = Infinity;
    for (const p of points) d = Math.min(d, polygonDistance(h.poly, p.x, p.y));
    return d;
  }

  /**
   * t in ms. limbs: {LH: [{x,y}, ...] | null, ...}; the first point is the primary one (used for speed).
   * Returns events [{t, limb, hold, on}].
   */
  update(t, limbs) {
    const { tolCm, releaseK, onMs, offMs, lostMs, maxSpeedCmS } = this.opt;
    const tol = tolCm * this.pxPerCm, events = [];
    for (const limb of LIMBS) {
      const st = this.state[limb], pts = limbs[limb];
      if (!pts || !pts.length) {
        if (st.hold !== null && t - st.lastSeen > lostMs) { events.push({ t, limb, hold: st.hold, on: false }); st.hold = null; }
        st.awaySince = null;
        st.cand = null;
        continue;
      }
      let speed = 0;
      if (st.last && t > st.last.t) speed = (Math.hypot(pts[0].x - st.last.x, pts[0].y - st.last.y) / this.pxPerCm) / ((t - st.last.t) / 1000);
      st.last = { t, x: pts[0].x, y: pts[0].y };
      st.lastSeen = t;

      if (st.hold !== null) {
        if (this.distTo(st.hold, pts) <= tol * releaseK) { st.awaySince = null; continue; }
        if (st.awaySince === null) st.awaySince = t;
        if (t - st.awaySince >= offMs) { events.push({ t, limb, hold: st.hold, on: false }); st.hold = null; st.awaySince = null; }
        else continue;
      }
      // not holding anything: look for a candidate
      const n = this.nearest(pts);
      if (!n || n.dist > tol || speed > maxSpeedCmS) { st.cand = null; continue; }
      if (st.cand !== n.hold.id) { st.cand = n.hold.id; st.candSince = t; }
      if (t - st.candSince >= onMs) { st.hold = n.hold.id; st.cand = null; events.push({ t, limb, hold: st.hold, on: true }); }
    }
    return events;
  }
}
