// AI เงา (SPEC 10.6): what the shadow AI would have done with each open trade of the bot shown, every few minutes,
// next to what really happened (the journal's CLOSE row of the same ticket: "pos=<ticket>"). Log only: nothing here
// changes the bot. The full scoring (tighten / reverse on real prices) is the offline report
// (research/strategies/shadow_score).
import { h, mount, fmtThai, fmtNum, pnl, errorState, loadingState, emptyState, callout, confirmDialog, toast, errText } from '../util.js';
import { myBot, isAdmin, ownsBot } from '../state.js';
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

const OP = { add: 'จดบทเรียนใหม่', reinforce: 'ยืนยันบทเรียน', weaken: 'ลดน้ำหนักบทเรียน', retire: 'เลิกใช้บทเรียน' };
const VERDICT = { better: ['ดีกว่าบอท', 'good'], worse: ['แย่กว่าบอท', 'bad'], same: ['เท่ากัน', 'off'] };

/** SPEC 10.7: the AI's own review of a closed trade. */
function reviewBlock(rv, lessonsById) {
  const checks = (rv.outcome && rv.outcome.checks) || [];
  return h('div', { class: 'shadow-review' },
    h('p', { class: 'shadow-review-title' }, 'AI ทบทวนไม้นี้หลังปิด'),
    rv.summary ? h('p', null, rv.summary) : null,
    rv.mistakes ? h('p', null, h('strong', null, 'ผิดตรงไหน: '), rv.mistakes) : null,
    checks.length ? h('div', { class: 'shadow-checks' }, checks.map((c) => {
      const [label, tone] = VERDICT[c.verdict] || [c.verdict, 'off'];
      return h('span', { class: `chip ${tone}` }, `${(ACTION[c.action] || [c.action])[0]}: ${label} `, pnl(c.delta));
    })) : null,
    (rv.ops || []).length ? h('ul', { class: 'shadow-ops' }, rv.ops.map((o) => {
      const l = lessonsById.get(Number(o.id));
      return h('li', null, h('strong', null, `${OP[o.op] || o.op} #${o.id}`), ` ${o.text || (l && l.text) || ''}`, o.why ? h('span', { class: 'muted small' }, ` (${o.why})`) : null);
    })) : null);
}

/** SPEC 10.7: the lessons the AI reads before every decision; the owner may retire one. */
function memoryPanel(lessons, reviews, onRetire, canEdit) {
  const active = lessons.filter((l) => l.status === 'active'), retired = lessons.filter((l) => l.status !== 'active');
  const row = (l) => h('li', { class: `shadow-lesson ${l.status}` },
    h('div', { class: 'grow' }, h('span', { class: 'shadow-weight', title: 'น้ำหนัก = จำนวนไม้ที่ยืนยันบทเรียนนี้ ลบจำนวนไม้ที่ค้าน' }, `#${l.id} น้ำหนัก ${l.weight}`), ' ', l.text,
      h('div', { class: 'muted small' }, `จากไม้ ${(l.tickets || []).slice(-5).join(', ') || '—'} · แก้ล่าสุด ${fmtThai(Date.parse(l.updated_at), 'datetime')}`)),
    canEdit && l.status === 'active' ? h('button', { class: 'btn ghost small', type: 'button', onclick: () => onRetire(l) }, 'เลิกใช้') : null);
  return panel('ความจำของ AI', { sub: `AI อ่านบทเรียนเหล่านี้ทุกครั้งก่อนตัดสินใจ ทบทวนแล้ว ${reviews.length} ไม้ บทเรียนที่ใช้อยู่ ${active.length} ข้อ (สูงสุด 20)` },
    active.length ? h('ul', { class: 'shadow-lessons' }, active.map(row))
      : h('p', { class: 'muted' }, 'ยังไม่มีบทเรียน หลังไม้แรกที่ AI ดูปิดลง AI จะทบทวนแล้วจดบทเรียนเอง'),
    retired.length ? h('details', null, h('summary', null, `บทเรียนที่เลิกใช้แล้ว ${retired.length} ข้อ`), h('ul', { class: 'shadow-lessons' }, retired.map(row))) : null,
    h('p', { class: 'muted small' }, 'AI เรียนจากผลจริงของไม้ที่ปิดแล้ว ไม้เดียวอาจเป็นแค่โชค บทเรียนที่น้ำหนักสูงจึงน่าเชื่อกว่า บทเรียนที่ถูกค้านจนน้ำหนักเหลือ 0 จะถูกเลิกใช้เอง'));
}

