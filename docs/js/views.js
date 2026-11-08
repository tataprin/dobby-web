// Small view pieces shared by several pages: chips, panels, page head with the "?" help link, teaching empty
// states, and the simple controls (stepper, big switch, segmented buttons, 3-step progress).
import { h, icon, newId, callout } from './util.js';
import { app } from './state.js';

const MOD_SLOT = { A_new: 1, NY: 2, C5G: 3, ASIA16: 4 };
export const modSlot = (m) => MOD_SLOT[m] || 5;

export function modChip(m) {
  return h('span', { class: `mod m${modSlot(m)}` }, h('span', { class: 'sw', 'aria-hidden': 'true' }), m || '—');
}

export function sideEl(side) {
  if (side === 'BUY') return h('span', { class: 'side buy' }, '▲ ซื้อ');
  if (side === 'SELL') return h('span', { class: 'side sell' }, '▼ ขาย');
  return h('span', { class: 'muted' }, '—');
}

export function kv(rows) {
  return h('dl', { class: 'kv' }, rows.filter(Boolean).map(([k, v]) => [h('dt', null, k), h('dd', null, v ?? '—')]));
}

export function panel(title, opts = {}, ...kids) {
  const { actions = null, cls = '', id = null, sub = null, icon: ic = null } = opts;
  return h('section', { class: `panel ${cls}`.trim(), id, 'aria-label': typeof title === 'string' ? title : null },
    title ? h('div', { class: 'panel-head' },
      h('div', { class: 'panel-title' }, ic ? h('span', { class: 'panel-ico' }, icon(ic)) : null,
        h('div', null, h('h2', null, title), sub ? h('p', { class: 'muted small' }, sub) : null)), actions) : null,
    ...kids);
}

// "?" button: opens the matching section of the guide (#/guide/<section>).
export function helpBtn(section, label = 'วิธีใช้') {
  return h('a', { class: 'help-btn', href: `#/guide/${section}`, title: 'วิธีใช้หน้านี้', 'aria-label': `วิธีใช้: ${label}` },
    h('span', { class: 'help-q', 'aria-hidden': 'true' }, '?'), h('span', { class: 'help-text' }, label));
}

export function pageHead(title, sub, actions, help) {
  return h('div', { class: 'page-head' },
    h('div', { class: 'page-title' }, h('h1', null, title), sub ? h('div', { class: 'page-sub' }, sub) : null),
    actions || help ? h('div', { class: 'page-actions' }, actions || null, help ? helpBtn(help) : null) : null);
}

// No bot yet: teach the 3 steps instead of a bare "empty" message.
export function noBotState() {
  return h('section', { class: 'teach-empty', 'aria-label': 'ยังไม่มีบอท' },
    h('div', { class: 'teach-art', html: NO_BOT_ART }),
    h('h2', null, 'ยังไม่มีบอท'),
    h('p', { class: 'muted' }, 'เชื่อมคอมที่เปิด MT5 ไว้กับเว็บนี้ ทำครั้งเดียว ใช้เวลาราว 15 นาที'),
    h('ol', { class: 'teach-steps' },
      h('li', null, h('strong', null, 'โหลดแอป Dobby'), h('span', null, 'ไฟล์เดียว ไม่ต้องติดตั้ง')),
      h('li', null, h('strong', null, 'เปิดแอปแล้วทำตาม'), h('span', null, 'เข้าสู่ระบบด้วยอีเมลเดียวกับเว็บนี้ แล้วกดเริ่ม')),
      h('li', null, h('strong', null, 'บอทจะขึ้นที่นี่เอง'), h('span', null, 'ภายในหนึ่งนาที พร้อมยอดเงินและสถานะ'))),
    h('div', { class: 'row gap wrap center' },
      h('a', { class: 'btn primary big', href: '#/downloads' }, icon('download'), 'ดาวน์โหลดแอป'),
      h('a', { class: 'btn ghost', href: '#/guide/start' }, icon('book'), 'ดูวิธีเริ่มต้น')),
    app.mode === 'demo' && app.api && app.api.noBots
      ? h('p', { class: 'hint' }, 'โหมดตัวอย่าง: นี่คือหน้าตาตอนที่ยังไม่มีบอท ',
        h('a', { href: '#/guide/start', onclick: async (e) => { e.preventDefault(); await restoreDemoBots(); } }, 'แสดงบอทตัวอย่างอีกครั้ง'))
      : null);
}

