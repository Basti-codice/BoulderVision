// Output sinks. Every sink receives the same events (see docs/OUTPUT-API.md).
//   contact event: {type:'contact', t, limb:'LH'|'RH'|'LF'|'RF', hold, holdId, led, on}
//   state snapshot: {type:'state', t, contacts:{LH:{hold,led}|null,...}}

const LIMB_COLORS = { LH: [0, 255, 255], RH: [0, 255, 255], LF: [255, 140, 0], RF: [255, 140, 0] };

export class Bus {
  constructor() { this.fns = new Set(); }
  on(f) { this.fns.add(f); return () => this.fns.delete(f); }
  emit(msg) { for (const f of this.fns) { try { f(msg); } catch (e) { console.warn('sink error', e); } } }
}

/** WebSocket client: sends JSON text frames; reconnects with backoff while enabled. */
export class WebSocketSink {
  constructor(onState) { this.onState = onState; this.ws = null; this.url = ''; this.want = false; this.retry = 0; this.hello = null; }
  connect(url, hello) {
    this.url = url; this.hello = hello; this.want = true; this._open();
  }
  _open() {
    if (!this.want) return;
    this.onState('connecting');
    let ws;
    try { ws = new WebSocket(this.url); } catch (e) { this.onState('error', e.message); return; }
    this.ws = ws;
    ws.onopen = () => { this.retry = 0; this.onState('connected'); if (this.hello) ws.send(JSON.stringify(this.hello())); };
    ws.onclose = () => { this.ws = null; if (!this.want) { this.onState('off'); return; } this.onState('retrying'); setTimeout(() => this._open(), Math.min(10000, 500 * 2 ** this.retry++)); };
    ws.onerror = () => {};
  }
  disconnect() { this.want = false; this.ws?.close(); this.onState('off'); }
  handle(msg) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg)); }
}

/** Web Serial (Arduino etc.): one text line per contact event: `C,<limb>,<hold>,<led|-1>,<1|0>\n`. */
export class SerialSink {
  constructor(onState) { this.onState = onState; this.port = null; this.writer = null; }
  static supported() { return typeof navigator !== 'undefined' && 'serial' in navigator; }
  async connect(baud = 115200) {
    this.port = await navigator.serial.requestPort();
    await this.port.open({ baudRate: baud });
    this.writer = this.port.writable.getWriter();
    this.enc = new TextEncoder();
    this.onState('connected');
  }
  async disconnect() { try { this.writer?.releaseLock(); await this.port?.close(); } catch { /* already closed */ } this.writer = null; this.port = null; this.onState('off'); }
  handle(msg) {
    if (!this.writer || msg.type !== 'contact') return;
    this.writer.write(this.enc.encode(`C,${msg.limb},${msg.hold},${msg.led ?? -1},${msg.on ? 1 : 0}\n`)).catch(() => this.onState('error', 'Serial write failed'));
  }
}

/** Lights the holds that currently carry a hand/foot on the Aurora board. Coalesces updates (latest wins). */
export class KilterSink {
  constructor(board, onError) { this.board = board; this.onError = onError; this.enabled = false; this.desired = []; this.busy = false; this.dirty = false; this.colors = LIMB_COLORS; }
  handle(msg) {
    if (msg.type !== 'state' || !this.enabled) return;
    const m = new Map();
    for (const [limb, c] of Object.entries(msg.contacts)) if (c && c.led != null) { const [r, g, b] = this.colors[limb]; if (!m.has(c.led) || limb[1] === 'H') m.set(c.led, { pos: c.led, r, g, b }); }
    this.desired = [...m.values()];
    this._flush();
  }
  async setEnabled(on) {
    this.enabled = on;
    if (!on) { this.desired = []; try { await this.board.allOff(); } catch (e) { this.onError?.(e); } }
  }
  async _flush() {
    if (this.busy) { this.dirty = true; return; }
    this.busy = true;
    try { do { this.dirty = false; await this.board.setLeds(this.desired); } while (this.dirty); }
    catch (e) { this.onError?.(e); }
    finally { this.busy = false; }
  }
}

/** Collects events of a session for export / replay. */
export class SessionRecorder {
  constructor() { this.reset(); }
  reset() { this.events = []; this.startedAt = null; this.endedAt = null; this.recording = false; }
  start(now) { this.reset(); this.startedAt = now; this.recording = true; }
  stop(now) { if (this.recording) { this.endedAt = now; this.recording = false; } }
  handle(msg) { if (this.recording && msg.type === 'contact') this.events.push(msg); }
  get duration() { return this.startedAt == null ? 0 : (this.endedAt ?? this.events.at(-1)?.t ?? 0); }
  contactsAt(t) {
    const cur = { LH: null, RH: null, LF: null, RF: null };
    for (const e of this.events) { if (e.t > t) break; cur[e.limb] = e.on ? e : null; }
    return cur;
  }
  summary() {
    const dwell = new Map(), open = {};
    for (const e of this.events) {
      if (e.on) open[e.limb] = e;
      else if (open[e.limb]) { const o = open[e.limb]; dwell.set(o.hold, (dwell.get(o.hold) || 0) + (e.t - o.t)); delete open[e.limb]; }
    }
    return {
      events: this.events.length,
      holds: new Set(this.events.map((e) => e.hold)).size,
      handMoves: this.events.filter((e) => e.on && e.limb.endsWith('H')).length,
      footMoves: this.events.filter((e) => e.on && e.limb.endsWith('F')).length,
      longest: [...dwell].sort((a, b) => b[1] - a[1]).slice(0, 5),
    };
  }
  toJSON(meta = {}) { return JSON.stringify({ format: 'bouldervision-session', version: 1, ...meta, duration: this.duration, events: this.events }, null, 1); }
  toCSV() { return ['t_ms,limb,hold,led,on', ...this.events.map((e) => `${Math.round(e.t)},${e.limb},${e.hold},${e.led ?? ''},${e.on ? 1 : 0}`)].join('\n'); }
}

export function download(name, text, type = 'application/json') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export function downloadBlob(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
