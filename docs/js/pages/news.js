// News: upcoming news_events in Thai time merged with the PC's own calendar (agent_state.news, SPEC 9.3: Forex Factory, USD,
// High; the same moment is shown once), one-click blackout per bot (default -30/+90 min), admin add/edit/delete.
// Each line shows its forecast and previous value and which way gold usually goes when the real number comes out above,
// at or below the forecast (newsguide.js, 2026-11-10).
import { h, mount, icon, fmtThai, thaiDayKey, until, toast, errText, confirmDialog, openModal, errorState, loadingState, emptyState,
  field, busy, isoUtc, utcToThaiInput, thaiInputToUtc, utcToServer } from '../util.js';
import { app, myBot, isAdmin, ownsBot } from '../state.js';
import { normDesired, patchDesired } from '../botctl.js';
import { panel, pageHead } from '../views.js';
import { guideFor, outcomes } from '../newsguide.js';

const MIN = 60000;
const TIER = { 1: ['สำคัญมาก', 'tier1'], 2: ['สำคัญ', 'tier2'], 3: ['ทั่วไป', 'tier3'] };
const IMPACT_TIER = { high: 1, medium: 2, low: 3 };

// news_events + agent_state.news, de-duplicated: calendar events within 5 minutes of an admin item are folded into it
// (shown as its calendar lines); the rest become items of their own, one per moment.
export function mergeNews(events, agentNews) {
  const out = events.map((n) => ({ ...n, cal: [] }));
  const extra = [];
  for (const a of agentNews || []) {
    const t = Date.parse(a.ts_utc);
    if (!Number.isFinite(t) || !a.title) continue;
    const host = out.find((n) => n.id !== undefined && Math.abs(Date.parse(n.ts_utc) - t) <= 5 * MIN) || extra.find((n) => Math.abs(Date.parse(n.ts_utc) - t) <= 5 * MIN);
    if (host) { if (!host.cal.some((c) => c.title === a.title)) host.cal.push(a); if (host.auto) host.tier = Math.min(host.tier, IMPACT_TIER[String(a.impact || '').toLowerCase()] || 2); continue; }
    extra.push({ auto: true, ts_utc: new Date(t).toISOString(), name: a.title, tier: IMPACT_TIER[String(a.impact || '').toLowerCase()] || 2, cal: [a] });
  }
  for (const x of extra) x.name = x.cal.map((c) => c.title).join(', ');
  return [...out, ...extra].sort((a, b) => a.ts_utc.localeCompare(b.ts_utc));
}