export async function restoreDemoBots() {
  const { loadBots } = await import('./state.js');
  app.api.setDemoNoBots(false);
  await loadBots();
  location.hash = '#/dashboard';
}

const NO_BOT_ART = `<svg viewBox="0 0 240 120" role="img" aria-label="คอมกับเว็บยังไม่ได้เชื่อมกัน">
<rect x="16" y="22" width="90" height="60" rx="9" fill="var(--sheet)" stroke="var(--hair-strong)"/>
<path d="M28 66l12-10 9 5 13-15 14 9 18-13" fill="none" stroke="var(--ink)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M50 96h22M61 82v14" stroke="var(--hair-strong)" stroke-width="2" stroke-linecap="round"/>
<rect x="152" y="16" width="70" height="90" rx="13" fill="var(--sheet)" stroke="var(--hair-strong)"/>
<path d="M175.5 30h17l6 6v17l-6 6h-17l-6-6V36z" fill="none" stroke="var(--slate)" stroke-width="1.4"/>
<rect x="164" y="70" width="46" height="6" rx="3" fill="var(--well-strong)"/><rect x="164" y="82" width="32" height="6" rx="3" fill="var(--well-strong)"/>
<path d="M114 52h30" stroke="var(--slate)" stroke-width="1.6" stroke-dasharray="2 5" stroke-linecap="round"/>
<circle cx="129" cy="52" r="10" fill="var(--bg)" stroke="var(--gold-ink)" stroke-width="1.4"/>
<path d="M129 47v6M129 56.5v.5" stroke="var(--gold-ink)" stroke-width="2" stroke-linecap="round"/>
</svg>`;

export function onOff(v, onText = 'เปิด', offText = 'ปิด') {
  return h('span', { class: `onoff ${v ? 'on' : 'off'}` }, v ? icon('check') : icon('x'), v ? onText : offText);
}

export function toneLabel(tone) {
  return { good: 'good', warn: 'warn', critical: 'critical', paused: 'paused', off: 'off' }[tone] || 'off';
}

// ------------------------------------------------------------------ simple controls
// Each control returns an element with .update() that refreshes it from get() without rebuilding (keeps focus).
const roundTo = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

export function stepper({ label, get, set, step = 1, min = -Infinity, max = Infinity, decimals = 0, unit = '', disabled = () => false, id, trim = false, format = null }) {
  const inId = id || newId('st');
  const input = h('input', {
    id: inId, class: 'stepper-in', type: 'text', inputmode: decimals ? 'decimal' : 'numeric', autocomplete: 'off', 'aria-label': label,
  });
  const fmt = (x) => (Number.isFinite(x) ? (format ? format(x) : trim ? String(roundTo(x, decimals)) : x.toFixed(decimals)) : '');
  const bump = (dir) => {
    const cur = Number(get());
    const base = Number.isFinite(cur) ? cur : min;
    // snap to the step grid first so 0.034 + 0.01 -> 0.04
    let next = roundTo((dir > 0 ? Math.floor(base / step + 1e-9) + 1 : Math.ceil(base / step - 1e-9) - 1) * step, decimals);
    next = Math.max(min, Math.min(max, next));
    set(next);
  };
  const minus = h('button', { type: 'button', class: 'step-btn', 'aria-label': `ลด ${label}`, onclick: () => bump(-1) }, '−');
  const plus = h('button', { type: 'button', class: 'step-btn', 'aria-label': `เพิ่ม ${label}`, onclick: () => bump(1) }, '+');
  const commit = () => {
    const raw = input.value.replace(/,/g, '').trim();
    const n = raw === '' ? NaN : Number(raw);
    set(Number.isFinite(n) ? roundTo(n, decimals) : NaN);
  };
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp') { e.preventDefault(); bump(1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); bump(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); commit(); }
  });
  const el = h('div', { class: 'stepper' }, minus, h('div', { class: 'stepper-mid' }, input, unit ? h('span', { class: 'stepper-unit' }, unit) : null), plus);
  el.input = input;
  el.update = () => {
    const x = Number(get());
    if (document.activeElement !== input) input.value = fmt(x);
    const off = disabled();
    input.disabled = off;
    minus.disabled = off || !(x > min + 1e-9);
    plus.disabled = off || !(x < max - 1e-9);
  };
  el.update();
  return el;
}

