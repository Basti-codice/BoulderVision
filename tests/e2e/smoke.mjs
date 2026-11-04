// End-to-end check in real Chromium using the built-in demo world (no hardware needed).
//   npm run build && npx vite preview --port 4173 &   then   node tests/e2e/smoke.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = createRequire('/opt/node-tools/')('playwright')); }

const URL = process.env.URL || 'http://localhost:4173/';
const SHOTS = process.env.SHOTS || './e2e-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-fake-ui-for-media-stream'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 880 } });
const logs = [];
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) logs.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`PAGEERROR: ${e.message}`));
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!ok) failed++; };
const shot = (n) => page.screenshot({ path: `${SHOTS}/${n}.png` });

await page.goto(URL);
await page.waitForSelector('.app');
await shot('01-start');

// --- demo start through the UI
await page.click('text=Demo');
await page.click('text=Start demo wall');
await page.waitForFunction(() => window.__bv.s.cam.status === 'on' && window.__bv.s.board.state === 'connected', null, { timeout: 15000 });
check('demo camera + board connected', true);
await page.waitForTimeout(500);
await shot('02-align-jittered');

// exact corners for ground-truth comparison
await page.evaluate(() => window.__bv.setCorners(window.__bv.world.corners.map((c) => c.slice())));
await page.waitForTimeout(300);
await shot('03-align-exact');

// --- hold detection through the UI
await page.click('text=Continue');
await page.waitForFunction(() => !window.__bv.s.detect.busy && window.__bv.holds.length > 0, null, { timeout: 60000 });
await page.waitForTimeout(500);
const det = await page.evaluate(() => {
  const a = window.__bv, w = a.world;
  const inside = (poly, x, y) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
  const found = a.holds.filter((h) => !h.ghost);
  let hit = 0; const used = new Set();
  for (const t of w.holds) { const i = found.findIndex((f, k) => !used.has(k) && inside(f.poly, t.x, t.y)); if (i >= 0) { used.add(i); hit++; } }
  return { truth: w.holds.length, found: found.length, recall: hit / w.holds.length, precision: used.size / found.length };
});
console.log('   detection', JSON.stringify(det));
check('hold recall >= 97%', det.recall >= 0.97);
check('hold precision >= 97%', det.precision >= 0.97);
await shot('04-holds');

// --- editing: select, remove, undo, add
const edit = await page.evaluate(() => {
  const a = window.__bv, n0 = a.holds.length, h = a.holds.find((x) => x.source === 'auto');
  a.select(h.id); a.removeIds([h.id]); const n1 = a.holds.length;
  a.undo(); const n2 = a.holds.length;
  a.removeIds([h.id]);
  const added = a.addAt(h.cx, h.cy); const n3 = a.holds.length;
  return { n0, n1, n2, n3, addedOk: !!added };
});
check('remove/undo/add', edit.n1 === edit.n0 - 1 && edit.n2 === edit.n0 && edit.n3 === edit.n0 && edit.addedOk, JSON.stringify(edit));

// --- LED scan through the UI
await page.click('.step:has-text("Board")');
await page.click('button.btn:has-text("Scan LEDs")');
await page.waitForFunction(() => !window.__bv.s.board.scan.running && window.__bv.s.board.leds.length > 0, null, { timeout: 120000 });
const scan = await page.evaluate(() => {
  const a = window.__bv, w = a.world, truth = new Map(w.leds.map((l) => [l.pos, l]));
  let ok = 0, bad = 0;
  for (const l of a.s.board.leds) { const t = truth.get(l.pos); if (t && Math.hypot(t.x - l.x, t.y - l.y) < 12) ok++; else bad++; }
  const r = a.s.board.scan.result;
  return { truth: w.leds.length, found: a.s.board.leds.length, ok, bad, verify: [r.verifyOk, r.verifyBad], matchedHolds: a.holds.filter((h) => h.led != null && !h.ghost).length, ghosts: a.holds.filter((h) => h.ghost).length, empty: w.empty.length };
});
console.log('   scan', JSON.stringify(scan));
check('LED scan: >= 97% located within 12 px', scan.ok / scan.truth >= 0.97 && scan.bad <= 6);
check('LED scan: verification clean', scan.verify[1] <= 1);
check('LEDs bound to holds', scan.matchedHolds >= scan.truth - scan.empty - 6);
await shot('05-board');

// click-to-light test
const lit = await page.evaluate(async () => { const a = window.__bv, h = a.holds.find((x) => x.led != null && !x.ghost); await a.testHold(h.id); const on = [...a.world.lit.keys()]; await a.lightsOff(); return { led: h.led, on, off: [...a.world.lit.keys()] }; });
check('click-to-light', lit.on.length === 1 && lit.on[0] === lit.led && lit.off.length === 0, JSON.stringify(lit));

// --- auto-align: jitter corners then recover from LEDs
const al = await page.evaluate(async () => {
  const a = window.__bv, truth = a.world.corners;
  a.setCorners(truth.map(([x, y], i) => [x + [25, -30, 20, -22][i], y + [-18, 22, 25, -20][i]]));
  await a.autoAlign();
  const c = a.s.corners; return { err: Math.max(...c.map((p, i) => Math.hypot(p[0] - truth[i][0], p[1] - truth[i][1]))), msg: a.s.board.align.message };
});
console.log('   align', JSON.stringify(al));
check('auto-align within 4 px', al.err < 4);

// --- live
await page.click('.step:has-text("Go live")');
await page.click('text=Start live tracking');
await page.waitForFunction(() => window.__bv.s.live.running, null, { timeout: 30000 });
await page.evaluate(() => window.__bv.setLive({ lightBoard: true }));
const samples = [];
for (let i = 0; i < 24; i++) {
  await page.waitForTimeout(450);
  samples.push(await page.evaluate(() => {
    const a = window.__bv, w = a.world, t = w.time(performance.now()), exp = w.expectedContacts(t), got = a.tracker.contacts;
    const inside = (poly, x, y) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
    const res = {};
    for (const l of ['LH', 'RH', 'LF', 'RF']) {
      const wh = exp[l] != null ? w.holds.find((h) => h.id === exp[l]) : null;
      const gh = got[l] != null ? a.holds.find((h) => h.id === got[l]) : null;
      res[l] = { exp: !!wh, got: !!gh, same: !!(wh && gh && inside(gh.poly, wh.x, wh.y)) };
    }
    return { res, lit: [...w.lit.keys()], contacts: got };
  }));
  if (i === 6) await shot('06-live');
}
let agree = 0, total = 0, wrong = 0;
for (const s of samples) for (const l of Object.values(s.res)) { if (l.exp && l.got) { total++; if (l.same) agree++; else wrong++; } }
console.log(`   live: ${agree}/${total} limb samples on the right hold, ${wrong} on a wrong hold`);
check('live: contacts found', total >= 20);
check('live: >= 90% correct hold when in contact', agree / Math.max(1, total) >= 0.9);
check('live: board LEDs follow contacts', samples.some((s) => s.lit.length >= 3));
const sum = await page.evaluate(async () => { const a = window.__bv; await a.stopLive(); return { events: a.recorder.events.length, lit: [...a.world.lit.keys()].length, summary: a.s.session.summary }; });
console.log('   session', JSON.stringify(sum));
check('events recorded', sum.events >= 10);
check('board dark after stop', sum.lit === 0);
await shot('07-review');

console.log('\nconsole warnings/errors:', logs.length ? '\n' + logs.slice(0, 10).join('\n') : 'none');
await browser.close();
process.exit(failed ? 1 : 0);
