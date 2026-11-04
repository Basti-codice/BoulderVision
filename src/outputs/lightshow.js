// Light show patterns for the LED board (and the on-screen preview). Pure functions: easy to test.

export const SHOWS = [
  { id: 'rainbow', label: 'Rainbow wave' },
  { id: 'sweep-up', label: 'Sweep upwards' },
  { id: 'sweep-side', label: 'Sweep sideways' },
  { id: 'sparkle', label: 'Sparkle' },
  { id: 'numbers', label: 'Number walk (shows the numbering)' },
  { id: 'pulse', label: 'Pulse' },
];

/** Route roles and their LED colours (3-3-2 bit friendly, similar to the Kilter app). */
export const ROLES = {
  start: { label: 'Start', rgb: [0, 255, 0], css: '#22e06b' },
  hand: { label: 'Hand', rgb: [0, 150, 255], css: '#2aa3ff' },
  foot: { label: 'Foot', rgb: [255, 140, 0], css: '#ffa31a' },
  finish: { label: 'Finish', rgb: [255, 0, 255], css: '#f046ff' },
};

export function hsv(h, s, v) {
  h = ((h % 1) + 1) % 1;
  const i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  const [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
  return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
}

const hash = (n) => { let x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
const scale = (c, k) => ({ r: Math.round(c.r * k), g: Math.round(c.g * k), b: Math.round(c.b * k) });

/**
 * Colours for time t (seconds). holds: [{id, cx, cy, label}] in wall px. Returns Map(holdId -> {r,g,b});
 * holds that stay dark are omitted. LEDs only resolve 3 bits per channel, so very dim colours are dropped.
 */
export function showFrame(id, t, holds, wall) {
  const out = new Map(), n = holds.length;
  const put = (h, c) => { if (Math.max(c.r, c.g, c.b) >= 40) out.set(h.id, c); };
  if (id === 'numbers') {
    const order = holds.slice().sort((a, b) => (a.label ?? 0) - (b.label ?? 0));
    if (order.length) put(order[Math.floor(t * 6) % order.length], { r: 0, g: 200, b: 255 });
    return out;
  }
  for (const h of holds) {
    const x = h.cx / wall.RW, y = 1 - h.cy / wall.RH;
    if (id === 'rainbow') put(h, hsv(x * 0.6 + y * 0.6 - t * 0.25, 1, 1));
    else if (id === 'sweep-up' || id === 'sweep-side') {
      const pos = ((t * 0.35) % 1.3) - 0.15, d = Math.abs((id === 'sweep-up' ? y : x) - pos);
      if (d < 0.09) put(h, scale(hsv(t * 0.1 + (id === 'sweep-up' ? x : y) * 0.3, 1, 1), 1 - d / 0.09));
    } else if (id === 'sparkle') {
      const ph = (t * 0.8 + hash(h.id)) % 1;
      if (ph < 0.14) put(h, scale(hsv(hash(h.id * 3), 0.9, 1), 1 - ph / 0.14));
    } else if (id === 'pulse') put(h, scale({ r: 0, g: 140, b: 255 }, 0.45 + 0.55 * Math.sin(t * Math.PI * 1.4) ** 2));
  }
  return out;
}
