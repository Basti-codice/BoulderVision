// The Games area's logic: which holds a game may use, starting and stopping, one tick per frame that turns the game's
// output into LEDs (and the on-screen mirror), records. The rules of a game are in src/game/games.js, how things are drawn
// on the LED field in src/game/wallhud.js; this file is only the glue to the app (tracker, board, state).

import { createGame, GAMES, OPTIONS, recordKey } from '../game/games.js';
import { WallTest } from '../game/walltest.js';
import { buildLayout, composeWall, isReserved } from '../game/wallhud.js';
import { LIMB_COLORS } from '../outputs/sinks.js';
import { rng } from '../core/rng.js';

const BEST_KEY = 'bv.game.best';
const OPTS_KEY = 'bv.game.opts';
const UI_INTERVAL_MS = 200;      // how often the screen HUD state is refreshed
const MIN_PLAYABLE_HOLDS = 8;
const NO_CONTACTS = { LH: null, RH: null, LF: null, RF: null };
/** Feet first, so that a hand and a foot on the same hold show the hand colour. */
const LIMB_ORDER = ['LF', 'RF', 'LH', 'RH'];

export class GamesController {
  constructor(app) {
    this.app = app;
    this.layout = null;          // LED field of the running game (null: screen only)
    this.hud = false;            // status strips on?
    this.byId = new Map();       // playable holds by id
    this.holdsById = new Map();  // all holds by id (to find the LED under a limb)
    this.ledAt = new Map();      // LED position -> {x, y}
    this.overSeen = false;
    this.uiAt = 0;
  }

  /** Stored records and settings into the state. Records of the old format ({coins: 12}) count as "medium". */
  load() {
    const a = this.app;
    const best = {};
    let opts = {};
    try {
      for (const [k, v] of Object.entries(JSON.parse(localStorage.getItem(BEST_KEY) || '{}'))) if (Number.isFinite(v)) best[k.includes(':') ? k : recordKey(k, 'medium')] = v;
      opts = JSON.parse(localStorage.getItem(OPTS_KEY) || '{}');
    } catch { /* corrupt storage: start fresh */ }
    const difficulty = OPTIONS.difficulty.choices.some((c) => c.id === opts.difficulty) ? opts.difficulty : a.s.game.opts.difficulty;
    a.set({ game: { ...a.s.game, best, opts: { difficulty, hud: opts.hud ?? a.s.game.opts.hud } } });
  }

  select(id) { if (!this.app.s.game.active && GAMES.some((g) => g.id === id)) this.app.set({ game: { ...this.app.s.game, id } }); }

  setOpts(patch) {
    const a = this.app;
    if (a.s.game.active) return;
    const opts = { ...a.s.game.opts };
    if (patch.difficulty !== undefined && OPTIONS.difficulty.choices.some((c) => c.id === patch.difficulty)) opts.difficulty = patch.difficulty;
    if (patch.hud !== undefined) opts.hud = !!patch.hud;
    a.set({ game: { ...a.s.game, opts } });
    try { localStorage.setItem(OPTS_KEY, JSON.stringify(opts)); } catch { /* storage unavailable */ }
  }

  /**
   * What a game may use. With an LED map only holds that have an LED are playable (a hold without light would be an
   * invisible coin or trap), and with the status strips on, the strips' LEDs are not. Without any LED map every hold is
   * (screen only).
   */
  plan({ hud = this.app.s.game.opts.hud } = {}) {
    const a = this.app, holds = a.holds.filter((h) => !h.ghost), mapped = holds.some((h) => h.led != null);
    const layout = a.s.board.leds.length ? buildLayout(a.s.board.leds, a.wallDims.pxPerCm) : null;
    const onWall = !!(a.board?.connected && mapped);
    const strips = onWall && hud && !!layout?.hud;
    const playable = mapped ? holds.filter((h) => h.led != null && !(strips && isReserved(layout, h.led))) : holds;
    return { holds: playable, layout: onWall ? layout : null, hud: strips, onWall };
  }

  _begin(game, plan, id) {
    const a = this.app;
    this.layout = plan.layout; this.hud = plan.hud;
    this.byId = new Map(plan.holds.map((h) => [h.id, h]));
    this.holdsById = new Map(a.holds.map((h) => [h.id, h]));
    this.ledAt = new Map(a.s.board.leds.map((l) => [l.pos, l]));
    this.overSeen = false;
    a.game = game;
    game.start(performance.now());
    a.kilterSink?.setEnabled(false); // the game draws the hands and feet itself, on top of its own lights
    a.set({ game: { ...a.s.game, active: true, current: id, state: game.state(performance.now()), info: { onWall: plan.onWall, hud: plan.hud, playable: plan.holds.length } } });
  }

