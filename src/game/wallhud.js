// Puts a game on the wall itself: everything the player needs to see (targets, obstacles, time, lives, score,
// countdown, game over) as LED colours. Pure geometry, no DOM and no Bluetooth, so it can be unit tested.
//
//   layout = buildLayout(board.leds, pxPerCm)      once per game: rows / columns of the LED field and the HUD strips
//   leds   = composeWall(layout, parts, options)    every frame: [{pos, r, g, b}] for AuroraBoard.setLeds
//
// The board is a field of LEDs at known wall positions (wall pixels, same frame as the holds). Three strips at the
// edge carry the status when it is switched on, and are then kept out of the playing field:
//   top row     time bar (Coins) / lives (Dodge)
//   left column combo (Coins) / speed (Dodge)
//   bottom row  score ticks
// Bluetooth is slow and a bright LED field draws a lot of current, so a frame never holds more than MAX_GAME_LEDS.

/** At most this many LEDs lit in one frame (one Bluetooth message, a safe current draw). */
export const MAX_GAME_LEDS = 64;
/** Even with full status strips this many LEDs stay for targets, limbs and obstacles (a full 24-LED field would otherwise starve them). */
const FIELD_MIN_LEDS = 16;
/** A row needs this many LEDs to count as a row of the field (junk LEDs at the border do not). */
const MIN_ROW_LEDS = 8;
const MIN_COLUMN_LEDS = 6;
/** Rows are told apart by vertical gaps above this (cm), and grouped by this fraction of the typical row gap. */
const MIN_GAP_CM = 1.5;
const GROUP_GAP_FRACTION = 0.5;
/** How long the "GO" flash lasts after the start (ms) and how long a game-over sweep takes at most (ms). */
export const GO_MS = 700;
export const SWEEP_MAX_MS = 2400;
const SWEEP_ROW_MS = 120;

const COUNTDOWN_COLORS = { 3: { r: 255, g: 0, b: 0 }, 2: { r: 255, g: 110, b: 0 }, 1: { r: 255, g: 220, b: 0 } };
const GO_COLOR = { r: 0, g: 255, b: 0 };
const LOST_COLOR = { r: 120, g: 50, b: 0 };
/** Colour of the score ticks per lap around the row (the last lit LED of a lap is where the score stands). */
const LAP_COLORS = [{ r: 0, g: 255, b: 0 }, { r: 0, g: 200, b: 255 }, { r: 255, g: 0, b: 255 }, { r: 255, g: 255, b: 255 }];

const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : 0);

/** Items sorted by `key`, split wherever two neighbours are further apart than `gap`. */
function groupBy(items, key, gap) {
  const out = [];
  let cur = [];
  for (const it of items) {
    if (cur.length && key(it) - key(cur[cur.length - 1]) > gap) { out.push(cur); cur = []; }
    cur.push(it);
  }
  if (cur.length) out.push(cur);
  return out;
}
/**
 * Typical distance between neighbouring rows (or columns): median of the sorted gaps that are not just jitter. A first pass
 * (gaps above minGap) still contains some jitter gaps and reads a bit low; the second pass only takes gaps near that estimate.
 */
function typicalGap(values, minGap) {
  const gaps = (floor) => { const g = []; for (let i = 1; i < values.length; i++) if (values[i] - values[i - 1] > floor) g.push(values[i] - values[i - 1]); return g; };
  const first = median(gaps(minGap));
  return first ? median(gaps(Math.max(minGap, 0.6 * first))) || first : 0;
}

/**
 * @param {{pos:number, x:number, y:number}[]} leds mapped LEDs (wall px)
 * @param {number} pxPerCm
 * @returns {{leds:object[], rows:object[][], top:object[], bottom:object[], left:object[], middle:object[], hud:boolean, hudPos:Set<number>, pitchX:number, pitchY:number}}
 *   pitchX / pitchY: typical distance between neighbouring columns / rows in px (0 when unknown).
 *   rows: rows of at least MIN_ROW_LEDS LEDs, top to bottom, each left to right. top/bottom/left/middle: the strips
 *   (LED objects in drawing order). hud: the three strips exist; hudPos: positions the strips use.
 */
