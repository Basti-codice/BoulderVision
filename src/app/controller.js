// Application controller: owns camera, geometry, hold data, board, live pipeline and outputs.
import { createStore } from '../store/store.js';
import { FrameSource } from '../core/camera.js';
import { Warper, warpCPU } from '../core/warp.js';
import { wallSize } from '../core/wall.js';
import { intersectionArea, resolveOverlaps, wallHomography, invert3, applyH, solveHomography, isValidQuad, pointInPolygon, polygonDistance, ellipsePolygon, polygonCentroid, polygonArea, orderCorners } from '../core/geometry.js';
import { OneEuro2D } from '../core/filters.js';
import { bindLeds } from '../core/binding.js';
import { ContactTracker, LIMBS } from '../core/contact.js';
import { numberHolds } from '../core/numbering.js';
import { analyzeWall, segmentHolds, filterHolds, fitHoldAt } from '../cv/holds.js';
import { scanLayout, spotImage, brightestSpot } from '../cv/calibrate.js';
import { holdRegions, regionMeans, decodeHolds, orphanSpots, estimateShift, pathCheck, planProbes, evaluateProbe, confirmPlan, evaluateConfirm, DEFAULT_RING_CM } from '../cv/ledmap.js';
import { AuroraBoard, BleTransport } from '../board/aurora.js';
import { PoseEngine, SKELETON, pickClimber, limbPoints, limbQuality, SideGuard, VARIANTS } from '../pose/pose.js';
import { Bus, WebSocketSink, SerialSink, KilterSink, SessionRecorder, download, downloadBlob } from '../outputs/sinks.js';
import { showFrame, ROLES } from '../outputs/lightshow.js';
import { debugLog } from '../core/debuglog.js';
import { createGame } from '../game/games.js';
import { rng } from '../core/rng.js';
import pkg from '../../package.json';
import { DemoWorld, DemoPose } from '../sim/demo.js';
import * as profiles from '../store/profiles.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clone = (o) => structuredClone(o);
const SETTINGS_KEY = 'bv.settings';
const MAX_SHOW_LEDS = 36;
const BEST_KEY = 'bv.game.best';
const MAX_PROBE_FRAMES = 40;       // per probing round: unusual boards must not turn the scan into an endless search
const GAME_UI_INTERVAL_MS = 200;   // HUD refresh rate
const GAME_LED_INTERVAL_MS = 120;  // minimum time between LED frames (Bluetooth is slow)

export const store = createStore({
  ready: false, profiles: [], profileId: null, profileName: 'My wall', saved: true,
  kilter: false, mode: 'setup', step: 'camera', demo: false,
  wall: { wm: 3.6, hm: 3.6 }, corners: null, fixedCamera: false,
  cam: { status: 'off', kind: 'none', label: '', width: 0, height: 0, fps: 0, devices: [], deviceId: '', res: 1080, rotation: 0, mirror: false, locked: false, lockMsg: '', error: '' },
  holds: [], tool: 'select', selected: null, numbering: 'rows', numberStart: 1, canUndo: false, canRedo: false,
  detect: { sensitivity: 0.5, contrast: 0.25, minDia: 0, maxDia: 30, showUncertain: false, effMin: 0, busy: false, hasAnalysis: false, message: '' },
  board: { state: 'idle', name: '', ledCount: 1024, leds: [], rejected: 0, testing: null, scan: { running: false, progress: 0, message: '', result: null, verify: null }, align: { running: false, message: '' } },
  live: { footUp: 0, handUp: 0, parallax: 0, running: false, loading: false, variant: 'auto', activeVariant: '', delegate: '', fps: 0, latency: 0, person: false, contacts: { LH: null, RH: null, LF: null, RF: null }, tolCm: 2.5, facing: 'wall', swapLR: false, lightBoard: false, error: '' },
  outputs: { ws: { url: 'ws://localhost:8765', state: 'off', detail: '' }, serial: { state: 'off', detail: '' } },
  session: { recording: false, events: 0, duration: 0, replayT: null, playing: false, summary: null },
  toast: null, ui: { labels: true, grid: true },
  game: { id: 'coins', active: false, state: null, best: { coins: 0, dodge: 0 } },
  kilterTab: 'test', show: { running: false, pattern: 'rainbow', speed: 1 }, routes: { items: [], active: null, brush: 'hand', sync: true },
});

class App {
  constructor() {
    this.source = new FrameSource();
    this.snapWarper = null;
    this.bus = new Bus();
    this.recorder = new SessionRecorder();
    this.analysis = null; this.seg = null; this.deleted = new Set(); this.sourceId = 0; this.snapKey = null; this._runId = 0; this.peopleSegs = [];
    this.snapshot = null; this.snapshotBitmap = null; this.snapshotBlob = null;
    this.holds = []; this.suppress = []; this.ignoredLeds = []; this.nextId = 1;
    this.history = []; this.future = []; this._liveToken = 0;
    this.board = null; this.kilterSink = null; this.world = null;
    this.engine = null; this.tracker = null; this.liveDraw = null; this.sideGuard = new SideGuard();
    this.filters = new Map(); this.prevPerson = null; this.poseBusy = false; this._lat = 0; this._poseFrames = 0; this._poseT = performance.now();
    this._saveTimer = null; this._detectTimer = null; this._H = null; this._Hkey = '';
    this.ws = new WebSocketSink((state, detail = '') => this.set({ outputs: { ...this.s.outputs, ws: { ...this.s.outputs.ws, state, detail } } }));
    this.serial = new SerialSink((state, detail = '') => this.set({ outputs: { ...this.s.outputs, serial: { state, detail } } }));
    this.bus.on((m) => { this.recorder.handle(m); this.ws.handle(m); this.serial.handle(m); this.kilterSink?.handle(m); });
    this.showLit = null; this.game = null; this._ledSig = null; this._ledNext = null; this._ledBusy = false; this._gameUi = 0; this._gameLed = 0;
    this.source.addEventListener('change', () => this._camChanged());
    this._lastUi = 0;
  }
  get s() { return store.get(); }
  set(p) { store.set(p); }
  /** Record an event for the debug report. */
  log(kind, data) { debugLog.info(kind, data); }
  toast(msg, kind = 'info') {
    if (kind === 'error') debugLog.error('toast', msg); const id = Math.random(); this.set({ toast: { msg, kind, id } }); setTimeout(() => { if (this.s.toast?.id === id) this.set({ toast: null }); }, kind === 'error' ? 7000 : 3500); }

