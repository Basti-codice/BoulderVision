// Hold numbering. Numbers are only labels; pick whatever suits you.

export const NUMBERING_MODES = [
  { id: 'rows', label: 'Rows, bottom to top' },
  { id: 'columns', label: 'Columns, left to right' },
  { id: 'snake', label: 'Rows, snake pattern' },
  { id: 'size', label: 'Size, largest first' },
  { id: 'led', label: 'Order of the LED strip (Kilter)' },
];

function medianDia(holds) {
  const d = holds.map((h) => Math.sqrt(h.area || 100)).sort((a, b) => a - b);
  return d.length ? d[d.length >> 1] : 20;
}

function bands(holds, key, tol) {
  const sorted = holds.slice().sort((a, b) => key(a) - key(b));
  const out = [];
  let cur = [], mean = 0;
  for (const h of sorted) {
    const v = key(h);
    if (cur.length && Math.abs(v - mean) > tol) { out.push(cur); cur = []; }
    cur.push(h);
    mean = cur.reduce((s, x) => s + key(x), 0) / cur.length;
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * Returns holds (new array) with .label. Numbers are always consecutive: start, start+1, ... (start = 0 or 1).
 * The LED position is a separate property (shown in the inspector), never used as the number.
 */
export function numberHolds(holds, mode = 'rows', start = 1) {
  const active = holds.filter((h) => !h.ghost);
  const tol = medianDia(active) * 1.1;
  let order;
  if (mode === 'rows' || mode === 'snake') {
    const rows = bands(active, (h) => -h.cy, tol); // bottom first
    order = rows.flatMap((row, i) => row.sort((a, b) => (mode === 'snake' && i % 2 ? b.cx - a.cx : a.cx - b.cx)));
  } else if (mode === 'columns') {
    order = bands(active, (h) => h.cx, tol).flatMap((col) => col.sort((a, b) => b.cy - a.cy));
  } else if (mode === 'size') {
    order = active.slice().sort((a, b) => b.area - a.area);
  } else if (mode === 'led') {
    const withLed = active.filter((h) => h.led != null).sort((a, b) => a.led - b.led);
    const rest = bands(active.filter((h) => h.led == null), (h) => -h.cy, tol).flatMap((r) => r.sort((a, b) => a.cx - b.cx));
    order = withLed.concat(rest);
  } else order = active;
  const labels = new Map(order.map((h, i) => [h.id, start + i]));
  return holds.map((h) => ({ ...h, label: labels.get(h.id) ?? null }));
}
