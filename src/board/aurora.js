// Aurora-protocol (v3) LED board control over Web Bluetooth (Kilter etc.).
// Based on the supplied board.js. Changes: transport abstraction (real BLE / mock),
// adaptive chunk delay + whole-frame retry, reconnect without the picker, status events,
// and "safe" state updates that work whether the board replaces or merges frames.
//
// Chrome/Edge only, HTTPS or localhost; connect() must run from a click.

export const ADVERTISED = '4488b571-7806-4df6-bcff-a2897e4953ff';
export const UART_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
export const UART_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';

const CMD_ONLY = 84, CMD_FIRST = 82, CMD_MIDDLE = 81, CMD_LAST = 83;
export const MAX_LEDS_PER_FRAME = 84;
const CHUNK_SIZE = 20;

// ---------- protocol (pure) ----------

export function encodeColor(r, g, b) { return ((r >> 5) << 5) | ((g >> 5) << 2) | (b >> 6); }
export function decodeColor(c) {
  // approximate inverse (for the simulator / tests)
  return { r: ((c >> 5) & 7) * 36, g: ((c >> 2) & 7) * 36, b: (c & 3) * 85 };
}

function frame(payload) {
  let sum = 0;
  for (const x of payload) sum = (sum + x) & 0xff;
  return [0x01, payload.length & 0xff, ~sum & 0xff, 0x02, ...payload, 0x03];
}

function check(l) {
  for (const k of ['pos', 'r', 'g', 'b']) if (!Number.isInteger(l[k])) throw new RangeError(`LED ${k} must be an integer`);
  if (l.pos < 0 || l.pos > 0xffff) throw new RangeError(`pos ${l.pos} outside 0..65535`);
  for (const k of ['r', 'g', 'b']) if (l[k] < 0 || l[k] > 255) throw new RangeError(`${k} ${l[k]} outside 0..255`);
}

/** Bytes for a complete LED state. Empty list = clear frame. */
export function buildMessage(leds) {
  leds.forEach(check);
  const groups = [];
  if (leds.length <= MAX_LEDS_PER_FRAME) groups.push(leds);
  else for (let i = 0; i < leds.length; i += MAX_LEDS_PER_FRAME) groups.push(leds.slice(i, i + MAX_LEDS_PER_FRAME));
  const out = [];
  groups.forEach((g, i) => {
    const cmd = groups.length === 1 ? CMD_ONLY : i === 0 ? CMD_FIRST : i === groups.length - 1 ? CMD_LAST : CMD_MIDDLE;
    const payload = [cmd];
    for (const l of g) payload.push(l.pos & 0xff, (l.pos >> 8) & 0xff, encodeColor(l.r, l.g, l.b));
    out.push(...frame(payload));
  });
  return Uint8Array.from(out);
}

/** Parse a byte stream back into frames (used by the simulator and tests). Throws on malformed data. */
export function decodeStream(bytes) {
  const frames = [];
  let i = 0;
  while (i < bytes.length) {
    if (bytes[i] !== 0x01) throw new Error(`bad start byte at ${i}`);
    const len = bytes[i + 1], chk = bytes[i + 2];
    if (bytes[i + 3] !== 0x02 || bytes[i + 4 + len] !== 0x03) throw new Error(`bad framing at ${i}`);
    const payload = bytes.slice(i + 4, i + 4 + len);
    let sum = 0;
    for (const x of payload) sum = (sum + x) & 0xff;
    if ((~sum & 0xff) !== chk) throw new Error(`bad checksum at ${i}`);
    const cmd = payload[0], leds = [];
    for (let k = 1; k + 2 < payload.length + 0; k += 3) leds.push({ pos: payload[k] | (payload[k + 1] << 8), color: payload[k + 2] });
    frames.push({ cmd, leds });
    i += len + 5;
  }
  return frames;
}

// ---------- transports ----------

export class BleTransport {
  constructor() { this.device = null; this.rx = null; this.onDisconnect = () => {}; }
  static supported() { return typeof navigator !== 'undefined' && !!navigator.bluetooth; }
  get connected() { return !!(this.device && this.device.gatt.connected && this.rx); }
  get name() { return this.device?.name || 'Board'; }
  async request() {
    if (!BleTransport.supported()) throw new Error('Web Bluetooth is not available (use Chrome or Edge over HTTPS/localhost).');
    try {
      this.device = await navigator.bluetooth.requestDevice({ filters: [{ services: [ADVERTISED] }], optionalServices: [UART_SERVICE] });
    } catch (e) {
      if (e?.name === 'NotFoundError' && /cancel/i.test(e.message || '')) throw e;
      // Some boards advertise only a name: offer name-prefixed devices as a fallback.
      this.device = await navigator.bluetooth.requestDevice({ filters: [{ namePrefix: 'Kilter' }, { namePrefix: 'Aurora' }], optionalServices: [UART_SERVICE] });
    }
    if (this._h) this.device.removeEventListener('gattserverdisconnected', this._h);
    this._h = () => { this.rx = null; this.onDisconnect(); };
    this.device.addEventListener('gattserverdisconnected', this._h);
  }
  async open() {
    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService(UART_SERVICE);
    this.rx = await service.getCharacteristic(UART_RX);
  }
  async write(chunk) { await this.rx.writeValueWithResponse(chunk); }
  close() { if (this.device?.gatt.connected) this.device.gatt.disconnect(); }
}

