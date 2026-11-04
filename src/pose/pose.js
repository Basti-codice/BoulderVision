// Pose estimation (MediaPipe Pose Landmarker) + conversion of landmarks to limb contact points.
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';

const BASE = import.meta.env?.BASE_URL ?? '/';

export const LM = { LSH: 11, RSH: 12, LELB: 13, RELB: 14, LW: 15, RW: 16, LP: 17, RP: 18, LI: 19, RI: 20, LHIP: 23, RHIP: 24, LKNEE: 25, RKNEE: 26, LA: 27, RA: 28, LHEEL: 29, RHEEL: 30, LFI: 31, RFI: 32 };

export const SKELETON = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28],
  [27, 31], [28, 32], [27, 29], [28, 30], [15, 19], [15, 17], [16, 20], [16, 18],
];

export const VARIANTS = ['heavy', 'full', 'lite'];

export class PoseEngine {
  constructor() { this.lm = null; this.probe = null; this.variant = null; this.delegate = null; this.crop = document.createElement('canvas'); this.cctx = this.crop.getContext('2d'); this.lastTs = 0; this._fileset = null; }

  async _make(variant, delegate, mode) {
    this._fileset ??= await FilesetResolver.forVisionTasks(`${BASE}mediapipe`);
    return PoseLandmarker.createFromOptions(this._fileset, {
      baseOptions: { modelAssetPath: `${BASE}models/pose_${variant}.task`, delegate },
      runningMode: mode, numPoses: 2,
      minPoseDetectionConfidence: 0.25, minPosePresenceConfidence: 0.25, minTrackingConfidence: 0.3, // low on purpose: climbers are often seen from behind
    });
  }

  async load(variant = 'full') {
    if (this.variant === variant && this.lm) return;
    let lm, delegate = globalThis.__bvForceCpu ? 'CPU' : 'GPU'; // CPU override: diagnostics / headless testing
    try { lm = await this._make(variant, delegate, 'VIDEO'); } catch (e) { console.warn('GPU delegate failed, using CPU', e); delegate = 'CPU'; lm = await this._make(variant, 'CPU', 'VIDEO'); }
    this.lm?.close(); this.probe?.close(); this.probe = null;
    this.lm = lm; this.variant = variant; this.delegate = delegate; this.lastTs = 0;
  }

  /** Second landmarker in still-image mode: lets us try other crop rotations without disturbing the video tracker. */
  async ensureProbe() {
    if (this.probe || this._probing || !this.lm) return;
    this._probing = true;
    try { this.probe = await this._make(this.variant, this.delegate, 'IMAGE'); } catch (e) { console.warn('probe landmarker unavailable', e); } finally { this._probing = false; }
  }

  /**
   * source: canvas with the full camera frame. roi: {x,y,w,h} in source px (crop around the wall / the climber so the model
   * sees the person at higher resolution and ignores bystanders). rot: rotate the crop by 0/90/-90 degrees before
   * inference (bodies that hang horizontally confuse the model); landmarks are mapped back. useProbe: use the
   * still-image landmarker. Returns poses with landmarks in NORMALISED FULL-FRAME coordinates: [{lm:[{x,y,v}x33], rot}].
   */
  detect(source, ts, roi, rot = 0, useProbe = false) {
    const maxSide = 768, k = Math.min(1, maxSide / Math.max(roi.w, roi.h));
    const rw = Math.max(32, Math.round(roi.w * k)), rh = Math.max(32, Math.round(roi.h * k));
    const swap = Math.abs(rot) % 180 !== 0, cw = swap ? rh : rw, ch = swap ? rw : rh;
    if (this.crop.width !== cw || this.crop.height !== ch) { this.crop.width = cw; this.crop.height = ch; }
    const c = this.cctx, th = (rot * Math.PI) / 180, cos = Math.cos(th), sin = Math.sin(th);
    c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, cw, ch);
    c.translate(cw / 2, ch / 2); c.rotate(th);
    c.drawImage(source, roi.x, roi.y, roi.w, roi.h, -rw / 2, -rh / 2, rw, rh);
    c.setTransform(1, 0, 0, 1, 0, 0);
    let res;
    if (useProbe) { if (!this.probe) return []; res = this.probe.detect(this.crop); }
    else { ts = Math.max(ts, this.lastTs + 1); this.lastTs = ts; res = this.lm.detectForVideo(this.crop, ts); }
    return (res.landmarks || []).map((pts) => ({
      rot,
      lm: pts.map((p) => {
        const dx = p.x * cw - cw / 2, dy = p.y * ch - ch / 2;           // inverse of the crop rotation
        const px = (dx * cos + dy * sin + rw / 2) / rw, py = (-dx * sin + dy * cos + rh / 2) / rh;
        return { x: (roi.x + px * roi.w) / source.width, y: (roi.y + py * roi.h) / source.height, v: Math.min(p.visibility ?? 1, p.presence ?? 1) };
      }),
    }));
  }
  close() { this.lm?.close(); this.probe?.close(); this.lm = null; this.probe = null; this.variant = null; }
}

