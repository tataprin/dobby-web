// AI เงา (SPEC 10.6-10.8, admin only): the shadow AI's answers on the bot's open trades, its own paper trades, its
// memory (lessons) and its reviews. Log only for the bot: nothing here changes the bot. Layout (DESIGN.md "AI เงา"):
// four figures, two equal panels (the AI's open trade / its last look at the market), two equal lists (its trades /
// its lessons), then the bot's trades it watched as expandable rows with a timeline of its answers.
import { h, mount, icon, fmtThai, fmtNum, money, pnl, thaiDayKey, errorState, loadingState, callout, confirmDialog, toast, errText, duration } from '../util.js';
import { myBot, isAdmin, ownsBot } from '../state.js';
import { pageHead, modChip, noBotState } from '../views.js';

const ACTION = {
  hold: ['ถือต่อ', 'off'],
  close: ['ปิดเลย', 'bad'],
  tighten: ['เลื่อน SL', 'warn'],
  reverse: ['ปิดแล้วเปิดสวน', 'bad'],
  error: ['ถามไม่สำเร็จ', 'pending'],
};
const PAUSE = {
  shadow_disabled: 'ผู้ดูแลยังไม่ได้เปิด AI เงา (ผู้ใช้ > ผู้ช่วย AI)',
  shadow_admin_only: 'AI เงาใช้ได้เฉพาะบอทของผู้ดูแล',
  shadow_budget: 'งบ AI เงาของเดือนนี้หมดแล้ว',
  ai_not_configured: 'ยังไม่ได้ตั้งค่า function shadow หรือ API key ใน Supabase',
  not_approved: 'บัญชียังไม่ได้รับอนุมัติ',
  bot_not_found: 'เว็บไม่รู้จักบอทของเครื่องนี้',
};
const CLOSE_TH = { sl: 'โดน SL', tp: 'ถึง TP', ai_close: 'AI สั่งปิด', reverse: 'AI กลับฝั่ง', time: 'หมดเวลา', stale: 'ไม่มีราคา',
  SL: 'โดน SL', TP: 'ถึง TP', LOCK: 'ล็อกกำไร', LOCK1: 'ล็อกกำไร', RUN: 'runner', EXIT: 'ปิดตามเวลา', TIME: 'ปิดตามเวลา', FRIDAY: 'ปิดวันศุกร์', FLAT: 'ปิดตามเวลา' };
const OP = { add: 'จดบทเรียนใหม่', reinforce: 'ยืนยันบทเรียน', weaken: 'ลดน้ำหนัก', retire: 'เลิกใช้' };
const VERDICT = { better: ['ดีกว่าบอท', 'good'], worse: ['แย่กว่าบอท', 'bad'], same: ['เท่ากับบอท', 'off'] };
const LIST_MAX = 6;

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
const r2 = (x) => Math.round(x * 100) / 100;
/** `วันนี้ 18:30` / `7 พ.ย. 18:30` (DESIGN.md dates and times) */
function when(ms) {
  if (!Number.isFinite(ms)) return '—';
  return thaiDayKey(ms) === thaiDayKey(Date.now()) ? `วันนี้ ${fmtThai(ms, 'time')}` : fmtThai(ms, 'short');
}
const fig = (label, value, foot, cls = '') => h('div', { class: `fig ${cls}`.trim() },
  h('p', { class: 'fig-label' }, label), h('p', { class: 'fig-value' }, value), h('div', { class: 'fig-foot' }, foot));
const sideMark = (side) => h('span', { class: `trade-ico ${side === 'BUY' ? 'buy' : 'sell'}`, 'aria-hidden': 'true' }, side === 'BUY' ? '▲' : '▼');