/** In-memory board for the demo mode and tests. `onFrame` receives decoded frames. */
export class MockTransport {
  constructor(onBytes = () => {}) { this.onBytes = onBytes; this.connected = false; this.name = 'Demo board'; this.onDisconnect = () => {}; this.buf = []; }
  async request() {}
  async open() { this.connected = true; }
  async write(chunk) {
    this.buf.push(...chunk);
    // a frame is complete when it ends with 0x03 at the declared length
    while (this.buf.length >= 6) {
      const len = this.buf[1], total = len + 5;
      if (this.buf.length < total) break;
      this.onBytes(Uint8Array.from(this.buf.splice(0, total)));
    }
  }
  close() { this.connected = false; this.onDisconnect(); }
}

// ---------- board ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class AuroraBoard extends EventTarget {
  constructor(transport = new BleTransport()) {
    super();
    this.t = transport;
    this.t.onDisconnect = () => { this._status('disconnected'); }; // `lit` is kept: the board may still show those LEDs after a BLE drop
    this.lit = new Map();          // pos -> {r,g,b} we believe is shown
    this.known = new Set();        // all positions we know exist (from calibration)
    this.queue = Promise.resolve();
    this.delay = 12;               // ms between chunks; adapts
    this.state = 'disconnected';
  }
  _status(s, detail) { this.state = s; this.dispatchEvent(new CustomEvent('status', { detail: { state: s, name: this.t.name, detail } })); }
  get connected() { return this.t.connected; }
  setKnownPositions(list) { this.known = new Set(list); }

  async connect() {
    this._status('connecting');
    try { await this.t.request(); await this.t.open(); this.lit = new Map(); this.delay = 12; this._status('connected'); }
    catch (e) { this._status(this.t.device ? 'disconnected' : 'idle', e.message); throw e; }
  }
  /** Re-open the already selected device (no picker). */
  async reconnect() {
    if (!this.t.device && !(this.t instanceof MockTransport)) throw new Error('No device selected yet');
    this._status('connecting');
    try { await this.t.open(); this._status('connected'); } // keep `lit`: next update switches stale LEDs off
    catch (e) { this._status('disconnected', e.message); throw e; }
  }

  async _write(bytes) {
    if (!this.connected) throw new Error('Not connected');
    for (let attempt = 0; ; attempt++) {
      try {
        for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
          await this.t.write(bytes.slice(i, i + CHUNK_SIZE));
          if (this.delay) await sleep(this.delay);
        }
        if (this.delay > 12) this.delay = Math.max(12, this.delay - 4); // recover speed after a transient error
        return;
      } catch (e) {
        if (attempt >= 2 || !this.connected) throw e;
        this.delay = Math.min(100, Math.max(20, this.delay * 2)); // slow down and resend the whole frame
        await sleep(50);
      }
    }
  }
  _enqueue(fn) { const run = this.queue.then(fn, fn); this.queue = run.catch(() => {}); return run; }

  /**
   * Show exactly these LEDs. LEDs that were lit before and are missing now get explicit black entries,
   * so the result is correct whether the board replaces or merges frames. Black entries count as off.
   */
  setLeds(leds) {
    return this._enqueue(async () => {
      const next = new Map();
      for (const l of leds) if (l.r || l.g || l.b) next.set(l.pos, { r: l.r, g: l.g, b: l.b });
      const msg = [...next].map(([pos, c]) => ({ pos, ...c }));
      for (const pos of this.lit.keys()) if (!next.has(pos)) msg.push({ pos, r: 0, g: 0, b: 0 });
      if (!msg.length) return;
      msg.sort((a, b) => a.pos - b.pos);
      try { await this._write(buildMessage(msg)); }
      catch (e) { for (const [p, c] of next) this.lit.set(p, c); throw e; } // the board may have received it: remember, so the next update blacks it out
      this.lit = next;
    });
  }

  /** Clear frame, then black entries for everything we know of (lit now, or from calibration). */
  allOff() {
    return this._enqueue(async () => {
      await this._write(buildMessage([]));
      const pos = new Set([...this.lit.keys(), ...this.known]);
      if (pos.size) await this._write(buildMessage([...pos].sort((a, b) => a - b).map((p) => ({ pos: p, r: 0, g: 0, b: 0 }))));
      this.lit = new Map();
    });
  }

  async disconnect() {
    try { if (this.connected) await this.allOff(); } finally { this.t.close(); }
  }
}
