import { html, render } from 'htm/preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { app, store } from '../app/controller.js';
import { useStore } from '../store/store.js';
import { Stage, LIMB_COL } from './stage.js';
import { NUMBERING_MODES } from '../core/numbering.js';
import { BleTransport } from '../board/aurora.js';
import { SerialSink } from '../outputs/sinks.js';
import { qrSvg } from '../core/phone.js';
import { SHOWS, ROLES } from '../outputs/lightshow.js';

const S = (sel) => useStore(store, sel);
const STEPS = [
  { id: 'camera', label: 'Camera' }, { id: 'align', label: 'Align' }, { id: 'holds', label: 'Holds' },
  { id: 'board', label: 'Board', kilter: true }, { id: 'ready', label: 'Go live' },
];

// ---------- small building blocks ----------
const Section = ({ title, hint, children, right }) => html`<section class="sec"><div class="sec-h"><h3>${title}</h3>${right}</div>${hint && html`<p class="hint">${hint}</p>`}${children}</section>`;
const Btn = ({ children, kind = '', ...p }) => html`<button class=${`btn ${kind}`} ...${p}>${children}</button>`;
const Slider = ({ label, value, min, max, step = 1, onInput, fmt = (v) => v, lo, hi }) => html`
  <label class="slider"><div class="sl-top"><span>${label}</span><b>${fmt(value)}</b></div>
  <input type="range" min=${min} max=${max} step=${step} value=${value} onInput=${(e) => onInput(+e.target.value)} />
  ${(lo || hi) && html`<div class="sl-ends"><span>${lo}</span><span>${hi}</span></div>`}</label>`;
const Seg = ({ options, value, onChange }) => html`<div class="seg">${options.map((o) => html`<button class=${value === o.id ? 'on' : ''} onClick=${() => onChange(o.id)} title=${o.title || ''}>${o.label}</button>`)}</div>`;
const Dot = ({ state }) => html`<i class=${`dot ${state}`}></i>`;

// ---------- header ----------
function Chip({ state, label, detail }) { return html`<div class="chip"><${Dot} state=${state} /><span>${label}</span>${detail && html`<em>${detail}</em>`}</div>`; }

function Header() {
  const st = S((s) => s);
  const cam = st.cam, live = st.live, b = st.board;
  const camState = cam.status === 'on' ? 'ok' : cam.status === 'starting' ? 'warn' : cam.status === 'error' ? 'bad' : 'off';
  const boardState = b.state === 'connected' ? 'ok' : b.state === 'connecting' ? 'warn' : 'off';
  const poseState = live.running ? 'ok' : live.loading ? 'warn' : 'off';
  const badge = st.mode === 'live' ? (live.running ? 'LIVE' : 'REVIEW') : st.step === 'holds' ? 'EDIT' : 'SETUP';
  return html`<header class="top">
    <div class="brand"><svg viewBox="0 0 24 24" width="22" height="22"><path d="M3 20 L10 7 L14 14 L17 9 L21 20 Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg><span>BoulderVision</span></div>
    <${ProfileMenu} />
    <label class="switch" title="Adds the LED board step and live LED output"><input type="checkbox" checked=${st.kilter} onChange=${(e) => app.setKilter(e.target.checked)} /><span class="sw"></span><span>Kilter mode</span></label>
    <div class="grow"></div>
    <div class="chips">
      <${Chip} state=${camState} label="Camera" detail=${cam.status === 'on' ? `${cam.width}×${cam.height}${cam.fps ? ` · ${cam.fps} fps` : ''}` : ''} />
      <${Chip} state=${poseState} label="Pose" detail=${live.running ? `${live.activeVariant} · ${live.fps} fps · ${live.latency} ms` : live.loading ? 'loading…' : ''} />
      ${st.kilter && html`<${Chip} state=${boardState} label="Board" detail=${b.state === 'connected' ? b.name : ''} />`}
    </div>
    <div class=${`badge ${badge.toLowerCase()}`}>${badge === 'LIVE' && html`<i></i>`}${badge}</div>
    <div class="tabs"><button class=${st.mode === 'setup' ? 'on' : ''} onClick=${() => app.leaveLive()}>Setup</button><button class=${st.mode === 'live' ? 'on' : ''} onClick=${() => (st.mode === 'live' ? null : app.startLive())}>Live</button></div>
  </header>`;
}