/** The plan behind one decision, in Thai, with the prices the AI gave and the money they mean (details, SPEC 10.6). */
export function planLines(r) {
  const d = (r && r.details) || {};
  const L = (...kids) => h('p', { class: 'ai-plan-line' }, ...kids);
  const out = [];
  if (r.action === 'hold') {
    if (fin(d.hold_target)) out.push(L(`ถือไปหาเป้า ${fmtNum(d.hold_target)} ถ้าถึงได้ `, pnl(d.target_pnl)));
    if (fin(d.hold_exit)) out.push(L(`SL ของ AI ${fmtNum(d.hold_exit)} ถ้าโดน `, pnl(d.exit_pnl), stopMoveText(d)));
  } else if (r.action === 'close') {
    if (fin(d.close_pnl)) out.push(L(`ปิดทั้งไม้ที่ ${fmtNum(d.close_price)} ผล `, pnl(d.close_pnl)));
  } else if (r.action === 'tighten') {
    if (fin(d.new_sl)) out.push(L(`ย้าย SL ไป ${fmtNum(d.new_sl)} ถ้าโดน `, pnl(d.locked_pnl), stopMoveText(d)));
    else if (fin(r.new_sl)) out.push(L(`SL ใหม่ ${fmtNum(r.new_sl)}`));
  } else if (r.action === 'reverse' && d.reverse) {
    const v = d.reverse;
    out.push(L(`ปิดไม้เดิมที่ ${fmtNum(d.close_price)} ผล `, pnl(d.close_pnl)));
    out.push(L(`เปิด${sideTh(v.side)} ${fmtNum(v.lots)} ล็อต ที่ ${fmtNum(v.entry)} SL ${fmtNum(v.sl)} (`, pnl(v.risk), `) TP ${fmtNum(v.tp)} (`, pnl(v.reward), ')'));
    out.push(L('รวมทั้งสองไม้ ถึง TP ', pnl(d.total_if_tp), ' โดน SL ', pnl(d.total_if_sl)));
  }
  return out;
}

/** " (ถอย SL จาก A)" / " (เลื่อน SL จาก A)": the AI's stop moved since its last answer (2026-11-13) */
function stopMoveText(d) {
  if (!d || !d.sl_move || !fin(d.sl_from)) return null;
  return h('span', { class: `ai-move ${d.sl_move}` }, d.sl_move === 'further' ? ` ถอย SL จาก ${fmtNum(d.sl_from)}` : ` เลื่อน SL จาก ${fmtNum(d.sl_from)}`);
}
const TRIGGER_TH = { first: 'ถามครั้งแรก', time: 'ถามตามรอบ 5 นาที', m15_close: 'แท่ง M15 เพิ่งปิด', price_move: 'ราคาวิ่งเร็ว', near_stop: 'ราคาใกล้ SL',
  near_target: 'ราคาใกล้เป้า', news: 'ข่าวแรงใกล้ออก' };

function actionChip(r) {
  let [label, tone] = ACTION[r.action] || [r.action, 'pending'];
  const mv = r.details && r.details.sl_move;
  if (r.action === 'tighten' && mv === 'further') [label, tone] = ['ถอย SL', 'bad'];
  else if (r.action === 'hold' && mv === 'further') [label, tone] = ['ถือต่อ ถอย SL', 'warn'];
  else if (r.action === 'hold' && mv === 'closer') label = 'ถือต่อ เลื่อน SL';
  return h('span', { class: `chip ${tone}`, title: r.valid === false ? 'ทำตามไม่ได้ เช่น SL ใหม่ไม่อยู่ระหว่าง SL เดิมกับราคา' : null },
    label, r.valid === false && r.action !== 'error' ? ' (ใช้ไม่ได้)' : '');
}

/** SPEC 10.7: the AI's own review of a closed trade (a hairline section, not a box). */
function reviewSection(rv, lessonsById) {
  const checks = (rv.outcome && rv.outcome.checks) || [];
  return h('section', { class: 'ai-review', 'aria-label': 'AI ทบทวนไม้นี้' },
    h('h3', null, icon('book'), 'AI ทบทวนหลังปิดไม้'),
    rv.outcome && rv.outcome.close && fin(rv.outcome.close.pnl) ? h('p', { class: 'muted small' },
      `ไม้ปิดเพราะ ${CLOSE_TH[rv.outcome.close.reason] || rv.outcome.close.reason || '—'}${fin(rv.outcome.close.price) ? ` ที่ ${fmtNum(rv.outcome.close.price)}` : ''} ผล `, pnl(rv.outcome.close.pnl)) : null,
    rv.summary ? h('p', null, rv.summary) : null,
    rv.mistakes ? h('p', null, h('strong', null, 'ผิดตรงไหน '), rv.mistakes) : null,
    rv.outcome && rv.outcome.better_plan ? h('p', null, h('strong', null, 'ควรทำอะไร '), rv.outcome.better_plan) : null,
    checks.length ? h('div', { class: 'ai-checks' }, checks.map((c) => {
      const [label, tone] = VERDICT[c.verdict] || [c.verdict, 'off'];
      return h('span', { class: `chip ${tone}`, title: c.note || null }, `${(ACTION[c.action] || [c.action])[0]} ${label} `, h('span', { class: 'num' }, `${c.delta >= 0 ? '+' : '−'}${fmtNum(Math.abs(c.delta))}`));
    })) : null,
    (rv.ops || []).length ? h('ul', { class: 'ai-ops' }, rv.ops.map((o) => {
      const l = lessonsById.get(Number(o.id));
      return h('li', null, h('span', { class: 'chip quiet-chip' }, `${OP[o.op] || o.op} #${o.id}`), h('span', null, o.text || (l && l.text) || ''));
    })) : null);
}

