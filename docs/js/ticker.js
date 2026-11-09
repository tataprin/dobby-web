// Header ticker: XAUUSD bid of the selected bot (bot_status.status.market.bid) and the change since the first M15 bar
// of the broker's (server) day, from bots.agent_state.bars (SPEC 8); without bars, from the first priced journal row
// of that day. Realtime with a 30 s poll while realtime is not joined, and read again when a phone wakes the page.
import { h, mount, fmtNum, fmtSigned, fmtThai, utcToServer, onWake } from './util.js';
import { app, on, currentBot } from './state.js';
import { readBars } from './pricechart.js';

const DAY = 86400000;

export function ticker() {
  const el = h('div', { class: 'ticker', hidden: true });
  let botId = null, bot = null, bid = NaN, ref = null, unsub = null, poll = null, rt = '', seq = 0, journalRef = null;

  const offMin = () => (bot && bot.server_utc_offset_min) || 0;
  const dayOf = (ms) => Math.floor((ms + offMin() * 60000) / DAY);

  function refFromBars() {
    const B = readBars(bot);
    if (!B) return null;
    const today = dayOf(Date.now());
    let i = B.t.findIndex((t) => dayOf(t) === today);
    if (i >= 0) return { price: B.c[i], label: 'วันนี้' };
    const lastDay = dayOf(B.t[B.t.length - 1]);
    i = B.t.findIndex((t) => dayOf(t) === lastDay);
    // market closed (weekend): the last trading day of the broker
    return i >= 0 ? { price: B.c[i], label: fmtThai(lastDay * DAY + 12 * 3600e3, 'day').replace(/\s\d{4}$/, '') } : null;
  }

  async function loadJournalRef(id, my) {
    try {
      const startUtc = dayOf(Date.now()) * DAY - offMin() * 60000;
      const fromServer = utcToServer(startUtc, offMin()).replace(/\./g, '-').replace(' ', 'T');
      const rows = await app.api.journal(id, { fromServer });
      if (my !== seq) return;
      const priced = rows.filter((r) => Number(r.price) > 0).sort((a, b) => String(a.ts_server).localeCompare(String(b.ts_server)));
      journalRef = priced.length ? { price: Number(priced[0].price), label: 'วันนี้' } : null;
      draw();
    } catch { /* price only */ }
  }

  function draw() {
    if (!el.isConnected && el.dataset.mounted) { stop(); return; }
    if (!botId) { el.hidden = true; return; }
    el.hidden = false;
    ref = refFromBars() || journalRef;
    const ok = Number.isFinite(bid) && bid > 0;
    const ch = ok && ref ? bid - ref.price : NaN;
    const tone = ch > 0 ? 'pos' : ch < 0 ? 'neg' : 'zero';
    el.title = ok ? `ราคาทองตอนนี้ (bid จาก MT5 ของ ${bot.name})${ref ? ` เทียบกับแท่งแรกของวันโบรก ${fmtNum(ref.price)}` : ''}` : 'ยังไม่มีราคาจากบอท';
    mount(el,
      h('span', { class: 'tk-sym' }, 'XAUUSD'),
      h('span', { class: 'tk-px num' }, ok ? fmtNum(bid) : '—'),
      Number.isFinite(ch) ? h('span', { class: `tk-ch ${tone}` }, h('span', { class: 'num' }, fmtSigned(ch)), h('span', { class: 'tk-when' }, ` ${ref.label}`)) : null,
      rt === 'SUBSCRIBED' ? h('span', { class: 'tk-live', 'aria-hidden': 'true', title: 'ข้อมูลสด' }) : null);
  }

  function stop() {
    if (unsub) { try { unsub(); } catch { /* ignore */ } unsub = null; }
    if (poll) { clearInterval(poll); poll = null; }
  }

  async function refetch() {
    try { const s = await app.api.botStatus(botId); const mk = s && s.status && s.status.market; if (mk) { bid = Number(mk.bid); draw(); } } catch { /* keep */ }
  }

  async function bind() {
    const b = currentBot();
    if (b && b.id === botId) { bot = { ...bot, ...b }; draw(); return; }
    stop();
    const my = ++seq;
    botId = b ? b.id : null; bot = b; bid = NaN; journalRef = null; rt = '';
    if (!b) { draw(); return; }
    draw();
    try {
      const s = await app.api.botStatus(b.id);
      if (my !== seq) return;
      const mk = s && s.status && s.status.market;
      bid = mk ? Number(mk.bid) : NaN;
    } catch { /* keep "—" */ }
    if (!readBars(bot)) loadJournalRef(b.id, my);
    draw();
    unsub = app.api.subscribeBot(b.id, {
      status: (row) => { const mk = row && row.status && row.status.market; if (mk) { bid = Number(mk.bid); draw(); } },
      bot: (row) => { if (row) { bot = { ...bot, ...row }; draw(); } },
      state: (st) => { rt = st; draw(); },
    });
    poll = setInterval(() => {
      if (!el.isConnected) { stop(); return; }
      if (rt !== 'SUBSCRIBED') refetch();
    }, 30000);
  }

  // first paint after the element is in the document
  requestAnimationFrame(() => { el.dataset.mounted = '1'; });
  on('bots-loaded', () => { if (el.isConnected || !el.dataset.mounted) bind(); });
  on('bot-changed', () => { if (el.isConnected || !el.dataset.mounted) bind(); });
  // a phone froze the page: realtime missed the price moves (and may not be joined any more)
  const offWake = onWake(() => { if (!el.isConnected && el.dataset.mounted) { offWake(); return; } if (botId) refetch(); });
  bind();
  return el;
}
