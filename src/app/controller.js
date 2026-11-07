// Application controller: owns camera, geometry, hold data, board, live pipeline and outputs.
import { createStore } from '../store/store.js';
import { FrameSource } from '../core/camera.js';
import { Warper, warpCPU } from '../core/warp.js';
import { wallSize } from '../core/wall.js';
import { resolveOverlaps, wallHomography, invert3, applyH, solveHomography, isValidQuad, pointInPolygon, polygonDistance, ellipsePolygon, polygonCentroid, polygonArea, orderCorners } from '../core/geometry.js';
import { OneEuro2D } from '../core/filters.js';
import { ContactTracker, LIMBS } from '../core/contact.js';
import { numberHolds } from '../core/numbering.js';
import { analyzeWall, detectHolds, fitHoldAt } from '../cv/holds.js';
import { scanLayout, spotImage, findSpots, decodeSpots, pickVerifySet, verifyMapping, brightestSpot } from '../cv/calibrate.js';
import { AuroraBoard, BleTransport } from '../board/aurora.js';
import { PoseEngine, SKELETON, pickClimber, limbPoints, limbQuality, SideGuard, VARIANTS } from '../pose/pose.js';
import { Bus, WebSocketSink, SerialSink, KilterSink, SessionRecorder, download, downloadBlob } from '../outputs/sinks.js';
import { showFrame, ROLES } from '../outputs/lightshow.js';
import { PhoneReceiver } from '../core/phone.js';
import { DemoWorld, DemoPose } from '../sim/demo.js';
import * as profiles from '../store/profiles.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clone = (o) => structuredClone(o);
const SETTINGS_KEY = 'bv.settings';
const MAX_SHOW_LEDS = 36;

export const store = createStore({
  ready: false, profiles: [], profileId: null, profileName: 'My wall', saved: true,
  kilter: false, mode: 'setup', step: 'camera', demo: false,
  wall: { wm: 3.6, hm: 3.6 }, corners: null,
  cam: { status: 'off', kind: 'none', label: '', width: 0, height: 0, fps: 0, devices: [], deviceId: '', res: 1080, rotation: 0, mirror: false, locked: false, lockMsg: '', error: '' },
  holds: [], tool: 'select', selected: null, numbering: 'rows', numberStart: 1, canUndo: false, canRedo: false,
  detect: { sensitivity: 0.5, minDia: 0, maxDia: 30, effMin: 0, busy: false, hasAnalysis: false, message: '' },
  board: { state: 'idle', name: '', ledCount: 1024, leds: [], rejected: 0, testing: null, scan: { running: false, progress: 0, message: '', result: null, verify: null }, align: { running: false, message: '' } },
  live: { running: false, loading: false, variant: 'auto', activeVariant: '', delegate: '', fps: 0, latency: 0, person: false, contacts: { LH: null, RH: null, LF: null, RF: null }, tolCm: 2.5, facing: 'wall', swapLR: false, lightBoard: false, error: '' },
  outputs: { ws: { url: 'ws://localhost:8765', state: 'off', detail: '' }, serial: { state: 'off', detail: '' } },
  session: { recording: false, events: 0, duration: 0, replayT: null, playing: false, summary: null },
  phone: { state: 'off', url: '', baseUrl: '', detail: '', lan: null },
  toast: null, ui: { labels: true, grid: true },
  kilterTab: 'test', show: { running: false, pattern: 'rainbow', speed: 1 }, routes: { items: [], active: null, brush: 'hand', sync: true },
});