/** One expandable row in a list: the summary is a `.trade` row, the body opens under it. */
function rowDetails(summaryKids, body, open = false) {
  const d = h('details', { class: 'ai-row' }, h('summary', { class: 'trade' }, ...summaryKids, h('span', { class: 'ai-chev', 'aria-hidden': 'true' }, icon('chevron'))), h('div', { class: 'ai-body' }, ...body));
  if (open) d.open = true;
  return d;
}

/** "แสดงทั้งหมด" under a list longer than LIST_MAX rows */
function capped(list, items) {
  if (items.length <= LIST_MAX) { list.append(...items); return list; }
  list.append(...items.slice(0, LIST_MAX));
  const more = h('button', { class: 'btn ghost small ai-more', type: 'button', onclick: () => { list.append(...items.slice(LIST_MAX)); more.remove(); } }, `แสดงทั้งหมด ${items.length} รายการ`);
  return h('div', null, list, more);
}

// ------------------------------------------------------------------ the AI's own paper trade (SPEC 10.8)
function aiOpenPanel(open, market) {
  const head = h('div', { class: 'dsec-head' }, h('h2', null, 'ไม้ของ AI ตอนนี้'), h('p', null, 'บนกระดาษ ไม่มีคำสั่งจริง'));
  if (!open) {
    return h('section', { class: 'panel dsec', 'aria-label': 'ไม้ของ AI ตอนนี้' }, head,
      h('div', { class: 'pos-empty' }, h('span', { class: 'pos-empty-ico' }, icon('clock')), h('p', { class: 'state-title' }, 'AI ไม่มีไม้เปิดอยู่'),
        h('p', null, 'AI ดูตลาดเป็นระยะ ถ้าเห็นจังหวะจะเปิดไม้ของตัวเองและขึ้นที่นี่')));
  }
  const dir = open.side === 'BUY' ? 1 : -1, lots = Number(open.lots), mult = lots * 100;
  const entry = Number(open.entry), sl = Number(open.sl), tp = Number(open.tp), firstSl = Number(open.first_sl || open.sl);
  const px = Number(open.side === 'BUY' ? market.bid : market.ask);
  const gain = Number.isFinite(px) && px > 0 ? (px - entry) * dir : null;
  const slDist = (entry - sl) * dir, tpDist = (tp - entry) * dir;
  const lo = -Math.max((entry - firstSl) * dir, 0.0001), hi = Math.max(tpDist, 0.0001);
  const t = (x) => Math.max(0, Math.min(1, (x - lo) / (hi - lo)));
  const locked = slDist < 0;
  const opened = Date.parse(open.opened_at);
  const fact = (label, value, sub) => h('div', { class: 'pos-fact' }, h('dt', null, label), h('dd', null, value), sub ? h('p', { class: 'fact-sub' }, sub) : null);
  return h('section', { class: 'panel dsec', 'aria-label': 'ไม้ของ AI ตอนนี้' }, head,
    h('article', { class: 'position' },
      h('div', { class: 'pos-summary' }, h('span', { class: `side ${open.side === 'BUY' ? 'buy' : 'sell'}` }, `${open.side === 'BUY' ? '▲' : '▼'} ${sideTh(open.side)}`),
        h('span', { class: 'chip live' }, icon('eye'), 'ไม้ของ AI'), h('span', { class: 'muted' }, h('span', { class: 'num' }, fmtNum(lots)), ' ล็อต'),
        h('span', { class: 'pos-pnl' }, gain === null ? '—' : money(r2(gain * mult), { signed: true }))),
      gain !== null ? h('div', { class: 'ptrack', role: 'img', 'aria-label': `SL ${fmtNum(sl)} ราคาเข้า ${fmtNum(entry)} ราคาตอนนี้ ${fmtNum(px)} TP ${fmtNum(tp)}` },
        h('div', { class: 'pt-bar' },
          h('span', { class: 'pt-loss', style: { width: `${t(0) * 100}%` } }),
          h('span', { class: 'pt-win', style: { left: `${t(0) * 100}%`, width: `${(1 - t(0)) * 100}%` } }),
          h('span', { class: 'pt-entry', style: { left: `${t(0) * 100}%` } }),
          locked ? h('span', { class: 'pt-lock', style: { left: `${t(-slDist) * 100}%` }, title: 'SL ที่ AI เลื่อนแล้ว' }) : null,
          h('span', { class: `pt-now ${gain >= 0 ? 'up' : 'down'}`, style: { left: `${t(gain) * 100}%` } })),
        h('div', { class: 'pt-labels' },
          h('span', null, h('b', null, locked ? 'SL เดิม' : 'SL'), h('span', { class: 'num' }, fmtNum(firstSl))),
          h('span', { class: 'pt-mid', style: { left: `${t(0) * 100}%` } }, h('b', null, 'ราคาเข้า'), h('span', { class: 'num' }, fmtNum(entry))),
          h('span', { class: 'pt-r' }, h('b', null, 'TP'), h('span', { class: 'num' }, fmtNum(tp))))) : null,
      h('dl', { class: 'pos-facts' },
        fact('ราคาตอนนี้', h('span', { class: 'num' }, fmtNum(px)), ['เข้าที่ ', h('span', { class: 'num' }, fmtNum(entry))]),
        fact('เปิดมาแล้ว', Number.isFinite(opened) ? duration(Date.now() - opened) : '—', `ตั้งแต่ ${when(opened)}`),
        fact('ถ้าถึง TP', money(r2(tpDist * mult), { signed: true }), ['TP อยู่ที่ ', h('span', { class: 'num' }, fmtNum(tp))]),
        fact(locked ? 'SL ล็อกกำไรไว้' : 'ถ้าโดน SL', money(r2(-slDist * mult), { signed: true }), ['SL อยู่ที่ ', h('span', { class: 'num' }, fmtNum(sl))])),
      open.plan && open.plan.reason ? h('p', { class: 'ai-why' }, h('strong', null, 'ทำไม AI เปิด '), open.plan.reason) : null));
}