export function buildLayout(leds, pxPerCm) {
  const all = (leds || []).filter((l) => Number.isFinite(l.x) && Number.isFinite(l.y));
  const empty = { leds: all, rows: [], top: [], bottom: [], left: [], middle: [], hud: false, hudPos: new Set(), pitchX: 0, pitchY: 0 };
  if (all.length < 2 * MIN_ROW_LEDS) return empty;
  const byY = [...all].sort((a, b) => a.y - b.y), byX = [...all].sort((a, b) => a.x - b.x), minGap = MIN_GAP_CM * pxPerCm;
  const pitchY = typicalGap(byY.map((l) => l.y), minGap), pitchX = typicalGap(byX.map((l) => l.x), minGap);
  if (!pitchY || !pitchX) return empty;
  const rows = groupBy(byY, (l) => l.y, GROUP_GAP_FRACTION * pitchY).map((r) => r.sort((a, b) => a.x - b.x)).filter((r) => r.length >= MIN_ROW_LEDS);
  const cols = groupBy(byX, (l) => l.x, GROUP_GAP_FRACTION * pitchX).map((c) => c.sort((a, b) => a.y - b.y)).filter((c) => c.length >= MIN_COLUMN_LEDS);
  if (rows.length < 3 || !cols.length) return { ...empty, rows };
  // the gaps between sorted values are shortened by the spread inside a row: the spacing is the distance between row (column) means
  const meanSpacing = (groups, key) => { const m = groups.map((g) => g.reduce((t, l) => t + l[key], 0) / g.length); const d = []; for (let i = 1; i < m.length; i++) d.push(m[i] - m[i - 1]); return median(d) || 0; };
  const rowPitch = meanSpacing(rows, 'y') || pitchY, colPitch = meanSpacing(cols, 'x') || pitchX;
  const top = rows[0], bottom = rows[rows.length - 1];
  const taken = new Set([...top, ...bottom].map((l) => l.pos));
  const left = cols[0].filter((l) => !taken.has(l.pos));
  const midY = (top[0].y + bottom[0].y) / 2;
  const middle = rows.slice(1, -1).reduce((best, r) => (Math.abs(r[0].y - midY) < Math.abs(best[0].y - midY) ? r : best));
  const hud = left.length >= 3;
  const hudPos = new Set(hud ? [...top, ...bottom, ...left].map((l) => l.pos) : []);
  return { leds: all, rows, top, bottom, left, middle, hud, hudPos, pitchX: colPitch, pitchY: rowPitch };
}

/** LEDs a game may use for targets: those that are not part of an active HUD strip. */
export function isReserved(layout, pos) { return !!layout && layout.hudPos.has(pos); }

const clamp = (n, len) => Math.max(0, Math.min(len, n));

/** Bars and ticks light every STRIP_STEP-th LED only: half the LEDs to send and to power, still clearly a bar. */
const STRIP_STEP = 2;
const slotsOf = (strip) => Math.ceil(strip.length / STRIP_STEP);
const slot = (strip, k) => strip[k * STRIP_STEP];

/** A strip as a bar: the first `value` (0..1) share of its slots. */
function drawBar(strip, value, color, put) {
  const n = clamp(Math.ceil(value * slotsOf(strip) - 1e-9), slotsOf(strip));
  for (let k = 0; k < n; k++) put(slot(strip, k)?.pos, color);
}
/** A strip as `count` blocks of one or two LEDs with one dark LED between them; the first `litCount` blocks are lit (lives). */
function drawSegments(strip, count, litCount, color, put) {
  const size = clamp(Math.floor((strip.length - (count - 1)) / count), 2) || 1;
  const used = count * size + (count - 1), start = Math.max(0, Math.floor((strip.length - used) / 2));
  for (let k = 0; k < Math.min(count, litCount); k++) for (let i = 0; i < size; i++) put(strip[start + k * (size + 1) + i]?.pos, color);
}
/** A strip as tick marks: one slot per point; after a full lap the row starts over in the next lap's colour. */
function drawTicks(strip, count, put) {
  if (count <= 0) return;
  const len = slotsOf(strip), lap = Math.floor((count - 1) / len), upto = ((count - 1) % len) + 1;
  for (let k = 0; k < len; k++) {
    if (k < upto) put(slot(strip, k)?.pos, LAP_COLORS[lap % LAP_COLORS.length]);
    else if (lap > 0) put(slot(strip, k)?.pos, LAP_COLORS[(lap - 1) % LAP_COLORS.length]);
  }
}
/** A strip with exactly the first `n` LEDs lit. */
function drawCount(strip, n, color, put) { for (let i = 0; i < clamp(n, strip.length); i++) put(strip[i].pos, color); }

function drawStrip(strip, spec, put) {
  if (!spec || !strip.length) return;
  if (spec.kind === 'bar') drawBar(strip, spec.value, spec.color, put);
  else if (spec.kind === 'segments') drawSegments(strip, spec.count, spec.lit, spec.color, put);
  else if (spec.kind === 'ticks') drawTicks(strip, spec.count, put);
  else if (spec.kind === 'count') drawCount(strip, spec.n, spec.color, put);
}

