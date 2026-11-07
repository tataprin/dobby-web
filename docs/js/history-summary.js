// ประวัติ > สรุป (SPEC 9.5): one week or one month next to the period before it, trading P&L without cash flows, per
// strategy, best and worst trade; printable as one page ("พิมพ์ / บันทึกเป็น PDF" -> the browser's Save as PDF).
import { h, icon, fmtNum, fmtPct, fmtThai, money, pnl } from './util.js';
import { periodBounds, summarize } from './analytics.js';
import { tradeHref, REASON_LABELS } from './journal.js';
import { modChip, panel, segmented } from './views.js';

const DAY = 86400000;

export function periodLabel(b) {
  if (b.kind === 'month') return fmtThai(b.from + 15 * DAY, 'month');
  const a = fmtThai(b.from, 'date'), z = fmtThai(b.to - 1, 'date');
  return `${a} ถึง ${z}`;
}
const periodName = (b) => (b.kind === 'month' ? (b.offset === 0 ? 'เดือนนี้' : b.offset === -1 ? 'เดือนก่อน' : 'เดือน') : (b.offset === 0 ? 'สัปดาห์นี้' : b.offset === -1 ? 'สัปดาห์ก่อน' : 'สัปดาห์'));

// c: { bot, trades, rows, flows, st, kind, offset, setPeriod(kind, offset), earliest }
export function summaryView(c) {
  const cur = (c.st && c.st.account && c.st.account.currency) || 'USD';
  const b = periodBounds(c.kind, c.offset), pb = periodBounds(c.kind, c.offset - 1);
  const fb = c.st && c.st.virtual ? Number(c.st.virtual.start) : null;
  const s = summarize(c.trades, c.rows, c.flows, b.from, b.to, fb);
  const p = summarize(c.trades, c.rows, c.flows, pb.from, pb.to, fb);
  const label = periodLabel(b);

  const seg = segmented({ label: 'ช่วงสรุป', get: () => c.kind, set: (v) => c.setPeriod(v, 0), options: [{ value: 'week', label: 'สัปดาห์' }, { value: 'month', label: 'เดือน' }] });
  const canPrev = b.from > (c.earliest ?? -Infinity) - 31 * DAY;
  const bar = h('div', { class: 'report-bar no-print' }, seg,
    h('div', { class: 'report-nav' },
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'ช่วงก่อนหน้า', disabled: !canPrev, onclick: () => c.setPeriod(c.kind, c.offset - 1) }, h('span', { class: 'ico-flip' }, icon('chevron'))),
      h('span', { class: 'report-when' }, periodName(b)),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'ช่วงถัดไป', disabled: c.offset >= 0, onclick: () => c.setPeriod(c.kind, c.offset + 1) }, icon('chevron'))),
    h('button', { class: 'btn', type: 'button', onclick: () => window.print() }, icon('download'), 'พิมพ์ / บันทึกเป็น PDF'));

  const delta = (now, before, unit = true) => {
    if (!Number.isFinite(before)) return 'ช่วงก่อนไม่มีข้อมูล';
    const d = now - before;
    return ['ช่วงก่อน ', unit ? h('span', { class: 'num' }, fmtNum(before)) : String(before), ' (', h('span', { class: `num ${d > 0 ? 'pos' : d < 0 ? 'neg' : ''}` }, `${d >= 0 ? '+' : '−'}${fmtNum(Math.abs(d), unit ? 2 : 0)}`), ')'];
  };
  const fig = (label, value, foot) => h('div', { class: 'fig' }, h('p', { class: 'fig-label' }, label), h('p', { class: 'fig-value' }, value), h('div', { class: 'fig-foot' }, foot));
  const tradeFoot = (t) => (t ? [modChip(t.module), ' ', fmtThai(t.closeUtc, 'short'), ' ', REASON_LABELS[t.reason] || t.reason || ''] : 'ไม่มีไม้ในช่วงนี้');
  const wr = s.stats.winRate, pwr = p.stats.winRate;

  const modRows = [...new Set([...s.perModule.map((m) => m.module), ...p.perModule.map((m) => m.module)])].map((m) => {
    const a = s.perModule.find((x) => x.module === m) || { trades: 0, wins: 0, losses: 0, winRate: null, net: 0 };
    const z = p.perModule.find((x) => x.module === m) || { net: 0, trades: 0 };
    return h('tr', null,
      h('td', { 'data-label': 'สูตร' }, modChip(m)),
      h('td', { 'data-label': 'ไม้', class: 'num' }, `${a.trades} (${a.wins}/${a.losses})`),
      h('td', { 'data-label': 'อัตราชนะ', class: 'num' }, a.winRate === null ? '—' : fmtPct(a.winRate, 0)),
      h('td', { 'data-label': 'สุทธิ', class: 'num' }, pnl(a.net)),
      h('td', { 'data-label': 'ช่วงก่อน', class: 'num' }, z.trades ? pnl(z.net) : '—'));
  });

  const report = h('article', { class: 'report', 'aria-label': `สรุป${periodName(b)}` },
    h('div', { class: 'print-head print-only' },
      h('p', { class: 'print-brand' }, 'Dobby รายงานผลบอท'),
      h('p', null, `${c.bot.name} ${label}`),
      h('p', { class: 'muted small' }, `พิมพ์เมื่อ ${fmtThai(Date.now(), 'datetime')} น.`)),
    h('div', { class: 'report-title' }, h('h2', null, label), h('p', { class: 'muted small' }, `${c.bot.name} เวลาไทย นับไม้ที่ปิดในช่วงนี้ เทียบกับ${periodName(pb)} (${periodLabel(pb)})`)),
    h('section', { class: 'figs', 'aria-label': 'ตัวเลขหลัก' },
      fig('กำไรจากการเทรด', money(s.stats.net, { signed: true, unit: cur }), [
        s.ret !== null && c.kind === 'month' ? h('p', null, h('span', { class: 'num' }, fmtPct(s.ret, 1, true)), ' ของทุน (ไม่นับเงินฝาก-ถอน)') : h('p', null, 'ไม่นับเงินฝาก-ถอน'),
        h('p', null, delta(s.stats.net, p.stats.trades ? p.stats.net : NaN))]),
      fig('จำนวนไม้', h('span', { class: 'fig-text' }, `${s.stats.trades} ไม้`), [
        h('p', null, wr === null ? 'ไม่มีไม้ที่ปิด' : ['ชนะ ', h('span', { class: 'num' }, fmtPct(wr, 0)), ` (${s.stats.wins}/${s.stats.losses})`]),
        h('p', null, pwr === null ? 'ช่วงก่อนไม่มีไม้' : ['ช่วงก่อน ', `${p.stats.trades} ไม้ ชนะ `, h('span', { class: 'num' }, fmtPct(pwr, 0))])]),
      fig('ไม้ที่ดีที่สุด', s.best ? h('a', { class: 'fig-link', href: tradeHref(s.best.key || '') }, money(s.best.pnl, { signed: true, unit: cur })) : '—', h('p', null, tradeFoot(s.best))),
      fig('ไม้ที่แย่ที่สุด', s.worst ? h('a', { class: 'fig-link', href: tradeHref(s.worst.key || '') }, money(s.worst.pnl, { signed: true, unit: cur })) : '—', h('p', null, tradeFoot(s.worst)))),
    panel('แยกตามสูตร', {},
      modRows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'rtable' },
        h('thead', null, h('tr', null, ['สูตร', 'ไม้', 'อัตราชนะ', 'สุทธิ', 'ช่วงก่อน'].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', null, modRows))) : h('p', { class: 'muted' }, 'ไม่มีไม้ที่ปิดในช่วงนี้และช่วงก่อน')),
    h('div', { class: 'grid-2' },
      panel('ความเสี่ยงในช่วงนี้', {}, h('dl', { class: 'kv' },
        h('dt', null, 'ลดลงมากสุดจากจุดสูงสุด'), h('dd', null, s.trades.length ? money(-s.maxDd, { signed: true, unit: cur }) : '—'),
        h('dt', null, 'แพ้ติดกันนานสุด'), h('dd', null, `${s.longestStreak} ไม้`),
        h('dt', null, 'ทุนต้นช่วง'), h('dd', null, s.startCapital ? money(s.startCapital, { unit: cur }) : '—'))),
      panel('เงินฝาก-ถอนในช่วงนี้', {}, s.flows.length ? h('dl', { class: 'kv' },
        s.flows.map((f) => [h('dt', null, fmtThai(Date.parse(f.ts), 'short')), h('dd', null, money(f.amount, { signed: true, unit: cur }))]),
        h('dt', null, 'สุทธิ'), h('dd', null, money(s.flowTotals.net, { signed: true, unit: cur }))) : h('p', { class: 'muted' }, 'ไม่มีเงินฝาก-ถอนที่ยืนยันแล้ว'))),
    h('p', { class: 'muted small report-note' }, 'กำไรจากการเทรดนับเฉพาะไม้ของ Dobby ไม่นับเงินฝาก-ถอน % ของทุนคิดแบบ modified Dietz (เงินฝากนับเป็นทุนเฉพาะช่วงที่อยู่ในบัญชี) ผลในอดีตไม่ได้บอกผลในอนาคต'));

  return h('div', { class: 'stack-lg' }, bar, report);
}