function scanPanel(scans, sh) {
  const last = scans[0];
  const head = h('div', { class: 'dsec-head' }, h('h2', null, 'AI ดูตลาดล่าสุด'), last ? h('p', null, when(Date.parse(last.ts))) : null);
  const next = sh && sh.next_scan_utc ? Date.parse(sh.next_scan_utc) : NaN;
  if (!last) {
    return h('section', { class: 'panel dsec', 'aria-label': 'AI ดูตลาดล่าสุด' }, head,
      h('div', { class: 'pos-empty' }, h('span', { class: 'pos-empty-ico' }, icon('eye')), h('p', { class: 'state-title' }, 'AI ยังไม่ได้ดูตลาด'),
        h('p', null, 'เปิดสวิตช์ "ให้ AI เทรดเองบนกระดาษ" ที่ ผู้ใช้ > ผู้ช่วย AI แล้ว AI จะเริ่มดูตลาดเอง')));
  }
  const verdict = last.action === 'open' ? `เปิด${sideTh(last.side)}` : last.action === 'wait' ? 'รอจังหวะ' : 'ถามไม่สำเร็จ';
  const conf = fin(last.confidence) ? Number(last.confidence) : null;
  const older = scans.slice(1, 6);
  return h('section', { class: 'panel dsec', 'aria-label': 'AI ดูตลาดล่าสุด' }, head,
    h('div', { class: 'ai-scan' },
      h('div', { class: 'ai-verdict' }, h('span', { class: `ai-verdict-dot ${last.action}` }), h('span', { class: 'ai-verdict-text' }, verdict),
        last.action === 'open' && fin(last.entry) ? h('span', { class: 'muted' }, 'ที่ ', h('span', { class: 'num' }, fmtNum(last.entry))) : null),
      conf !== null ? h('div', { class: 'ai-conf-row' },
        h('div', { class: 'meter', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(conf), 'aria-label': 'ความมั่นใจของ AI' },
          h('span', { class: 'meter-fill ai-conf', style: { width: `${conf}%` } })),
        h('span', { class: 'muted small' }, 'มั่นใจ ', h('span', { class: 'num' }, `${conf}%`))) : null,
      last.action === 'open' && fin(last.entry) && fin(last.sl) && fin(last.tp) ? (() => {
        const d = last.details || {}, slD = Math.abs(last.entry - last.sl), tpD = Math.abs(last.tp - last.entry);
        const fact = (label, price, dist, money_) => h('div', { class: 'pos-fact' }, h('dt', null, label), h('dd', null, h('span', { class: 'num' }, fmtNum(price))),
          h('p', { class: 'fact-sub' }, 'ห่าง ', h('span', { class: 'num' }, fmtNum(dist)), money_ !== null ? [' ', pnl(money_)] : null));
        return h('dl', { class: 'pos-facts' }, fact('SL', last.sl, slD, fin(d.risk) ? d.risk : null), fact('TP', last.tp, tpD, fin(d.reward) ? d.reward : null));
      })() : null,
      h('p', { class: 'ai-why' }, last.action === 'error' ? h('span', { class: 'muted' }, 'AI ตอบไม่สำเร็จ แอปจะถามใหม่รอบถัดไป') : (last.reason || '—')),
      Number.isFinite(next) && next > Date.now() ? h('p', { class: 'muted small' }, `ดูตลาดครั้งต่อไปประมาณ ${when(next)}`) : null,
      older.length ? h('details', { class: 'ai-older' }, h('summary', null, `ครั้งก่อน ๆ ${older.length} ครั้ง`),
        h('ul', { class: 'ai-older-list' }, older.map((s) => h('li', null,
          h('span', { class: 'muted small' }, when(Date.parse(s.ts))),
          h('span', { class: `chip ${s.action === 'open' ? 'live' : 'off'}` }, s.action === 'open' ? `เปิด${sideTh(s.side)}` : s.action === 'wait' ? 'รอ' : 'ไม่สำเร็จ'),
          h('span', { class: 'ai-older-reason' }, s.action === 'error' ? 'ตอบไม่สำเร็จ' : s.reason || '—'))))) : null));
}

