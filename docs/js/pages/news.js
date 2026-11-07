// News: upcoming news_events in Thai time, one-click blackout per bot (default -30/+90 min), admin add/edit/delete.
import { h, mount, icon, fmtThai, thaiDayKey, until, toast, errText, confirmDialog, openModal, errorState, loadingState, emptyState,
  field, busy, isoUtc, utcToThaiInput, thaiInputToUtc, utcToServer } from '../util.js';
import { app, currentBot, isAdmin } from '../state.js';
import { normDesired, patchDesired } from '../botctl.js';
import { panel, pageHead } from '../views.js';

const MIN = 60000;
const TIER = { 1: ['สำคัญมาก', 'tier1'], 2: ['สำคัญ', 'tier2'], 3: ['ทั่วไป', 'tier3'] };

export async function render(root, ctx) {
  const bot = currentBot();
  root.append(pageHead('ข่าว', 'ข่าวเศรษฐกิจที่มีผลกับราคาทอง (เวลาไทย) กดปุ่มข้างข่าวเพื่อให้บอทงดเข้าไม้ช่วงนั้น', null, 'news'));
  const ctrlBox = h('div'), listBox = h('div'), adminBox = h('div');
  root.append(ctrlBox, listBox, adminBox);
  listBox.append(loadingState());
  let news = [], ctl = null;
  const load = async () => {
    const [n, c] = await Promise.all([
      ctx.api.listNews({ fromIso: new Date(Date.now() - 24 * 3600e3).toISOString() }),
      bot ? ctx.api.botControl(bot.id).catch(() => null) : null,
    ]);
    news = n; ctl = c;
  };
  try { await load(); } catch (e) { listBox.replaceChildren(errorState(e, () => ctx.route())); return; }

  const beforeIn = h('input', { class: 'input', type: 'number', min: '0', max: '600', step: '5', value: '30', inputmode: 'numeric' });
  const afterIn = h('input', { class: 'input', type: 'number', min: '0', max: '600', step: '5', value: '90', inputmode: 'numeric' });
  [beforeIn, afterIn].forEach((el) => el.addEventListener('change', () => drawList()));
  ctrlBox.append(panel(null, { cls: 'news-ctrl' },
    h('div', { class: 'row gap wrap end' },
      h('p', { class: 'grow' }, bot ? ['งดเข้าไม้สำหรับ ', h('strong', null, bot.name), app.bots.length > 1 ? h('span', { class: 'muted small' }, ' (เปลี่ยนบอทได้ที่ด้านบน)') : null] : h('span', { class: 'muted' }, 'ยังไม่มีบอท ปุ่มงดเข้าไม้จะใช้ได้เมื่อมีบอท')),
      field('ก่อนข่าว (นาที)', beforeIn, { cls: 'narrow' }), field('หลังข่าว (นาที)', afterIn, { cls: 'narrow' }))));

  const mins = () => [Math.max(0, Math.min(600, Number(beforeIn.value) || 0)), Math.max(0, Math.min(600, Number(afterIn.value) || 0))];

  function covered(t) {
    if (!ctl) return false;
    const [b, a] = mins();
    return normDesired(ctl.desired).blackouts.some((x) => Date.parse(x.from_utc) <= t - b * MIN && Date.parse(x.to_utc) >= t + a * MIN);
  }

  function drawList() {
    const now = Date.now();
    const upcoming = news.filter((n) => Date.parse(n.ts_utc) >= now - 90 * MIN);
    const past = news.filter((n) => Date.parse(n.ts_utc) < now - 90 * MIN);
    if (!news.length) { listBox.replaceChildren(emptyState('ยังไม่มีข่าวในปฏิทิน', isAdmin() ? 'เพิ่มข่าวได้ที่ฟอร์มด้านล่าง' : 'ผู้ดูแลระบบจะเพิ่มข่าวสำคัญให้')); return; }
    const groups = new Map();
    for (const n of upcoming) {
      const k = thaiDayKey(Date.parse(n.ts_utc));
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(n);
    }
    mount(listBox,
      upcoming.length ? h('div', { class: 'news-days' }, [...groups.entries()].map(([k, list]) => h('section', { class: 'news-day' },
        h('h2', null, fmtThai(Date.parse(list[0].ts_utc), 'longday')),
        h('ul', { class: 'news-list' }, list.map(item))))) : emptyState('ไม่มีข่าวที่จะถึง', null),
      past.length ? h('details', { class: 'panel' }, h('summary', null, `ข่าวที่ผ่านไปใน 24 ชั่วโมง (${past.length})`), h('ul', { class: 'news-list' }, past.map(item))) : null);
  }

  function item(n) {
    const t = Date.parse(n.ts_utc);
    const [label, cls] = TIER[n.tier] || TIER[3];
    const done = covered(t);
    const live = t <= Date.now() && Date.now() < t + 90 * MIN;
    const off = bot ? bot.server_utc_offset_min ?? 0 : null;
    return h('li', { class: `news-item ${cls}` },
      h('div', { class: 'news-time' }, h('span', { class: 'big' }, fmtThai(t, 'time')), h('span', { class: 'muted small' }, live ? 'กำลังเกิด' : until(t))),
      h('div', { class: 'news-main' },
        h('p', { class: 'news-name' }, n.name, ' ', h('span', { class: `chip ${cls}` }, label)),
        n.note ? h('p', { class: 'muted small' }, n.note) : null,
        off !== null ? h('p', { class: 'muted small' }, `เวลาเซิร์ฟเวอร์ ${utcToServer(t, off).slice(11)}`) : null),
      h('div', { class: 'news-actions' },
        bot ? (done ? h('span', { class: 'chip good' }, icon('check'), 'งดไว้แล้ว')
          : h('button', { class: 'btn small', type: 'button', disabled: t + mins()[1] * MIN < Date.now(), onclick: (e) => blackout(n, e.currentTarget) }, icon('clock'), `งดเข้าไม้ −${mins()[0]}/+${mins()[1]} นาที`)) : null,
        isAdmin() ? h('button', { class: 'icon-btn', type: 'button', 'aria-label': `แก้ไข ${n.name}`, onclick: () => editNews(n) }, icon('edit')) : null,
        isAdmin() ? h('button', { class: 'icon-btn', type: 'button', 'aria-label': `ลบ ${n.name}`, onclick: () => delNews(n) }, icon('trash')) : null));
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
    try { await ctx.api.deleteNews(n.id); news = news.filter((x) => x.id !== n.id); drawList(); toast('ลบข่าวแล้ว', 'good'); } catch (e) { toast(errText(e), 'error'); }
  }

  drawList();
  if (isAdmin()) adminBox.append(panel('เพิ่มข่าว (ผู้ดูแล)', { sub: 'ใส่เวลาไทย ระบบเก็บเป็น UTC' }, newsForm(null)));
  const tick = setInterval(drawList, 60000);
  return () => clearInterval(tick);
}