function ProfileMenu() {
  const st = S((s) => s);
  const [open, setOpen] = useState(false);
  const fileRef = useRef();
  useEffect(() => { const f = (e) => { if (!e.target.closest?.('.pm')) setOpen(false); }; window.addEventListener('pointerdown', f); return () => window.removeEventListener('pointerdown', f); }, []);
  return html`<div class="pm">
    <button class="btn ghost" onClick=${() => setOpen(!open)}>${st.profileName}<small>${st.saved ? 'saved' : 'saving…'}</small> ▾</button>
    ${open && html`<div class="menu">
      <label class="field"><span>Board name</span><input value=${st.profileName} onChange=${(e) => app.renameProfile(e.target.value)} /></label>
      <div class="menu-list">${st.profiles.map((p) => html`<div class=${`menu-item ${p.id === st.profileId ? 'on' : ''}`}><button onClick=${() => { app.loadProfile(p.id); setOpen(false); }}>${p.name}<small>${p.holdCount || 0} holds</small></button>${st.profiles.length > 1 && html`<button class="x" title="Delete" onClick=${() => confirm(`Delete "${p.name}"?`) && app.deleteProfile(p.id)}>✕</button>`}</div>`)}</div>
      <div class="menu-actions">
        <${Btn} onClick=${() => { app.newProfile('New wall'); setOpen(false); }}>New board<//>
        <${Btn} onClick=${() => app.exportProfileFile()}>Export<//>
        <${Btn} onClick=${() => fileRef.current.click()}>Import<//>
        <input ref=${fileRef} type="file" accept=".json" hidden onChange=${(e) => { app.importProfileFile(e.target.files[0]); setOpen(false); }} />
      </div></div>`}
  </div>`;
}

// ---------- left panel: setup steps ----------
function Stepper() {
  const st = S((s) => s);
  const nHolds = st.holds.filter((h) => !h.ghost).length;
  const done = { camera: st.cam.status === 'on', align: !!st.corners && st.cam.status === 'on', holds: nHolds > 0, board: st.board.leds.length > 0, ready: false };
  const meta = { camera: st.cam.status === 'on' ? st.cam.label.slice(0, 22) : 'choose source', align: st.corners ? `${st.wall.wm}×${st.wall.hm} m` : 'mark corners', holds: nHolds ? `${nHolds} holds` : 'detect', board: st.board.leds.length ? `${st.board.leds.length} LEDs` : st.board.state === 'connected' ? 'scan LEDs' : 'connect', ready: 'start' };
  const steps = STEPS.filter((s) => !s.kilter || st.kilter);
  return html`<nav class="steps">${steps.map((s, i) => html`<button class=${`step ${st.step === s.id && st.mode === 'setup' ? 'on' : ''} ${done[s.id] ? 'done' : ''}`} onClick=${() => app.goStep(s.id)}><span class="num">${done[s.id] ? '✓' : i + 1}</span><span class="lbl"><b>${s.label}</b><small>${meta[s.id]}</small></span></button>`)}</nav>`;
}

function NextBtn({ to, label = 'Continue', disabled }) { return html`<${Btn} kind="primary wide" disabled=${disabled} onClick=${() => app.goStep(to)}>${label} →<//>`; }

