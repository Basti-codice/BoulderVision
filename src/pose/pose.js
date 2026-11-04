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
  constructor() { this.lm = null; this.variant = null; this.delegate = null; this.crop = document.createElement('canvas'); this.cctx = this.crop.getContext('2d'); this.lastTs = 0; }

  async load(variant = 'full') {
    if (this.variant === variant && this.lm) return;
    const fileset = await FilesetResolver.forVisionTasks(`${BASE}mediapipe`);
    const make = (delegate) => PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: `${BASE}models/pose_${variant}.task`, delegate },
      runningMode: 'VIDEO', numPoses: 2,
      minPoseDetectionConfidence: 0.25, minPosePresenceConfidence: 0.25, minTrackingConfidence: 0.3, // low on purpose: climbers are often seen from behind
    });
    let lm, delegate = 'GPU';
    if (globalThis.__bvForceCpu) delegate = 'CPU'; // diagnostics / headless testing
    try { lm = await make(delegate); } catch (e) { console.warn('GPU delegate failed, using CPU', e); delegate = 'CPU'; lm = await make('CPU'); }
    this.lm?.close(); this.lm = lm; this.variant = variant; this.delegate = delegate; this.lastTs = 0;
  }

  /**
   * source: canvas with the full camera frame. roi: {x,y,w,h} in source px (crop around the wall so the model
   * sees the climber at higher resolution and ignores bystanders). Returns poses with landmarks in
   * NORMALISED FULL-FRAME coordinates: [{lm:[{x,y,v}x33]}].
   */
  detect(source, ts, roi) {
    const maxSide = 768, k = Math.min(1, maxSide / Math.max(roi.w, roi.h));
    const cw = Math.max(32, Math.round(roi.w * k)), ch = Math.max(32, Math.round(roi.h * k));
    if (this.crop.width !== cw || this.crop.height !== ch) { this.crop.width = cw; this.crop.height = ch; }
    this.cctx.drawImage(source, roi.x, roi.y, roi.w, roi.h, 0, 0, cw, ch);
    ts = Math.max(ts, this.lastTs + 1); this.lastTs = ts;
    const res = this.lm.detectForVideo(this.crop, ts);
    return (res.landmarks || []).map((pts) => ({
      lm: pts.map((p) => ({ x: (roi.x + p.x * roi.w) / source.width, y: (roi.y + p.y * roi.h) / source.height, v: Math.min(p.visibility ?? 1, p.presence ?? 1) })),
    }));
  }
  close() { this.lm?.close(); this.lm = null; this.variant = null; }
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
export function limbPoints(lm, W, H, { swap = false, minVis = 0.3 } = {}) {
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