function aiTradesPanel(closed, reviewByTicket, lessonsById) {
  const head = h('div', { class: 'dsec-head' }, h('h2', null, 'ไม้ของ AI ที่ปิดแล้ว'), closed.length ? h('p', null, `${closed.length} ไม้`) : null);
  if (!closed.length) {
    return h('section', { class: 'panel dsec', 'aria-label': 'ไม้ของ AI ที่ปิดแล้ว' }, head,
      h('div', { class: 'pos-empty' }, h('span', { class: 'pos-empty-ico' }, icon('history')), h('p', { class: 'state-title' }, 'ยังไม่มีไม้ที่ปิด')));
  }
  const rows = closed.map((t) => {
    const rv = reviewByTicket.get(Number(t.ticket));
    return h('li', null, rowDetails([
      sideMark(t.side),
      h('div', { class: 'trade-main' },
        h('p', null, h('span', { class: `side ${t.side === 'BUY' ? 'buy' : 'sell'}` }, sideTh(t.side)), ' ', h('span', { class: 'muted' }, h('span', { class: 'num' }, fmtNum(t.entry)), ' → ', h('span', { class: 'num' }, fmtNum(t.exit)))),
        h('p', { class: 'muted small' }, `${when(Date.parse(t.closed_at || t.opened_at))} ${CLOSE_TH[t.close_reason] || t.close_reason || ''}`)),
      h('span', { class: 'trade-pnl' }, money(t.pnl, { signed: true })),
    ], [
      h('p', { class: 'muted small' }, `เปิด ${when(Date.parse(t.opened_at))} ปิด ${when(Date.parse(t.closed_at))}`),
      h('dl', { class: 'pos-facts' },
        h('div', { class: 'pos-fact' }, h('dt', null, 'SL ตอนเปิด'), h('dd', null, h('span', { class: 'num' }, fmtNum(t.first_sl))),
          h('p', { class: 'fact-sub' }, 'ถ้าโดน ', pnl(-Math.abs(t.entry - t.first_sl) * t.lots * 100))),
        h('div', { class: 'pos-fact' }, h('dt', null, 'TP'), h('dd', null, h('span', { class: 'num' }, fmtNum(t.tp))),
          h('p', { class: 'fact-sub' }, 'ถ้าถึง ', pnl(Math.abs(t.tp - t.entry) * t.lots * 100)))),
      t.plan && t.plan.reason ? h('p', { class: 'ai-why' }, h('strong', null, 'ทำไม AI เปิด '), t.plan.reason) : null,
      rv ? reviewSection(rv, lessonsById) : h('p', { class: 'muted small' }, 'ยังไม่มีการทบทวนไม้นี้'),
    ]));
  });
  return h('section', { class: 'panel dsec', 'aria-label': 'ไม้ของ AI ที่ปิดแล้ว' }, head, capped(h('ul', { class: 'trade-list ai-list' }), rows));
}

