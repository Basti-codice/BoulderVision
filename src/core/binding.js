// Assign located LED spots to holds: one LED per hold, one hold per LED.
//
// The glow is a ring around the hold, so the spot centre is near the hold centre but not exactly on it (the bolt hole
// can sit off-centre). A hold is a candidate when the spot is inside its outline or within maxCm of it; among all
// candidate pairs the closest ones win first (cost mixes distance to the outline and to the centre).
import { polygonDistance, bbox } from './geometry.js';

/**
 * holds: [{id, cx, cy, poly, ghost?}], leds: [{pos, x, y}]. Returns {byHold: Map(holdId -> led), unmatched: [led]}.
 */
export function bindLeds(holds, leds, pxPerCm, { maxCm = 3.5 } = {}) {
  const gate = maxCm * pxPerCm, boxes = holds.map((h) => bbox(h.poly)), pairs = [];
  leds.forEach((l, li) => {
    holds.forEach((h, hi) => {
      if (h.ghost) return;
      const b = boxes[hi];
      if (l.x < b.x0 - gate || l.x > b.x1 + gate || l.y < b.y0 - gate || l.y > b.y1 + gate) return;
      const dp = polygonDistance(h.poly, l.x, l.y);
      if (dp > gate) return;
      pairs.push({ li, hi, cost: dp * 3 + Math.hypot(l.x - h.cx, l.y - h.cy) });
    });
  });
  pairs.sort((a, b) => a.cost - b.cost);
  const usedL = new Set(), usedH = new Set(), byHold = new Map();
  for (const p of pairs) {
    if (usedL.has(p.li) || usedH.has(p.hi)) continue;
    usedL.add(p.li); usedH.add(p.hi); byHold.set(holds[p.hi].id, leds[p.li]);
  }
  return { byHold, unmatched: leds.filter((_, i) => !usedL.has(i)) };
}