function CameraStep() {
  const st = S((s) => s);
  const cam = st.cam, ph = st.phone;
  const [tab, setTab] = useState(cam.kind === 'phone' ? 'phone' : 'cam');
  const fileRef = useRef();
  const insecure = !window.isSecureContext;
  return html`<div class="step-body">
    ${insecure && html`<div class="note warn">Camera and Bluetooth need HTTPS or localhost. This page is served insecurely.</div>`}
    <${Seg} value=${tab} onChange=${setTab} options=${[{ id: 'cam', label: 'Webcam / USB' }, { id: 'phone', label: 'Phone (QR)' }, { id: 'file', label: 'File' }, { id: 'demo', label: 'Demo' }]} />
    ${tab === 'cam' && html`<div>
      <p class="hint">Works with any device that shows up as a camera: USB webcams, phones in USB-webcam mode, Continuity Camera, DroidCam, Iriun, OBS Virtual Camera.</p>
      <label class="field"><span>Camera</span><select value=${cam.deviceId} onChange=${(e) => app.useCamera(e.target.value)}><option value="">Default camera</option>${cam.devices.map((d) => html`<option value=${d.id}>${d.label}</option>`)}</select></label>
      <label class="field"><span>Resolution</span><select value=${cam.res} onChange=${(e) => app.setRes(+e.target.value)}><option value="720">720p (fast)</option><option value="1080">1080p (recommended)</option><option value="2160">4K (if supported)</option></select></label>
      <${Btn} kind="primary wide" onClick=${() => app.useCamera()}>${cam.kind === 'camera' ? 'Restart camera' : 'Start camera'}<//>
    </div>`}
    ${tab === 'phone' && html`<div>
      <p class="hint">No cable or app needed. Open the link or scan the QR code with the phone, allow the camera, tap <i>Start streaming</i>. Pairing needs internet; the video goes directly phone to laptop.</p>
      <label class="field"><span>App address the phone should open</span>
        ${ph.lan?.ips?.length > 1 ? html`<select value=${ph.baseUrl} onChange=${(e) => app.setPhoneBase(e.target.value)}>${ph.lan.ips.map((ip) => html`<option value=${`${ph.lan.protocol}://${ip}:${ph.lan.port}/`}>${ip}</option>`)}<option value=${ph.baseUrl}>${ph.baseUrl}</option></select>` : html`<input value=${ph.baseUrl} onChange=${(e) => app.setPhoneBase(e.target.value)} />`}</label>
      ${/localhost|127\.0\.0\.1/.test(ph.baseUrl) && html`<div class="note warn">A phone cannot open "localhost". Start the app with <b>npm run dev:phone</b> (the address is filled in automatically) or enter the address of a hosted copy.</div>`}
      ${!/localhost|127\.0\.0\.1/.test(ph.baseUrl) && ph.baseUrl.startsWith('http:') && html`<div class="note warn">Phones only allow the camera on <b>https</b>. Stop the server and run <b>npm run dev:phone</b>. The phone will show a certificate warning once: choose "Advanced" and continue.</div>`}
      ${ph.lan && html`<p class="hint">Phone and laptop must be on the same Wi-Fi. If the page does not load, allow Node.js on private networks in the Windows firewall prompt.</p>`}
      ${ph.state === 'off' || ph.state === 'error' ? html`<${Btn} kind="primary wide" onClick=${() => app.startPhone()}>Create pairing code<//>` : html`<div class="qr" dangerouslySetInnerHTML=${{ __html: ph.url ? qrSvg(ph.url) : '' }}></div>`}
      <div class="note">${{ off: '', starting: 'Contacting the pairing server…', 'waiting-broker': 'Contacting the pairing server…', 'waiting-phone': 'Waiting for the phone…', streaming: 'Phone connected.', closed: 'Phone disconnected.', 'broker-lost': 'Pairing server connection lost.', error: `Pairing failed: ${ph.detail}` }[ph.state]}</div>
      ${ph.url && html`<input class="mono small" readonly value=${ph.url} onFocus=${(e) => e.target.select()} />`}
    </div>`}
    ${tab === 'file' && html`<div><p class="hint">Use a video or photo of the wall instead of a live camera. Great for trying the app away from the gym.</p><${Btn} kind="primary wide" onClick=${() => fileRef.current.click()}>Choose video or photo…<//><input ref=${fileRef} type="file" accept="video/*,image/*" hidden onChange=${(e) => e.target.files[0] && app.useFile(e.target.files[0])} /></div>`}
    ${tab === 'demo' && html`<div><p class="hint">A simulated wall with a virtual LED board and a virtual climber. Walks through the complete workflow without any hardware.</p><${Btn} kind="primary wide" onClick=${() => app.startDemo()}>Start demo wall<//></div>`}
    ${cam.error && html`<div class="note bad">${cam.error}</div>`}
    ${cam.status === 'on' && html`<${Section} title="Image">
      <div class="row"><${Btn} onClick=${() => app.setOrientation({ rotation: (cam.rotation + 90) % 360 })}>Rotate 90° ↻<//><${Btn} kind=${cam.mirror ? 'active' : ''} onClick=${() => app.setOrientation({ mirror: !cam.mirror })}>Mirror<//></div>
      ${(cam.kind === 'camera' || cam.kind === 'phone') && html`<label class="check"><input type="checkbox" checked=${cam.locked} onChange=${(e) => app.lockCamera(e.target.checked)} /><span>Lock exposure / white balance / focus</span></label>`}
      ${cam.lockMsg && html`<p class="hint">${cam.lockMsg}</p>`}
      <p class="hint">Put the tripod in front of the wall so the whole board is in view. Straight-on is best, but slightly off-centre is fine: the next step straightens it.</p>
    <//>`}
    <${NextBtn} to="align" disabled=${cam.status !== 'on'} />
  </div>`;
}

function AlignStep() {
  const st = S((s) => s);
  const [w, setW] = useState(st.wall.wm), [h, setH] = useState(st.wall.hm);
  useEffect(() => { setW(st.wall.wm); setH(st.wall.hm); }, [st.wall.wm, st.wall.hm, st.profileId]);
  const canAuto = st.kilter && st.board.leds.length >= 8 && st.board.state === 'connected';
  return html`<div class="step-body">
    <${Section} title="Mark the wall corners" hint="Drag the four handles onto the corners of the climbing surface. Zoom with the wheel. Hold the handle for a magnified loupe; arrow keys nudge the selected corner. The small preview shows the straightened wall: the grid lines should run exactly along rows and columns of holds.">
      <div class="row"><${Btn} onClick=${() => app.setCorners(app.defaultCorners())}>Reset corners<//><${Btn} kind=${st.ui.grid ? 'active' : ''} onClick=${() => app.setUi({ grid: !st.ui.grid })}>Grid<//></div>
    <//>
    <${Section} title="Wall size" hint="Real size of the climbing surface. Used to convert pixels to centimetres (hold size filters, contact tolerance).">
      <div class="row2">
        <label class="field"><span>Width (m)</span><input type="number" step="0.1" min="0.5" max="20" value=${w} onInput=${(e) => { setW(e.target.value); app.setWall({ wm: +e.target.value }); }} /></label>
        <label class="field"><span>Height (m)</span><input type="number" step="0.1" min="0.5" max="20" value=${h} onInput=${(e) => { setH(e.target.value); app.setWall({ hm: +e.target.value }); }} /></label>
      </div>
      <div class="row"><${Btn} onClick=${() => app.setWall({ wm: 3.6, hm: 3.6 })}>12×12 ft<//><${Btn} onClick=${() => app.setWall({ wm: 2.4, hm: 3.6 })}>8×12 ft<//><${Btn} onClick=${() => app.setWall({ wm: 3, hm: 3 })}>3×3 m<//></div>
    <//>
    ${st.kilter && html`<${Section} title="Auto-align with LEDs" hint="Quick re-setup: flashes a few known LEDs and computes the corners itself. Needs a finished LED scan.">
      <${Btn} disabled=${!canAuto || st.board.align.running || st.board.scan.running} onClick=${() => app.autoAlign()}>${st.board.align.running ? 'Aligning…' : 'Align automatically'}<//>
      ${st.board.align.message && html`<p class="hint">${st.board.align.message}</p>`}
    <//>`}
    <${NextBtn} to="holds" disabled=${!st.corners} />
  </div>`;
}

function HoldsStep() {
  const st = S((s) => s);
  const d = st.detect, n = st.holds.filter((h) => !h.ghost).length;
  const tools = [{ id: 'select', label: 'Select', title: 'V: select, move, reshape' }, { id: 'add', label: 'Add', title: 'A: click a hold, or drag an area to search it' }, { id: 'remove', label: 'Remove', title: 'X: click a hold, or drag over false detections' }];
  const hints = { select: 'Click a hold to select it. Drag it to move; drag a white corner to reshape. Delete removes it.', add: 'Click on a hold to add it (the edge is found automatically). Drag a rectangle to search that area more sensitively.', remove: 'Click a false detection to remove it, or drag a rectangle over several.' };
  return html`<div class="step-body">
    <${Btn} kind="primary wide" disabled=${d.busy} onClick=${() => app.runDetect()}>${d.busy ? 'Working…' : n ? 'Detect again' : 'Detect holds'}<//>
    ${d.message && html`<p class="hint center">${d.message}</p>`}
    <${Section} title="Detection filters">
      <${Slider} label="Sensitivity" value=${d.sensitivity} min=${0} max=${1} step=${0.01} fmt=${(v) => `${Math.round(v * 100)}%`} lo="fewer holds" hi="more holds" onInput=${(v) => app.setDetectParam({ sensitivity: v })} />
      <${Slider} label="Ignore smaller than" value=${d.minDia} min=${0} max=${10} step=${0.5} fmt=${(v) => (v === 0 ? `Auto (${d.effMin || '–'} cm)` : `${v} cm`)} lo="auto: relative to typical hold" onInput=${(v) => app.setDetectParam({ minDia: v })} />
      <${Slider} label="Ignore larger than" value=${d.maxDia} min=${10} max=${60} step=${1} fmt=${(v) => `${v} cm`} onInput=${(v) => app.setDetectParam({ maxDia: v })} />
    <//>
    <${Section} title="Clean up" right=${html`<span class="undo"><button disabled=${!st.canUndo} onClick=${() => app.undo()} title="Ctrl+Z">↶</button><button disabled=${!st.canRedo} onClick=${() => app.redo()} title="Ctrl+Y">↷</button></span>`}>
      <${Seg} value=${st.tool} onChange=${(t) => app.setTool(t)} options=${tools} />
      <p class="hint">${hints[st.tool]}</p>
    <//>
    <${Section} title="Numbering">
      <label class="field"><select value=${st.numbering} onChange=${(e) => app.setNumbering(e.target.value)}>${NUMBERING_MODES.filter((m) => m.id !== 'led' || st.kilter).map((m) => html`<option value=${m.id}>${m.label}</option>`)}</select></label>
      <label class="check"><input type="checkbox" checked=${st.ui.labels} onChange=${(e) => app.setUi({ labels: e.target.checked })} /><span>Show numbers</span></label>
    <//>
    <${NextBtn} to=${st.kilter ? 'board' : 'ready'} disabled=${!n} />
    <${ExportCard} />
  </div>`;
}

function ExportCard() {
  const st = S((s) => s);
  const n = st.holds.filter((h) => !h.ghost).length;
  return html`<${Section} title="Export" hint="Save this board: the wall, every marked hold with its number and LED. The board file can be re-imported from the profile menu.">
    <div class="row"><${Btn} disabled=${!n} onClick=${() => app.exportImage()}>Image (PNG)<//><${Btn} disabled=${!n} onClick=${() => app.exportHoldsCsv()}>Hold list (CSV)<//></div>
    <div class="row"><${Btn} disabled=${!n} onClick=${() => app.exportHolds()}>Hold map (JSON)<//><${Btn} onClick=${() => app.exportProfileFile()}>Board file<//></div>
  <//>`;
}