/** The effect covering the wall, or null when there is nothing (left) to show. */
function drawEffect(layout, fx, put) {
  if (!fx || !layout.middle.length) return false;
  if (fx.kind === 'countdown') { for (const l of layout.middle) put(l.pos, COUNTDOWN_COLORS[Math.min(3, Math.max(1, fx.n))]); return true; }
  if (fx.kind === 'lost') { for (const l of layout.middle) put(l.pos, LOST_COLOR); return true; } // tracking lost: the game is frozen
  if (fx.kind === 'go') { for (const l of [...layout.middle, ...layout.top]) put(l.pos, GO_COLOR); return true; }
  if (fx.kind === 'sweep') {
    const perRow = Math.min(SWEEP_ROW_MS, SWEEP_MAX_MS / layout.rows.length), idx = Math.floor((fx.t * 1000) / perRow);
    if (idx >= layout.rows.length) return false;
    for (const l of layout.rows[idx]) put(l.pos, fx.color);
    return true;
  }
  return false;
}

const inZone = (l, z) => l.x >= z.x0 && l.x <= z.x1 && l.y >= z.y0 && l.y <= z.y1;
const inMark = (l, m) => (l.x - m.x) ** 2 + (l.y - m.y) ** 2 <= m.r * m.r;

/**
 * One frame.
 * @param {object|null} layout from buildLayout (null: no LED map, only the target LEDs below)
 * @param {{flashLeds?, limbLeds?, holdLeds?: {pos:number, color:{r,g,b}}[], marks?: {x,y,r,color}[], zones?: {x0,y0,x1,y1,color}[],
 *          body?: {leds: Iterable<number>, color, overlapColor}, hud?: {top?,left?,bottom?}, fx?: object}} parts
 *   Priority, highest first: fx (replaces everything), flashLeds (a hit / a collected coin, short), limbLeds (the holds hands and
 *   feet are on, so nobody can claim the system saw something else), holdLeds (targets), marks (round things in wall px, e.g. a
 *   chaser: every LED within r lights), overlap (a body LED inside a zone: shows you are touching an obstacle), zones, body
 *   (the stick figure: dim LEDs along the bones), hud.
 *   zones: rectangles in wall px; every LED inside lights, whether a hold sits there or not (earlier zones win).
 *   hud: strip specs (bar / segments / ticks / count). fx: countdown / go / sweep / lost.
 * @param {{hudOn?: boolean, cap?: number}} [o]
 * @returns {{pos:number, r:number, g:number, b:number}[]}
 */
export function composeWall(layout, parts, { hudOn = true, cap = MAX_GAME_LEDS } = {}) {
  const useHud = hudOn && !!layout?.hud;
  const finish = (m) => [...m].map(([pos, c]) => ({ pos, r: c.r, g: c.g, b: c.b }));
  const fxOut = new Map();
  if (layout && drawEffect(layout, parts.fx, (pos, c) => { if (pos != null && !fxOut.has(pos) && fxOut.size < cap) fxOut.set(pos, c); })) return finish(fxOut);
  // the status strips first, into their own space: they are never cut short by obstacles (zones give way instead)
  const strips = new Map();
  if (useHud && parts.hud) {
    const putStrip = (pos, c) => { if (pos != null && !strips.has(pos) && strips.size < cap - FIELD_MIN_LEDS) strips.set(pos, c); };
    drawStrip(layout.top, parts.hud.top, putStrip);
    drawStrip(layout.left, parts.hud.left, putStrip);
    drawStrip(layout.bottom, parts.hud.bottom, putStrip);
  }
  const room = cap - strips.size, out = new Map();
  const put = (pos, c) => { if (pos != null && !out.has(pos) && out.size < room) out.set(pos, c); };
  const onStrip = (pos) => useHud && layout.hudPos.has(pos);
  for (const t of parts.flashLeds || []) put(t.pos, t.color);
  for (const t of parts.limbLeds || []) if (!onStrip(t.pos)) put(t.pos, t.color); // a hand on a strip's hold must not look like part of the display
  for (const t of parts.holdLeds || []) put(t.pos, t.color);
  const zoneAt = new Map();                                   // LED pos -> colour of the first zone it lies in
  if (layout) {
    for (const m of parts.marks || []) for (const l of layout.leds) if (!onStrip(l.pos) && inMark(l, m)) put(l.pos, m.color);
    for (const z of parts.zones || []) for (const l of layout.leds) if (!onStrip(l.pos) && !zoneAt.has(l.pos) && inZone(l, z)) zoneAt.set(l.pos, z.color);
  }
  const body = new Set(parts.body?.leds || []);
  if (parts.body?.overlapColor) for (const pos of body) if (zoneAt.has(pos) && !onStrip(pos)) put(pos, parts.body.overlapColor);
  for (const [pos, color] of zoneAt) put(pos, color);
  for (const pos of body) if (!onStrip(pos)) put(pos, parts.body.color);
  for (const [pos, c] of strips) if (!out.has(pos)) out.set(pos, c);
  return finish(out);
}