// ------------------------------------------------------------------ SPEC 10.8: the AI's own paper trades
const CLOSE_TH = { sl: 'โดน SL', tp: 'ถึง TP', ai_close: 'AI สั่งปิด', reverse: 'AI กลับฝั่ง', time: 'หมดเวลา', stale: 'ปิดเพราะไม่มีราคา' };

function aiPortfolioPanel(trades, scans, status) {
  const open = trades.find((t) => t.status === 'open');
  const closed = trades.filter((t) => t.status === 'closed');
  const total = closed.reduce((s, t) => s + Number(t.pnl || 0), 0);
  const wins = closed.filter((t) => Number(t.pnl) > 0).length;
  const m = (status && status.market) || {};
  let openBox = h('p', { class: 'muted' }, 'ตอนนี้ AI ไม่มีไม้เปิดอยู่');
  if (open) {
    const px = Number(open.side === 'BUY' ? m.bid : m.ask);
    const live = Number.isFinite(px) && px > 0 ? Math.round((open.side === 'BUY' ? px - open.entry : open.entry - px) * open.lots * 100 * 100) / 100 : null;
    const risk = Math.round(Math.abs(open.entry - open.sl) * open.lots * 100 * 100) / 100, reward = Math.round(Math.abs(open.tp - open.entry) * open.lots * 100 * 100) / 100;
    openBox = h('div', { class: 'shadow-ai-open' },
      h('div', { class: 'shadow-head' }, h('span', { class: 'chip live' }, 'ไม้ของ AI เปิดอยู่'), sideEl(open.side), h('span', { class: 'num' }, `${fmtNum(open.lots)} ล็อต`),
        h('span', null, `เข้า ${fmtNum(open.entry)}`), h('span', { class: 'muted small' }, `เปิด ${fmtThai(Date.parse(open.opened_at), 'datetime')}`)),
      h('div', { class: 'shadow-plan-line' }, `SL ${fmtNum(open.sl)} ถ้าโดน `, pnl(-risk), ` · TP ${fmtNum(open.tp)} ถ้าถึง `, pnl(reward)),
      live !== null ? h('div', { class: 'shadow-plan-line' }, 'ตอนนี้ ', pnl(live)) : null,
      open.plan && open.plan.reason ? h('p', { class: 'muted' }, open.plan.reason) : null);
  }
  const last = scans[0];
  return panel('พอร์ตของ AI (เทรดเองบนกระดาษ)', { sub: 'AI ตัดสินใจเองว่าจะเปิดไม้เมื่อไหร่ ฝั่งไหน SL และ TP เท่าไหร่ แล้วดูแลไม้ของตัวเองทุก 5 นาที ใช้ราคาจริงคิดผล แต่ไม่มีคำสั่งไปถึงโบรกเกอร์' },
    h('dl', { class: 'kv' },
      h('dt', null, 'ไม้ที่ปิดแล้ว'), h('dd', null, `${closed.length} ไม้ ชนะ ${wins}${closed.length ? ` (${Math.round((wins / closed.length) * 100)} %)` : ''}`),
      h('dt', null, 'กำไรรวมของ AI'), h('dd', null, pnl(total))),
    openBox,
    last ? h('div', { class: 'shadow-review' }, h('p', { class: 'shadow-review-title' }, `AI ดูตลาดล่าสุด ${fmtThai(Date.parse(last.ts), 'datetime')}: `,
      h('span', { class: `chip ${last.action === 'open' ? 'live' : 'off'}` }, last.action === 'open' ? `เปิด${last.side === 'BUY' ? 'ซื้อ' : 'ขาย'}` : last.action === 'wait' ? 'รอ' : 'ถามไม่สำเร็จ')),
    h('p', null, last.reason || '—')) : null,
    closed.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'rtable compact' },
      h('thead', null, h('tr', null, ['เปิด', 'ฝั่ง', 'เข้า', 'SL', 'TP', 'ออก', 'ปิดเพราะ', 'กำไร', 'เหตุผลที่เปิด'].map((x) => h('th', { scope: 'col' }, x)))),
      h('tbody', null, closed.map((t) => h('tr', null,
        h('td', { 'data-label': 'เปิด' }, fmtThai(Date.parse(t.opened_at), 'datetime')),
        h('td', { 'data-label': 'ฝั่ง' }, sideEl(t.side)),
        h('td', { 'data-label': 'เข้า', class: 'num' }, fmtNum(t.entry)),
        h('td', { 'data-label': 'SL', class: 'num' }, fmtNum(t.first_sl)),
        h('td', { 'data-label': 'TP', class: 'num' }, fmtNum(t.tp)),
        h('td', { 'data-label': 'ออก', class: 'num' }, fmtNum(t.exit)),
        h('td', { 'data-label': 'ปิดเพราะ' }, CLOSE_TH[t.close_reason] || t.close_reason || '—'),
        h('td', { 'data-label': 'กำไร' }, pnl(t.pnl)),
        h('td', { 'data-label': 'เหตุผลที่เปิด', class: 'shadow-reason' }, (t.plan && t.plan.reason) || '—')))))) : null);
}

