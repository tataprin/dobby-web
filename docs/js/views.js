// Small view pieces shared by several pages.
import { h, icon, emptyState } from './util.js';

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
  const { actions = null, cls = '', id = null, sub = null } = opts;
  return h('section', { class: `panel ${cls}`.trim(), id, 'aria-label': typeof title === 'string' ? title : null },
    title ? h('div', { class: 'panel-head' }, h('div', null, h('h2', null, title), sub ? h('p', { class: 'muted small' }, sub) : null), actions) : null,
    ...kids);
}

export function pageHead(title, sub, actions) {
  return h('div', { class: 'page-head' },
    h('div', { class: 'page-title' }, h('h1', null, title), sub ? h('div', { class: 'page-sub' }, sub) : null),
    actions ? h('div', { class: 'page-actions' }, actions) : null);
}

export function noBotState() {
  return emptyState('ยังไม่มีบอทในบัญชีนี้',
    'ติดตั้งเอเจนต์บนเครื่องที่รัน MT5 แล้วรัน python dobby_agent.py register บอทจะขึ้นที่นี่เอง',
    h('a', { class: 'btn primary', href: '#/downloads' }, icon('box'), 'ดูวิธีติดตั้ง'));
}

export function onOff(v, onText = 'เปิด', offText = 'ปิด') {
  return h('span', { class: `onoff ${v ? 'on' : 'off'}` }, v ? icon('check') : icon('x'), v ? onText : offText);
}

export function toneLabel(tone) {
  return { good: 'good', warn: 'warn', critical: 'critical', paused: 'paused', off: 'off' }[tone] || 'off';
}
