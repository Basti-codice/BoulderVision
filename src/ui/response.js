// The responsiveness menu (how quickly a limb counts on a hold), shared by the Live and Games panels.
import { html } from 'htm/preact';
import { useState } from 'preact/hooks';
import { app } from '../app/controller.js';
import { S, Slider, Seg } from './kit.js';

export /** How quickly a limb counts on a hold. Presets for the common cases, sliders for the rest, and where the time goes. */
function ResponseMenu() {
  const live = S((s) => s.live), c = live.contact, t = live.timing;
  const [open, setOpen] = useState(false);
  const set = (key) => (value) => app.setContact({ key, value });
  return html`<div class="response">
    <div class="field"><span>Responsiveness</span></div>
    <${Seg} value=${c.preset} onChange=${(preset) => app.setContact({ preset })} options=${[{ id: 'precise', label: 'Precise', title: 'Steadier, a bit later' }, { id: 'balanced', label: 'Balanced' }, { id: 'fast', label: 'Fast', title: 'Quicker, may flicker' }]} />
    <p class="hint">${c.preset === 'custom' ? 'Custom values.' : 'Fast reacts sooner but can flicker between neighbouring holds. Precise is steadier.'} <button class="linkbtn" onClick=${() => setOpen(!open)}>${open ? 'Hide fine-tuning' : 'Fine-tune'}</button></p>
    ${open && html`<div>
      <${Slider} label="Hold time" value=${c.holdMs} min=${20} max=${250} step=${5} fmt=${(v) => `${v} ms`} lo="instant" hi="steady" onInput=${set('holdMs')} />
      <${Slider} label="Release time" value=${c.releaseMs} min=${40} max=${400} step=${10} fmt=${(v) => `${v} ms`} lo="lets go quickly" hi="sticks" onInput=${set('releaseMs')} />
      <${Slider} label="Fastest touch" value=${c.maxSpeed} min=${40} max=${300} step=${10} fmt=${(v) => `${v} cm/s`} lo="only slow hands" hi="also fast moves" onInput=${set('maxSpeed')} />
      <${Slider} label="Smoothing" value=${c.smoothing} min=${0} max=${1} step=${0.05} fmt=${(v) => `${Math.round(v * 100)}%`} lo="raw, quick" hi="smooth, lags" onInput=${set('smoothing')} />
    </div>`}
    ${live.running && t && html`<p class="hint">Where the time goes (median): pose ${t.pose ?? '–'} ms · hold time ${t.hold ?? '–'} ms · LED ${t.led ?? '–'} ms. The camera adds its own delay on top.</p>`}
  </div>`;
}