function tradePanel(t, close, review, lessonsById) {
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
        h('td', { 'data-label': 'เหตุผล', class: 'shadow-reason' }, r.reason || '—')))))),
    review ? reviewBlock(review, lessonsById) : null);
}

export async function render(root, ctx) {
  const bot = myBot();
  root.append(pageHead('AI เงา', 'ทุก 5 นาทีที่บอทมีไม้เปิดอยู่ AI จะดูกราฟและบอกว่าจะทำอะไรกับไม้นั้น เป็นการทดสอบเท่านั้น บอทไม่ได้ทำตาม', null, null));
  if (!bot) { root.append(noBotState()); return; }
  const box = h('div', { class: 'stack-lg' });
  root.append(box);
  box.append(loadingState());

  let rows = [], journal = [], cost = null, lessons = [], reviews = [], aiTrades = [], aiScans = [], st = null;
  try {
    [rows, journal, cost, lessons, reviews, aiTrades, aiScans, st] = await Promise.all([
      ctx.api.shadowDecisions(bot.id, { limit: 400 }),
      ctx.api.journalTail(bot.id, 400).catch(() => []),
      isAdmin() ? ctx.api.shadowMonthCost().catch(() => null) : null,
      ctx.api.shadowLessons(bot.id).catch(() => []),          // SPEC 10.7 (schema.sql older than the memory: none)
      ctx.api.shadowReviews(bot.id).catch(() => []),
      ctx.api.aiTrades(bot.id).catch(() => []),                // SPEC 10.8
      ctx.api.aiScans(bot.id).catch(() => []),
      ctx.api.botStatus(bot.id).catch(() => null),
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

  const lessonsById = new Map(lessons.map((l) => [Number(l.id), l]));
  const reviewByTicket = new Map(reviews.map((r) => [Number(r.ticket), r]));
  const retire = async (l) => {
    if (!(await confirmDialog(`เลิกใช้บทเรียน #${l.id}`, `${l.text} — AI จะไม่อ่านบทเรียนนี้อีก`, { ok: 'เลิกใช้', danger: true }))) return;
    try { await ctx.api.retireLesson(bot.id, l.id); toast('เลิกใช้บทเรียนแล้ว AI จะไม่อ่านบทเรียนนี้อีก', 'good'); ctx.route(); } catch (e) { toast(errText(e), 'bad'); }
  };
  const stJson = st && (st.status || st);
  mount(box, intro, ...status, aiPortfolioPanel(aiTrades, aiScans, stJson), summary, memoryPanel(lessons, reviews, retire, ownsBot(bot)),
    ...trades.map((t) => tradePanel(t, closes.get(t.ticket), reviewByTicket.get(t.ticket), lessonsById)));
}