  start(id = this.app.s.game.id) {
    const a = this.app;
    if (!a.tracking || !a.tracker) { a.toast('Start tracking first: games use the climber\'s hand and foot contacts.'); return; }
    const plan = this.plan();
    if (plan.holds.length < MIN_PLAYABLE_HOLDS) { a.toast('Too few playable holds. Scan the LEDs first so the holds have lights.', 'error'); return; }
    this.stop(false);
    const { difficulty } = a.s.game.opts;
    this._begin(createGame(id, plan.holds, a.wallDims, rng((Date.now() ^ (performance.now() * 1000)) >>> 0), difficulty), plan, id);
    a.log('game', { start: id, difficulty, playable: plan.holds.length, onWall: plan.onWall, hud: plan.hud });
  }

  /** Plays every display once (no contacts needed): the quick way to check what the wall shows. */
  startWallTest() {
    const a = this.app, plan = this.plan({ hud: true });
    if (!plan.onWall) { a.toast('Connect the board and scan the LEDs first: the test shows on the wall.', 'error'); return; }
    this.stop(false);
    this._begin(new WallTest(plan.holds, a.wallDims), plan, 'walltest');
    a.log('game', { start: 'walltest', onWall: true, hud: plan.hud });
  }

  async stop(restoreSink = true) {
    const a = this.app;
    if (!a.game) return;
    a.game = null; a.showLit = null; a.showZones = null; a.showLeds = null; this.layout = null;
    a.set({ game: { ...a.s.game, active: false, current: null, state: null } });
    await a._ledsOff();
    if (restoreSink && a.s.live.running) a.kilterSink?.setEnabled(a.s.live.lightBoard && !!a.board?.connected);
  }

  _holdLeds(map) {
    const out = [];
    for (const [id, color] of map || []) { const h = this.byId.get(id); if (h?.led != null) out.push({ pos: h.led, color }); }
    return out;
  }

  /** The holds the hands and feet are on, in the limb colours: what the system believes, visible on the wall at all times. */
  _limbLeds() {
    const t = this.app.tracker;
    if (!t) return [];
    const m = new Map();
    for (const limb of LIMB_ORDER) {
      const h = this.holdsById.get(t.contacts[limb]);
      if (h?.led == null) continue;
      const [r, g, b] = LIMB_COLORS[limb];
      m.set(h.led, { pos: h.led, color: { r, g, b } });
    }
    return [...m.values()];
  }

  _finish(g) {
    const a = this.app;
    this.overSeen = true;
    if (g.practice) return;
    const id = a.s.game.current, key = recordKey(id, a.s.game.opts.difficulty), best = a.s.game.best;
    if (g.score > (best[key] || 0)) {
      g.record = true;
      const next = { ...best, [key]: g.score };
      a.set({ game: { ...a.s.game, best: next } });
      try { localStorage.setItem(BEST_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
    }
    a.log('game', { over: id, difficulty: a.s.game.opts.difficulty, score: g.score, record: g.record });
  }

  /** One frame: advance the game, build what the wall shows, send it, refresh the screen. */
  tick(now) {
    const a = this.app, g = a.game;
    if (!g) return;
    g.update(now, a.tracker?.contacts ?? NO_CONTACTS);
    if (g.over && !this.overSeen) this._finish(g);
    const out = g.output(now);
    const frame = composeWall(this.layout, { flashLeds: this._holdLeds(out.flash), limbLeds: this._limbLeds(), holdLeds: this._holdLeds(out.lit), zones: out.zones, hud: out.hud, fx: out.fx }, { hudOn: this.hud });
    a.showLit = out.lit; a.showZones = out.zones;
    a.showLeds = frame.map((l) => ({ ...l, x: this.ledAt.get(l.pos)?.x, y: this.ledAt.get(l.pos)?.y })).filter((l) => l.x != null);
    a._pushLeds(frame); // latest wins: a slow link never queues frames, identical frames are not resent
    if (now - this.uiAt >= UI_INTERVAL_MS || g.over) { this.uiAt = now; a.set({ game: { ...a.s.game, state: g.state(now) } }); }
  }
}