// ------------------------------------------------------------------ memory (SPEC 10.7)
function memoryPanel(lessons, reviews, onRetire, canEdit) {
  const active = lessons.filter((l) => l.status === 'active'), retired = lessons.filter((l) => l.status !== 'active');
  const row = (l) => h('li', { class: `ai-lesson ${l.status}` },
    h('span', { class: `ai-weight ${l.weight >= 3 ? 'strong' : ''}`, title: 'น้ำหนัก = ไม้ที่ยืนยันบทเรียนนี้ ลบไม้ที่ค้าน' }, String(l.weight)),
    h('div', { class: 'ai-lesson-main' }, h('p', null, l.text),
      h('p', { class: 'muted small' }, `บทเรียน #${l.id} จาก ${(l.tickets || []).length} ไม้ แก้ล่าสุด ${when(Date.parse(l.updated_at))}`)),
    canEdit && l.status === 'active' ? h('button', { class: 'btn ghost small', type: 'button', onclick: () => onRetire(l) }, 'เลิกใช้') : null);
  return h('section', { class: 'panel dsec', 'aria-label': 'ความจำของ AI' },
    h('div', { class: 'dsec-head' }, h('h2', null, 'ความจำของ AI'), h('p', null, `${active.length} บทเรียน จาก ${reviews.length} ไม้`)),
    active.length ? capped(h('ul', { class: 'ai-lessons' }), active.map(row))
      : h('div', { class: 'pos-empty' }, h('span', { class: 'pos-empty-ico' }, icon('book')), h('p', { class: 'state-title' }, 'ยังไม่มีบทเรียน'),
        h('p', null, 'หลังไม้แรกที่ AI ดูปิดลง AI จะทบทวนตัวเองแล้วจดบทเรียนไว้ใช้กับไม้ต่อไป')),
    retired.length ? h('details', { class: 'ai-older' }, h('summary', null, `เลิกใช้แล้ว ${retired.length} บทเรียน`), h('ul', { class: 'ai-lessons' }, retired.map(row))) : null,
    h('p', { class: 'muted small ai-note' }, 'น้ำหนักสูงแปลว่าหลายไม้ยืนยัน บทเรียนที่ถูกค้านจนน้ำหนักเหลือ 0 จะเลิกใช้เอง'));
}

// ------------------------------------------------------------------ the bot's trades the AI watched (SPEC 10.6)
function decisionItem(r) {
  const dot = r.action === 'error' ? 'ev-error' : r.action === 'hold' ? 'ev-hold' : r.action === 'tighten' ? 'ev-lock' : 'ev-close';
  const px = r.side === 'BUY' ? r.bid : r.ask;
  return h('li', { class: `tl-item ${dot}` },
    h('span', { class: 'tl-time' }, fmtThai(Date.parse(r.ts), 'time')),
    h('span', { class: 'tl-dot', 'aria-hidden': 'true' }),
    h('div', { class: 'tl-body' },
      h('p', { class: 'tl-ev' }, actionChip(r),
        fin(r.confidence) ? h('span', { class: 'muted small' }, 'มั่นใจ ', h('span', { class: 'num' }, `${r.confidence}%`)) : null,
        h('span', { class: 'muted small' }, 'ราคา ', h('span', { class: 'num' }, fmtNum(px)), ' กำไรตอนนั้น '), pnl(r.profit),
        r.details && TRIGGER_TH[r.details.trigger] ? h('span', { class: 'ai-trigger' }, TRIGGER_TH[r.details.trigger]) : null),
      ...planLines(r),
      r.action === 'error' ? h('p', { class: 'muted small' }, 'AI ตอบไม่สำเร็จในรอบนี้') : r.reason ? h('p', { class: 'tl-text' }, r.reason) : null));
}