/** Mean visibility of hands and feet: how trustworthy the pose is for contact detection. */
export function limbQuality(lm) {
  const idx = [15, 16, 19, 20, 27, 28, 31, 32];
  return idx.reduce((s, i) => s + (lm[i]?.v ?? 0), 0) / idx.length;
}

/** Pick the climber: prefer the person nearest to the previous one, otherwise the tallest inside the wall. */
export function pickClimber(poses, wallQuadNorm, prev) {
  let best = null, bs = -Infinity;
  for (const p of poses) {
    const vis = p.lm.filter((q) => q.v > 0.3);
    if (vis.length < 8) continue;
    const xs = vis.map((q) => q.x), ys = vis.map((q) => q.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2, hgt = Math.max(...ys) - Math.min(...ys);
    let s = hgt + (insideQuad(wallQuadNorm, cx, cy) ? 1 : 0);
    if (prev) s -= Math.hypot(cx - prev.cx, cy - prev.cy) * 3;
    if (s > bs) { bs = s; best = { pose: p, cx, cy }; }
  }
  return best;
}
function insideQuad(q, x, y) {
  let c = false;
  for (let i = 0, j = 3; i < 4; j = i++) if ((q[i][1] > y) !== (q[j][1] > y) && x < ((q[j][0] - q[i][0]) * (y - q[i][1])) / (q[j][1] - q[i][1]) + q[i][0]) c = !c;
  return c;
}

const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/**
 * Landmarks (normalised frame coords) -> contact points per limb in FRAME PIXELS.
 * swap: exchange left/right (model labelled the climber mirrored). Each limb: array of {x,y} (primary first) or null.
 */
export function limbPoints(lm, W, H, { swap = false, minVis = 0.25 } = {}) {
  const g = (i) => { const p = lm[i]; return p && p.v >= minVis ? { x: p.x * W, y: p.y * H } : null; };
  const hand = (wr, pk, ix) => {
    const a = g(ix), b = g(pk), w = g(wr);
    if (a && b) return [mid(a, b), a];
    if (a) return [a];
    if (w) return [w];
    return null;
  };
  const foot = (toe, heel) => {
    const t = g(toe), hl = g(heel);
    if (t && hl) return [t, { x: hl.x + (t.x - hl.x) * 0.75, y: hl.y + (t.y - hl.y) * 0.75 }];
    if (t) return [t];
    return null;
  };
  const L = { hand: hand(LM.LW, LM.LP, LM.LI), foot: foot(LM.LFI, LM.LHEEL) };
  const R = { hand: hand(LM.RW, LM.RP, LM.RI), foot: foot(LM.RFI, LM.RHEEL) };
  return swap ? { LH: R.hand, RH: L.hand, LF: R.foot, RF: L.foot } : { LH: L.hand, RH: R.hand, LF: L.foot, RF: R.foot };
}

/** Decide whether the model's left/right labels are mirrored relative to the wanted convention. */
export class SideGuard {
  constructor() { this.swap = false; this.votes = 0; }
  /** facing: 'wall' (camera behind climber: anatomical left appears on image-left) or 'camera'. */
  update(lm, facing = 'wall') {
    const l = lm[LM.LSH], r = lm[LM.RSH];
    if (!l || !r || l.v < 0.4 || r.v < 0.4) return this.swap;
    const sep = r.x - l.x;
    if (Math.abs(sep) < 0.03) return this.swap; // torso turned sideways: ordering is meaningless
    const wantSwap = facing === 'wall' ? sep < 0 : sep > 0;
    this.votes = Math.max(-6, Math.min(6, this.votes + (wantSwap ? 1 : -1)));
    if (this.votes >= 4) this.swap = true; else if (this.votes <= -4) this.swap = false;
    return this.swap;
  }
}
