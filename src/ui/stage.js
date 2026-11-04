// The centre stage: camera view or straightened wall, overlays, and all pointer interaction.
import { Warper } from '../core/warp.js';
import { applyH, invert3, pointInPolygon } from '../core/geometry.js';
import { SKELETON } from '../pose/pose.js';

export const LIMB_COL = { LH: '#38bdf8', RH: '#f472b6', LF: '#34d399', RF: '#fbbf24' };
const CORNER_NAMES = ['TL', 'TR', 'BR', 'BL'];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export class Stage {
  constructor(el, app, store) {
    this.el = el; this.app = app; this.store = store;
    const mk = (cls) => { const c = document.createElement('canvas'); c.className = cls; el.appendChild(c); return c; };
    this.raw = mk('cv raw'); this.gl = mk('cv gl'); this.ov = mk('cv ov');
    this.pip = document.createElement('div'); this.pip.className = 'pip';
    this.pipCanvas = document.createElement('canvas'); this.pip.appendChild(this.pipCanvas);
    this.pipGrid = document.createElement('div'); this.pipGrid.className = 'pipgrid'; this.pip.appendChild(this.pipGrid);
    el.appendChild(this.pip);
    this.rctx = this.raw.getContext('2d'); this.octx = this.ov.getContext('2d');
    try { this.warper = new Warper(this.gl); } catch { this.warper = { ok: false }; }
    try { this.pipWarper = new Warper(this.pipCanvas); } catch { this.pipWarper = { ok: false }; }
    this.views = { raw: { k: 1, tx: 0, ty: 0, user: false, key: '' }, wall: { k: 1, tx: 0, ty: 0, user: false, key: '' } };
    this.w = 0; this.h = 0; this.dpr = 1;
    this.drag = null; this.hover = null; this.selCorner = null; this.rect = null; this.space = false; this.mouse = null; this.running = true;
    this._bind();
    this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(el);
    this.resize();
    const loop = () => { if (!this.running) return; this.draw(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }
  destroy() { this.running = false; this.ro.disconnect(); this._unbind?.(); this.el.innerHTML = ''; }

  resize() {
    const r = this.el.getBoundingClientRect();
    this.w = Math.max(10, r.width); this.h = Math.max(10, r.height); this.dpr = Math.min(2, window.devicePixelRatio || 1);
    for (const c of [this.raw, this.gl, this.ov]) { c.style.width = this.w + 'px'; c.style.height = this.h + 'px'; }
    this.raw.width = this.ov.width = Math.round(this.w * this.dpr); this.raw.height = this.ov.height = Math.round(this.h * this.dpr);
    this.views.raw.user = this.views.wall.user = false;
  }

  // ---------- mode & view ----------
  mode(s) {
    const app = this.app;
    const rawStep = s.mode === 'setup' && (s.step === 'camera' || s.step === 'align');
    if (app.source.active && (rawStep || !app.Himg2wall)) return 'raw';
    if (app.source.active) return 'wall';
    if (app.snapshotBitmap && s.step !== 'camera') return 'wall';
    return 'none';
  }
  content(mode) {
    if (mode === 'raw') return { W: this.app.source.width || 1280, H: this.app.source.height || 720 };
    const { RW, RH } = this.app.wallDims; return { W: RW, H: RH };
  }
  /** Size of the straightened preview shown in the align step. */
  pipSize() {
    const { RW, RH } = this.app.wallDims, pw = Math.min(280, this.w * 0.3, (this.h * 0.34 * RW) / RH), ph = pw * (RH / RW);
    return { pw, ph };
  }
  view(mode) {
    const s = this.store.get(), v = this.views[mode], { W, H } = this.content(mode);
    // in the align step the preview gets its own strip below the camera image instead of covering corner handles
    const reserve = mode === 'raw' && s.step === 'align' && s.mode === 'setup' && this.app.Himg2wall ? this.pipSize().ph + 26 : 0;
    const key = `${W}x${H}x${this.w}x${this.h}x${reserve}`;
    if (!v.user || v.key !== key) {
      const pad = mode === 'raw' ? 0.97 : 0.95, availH = this.h - reserve, k = Math.min(this.w / W, availH / H) * pad;
      v.k = k; v.tx = (this.w - W * k) / 2; v.ty = (availH - H * k) / 2; v.key = key; v.user = false; v.fit = k;
    }
    return v;
  }
  fit() { this.views.raw.user = this.views.wall.user = false; }
  toContent(v, x, y) { return [(x - v.tx) / v.k, (y - v.ty) / v.k]; }
  toScreen(v, x, y) { return [x * v.k + v.tx, y * v.k + v.ty]; }
  pos(e) { const r = this.el.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

  // ---------- drawing ----------
  draw() {
    const s = this.store.get(), app = this.app, mode = this.mode(s), ctx = this.octx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); ctx.clearRect(0, 0, this.w, this.h);
    const useSnap = mode === 'wall' && s.mode === 'setup' && s.step === 'holds' && app.snapshotBitmap;
    const showRaw = mode === 'raw', showGL = mode === 'wall' && !useSnap && app.source.active && this.warper.ok && !!app.Himg2wall;
    this.raw.style.display = showRaw ? 'block' : 'none'; this.gl.style.display = showGL ? 'block' : 'none';
    this.el.dataset.mode = mode;
    if (mode === 'none') { this.pip.style.display = 'none'; return; }
    const v = this.view(mode);
    if (showRaw) { this.rctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); this.rctx.clearRect(0, 0, this.w, this.h); const { W, H } = this.content('raw'); this.rctx.drawImage(app.source.canvas, v.tx, v.ty, W * v.k, H * v.k); }
    if (showGL) {
      const wall = app.wallDims, d = this.dpr;
      this.warper.render(app.source.canvas, app.source.width, app.source.height, app.Himg2wall, wall, { k: v.k * d, tx: v.tx * d, ty: v.ty * d }, Math.round(this.w * d), Math.round(this.h * d));
    }
    if (mode === 'wall') {
      const { RW, RH } = app.wallDims;
      if (useSnap) ctx.drawImage(app.snapshotBitmap, v.tx, v.ty, RW * v.k, RH * v.k);
      else if (!showGL) { ctx.fillStyle = '#0b0d10'; ctx.fillRect(v.tx, v.ty, RW * v.k, RH * v.k); }
      ctx.strokeStyle = 'rgba(255,255,255,.14)'; ctx.lineWidth = 1; ctx.strokeRect(v.tx + 0.5, v.ty + 0.5, RW * v.k, RH * v.k);
      this.drawWallOverlay(ctx, v, s);
    } else this.drawRawOverlay(ctx, v, s);
    this.drawPip(s, mode);
  }

  drawPip(s, mode) {
    const app = this.app, show = mode === 'raw' && s.step === 'align' && app.Himg2wall && app.source.active && this.pipWarper.ok;
    this.pip.style.display = show ? 'block' : 'none';
    if (!show) return;
    const { RW, RH } = app.wallDims, { pw, ph } = this.pipSize(), d = this.dpr;
    this.pip.style.width = pw + 'px'; this.pip.style.height = ph + 'px';
    this.pip.style.left = 'auto'; this.pip.style.top = 'auto'; this.pip.style.right = '14px'; this.pip.style.bottom = '10px';
    this.pipGrid.style.display = s.ui.grid ? 'block' : 'none';
    this.pipWarper.render(app.source.canvas, app.source.width, app.source.height, app.Himg2wall, app.wallDims, { k: (pw * d) / RW, tx: 0, ty: 0 }, Math.round(pw * d), Math.round(ph * d));
    this.pipCanvas.style.width = pw + 'px'; this.pipCanvas.style.height = ph + 'px';
  }

  drawRawOverlay(ctx, v, s) {
    const app = this.app, c = s.corners;
    if (s.step !== 'align' || !c) return;
    const P = c.map(([x, y]) => this.toScreen(v, x, y));
    // perspective-correct grid inside the quad
    const H = app.Himg2wall, { RW, RH } = app.wallDims;
    ctx.save();
    if (H && s.ui.grid) {
      const Hi = invert3(H);
      ctx.strokeStyle = 'rgba(56,189,248,.35)'; ctx.lineWidth = 1; ctx.beginPath();
      for (let i = 1; i < 10; i++) {
        const a = applyH(Hi, (RW * i) / 10, 0), b = applyH(Hi, (RW * i) / 10, RH), c2 = applyH(Hi, 0, (RH * i) / 10), d = applyH(Hi, RW, (RH * i) / 10);
        let p = this.toScreen(v, ...a); ctx.moveTo(...p); p = this.toScreen(v, ...b); ctx.lineTo(...p);
        p = this.toScreen(v, ...c2); ctx.moveTo(...p); p = this.toScreen(v, ...d); ctx.lineTo(...p);
      }
      ctx.stroke();
    }
    ctx.beginPath(); P.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath();
    ctx.fillStyle = 'rgba(56,189,248,.07)'; ctx.fill(); ctx.strokeStyle = '#38bdf8'; ctx.lineWidth = 2; ctx.stroke();
    P.forEach(([x, y], i) => {
      const sel = this.selCorner === i;
      ctx.beginPath(); ctx.arc(x, y, sel ? 10 : 8, 0, 7); ctx.fillStyle = sel ? '#ffb020' : '#0d1013'; ctx.fill(); ctx.lineWidth = 2.5; ctx.strokeStyle = sel ? '#fff' : '#38bdf8'; ctx.stroke();
      ctx.fillStyle = '#e8edf2'; ctx.font = '600 11px system-ui'; ctx.fillText(CORNER_NAMES[i], x + (i % 3 === 0 ? -26 : 14), y + (i < 2 ? -12 : 20));
    });
    ctx.restore();
    // loupe while a corner is dragged or selected-and-hovered
    if (this.drag?.type === 'corner') {
      const [ix, iy] = c[this.drag.i], [sx, sy] = P[this.drag.i], R = 70, Z = 5;
      const lx = clamp(sx + (sx > this.w - 200 ? -R - 40 : R + 40), R + 6, this.w - R - 6), ly = clamp(sy - (sy < 160 ? -R - 40 : R + 40), R + 6, this.h - R - 6);
      ctx.save(); ctx.beginPath(); ctx.arc(lx, ly, R, 0, 7); ctx.clip(); ctx.imageSmoothingEnabled = false;
      ctx.drawImage(app.source.canvas, ix - R / Z, iy - R / Z, (2 * R) / Z, (2 * R) / Z, lx - R, ly - R, 2 * R, 2 * R);
      ctx.strokeStyle = '#ffb020'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(lx - R, ly); ctx.lineTo(lx + R, ly); ctx.moveTo(lx, ly - R); ctx.lineTo(lx, ly + R); ctx.stroke(); ctx.restore();
      ctx.beginPath(); ctx.arc(lx, ly, R, 0, 7); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
    }
  }

  contactMap(s) {
    const map = new Map();
    const add = (limb, id) => { if (id == null) return; (map.get(id) || map.set(id, []).get(id)).push(limb); };
    if (s.mode === 'live' && s.live.running && this.app.liveDraw) for (const [l, id] of Object.entries(this.app.liveDraw.contacts)) add(l, id);
    else if (s.mode === 'live' && s.session.replayT != null) for (const [l, e] of Object.entries(this.app.replayContacts() || {})) add(l, e?.holdId);
    return map;
  }

  drawWallOverlay(ctx, v, s) {
    const app = this.app, holds = app.holds, live = s.mode === 'live', contacts = this.contactMap(s), tool = s.tool;
    const editing = s.mode === 'setup' && s.step === 'holds';
    for (const h of holds) {
      const hit = contacts.get(h.id), sel = editing && s.selected === h.id, hov = editing && this.hover === h.id && !this.drag;
      ctx.beginPath(); h.poly.forEach(([x, y], i) => { const p = this.toScreen(v, x, y); i ? ctx.lineTo(...p) : ctx.moveTo(...p); }); ctx.closePath();
      ctx.save();
      if (h.ghost) { ctx.setLineDash([4, 3]); ctx.strokeStyle = 'rgba(255,255,255,.5)'; ctx.lineWidth = 1.2; ctx.stroke(); }
      else if (hit) { const col = LIMB_COL[hit[0]]; ctx.shadowColor = col; ctx.shadowBlur = 16; ctx.fillStyle = col + 'aa'; ctx.fill(); ctx.shadowBlur = 0; ctx.strokeStyle = col; ctx.lineWidth = 3; ctx.stroke(); }
      else if (sel) { ctx.fillStyle = 'rgba(255,176,32,.2)'; ctx.fill(); ctx.strokeStyle = '#ffb020'; ctx.lineWidth = 2.2; ctx.stroke(); }
      else {
        const manual = h.source === 'manual';
        ctx.fillStyle = hov ? 'rgba(255,255,255,.22)' : manual ? 'rgba(163,230,53,.12)' : 'rgba(56,189,248,.10)'; if (!live) ctx.fill();
        ctx.strokeStyle = hov ? '#fff' : live ? 'rgba(56,189,248,.5)' : manual ? 'rgba(163,230,53,.95)' : 'rgba(56,189,248,.95)'; ctx.lineWidth = live ? 1.1 : 1.4; ctx.stroke();
      }
      ctx.restore();
      if (s.ui.labels && h.label != null && !h.ghost) {
        const dia = Math.sqrt(h.area) * v.k;
        if (dia >= 11 || hit) {
          const [cx, cy] = this.toScreen(v, h.cx, h.cy), fs = clamp(dia * 0.42, 8, 15);
          ctx.font = `700 ${fs}px ui-monospace, SFMono-Regular, Menlo, monospace`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.75)'; ctx.strokeText(String(h.label), cx, cy); ctx.fillStyle = '#fff'; ctx.fillText(String(h.label), cx, cy);
        }
      }
      if (hit && hit.length) { const [cx, cy] = this.toScreen(v, h.cx, h.cy - Math.sqrt(h.area) * 0.8); ctx.font = '700 11px system-ui'; ctx.textAlign = 'center'; ctx.fillStyle = LIMB_COL[hit[0]]; ctx.strokeStyle = 'rgba(0,0,0,.8)'; ctx.lineWidth = 3; const t = hit.join('+'); ctx.strokeText(t, cx, cy); ctx.fillText(t, cx, cy); }
    }
    // LED dots in the board step
    if (s.mode === 'setup' && s.step === 'board') {
      for (const l of s.board.leds) { const [x, y] = this.toScreen(v, l.x, l.y); ctx.beginPath(); ctx.arc(x, y, 2.6, 0, 7); ctx.fillStyle = l.conf < 0.35 ? '#ffb020' : '#35d07f'; ctx.fill(); }
      const t = s.board.testing && holds.find((h) => h.id === s.board.testing);
      if (t) { const [x, y] = this.toScreen(v, t.cx, t.cy); ctx.beginPath(); ctx.arc(x, y, 16, 0, 7); ctx.strokeStyle = '#35d07f'; ctx.lineWidth = 3; ctx.stroke(); }
    }
    // selected hold handles
    if (editing && s.selected != null) {
      const h = holds.find((x) => x.id === s.selected);
      if (h) { for (const [x, y] of h.poly) { const [sx, sy] = this.toScreen(v, x, y); ctx.fillStyle = '#fff'; ctx.strokeStyle = '#ffb020'; ctx.lineWidth = 2; ctx.fillRect(sx - 4, sy - 4, 8, 8); ctx.strokeRect(sx - 4, sy - 4, 8, 8); } }
    }
    // region rectangle
    if (this.rect) {
      const { a, b } = this.rect, x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), w = Math.abs(a.x - b.x), hh = Math.abs(a.y - b.y);
      ctx.save(); ctx.setLineDash([6, 4]); ctx.lineWidth = 1.5; ctx.strokeStyle = tool === 'remove' ? '#ff4757' : '#35d07f'; ctx.fillStyle = tool === 'remove' ? 'rgba(255,71,87,.12)' : 'rgba(53,208,127,.12)'; ctx.fillRect(x, y, w, hh); ctx.strokeRect(x, y, w, hh); ctx.restore();
    }
    // skeleton + limb points
    const ld = app.liveDraw;
    if (live && s.live.running && ld?.skeleton) {
      const P = ld.skeleton.map((p) => (p.v > 0.25 ? this.toScreen(v, p.x, p.y) : null));
      ctx.lineCap = 'round'; ctx.lineWidth = 3;
      for (const [a, b] of SKELETON) {
        if (!P[a] || !P[b]) continue;
        ctx.strokeStyle = a === 11 && b === 12 || a === 23 && b === 24 || (a === 11 && b === 23) || (a === 12 && b === 24) ? 'rgba(255,255,255,.55)' : (a % 2 ? 'rgba(56,189,248,.85)' : 'rgba(244,114,182,.85)');
        ctx.beginPath(); ctx.moveTo(...P[a]); ctx.lineTo(...P[b]); ctx.stroke();
      }
      for (const [limb, pts] of Object.entries(ld.limbs)) {
        if (!pts) continue;
        const [x, y] = this.toScreen(v, pts[0].x, pts[0].y);
        ctx.beginPath(); ctx.arc(x, y, 7, 0, 7); ctx.fillStyle = LIMB_COL[limb]; ctx.fill(); ctx.strokeStyle = '#0d1013'; ctx.lineWidth = 2; ctx.stroke();
      }
    }
  }

  // ---------- interaction ----------
  _bind() {
    const el = this.el;
    const down = (e) => this.onDown(e), move = (e) => this.onMove(e), up = (e) => this.onUp(e), wheel = (e) => this.onWheel(e);
    const key = (e) => this.onKey(e), keyup = (e) => { if (e.key === ' ') this.space = false; };
    const ctxm = (e) => e.preventDefault();
    el.addEventListener('pointerdown', down); el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', wheel, { passive: false }); el.addEventListener('contextmenu', ctxm); el.addEventListener('dblclick', () => this.fit());
    window.addEventListener('keydown', key); window.addEventListener('keyup', keyup);
    this._unbind = () => { window.removeEventListener('keydown', key); window.removeEventListener('keyup', keyup); };
  }
  onWheel(e) {
    const mode = this.mode(this.store.get()); if (mode === 'none') return;
    e.preventDefault();
    const v = this.view(mode), p = this.pos(e), [cx, cy] = this.toContent(v, p.x, p.y);
    const k = clamp(v.k * Math.exp(-e.deltaY * 0.0015), v.fit * 0.6, v.fit * 14);
    v.k = k; v.tx = p.x - cx * k; v.ty = p.y - cy * k; v.user = true;
  }
  onKey(e) {
    const t = e.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    const s = this.store.get(), app = this.app;
    if (e.key === ' ') { this.space = true; e.preventDefault(); }
    if (s.mode !== 'setup') return;
    if (s.step === 'align' && this.selCorner != null && s.corners && e.key.startsWith('Arrow')) {
      e.preventDefault(); const d = e.shiftKey ? 5 : 1, dx = e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0, dy = e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0;
      const c = s.corners.map((p) => p.slice()); c[this.selCorner][0] += dx; c[this.selCorner][1] += dy; app.setCorners(c); return;
    }
    if (s.step !== 'holds') return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && s.selected != null) { app.removeIds([s.selected]); e.preventDefault(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.shiftKey ? app.redo() : app.undo(); e.preventDefault(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { app.redo(); e.preventDefault(); }
    else if (e.key === 'Escape') app.select(null);
    else if (!e.ctrlKey && !e.metaKey) { if (e.key === 'v') app.setTool('select'); if (e.key === 'a') app.setTool('add'); if (e.key === 'x') app.setTool('remove'); }
  }

  onDown(e) {
    const s = this.store.get(), app = this.app, mode = this.mode(s); if (mode === 'none') return;
    this.el.setPointerCapture?.(e.pointerId);
    const p = this.pos(e), v = this.view(mode);
    this.mouse = p;
    const pan = e.button === 1 || e.button === 2 || this.space;
    if (pan) { this.drag = { type: 'pan', last: p, mode }; return; }
    if (mode === 'raw' && s.step === 'align' && s.corners) {
      let best = -1, bd = 18;
      s.corners.forEach(([x, y], i) => { const [sx, sy] = this.toScreen(v, x, y), d = Math.hypot(sx - p.x, sy - p.y); if (d < bd) { bd = d; best = i; } });
      if (best >= 0) { this.selCorner = best; this.drag = { type: 'corner', i: best }; return; }
      this.drag = { type: 'pan', last: p, mode }; return;
    }
    if (mode !== 'wall') return;
    const [wx, wy] = this.toContent(v, p.x, p.y);
    if (s.mode === 'setup' && s.step === 'holds') {
      if (s.tool === 'select') {
        const sel = s.selected != null ? app.holds.find((h) => h.id === s.selected) : null;
        if (sel) {
          for (let i = 0; i < sel.poly.length; i++) { const [sx, sy] = this.toScreen(v, ...sel.poly[i]); if (Math.hypot(sx - p.x, sy - p.y) < 10) { this.drag = { type: 'vertex', id: sel.id, i, moved: false }; return; } }
        }
        const hit = app.hitTest(wx, wy);
        if (hit) { app.select(hit.id); this.drag = { type: 'move', id: hit.id, last: [wx, wy], moved: false }; }
        else { app.select(null); this.drag = { type: 'pan', last: p, mode }; }
      } else { this.drag = { type: 'region', a: p, tool: s.tool }; this.rect = { a: p, b: p }; }
    } else if (s.mode === 'setup' && s.step === 'board') {
      const hit = app.hitTest(wx, wy);
      if (hit) { app.select(hit.id); app.testHold(hit.id); }
    }
  }
  onMove(e) {
    const s = this.store.get(), app = this.app, mode = this.mode(s); if (mode === 'none') return;
    const p = this.pos(e), v = this.view(mode); this.mouse = p;
    const d = this.drag;
    if (!d) {
      if (mode === 'wall' && s.mode === 'setup' && (s.step === 'holds' || s.step === 'board')) { const [wx, wy] = this.toContent(v, p.x, p.y), h = app.hitTest(wx, wy); this.hover = h?.id ?? null; this.el.style.cursor = s.step === 'board' ? (h ? 'pointer' : 'default') : s.tool === 'select' ? (h ? 'move' : 'grab') : 'crosshair'; }
      else if (mode === 'raw' && s.step === 'align' && s.corners) { const near = s.corners.some(([x, y]) => { const [sx, sy] = this.toScreen(v, x, y); return Math.hypot(sx - p.x, sy - p.y) < 18; }); this.el.style.cursor = near ? 'pointer' : 'grab'; }
      else this.el.style.cursor = 'default';
      return;
    }
    if (d.type === 'pan') { const vv = this.view(d.mode); vv.tx += p.x - d.last.x; vv.ty += p.y - d.last.y; vv.user = true; d.last = p; }
    else if (d.type === 'corner') {
      const [ix, iy] = this.toContent(v, p.x, p.y), W = app.source.width, H = app.source.height;
      const c = s.corners.map((q) => q.slice()); c[d.i] = [clamp(ix, 0, W), clamp(iy, 0, H)]; app.setCorners(c, { save: false }); d.moved = true;
    } else if (d.type === 'vertex') { const [wx, wy] = this.toContent(v, p.x, p.y); app.editHold(d.id, (h) => { h.poly[d.i] = [wx, wy]; }); d.moved = true; }
    else if (d.type === 'move') { const [wx, wy] = this.toContent(v, p.x, p.y), dx = wx - d.last[0], dy = wy - d.last[1]; if (Math.hypot(dx, dy) > 0) { app.editHold(d.id, (h) => { h.poly = h.poly.map(([x, y]) => [x + dx, y + dy]); }); d.last = [wx, wy]; d.moved = true; } }
    else if (d.type === 'region') this.rect.b = p;
  }
  onUp(e) {
    const s = this.store.get(), app = this.app, d = this.drag; this.drag = null;
    if (!d) return;
    const mode = this.mode(s), v = mode === 'none' ? null : this.view(mode), p = this.pos(e);
    if (d.type === 'corner' && d.moved) app.saveSoon();
    if ((d.type === 'vertex' || d.type === 'move') && d.moved) app.endEdit();
    if (d.type === 'region') {
      const moved = Math.hypot(p.x - d.a.x, p.y - d.a.y) > 6; this.rect = null;
      const [ax, ay] = this.toContent(v, d.a.x, d.a.y), [bx, by] = this.toContent(v, p.x, p.y);
      if (!moved) {
        if (d.tool === 'add') app.addAt(bx, by);
        else { const h = app.hitTest(bx, by); if (h) app.removeIds([h.id]); }
      } else {
        const r = { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) };
        if (d.tool === 'add') app.addInRegion(r); else app.removeInRegion(r);
      }
    }
  }
}