class App {
  constructor() {
    this.source = new FrameSource();
    this.snapWarper = null;
    this.bus = new Bus();
    this.recorder = new SessionRecorder();
    this.analysis = null; this.snapshot = null; this.snapshotBitmap = null; this.snapshotBlob = null;
    this.holds = []; this.suppress = []; this.ignoredLeds = []; this.nextId = 1;
    this.history = []; this.future = []; this._liveToken = 0;
    this.board = null; this.kilterSink = null; this.world = null;
    this.engine = null; this.tracker = null; this.liveDraw = null; this.sideGuard = new SideGuard();
    this.filters = new Map(); this.prevPerson = null; this.poseBusy = false; this._lat = 0; this._poseFrames = 0; this._poseT = performance.now();
    this._saveTimer = null; this._detectTimer = null; this._H = null; this._Hkey = '';
    this.ws = new WebSocketSink((state, detail = '') => this.set({ outputs: { ...this.s.outputs, ws: { ...this.s.outputs.ws, state, detail } } }));
    this.serial = new SerialSink((state, detail = '') => this.set({ outputs: { ...this.s.outputs, serial: { state, detail } } }));
    this.bus.on((m) => { this.recorder.handle(m); this.ws.handle(m); this.serial.handle(m); this.kilterSink?.handle(m); });
    this.showLit = null;
    this.source.addEventListener('change', () => this._camChanged());
    this._lastUi = 0;
  }
  get s() { return store.get(); }
  set(p) { store.set(p); }
  toast(msg, kind = 'info') { const id = Math.random(); this.set({ toast: { msg, kind, id } }); setTimeout(() => { if (this.s.toast?.id === id) this.set({ toast: null }); }, kind === 'error' ? 7000 : 3500); }

