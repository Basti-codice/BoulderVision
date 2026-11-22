// Small building blocks shared by the panels.
import { html } from 'htm/preact';
import { store } from '../app/controller.js';
import { useStore } from '../store/store.js';

export const S = (sel) => useStore(store, sel);
export const Section = ({ title, hint, children, right }) => html`<section class="sec"><div class="sec-h"><h3>${title}</h3>${right}</div>${hint && html`<p class="hint">${hint}</p>`}${children}</section>`;
export const Btn = ({ children, kind = '', ...p }) => html`<button class=${`btn ${kind}`} ...${p}>${children}</button>`;
export const Slider = ({ label, value, min, max, step = 1, onInput, fmt = (v) => v, lo, hi, disabled }) => html`
  <label class=${`slider ${disabled ? 'off' : ''}`}><div class="sl-top"><span>${label}</span><b>${fmt(value)}</b></div>
  <input type="range" min=${min} max=${max} step=${step} value=${value} disabled=${disabled} onInput=${(e) => onInput(+e.target.value)} />
  ${(lo || hi) && html`<div class="sl-ends"><span>${lo}</span><span>${hi}</span></div>`}</label>`;
export const Seg = ({ options, value, onChange }) => html`<div class="seg">${options.map((o) => html`<button class=${value === o.id ? 'on' : ''} onClick=${() => onChange(o.id)} title=${o.title || ''}>${o.label}</button>`)}</div>`;