function RoutePanel() {
  const st = S((s) => s);
  const r = st.routes, active = r.items.find((i) => i.id === r.active), count = active ? Object.keys(active.roles).length : 0;
  const counts = {}; if (active) for (const role of Object.values(active.roles)) counts[role] = (counts[role] || 0) + 1;
  return html`<div class="sec">
    <p class="hint">Pick a role, then click holds in the wall view. Click again to remove. The board shows the route live, like the Kilter app.</p>
    <div class="roles">${Object.entries(ROLES).map(([k, v]) => html`<button class=${r.brush === k ? 'on' : ''} style=${{ '--c': v.css }} onClick=${() => app.setBrush(k)}><i></i>${v.label}${counts[k] ? html`<b>${counts[k]}</b>` : ''}</button>`)}</div>
    <div class="row"><select value=${r.active || ''} onChange=${(e) => app.selectRoute(e.target.value)} style="flex:1">${r.items.length ? r.items.map((i) => html`<option value=${i.id}>${i.name}</option>`) : html`<option value="">No route yet</option>`}</select><${Btn} onClick=${() => app.newRoute()}>New<//></div>
    ${active && html`<label class="field"><span>Name</span><input value=${active.name} onChange=${(e) => app.renameRoute(e.target.value)} /></label>`}
    <label class="check"><input type="checkbox" checked=${r.sync} onChange=${(e) => app.setRouteSync(e.target.checked)} /><span>Light the route on the board while editing</span></label>
    <div class="row"><${Btn} disabled=${!count} onClick=${() => app.clearRoute()}>Clear<//><${Btn} disabled=${!active} kind="danger" onClick=${() => confirm('Delete this route?') && app.deleteRoute(active.id)}>Delete<//><${Btn} disabled=${!r.items.length} onClick=${() => app.exportRoutes()}>Export<//></div>
  </div>`;
}