export async function render(root, ctx) {
  const bot = myBot(); // blackouts go to the bot shown: mine, or the member's bot the admin is looking at (2026-11-10)
  root.append(pageHead('ข่าว', 'ข่าวเศรษฐกิจที่มีผลกับราคาทอง (เวลาไทย) กดปุ่มข้างข่าวเพื่อให้บอทงดเข้าไม้ช่วงนั้น', null, 'news'));
  const ctrlBox = h('div'), listBox = h('div', { class: 'stack-lg' }), adminBox = h('div');
  root.append(ctrlBox, listBox, adminBox);
  listBox.append(loadingState());
  let news = [], ctl = null;
  // the PC calendar of my bot (or of any of my bots that has one)
  const calBot = [bot, ...app.bots].find((b) => b && b.agent_state && Array.isArray(b.agent_state.news) && b.agent_state.news.length);
  const load = async () => {
    const [n, c] = await Promise.all([
      ctx.api.listNews({ fromIso: new Date(Date.now() - 24 * 3600e3).toISOString() }),
      bot ? ctx.api.botControl(bot.id).catch(() => null) : null,
    ]);
    const since = Date.now() - 24 * 3600e3;
    news = mergeNews(n, calBot ? calBot.agent_state.news.filter((a) => Date.parse(a.ts_utc) >= since) : []);
    ctl = c;
  };
  try { await load(); } catch (e) { listBox.replaceChildren(errorState(e, () => ctx.route())); return; }

  const beforeIn = h('input', { class: 'input', type: 'number', min: '0', max: '600', step: '5', value: '30', inputmode: 'numeric' });
  const afterIn = h('input', { class: 'input', type: 'number', min: '0', max: '600', step: '5', value: '90', inputmode: 'numeric' });
  [beforeIn, afterIn].forEach((el) => el.addEventListener('change', () => drawList()));
  ctrlBox.append(panel(null, {},
    h('div', { class: 'news-ctrl' },
      h('p', { class: 'grow' }, bot ? ['งดเข้าไม้สำหรับ ', h('strong', null, bot.name), ownsBot(bot) ? null : ` ของ ${bot.owner_name || 'สมาชิก'}`, app.bots.length > 1 ? h('span', { class: 'muted small' }, ' (เปลี่ยนบอทได้ที่ด้านบน)') : null] : h('span', { class: 'muted' }, 'ยังไม่มีบอท ปุ่มงดเข้าไม้จะใช้ได้เมื่อมีบอท')),
      field('ก่อนข่าว (นาที)', beforeIn, { cls: 'narrow' }), field('หลังข่าว (นาที)', afterIn, { cls: 'narrow' }))));

  const mins = () => [Math.max(0, Math.min(600, Number(beforeIn.value) || 0)), Math.max(0, Math.min(600, Number(afterIn.value) || 0))];

  function covered(t) {
    if (!ctl) return false;
    const [b, a] = mins();
    return normDesired(ctl.desired).blackouts.some((x) => Date.parse(x.from_utc) <= t - b * MIN && Date.parse(x.to_utc) >= t + a * MIN);
  }
  // the windows set by hand that hold the news moment and have not ended: what "ยกเลิกงด" removes
  function hitsOf(t) {
    if (!ctl) return [];
    const now = Date.now();
    return normDesired(ctl.desired).blackouts.filter((x) => Date.parse(x.from_utc) <= t && Date.parse(x.to_utc) >= t && Date.parse(x.to_utc) > now)
      .sort((a, b) => a.from_utc.localeCompare(b.from_utc));
  }
  // the PC's automatic news pause (SPEC 9.3) is not in the list above: removing a hand-set window does not lift it
  const autoHolds = (t) => (Array.isArray(bot && bot.agent_state && bot.agent_state.auto_blackouts) ? bot.agent_state.auto_blackouts : [])
    .some((w) => Date.parse(w.from_utc) <= t && Date.parse(w.to_utc) >= t && Date.parse(w.to_utc) > Date.now());
  const span = (from, to) => `${fmtThai(from, 'short')} ถึง ${fmtThai(to, fmtThai(from, 'date') === fmtThai(to, 'date') ? 'time' : 'short')} น.`;

  function drawList() {
    const now = Date.now();
    const upcoming = news.filter((n) => Date.parse(n.ts_utc) >= now - 90 * MIN);
    const past = news.filter((n) => Date.parse(n.ts_utc) < now - 90 * MIN);
    if (!news.length) { listBox.replaceChildren(emptyState('ยังไม่มีข่าวในปฏิทิน', isAdmin() ? 'เพิ่มข่าวได้ที่ฟอร์มด้านล่าง' : 'ผู้ดูแลระบบจะเพิ่มข่าวสำคัญให้')); return; }
    const calNote = calBot ? h('p', { class: 'muted small cal-note' }, `รวมปฏิทินข่าวอัตโนมัติจากเครื่อง ${calBot.name} (ข่าวสหรัฐที่มีผลแรง)`,
      calBot.agent_state.news_fetched_at ? ` อัปเดต ${fmtThai(Date.parse(calBot.agent_state.news_fetched_at), 'short')} น.` : '') : null;
    const groups = new Map();
    for (const n of upcoming) {
      const k = thaiDayKey(Date.parse(n.ts_utc));
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(n);
    }
    const guideNote = h('p', { class: 'muted small' }, 'ใต้ข่าวแต่ละตัวมีค่าคาดการณ์ ค่าครั้งก่อน และทองมักขึ้นหรือลงเมื่อตัวเลขจริงออกมาสูงหรือต่ำกว่าที่คาด เป็นแนวโน้มทั่วไปของตลาด ไม่ใช่คำทำนาย ช่วงแรกหลังข่าวราคามักกระชากทั้งสองทาง');
    mount(listBox, calNote, guideNote,
      upcoming.length ? h('div', { class: 'news-days' }, [...groups.entries()].map(([k, list]) => h('section', { class: 'news-day' },
        h('h2', null, fmtThai(Date.parse(list[0].ts_utc), 'longday')),
        h('ul', { class: 'news-list' }, list.map(item))))) : emptyState('ไม่มีข่าวที่จะถึง', null),
      past.length ? h('details', { class: 'panel past-news' }, h('summary', null, `ข่าวที่ผ่านไปใน 24 ชั่วโมง (${past.length})`), h('ul', { class: 'news-list' }, past.map(item))) : null);
  }

  function item(n) {
    const t = Date.parse(n.ts_utc);
    const [label, cls] = TIER[n.tier] || TIER[3];
    const done = covered(t);
    const undo = bot && hitsOf(t).length ? h('button', { class: 'btn small ghost', type: 'button', onclick: (e) => unblackout(n, e.currentTarget) }, icon('x'), 'ยกเลิกงด') : null;
    const live = t <= Date.now() && Date.now() < t + 90 * MIN;
    const off = bot ? bot.server_utc_offset_min ?? 0 : null;
    return h('li', { class: `news-item ${cls}` },
      h('div', { class: 'news-time' }, h('span', { class: 'big' }, fmtThai(t, 'time')), h('span', { class: 'muted small' }, live ? 'กำลังเกิด' : until(t))),
      h('div', { class: 'news-main' },
        h('p', { class: 'news-name' }, n.name, ' ', h('span', { class: `chip ${cls}` }, label), n.auto ? [' ', h('span', { class: 'chip quiet-chip' }, 'ปฏิทินอัตโนมัติ')] : null),
        n.note ? h('p', { class: 'muted small' }, n.note) : null,
        detail(n),
        off !== null ? h('p', { class: 'muted small' }, `เวลาเซิร์ฟเวอร์ ${utcToServer(t, off).slice(11)}`) : null),
      h('div', { class: 'news-actions' },
        bot ? (done ? h('span', { class: 'chip good' }, icon('check'), 'งดไว้แล้ว')
          : h('button', { class: 'btn small', type: 'button', disabled: t + mins()[1] * MIN < Date.now(), onclick: (e) => blackout(n, e.currentTarget) }, icon('clock'), `งดเข้าไม้ −${mins()[0]}/+${mins()[1]} นาที`)) : null,
        undo,
        isAdmin() && !n.auto ? h('button', { class: 'icon-btn', type: 'button', 'aria-label': `แก้ไข ${n.name}`, onclick: () => editNews(n) }, icon('edit')) : null,
        isAdmin() && !n.auto ? h('button', { class: 'icon-btn', type: 'button', 'aria-label': `ลบ ${n.name}`, onclick: () => delNews(n) }, icon('trash')) : null));
  }

  // forecast / previous of each calendar line of this news, and which way gold usually goes (newsguide.js)
  function detail(n) {
    const cal = n.cal || [];
    const lines = cal.length ? cal : [{ title: n.name, currency: 'USD' }]; // an admin item without the PC calendar
    const named = !(lines.length === 1 && (n.auto || !cal.length)); // one line: its title is already the item's name
    const whys = new Set();
    const rows = lines.map((c) => {
      const g = guideFor(c.title, c.currency);
      const nums = !!(c.forecast || c.previous);
      if (!g && !nums && !named) return null;
      const talk = g && (g.kind === 'talk' || g.kind === 'off');
      const why = g && !talk && !whys.has(g.why) ? (whys.add(g.why), g.why) : null; // once per news
      const outs = outcomes(g, c.forecast, c.previous);
      return h('li', { class: 'cal-line' },
        named || g ? h('p', { class: 'cal-title' }, named ? h('span', null, c.title) : null, g ? h('span', { class: 'cal-th' }, g.th) : null) : null,
        nums ? h('p', { class: 'cal-nums' },
          h('span', null, 'คาดการณ์ ', h('strong', { class: 'num' }, c.forecast || '—')),
          h('span', null, 'ครั้งก่อน ', h('strong', { class: 'num' }, c.previous || '—'))) : null,
        outs.length ? h('ul', { class: 'gold-react', 'aria-label': 'ทองมักขึ้นหรือลง' }, outs.map(([label, dir, text]) => h('li', null,
          h('span', { class: 'react-k' }, label),
          h('span', { class: `react-v${dir ? ` ${dir === 'up' ? 'pos' : 'neg'}` : ''}` }, dir ? (dir === 'up' ? '▲ ' : '▼ ') : '', text)))) : null,
        talk ? h('p', { class: 'react-talk' }, g.why) : null,
        why ? h('p', { class: 'muted small react-why' }, 'ทำไม: ', why) : null);
    }).filter(Boolean);
    return rows.length ? h('ul', { class: 'cal-lines' }, rows) : null;
  }

  async function blackout(n, btn) {
    const t = Date.parse(n.ts_utc);
    const [b, a] = mins();
    busy(btn, true);
    try {
      ctl = await patchDesired(bot.id, (d) => {
        d.blackouts = d.blackouts.filter((x) => Date.parse(x.to_utc) > Date.now());
        d.blackouts.push({ from_utc: isoUtc(t - b * MIN), to_utc: isoUtc(t + a * MIN), label: n.name });
        d.blackouts.sort((x, y) => x.from_utc.localeCompare(y.from_utc));
      });
      toast(`งดเข้าไม้ ${fmtThai(t - b * MIN, 'time')} ถึง ${fmtThai(t + a * MIN, 'time')} น. แล้ว`, 'good');
      drawList();
    } catch (e) { busy(btn, false); toast(errText(e), 'error', 6000); }
  }

  // Lifts the pause around one news: removes every hand-set window that holds its moment. Asks first only when one of
  // them was not made for this news (another news, "งด 2 ชม." or a window set by hand), since that one goes too.
  async function unblackout(n, btn) {
    const t = Date.parse(n.ts_utc);
    const hits = hitsOf(t);
    if (!hits.length) { drawList(); return; }
    if (hits.some((x) => (x.label || '') !== n.name)) {
      const ok = await confirmDialog('ยกเลิกงดช่วงข่าวนี้?', h('div', { class: 'stack' },
        h('p', null, hits.length > 1 ? 'ช่วงงดเหล่านี้ครอบเวลาข่าวนี้อยู่ จะถูกลบทั้งหมด:' : 'ช่วงงดนี้ครอบเวลาข่าวนี้อยู่ และจะถูกลบ:'),
        hits.map((x) => h('p', { class: 'small' }, h('strong', null, span(Date.parse(x.from_utc), Date.parse(x.to_utc))), ' ', x.label || 'ไม่มีชื่อ'))),
      { ok: 'ยกเลิกงด', cancel: 'ไม่ลบ' });
      if (!ok) return;
    }
    const key = (x) => `${x.from_utc}|${x.to_utc}`;
    const gone = new Set(hits.map(key));
    busy(btn, true);
    try {
      ctl = await patchDesired(bot.id, (d) => { d.blackouts = d.blackouts.filter((x) => !gone.has(key(x))); });
      if (autoHolds(t)) toast('ยกเลิกงดแล้ว แต่งดข่าวอัตโนมัติยังงดช่วงนี้อยู่ ปิดได้ที่ ตั้งค่าบอท > งดเข้าไม้', 'info', 8000);
      else toast('ยกเลิกงดแล้ว บอทเปิดไม้ช่วงข่าวนี้ได้ตามปกติ', 'good');
      drawList();
    } catch (e) { busy(btn, false); toast(errText(e), 'error', 6000); }
  }

  function newsForm(n, onSave) {
    const whenIn = h('input', { class: 'input', type: 'datetime-local', required: true, value: n ? utcToThaiInput(Date.parse(n.ts_utc)) : '' });
    const nameIn = h('input', { class: 'input', type: 'text', required: true, maxlength: 120, value: n ? n.name : '', list: 'news-names' });
    const tierIn = h('select', { class: 'input select' }, [1, 2, 3].map((t) => h('option', { value: String(t), selected: n ? n.tier === t : t === 1 }, `${t} ${TIER[t][0]}`)));
    const noteIn = h('input', { class: 'input', type: 'text', maxlength: 300, value: n && n.note ? n.note : '' });
    const err = h('p', { class: 'field-error', role: 'alert' });
    const names = h('datalist', { id: 'news-names' }, ['US NFP (Non-Farm Payrolls)', 'US CPI', 'FOMC rate decision', 'FOMC press conference'].map((x) => h('option', { value: x })));
    const form = h('form', {
      class: 'stack',
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        const t = thaiInputToUtc(whenIn.value);
        if (!Number.isFinite(t)) { err.textContent = 'เลือกวันเวลา'; return; }
        if (!nameIn.value.trim()) { err.textContent = 'ใส่ชื่อข่าว'; return; }
        const btn = form.querySelector('button[type=submit]');
        busy(btn, true);
        try {
          await ctx.api.saveNews({ id: n ? n.id : undefined, ts_utc: isoUtc(t), name: nameIn.value.trim(), tier: Number(tierIn.value), note: noteIn.value.trim() });
          await load();
          onSave && onSave();
          drawList();
          toast(n ? 'แก้ไขข่าวแล้ว' : 'เพิ่มข่าวแล้ว', 'good');
          if (!n) { whenIn.value = ''; nameIn.value = ''; noteIn.value = ''; }
          busy(btn, false);
        } catch (ex) { busy(btn, false); err.textContent = errText(ex); }
      },
    },
    names,
    h('div', { class: 'grid-2 tight' }, field('วันเวลา (เวลาไทย)', whenIn), field('ระดับ', tierIn)),
    field('ชื่อข่าว', nameIn), field('หมายเหตุ', noteIn), err,
    h('button', { class: 'btn primary', type: 'submit' }, icon(n ? 'check' : 'plus'), n ? 'บันทึก' : 'เพิ่มข่าว'));
    return form;
  }

  function editNews(n) {
    const m = openModal({ title: 'แก้ไขข่าว', body: newsForm(n, () => m.close()) });
  }
  async function delNews(n) {
    const ok = await confirmDialog(`ลบข่าว "${n.name}"?`, `${fmtThai(Date.parse(n.ts_utc), 'datetime')} ช่วงงดเข้าไม้ที่ตั้งไว้แล้วไม่ถูกลบ`, { ok: 'ลบ', danger: true });
    if (!ok) return;
    try { await ctx.api.deleteNews(n.id); await load(); drawList(); toast('ลบข่าวแล้ว', 'good'); } catch (e) { toast(errText(e), 'error'); }
  }

  drawList();
  if (isAdmin()) adminBox.append(panel('เพิ่มข่าว (ผู้ดูแล)', { sub: 'ใส่เวลาไทย ระบบเก็บเป็น UTC' }, newsForm(null)));
  const tick = setInterval(drawList, 60000);
  return () => clearInterval(tick);
}