function watchedPanel(trades, closes, reviewByTicket, lessonsById) {
  const head = h('div', { class: 'dsec-head' }, h('h2', null, 'ไม้ของบอทที่ AI ดู'), trades.length ? h('p', null, 'บันทึกอย่างเดียว บอทไม่ได้ทำตาม') : null);
  if (!trades.length) {
    return h('section', { class: 'panel dsec', 'aria-label': 'ไม้ของบอทที่ AI ดู' }, head,
      h('div', { class: 'pos-empty' }, h('span', { class: 'pos-empty-ico' }, icon('eye')), h('p', { class: 'state-title' }, 'ยังไม่มีไม้ที่ AI ดู'),
        h('p', null, 'เมื่อบอทเปิดไม้ AI จะดูทุก 5 นาที และคำตอบจะขึ้นที่นี่')));
  }
  const rows = trades.map((t, i) => {
    const close = closes.get(t.ticket), rv = reviewByTicket.get(t.ticket), mv = firstMove(t);
    const asked = t.list.filter((r) => r.action !== 'error').length, failed = t.list.length - asked;
    const advice = mv ? `แนะนำ ${(ACTION[mv.action] || [mv.action])[0]} ตอน ${fmtThai(Date.parse(mv.ts), 'time')}` : asked ? 'ให้ถือตามบอททุกครั้ง' : 'ยังไม่มีคำตอบที่ใช้ได้';
    return h('li', null, rowDetails([
      sideMark(t.side),
      h('div', { class: 'trade-main' },
        h('p', null, modChip(t.module), ' ', h('span', { class: `side ${t.side === 'BUY' ? 'buy' : 'sell'}` }, sideTh(t.side)), ' ', h('span', { class: 'muted' }, h('span', { class: 'num' }, fmtNum(t.lots)), ' ล็อต')),
        h('p', { class: 'muted small' }, `${when(Date.parse(t.list[0].ts))} AI ตอบ ${asked} ครั้ง${failed ? ` ไม่สำเร็จ ${failed}` : ''} ${advice}`)),
      h('span', { class: 'trade-pnl' }, close ? money(close.pnl, { signed: true }) : h('span', { class: 'chip live' }, 'เปิดอยู่')),
    ], [
      close ? h('p', { class: 'muted small' }, `บอทปิดไม้นี้ ${CLOSE_TH[close.reason] || close.reason || ''} ที่ `, h('span', { class: 'num' }, fmtNum(close.price))) : null,
      h('ol', { class: 'timeline ai-timeline' }, t.list.map(decisionItem)),
      rv ? reviewSection(rv, lessonsById) : null,
    ], i === 0 && !close));
  });
  return h('section', { class: 'panel dsec', 'aria-label': 'ไม้ของบอทที่ AI ดู' }, head, capped(h('ul', { class: 'trade-list ai-list' }), rows));
}