// Big on/off switch with a title and one line of text. get() -> bool, set(bool).
export function bigToggle({ title, text, get, set, disabled = () => false, badge = null, extra = null }) {
  const tid = newId('tg');
  const btn = h('button', { type: 'button', class: 'switch', role: 'switch', 'aria-labelledby': tid, onclick: () => set(!get()) },
    h('span', { class: 'switch-knob', 'aria-hidden': 'true' }));
  const state = h('span', { class: 'toggle-state' });
  const el = h('div', { class: 'toggle-card' },
    h('div', { class: 'toggle-main' },
      h('div', { class: 'toggle-copy' },
        h('p', { class: 'toggle-title', id: tid }, title, badge ? [' ', badge] : null),
        text ? h('p', { class: 'toggle-text' }, text) : null),
      h('div', { class: 'toggle-side' }, state, btn)),
    extra);
  el.update = () => {
    const on = !!get();
    btn.setAttribute('aria-checked', on ? 'true' : 'false');
    btn.disabled = disabled();
    el.classList.toggle('on', on);
    state.textContent = on ? 'เปิด' : 'ปิด';
  };
  el.update();
  return el;
}

// Segmented buttons (radiogroup). options [{value, label, icon?}]
export function segmented({ label, options, get, set, disabled = () => false, wide = false }) {
  const el = h('div', { class: `segmented${wide ? ' wide' : ''}`, role: 'radiogroup', 'aria-label': label });
  const btns = options.map((o) => h('button', {
    type: 'button', role: 'radio', onclick: () => set(o.value),
    onkeydown: (e) => {
      if (!['ArrowRight', 'ArrowLeft'].includes(e.key)) return;
      e.preventDefault();
      const i = options.findIndex((x) => x.value === get());
      const n = options[(i + (e.key === 'ArrowRight' ? 1 : options.length - 1)) % options.length];
      set(n.value);
      btns[options.indexOf(n)].focus();
    },
  }, o.icon ? icon(o.icon) : null, o.label));
  el.append(...btns);
  el.update = () => {
    const cur = get();
    btns.forEach((b, i) => {
      const on = options[i].value === cur;
      b.className = on ? 'on' : '';
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
      b.disabled = disabled();
    });
  };
  el.update();
  return el;
}

// 3-step progress. steps [{label, state: 'done'|'active'|'wait'|'todo'|'fail', note}]
export function progressSteps(steps) {
  return h('ol', { class: 'progress-steps' }, steps.map((s, i) => h('li', { class: `ps ps-${s.state}` },
    h('span', { class: 'ps-dot', 'aria-hidden': 'true' }, s.state === 'done' ? icon('check') : s.state === 'fail' ? icon('x') : String(i + 1)),
    h('span', { class: 'ps-copy' }, h('span', { class: 'ps-label' }, s.label), s.note ? h('span', { class: 'ps-note' }, s.note) : null),
    h('span', { class: 'sr-only' }, { done: ' (เสร็จแล้ว)', active: ' (กำลังทำ)', wait: ' (รออยู่)', todo: ' (ยังไม่ถึง)', fail: ' (ไม่สำเร็จ)' }[s.state] || ''))));
}
