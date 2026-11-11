// AI เงา (SPEC 10.6): what the shadow AI would have done with each open trade of the bot shown, every few minutes,
// next to what really happened (the journal's CLOSE row of the same ticket: "pos=<ticket>"). Log only: nothing here
// changes the bot. The full scoring (tighten / reverse on real prices) is the offline report
// (research/strategies/shadow_score).
import { h, mount, fmtThai, fmtNum, pnl, errorState, loadingState, emptyState, callout } from '../util.js';
import { myBot, isAdmin } from '../state.js';
import { panel, pageHead, modChip, sideEl, noBotState } from '../views.js';

const ACTION = {
  hold: ['ถือต่อ', 'off'],
  close: ['ปิดเลย', 'bad'],
  tighten: ['เลื่อน SL', 'warn'],
  reverse: ['ปิดแล้วเปิดสวน', 'bad'],
  error: ['ถามไม่สำเร็จ', 'pending'],
};
const PAUSE = {
  shadow_disabled: 'ผู้ดูแลยังไม่ได้เปิด AI เงา (ผู้ใช้ > ผู้ช่วย AI)',
  shadow_budget: 'งบ AI เงาของเดือนนี้หมดแล้ว',
  ai_not_configured: 'ยังไม่ได้ตั้งค่า function shadow หรือ API key ใน Supabase',
  not_approved: 'บัญชียังไม่ได้รับอนุมัติ',
  bot_not_found: 'เว็บไม่รู้จักบอทของเครื่องนี้',
};

/** CLOSE rows of the journal by ticket ("pos=<ticket>" in the detail). */
export function closesByTicket(rows) {
  const out = new Map();
  for (const r of rows || []) {
    if (r.event !== 'CLOSE') continue;
    const m = /pos=(\d+)/.exec(r.detail || '');
    if (!m) continue;
    const reason = (/reason=(\w+)/.exec(r.detail || '') || [])[1] || '';
    out.set(Number(m[1]), { pnl: Number(r.pnl), price: Number(r.price), reason, ts_server: r.ts_server });
  }
  return out;
}

/** Decisions (newest first) -> trades (newest first) with their decisions in time order. */
export function groupTrades(rows) {
  const by = new Map();
  for (const r of rows) {
    const k = Number(r.ticket);
    if (!by.has(k)) by.set(k, { ticket: k, module: r.module, side: r.side, lots: Number(r.lots), open: Number(r.open_price), list: [] });
    by.get(k).list.push(r);
  }
  const out = [...by.values()];
  for (const t of out) t.list.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  out.sort((a, b) => String(b.list[b.list.length - 1].ts).localeCompare(String(a.list[a.list.length - 1].ts)));
  return out;
}

/** The first decision that differs from "hold" (and could be applied), or null: what following the AI would change. */
export function firstMove(t) {
  return t.list.find((r) => r.valid !== false && r.action && r.action !== 'hold' && r.action !== 'error') || null;
}

const fin = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));
const sideTh = (s) => (s === 'BUY' ? 'ซื้อ' : 'ขาย');

/** The plan behind one decision, in Thai, with the prices the AI gave and the money they mean (details, SPEC 10.6). */
export function planLines(r) {
  const d = (r && r.details) || {};
  const L = (...kids) => h('div', { class: 'shadow-plan-line' }, ...kids);
  const out = [];
  if (r.action === 'hold') {
    if (fin(d.hold_target)) out.push(L(`ถือไปหาเป้า ${fmtNum(d.hold_target)} ถ้าถึงได้ `, pnl(d.target_pnl)));
    if (fin(d.hold_exit)) out.push(L(`ถ้าราคาไปถึง ${fmtNum(d.hold_exit)} จะปิด ผล `, pnl(d.exit_pnl)));
    if (!out.length) out.push(L(h('span', { class: 'muted' }, 'ถือตามระบบของบอท')));
  } else if (r.action === 'close') {
    if (fin(d.close_pnl)) out.push(L(`ปิดทั้งไม้ที่ ${fmtNum(d.close_price)} ผล `, pnl(d.close_pnl)));
  } else if (r.action === 'tighten') {
    if (fin(d.new_sl)) out.push(L(`เลื่อน SL จาก ${fmtNum(d.old_sl)} ไป ${fmtNum(d.new_sl)} ถ้าโดน SL ใหม่ ผล `, pnl(d.locked_pnl)));
  } else if (r.action === 'reverse' && d.reverse) {
    const v = d.reverse;
    out.push(L(`1. ปิดไม้เดิมที่ ${fmtNum(d.close_price)} ผล `, pnl(d.close_pnl)));
    out.push(L(`2. เปิด${sideTh(v.side)} ${fmtNum(v.lots)} ล็อต ที่ ${fmtNum(v.entry)}`));
    out.push(L(`SL ${fmtNum(v.sl)} (ห่าง ${fmtNum(v.sl_dist)}) ถ้าโดนเสีย `, pnl(v.risk)));
    out.push(L(`TP ${fmtNum(v.tp)} (ห่าง ${fmtNum(v.tp_dist)}) ถ้าถึงได้ `, pnl(v.reward)));
    out.push(L('รวมทั้งสองไม้: ถึง TP ', pnl(d.total_if_tp), ' / โดน SL ', pnl(d.total_if_sl)));
  }
  if (fin(d.pnl_now) && r.action !== 'close' && r.action !== 'reverse') out.push(L(h('span', { class: 'muted small' }, 'ตอนนั้นกำไร '), pnl(d.pnl_now)));
  if (!out.length) out.push(L(h('span', { class: 'muted' }, r.action === 'tighten' && fin(r.new_sl) ? `SL ใหม่ ${fmtNum(r.new_sl)}` : '—')));
  return out;
}

