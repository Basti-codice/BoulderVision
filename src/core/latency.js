// Where does the time go between "the hand reaches a hold" and "the LED lights"? Rolling statistics per stage, so the
// debug report and the live panel can say which part is slow.
//
//   frame    ms between two analysed camera frames (1000 / fps)
//   pose     ms the pose model needed for one frame
//   hold     ms a limb had to stay over a hold before it counted (the debounce)
//   led      ms from the contact change until the LED command was written to the board (queue + Bluetooth)
//   ledWrite ms the Bluetooth write itself took (one LED frame)
//   ledFrame ms from asking for a game frame until it was written

export class LatencyMeter {
  /** @param {number} [size] samples kept per stage */
  constructor(size = 240) { this.size = size; this.series = new Map(); }
  /** Record one sample (ms). Non-finite or negative values are ignored. */
  add(name, ms) {
    if (!Number.isFinite(ms) || ms < 0) return;
    let s = this.series.get(name);
    if (!s) { s = { buf: [], total: 0 }; this.series.set(name, s); }
    s.buf.push(ms); s.total++;
    if (s.buf.length > this.size) s.buf.shift();
  }
  /** {n (samples ever), median, p95, last} of the kept samples, or null when there are none. */
  stats(name) {
    const s = this.series.get(name);
    if (!s || !s.buf.length) return null;
    const v = [...s.buf].sort((a, b) => a - b), at = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
    return { n: s.total, median: Math.round(at(0.5)), p95: Math.round(at(0.95)), last: Math.round(s.buf[s.buf.length - 1]) };
  }
  snapshot() { const o = {}; for (const k of this.series.keys()) o[k] = this.stats(k); return o; }
  reset() { this.series.clear(); }
}