export async function render(root, ctx) {
  const bot = myBot();
  const head = pageHead('AI เงา', 'AI ดูไม้ของบอท เทรดเองบนกระดาษ และเรียนรู้จากทุกไม้ ไม่มีคำสั่งจริงไปถึงโบรกเกอร์', null, null);
  root.append(head);
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
  const stJson = (st && (st.status || st)) || {};
  const market = stJson.market || {};
  const status = [];
  if (sh && sh.paused) status.push(callout('warn', 'AI เงาหยุดพักอยู่', h('p', null, PAUSE[sh.paused] || sh.paused)));
  if (!sh && !rows.length && !aiScans.length) {
    status.push(callout('warn', 'แอปที่เครื่องยังไม่ได้ส่งงานให้ AI เงา',
      h('p', null, 'ต้องใช้แอป Dobby รุ่น 1.3.0 ขึ้นไป และเปิด AI เงาที่ ผู้ใช้ > ผู้ช่วย AI')));
  }

  // figures
  const open = aiTrades.find((t) => t.status === 'open');
  const closed = aiTrades.filter((t) => t.status === 'closed');
  const total = closed.reduce((s, t) => s + Number(t.pnl || 0), 0);
  const wins = closed.filter((t) => Number(t.pnl) > 0).length;
  let better = 0, worse = 0;
  for (const rv of reviews) for (const c of (rv.outcome && rv.outcome.checks) || []) { if (c.verdict === 'better') better += 1; else if (c.verdict === 'worse') worse += 1; }
  const livePnl = open ? (() => {
    const px = Number(open.side === 'BUY' ? market.bid : market.ask);
    return Number.isFinite(px) && px > 0 ? r2((open.side === 'BUY' ? px - open.entry : open.entry - px) * open.lots * 100) : null;
  })() : null;
  const active = lessons.filter((l) => l.status === 'active').length;
  const figs = h('section', { class: 'figs', 'aria-label': 'สรุป AI เงา' },
    fig('กำไรของ AI (กระดาษ)', money(total, { signed: true }),
      h('p', null, closed.length ? `${closed.length} ไม้ ชนะ ${Math.round((wins / closed.length) * 100)}%` : 'ยังไม่มีไม้ที่ปิด')),
    fig('ไม้ของ AI ตอนนี้', open ? (livePnl === null ? '—' : money(livePnl, { signed: true })) : h('span', { class: 'fig-text' }, 'ไม่มี'),
      h('p', null, open ? `${sideTh(open.side)} ${fmtNum(open.lots)} ล็อต ที่ ${fmtNum(open.entry)}` : 'รอจังหวะ')),
    fig('AI แนะนำดีกว่าบอท', better + worse ? [h('span', { class: 'num' }, String(better)), h('span', { class: 'unit' }, ` จาก ${better + worse} ครั้ง`)] : h('span', { class: 'fig-text' }, 'ยังไม่มี'),
      h('p', null, `ตรวจกับผลจริง ${reviews.length} ไม้`)),
    fig('ความจำของ AI', h('span', { class: 'fig-text' }, `${active} บทเรียน`),
      h('p', null, cost !== null ? ['ค่า AI เดือนนี้ ', h('span', { class: 'num' }, fmtNum(cost, 2)), ' USD'] : `ทบทวนแล้ว ${reviews.length} ไม้`)));

  const lessonsById = new Map(lessons.map((l) => [Number(l.id), l]));
  const reviewByTicket = new Map(reviews.map((r) => [Number(r.ticket), r]));
  const retire = async (l) => {
    if (!(await confirmDialog(`เลิกใช้บทเรียน #${l.id}`, `${l.text} — AI จะไม่อ่านบทเรียนนี้อีก`, { ok: 'เลิกใช้', danger: true }))) return;
    try { await ctx.api.retireLesson(bot.id, l.id); toast('เลิกใช้บทเรียนแล้ว AI จะไม่อ่านบทเรียนนี้อีก', 'good'); ctx.route(); } catch (e) { toast(errText(e), 'bad'); }
  };

  const explain = h('details', { class: 'panel' }, h('summary', null, 'AI เงาทำงานยังไง'),
    h('div', { class: 'stack' },
      h('p', null, 'ทุก 5 นาทีที่บอทมีไม้เปิด AI ดูกราฟ ข่าว และความจำของตัวเอง แล้วบอกว่าจะถือต่อ ปิด เลื่อน SL หรือเปิดสวน พร้อมราคาและเงิน บอทยังเทรดตามสูตรเดิมทุกอย่าง'),
      h('p', null, 'AI ยังเปิดไม้ของตัวเองบนกระดาษได้ ตั้ง SL และ TP เอง และดูแลไม้เองทุก 5 นาที ผลคิดจากราคาจริง แต่ไม่มีคำสั่งไปถึงโบรกเกอร์'),
      h('p', null, 'หลังไม้ปิด AI ทบทวนตัวเองว่าผิดตรงไหน แล้วจดบทเรียนไว้ใช้ไม้ต่อไป เมื่อมีไม้ครบราว 60 ถึง 100 ไม้ จะเทียบกับราคาจริงว่าทำตาม AI แล้วได้หรือเสียกว่าบอทเท่าไหร่')));

  mount(box, ...status, figs,
    h('div', { class: 'dash-cols' }, aiOpenPanel(open, market), scanPanel(aiScans, sh)),
    h('div', { class: 'dash-cols' }, aiTradesPanel(closed, reviewByTicket, lessonsById), memoryPanel(lessons, reviews, retire, ownsBot(bot))),
    watchedPanel(groupTrades(rows), closesByTicket(journal), reviewByTicket, lessonsById),
    explain);
}