function actionChip(r) {
  const [label, tone] = ACTION[r.action] || [r.action, 'pending'];
  return h('span', { class: `chip ${tone}`, title: r.valid === false ? 'ทำตามไม่ได้ เช่น SL ใหม่ไม่อยู่ระหว่าง SL เดิมกับราคา' : null },
    label, r.valid === false ? ' (ใช้ไม่ได้)' : '');
}

function tradePanel(t, close) {
  const mv = firstMove(t);
  const real = close ? [pnl(close.pnl), h('span', { class: 'muted small' }, ` ${close.reason || ''}`)] : h('span', { class: 'muted' }, 'ยังเปิดอยู่ หรือยังไม่เห็นผลในประวัติล่าสุด');
  let follow = h('span', { class: 'muted' }, 'AI ให้ถือต่อทุกครั้ง ผลเท่ากับบอท');
  if (mv) {
    const when = fmtThai(Date.parse(mv.ts), 'time');
    const note = mv.action === 'close' ? `ปิดตอน ${when}` : mv.action === 'reverse' ? `ปิดแล้วเปิดสวนตอน ${when} ผลของไม้สวนดูจากราคาจริงในรายงาน`
      : `เลื่อน SL ตอน ${when} ผลดูจากราคาจริงในรายงาน`;
    follow = h('div', null, h('p', { class: 'muted small' }, note), ...planLines(mv));
  }
  return panel(null, { cls: 'shadow-trade' },
    h('div', { class: 'shadow-head' }, modChip(t.module), sideEl(t.side), h('span', { class: 'num' }, `${fmtNum(t.lots)} ล็อต`),
      h('span', { class: 'muted' }, `เข้า ${fmtNum(t.open)}`), h('span', { class: 'muted small' }, `#${t.ticket}`)),
    h('dl', { class: 'kv' },
      h('dt', null, 'ผลจริงของบอท'), h('dd', null, real),
      h('dt', null, 'ถ้าทำตาม AI'), h('dd', null, follow)),
    h('div', { class: 'table-wrap' }, h('table', { class: 'rtable compact' },
      h('thead', null, h('tr', null, ['เวลา', 'ราคา', 'กำไรตอนนั้น', 'AI ว่า', 'แผนและตัวเลข', 'มั่นใจ', 'เหตุผล'].map((x) => h('th', { scope: 'col' }, x)))),
      h('tbody', null, t.list.map((r) => h('tr', null,
        h('td', { 'data-label': 'เวลา' }, fmtThai(Date.parse(r.ts), 'datetime')),
        h('td', { 'data-label': 'ราคา', class: 'num' }, fmtNum(r.side === 'BUY' ? r.bid : r.ask)),
        h('td', { 'data-label': 'กำไรตอนนั้น' }, pnl(r.profit)),
        h('td', { 'data-label': 'AI ว่า' }, actionChip(r)),
        h('td', { 'data-label': 'แผนและตัวเลข', class: 'shadow-plan' }, ...planLines(r)),
        h('td', { 'data-label': 'มั่นใจ', class: 'num' }, r.confidence === null || r.confidence === undefined ? '—' : `${r.confidence} %`),
        h('td', { 'data-label': 'เหตุผล', class: 'shadow-reason' }, r.reason || '—')))))));
}