  // ---------- lifecycle ----------
  async init() {
    const st = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    this.set({
      cam: { ...this.s.cam, res: st.res || 1080, deviceId: st.deviceId || '' },
      live: { ...this.s.live, tolCm: st.tolCm ?? 2.5, facing: st.facing || 'wall', variant: st.variant || 'auto', footUp: st.footUp ?? 0, handUp: st.handUp ?? 0, parallax: st.parallax ?? 0 },
      outputs: { ...this.s.outputs, ws: { ...this.s.outputs.ws, url: st.wsUrl || this.s.outputs.ws.url } },
    });
    try { this.set({ game: { ...this.s.game, best: { ...this.s.game.best, ...JSON.parse(localStorage.getItem(BEST_KEY) || '{}') } } }); } catch { /* ignore corrupt storage */ }
    try { this.set({ profiles: await profiles.listProfiles() }); } catch (e) { console.warn('profiles unavailable', e); }
    const last = localStorage.getItem('bv.lastProfile');
    if (last && this.s.profiles.some((p) => p.id === last)) await this.loadProfile(last); else await this.newProfile('My wall', false);
    this.set({ ready: true });
    this.refreshDevices();
    const loop = (now) => { this.frame(now); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }
  saveSettings() {
    const { cam, live, outputs } = this.s;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ res: cam.res, deviceId: cam.deviceId, tolCm: live.tolCm, facing: live.facing, variant: live.variant, footUp: live.footUp, handUp: live.handUp, parallax: live.parallax, wsUrl: outputs.ws.url }));
  }

  // ---------- main loop ----------
  frame(now) {
    const fresh = this.source.tick(now);
    if (this.s.show.running) this._showTick(now);
    if (this.game) this._gameTick(now);
    if (fresh && this.s.mode === 'live' && this.s.live.running && this.engine && !this.poseBusy) this._liveStep(now);
  }

  // ---------- geometry ----------
  get wallDims() { const { wm, hm } = this.s.wall; return wallSize(wm, hm); }
  get Himg2wall() {
    const c = this.s.corners;
    if (!c || !isValidQuad(c)) return null;
    const { RW, RH } = this.wallDims, key = JSON.stringify([c, RW, RH]);
    if (key !== this._Hkey) { this._H = wallHomography(c, RW, RH); this._Hkey = key; }
    return this._H;
  }
  /** Identifies the picture + geometry an analysis/snapshot belongs to. */
  _geoKey() {
    const c = this.s.corners ? this.s.corners.map((p) => `${Math.round(p[0])},${Math.round(p[1])}`).join(';') : '';
    const { RW, RH } = this.wallDims;
    return `${this.sourceId}|${c}|${RW}x${RH}|${this.s.cam.rotation}${this.s.cam.mirror ? 'm' : ''}`;
  }
  /** The stored snapshot may only be shown/exported while it matches the current picture. */
  get snapshotValid() { return !!this.snapshotBitmap && (this.snapKey === '*profile' ? !this.source.active : this.snapKey === this._geoKey()); }
  /**
   * Drops everything that was computed from a particular picture (analysis, candidates, snapshot, people mask, deletions).
   * Holds themselves live in wall coordinates and stay.
   */
  _invalidateAnalysis() {
    this._runId++;
    clearTimeout(this._detectTimer); clearTimeout(this._commitTimer);
    this.analysis = null; this.seg = null; this.deleted = new Set(); this.peopleSegs = [];
    this.snapshot = null; this.snapshotBitmap = null; this.snapshotBlob = null; this.snapKey = null;
    if (this.s.detect.hasAnalysis) this.set({ detect: { ...this.s.detect, hasAnalysis: false, busy: false } });
  }
  imgToWall(x, y) { const H = this.Himg2wall; return H ? applyH(H, x, y) : [x, y]; }
  defaultCorners() { const w = this.source.width, h = this.source.height; return [[w * 0.2, h * 0.12], [w * 0.8, h * 0.12], [w * 0.8, h * 0.9], [w * 0.2, h * 0.9]]; }
  setCorners(c, { save = true } = {}) {
    const old = this.s.corners, moved = !old || c.some((p, i) => Math.abs(p[0] - old[i][0]) + Math.abs(p[1] - old[i][1]) > 0.5);
    this.set({ corners: c });
    if (moved && this.analysis) this._invalidateAnalysis(); // the rectification changed: the old analysis no longer fits
    if (save) this.saveSoon();
  }
  setWall(patch) {
    const wall = { ...this.s.wall, ...patch };
    if (!(wall.wm >= 0.5 && wall.wm <= 20 && wall.hm >= 0.5 && wall.hm <= 20)) return;
    const old = this.wallDims;
    this.set({ wall });
    const now = this.wallDims;
    if (now.RW !== old.RW || now.RH !== old.RH) { // rescale holds and LED positions to the new pixel frame, drop the analysis
      const sx = now.RW / old.RW, sy = now.RH / old.RH;
      for (const h of this.holds) { h.poly = h.poly.map(([x, y]) => [x * sx, y * sy]); h.cx *= sx; h.cy *= sy; h.area *= sx * sy; h.diaCm = (2 * Math.sqrt(h.area / Math.PI)) / now.pxPerCm; }
      this.set({ holds: this.holds, board: { ...this.s.board, leds: this.s.board.leds.map((l) => ({ ...l, x: l.x * sx, y: l.y * sy })) } });
      this._invalidateAnalysis();
    }
    this.saveSoon();
  }

  // ---------- camera ----------
  _camChanged() {
    const s = this.source;
    this.set({ cam: { ...this.s.cam, status: s.kind === 'none' ? 'off' : 'on', kind: s.kind, label: s.label, width: s.active ? s.width : 0, height: s.active ? s.height : 0, fps: s.fps } });
  }
  async refreshDevices() { try { const devices = await this.source.listDevices(); this.set({ cam: { ...this.s.cam, devices } }); } catch { /* ignore */ } }
  async _startSource(fn, label) {
    this.set({ cam: { ...this.s.cam, status: 'starting', error: '' } });
    try { await fn(); await this._afterSource(); }
    catch (e) { this.set({ cam: { ...this.s.cam, status: 'error', error: e.message || String(e) } }); this.toast(`${label}: ${e.message || e}`, 'error'); }
  }
  async _afterSource() {
    this.sourceId++;
    this._invalidateAnalysis();
    // Holds and corners belong to the picture they were made for. A different photo or video file is a new setup,
    // unless the camera is on a fixed mount: then the geometry is the same and both are kept.
    const picture = ['image', 'video'].includes(this.source.kind), fresh = picture && !this.s.fixedCamera;
    if (fresh && this.holds.some((h) => !h.ghost)) { this.clearHolds(); this.toast('New picture: holds cleared. Ctrl+Z brings them back.'); }
    this.source.setOrientation({ rotation: this.s.cam.rotation, mirror: this.s.cam.mirror });
    for (let i = 0; i < 40 && !this.source.tick(performance.now()); i++) await sleep(50);
    this._camChanged();
    // corners belong to a camera view: keep them for the same resolution, scale them for the same aspect, else start over
    const dims = [this.source.width, this.source.height], prev = this._srcDims;
    if (dims[0]) {
      if (!this.s.corners || fresh) this.setCorners(this.defaultCorners(), { save: false });
      else if (prev && (prev[0] !== dims[0] || prev[1] !== dims[1])) {
        const sameAspect = Math.abs(prev[0] / prev[1] - dims[0] / dims[1]) < 0.02;
        this.setCorners(sameAspect ? this.s.corners.map(([x, y]) => [x * dims[0] / prev[0], y * dims[1] / prev[1]]) : this.defaultCorners(), { save: false });
      }
      this._srcDims = dims;
    }
    this.refreshDevices();
  }
  useCamera(deviceId) {
    this.set({ cam: { ...this.s.cam, deviceId: deviceId ?? this.s.cam.deviceId } }); this.saveSettings();
    return this._startSource(() => this.source.useCamera(this.s.cam.deviceId, this.s.cam.res), 'Camera');
  }
  useFile(file) { return this._startSource(() => this.source.useFile(file), 'File'); }
  setRes(res) { this.set({ cam: { ...this.s.cam, res } }); this.saveSettings(); if (this.s.cam.kind === 'camera') this.useCamera(); }
  setOrientation(o) {
    const cam = { ...this.s.cam, ...o };
    let corners = this.s.corners;
    if (corners && this.source.width) {
      // display = mirror(rotate(source)). Undo the old mirror, rotate by the delta, apply the new mirror.
      let W0 = this.source.width, H0 = this.source.height;
      if (this.s.cam.mirror) corners = corners.map(([x, y]) => [W0 - x, y]);
      const steps = ((((cam.rotation - this.s.cam.rotation) % 360) + 360) % 360) / 90;
      for (let i = 0; i < steps; i++) { corners = corners.map(([x, y]) => [H0 - y, x]); [W0, H0] = [H0, W0]; }
      if (cam.mirror) corners = corners.map(([x, y]) => [W0 - x, y]);
      corners = orderCorners(corners);
    }
    this.set({ cam, corners }); this.source.setOrientation({ rotation: cam.rotation, mirror: cam.mirror });
    this._invalidateAnalysis();
    this.saveSoon();
  }
  async lockCamera(on) {
    const r = await this.source.lock(on);
    this.set({ cam: { ...this.s.cam, locked: r.ok ? on : false, lockMsg: r.ok ? (on ? `Locked: ${r.applied.join(', ')}` : 'Auto mode restored') : r.reason } });
    return r;
  }


  // ---------- demo ----------
  async startDemo() {
    this.world = new DemoWorld();
    this.source.useDemo(this.world);
    this.set({ demo: true, kilter: true, wall: { wm: 3.6, hm: 3.6 } });
    await this._afterSource();
    // start with a slightly wrong marking so the alignment step has something to do
    const jit = [[10, 6], [-8, 9], [7, -9], [-9, -6]];
    this.setCorners(this.world.corners.map(([x, y], i) => [x + jit[i][0], y + jit[i][1]]), { save: false });
    this.board = new AuroraBoard(this.world.transport); this.board.delay = 0; this._wireBoard();
    this.holds = []; this.suppress = []; this.ignoredLeds = []; this.history = []; this.future = [];
    this.set({ holds: [], board: { ...this.s.board, leds: [], scan: { ...this.s.board.scan, result: null, verify: null } }, step: 'align', canUndo: false, canRedo: false });
    this.history.push(this._snap());
    try { await this.board.connect(); } catch (e) { this.toast(e.message, 'error'); }
  }

  // ---------- snapshot / rectification ----------
  _rectifyOnce() {
    const H = this.Himg2wall, wall = this.wallDims, src = this.source;
    if (!H) throw new Error('Mark the four wall corners first.');
    if (!this.snapWarper) { const c = document.createElement('canvas'); try { this.snapWarper = new Warper(c); } catch { this.snapWarper = { ok: false }; } }
    if (this.snapWarper.ok) return this.snapWarper.snapshot(src.canvas, src.width, src.height, H, wall);
    return warpCPU(src.ctx.getImageData(0, 0, src.width, src.height), H, wall.RW, wall.RH);
  }
  async _waitFrames(n) {
    if (this.source.kind === 'image') return;
    const target = this.source.frameId + n;
    for (let i = 0; i < 400 && this.source.frameId < target; i++) await new Promise((r) => requestAnimationFrame(r));
  }
  /** Average of n fresh rectified frames (reduces sensor noise). */
  async captureWall(n = 4) {
    const { RW, RH } = this.wallDims, acc = new Uint16Array(RW * RH * 4);
    n = this.source.kind === 'image' ? 1 : n;
    for (let k = 0; k < n; k++) { await this._waitFrames(2); const f = this._rectifyOnce(); for (let i = 0; i < acc.length; i++) acc[i] += f.data[i]; }
    const out = new Uint8ClampedArray(RW * RH * 4);
    for (let i = 0; i < out.length; i++) out[i] = acc[i] / n;
    return { data: out, width: RW, height: RH };
  }
  async _storeSnapshot(img) {
    this.snapshot = img;
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    c.getContext('2d').putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
    this.snapshotBitmap = c;
    this.snapshotBlob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
  }

  // ---------- holds: detection ----------
  get pxPerCm() { return this.wallDims.pxPerCm; }
  /**
   * Fresh detection run on the current picture. Deletions and the old analysis are discarded; holds the user edited or
   * added survive (a new picture has already cleared them in _afterSource, unless the mount is fixed).
   */
  async runDetect() {
    if (this.s.detect.busy) return;
    this._invalidateAnalysis();
    const run = this._runId;
    const alive = () => run === this._runId;
    this.set({ detect: { ...this.s.detect, busy: true, hasAnalysis: false, message: 'Capturing wall…' } });
    try {
      for (const h of this.holds) delete h.cand; // candidate numbers belong to one analysis only
      if (this.board?.connected && this.board.lit.size) await this.board.allOff();
      const t0 = performance.now();
      const img = await this.captureWall(4);
      if (!alive()) return;
      const tCapture = performance.now() - t0;
      this.set({ detect: { ...this.s.detect, message: 'Detecting holds…' } });
      await sleep(30);
      await this._storeSnapshot(img);
      const t1 = performance.now();
      this.analysis = analyzeWall(img);
      const t2 = performance.now();
      this.seg = segmentHolds(this.analysis, this.pxPerCm);
      this.timings = { captureMs: Math.round(tCapture), analyzeMs: Math.round(t2 - t1), segmentMs: Math.round(performance.now() - t2) };
      this.snapKey = this._geoKey();
      this.set({ detect: { ...this.s.detect, message: 'Checking for people in view…' } });
      const people = await this._findPeople();
      if (!alive()) return;
      this.history = []; this.future = [];
      this.set({ detect: { ...this.s.detect, hasAnalysis: true, effMin: +this.seg.minDiaEff.toFixed(1) } });
      this._applyDetection(true);
      this.commit();
      const n = this.holds.filter((h) => !h.ghost).length;
      this.log('detect', { holds: n, candidates: this.seg.candidates.length, otsu: this.seg.otsu, medianDiaCm: +this.seg.medianDia.toFixed(1), people, ...this.timings, params: { sensitivity: this.s.detect.sensitivity, contrast: this.s.detect.contrast } });
      this.set({ detect: { ...this.s.detect, busy: false, message: n ? `${n} holds found${people ? ` (ignored ${people} ${people > 1 ? 'people' : 'person'} in view)` : ''}` : 'No holds found. Check the corners and the wall size.' } });
    } catch (e) {
      this.set({ detect: { ...this.s.detect, busy: false, message: e.message } }); this.toast(e.message, 'error');
    }
  }
  /** Overlap of a polygon with an existing hold, relative to the smaller one (0..1). */
  _overlap(poly, area, h) { if (!h.poly) return 0; const inter = intersectionArea(h.poly, poly); return inter / Math.max(1, Math.min(area, h.area || Infinity)); }
  /**
   * Apply the slider values to the stored candidates (instant, never re-segments). Edited/added holds are kept;
   * auto holds keep their id when they stay; holds the user deleted stay deleted until the next Detect.
   */
  _applyDetection(fromRun = false) {
    if (!this.seg || (this.s.detect.busy && !fromRun)) return false; // sliders wait while a detection run is in progress
    const d = this.s.detect, px = this.pxPerCm;
    const cands = filterHolds(this.seg, { sensitivity: d.sensitivity, contrast: d.contrast, minDiaCm: d.minDia, maxDiaCm: d.maxDia, ...(d.showUncertain ? { minConfidence: 0 } : {}) });
    const keep = this.holds.filter((h) => h.source === 'manual');
    const prevId = new Map(this.holds.filter((h) => h.source === 'auto' && h.cand != null).map((h) => [h.cand, h.id]));
    const taken = new Set(keep.map((h) => h.cand).filter((v) => v != null));
    const out = keep.slice();
    for (const c of cands) {
      if (this.deleted.has(c.idx) || taken.has(c.idx)) continue;
      if (keep.some((k) => this._overlap(c.poly, c.area, k) > 0.25)) continue; // already covered by an edited / added hold
      if (this._inPeople(c.cx, c.cy, px)) continue;                            // a person stood there while the wall was captured
      const { idx, ...rest } = c;
      out.push({ ...rest, poly: c.poly.map((p) => [p[0], p[1]]), id: prevId.get(idx) ?? this.nextId++, cand: idx, source: 'auto' });
    }
    resolveOverlaps(out.filter((h) => h.source === 'auto')); // touching holds: cut along the line between them
    this.holds = out;
    this._rebind(); this._renumber();
    this.saveSoon();
    return true;
  }
  _inPeople(x, y, px) {
    const r = 11 * px;
    for (const [ax, ay, bx, by] of this.peopleSegs || []) {
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy, t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
      if (Math.hypot(x - (ax + t * dx), y - (ay + t * dy)) < r) return true;
    }
    return false;
  }
  /** Finds people in the captured frame (skeleton segments in wall px) so they are not mistaken for holds. Best effort. */
  async _findPeople() {
    this.peopleSegs = [];
    if (this.s.demo || !this.source.active || this.source.kind === 'none') return 0;
    try {
      if (!this.engine || this.engine instanceof DemoPose) this.engine = new PoseEngine();
      await this.engine.load(this.engine.variant || 'full');
      await this.engine.ensureProbe(); for (let i = 0; i < 40 && !this.engine.probe; i++) await sleep(100);
      if (!this.engine.probe) return 0;
      const { width: W, height: H } = this.source, c = this.s.corners, xs = c.map((p) => p[0]), ys = c.map((p) => p[1]);
      const roi = { x: Math.max(0, Math.min(...xs) - 20), y: Math.max(0, Math.min(...ys) - 20), w: 0, h: 0 };
      roi.w = Math.min(W, Math.max(...xs) + 20) - roi.x; roi.h = Math.min(H, Math.max(...ys) + 20) - roi.y;
      let best = [], bq = -1;
      for (const rot of [0, 90, -90]) { // keep the rotation that sees the most body
        const found = this.engine.detect(this.source.canvas, performance.now(), roi, rot, true).filter((p) => p.lm.filter((q) => q.v > 0.4).length >= 16); // real bodies only, not ghost detections
        const q = found.reduce((s, p) => s + p.lm.filter((l) => l.v > 0.4).length, 0);
        if (q > bq) { bq = q; best = found; }
      }
      const cen = (p) => { const v = p.lm.filter((q) => q.v > 0.4); return [v.reduce((s, q) => s + q.x, 0) / v.length, v.reduce((s, q) => s + q.y, 0) / v.length]; };
      best = best.filter((p, i) => best.findIndex((o) => Math.hypot(cen(o)[0] - cen(p)[0], cen(o)[1] - cen(p)[1]) < 0.12) === i); // same person detected twice
      for (const p of best) {
        const P = p.lm.map((l) => (l.v > 0.2 ? this.imgToWall(l.x * W, l.y * H) : null));
        for (const [a, b] of SKELETON) if (P[a] && P[b]) this.peopleSegs.push([...P[a], ...P[b]]);
        if (P[0]) this.peopleSegs.push([...P[0], ...P[0]]);
      }
      return best.length;
    } catch (e) { console.warn('people mask unavailable', e); return 0; }
  }
  /** Slider moved: apply instantly to the stored candidates; one undo entry per gesture. */
  setDetectParam(patch) {
    this.set({ detect: { ...this.s.detect, ...patch } });
    if (!this.seg) return;
    clearTimeout(this._detectTimer); clearTimeout(this._commitTimer);
    this._detectTimer = setTimeout(() => { if (this._applyDetection()) this._commitTimer = setTimeout(() => this.commit(), 450); }, 90);
  }

  // ---------- holds: editing ----------
  _renumber() {
    const mode = this.s.numbering === 'led' && !this.s.board.leds.length ? 'rows' : this.s.numbering;
    this.holds = numberHolds(this.holds, mode, this.s.numberStart);
    this.set({ holds: this.holds });
  }
  setUi(p) { this.set({ ui: { ...this.s.ui, ...p } }); }
  setNumberStart(n) { this.set({ numberStart: n ? 1 : 0 }); this._renumber(); this.saveSoon(); }
  setNumbering(mode) { this.set({ numbering: mode }); this._renumber(); this.saveSoon(); }
  _snap() { const { sensitivity, contrast, minDia, maxDia, showUncertain } = this.s.detect; return { holds: clone(this.holds), ignoredLeds: [...this.ignoredLeds], nextId: this.nextId, leds: clone(this.s.board.leds), deleted: [...this.deleted], detect: { sensitivity, contrast, minDia, maxDia, showUncertain } }; }
  _restore(s) {
    this.holds = clone(s.holds); this.ignoredLeds = [...s.ignoredLeds]; this.nextId = s.nextId; this.deleted = new Set(s.deleted || []);
    if (s.detect) this.set({ detect: { ...this.s.detect, ...s.detect } });
    this.set({ board: { ...this.s.board, leds: clone(s.leds || []) } }); this.board?.setKnownPositions((s.leds || []).map((l) => l.pos));
    this._renumber();
  }
  /** Call after a finished edit (not during drags). */
  commit() {
    this.history.push(this._snap()); if (this.history.length > 100) this.history.shift();
    this.future = [];
    this.set({ canUndo: this.history.length > 1, canRedo: false }); this.saveSoon();
  }
  undo() { if (this.history.length < 2) return; this.future.push(this.history.pop()); this._restore(this.history.at(-1)); this.set({ canUndo: this.history.length > 1, canRedo: true, selected: null }); this.saveSoon(); }
  redo() { const s = this.future.pop(); if (!s) return; this.history.push(s); this._restore(s); this.set({ canUndo: true, canRedo: this.future.length > 0, selected: null }); this.saveSoon(); }
  setTool(tool) { this.set({ tool, selected: tool === 'select' ? this.s.selected : null }); }
  select(id) { this.set({ selected: id }); }
  hitTest(x, y) {
    const tol = 0.8 * this.pxPerCm;
    let best = null, ba = Infinity;
    for (const h of this.holds) {
      if (polygonDistance(h.poly, x, y) <= (pointInPolygon(h.poly, x, y) ? 0 : tol)) { const a = polygonArea(h.poly); if (a < ba) { ba = a; best = h; } }
    }
    return best;
  }
  /** True when a polygon covers a clear part (>20 %) of an existing real hold. */
  _coversHold(poly, area) { return this.holds.some((h) => !h.ghost && this._overlap(poly, area, h) > 0.2); }
  addAt(x, y) {
    let f = this.analysis ? fitHoldAt(this.analysis, x, y, this.pxPerCm) : null;
    let note = '';
    if (!f) { const r = 2.5 * this.pxPerCm; f = { cx: x, cy: y, poly: ellipsePolygon(x, y, r, r, 8), area: Math.PI * r * r, solidity: 1, diaCm: 5 }; note = 'No clear hold edge found: placed a default shape. Drag its corners to fit.'; }
    if (this.holds.some((h) => !h.ghost && pointInPolygon(h.poly, f.cx, f.cy)) || this._coversHold(f.poly, f.area)) { this.toast('There is already a hold here.'); return null; }
    const h = { id: this.nextId++, ...f, source: 'manual' };
    this.holds.push(h); this._rebind(); this._renumber(); this.commit();
    this.set({ selected: h.id });
    if (note) this.toast(note);
    return h;
  }
  /** Search an area more eagerly: take every stored candidate in it that is not covered yet. */
  addInRegion(r) {
    if (!this.seg) { this.toast('Run hold detection first.'); return 0; }
    const d = this.s.detect;
    const found = filterHolds(this.seg, { sensitivity: 1.4, contrast: 0, minConfidence: 0, minDiaCm: Math.max(1.5, (d.minDia || this.seg.minDiaEff) * 0.7), maxDiaCm: d.maxDia, region: r });
    let n = 0;
    for (const c of found) {
      if (this._coversHold(c.poly, c.area)) continue;
      const { idx, ...rest } = c;
      this.deleted.delete(idx);
      this.holds.push({ ...rest, poly: c.poly.map((p) => [p[0], p[1]]), id: this.nextId++, cand: idx, source: 'manual' }); n++;
    }
    if (n) { this._rebind(); this._renumber(); this.commit(); this.toast(`Added ${n} hold${n > 1 ? 's' : ''}.`); } else this.toast('Nothing new found in that area. Click a hold to add it directly.');
    return n;
  }
  removeIds(ids) {
    const set = new Set(ids);
    for (const h of this.holds) {
      if (!set.has(h.id)) continue;
      if (h.ghost && h.led != null) this.ignoredLeds.push(h.led);
      else if (h.cand != null) this.deleted.add(h.cand); // stays deleted while the sliders move; a new Detect starts fresh
    }
    this.holds = this.holds.filter((h) => !set.has(h.id));
    this._rebind(); this._renumber(); this.commit();
    if (set.has(this.s.selected)) this.set({ selected: null });
  }
  removeInRegion(r) { const ids = this.holds.filter((h) => h.cx >= r.x0 && h.cx <= r.x1 && h.cy >= r.y0 && h.cy <= r.y1).map((h) => h.id); if (ids.length) { this.removeIds(ids); this.toast(`Removed ${ids.length}.`); } }
  /** Live edit (drag). Call commit() when the drag ends. */
  editHold(id, fn) {
    const h = this.holds.find((x) => x.id === id);
    if (!h) return;
    fn(h);
    const [cx, cy] = polygonCentroid(h.poly); h.cx = cx; h.cy = cy; h.area = polygonArea(h.poly); h.source = 'manual'; h.ghost = false;
  }
  scaleHold(id, k) {
    this.editHold(id, (h) => { const { cx, cy } = h; h.poly = h.poly.map(([x, y]) => [cx + (x - cx) * k, cy + (y - cy) * k]); });
    this.commit(); this._renumber();
  }
  setHoldGhost(id, ghost) { const h = this.holds.find((x) => x.id === id); if (h) { h.ghost = ghost; if (!ghost) h.source = 'manual'; this._renumber(); this.commit(); } }
  /** Remove every hold. Candidates stay deleted until the next Detect, so the sliders cannot bring them back. */
  clearHolds() {
    this.holds = []; this.ignoredLeds = [];
    if (this.seg) this.deleted = new Set(this.seg.candidates.map((c) => c.idx));
    this.set({ selected: null }); this._renumber(); this.commit();
  }
  /** Drop manual edits and deletions and show the automatic result of the current sliders again. */
  resetToAuto() {
    if (!this.seg) { this.toast('Run hold detection first.'); return; }
    this.holds = this.holds.filter((h) => h.source !== 'manual'); this.deleted = new Set(); this.ignoredLeds = [];
    this.set({ selected: null }); this._applyDetection(); this.commit();
  }
  setFixedCamera(on) { this.set({ fixedCamera: !!on }); this.saveSoon(); }
  endEdit() { this._rebind(); this._renumber(); this.commit(); }

  // ---------- board ----------
  _wireBoard() {
    this.board.addEventListener('status', (e) => {
      this.log('board', { state: e.detail.state, name: e.detail.name, detail: e.detail.detail });
      this.set({ board: { ...this.s.board, state: e.detail.state, name: e.detail.name } });
      if (e.detail.state === 'disconnected' && this.s.mode === 'live' && this.s.live.running && !this._reconnecting && !this._manualDisc) this._autoReconnect();
    });
    this.kilterSink = new KilterSink(this.board, (e) => this.toast(`Board: ${e.message}`, 'error'));
    this.kilterSink.enabled = this.s.live.lightBoard;
    this.board.setKnownPositions(this.s.board.leds.map((l) => l.pos));
  }
  async connectBoard() {
    this._manualDisc = false;
    if (!this.board || this.s.demo) { this.board = new AuroraBoard(new BleTransport()); this._wireBoard(); }
    try { await this.board.connect(); this.toast(`Connected to ${this.board.t.name}`, 'ok'); }
    catch (e) {
      const msg = e?.message || String(e);
      if (e?.name === 'NotFoundError' && /cancel/i.test(msg)) return; // the user closed the picker
      // Chrome also reports "picker not shown" (adapter off, permission blocked) as NotFoundError: say so instead of failing silently
      this.toast(e?.name === 'NotFoundError' ? `${msg} Check that Bluetooth is on and that Bluetooth is not blocked for this site (lock icon in the address bar, Site settings).` : msg, 'error');
    }
  }
  async disconnectBoard() { this._manualDisc = true; try { await this.board?.disconnect(); } catch (e) { this.toast(e.message, 'error'); } }
  async _autoReconnect() {
    this._reconnecting = true;
    for (let i = 0; i < 6 && this.s.live.running; i++) { await sleep(1500 * (i + 1)); try { await this.board.reconnect(); this._reconnecting = false; this.toast('Board reconnected.', 'ok'); return; } catch { /* retry */ } }
    this._reconnecting = false; this.toast('Board connection lost. Reconnect it in the Board step.', 'error');
  }
  setLedCount(n) { this.set({ board: { ...this.s.board, ledCount: Math.max(16, Math.min(4096, n | 0)) } }); this.saveSoon(); }

  async _captureSignal(dark, n = 3) {
    const f = await this.captureWall(n), N = f.width * f.height, sig = new Uint8Array(N), hist = new Uint32Array(256), d = new Int16Array(N);
    for (let i = 0, p = 0; i < N; i++, p += 4) { const v = ((f.data[p] - dark.data[p]) + (f.data[p + 1] - dark.data[p + 1]) + (f.data[p + 2] - dark.data[p + 2])) / 3; d[i] = v; hist[Math.max(0, Math.min(255, (v | 0) + 128))]++; }
    let acc = 0, med = 128; for (let k = 0; k < 256; k++) { acc += hist[k]; if (acc >= N / 2) { med = k - 128; break; } }
    for (let i = 0; i < N; i++) sig[i] = Math.max(0, Math.min(255, d[i] - med));
    return sig;
  }

  /** Only one board job (scan / auto-align) at a time; the camera lock taken for it is released afterwards. */
  async _exclusive(fn) {
    if (this._busyBoard || this.s.board.scan.running || this.s.board.align.running) { this.toast('Another board operation is still running.'); return; }
    this._busyBoard = true;
    const wasLocked = this.s.cam.locked;
    try { await fn(); } finally { this._busyBoard = false; if (!wasLocked && this.s.cam.locked) await this.lockCamera(false); }
  }
  scanLeds() { return this._exclusive(() => this._scanLeds()); }
  autoAlign() { return this._exclusive(() => this._autoAlign()); }

  /**
   * Find which LED belongs to which hold. The light is a ring around the whole hold, so brightness is measured per hold
   * (cv/ledmap.js). Phases: sparse row/column patterns (never more than ~sqrt(N) LEDs on at once) -> decode per hold
   * -> targeted probing of holds/positions that stayed open -> every mapped LED is confirmed individually.
   */
  async _scanLeds() {
    const sc = (p) => this.set({ board: { ...this.s.board, scan: { ...this.s.board.scan, ...p } } });
    if (!this.board?.connected) { this.toast('Connect the board first.', 'error'); return; }
    if (!this.Himg2wall) { this.toast('Mark the wall corners first.', 'error'); return; }
    const holds = this.holds.filter((h) => !h.ghost);
    if (holds.length < 8) { this.toast('Detect the holds first (Holds step): the LED scan assigns LEDs to detected holds.', 'error'); return; }
    this._abortScan = false;
    const N = this.s.board.ledCount, layout = scanLayout(N), F = layout.frames.length, GREEN = { r: 0, g: 255, b: 0 };
    const { RW, RH, pxPerCm } = this.wallDims;
    let done = 0, total = F + 6;                                   // refined once the later phases are planned
    const step = async (msg) => { if (this._abortScan) throw new Error('Scan cancelled'); sc({ running: true, progress: Math.min(0.98, done / total), message: msg }); };
    const capture = async (positions) => {                         // light these LEDs, wait, take the signal
      await this.board.setLeds(positions.map((pos) => ({ pos, ...GREEN }))); await sleep(380);
      return this._captureSignal(dark, 2);
    };
    let dark = null;
    sc({ running: true, progress: 0, message: 'Preparing…', result: null, verify: null });
    this.log('scan', { start: true, range: N, patterns: F, holds: holds.length });
    try {
      if (this.s.cam.kind === 'camera') await this.lockCamera(true);
      await step('Lights off, taking reference…');
      await this.board.allOff(); await sleep(500);
      dark = await this.captureWall(4);
      done++;

      // 1. sparse patterns
      const signals = [];
      for (let k = 0; k < F; k++) {
        const f = layout.frames[k];
        await step(`Pattern ${k + 1} of ${F} (${f.positions.length} LEDs on)…`);
        signals.push(await capture(f.positions)); done++;
      }
      await this.board.allOff();

      // 2. decode per hold (after correcting a camera shift since the holds were detected)
      await step('Decoding…');
      const shift = estimateShift(holds, spotImage(layout, signals), RW, RH, { pxPerCm });
      if (shift.dx || shift.dy) {
        for (const h of this.holds) { h.poly = h.poly.map(([x, y]) => [x + shift.dx, y + shift.dy]); h.cx += shift.dx; h.cy += shift.dy; }
        this.log('scan', { shiftedHoldsPx: [shift.dx, shift.dy], gain: shift.gain });
      }
      const labels = holdRegions(holds, RW, RH, Math.round(DEFAULT_RING_CM * pxPerCm));
      const means = (sig) => regionMeans(labels, holds.length, sig);
      const dec = decodeHolds(signals.map(means), layout);
      const assigned = new Map(), conf = new Map();                   // holdIndex -> pos / confidence
      dec.holds.forEach((d, k) => { if (d.pos !== null) { assigned.set(k, d.pos); conf.set(k, d.conf); } });
      const orphans = orphanSpots(labels, signals, layout, RW, RH, pxPerCm, { decoded: dec.holds });
      for (const o of orphans) if (o.supersedes != null) { assigned.delete(o.supersedes); conf.delete(o.supersedes); } // that hold only caught a neighbour's glow
      const suspects = pathCheck(assigned, holds);
      for (const x of suspects) { assigned.delete(x.holdIndex); conf.delete(x.holdIndex); }   // implausible neighbours: re-tested below
      const afterScan = assigned.size;
      this.log('scan', { decoded: afterScan, ofHolds: holds.length, orphans: orphans.length, suspects: suspects.length, noiseFloor: +dec.noiseFloor.toFixed(1), reasons: dec.holds.reduce((m, d) => { for (const r of d.reasons || []) m[r] = (m[r] || 0) + 1; return m; }, {}) });

      // 3. targeted probing of holds without an LED and positions without a hold (up to two rounds)
      let probed = 0;
      for (let round = 0; round < 2; round++) {
        const used = new Set([...assigned.values(), ...orphans.map((o) => o.pos)]);
        const missing = []; for (let p = 0; p < N; p++) if (!used.has(p)) missing.push(p);
        const open = holds.map((_, k) => k).filter((k) => !assigned.has(k));
        const planned = planProbes(assigned, open, missing, holds, { pxPerCm });
        const probes = planned.slice(0, MAX_PROBE_FRAMES);
        if (planned.length > probes.length) this.log('scan', { probeFramesTruncated: planned.length, kept: probes.length });
        if (!probes.length) break;
        total = done + probes.length + 24;
        let gained = 0;
        for (let i = 0; i < probes.length; i++) {
          await step(`Checking open holds, frame ${i + 1} of ${probes.length}…`);
          const sig = await capture(probes[i].leds); done++;
          for (const r of evaluateProbe(means(sig), probes[i])) {
            if (r.holdIndex === null || assigned.has(r.holdIndex) || [...assigned.values()].includes(r.pos)) continue;
            assigned.set(r.holdIndex, r.pos); conf.set(r.holdIndex, r.conf); gained++;
          }
        }
        probed += gained;
        if (!gained) break;
      }
      await this.board.allOff();

      // 4. confirm every mapped LED on its own (one hold on, all others off)
      const plan = confirmPlan(assigned, holds, { pxPerCm });
      total = done + plan.length + 2;
      const cm = [];
      for (let i = 0; i < plan.length; i++) {
        await step(`Confirming, frame ${i + 1} of ${plan.length}…`);
        cm.push(means(await capture(plan[i].leds))); done++;
      }
      await this.board.allOff();
      const ver = evaluateConfirm(cm, plan, assigned, holds, { pxPerCm });
      const failed = ver.holds.filter((x) => !x.ok);
      for (const x of failed) { assigned.delete(x.holdIndex); conf.delete(x.holdIndex); }

      // 5. result: one entry per LED at the centre of its hold (LEDs without a hold at their light spot)
      const leds = [...assigned].map(([k, pos]) => ({ pos, x: holds[k].cx, y: holds[k].cy, conf: conf.get(k) ?? 0.5 }));
      for (const o of orphans) if (!leds.some((l) => l.pos === o.pos)) leds.push({ pos: o.pos, x: o.x, y: o.y, conf: o.conf });
      leds.sort((a, b) => a.pos - b.pos);
      if (leds.length < 4) throw new Error(`Only ${leds.length} LEDs found. Check that the whole board is in view, that nothing covers it, and that the LEDs light up when you click a hold in the light test.`);
      const maxPos = leds.reduce((m, l) => Math.max(m, l.pos), 0);
      const result = {
        found: leds.length, matched: assigned.size, orphans: orphans.length, unassigned: holds.length - assigned.size,
        probed, fromPatterns: afterScan, unverified: failed.length, uncertain: leds.filter((l) => l.conf < 0.35).length,
        verifyOk: ver.ok, verifyBad: failed.length, maxPos, range: N, shiftPx: [shift.dx, shift.dy],
      };
      this.set({ board: { ...this.s.board, leds } });
      this.board.setKnownPositions(leds.map((l) => l.pos));
      this._rebind(); this._renumber(); this.commit();
      sc({ running: false, progress: 1, message: 'Done', result, verify: { ok: ver.ok, bad: failed.length } });
      this.log('scan', { done: true, ...result, failedConfirm: failed.map((x) => ({ pos: x.pos, reasons: x.reasons })).slice(0, 20) });
      this.saveSoon();
    } catch (e) {
      try { await this.board.allOff(); } catch { /* ignore */ }
      this.log('scan', { failed: e.message });
      sc({ running: false, message: e.message });
      if (e.message !== 'Scan cancelled') this.toast(e.message, 'error');
    }
  }
  cancelScan() { this._abortScan = true; }

  /** Attach LED positions to holds; create dashed "ghost" markers for LEDs without a hold. */
  _rebind() {
    const leds = this.s.board.leds;
    this.holds = this.holds.filter((h) => !(h.ghost && h.source === 'led'));
    for (const h of this.holds) delete h.led;
    if (!leds.length) return;
    const { byHold, unmatched } = bindLeds(this.holds, leds, this.pxPerCm);
    for (const h of this.holds) { const l = byHold.get(h.id); if (l) h.led = l.pos; }
    const r = 2 * this.pxPerCm;
    for (const l of unmatched) {
      if (this.ignoredLeds.includes(l.pos)) continue;
      if (this.holds.some((h) => !h.ghost && h.led != null && polygonDistance(h.poly, l.x, l.y) <= this.pxPerCm)) continue; // a second LED of a big hold: no extra outline
      this.holds.push({ id: 1e9 + l.pos, cx: l.x, cy: l.y, poly: ellipsePolygon(l.x, l.y, r, r, 8), area: Math.PI * r * r, solidity: 1, diaCm: 4, source: 'led', ghost: true, led: l.pos }); // stable id: selection survives re-binding
    }
  }

  async testHold(holdId) {
    const h = this.holds.find((x) => x.id === holdId);
    if (!this.board?.connected || !h || h.led == null) { this.toast(h ? 'This hold has no LED position yet.' : 'No hold selected.'); return; }
    const on = this.s.board.testing !== holdId;
    try { await this.board.setLeds(on ? [{ pos: h.led, r: 0, g: 255, b: 0 }] : []); this.set({ board: { ...this.s.board, testing: on ? holdId : null } }); } catch (e) { this.toast(e.message, 'error'); }
  }
  async lightsOff() { await this._ledsOff(); this.set({ board: { ...this.s.board, testing: null } }); }

  /** Flash known LEDs one by one, find them in the raw image and solve the wall corners from them. */
  async _autoAlign() {
    const al = (p) => this.set({ board: { ...this.s.board, align: { ...this.s.board.align, ...p } } });
    const leds = this.s.board.leds;
    if (!this.board?.connected || leds.length < 8) { this.toast('Needs a connected board and a finished LED scan.', 'error'); return; }
    const { RW, RH } = this.wallDims;
    const anchors = [[0.1, 0.1], [0.5, 0.1], [0.9, 0.1], [0.1, 0.5], [0.9, 0.5], [0.1, 0.9], [0.5, 0.9], [0.9, 0.9], [0.5, 0.5]];
    const picks = [];
    for (const [ax, ay] of anchors) {
      const t = leds.slice().sort((a, b) => Math.hypot(a.x - ax * RW, a.y - ay * RH) - Math.hypot(b.x - ax * RW, b.y - ay * RH)).find((l) => !picks.includes(l));
      if (t) picks.push(t);
    }
    const grab = async (n = 2) => {
      const { width: w, height: h } = this.source, acc = new Float32Array(w * h);
      for (let k = 0; k < n; k++) { await this._waitFrames(2); const d = this.source.ctx.getImageData(0, 0, w, h).data; for (let i = 0; i < acc.length; i++) acc[i] += (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3; }
      for (let i = 0; i < acc.length; i++) acc[i] /= n;
      return acc;
    };
    al({ running: true, message: 'Flashing reference LEDs…' });
    try {
      if (this.s.cam.kind === 'camera') await this.lockCamera(true);
      await this.board.allOff(); await sleep(500);
      const dark = await grab(3), { width: w, height: h } = this.source, imgPts = [], wallPts = [];
      for (const l of picks) {
        await this.board.setLeds([{ pos: l.pos, r: 0, g: 255, b: 0 }]); await sleep(450);
        const lit = await grab(2), sig = new Uint8Array(w * h);
        for (let i = 0; i < sig.length; i++) sig[i] = Math.max(0, Math.min(255, lit[i] - dark[i]));
        const sp = brightestSpot(sig, w, h, 20);
        if (sp) { imgPts.push([sp.x, sp.y]); wallPts.push([l.x, l.y]); }
      }
      await this.board.allOff();
      let ip = imgPts, wp = wallPts, H = null;
      for (let it = 0; it < 4 && ip.length >= 4; it++) {
        H = solveHomography(ip, wp); if (!H) break;
        const errs = ip.map((p, i) => { const [x, y] = applyH(H, p[0], p[1]); return Math.hypot(x - wp[i][0], y - wp[i][1]); });
        const worst = errs.indexOf(Math.max(...errs));
        if (errs[worst] < 0.012 * RW || ip.length === 4) break;
        ip = ip.filter((_, i) => i !== worst); wp = wp.filter((_, i) => i !== worst);
      }
      if (ip.length >= 4) H = solveHomography(ip, wp); // re-solve on the final, outlier-free set
      if (!H || ip.length < 4) throw new Error(`Found only ${imgPts.length} reference LEDs. Check the camera view.`);
      const err = ip.map((p, i) => { const [x, y] = applyH(H, p[0], p[1]); return Math.hypot(x - wp[i][0], y - wp[i][1]); });
      const rmsCm = Math.sqrt(err.reduce((s, e) => s + e * e, 0) / err.length) / this.pxPerCm;
      const Hi = invert3(H), corners = [[0, 0], [RW, 0], [RW, RH], [0, RH]].map(([x, y]) => applyH(Hi, x, y));
      if (!isValidQuad(corners)) throw new Error('Alignment result is not plausible. Mark the corners manually.');
      this.setCorners(corners);
      al({ running: false, message: `Aligned using ${ip.length} LEDs (error ${rmsCm.toFixed(1)} cm).` });
      this.toast(`Aligned using ${ip.length} LEDs (error ${rmsCm.toFixed(1)} cm).`, 'ok');
    } catch (e) {
      try { await this.board.allOff(); } catch { /* ignore */ }
      al({ running: false, message: e.message }); this.toast(e.message, 'error');
    }
  }

  // ---------- live ----------
  async startLive() {
    if (this.s.live.loading || this.s.live.running) return;
    const token = ++this._liveToken;
    if (this.s.show.running) await this.stopShow();
    if (!this.source.active) { this.toast('Start a camera first.', 'error'); return; }
    if (!this.Himg2wall) { this.toast('Mark the wall corners first.', 'error'); return; }
    if (!this.holds.some((h) => !h.ghost)) { this.toast('Detect holds first.', 'error'); return; }
    const l = this.s.live;
    this.set({ mode: 'live', live: { ...l, loading: true, running: false, error: '' } });
    try {
      if (this.s.demo) { this.engine = new DemoPose(this.world); this.world.climber = true; this.world.t0 = null; }
      else {
        if (!this.engine || this.engine instanceof DemoPose) this.engine = new PoseEngine();
        await this.engine.load(l.variant === 'auto' ? 'heavy' : l.variant);
      }
      if (token !== this._liveToken) return; // stopped while the model was loading
      this.engine.ensureProbe?.(); // stateless landmarker used while searching for the climber
      this.tracker = new ContactTracker(this.holds.filter((h) => !h.ghost), this.pxPerCm, { tolCm: l.tolCm });
      this.filters.clear(); this.prevPerson = null; this.track = null; this._lost = 99; this._tile = -1; this._rot = 0; this._lowq = 0; this.sideGuard = new SideGuard(); this._lat = 0; this._slow = 0;
      this.recorder.start(performance.now());
      this.log('live', { start: true, variant: this.engine.variant, delegate: this.engine.delegate, holds: this.holds.length });
      this.source.alwaysFresh = true;
      this.set({ live: { ...this.s.live, loading: false, running: true, activeVariant: this.engine.variant, delegate: this.engine.delegate }, session: { recording: true, events: 0, duration: 0, replayT: null, playing: false, summary: null } });
      if (this.kilterSink) this.kilterSink.setEnabled(this.s.live.lightBoard && !!this.board?.connected);
    } catch (e) {
      console.error(e);
      this.set({ mode: 'setup', live: { ...this.s.live, loading: false, running: false, error: e.message } });
      this.toast(`Live mode could not start: ${e.message}`, 'error');
    }
  }
  async stopLive() {
    this._liveToken++;
    this.log('live', { stop: true, events: this.recorder.events.length });
    await this.stopGame(false);
    const now = performance.now();
    this.recorder.stop(now);
    this.set({ live: { ...this.s.live, loading: false, running: false, person: false, contacts: { LH: null, RH: null, LF: null, RF: null } }, session: { ...this.s.session, recording: false, duration: this.recorder.duration, events: this.recorder.events.length, summary: this.recorder.summary() } });
    if (this.world) this.world.climber = false;
    this.source.alwaysFresh = false;
    this.liveDraw = null;
    try { await this.kilterSink?.setEnabled(false); } catch { /* ignore */ }
  }
  leaveLive() { this.stopLive(); this.set({ mode: 'setup' }); }

  async setVariant(v) {
    this.set({ live: { ...this.s.live, variant: v } }); this.saveSettings();
    if (this.s.live.running && !this.s.demo) {
      this.set({ live: { ...this.s.live, loading: true } });
      try { await this.engine.load(v === 'auto' ? 'heavy' : v); this.set({ live: { ...this.s.live, loading: false, activeVariant: this.engine.variant, delegate: this.engine.delegate } }); }
      catch (e) { this.set({ live: { ...this.s.live, loading: false } }); this.toast(e.message, 'error'); }
    }
  }
  setLive(patch) {
    this.set({ live: { ...this.s.live, ...patch } }); this.saveSettings();
    if (patch.tolCm !== undefined) this.tracker?.setOptions({ tolCm: patch.tolCm });
    if (patch.lightBoard !== undefined) this.kilterSink?.setEnabled(patch.lightBoard && this.s.live.running);
    if (patch.swapLR !== undefined) this.sideGuard = new SideGuard();
  }

  /**
   * Crop for the pose model. Small people vanish when the whole wall is squeezed into the detector input, so:
   * follow the climber with a tight crop while tracked; when lost, cycle through the wall and overlapping tiles.
   */
  _poseRoi() {
    const { width: W, height: H } = this.source, c = this.s.corners;
    const xs = c.map((p) => p[0]), ys = c.map((p) => p[1]);
    const mx = (Math.max(...xs) - Math.min(...xs)) * 0.12, my = (Math.max(...ys) - Math.min(...ys)) * 0.1;
    const x0 = Math.max(0, Math.min(...xs) - mx), y0 = Math.max(0, Math.min(...ys) - my), x1 = Math.min(W, Math.max(...xs) + mx), y1 = Math.min(H, Math.max(...ys) + my);
    const wall = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    if (this.track && this._lost < 4) {
      const side = Math.min(Math.max(this.track.size * 1.7, Math.min(wall.w, wall.h) * 0.45), Math.max(wall.w, wall.h));
      const sw = Math.min(side * 1.0, W), sh = Math.min(side * 1.15, H);
      return { x: Math.max(0, Math.min(W - sw, this.track.cx * W - sw / 2)), y: Math.max(0, Math.min(H - sh, this.track.cy * H - sh / 2)), w: sw, h: sh, rot: this._rot || 0 };
    }
    // searching: whole wall, then overlapping tiles (every candidate is tried in all three rotations by _liveStep)
    const tw = wall.w * 0.62, th = wall.h * 0.62, centre = { x: wall.x + (wall.w - tw) / 2, y: wall.y + (wall.h - th) / 2, w: tw, h: th };
    const seq = [wall, centre, { x: wall.x, y: wall.y, w: tw, h: th }, { x: wall.x + wall.w - tw, y: wall.y, w: tw, h: th }, { x: wall.x, y: wall.y + wall.h - th, w: tw, h: th }, { x: wall.x + wall.w - tw, y: wall.y + wall.h - th, w: tw, h: th }];
    return { ...seq[(this._tile = ((this._tile ?? -1) + 1) % seq.length)], rot: 0 };
  }

  /** When hands/feet are poorly visible, occasionally test the other crop rotations and switch if one is clearly better. */
  _probeQuality(now, roi, pose) {
    if (!this.engine?.ensureProbe) return;
    const q = limbQuality(pose.lm);
    this._lowq = q < 0.55 ? (this._lowq || 0) + 1 : 0;
    if (this._lowq < 8 || now - (this._lastProbe || 0) < 700) return;
    this._lastProbe = now;
    this.engine.ensureProbe();
    let best = { rot: this._rot || 0, q };
    for (const rot of [0, 90, -90]) {
      if (rot === (this._rot || 0)) continue;
      const found = this.engine.detect(this.source.canvas, now, roi, rot, true);
      const pk = pickClimber(found, this.s.corners.map(([x, y]) => [x / this.source.width, y / this.source.height]), this.prevPerson);
      if (pk) { const qq = limbQuality(pk.pose.lm); if (qq > best.q + 0.12) best = { rot, q: qq }; }
    }
    if (best.rot !== (this._rot || 0)) { this._rot = best.rot; this.track = null; this._lost = 99; this._tile = -1; }
  }

  /**
   * Correct a limb point in wall coordinates. Parallax: the climber stands in front of the wall, so a close camera sees
   * the body pushed away from the point it looks at; pull points back towards that centre. Plus manual up-shifts.
   */
  _adjust(limb, x, y) {
    const { parallax, footUp, handUp } = this.s.live, px = this.pxPerCm;
    if (parallax > 0) { const c = this._viewCentre ??= this.imgToWall(this.source.width / 2, this.source.height / 2); x = c[0] + (x - c[0]) * (1 - parallax); y = c[1] + (y - c[1]) * (1 - parallax); }
    return [x, y - (limb.endsWith('F') ? footUp : handUp) * px];
  }

  _liveStep(now) {
    const { width: W, height: H } = this.source, c = this.s.corners;
    this._viewCentre = null;
    const searching = !(this.track && this._lost < 4);
    const roi = this._poseRoi();
    this.poseBusy = true;
    const t0 = performance.now();
    let poses = [];
    const quad = this.s.corners.map(([x, y]) => [x / W, y / H]);
    // stateless search over the three rotations; keeps the reading with the best visible hands/feet
    const searchRot = (r) => {
      let best = null;
      // every rotation costs one inference: on a slow machine only try the current one most of the time
      const rots = this._lat > 45 && (this._searchN = (this._searchN || 0) + 1) % 6 ? [this._rot || 0] : [0, 90, -90];
      for (const rot of rots) {
        const pk = pickClimber(this.engine.detect(this.source.canvas, now, r, rot, true), quad, this.prevPerson);
        if (pk) { const sc = limbQuality(pk.pose.lm) + pk.pose.lm.filter((q) => q.v > 0.3).length * 0.01 + (rot === (this._rot || 0) ? 0.1 : 0); // bias: do not flip rotation for small gains
          if (!best || sc > best.sc) best = { pose: pk.pose, sc }; }
      }
      return best ? [best.pose] : [];
    };
    try {
      if (searching && this.engine.probe) poses = searchRot(roi);
      else {
        poses = this.engine.detect(this.source.canvas, now, roi, roi.rot || 0, false);
        // the video tracker lost the climber: retry this very frame statelessly around the last position
        if (!poses.length && this.engine.probe) poses = searchRot(roi);
      }
    } catch (e) { console.warn('pose error', e); }
    const lat = performance.now() - t0;
    this.poseBusy = false;
    this._lat = this._lat ? this._lat * 0.9 + lat * 0.1 : lat;
    this._poseFrames++;
    const t = now - this.recorder.startedAt, toWall = (p) => this.imgToWall(p.x, p.y);
    const pick = pickClimber(poses, c.map(([x, y]) => [x / W, y / H]), this.prevPerson);
    let events = [], wallLimbs = { LH: null, RH: null, LF: null, RF: null }, skeleton = null;
    if (pick) {
      this.prevPerson = { cx: pick.cx, cy: pick.cy };
      this._rot = pick.pose.rot || 0;
      this._probeQuality(now, roi, pick.pose);
      { const vis = pick.pose.lm.filter((q) => q.v > 0.3), ys2 = vis.map((q) => q.y), xs2 = vis.map((q) => q.x); this.track = { cx: pick.cx, cy: pick.cy, size: Math.max(Math.max(...ys2) - Math.min(...ys2), Math.max(...xs2) - Math.min(...xs2)) * Math.max(W, H) }; this._lost = 0; }
      const lm = pick.pose.lm, auto = this.sideGuard.update(lm, this.s.live.facing), swap = this.s.demo ? false : auto !== this.s.live.swapLR;
      const raw = limbPoints(lm, W, H, { swap });
      for (const limb of LIMBS) {
        if (!raw[limb]) { for (let i = 0; i < 2; i++) this.filters.delete(limb + i); continue; }
        wallLimbs[limb] = raw[limb].map((p, i) => {
          const [wx, wy] = this._adjust(limb, ...toWall(p));
          let f = this.filters.get(limb + i); if (!f) { f = new OneEuro2D({ minCutoff: 1.6, beta: 0.05 }); this.filters.set(limb + i, f); }
          const [fx, fy] = f.filter(wx, wy, now / 1000);
          return { x: fx, y: fy };
        });
      }
      skeleton = lm.map((p) => { const [x, y] = toWall({ x: p.x * W, y: p.y * H }); return { x, y, v: p.v }; });
      events = this.tracker.update(now, wallLimbs);
    } else { this.prevPerson = null; this._lost = (this._lost ?? 0) + 1; if (this._lost >= 4) this.track = null; events = this.tracker.update(now, wallLimbs); }
    this.liveDraw = { skeleton, limbs: wallLimbs, contacts: this.tracker.contacts, person: !!pick };
    if (events.length) {
      const byId = new Map(this.holds.map((h) => [h.id, h]));
      for (const e of events) { const h = byId.get(e.hold); this.bus.emit({ type: 'contact', t: now - this.recorder.startedAt, limb: e.limb, hold: h?.label ?? e.hold, holdId: e.hold, led: h?.led ?? null, on: e.on }); }
      const contacts = {};
      for (const [limb, id] of Object.entries(this.tracker.contacts)) { const h = id != null ? byId.get(id) : null; contacts[limb] = h ? { hold: h.label, holdId: h.id, led: h.led ?? null } : null; }
      this.bus.emit({ type: 'state', t, contacts });
    }
    // throttled UI update
    if (now - this._lastUi > 120) {
      const fps = Math.round((this._poseFrames * 1000) / (now - this._poseT)); if (now - this._poseT > 1000) { this._poseFrames = 0; this._poseT = now; }
      this._lastUi = now;
      this.set({
        live: { ...this.s.live, fps: fps || this.s.live.fps, latency: Math.round(this._lat), person: !!pick, contacts: { ...this.tracker.contacts } },
        session: { ...this.s.session, events: this.recorder.events.length, duration: t },
      });
    }
    // automatic model downgrade when the machine cannot keep up
    if (this.s.live.variant === 'auto' && this.engine.variant && this.engine.variant !== 'lite' && this.engine.variant !== 'demo') {
      this._slow = this._lat > 38 ? (this._slow || 0) + 1 : 0;
      if (this._slow > 45 && !this._switching) {
        this._switching = true;
        const next = VARIANTS[VARIANTS.indexOf(this.engine.variant) + 1];
        this.engine.load(next).then(() => { this.set({ live: { ...this.s.live, activeVariant: next } }); this.toast(`Switched to the ${next} pose model to keep the frame rate up.`); }).catch((e) => this.toast(`Could not switch pose model: ${e.message}`, 'error')).finally(() => { this._switching = false; this._slow = 0; this._lat = 0; });
      }
    }
  }

  // ---------- debug report ----------
  _gpuInfo() {
    if (this._gpu !== undefined) return this._gpu;
    try {
      const gl = document.createElement('canvas').getContext('webgl'), ext = gl?.getExtension('WEBGL_debug_renderer_info');
      this._gpu = gl ? { renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown', vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : 'unknown' } : null;
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
    } catch { this._gpu = null; }
    return this._gpu;
  }
  /** Downscaled JPEG data URL of the straightened wall (or null). */
  _debugImage(maxSide = 900) {
    let src = null;
    try {
      if (this.snapshotValid) src = this.snapshotBitmap;
      else if (this.source.active && this.Himg2wall) { const f = this._rectifyOnce(), c = document.createElement('canvas'); c.width = f.width; c.height = f.height; c.getContext('2d').putImageData(new ImageData(f.data, f.width, f.height), 0, 0); src = c; }
      if (!src) return null;
      const k = Math.min(1, maxSide / Math.max(src.width, src.height)), out = document.createElement('canvas');
      out.width = Math.round(src.width * k); out.height = Math.round(src.height * k);
      out.getContext('2d').drawImage(src, 0, 0, out.width, out.height);
      return out.toDataURL('image/jpeg', 0.8);
    } catch (e) { debugLog.warn('debug-image', e.message); return null; }
  }
  /**
   * Everything needed to understand a problem remotely: environment, settings, measured numbers, recent events.
   * Contains no personal data. The camera image is only included on request.
   */
  buildDebugReport({ includeImage = false } = {}) {
    const s = this.s, wall = this.wallDims, holds = this.holds.filter((h) => !h.ghost);
    const areas = holds.map((h) => h.area).sort((a, b) => a - b), q = (p) => (areas.length ? Math.round(areas[Math.min(areas.length - 1, Math.floor(areas.length * p))]) : null);
    const confBins = [0, 0, 0, 0, 0];
    for (const l of s.board.leds) confBins[Math.min(4, Math.floor(l.conf * 5))]++;
    const track = this.source.stream?.getVideoTracks?.()[0];
    const t = this.board?.t;
    return {
      format: 'bouldervision-debug', version: 1, createdAt: new Date().toISOString(),
      app: { version: pkg.version },
      environment: {
        userAgent: navigator.userAgent, language: navigator.language, hardwareConcurrency: navigator.hardwareConcurrency, deviceMemoryGB: navigator.deviceMemory ?? null,
        screen: `${screen.width}x${screen.height}@${devicePixelRatio}`, secureContext: window.isSecureContext, online: navigator.onLine,
        gpu: this._gpuInfo(), webBluetooth: !!navigator.bluetooth, webSerial: 'serial' in navigator,
      },
      camera: { ...(({ kind, label, width, height, fps, rotation, mirror, locked, lockMsg, error }) => ({ kind, label, width, height, fps, rotation, mirror, locked, lockMsg, error }))(s.cam), trackSettings: track?.getSettings?.() ?? null, trackCapabilityKeys: track?.getCapabilities ? Object.keys(track.getCapabilities()) : null },
      wall: { widthM: s.wall.wm, heightM: s.wall.hm, pixels: `${wall.RW}x${wall.RH}`, pxPerCm: +wall.pxPerCm.toFixed(2), corners: s.corners },
      detection: {
        params: { sensitivity: s.detect.sensitivity, contrast: s.detect.contrast, minDiaCm: s.detect.minDia, maxDiaCm: s.detect.maxDia }, hasAnalysis: s.detect.hasAnalysis,
        candidates: this.seg?.candidates.length ?? null, medianDiaCm: this.seg ? +this.seg.medianDia.toFixed(1) : null, otsu: this.seg?.otsu ?? null, timings: this.timings ?? null,
        holds: { total: holds.length, auto: holds.filter((h) => h.source === 'auto').length, manual: holds.filter((h) => h.source === 'manual').length, ledMarkers: this.holds.filter((h) => h.ghost).length, withLed: holds.filter((h) => h.led != null).length },
        areaPx: { min: q(0), p25: q(0.25), median: q(0.5), p75: q(0.75), max: q(1) }, deletedCandidates: this.deleted.size,
      },
      board: {
        state: s.board.state, name: s.board.name, transport: t?.constructor?.name ?? null, ledRange: s.board.ledCount, ledsMapped: s.board.leds.length,
        confidenceHistogram: { '0-0.2': confBins[0], '0.2-0.4': confBins[1], '0.4-0.6': confBins[2], '0.6-0.8': confBins[3], '0.8-1': confBins[4] },
        lastScan: s.board.scan.result, bleChunkDelayMs: this.board?.delay ?? null, bleWithoutResponse: t?.fast !== false, lastLedUpdateMs: this.board?.lastMs ?? null,
      },
      live: { running: s.live.running, variant: s.live.variant, activeVariant: s.live.activeVariant, delegate: s.live.delegate, fps: s.live.fps, latencyMs: s.live.latency, toleranceCm: s.live.tolCm, footUpCm: s.live.footUp, handUpCm: s.live.handUp, perspective: s.live.parallax, facing: s.live.facing, swapLR: s.live.swapLR, session: s.session.summary },
      profile: { name: s.profileName, kilter: s.kilter, numbering: s.numbering, numberStart: s.numberStart, routes: s.routes.items.length },
      holds: holds.map((h) => ({ id: h.id, label: h.label, led: h.led ?? null, x: Math.round(h.cx), y: Math.round(h.cy), area: Math.round(h.area), source: h.source })),
      leds: s.board.leds.map((l) => ({ pos: l.pos, x: Math.round(l.x), y: Math.round(l.y), conf: +l.conf.toFixed(2) })),
      log: debugLog.entries,
      image: includeImage ? this._debugImage() : undefined,
    };
  }
  exportDebug({ includeImage = false } = {}) {
    const report = this.buildDebugReport({ includeImage });
    download(`bouldervision-debug-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`, JSON.stringify(report));
    this.toast('Debug report saved. Send the file to whoever is helping you.', 'ok');
  }

  // ---------- outputs ----------
  holdsMessage() {
    const { RW, RH, pxPerCm } = this.wallDims;
    return { type: 'holds', wall: { widthM: this.s.wall.wm, heightM: this.s.wall.hm }, leds: this.s.board.leds.map((l) => ({ led: l.pos, x: +(l.x / RW).toFixed(4), y: +(l.y / RH).toFixed(4) })), holds: this.holds.filter((h) => !h.ghost).map((h) => ({ id: h.id, label: h.label, led: h.led ?? null, x: +(h.cx / RW).toFixed(4), y: +(h.cy / RH).toFixed(4), xCm: Math.round(h.cx / pxPerCm), yCm: Math.round((RH - h.cy) / pxPerCm), diaCm: +h.diaCm?.toFixed(1) })) };
  }
  connectWs(url) {
    this.set({ outputs: { ...this.s.outputs, ws: { ...this.s.outputs.ws, url } } }); this.saveSettings();
    this.ws.connect(url, () => ({ type: 'hello', app: 'bouldervision', version: 1, ...this.holdsMessage() }));
  }
  disconnectWs() { this.ws.disconnect(); }
  async connectSerial() { try { await this.serial.connect(); } catch (e) { if (e.name !== 'NotFoundError') this.toast(e.message, 'error'); } }
  exportSession(kind) {
    const meta = { profile: this.s.profileName, holds: this.holdsMessage().holds };
    if (kind === 'csv') download('session.csv', this.recorder.toCSV(), 'text/csv'); else download('session.json', this.recorder.toJSON(meta));
  }
  exportHolds() { download(`${this.s.profileName.replace(/\W+/g, '_')}_holds.json`, JSON.stringify(this.holdsMessage(), null, 1)); }
  setReplay(t) { this.set({ session: { ...this.s.session, replayT: t } }); }
  replayContacts() { const t = this.s.session.replayT; return t == null ? null : this.recorder.contactsAt(t); }
  playReplay() {
    const dur = this.recorder.duration; if (!dur) return;
    let t = this.s.session.replayT == null || this.s.session.replayT >= dur ? 0 : this.s.session.replayT;
    this.set({ session: { ...this.s.session, playing: true, replayT: t } });
    const t0 = performance.now() - t;
    const tick = () => {
      if (!this.s.session.playing) return;
      t = performance.now() - t0;
      if (t >= dur) { this.set({ session: { ...this.s.session, replayT: dur, playing: false } }); return; }
      this.set({ session: { ...this.s.session, replayT: t } }); requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  pauseReplay() { this.set({ session: { ...this.s.session, playing: false } }); }

  // ---------- profiles ----------
  _profileData() {
    const s = this.s;
    return { id: s.profileId, name: s.profileName, kilter: s.kilter, wall: s.wall, corners: s.corners, fixedCamera: s.fixedCamera, camRotation: s.cam.rotation, camMirror: s.cam.mirror, holds: this.holds.map(({ cand, ...h }) => h), ignoredLeds: this.ignoredLeds, nextId: this.nextId, numbering: s.numbering, numberStart: s.numberStart, detect: { sensitivity: s.detect.sensitivity, contrast: s.detect.contrast, minDia: s.detect.minDia, maxDia: s.detect.maxDia, showUncertain: s.detect.showUncertain }, ledCount: s.board.ledCount, leds: s.board.leds, routes: s.routes.items, snapshot: this.snapshotBlob, holdCount: this.holds.filter((h) => !h.ghost).length };
  }
  saveSoon() { this.set({ saved: false }); clearTimeout(this._saveTimer); this._saveTimer = setTimeout(() => this.saveNow(), 700); }
  async saveNow() {
    if (!this.s.profileId) return;
    try { await profiles.saveProfile(this._profileData()); this.set({ saved: true, profiles: await profiles.listProfiles() }); localStorage.setItem('bv.lastProfile', this.s.profileId); }
    catch (e) { console.warn('save failed', e); }
  }
  async _applyProfile(p) {
    this.holds = clone(p.holds || []); this.holds.forEach((h) => delete h.cand); this.suppress = []; this.ignoredLeds = p.ignoredLeds || []; this.nextId = p.nextId || this.holds.reduce((m, h) => Math.max(m, h.id), 0) + 1;
    this.history = []; this.future = []; this.analysis = null; this.seg = null; this.deleted = new Set(); this.peopleSegs = []; this._runId++; this.snapshot = null; this.snapshotBitmap = null; this.snapshotBlob = p.snapshot || null; this.snapKey = p.snapshot ? '*profile' : null;
    if (p.snapshot instanceof Blob) { const bmp = await createImageBitmap(p.snapshot); const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; c.getContext('2d').drawImage(bmp, 0, 0); this.snapshotBitmap = c; }
    this.set({
      profileId: p.id, profileName: p.name, kilter: !!p.kilter, wall: p.wall || { wm: 3.6, hm: 3.6 }, fixedCamera: !!p.fixedCamera, corners: p.corners || this.s.corners, holds: this.holds, numbering: p.numbering || 'rows', numberStart: p.numberStart ?? 1, selected: null,
      cam: { ...this.s.cam, rotation: p.camRotation || 0, mirror: !!p.camMirror },
      detect: { ...this.s.detect, ...(p.detect || {}), hasAnalysis: false, busy: false, message: '' },
      routes: { items: p.routes || [], active: p.routes?.[0]?.id ?? null, brush: 'hand', sync: true }, show: { ...this.s.show, running: false }, kilterTab: 'test',
      board: { ...this.s.board, ledCount: Math.max(1024, p.ledCount || 0), leds: p.leds || [], scan: { ...this.s.board.scan, result: null, verify: null } },
      step: this.source.active ? (p.corners ? 'align' : 'align') : 'camera', mode: 'setup', saved: true, demo: false,
    });
    this.source.setOrientation({ rotation: this.s.cam.rotation, mirror: this.s.cam.mirror });
    this.history.push(this._snap());
    this.set({ canUndo: false, canRedo: false });
    this.board?.setKnownPositions((p.leds || []).map((l) => l.pos));
  }
  async loadProfile(id) { const p = await profiles.loadProfile(id); if (p) { await this._applyProfile(p); localStorage.setItem('bv.lastProfile', id); } }
  async newProfile(name = 'New wall', save = true) {
    const p = { id: profiles.newId(), name, kilter: false, wall: { wm: 3.6, hm: 3.6 }, corners: null, holds: [], leds: [], numbering: 'rows' };
    await this._applyProfile(p); this.set({ corners: this.source.width ? this.defaultCorners() : null });
    if (save) await this.saveNow();
  }
  async deleteProfile(id) {
    await profiles.deleteProfile(id);
    const list = await profiles.listProfiles(); this.set({ profiles: list });
    if (id === this.s.profileId) { if (list.length) await this.loadProfile(list[0].id); else await this.newProfile('My wall'); }
  }
  renameProfile(name) { this.set({ profileName: name || 'Wall' }); this.saveSoon(); }
  setKilter(on) { this.set({ kilter: on }); if (this.s.step === 'board' && !on) this.set({ step: 'ready' }); this.saveSoon(); }
  async exportProfileFile() { await this.saveNow(); download(`${this.s.profileName.replace(/\W+/g, '_')}.bvprofile.json`, await profiles.exportProfile(this._profileData())); }
  async importProfileFile(file) {
    try { const p = await profiles.importProfile(await file.text()); await profiles.saveProfile(p); this.set({ profiles: await profiles.listProfiles() }); await this.loadProfile(p.id); this.toast('Profile imported.', 'ok'); }
    catch (e) { this.toast(e.message, 'error'); }
  }

  // ---------- kilter extras: light show, routes, exports ----------
  setKilterTab(tab) {
    const prev = this.s.kilterTab;
    if (prev === tab) return;
    if (prev === 'show') this.stopShow();
    if (prev === 'test' || prev === 'route') this.lightsOff();
    this.set({ kilterTab: tab });
    if (tab === 'route' && this.s.routes.sync) this._sendRoute();
  }
  startShow(pattern) {
    if (this.s.mode === 'live' && this.s.live.running) return;
    this.lightsOff();
    this._showT0 = performance.now(); this._showById = new Map(this.holds.map((h) => [h.id, h]));
    this.set({ show: { ...this.s.show, running: true, pattern: pattern || this.s.show.pattern } });
  }
  async stopShow() {
    this.set({ show: { ...this.s.show, running: false } });
    this.showLit = null;
    await this._ledsOff();
  }
  setShow(patch) { this.set({ show: { ...this.s.show, ...patch } }); if (patch.pattern && this.s.show.running) this._showT0 = performance.now(); }
  _showTick(now) {
    const sh = this.s.show, t = ((now - this._showT0) / 1000) * sh.speed;
    this.showLit = showFrame(sh.pattern, t, this.holds.filter((h) => !h.ghost), this.wallDims);
    if (now - (this._showSent || 0) > GAME_LED_INTERVAL_MS) { this._showSent = now; this._pushLeds(this._litToLeds(this.showLit, this._showById)); }
  }
  /** Colours per hold -> LEDs (only holds with an LED; the brightest MAX_SHOW_LEDS, since Bluetooth is slow). */
  _litToLeds(lit, byId) {
    const leds = [];
    for (const [id, col] of lit) { const h = byId.get(id); if (h?.led != null) leds.push({ pos: h.led, r: col.r, g: col.g, b: col.b }); }
    if (leds.length > MAX_SHOW_LEDS) leds.sort((a, b) => Math.max(b.r, b.g, b.b) - Math.max(a.r, a.g, a.b)).length = MAX_SHOW_LEDS;
    return leds;
  }
  /**
   * Send a complete LED state to the board. Latest wins: while a frame is in flight only the newest pending state is kept,
   * so a slow Bluetooth link never builds up a queue and identical frames are not resent.
   */
  async _pushLeds(leds) {
    if (!this.board?.connected) return;
    const sig = leds.map((l) => `${l.pos}:${l.r},${l.g},${l.b}`).sort().join('|');
    if (sig === this._ledSig && !this._ledNext) return;
    this._ledNext = { leds, sig };
    if (this._ledBusy) return;
    this._ledBusy = true;
    try {
      while (this._ledNext) {
        const { leds: next, sig: nextSig } = this._ledNext;
        this._ledNext = null;
        await this.board.setLeds(next);
        this._ledSig = nextSig;
      }
    } catch (e) { this.log('led', `update failed: ${e.message}`); }
    finally { this._ledBusy = false; }
  }
  /** Everything off, and forget what we believed was lit. */
  async _ledsOff() {
    this._ledNext = null; this._ledSig = null;
    try { if (this.board?.connected) await this.board.allOff(); } catch (e) { this.log('led', `all off failed: ${e.message}`); }
  }

  // ---------- games ----------
  selectGame(id) { if (!this.s.game.active) this.set({ game: { ...this.s.game, id } }); }
  startGame(id = this.s.game.id) {
    if (!(this.s.mode === 'live' && this.s.live.running && this.tracker)) { this.toast('Start live tracking first: games use the climber\'s hand and foot contacts.'); return; }
    this.stopGame(false);
    const holds = this.holds.filter((h) => !h.ghost);
    this._gameById = new Map(holds.map((h) => [h.id, h]));
    this.game = createGame(id, holds, this.wallDims, rng((Date.now() ^ (performance.now() * 1000)) >>> 0));
    this.game.start(performance.now());
    this._gameOverSeen = false;
    this.kilterSink?.setEnabled(false); // the game decides what lights; hands/feet lighting would fight it
    this.log('game', { start: id, holds: holds.length });
    this.set({ game: { ...this.s.game, id, active: true, state: this.game.state(performance.now()) } });
  }
  async stopGame(restoreSink = true) {
    if (!this.game) return;
    this.game = null; this.showLit = null;
    this.set({ game: { ...this.s.game, active: false, state: null } });
    await this._ledsOff();
    if (restoreSink && this.s.live.running) this.kilterSink?.setEnabled(this.s.live.lightBoard && !!this.board?.connected);
  }
  _gameTick(now) {
    const g = this.game, contacts = this.tracker?.contacts ?? { LH: null, RH: null, LF: null, RF: null };
    g.update(now, contacts);
    this.showLit = g.lit;
    if (now - this._gameLed >= GAME_LED_INTERVAL_MS) { this._gameLed = now; this._pushLeds(this._litToLeds(g.lit, this._gameById)); }
    if (g.over && !this._gameOverSeen) {
      this._gameOverSeen = true;
      const id = this.s.game.id, best = this.s.game.best;
      if (g.score > (best[id] || 0)) { const next = { ...best, [id]: g.score }; this.set({ game: { ...this.s.game, best: next } }); try { localStorage.setItem(BEST_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ } }
      this.log('game', { over: id, score: g.score });
      this._pushLeds([]);
    }
    if (now - this._gameUi >= GAME_UI_INTERVAL_MS || g.over) { this._gameUi = now; this.set({ game: { ...this.s.game, state: g.state(now) } }); }
  }

  get activeRoute() { const r = this.s.routes; return r.items.find((i) => i.id === r.active) || null; }
  _setRoutes(patch) { this.set({ routes: { ...this.s.routes, ...patch } }); this.saveSoon(); }
  newRoute(name) {
    const items = this.s.routes.items, id = 'r' + Math.random().toString(36).slice(2, 8);
    this._setRoutes({ items: [...items, { id, name: name || `Route ${items.length + 1}`, roles: {} }], active: id });
  }
  selectRoute(id) { this._setRoutes({ active: id }); if (this.s.kilterTab === 'route' && this.s.routes.sync) this._sendRoute(); }
  deleteRoute(id) {
    const items = this.s.routes.items.filter((r) => r.id !== id);
    this._setRoutes({ items, active: this.s.routes.active === id ? items[0]?.id ?? null : this.s.routes.active });
    if (this.s.routes.sync) this._sendRoute();
  }
  renameRoute(name) { this._setRoutes({ items: this.s.routes.items.map((r) => (r.id === this.s.routes.active ? { ...r, name: name || r.name } : r)) }); }
  setBrush(brush) { this.set({ routes: { ...this.s.routes, brush } }); }
  setRouteSync(sync) { this.set({ routes: { ...this.s.routes, sync } }); if (sync) this._sendRoute(); else this.lightsOff(); }
  /** Roles are keyed by LED position: the physical identity of a hold on the board, stable across re-detection. */
  toggleRouteHold(holdId) {
    const h = this.holds.find((x) => x.id === holdId);
    if (!h || h.ghost) return;
    if (h.led == null) { this.toast('This hold has no LED yet. Scan the LEDs first.'); return; }
    if (!this.activeRoute) this.newRoute();
    const brush = this.s.routes.brush;
    this._setRoutes({ items: this.s.routes.items.map((r) => { if (r.id !== this.s.routes.active) return r; const roles = { ...r.roles }; if (roles[h.led] === brush) delete roles[h.led]; else roles[h.led] = brush; return { ...r, roles }; }) });
    if (this.s.routes.sync) this._sendRoute();
  }
  clearRoute() { if (!this.activeRoute) return; this._setRoutes({ items: this.s.routes.items.map((r) => (r.id === this.s.routes.active ? { ...r, roles: {} } : r)) }); if (this.s.routes.sync) this._sendRoute(); }
  _routeLeds() { const r = this.activeRoute; return r ? Object.entries(r.roles).map(([led, role]) => ({ pos: +led, r: ROLES[role].rgb[0], g: ROLES[role].rgb[1], b: ROLES[role].rgb[2] })) : []; }
  async _sendRoute() {
    if (!this.board?.connected) return;
    try { const leds = this._routeLeds(); if (leds.length) await this.board.setLeds(leds); else await this.board.allOff(); } catch (e) { this.toast(e.message, 'error'); }
  }
  exportRoutes() {
    const byLed = new Map(this.holds.filter((h) => h.led != null).map((h) => [h.led, h]));
    const routes = this.s.routes.items.map((r) => ({ name: r.name, holds: Object.entries(r.roles).map(([led, role]) => ({ led: +led, hold: byLed.get(+led)?.label ?? null, role })) }));
    download(`${this.s.profileName.replace(/\W+/g, '_')}_routes.json`, JSON.stringify({ format: 'bouldervision-routes', board: this.s.profileName, routes }, null, 1));
  }

  exportHoldsCsv() {
    const { RH, pxPerCm } = this.wallDims, rows = this.holds.filter((h) => !h.ghost).slice().sort((a, b) => (a.label ?? 0) - (b.label ?? 0));
    const csv = ['label,id,led,x_cm_from_left,y_cm_from_bottom,diameter_cm,origin', ...rows.map((h) => [h.label ?? '', h.id, h.led ?? '', (h.cx / pxPerCm).toFixed(1), ((RH - h.cy) / pxPerCm).toFixed(1), (h.diaCm || 0).toFixed(1), h.source].join(','))].join('\n');
    download(`${this.s.profileName.replace(/\W+/g, '_')}_holds.csv`, csv, 'text/csv');
  }
  /** PNG of the straightened wall with every hold outlined and numbered (and LED-only markers dashed). */
  async exportImage() {
    const { RW, RH } = this.wallDims, bar = 44, cv = document.createElement('canvas');
    cv.width = RW; cv.height = RH + bar;
    const g = cv.getContext('2d');
    g.fillStyle = '#0b0e12'; g.fillRect(0, 0, RW, RH + bar);
    try {
      if (this.snapshotValid) g.drawImage(this.snapshotBitmap, 0, 0, RW, RH);
      else if (this.source.active && this.Himg2wall) { const f = this._rectifyOnce(); g.putImageData(new ImageData(f.data, f.width, f.height), 0, 0); }
    } catch { /* export without background */ }
    g.lineJoin = 'round';
    for (const h of this.holds) {
      g.beginPath(); h.poly.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath();
      if (h.ghost) { g.setLineDash([5, 4]); g.strokeStyle = 'rgba(255,255,255,.6)'; g.lineWidth = 1.5; } else { g.setLineDash([]); g.strokeStyle = h.source === 'manual' ? '#a3e635' : '#38bdf8'; g.lineWidth = 2; }
      g.stroke(); g.setLineDash([]);
      if (!h.ghost && h.label != null) {
        const fs = Math.max(11, Math.min(20, Math.sqrt(h.area) * 0.5));
        g.font = `700 ${fs}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineWidth = 4; g.strokeStyle = 'rgba(0,0,0,.8)'; g.strokeText(String(h.label), h.cx, h.cy); g.fillStyle = '#fff'; g.fillText(String(h.label), h.cx, h.cy);
      }
    }
    g.fillStyle = '#12161c'; g.fillRect(0, RH, RW, bar);
    g.fillStyle = '#e8edf2'; g.font = '600 18px sans-serif'; g.textAlign = 'left'; g.textBaseline = 'middle';
    g.fillText(`${this.s.profileName}  ·  ${this.holds.filter((h) => !h.ghost).length} holds  ·  ${this.s.wall.wm} × ${this.s.wall.hm} m  ·  BoulderVision`, 14, RH + bar / 2);
    const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
    downloadBlob(`${this.s.profileName.replace(/\W+/g, '_')}_holds.png`, blob);
  }

  // ---------- navigation ----------
  async goStep(step) {
    this.set({ step, mode: 'setup', selected: null });
    if (step === 'holds' && !this.holds.length && !this.analysis && this.Himg2wall && this.source.active && !this.s.detect.busy) this.runDetect();
  }
}

export const app = new App();
if (typeof window !== 'undefined') { window.__bv = app; app._PoseEngine = PoseEngine; } // handy for the e2e test and the diagnostics page
