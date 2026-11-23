// The Games area: choose a game, settings, start/stop, the wall check, records, and the on-screen game HUD.
// New games are added in src/game/games.js (GAMES list + a class); this file draws whatever the list contains.
import { html } from 'htm/preact';
import { app } from '../app/controller.js';
import { S, Section, Btn, Seg } from './kit.js';
import { ResponseMenu } from './response.js';
import { LIMB_COL } from './stage.js';
import { GAMES, OPTIONS, recordKey, formatScore } from '../game/games.js';

const mmss = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
const DIFFICULTY_TITLE = Object.fromEntries(OPTIONS.difficulty.choices.map((c) => [c.id, c.title]));

export function GamesPanel() {
  const st = S((s) => s), l = st.live, g = st.game, connected = st.board.state === 'connected';
  const game = GAMES.find((x) => x.id === g.id) || GAMES[0], playing = g.active;
  const best = (id) => g.best[recordKey(id, g.opts.difficulty)] || 0;
  return html`<div class="step-body">
    ${l.loading ? html`<div class="note warn">Loading the pose model…</div>`
      : !l.running ? html`<div class="note warn">Tracking is off: games use the hand and foot contacts.</div><${Btn} kind="primary wide big" onClick=${() => app.startLive('games')}>Start tracking<//>`
      : html`<div class=${`note ${l.person ? 'ok' : 'warn'}`}>${l.person ? 'Climber tracked' : 'No climber detected'}</div>`}
    ${l.error && html`<div class="note bad">${l.error}</div>`}
    <${Section} title="Choose a game" hint="Everything a game needs lights up on the wall itself (targets, obstacles, time, lives, score), and your hands and feet always show in their colour: cyan for hands, orange for feet. The screen only mirrors it.">
      <div class="game-list">${GAMES.map((x) => html`<button class=${`game-card ${g.id === x.id ? 'on' : ''}`} disabled=${playing} onClick=${() => app.selectGame(x.id)}><b>${x.title}</b><span>${x.blurb}</span><em>Best (${DIFFICULTY_TITLE[g.opts.difficulty]}): ${formatScore(x.id, best(x.id))}</em></button>`)}</div>
    <//>
    <${Section} title=${`${game.title} settings`}>
      ${game.options.map((id) => OPTIONS[id]).map((o) => html`<div class="field"><span>${o.label}</span></div>${html`<${Seg} value=${g.opts[o.id]} onChange=${(v) => !playing && app.setGameOpts({ [o.id]: v })} options=${o.choices.map((c) => ({ id: c.id, label: c.title }))} />`}`)}
      <label class="check"><input type="checkbox" checked=${g.opts.hud} disabled=${playing} onChange=${(e) => app.setGameOpts({ hud: e.target.checked })} /><span>Show time, lives and score on the wall</span></label>
      <p class="hint">Uses the top row (time / lives), the left column (combo / speed) and the bottom row (score) of the LEDs; the holds on them are not part of the game.</p>
      ${playing ? html`<${Btn} kind="danger wide" onClick=${() => app.stopGame()}>Stop<//>` : html`<${Btn} kind="primary wide" disabled=${!l.running} onClick=${() => app.startGame()}>Start ${game.title}<//>`}
      ${playing ? html`<p class="hint">${g.info.onWall ? `On the wall · ${g.info.playable} playable holds${g.info.hud ? ' · status on the edges' : ''}` : 'Screen only: connect the board and scan the LEDs to play on the wall.'}</p>` : !connected && html`<p class="hint">Board not connected: the game runs on screen only.</p>`}
    <//>
    <${Section} title="Wall check" hint="Plays every display once (countdown, bars, lives, time, score, game over) so you can see on the wall what a game shows. No climbing needed.">
      ${playing && g.current === 'walltest' ? html`<${Btn} kind="danger wide" onClick=${() => app.stopGame()}>Stop the test<//>` : html`<${Btn} kind="wide" disabled=${playing || !connected} onClick=${() => app.startWallTest()}>Test the wall display<//>`}
      ${!connected && html`<p class="hint">Connect the board in Setup → Board first.</p>`}
    <//>
    <${Section} title="Tracking"><${ResponseMenu} /><//>
  </div>`;
}

export function GamesRight() {
  const st = S((s) => s), l = st.live, g = st.game, byId = new Map(st.holds.map((h) => [h.id, h]));
  const limbNames = { LH: 'Left hand', RH: 'Right hand', LF: 'Left foot', RF: 'Right foot' };
  return html`<div class="step-body">
    <${Section} title="Contacts">${['LH', 'RH', 'LF', 'RF'].map((k) => { const id = l.contacts[k], h = id != null ? byId.get(id) : null; return html`<div class="contact"><i style=${{ background: LIMB_COL[k] }}></i><span>${limbNames[k]}</span><b>${h ? `#${h.label ?? h.id}` : '–'}</b>${h?.led != null && html`<small>LED ${h.led}</small>`}</div>`; })}<//>
    <${Section} title="Records" hint="Best score per game and difficulty, kept in this browser.">
      <div class="card">${GAMES.map((x) => html`<div class="rec-game"><b>${x.title}</b>${OPTIONS.difficulty.choices.map((c) => html`<div class="kv"><span>${c.title}</span><b>${formatScore(x.id, g.best[recordKey(x.id, c.id)] || 0)}</b></div>`)}</div>`)}</div>
    <//>
  </div>`;
}

/** Score, time and lives on screen (the wall shows the same with LEDs). */
export function GameHud() {
  const g = S((s) => s.game);
  if (!g.active || !g.state) return null;
  const st = g.state, id = g.current, over = st.phase === 'over', best = g.best[recordKey(id, g.opts.difficulty)] || 0;
  let line;
  if (id === 'walltest') line = over ? html`<b>Wall test</b><span>Done</span>` : html`<b>Wall test</b><span>Watch the wall</span><span>${mmss(st.secondsLeft)}</span>`;
  else if (st.phase === 'ready') line = html`<b>Get ready</b><span class="big">${st.countdown}</span>`;
  else if (st.paused && !over) line = html`<b>Tracking lost</b><span>The game is paused until the climber is seen again</span>`;
  else if (id === 'coins') line = over ? html`<b>Time is up</b><span class="big">${st.score}</span><span>coins score · best ${best}</span>` : html`<b>Coins</b><span class="big">${st.score}</span><span>${st.combo > 1 ? `combo ×${st.combo}` : ''}</span><span>${mmss(st.secondsLeft)}</span>`;
  else if (id === 'chaser') line = over ? html`<b>Caught</b><span class="big">${st.score} s</span><span>survived · best ${best} s</span>` : html`<b>Chaser</b><span class="big">${st.score} s</span><span class="hearts">${'♥'.repeat(st.lives)}${'♡'.repeat(Math.max(0, st.maxLives - st.lives))}</span>${st.frozen ? html`<span>frozen</span>` : ''}`;
  else line = over ? html`<b>Game over</b><span class="big">${st.score} s</span><span>survived · best ${best} s</span>` : html`<b>Dodge</b><span class="big">${st.score} s</span><span class="hearts">${'♥'.repeat(st.lives)}${'♡'.repeat(Math.max(0, st.maxLives - st.lives))}</span>`;
  const again = () => (id === 'walltest' ? app.startWallTest() : app.startGame(id));
  return html`<div class=${`game-hud ${over ? 'over' : ''}`}>${line}${over && html`<span class="hud-btns"><button class="btn primary" onClick=${again}>${id === 'walltest' ? 'Run again' : 'Play again'}</button><button class="btn" onClick=${() => app.stopGame()}>Close</button></span>`}</div>`;
}
