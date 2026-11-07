// One trade (#/trade/<trade_key>, SPEC 9.1 + 9.6): the price around it with entry, SL / TP and every lock step, why the
// bot opened it in plain Thai, the timeline of its journal rows, and the owner's note and tags (read only for the admin
// viewing a member's bot).
import { h, mount, icon, fmtNum, fmtThai, timeEl, money, duration, errorState, loadingState, emptyState, toast, errText, busy,
  callout, parseWall, wallString, isoUtc, thaiDayKey } from '../util.js';
import { currentBot, ownsBot } from '../state.js';
import { prepareRows, pairTrades, parseTradeKey, EVENT_LABELS, REASON_LABELS, SUGGESTED_TAGS } from '../journal.js';
import { modChip, sideEl, panel, pageHead, noBotState } from '../views.js';
import { whyOpened, explainEvent, parseOpenDetail } from '../explain.js';
import { tradeChart, barsFromRows } from '../tradechart.js';
import { readBars } from '../pricechart.js';
import { openChat } from '../chat.js';

const HOUR = 3600000, MIN = 60000;
const TIMELINE = new Set(['SIGNAL', 'ARM', 'ORDER', 'OPEN', 'NEAR1', 'NEARTP', 'LOCK1', 'LOCK', 'SHADOWLOCK1', 'SHADOWLOCK', 'CLOSE', 'CANCEL', 'ERROR', 'SKIP']);
const srv = (wall) => wallString(wall, '-', true).replace(' ', 'T');

