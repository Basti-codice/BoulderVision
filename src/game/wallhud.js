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
/** Typical distance between neighbouring rows (or columns): median of the sorted gaps that are not just jitter. */
function typicalGap(values, minGap) {
  const gaps = [];
  for (let i = 1; i < values.length; i++) if (values[i] - values[i - 1] > minGap) gaps.push(values[i] - values[i - 1]);
  return median(gaps);
}

/**
 * @param {{pos:number, x:number, y:number}[]} leds mapped LEDs (wall px)
 * @param {number} pxPerCm
 * @returns {{leds:object[], rows:object[][], top:object[], bottom:object[], left:object[], middle:object[], hud:boolean, hudPos:Set<number>}}
 *   rows: rows of at least MIN_ROW_LEDS LEDs, top to bottom, each left to right. top/bottom/left/middle: the strips
 *   (LED objects in drawing order). hud: the three strips exist; hudPos: positions the strips use.
 */
export function buildLayout(leds, pxPerCm) {
  const all = (leds || []).filter((l) => Number.isFinite(l.x) && Number.isFinite(l.y));
  const empty = { leds: all, rows: [], top: [], bottom: [], left: [], middle: [], hud: false, hudPos: new Set() };
  if (all.length < 2 * MIN_ROW_LEDS) return empty;
  const byY = [...all].sort((a, b) => a.y - b.y), byX = [...all].sort((a, b) => a.x - b.x), minGap = MIN_GAP_CM * pxPerCm;
  const pitchY = typicalGap(byY.map((l) => l.y), minGap), pitchX = typicalGap(byX.map((l) => l.x), minGap);
  if (!pitchY || !pitchX) return empty;
  const rows = groupBy(byY, (l) => l.y, GROUP_GAP_FRACTION * pitchY).map((r) => r.sort((a, b) => a.x - b.x)).filter((r) => r.length >= MIN_ROW_LEDS);
  const cols = groupBy(byX, (l) => l.x, GROUP_GAP_FRACTION * pitchX).map((c) => c.sort((a, b) => a.y - b.y)).filter((c) => c.length >= MIN_COLUMN_LEDS);
  if (rows.length < 3 || !cols.length) return { ...empty, rows };
  const top = rows[0], bottom = rows[rows.length - 1];
  const taken = new Set([...top, ...bottom].map((l) => l.pos));
  const left = cols[0].filter((l) => !taken.has(l.pos));
  const midY = (top[0].y + bottom[0].y) / 2;
  const middle = rows.slice(1, -1).reduce((best, r) => (Math.abs(r[0].y - midY) < Math.abs(best[0].y - midY) ? r : best));
  const hud = left.length >= 3;
  const hudPos = new Set(hud ? [...top, ...bottom, ...left].map((l) => l.pos) : []);
  return { leds: all, rows, top, bottom, left, middle, hud, hudPos };
}

/** LEDs a game may use for targets: those that are not part of an active HUD strip. */
export function isReserved(layout, pos) { return !!layout && layout.hudPos.has(pos); }

const clamp = (n, len) => Math.max(0, Math.min(len, n));

/** A strip as a bar: the first `value` (0..1) share of its LEDs. */
function drawBar(strip, value, color, put) {
  const n = clamp(Math.ceil(value * strip.length - 1e-9), strip.length);
  for (let i = 0; i < n; i++) put(strip[i].pos, color);
}
/** A strip as `count` blocks of LEDs with one dark LED between them; the first `litCount` blocks are lit. */
function drawSegments(strip, count, litCount, color, put) {
  const size = Math.max(1, Math.floor((strip.length - (count - 1)) / count));
  const used = count * size + (count - 1), start = Math.floor((strip.length - used) / 2);
  for (let k = 0; k < Math.min(count, litCount); k++) for (let i = 0; i < size; i++) put(strip[start + k * (size + 1) + i]?.pos, color);
}
/** A strip as tick marks: `count` LEDs; after a full lap the row starts over in the next lap's colour. */
function drawTicks(strip, count, put) {
  if (count <= 0) return;
  const len = strip.length, lap = Math.floor((count - 1) / len), upto = ((count - 1) % len) + 1;
  for (let i = 0; i < len; i++) {
    if (i < upto) put(strip[i].pos, LAP_COLORS[lap % LAP_COLORS.length]);
    else if (lap > 0) put(strip[i].pos, LAP_COLORS[(lap - 1) % LAP_COLORS.length]);
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

/**
 * One frame.
 * @param {object|null} layout from buildLayout (null: no LED map, only the target LEDs below)
 * @param {{holdLeds?: {pos:number, color:{r,g,b}}[], zones?: {x0,y0,x1,y1,color}[], hud?: {top?,left?,bottom?}, fx?: object}} parts
 *   holdLeds: the LEDs of target holds (highest priority). zones: rectangles in wall px; every LED inside lights, whether
 *   a hold sits there or not (earlier zones win). hud: strip specs (bar / segments / ticks / count). fx: countdown / go / sweep.
 * @param {{hudOn?: boolean, cap?: number}} [o]
 * @returns {{pos:number, r:number, g:number, b:number}[]}
 */
export function composeWall(layout, parts, { hudOn = true, cap = MAX_GAME_LEDS } = {}) {
  const out = new Map();
  const put = (pos, c) => { if (pos != null && !out.has(pos) && out.size < cap) out.set(pos, c); };
  const useHud = hudOn && !!layout?.hud;
  if (layout && drawEffect(layout, parts.fx, put)) return [...out].map(([pos, c]) => ({ pos, r: c.r, g: c.g, b: c.b }));
  for (const t of parts.holdLeds || []) put(t.pos, t.color);
  if (layout) for (const z of parts.zones || []) for (const l of layout.leds) if (!(useHud && layout.hudPos.has(l.pos)) && inZone(l, z)) put(l.pos, z.color);
  if (useHud && parts.hud) {
    drawStrip(layout.top, parts.hud.top, put);
    drawStrip(layout.left, parts.hud.left, put);
    drawStrip(layout.bottom, parts.hud.bottom, put);
  }
  return [...out].map(([pos, c]) => ({ pos, r: c.r, g: c.g, b: c.b }));
}