export async function render(root, ctx) {
  const bot = myBot();
  root.append(pageHead('AI เงา', 'ทุก 5 นาทีที่บอทมีไม้เปิดอยู่ AI จะดูกราฟและบอกว่าจะทำอะไรกับไม้นั้น เป็นการทดสอบเท่านั้น บอทไม่ได้ทำตาม', null, null));
  if (!bot) { root.append(noBotState()); return; }
  const box = h('div', { class: 'stack-lg' });
  root.append(box);
  box.append(loadingState());

  let rows = [], journal = [], cost = null;
  try {
    [rows, journal, cost] = await Promise.all([
      ctx.api.shadowDecisions(bot.id, { limit: 400 }),
      ctx.api.journalTail(bot.id, 400).catch(() => []),
      isAdmin() ? ctx.api.shadowMonthCost().catch(() => null) : null,
    ]);
  } catch (e) {
    if (e && e.code === 'not_deployed') {
      mount(box, callout('warn', 'ฐานข้อมูลยังไม่มีส่วนของ AI เงา', h('p', null, 'รัน supabase/schema.sql รุ่นล่าสุดใน Supabase SQL Editor แล้วเปิดหน้านี้อีกครั้ง')));
      return;
    }
    mount(box, errorState(e, () => ctx.route()));
    return;
  }

  const sh = (bot.agent_state && bot.agent_state.shadow) || null;
  const intro = callout('info', 'ทำไมต้องมี AI เงา',
    h('p', null, 'เพื่อพิสูจน์ว่า AI ที่คอยดูไม้ตลอดเวลาทำได้ดีกว่าสูตรตายตัวจริงไหม AI แค่บันทึกว่าจะถือต่อ ปิด เลื่อน SL หรือเปิดสวน บอทยังเทรดตามสูตรเดิมทุกอย่าง'),
    h('p', null, 'เมื่อมีไม้ครบราว 60 ถึง 100 ไม้ จะเทียบผลไม้ต่อไม้กับราคาจริงว่าทำตาม AI แล้วได้หรือเสียกว่าบอทเท่าไหร่'));
  const status = [];
  if (sh && sh.paused) status.push(callout('warn', 'AI เงาหยุดพักอยู่', h('p', null, PAUSE[sh.paused] || sh.paused)));
  if (!sh && !rows.length) {
    status.push(callout('warn', 'แอปที่เครื่องยังไม่ได้ส่งไม้มาให้ AI เงา',
      h('p', null, 'ต้องใช้แอป Dobby รุ่น 1.3.0 ขึ้นไป และผู้ดูแลต้องเปิด AI เงาที่ ผู้ใช้ > ผู้ช่วย AI')));
  }

  const trades = groupTrades(rows);
  const closes = closesByTicket(journal);
  const moved = trades.filter((t) => firstMove(t));
  const counts = Object.fromEntries(Object.keys(ACTION).map((k) => [k, rows.filter((r) => r.action === k).length]));
  const summary = panel('สรุป', { sub: rows.length ? `ไม้ล่าสุด ${trades.length} ไม้ AI ตอบ ${rows.length} ครั้ง` : null },
    rows.length ? h('dl', { class: 'kv' },
      h('dt', null, 'ไม้ที่ AI อยากทำต่างจากบอท'), h('dd', null, `${moved.length} จาก ${trades.length} ไม้`),
      h('dt', null, 'คำตอบทั้งหมด'), h('dd', null, Object.entries(counts).filter(([, n]) => n).map(([k, n]) => h('span', { class: 'shadow-count' }, actionChip({ action: k }), ` ${n}`))),
      sh && sh.last_at ? [h('dt', null, 'ถามล่าสุด'), h('dd', null, fmtThai(Date.parse(sh.last_at), 'datetime'))] : null,
      cost !== null ? [h('dt', null, 'ค่าใช้จ่ายเดือนนี้'), h('dd', null, `${fmtNum(cost, 2)} USD`)] : null)
      : emptyState('ยังไม่มีคำตอบจาก AI เงา', 'คำตอบแรกจะขึ้นเมื่อบอทเปิดไม้ครั้งถัดไป'));

  mount(box, intro, ...status, summary, ...trades.map((t) => tradePanel(t, closes.get(t.ticket))));
}