  // ---------- lifecycle ----------
  async init() {
    const st = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    this.set({
      cam: { ...this.s.cam, res: st.res || 1080, deviceId: st.deviceId || '' },
      live: { ...this.s.live, tolCm: st.tolCm ?? 2.5, facing: st.facing || 'wall', variant: st.variant || 'auto' },
      outputs: { ...this.s.outputs, ws: { ...this.s.outputs.ws, url: st.wsUrl || this.s.outputs.ws.url } },
      phone: { ...this.s.phone, baseUrl: st.phoneBase || location.href.replace(/#.*$/, '') },
    });
    await this._detectLan(st.phoneBase);
    try { this.set({ profiles: await profiles.listProfiles() }); } catch (e) { console.warn('profiles unavailable', e); }
    const last = localStorage.getItem('bv.lastProfile');
    if (last && this.s.profiles.some((p) => p.id === last)) await this.loadProfile(last); else await this.newProfile('My wall', false);
    this.set({ ready: true });
    this.refreshDevices();
    const loop = (now) => { this.frame(now); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }
  /** Asks the dev server for the Wi-Fi address a phone can use (the QR code must not point to "localhost"). */
  async _detectLan(saved) {
    try {
      const r = await fetch('./__lan', { cache: 'no-store' });
      if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) return;
      const lan = await r.json();
      this.set({ phone: { ...this.s.phone, lan } });
      if (lan.ips?.length && (!saved || /localhost|127\.0\.0\.1/.test(saved))) this.setPhoneBase(`${lan.protocol}://${lan.ips[0]}:${lan.port}/`);
    } catch { /* hosted build: no dev server endpoint */ }
  }
  saveSettings() {
    const { cam, live, outputs, phone } = this.s;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ res: cam.res, deviceId: cam.deviceId, tolCm: live.tolCm, facing: live.facing, variant: live.variant, wsUrl: outputs.ws.url, phoneBase: phone.baseUrl }));
  }

  // ---------- main loop ----------
  frame(now) {
    const fresh = this.source.tick(now);
    if (this.s.show.running) this._showTick(now);
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
  imgToWall(x, y) { const H = this.Himg2wall; return H ? applyH(H, x, y) : [x, y]; }
  defaultCorners() { const w = this.source.width, h = this.source.height; return [[w * 0.2, h * 0.12], [w * 0.8, h * 0.12], [w * 0.8, h * 0.9], [w * 0.2, h * 0.9]]; }
  setCorners(c, { save = true } = {}) { this.set({ corners: c }); if (save) this.saveSoon(); }
  setWall(patch) {
    const wall = { ...this.s.wall, ...patch };
    if (!(wall.wm >= 0.5 && wall.wm <= 20 && wall.hm >= 0.5 && wall.hm <= 20)) return;
    this.set({ wall }); this.saveSoon();
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
    this.source.setOrientation({ rotation: this.s.cam.rotation, mirror: this.s.cam.mirror });
    for (let i = 0; i < 40 && !this.source.tick(performance.now()); i++) await sleep(50);
    this._camChanged();
    if (!this.s.corners && this.source.width) this.setCorners(this.defaultCorners(), { save: false });
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
    this.saveSoon();
  }
  async lockCamera(on) {
    const r = await this.source.lock(on);
    this.set({ cam: { ...this.s.cam, locked: r.ok ? on : false, lockMsg: r.ok ? (on ? `Locked: ${r.applied.join(', ')}` : 'Auto mode restored') : r.reason } });
    return r;
  }

  // phone
  async startPhone() {
    this.set({ phone: { ...this.s.phone, state: 'starting', detail: '' } });
    this.phone?.stop();
    this.phone = new PhoneReceiver({
      onStream: (stream) => { this._startSource(() => this.source.useStream(stream, 'Phone camera (WebRTC)', 'phone'), 'Phone'); },
      onState: (state, detail = '') => this.set({ phone: { ...this.s.phone, state, detail } }),
    });
    try { const { url } = await this.phone.start(this.s.phone.baseUrl); this.set({ phone: { ...this.s.phone, url } }); }
    catch (e) { this.set({ phone: { ...this.s.phone, state: 'error', detail: e.type || e.message } }); }
  }
  setPhoneBase(v) { this.set({ phone: { ...this.s.phone, baseUrl: v } }); this.saveSettings(); }
  stopPhone() { this.phone?.stop(); this.set({ phone: { ...this.s.phone, state: 'off', url: '' } }); }

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
  async runDetect() {
    const d = this.s.detect;
    if (d.busy) return;
    this.set({ detect: { ...d, busy: true, message: 'Capturing wall…' } });
    try {
      if (this.board?.connected && this.board.lit.size) await this.board.allOff();
      const img = await this.captureWall(4);
      this.set({ detect: { ...this.s.detect, message: 'Detecting holds…' } });
      await sleep(30);
      await this._storeSnapshot(img);
      this.analysis = analyzeWall(img);
      this.set({ detect: { ...this.s.detect, message: 'Checking for people in view…' } });
      const people = await this._findPeople();
      this.set({ detect: { ...this.s.detect, hasAnalysis: true } });
      this._applyDetection(true);
      this.commit();
      const n = this.holds.filter((h) => !h.ghost).length;
      this.set({ detect: { ...this.s.detect, busy: false, message: n ? `${n} holds found${people ? ` (ignored ${people} ${people > 1 ? 'people' : 'person'} in view)` : ''}` : 'No holds found. Raise the sensitivity or check the corners.' } });
    } catch (e) {
      this.set({ detect: { ...this.s.detect, busy: false, message: e.message } }); this.toast(e.message, 'error');
    }
  }
  /** Re-run thresholding on the stored analysis (fast; used by the sliders). Manual holds are kept. */
  _applyDetection(first = false) {
    if (!this.analysis) return;
    const d = this.s.detect, px = this.pxPerCm;
    const { holds: found, thresholds } = detectHolds(this.analysis, { sensitivity: d.sensitivity, minDiaCm: d.minDia, maxDiaCm: d.maxDia, pxPerCm: px });
    this.set({ detect: { ...this.s.detect, effMin: +thresholds.minDiaEff.toFixed(1) } });
    const keep = this.holds.filter((h) => h.source === 'manual');
    const out = keep.slice();
    for (const f of found) {
      if (keep.some((k) => pointInPolygon(k.poly, f.cx, f.cy) || pointInPolygon(f.poly, k.cx, k.cy))) continue;
      if (this.suppress.some((s) => Math.hypot(s.x - f.cx, s.y - f.cy) < 1.5 * px)) continue;
      if (this._inPeople(f.cx, f.cy, px)) continue; // a person was standing there while the wall was captured
      out.push({ id: this.nextId++, ...f, source: 'auto' });
    }
    resolveOverlaps(out.filter((h) => h.source === 'auto')); // touching holds: separate overlapping outlines
    this.holds = out;
    this._rebind(); this._renumber();
    if (!first) this.saveSoon();
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
  setDetectParam(patch) {
    this.set({ detect: { ...this.s.detect, ...patch } });
    clearTimeout(this._detectTimer);
    this._detectTimer = setTimeout(() => { if (this.analysis) { this._applyDetection(); this.commit(); } }, 220);
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
  _snap() { return { holds: clone(this.holds), suppress: clone(this.suppress), ignoredLeds: [...this.ignoredLeds], nextId: this.nextId, leds: clone(this.s.board.leds) }; }
  _restore(s) {
    this.holds = clone(s.holds); this.suppress = clone(s.suppress); this.ignoredLeds = [...s.ignoredLeds]; this.nextId = s.nextId;
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
  addAt(x, y) {
    let f = this.analysis ? fitHoldAt(this.analysis, x, y, this.pxPerCm) : null;
    let note = '';
    if (!f) { const r = 2.5 * this.pxPerCm; f = { cx: x, cy: y, poly: ellipsePolygon(x, y, r, r, 8), area: Math.PI * r * r, solidity: 1, diaCm: 5 }; note = 'No clear hold edge found: placed a default shape. Drag its corners to fit.'; }
    if (this.holds.some((h) => pointInPolygon(h.poly, f.cx, f.cy))) { this.toast('There is already a hold here.'); return null; }
    const h = { id: this.nextId++, ...f, source: 'manual' };
    this.holds.push(h); this._rebind(); this._renumber(); this.commit();
    this.set({ selected: h.id });
    if (note) this.toast(note);
    return h;
  }
  addInRegion(r) {
    if (!this.analysis) { this.toast('Run hold detection first.'); return 0; }
    const d = this.s.detect, px = this.pxPerCm;
    const { holds } = detectHolds(this.analysis, { sensitivity: Math.min(1, d.sensitivity + 0.35), minDiaCm: Math.max(1.5, (d.minDia || d.effMin || 3) * 0.7), maxDiaCm: d.maxDia, pxPerCm: px, region: r });
    let n = 0;
    for (const f of holds) {
      if (this.holds.some((k) => pointInPolygon(k.poly, f.cx, f.cy) || pointInPolygon(f.poly, k.cx, k.cy))) continue;
      this.holds.push({ id: this.nextId++, ...f, source: 'manual' }); n++;
    }
    if (n) { this._rebind(); this._renumber(); this.commit(); this.toast(`Added ${n} hold${n > 1 ? 's' : ''}.`); } else this.toast('Nothing new found in that area. Click a hold to add it directly.');
    return n;
  }
  removeIds(ids) {
    const set = new Set(ids);
    for (const h of this.holds) {
      if (!set.has(h.id)) continue;
      if (h.ghost && h.led != null) this.ignoredLeds.push(h.led);
      else if (h.source === 'auto') this.suppress.push({ x: h.cx, y: h.cy });
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
  setHoldGhost(id, ghost) { const h = this.holds.find((x) => x.id === id); if (h) { h.ghost = ghost; this._renumber(); this.commit(); } }
  clearHolds() { this.holds = []; this.suppress = []; this.ignoredLeds = []; this._renumber(); this.commit(); }
  endEdit() { this._rebind(); this._renumber(); this.commit(); }

  // ---------- board ----------
  _wireBoard() {
    this.board.addEventListener('status', (e) => {
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
    catch (e) { if (e?.name !== 'NotFoundError') this.toast(e.message || String(e), 'error'); }
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

  async _scanLeds() {
    const sc = (p) => this.set({ board: { ...this.s.board, scan: { ...this.s.board.scan, ...p } } });
    if (!this.board?.connected) { this.toast('Connect the board first.', 'error'); return; }
    if (!this.Himg2wall) { this.toast('Mark the wall corners first.', 'error'); return; }
    this._abortScan = false;
    const N = this.s.board.ledCount, layout = scanLayout(N), F = layout.frames.length, total = F + 3, GREEN = { r: 0, g: 255, b: 0 };
    const step = async (i, msg) => { if (this._abortScan) throw new Error('Scan cancelled'); sc({ running: true, progress: i / total, message: msg }); };
    sc({ running: true, progress: 0, message: 'Preparing…', result: null, verify: null });
    try {
      if (this.s.cam.kind === 'camera' || this.s.cam.kind === 'phone') await this.lockCamera(true);
      await step(0, 'Lights off, taking reference…');
      await this.board.allOff(); await sleep(500);
      const dark = await this.captureWall(4);
      // Sparse patterns: never more than ~sqrt(N) LEDs on at once, so a weak board power supply does not sag.
      const signals = [];
      for (let k = 0; k < F; k++) {
        const f = layout.frames[k];
        await step(1 + k, `Pattern ${k + 1} of ${F} (${f.positions.length} LEDs on)…`);
        await this.board.setLeds(f.positions.map((pos) => ({ pos, ...GREEN }))); await sleep(380);
        signals.push(await this._captureSignal(dark, 2));
      }
      await this.board.allOff();
      await step(1 + F, 'Decoding…');
      const { RW, RH, pxPerCm } = this.wallDims;
      const spots = findSpots(spotImage(layout, signals), RW, RH, pxPerCm);
      const { leds, rejected } = decodeSpots(spots, signals, layout);
      if (leds.length < 4) throw new Error(`Only ${leds.length} LEDs found. Check that the whole board is in view, that nothing covers it, and that the LEDs light up when you click a hold in the light test.`);
      // verification: a different sparse pattern must light exactly the LEDs the mapping predicts
      await step(2 + F, 'Verifying…');
      const lit = pickVerifySet(leds, 36, 7);
      await this.board.setLeds([...lit].map((pos) => ({ pos, ...GREEN }))); await sleep(380);
      const sigV = await this._captureSignal(dark, 2);
      await this.board.allOff();
      const ver = verifyMapping(leds, lit, sigV);
      const uncertain = leds.filter((l) => l.conf < 0.35).length, maxPos = leds.reduce((m, l) => Math.max(m, l.pos), 0);
      const result = { found: leds.length, rejected: rejected.length, uncertain, verifyOk: ver.ok, verifyBad: ver.bad, maxPos, range: N };
      this.set({ board: { ...this.s.board, leds: leds.map(({ pos, x, y, conf }) => ({ pos, x, y, conf })), rejected: rejected.length } });
      this.board.setKnownPositions(leds.map((l) => l.pos));
      this._rebind(); this._renumber(); this.commit();
      sc({ running: false, progress: 1, message: 'Done', result, verify: ver });
      this.saveSoon();
    } catch (e) {
      try { await this.board.allOff(); } catch { /* ignore */ }
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
    const px = this.pxPerCm, used = new Set();
    for (const l of leds) {
      let best = null, bd = Infinity;
      for (const h of this.holds) { const d = polygonDistance(h.poly, l.x, l.y); if (d < bd) { bd = d; best = h; } }
      if (best && bd <= 2.5 * px) { if (best.led == null || bd < best._ld) { if (best.led != null) used.delete(best.led); best.led = l.pos; best._ld = bd; used.add(l.pos); } }
    }
    for (const h of this.holds) delete h._ld;
    for (const l of leds) {
      if (used.has(l.pos) || this.ignoredLeds.includes(l.pos)) continue;
      const r = 2 * px;
      this.holds.push({ id: 1e6 + l.pos, cx: l.x, cy: l.y, poly: ellipsePolygon(l.x, l.y, r, r, 8), area: Math.PI * r * r, solidity: 1, diaCm: 4, source: 'led', ghost: true, led: l.pos }); // stable id: selection survives re-binding
    }
  }

  async testHold(holdId) {
    const h = this.holds.find((x) => x.id === holdId);
    if (!this.board?.connected || !h || h.led == null) { this.toast(h ? 'This hold has no LED position yet.' : 'No hold selected.'); return; }
    const on = this.s.board.testing !== holdId;
    try { await this.board.setLeds(on ? [{ pos: h.led, r: 0, g: 255, b: 0 }] : []); this.set({ board: { ...this.s.board, testing: on ? holdId : null } }); } catch (e) { this.toast(e.message, 'error'); }
  }
  async lightsOff() { try { await this.board?.allOff(); this.set({ board: { ...this.s.board, testing: null } }); } catch (e) { this.toast(e.message, 'error'); } }

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
      if (this.s.cam.kind === 'camera' || this.s.cam.kind === 'phone') await this.lockCamera(true);
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

  _liveStep(now) {
    const { width: W, height: H } = this.source, c = this.s.corners;
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
          const [wx, wy] = toWall(p);
          let f = this.filters.get(limb + i); if (!f) { f = new OneEuro2D({ minCutoff: 1.5, beta: 0.02 }); this.filters.set(limb + i, f); }
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
    return { id: s.profileId, name: s.profileName, kilter: s.kilter, wall: s.wall, corners: s.corners, camRotation: s.cam.rotation, camMirror: s.cam.mirror, holds: this.holds, suppress: this.suppress, ignoredLeds: this.ignoredLeds, nextId: this.nextId, numbering: s.numbering, numberStart: s.numberStart, detect: { sensitivity: s.detect.sensitivity, minDia: s.detect.minDia, maxDia: s.detect.maxDia }, ledCount: s.board.ledCount, leds: s.board.leds, routes: s.routes.items, snapshot: this.snapshotBlob, holdCount: this.holds.filter((h) => !h.ghost).length };
  }
  saveSoon() { this.set({ saved: false }); clearTimeout(this._saveTimer); this._saveTimer = setTimeout(() => this.saveNow(), 700); }
  async saveNow() {
    if (!this.s.profileId) return;
    try { await profiles.saveProfile(this._profileData()); this.set({ saved: true, profiles: await profiles.listProfiles() }); localStorage.setItem('bv.lastProfile', this.s.profileId); }
    catch (e) { console.warn('save failed', e); }
  }
  async _applyProfile(p) {
    this.holds = clone(p.holds || []); this.suppress = p.suppress || []; this.ignoredLeds = p.ignoredLeds || []; this.nextId = p.nextId || this.holds.reduce((m, h) => Math.max(m, h.id), 0) + 1;
    this.history = []; this.future = []; this.analysis = null; this.snapshot = null; this.snapshotBitmap = null; this.snapshotBlob = p.snapshot || null;
    if (p.snapshot instanceof Blob) { const bmp = await createImageBitmap(p.snapshot); const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; c.getContext('2d').drawImage(bmp, 0, 0); this.snapshotBitmap = c; }
    this.set({
      profileId: p.id, profileName: p.name, kilter: !!p.kilter, wall: p.wall || { wm: 3.6, hm: 3.6 }, corners: p.corners || this.s.corners, holds: this.holds, numbering: p.numbering || 'rows', numberStart: p.numberStart ?? 1, selected: null,
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
    try { if (this.board?.connected) await this.board.allOff(); } catch { /* ignore */ }
  }
  setShow(patch) { this.set({ show: { ...this.s.show, ...patch } }); if (patch.pattern && this.s.show.running) this._showT0 = performance.now(); }
  _showTick(now) {
    const sh = this.s.show, t = ((now - this._showT0) / 1000) * sh.speed;
    this.showLit = showFrame(sh.pattern, t, this.holds.filter((h) => !h.ghost), this.wallDims);
    if (this.board?.connected && !this._showBusy && now - (this._showSent || 0) > 140) {
      this._showSent = now; this._showBusy = true;
      const leds = [];
      for (const [id, col] of this.showLit) { const h = this._showById.get(id); if (h?.led != null) leds.push({ pos: h.led, ...col }); }
      // Bluetooth is slow (20 bytes per packet): send only the brightest LEDs so the animation stays fluid
      if (leds.length > MAX_SHOW_LEDS) leds.sort((a, b) => Math.max(b.r, b.g, b.b) - Math.max(a.r, a.g, a.b)).length = MAX_SHOW_LEDS;
      this.board.setLeds(leds).catch(() => {}).finally(() => { this._showBusy = false; });
    }
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
      if (this.snapshotBitmap) g.drawImage(this.snapshotBitmap, 0, 0, RW, RH);
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