export async function render(root, ctx) {
  const bot = currentBot();
  if (!bot) { root.append(pageHead('รายละเอียดไม้', null, null, 'history'), noBotState()); return; }
  const key = ctx.parts[0] || '';
  const pk = parseTradeKey(key);
  const back = h('a', { class: 'back', href: '#/history?tab=trades' }, icon('arrow'), 'รายการเทรด');
  const notFound = (text) => mount(root, back, pageHead('ไม่พบไม้นี้', null, null, 'history'),
    emptyState('ไม่พบไม้นี้ในบันทึกของบอท', text || 'ลิงก์อาจมาจากบอทอื่น หรือบันทึกถูกลบไปแล้ว เลือกไม้จากรายการเทรดอีกครั้ง',
      h('a', { class: 'btn', href: '#/history?tab=trades' }, icon('history'), 'ไปที่รายการเทรด')));
  if (!pk) { notFound(); return; }
  const off = bot.server_utc_offset_min ?? 0;
  const ro = !ownsBot(bot);
  root.append(loadingState('กำลังโหลดไม้นี้…'));

  // the journal around the open (ARM of NY comes hours before; a trade can stay open overnight)
  const openWall = parseWall(pk.ts);
  let rows, st = null;
  try {
    const [raw, s] = await Promise.all([
      ctx.api.journal(bot.id, { fromServer: srv(openWall - 14 * HOUR), toServer: srv(openWall + 3 * 24 * HOUR) }),
      ctx.api.botStatus(bot.id).catch(() => null)]);
    rows = prepareRows(raw, off);
    st = s ? s.status : null;
  } catch (e) { mount(root, back, errorState(e, () => ctx.route())); return; }
  const trade = pairTrades(rows.filter((r) => r.tag === pk.tag)).find((t) => t.key === key);
  if (!trade) { notFound(); return; }
  const cur = (st && st.account && st.account.currency) || 'USD';

  // the rows of this trade: same strategy, after its previous close (at most 12 h before the open), up to the close;
  // a DAYCAP written right after the close belongs to it too
  const prevClose = rows.filter((r) => r.tag === pk.tag && r.event === 'CLOSE' && r.utc < trade.openUtc).pop();
  const startUtc = Math.max(prevClose ? prevClose.utc + 1 : -Infinity, trade.openUtc - 12 * HOUR);
  const endUtc = trade.open ? Infinity : trade.closeUtc;
  const tl = rows.filter((r) => (r.tag === pk.tag && TIMELINE.has(r.event) && r.utc >= startUtc && r.utc <= endUtc)
    || (r.event === 'DAYCAP' && Number.isFinite(endUtc) && r.utc >= endUtc && r.utc <= endUtc + 3 * MIN));
  const before = tl.filter((r) => r.utc <= trade.openUtc);
  const why = whyOpened(trade, {
    signal: before.filter((r) => r.event === 'SIGNAL').pop(), arm: before.filter((r) => r.event === 'ARM').pop(), order: before.filter((r) => r.event === 'ORDER').pop(),
  });

  // ---------------- layout
  const buy = trade.side === 'BUY';
  const title = `ไม้${buy ? 'ซื้อ' : 'ขาย'} ${trade.module}`;
  const chips = [
    h('strong', { class: 'bot-name' }, bot.name),
    ro ? h('span', { class: 'chip live' }, icon('eye'), `ของ ${bot.owner_name || 'สมาชิก'}`) : null,
    h('span', { class: 'chip' }, `${fmtNum(trade.lots)} ล็อต`),
    trade.step ? h('span', { class: 'chip' }, `ไม้แก้ขั้น ${trade.step}`) : null,
    trade.open ? h('span', { class: 'chip pending' }, 'ยังเปิดอยู่') : null,
  ];
  const chart = tradeChart();
  const whyBox = panel('ทำไมบอทเปิดไม้นี้', { cls: 'why' });
  const noteBox = panel('บันทึกของไม้นี้', { cls: 'tnote', sub: ro ? 'ของเจ้าของบอท ดูอย่างเดียว' : 'จดไว้ดูย้อนหลัง แท็กใช้กรองในรายการเทรด' });
  mount(root, back,
    pageHead(title, h('span', { class: 'row gap wrap' }, chips),
      h('button', { class: 'btn small', type: 'button', onclick: () => openChat('ทำไมไม้นี้ถึงเปิด และเกิดอะไรขึ้นกับไม้นี้บ้าง', { trade_key: trade.key || undefined }) }, icon('chat'), 'ถาม AI เรื่องไม้นี้'),
      'history'),
    figs(),
    panel('ราคาช่วงที่ถือไม้', { sub: 'ช่วงที่ถือไม้แรเงาไว้ เส้นประจางคือ VWAP' }, chart, legend()),
    h('div', { class: 'dash-cols' }, whyBox, noteBox),
    timeline());

  function figs() {
    const o = parseOpenDetail(trade.openDetail);
    const risk = Number.isFinite(o.d) ? -o.d * 100 * (trade.lots || 0) : (trade.sl > 0 && trade.openPrice > 0 ? -Math.abs(trade.openPrice - trade.sl) * 100 * (trade.lots || 0) : NaN);
    const fig = (label, value, foot) => h('div', { class: 'fig' }, h('p', { class: 'fig-label' }, label), h('p', { class: 'fig-value' }, value), h('div', { class: 'fig-foot' }, foot));
    const sameDay = !trade.open && thaiDayKey(trade.openUtc) === thaiDayKey(trade.closeUtc);
    const locked = (trade.lockSteps || []).length;
    return h('section', { class: 'figs', 'aria-label': 'สรุปไม้นี้' },
      fig('ผลของไม้นี้', trade.open ? h('span', { class: 'fig-text' }, 'ยังเปิดอยู่') : money(trade.pnl, { signed: true, unit: cur }),
        h('p', null, trade.open ? 'ผลจะขึ้นเมื่อปิดไม้' : [REASON_LABELS[trade.reason] || trade.reason || 'ปิดไม้', locked ? ` หลังล็อกกำไร ${locked} ชั้น` : ''])),
      fig('ราคาเข้า', h('span', { class: 'num' }, fmtNum(trade.openPrice)),
        h('p', null, trade.open ? 'ยังไม่ออก' : ['ออกที่ ', h('span', { class: 'num' }, fmtNum(trade.closePrice))])),
      fig('ความเสี่ยงตอนเปิด', Number.isFinite(risk) ? money(risk, { signed: true, unit: cur }) : '—',
        h('p', null, 'SL ', h('span', { class: 'num' }, fmtNum(trade.sl)), ' TP ', h('span', { class: 'num' }, fmtNum(trade.tp)))),
      fig('ถือไว้', h('span', { class: 'fig-text' }, Number.isFinite(trade.openUtc) ? duration((trade.open ? Date.now() : trade.closeUtc) - trade.openUtc) : '—'),
        h('p', null, Number.isFinite(trade.openUtc) ? `${fmtThai(trade.openUtc, 'short')}${trade.open ? ' ถึงตอนนี้' : ` ถึง ${fmtThai(trade.closeUtc, sameDay ? 'time' : 'short')}`}` : '—')));
  }

  function legend() {
    const it = (cls, text) => h('li', null, h('span', { class: `lg-key ${cls}`, 'aria-hidden': 'true' }), text);
    return h('ul', { class: 'tc-legend' },
      it(buy ? 'entry-buy' : 'entry-sell', 'จุดเข้า'), trade.open ? null : it((trade.pnl ?? 0) >= 0 ? 'exit-win' : 'exit-loss', 'จุดออก'),
      it('tp', 'TP'), it('sl', 'SL'), (trade.lockSteps || []).length ? it('lock', 'SL ที่เลื่อนมาล็อกกำไร') : null);
  }

  // ---------------- why + timeline
  mount(whyBox,
    h('div', { class: 'panel-head' }, h('div', null, h('h2', null, 'ทำไมบอทเปิดไม้นี้'))),
    why.lines.length ? h('div', { class: 'why-lines' }, why.lines.map((l) => h('p', null, l))) : null,
    !why.understood ? h('div', { class: 'stack' }, h('p', { class: 'muted small' }, 'อ่านรูปแบบข้อความนี้ไม่ออก จึงแสดงข้อความจาก EA ตรง ๆ'),
      h('p', { class: 'raw-line' }, why.raw || 'ไม่มีรายละเอียด')) : null,
    h('p', { class: 'muted small' }, 'อธิบายจากบันทึกของ EA ตอนเปิดไม้ ไม่ใช่คำแนะนำการลงทุน'));

  function timeline() {
    const day0 = thaiDayKey(trade.openUtc);
    const items = tl.map((r) => {
      const ex = explainEvent(r, trade);
      const when = thaiDayKey(r.utc) === day0 ? fmtThai(r.utc, 'time') : fmtThai(r.utc, 'short');
      return h('li', { class: `tl-item ev-${r.event.toLowerCase()}` },
        h('span', { class: 'tl-time num', title: `เวลาเซิร์ฟเวอร์ ${String(r.ts_server).replace('T', ' ')}` }, when),
        h('span', { class: 'tl-dot', 'aria-hidden': 'true' }),
        h('div', { class: 'tl-body' },
          h('p', { class: 'tl-ev' }, EVENT_LABELS[r.event] || r.event, r.event === 'CLOSE' && Number.isFinite(r.pnl) ? [' ', money(r.pnl, { signed: true })] : null),
          h('p', { class: ex.understood ? 'tl-text' : 'tl-text raw-line' }, ex.text)));
    });
    return panel('ลำดับเหตุการณ์', { sub: `${tl.length} รายการจากบันทึกของ EA เวลาไทย (ชี้ที่เวลาเพื่อดูเวลาเซิร์ฟเวอร์)` },
      tl.length ? h('ol', { class: 'timeline' }, items) : h('p', { class: 'muted' }, 'ไม่มีบันทึกของไม้นี้'),
      tl.length ? h('details', { class: 'table-view' }, h('summary', null, 'ข้อความต้นฉบับจาก EA'),
        h('ul', { class: 'raw-list' }, tl.map((r) => h('li', null, h('span', { class: 'num' }, String(r.ts_server).replace('T', ' ')), ` ${r.event} `, r.detail || '')))) : null);
  }

  // ---------------- chart data: `bars` for [open - 3 h, close + 1 h], else the 24 h window in agent_state.bars
  (async () => {
    const from = trade.openUtc - 3 * HOUR, to = (trade.open ? Date.now() : trade.closeUtc) + HOUR;
    let bars = null, empty = 'ยังไม่มีข้อมูลราคาช่วงนี้ (ต้องใช้แอป Dobby 1.2.0 ขึ้นไป และเก็บย้อนหลังได้ราว 45 วัน)';
    try { bars = barsFromRows(await ctx.api.bars(bot.id, isoUtc(from), isoUtc(to))); } catch (e) { if (e.code !== 'not_deployed') empty = errText(e); }
    if (!bars) {
      const b = readBars(bot);
      if (b) {
        const idx = b.t.map((t, i) => i).filter((i) => b.t[i] >= from && b.t[i] <= to);
        if (idx.length >= 2) bars = { tf: b.tf, t: idx.map((i) => b.t[i]), c: idx.map((i) => b.c[i]), vwap: idx.map((i) => b.vwap[i]) };
      }
    }
    if (!chart.isConnected) return;
    chart.update({ bars, trade, now: Date.now(), emptyText: empty });
  })();

  // ---------------- note + tags
  let note = null;
  async function loadNote() {
    mount(noteBox, h('div', { class: 'panel-head' }, h('div', null, h('h2', null, 'บันทึกของไม้นี้'))), loadingState());
    try {
      const list = await ctx.api.listTradeNotes(bot.id);
      note = list.find((x) => x.trade_key === key) || null;
      drawNote();
    } catch (e) {
      mount(noteBox, h('div', { class: 'panel-head' }, h('div', null, h('h2', null, 'บันทึกของไม้นี้'))),
        e.code === 'not_deployed' ? callout('info', 'ยังบันทึกไม่ได้', h('p', null, e.thai)) : errorState(e, loadNote));
    }
  }
  function drawNote() {
    const head = h('div', { class: 'panel-head' }, h('div', null, h('h2', null, 'บันทึกของไม้นี้'),
      h('p', { class: 'muted small' }, ro ? 'ของเจ้าของบอท ดูอย่างเดียว' : 'จดไว้ดูย้อนหลัง แท็กใช้กรองในรายการเทรด')));
    if (ro) {
      const tags = (note && note.tags) || [];
      mount(noteBox, head,
        tags.length ? h('div', { class: 'chips' }, tags.map((t) => h('span', { class: 'chip' }, t))) : null,
        note && note.note ? h('p', { class: 'note-text' }, note.note) : h('p', { class: 'muted' }, tags.length ? 'ไม่มีข้อความ' : 'เจ้าของบอทยังไม่ได้บันทึกอะไรไว้'));
      return;
    }
    const chosen = new Set((note && note.tags) || []);
    const tagBox = h('div', { class: 'tag-picks', role: 'group', 'aria-label': 'แท็ก' });
    const drawTags = () => mount(tagBox, [...new Set([...SUGGESTED_TAGS, ...chosen])].map((t) => h('button', {
      type: 'button', class: `btn small tag-btn${chosen.has(t) ? ' on' : ''}`, 'aria-pressed': chosen.has(t) ? 'true' : 'false',
      onclick: () => { if (chosen.has(t)) chosen.delete(t); else chosen.add(t); drawTags(); dirty(); },
    }, chosen.has(t) ? icon('check') : icon('plus'), t)));
    drawTags();
    const tagIn = h('input', { class: 'input', type: 'text', maxlength: 24, placeholder: 'แท็กอื่น เช่น ทดลองล็อตใหม่', 'aria-label': 'แท็กใหม่' });
    const addTag = () => { const v = tagIn.value.trim().replace(/\s+/g, ' '); if (!v) return; chosen.add(v); tagIn.value = ''; drawTags(); dirty(); };
    tagIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } });
    const text = h('textarea', { class: 'input', maxlength: 2000, rows: 4, placeholder: 'เช่น ข่าวออกตอนถือไม้อยู่ ราคาวิ่งแรง', 'aria-label': 'บันทึก' }, (note && note.note) || '');
    text.addEventListener('input', () => dirty());
    const status = h('p', { class: 'muted small', 'aria-live': 'polite' }, note && note.updated_at ? `บันทึกล่าสุด ${fmtThai(Date.parse(note.updated_at), 'short')} น.` : 'ยังไม่มีบันทึก');
    const save = h('button', { class: 'btn primary', type: 'button', disabled: true }, icon('save'), 'บันทึก');
    function dirty() {
      const same = JSON.stringify([...chosen].sort()) === JSON.stringify([...((note && note.tags) || [])].sort()) && text.value.trim() === ((note && note.note) || '').trim();
      save.disabled = same;
    }
    save.addEventListener('click', async () => {
      busy(save, true, 'กำลังบันทึก…');
      try {
        const tags = [...chosen], body = text.value.trim();
        if (!tags.length && !body) { if (note) await ctx.api.deleteTradeNote(bot.id, key); note = null; }
        else note = await ctx.api.saveTradeNote(bot.id, key, { note: body, tags });
        toast('บันทึกแล้ว', 'good');
        drawNote();
      } catch (e) { busy(save, false); toast(errText(e), 'error', 6000); }
    });
    mount(noteBox, head, tagBox,
      h('div', { class: 'tag-add' }, tagIn, h('button', { class: 'btn', type: 'button', onclick: addTag }, icon('plus'), 'เพิ่มแท็ก')),
      text, h('div', { class: 'note-foot' }, status, save));
  }
  loadNote();

  // an open trade: reload when its journal moves on
  const unsub = trade.open ? ctx.api.subscribeBot(bot.id, { journal: (row) => { if (row && row.tag === pk.tag) ctx.route(); } }) : () => {};
  return () => { unsub(); chart.destroy(); };
}