function ShowPanel() {
  const st = S((s) => s);
  const sh = st.show, connected = st.board.state === 'connected';
  return html`<div class="sec">
    <p class="hint">Plays on the board and in the wall view, so you can try it without a board too. Bluetooth is slow, so the board shows the 36 brightest LEDs per frame.</p>
    <label class="field"><span>Pattern</span><select value=${sh.pattern} onChange=${(e) => app.setShow({ pattern: e.target.value })}>${SHOWS.map((x) => html`<option value=${x.id}>${x.label}</option>`)}</select></label>
    <${Slider} label="Speed" value=${sh.speed} min=${0.3} max=${3} step=${0.1} fmt=${(v) => `${v.toFixed(1)}×`} onInput=${(v) => app.setShow({ speed: v })} />
    ${sh.running ? html`<${Btn} kind="danger wide" onClick=${() => app.stopShow()}>Stop<//>` : html`<${Btn} kind="primary wide" disabled=${!st.holds.length} onClick=${() => app.startShow()}>Play${connected ? ' on board' : ''}<//>`}
    <div class="legend"><span><i style="background:#2aa3ff"></i>hands</span><span><i style="background:#ffa31a"></i>feet</span><span><i style="background:#22e06b"></i>start</span><span><i style="background:#f046ff"></i>finish</span></div>
  </div>`;
}

function BoardStep() {
  const st = S((s) => s);
  const b = st.board, sc = b.scan, connected = b.state === 'connected', res = sc.result;
  const verifyPct = res && res.verifyOk + res.verifyBad ? Math.round((100 * res.verifyOk) / (res.verifyOk + res.verifyBad)) : null;
  return html`<div class="step-body">
    ${!BleTransport.supported() && !st.demo && html`<div class="note bad">Web Bluetooth is not available in this browser. Use Chrome or Edge.</div>`}
    <${Section} title="Connection">
      <div class="card row between"><div><${Dot} state=${connected ? 'ok' : b.state === 'connecting' ? 'warn' : 'off'} /> ${connected ? b.name : b.state === 'connecting' ? 'Connecting…' : 'Not connected'}</div>
      ${connected ? html`<${Btn} onClick=${() => app.disconnectBoard()}>Disconnect<//>` : html`<${Btn} kind="primary" onClick=${() => app.connectBoard()}>Connect board<//>`}</div>
    <//>
    <${Section} title="Find LED positions" hint="Every LED lights in a coded pattern while the camera watches. This assigns each hold its LED and takes about a minute. Keep the wall free of people.">
      <label class="field"><span>Highest LED position + 1</span><input type="number" min="8" max="1500" step="1" value=${b.ledCount} onChange=${(e) => app.setLedCount(+e.target.value)} /></label>
      <div class="row"><${Btn} onClick=${() => app.setLedCount(200)}>200<//><${Btn} onClick=${() => app.setLedCount(300)}>300<//><${Btn} onClick=${() => app.setLedCount(500)}>500<//><${Btn} onClick=${() => app.setLedCount(600)}>600<//></div>
      ${sc.running ? html`<div class="progress"><div style=${{ width: `${Math.round(sc.progress * 100)}%` }}></div></div><p class="hint center">${sc.message}</p><${Btn} kind="wide" onClick=${() => app.cancelScan()}>Cancel<//>` : html`<${Btn} kind="primary wide" disabled=${!connected || b.align.running} onClick=${() => app.scanLeds()}>${b.leds.length ? 'Scan again' : 'Scan LEDs'}<//>`}
      ${!sc.running && sc.message && !res && html`<p class="hint center">${sc.message}</p>`}
      ${res && html`<div class="card"><b>${res.found} LEDs located</b> · ${st.holds.filter((h) => h.led != null && !h.ghost).length} matched to holds
        ${verifyPct != null && html`<div class=${verifyPct >= 97 ? 'ok-t' : 'warn-t'}>Verification: ${verifyPct}% of LEDs behaved as predicted</div>`}
        ${(res.rejected > Math.max(3, res.found * 0.1) || res.uncertain > 0) && html`<div class="warn-t">${res.rejected > Math.max(3, res.found * 0.1) ? `${res.rejected} unreadable spots ignored` : ''}${res.rejected > Math.max(3, res.found * 0.1) && res.uncertain ? ', ' : ''}${res.uncertain ? `${res.uncertain} low confidence (amber dots)` : ''}</div>`}
        ${st.holds.some((h) => h.ghost) && html`<div class="hint">${st.holds.filter((h) => h.ghost).length} LEDs have no detected hold. They show as dashed circles; use "Add" in Holds if one is real.</div>`}</div>`}
    <//>
    <${Section} title="Use the board">
      <${Seg} value=${st.kilterTab} onChange=${(t) => app.setKilterTab(t)} options=${[{ id: 'test', label: 'Light test' }, { id: 'route', label: 'Routes' }, { id: 'show', label: 'Light show' }]} />
      ${st.kilterTab === 'test' && html`<div><p class="hint">Click any hold in the wall view: its LED lights up on the board. This is the quickest way to confirm the mapping.</p><${Btn} disabled=${!connected} onClick=${() => app.lightsOff()}>All lights off<//></div>`}
      ${st.kilterTab === 'route' && html`<${RoutePanel} />`}
      ${st.kilterTab === 'show' && html`<${ShowPanel} />`}
    <//>
    <${ExportCard} />
    <${NextBtn} to="ready" />
  </div>`;
}

function ReadyStep() {
  const st = S((s) => s);
  const n = st.holds.filter((h) => !h.ghost).length;
  const items = [
    { ok: st.cam.status === 'on', t: 'Camera', d: st.cam.status === 'on' ? st.cam.label : 'No camera running' },
    { ok: !!st.corners, t: 'Wall alignment', d: st.corners ? `${st.wall.wm} × ${st.wall.hm} m` : 'Corners not marked' },
    { ok: n > 0, t: 'Holds', d: n ? `${n} holds` : 'None detected' },
    ...(st.kilter ? [{ ok: st.board.state === 'connected', t: 'Board', d: st.board.state === 'connected' ? `${st.board.name} · ${st.board.leds.length} LEDs mapped` : 'Not connected (live view still works)', soft: true }] : []),
  ];
  const ready = items.every((i) => i.ok || i.soft);
  return html`<div class="step-body">
    <${Section} title="Ready check">${items.map((i) => html`<div class="check-row"><${Dot} state=${i.ok ? 'ok' : i.soft ? 'warn' : 'bad'} /><div><b>${i.t}</b><small>${i.d}</small></div></div>`)}<//>
    <p class="hint">Only one person at a time is tracked. Stand clear of the wall until the skeleton locks on, then climb.</p>
    <${Btn} kind="primary wide big" disabled=${!ready} onClick=${() => app.startLive()}>Start live tracking<//>
    <${ExportCard} />
  </div>`;
}

// ---------- left panel: live ----------
function LivePanel() {
  const st = S((s) => s);
  const l = st.live, connected = st.board.state === 'connected';
  return html`<div class="step-body">
    ${l.running || l.loading ? html`<${Btn} kind="danger wide big" onClick=${() => app.stopLive()}>${l.loading ? 'Loading model…' : 'Stop'}<//>` : html`<${Btn} kind="primary wide big" onClick=${() => app.startLive()}>Start again<//><${Btn} kind="wide" onClick=${() => app.leaveLive()}>Back to setup<//>`}
    ${l.running && html`<div class=${`note ${l.person ? 'ok' : 'warn'}`}>${l.person ? 'Climber tracked' : 'No climber detected'}</div>`}
    ${l.error && html`<div class="note bad">${l.error}</div>`}
    <${Section} title="Tracking">
      <label class="field"><span>Pose model</span><select value=${l.variant} onChange=${(e) => app.setVariant(e.target.value)} disabled=${st.demo}><option value="auto">Auto (best that runs smoothly)</option><option value="heavy">Heavy · most accurate</option><option value="full">Full · balanced</option><option value="lite">Lite · fastest</option></select></label>
      ${l.running && html`<p class="hint">Running: ${l.activeVariant} (${l.delegate}) · ${l.fps} fps · ${l.latency} ms per frame</p>`}
      <${Slider} label="Contact tolerance" value=${l.tolCm} min=${0.5} max=${6} step=${0.5} fmt=${(v) => `${v} cm`} lo="strict" hi="forgiving" onInput=${(v) => app.setLive({ tolCm: v })} />
      <label class="field"><span>Climber faces</span><select value=${l.facing} onChange=${(e) => app.setLive({ facing: e.target.value })}><option value="wall">The wall (camera behind)</option><option value="camera">The camera</option></select></label>
      <label class="check"><input type="checkbox" checked=${l.swapLR} onChange=${(e) => app.setLive({ swapLR: e.target.checked })} /><span>Swap left / right</span></label>
    <//>
    ${st.kilter && html`<${Section} title="Board output">
      <label class="check"><input type="checkbox" checked=${l.lightBoard} disabled=${!connected} onChange=${(e) => app.setLive({ lightBoard: e.target.checked })} /><span>Light the holds hands and feet are on</span></label>
      ${!connected && html`<p class="hint">Connect the board in the Setup → Board step first.</p>`}
      <div class="legend"><span><i style="background:#00ffff"></i>hands</span><span><i style="background:#ff8c00"></i>feet</span></div>
    <//>`}
  </div>`;
}

// ---------- right panel ----------
function Inspector() {
  const st = S((s) => s);
  const h = st.selected != null ? st.holds.find((x) => x.id === st.selected) : null;
  const holds = st.holds.filter((x) => !x.ghost), auto = holds.filter((x) => x.source === 'auto').length;
  return html`<div class="step-body">
    ${st.step === 'holds' && html`<${Section} title="Selected hold">
      ${h ? html`<div class="card"><div class="kv"><span>Number</span><b>${h.label ?? '–'}</b></div><div class="kv"><span>Size</span><b>${(h.diaCm || 0).toFixed(1)} cm</b></div>${h.led != null && html`<div class="kv"><span>LED</span><b>${h.led}</b></div>`}<div class="kv"><span>Origin</span><b>${h.ghost ? 'LED only' : h.source}</b></div></div>
        <div class="row"><${Btn} onClick=${() => app.scaleHold(h.id, 1.1)}>Grow<//><${Btn} onClick=${() => app.scaleHold(h.id, 0.9)}>Shrink<//><${Btn} kind="danger" onClick=${() => app.removeIds([h.id])}>Delete<//></div>
        ${h.ghost && html`<${Btn} kind="wide" onClick=${() => app.setHoldGhost(h.id, false)}>Treat as a hold<//>`}` : html`<p class="hint">Nothing selected.</p>`}
    <//>`}
    <${Section} title="Overview"><div class="card"><div class="kv"><span>Holds</span><b>${holds.length}</b></div><div class="kv"><span>Auto-detected</span><b>${auto}</b></div><div class="kv"><span>Added / edited</span><b>${holds.length - auto}</b></div>${st.kilter && html`<div class="kv"><span>With LED</span><b>${holds.filter((x) => x.led != null).length}</b></div>`}</div><//>
    ${st.step === 'holds' && html`<div class="legend col"><span><i style="background:#38bdf8"></i>detected</span><span><i style="background:#a3e635"></i>added / edited</span>${st.kilter && html`<span><i class="dash"></i>LED without hold</span>`}</div><p class="hint">Wheel: zoom · Right-drag or Space-drag: pan · Double-click: fit.</p>`}
    ${st.step === 'align' && html`<p class="hint">Tip: the outer edge of the first and last row of holds should sit just inside the grid border in the preview.</p>`}
  </div>`;
}

function LiveRight() {
  const st = S((s) => s);
  const l = st.live, ses = st.session, o = st.outputs, byId = new Map(st.holds.map((h) => [h.id, h]));
  const [wsUrl, setWsUrl] = useState(o.ws.url);
  const dur = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
  const limbNames = { LH: 'Left hand', RH: 'Right hand', LF: 'Left foot', RF: 'Right foot' };
  const replayContacts = ses.replayT != null ? app.replayContacts() : null;
  return html`<div class="step-body">
    <${Section} title="Contacts">${['LH', 'RH', 'LF', 'RF'].map((k) => { const id = replayContacts ? replayContacts[k]?.holdId : l.contacts[k], h = id != null ? byId.get(id) : null; return html`<div class="contact"><i style=${{ background: LIMB_COL[k] }}></i><span>${limbNames[k]}</span><b>${h ? `#${h.label}` : '–'}</b>${h?.led != null && html`<small>LED ${h.led}</small>`}</div>`; })}<//>
    <${Section} title="Session" right=${ses.recording && html`<span class="rec">● REC</span>`}>
      <div class="card"><div class="kv"><span>Time</span><b>${dur(ses.duration)}</b></div><div class="kv"><span>Contact events</span><b>${ses.events}</b></div>
      ${ses.summary && html`<div class="kv"><span>Holds used</span><b>${ses.summary.holds}</b></div><div class="kv"><span>Hand moves</span><b>${ses.summary.handMoves}</b></div><div class="kv"><span>Foot moves</span><b>${ses.summary.footMoves}</b></div>`}</div>
      ${!l.running && ses.events > 0 && html`<div class="replay"><button class="btn" onClick=${() => (ses.playing ? app.pauseReplay() : app.playReplay())}>${ses.playing ? 'Pause' : 'Replay'}</button><input type="range" min="0" max=${Math.round(ses.duration)} value=${Math.round(ses.replayT ?? 0)} onInput=${(e) => app.setReplay(+e.target.value)} /></div>
        <div class="row"><${Btn} onClick=${() => app.exportSession('json')}>Export JSON<//><${Btn} onClick=${() => app.exportSession('csv')}>Export CSV<//></div>`}
    <//>
    <${Section} title="Send to other devices" hint="Every contact change is sent as an event. Format: see docs/OUTPUT-API.md.">
      <label class="field"><span>WebSocket</span><input class="mono small" value=${wsUrl} onInput=${(e) => setWsUrl(e.target.value)} placeholder="ws://192.168.1.50:8765" /></label>
      <div class="row between"><span class="hint"><${Dot} state=${o.ws.state === 'connected' ? 'ok' : o.ws.state === 'off' ? 'off' : 'warn'} /> ${o.ws.state}</span>${o.ws.state === 'off' ? html`<${Btn} onClick=${() => app.connectWs(wsUrl)}>Connect<//>` : html`<${Btn} onClick=${() => app.disconnectWs()}>Disconnect<//>`}</div>
      <div class="row between"><span class="hint"><${Dot} state=${o.serial.state === 'connected' ? 'ok' : 'off'} /> Serial (Arduino)</span>${o.serial.state === 'connected' ? html`<${Btn} onClick=${() => app.serial.disconnect()}>Disconnect<//>` : html`<${Btn} disabled=${!SerialSink.supported()} title=${SerialSink.supported() ? '' : 'Web Serial needs Chrome or Edge'} onClick=${() => app.connectSerial()}>Connect<//>`}</div>
      <${Btn} onClick=${() => app.exportHolds()}>Export hold map (JSON)<//>
    <//>
  </div>`;
}

// ---------- stage ----------
function StageView() {
  const ref = useRef(), stageRef = useRef();
  const st = S((s) => s);
  useEffect(() => { const sg = new Stage(ref.current, app, store); stageRef.current = sg; window.__stage = sg; return () => sg.destroy(); }, []);
  const none = !st.cam.status || st.cam.status === 'off';
  const live = st.mode === 'live' && st.live.running;
  const hints = { camera: 'Choose a camera source on the left.', align: 'Drag the corner handles onto the wall corners.', holds: '', board: 'Click a hold to light its LED.', ready: '' };
  return html`<main class=${`stage ${live ? 'is-live' : ''}`}>
    <div class="canvas-host" ref=${ref}></div>
    ${none && !app.snapshotBitmap && html`<div class="empty"><svg viewBox="0 0 24 24" width="44" height="44"><path d="M3 20 L10 7 L14 14 L17 9 L21 20 Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg><h2>Point a camera at the wall</h2><p>Pick a camera source on the left. No hardware at hand? Try the demo wall.</p></div>`}
    ${live && !st.live.person && html`<div class="toast-top">No climber detected</div>`}
    ${st.mode === 'setup' && hints[st.step] && !none && html`<div class="hintbar">${hints[st.step]}</div>`}
    <div class="vtools"><button title="Fit to view" onClick=${() => stageRef.current?.fit()}>⤢</button>${st.step !== 'align' && html`<button class=${st.ui.labels ? 'on' : ''} title="Hold numbers" onClick=${() => app.setUi({ labels: !st.ui.labels })}>#</button>`}</div>
    ${live && html`<div class="live-pill"><i></i>LIVE</div>`}
  </main>`;
}

function Toast() {
  const t = S((s) => s.toast);
  return t ? html`<div class=${`toast ${t.kind}`}>${t.msg}</div>` : null;
}

let _webgl;
const hasWebGL = () => (_webgl ??= !!document.createElement('canvas').getContext('webgl')); // probe once: every probe would allocate a GL context

function Diagnostics() {
  const st = S((s) => s);
  const [open, setOpen] = useState(false);
  const info = { secureContext: window.isSecureContext, webgl: hasWebGL(), webBluetooth: BleTransport.supported(), webSerial: SerialSink.supported(), camera: st.cam.label, frame: `${st.cam.width}x${st.cam.height}@${st.cam.fps}`, pose: `${st.live.activeVariant || '-'} / ${st.live.delegate || '-'}`, poseFps: st.live.fps, poseLatencyMs: st.live.latency, board: st.board.state, holds: st.holds.length, leds: st.board.leds.length, userAgent: navigator.userAgent };
  return html`<div class="diag"><button class="linkbtn" onClick=${() => setOpen(!open)}>Diagnostics</button>${open && html`<pre>${Object.entries(info).map(([k, v]) => `${k}: ${v}`).join('\n')}</pre><button class="linkbtn" onClick=${() => navigator.clipboard?.writeText(JSON.stringify(info, null, 1))}>Copy report</button>`}</div>`;
}

export function Root() {
  const st = S((s) => s);
  if (!st.ready) return html`<div class="boot">Loading…</div>`;
  const Step = { camera: CameraStep, align: AlignStep, holds: HoldsStep, board: BoardStep, ready: ReadyStep }[st.step] || CameraStep;
  return html`<div class="app">
    <${Header} />
    <div class="main">
      <aside class="panel left">${st.mode === 'live' ? html`<${LivePanel} />` : html`<${Stepper} /><${Step} />`}<${Diagnostics} /></aside>
      <${StageView} />
      <aside class="panel right">${st.mode === 'live' ? html`<${LiveRight} />` : html`<${Inspector} />`}</aside>
    </div>
    <${Toast} />
  </div>`;
}

export function mount(el) { render(html`<${Root} />`, el); }
