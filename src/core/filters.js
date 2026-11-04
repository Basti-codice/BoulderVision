// One-Euro filter (Casiez et al.): low jitter when still, low lag when moving.
const alpha = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff) / dt);

export class OneEuro {
  constructor({ minCutoff = 1.5, beta = 0.05, dCutoff = 1 } = {}) {
    Object.assign(this, { minCutoff, beta, dCutoff });
    this.reset();
  }
  reset() { this.x = null; this.dx = 0; this.t = null; }
  /** t in seconds. */
  filter(v, t) {
    if (this.x === null || t <= this.t) { this.x = v; this.t = t; this.dx = 0; return v; }
    const dt = t - this.t;
    const rawD = (v - this.x) / dt;
    this.dx += alpha(this.dCutoff, dt) * (rawD - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += alpha(cutoff, dt) * (v - this.x);
    this.t = t;
    return this.x;
  }
}

export class OneEuro2D {
  constructor(opts) { this.fx = new OneEuro(opts); this.fy = new OneEuro(opts); }
  reset() { this.fx.reset(); this.fy.reset(); }
  filter(x, y, t) { return [this.fx.filter(x, t), this.fy.filter(y, t)]; }
}
