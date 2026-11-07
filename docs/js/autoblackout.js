// ตั้งค่าบอท > งดเข้าไม้ > อัตโนมัติ (SPEC 9.3): desired.auto_news and desired.schedule, sent with the version check
// like the other settings, the upcoming windows the agent made (agent_state.auto_blackouts), and a state line when the
// PC's agent is older than 1.2.0 or could not fetch the calendar. Read only for the admin viewing a member's bot.
import { h, mount, icon, fmtThai, toast, errText, busy, callout, until, ago } from './util.js';
import { normDesired, patchDesired } from './botctl.js';
import { stepper } from './views.js';

const DOW = ['', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์', 'อาทิตย์'];
const TIMES = Array.from({ length: 49 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);
const FRIDAY_NIGHT = { dow: 5, from: '21:00', to: '24:00' };
const NEWS_DEFAULT = { enabled: false, before_min: 30, after_min: 60, currencies: ['USD'], impact: ['High'] };
const SCHEDULE_DEFAULT = { enabled: false, us_holidays: true, weekly: [] };
const clone = (x) => JSON.parse(JSON.stringify(x));
const KIND = { news: 'ข่าว', schedule: 'ตารางเวลา', holiday: 'วันหยุดสหรัฐ' };
// "ข่าว: CPI m/m" / "วันหยุดสหรัฐ: Thanksgiving Day" / "ตารางเวลา" (agent_state.auto_blackouts[].kinds, SPEC 9.3)
function windowReason(w) {
  const kinds = (Array.isArray(w.kinds) ? w.kinds : []).map((k) => KIND[k] || k);
  const reason = w.reason || '';
  if (!kinds.length) return reason || 'อัตโนมัติ';
  if (kinds.length === 1 && (reason === kinds[0] || reason === 'ตารางเวลา')) return kinds[0];
  return `${kinds.join(' + ')}${reason ? `: ${reason}` : ''}`;
}
const clamp = (x) => Math.max(0, Math.min(240, Math.round(Number(x) || 0)));

export function semverAtLeast(v, min) {
  const a = String(v || '').split('.').map((x) => parseInt(x, 10) || 0), b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i]; }
  return true;
}

function readAuto(desired) {
  const d = normDesired(desired);
  const n = d.auto_news && typeof d.auto_news === 'object' ? d.auto_news : {};
  const s = d.schedule && typeof d.schedule === 'object' ? d.schedule : {};
  return {
    auto_news: { ...NEWS_DEFAULT, ...n, enabled: !!n.enabled, before_min: clamp(n.before_min ?? 30), after_min: clamp(n.after_min ?? 60) },
    schedule: { ...SCHEDULE_DEFAULT, ...s, enabled: !!s.enabled, us_holidays: s.us_holidays !== false,
      weekly: Array.isArray(s.weekly) ? s.weekly.filter((w) => w && w.dow >= 1 && w.dow <= 7 && w.from && w.to).map((w) => ({ dow: w.dow, from: w.from, to: w.to })) : [] },
  };
}

export function validateAuto(a) {
  const errs = [];
  for (const k of ['before_min', 'after_min']) if (!(a.auto_news[k] >= 0 && a.auto_news[k] <= 240)) errs.push('ก่อนและหลังข่าวต้องอยู่ระหว่าง 0 ถึง 240 นาที');
  if (a.schedule.weekly.length > 14) errs.push('ตั้งได้ไม่เกิน 14 ช่วงต่อสัปดาห์');
  a.schedule.weekly.forEach((w, i) => { if (!(w.from < w.to)) errs.push(`ช่วงที่ ${i + 1}: เวลาเริ่มต้องก่อนเวลาจบ`); });
  return [...new Set(errs)];
}

// get(): { bot, ctl, friend }; onSent(ctlRow)
export function autoBlackouts({ get, onSent }) {
  const box = h('div', { class: 'auto-bo' });
  let base = null, edit = null, sending = false;

  box.update = (force) => {
    const { ctl } = get();
    const fresh = readAuto(ctl && ctl.desired);
    const dirty = edit && JSON.stringify(edit) !== JSON.stringify(base);
    if (!force && dirty) { base = fresh; drawStatus(); return; } // keep the user's unsent edits
    if (!force && base && JSON.stringify(fresh) === JSON.stringify(base)) { drawStatus(); return; }
    base = fresh; edit = clone(fresh);
    draw();
  };

  const statusBox = h('div', { class: 'auto-status' });
  function drawStatus() {
    const { bot } = get();
    const as = (bot && bot.agent_state) || {};
    const ver = as.agent_version || bot.agent_version || '';
    const out = [];
    const on = base && (base.auto_news.enabled || base.schedule.enabled);
    if (!semverAtLeast(ver, '1.2.0')) {
      out.push(callout('info', `แอป Dobby ที่เครื่องนี้เป็นรุ่น ${ver || 'เก่า'}`,
        h('p', null, 'ต้องเป็นรุ่น 1.2.0 ขึ้นไปจึงจะงดเข้าไม้อัตโนมัติได้ ค่าที่ตั้งไว้จะเริ่มใช้เมื่ออัปเดตแอปที่เครื่อง ', h('a', { href: '#/downloads' }, 'ดาวน์โหลดรุ่นล่าสุด'))));
    } else if (as.news_error) {
      out.push(callout('warn', 'ดึงปฏิทินข่าวไม่สำเร็จ', h('p', null, `เครื่องใช้ปฏิทินชุดล่าสุดที่มีอยู่${as.news_fetched_at ? ` (ดึงได้เมื่อ ${ago(Date.parse(as.news_fetched_at))})` : ''} และจะลองใหม่เอง`),
        h('p', { class: 'muted small' }, `ข้อความจากเครื่อง: ${as.news_error}`)));
    }
    const list = (Array.isArray(as.auto_blackouts) ? as.auto_blackouts : []).map((w) => ({ ...w, from: Date.parse(w.from_utc), to: Date.parse(w.to_utc) }))
      .filter((w) => Number.isFinite(w.from) && w.to > Date.now()).sort((a, b) => a.from - b.from);
    const now = Date.now();
    const item = (w) => {
      const sameDay = fmtThai(w.from, 'date') === fmtThai(w.to, 'date');
      const active = w.from <= now && now < w.to;
      return h('li', { class: `bo${active ? ' active' : ''}` },
        h('div', { class: 'bo-main' }, h('p', { class: 'bo-time' }, `${fmtThai(w.from, 'short')} ถึง ${fmtThai(w.to, sameDay ? 'time' : 'short')} น.`),
          h('p', { class: 'muted small' }, windowReason(w))),
        h('span', { class: `chip ${active ? 'warn' : ''}` }, active ? 'กำลังงดอยู่' : until(w.from)));
    };
    const head = h('div', { class: 'auto-head' }, h('p', { class: 'set-label' }, 'ช่วงงดอัตโนมัติ 7 วันข้างหน้า'),
      as.news_fetched_at && !as.news_error ? h('p', { class: 'hint' }, `อัปเดตปฏิทินข่าว${ago(Date.parse(as.news_fetched_at)) === 'เมื่อสักครู่' ? 'เมื่อสักครู่' : ` ${ago(Date.parse(as.news_fetched_at))}`}`) : null);
    if (semverAtLeast(ver, '1.2.0')) {
      out.push(head, list.length ? h('ul', { class: 'bo-list' }, list.slice(0, 12).map(item))
        : h('p', { class: 'muted group-note' }, on ? 'ยังไม่มีช่วงงดใน 7 วันข้างหน้า (หรือรอเครื่องคำนวณหลังได้รับค่าใหม่)' : 'ปิดอยู่ทั้งสองอย่าง จึงไม่มีช่วงงดอัตโนมัติ'));
    }
    mount(statusBox, ...out);
  }

  // structure is rebuilt only for structural changes (a switch, a row added or removed); numbers and times update in
  // place (soft) so the focused control keeps focus
  const errBox = h('div', { class: 'stack auto-errs' }), saveBox = h('div');
  let newsText = null;
  function soft() {
    const a = edit;
    if (newsText) newsText.textContent = newsLine(a);
    const errs = validateAuto(a);
    mount(errBox, errs.map((x) => h('p', { class: 'field-error' }, x)));
    errBox.hidden = !errs.length;
    const dirty = JSON.stringify(edit) !== JSON.stringify(base);
    const save = h('button', { class: 'btn primary', type: 'button', disabled: !!errs.length || sending, onclick: (e) => send(e.currentTarget) }, icon('check'), 'บันทึกและส่งให้บอท');
    mount(saveBox, dirty ? h('div', { class: 'set-row auto-save' }, h('div', { class: 'set-row-main' },
      h('div', { class: 'set-copy' }, h('p', { class: 'set-label' }, 'มีการเปลี่ยนแปลงที่ยังไม่ส่ง'), h('p', { class: 'hint' }, 'ไม่ยุ่งกับช่วงงดที่ตั้งเอง และไม่ยุ่งกับสวิตช์เทรดจริง')),
      h('div', { class: 'set-ctrl' }, h('button', { class: 'btn ghost', type: 'button', onclick: () => { edit = clone(base); draw(); } }, 'ยกเลิก'), save))) : '');
  }
  const newsLine = (a) => `ข่าวสหรัฐที่มีผลแรงจากปฏิทินข่าว: บอทไม่เปิดไม้ใหม่ ${a.auto_news.before_min} นาทีก่อนข่าว ถึง ${a.auto_news.after_min} นาทีหลังข่าว`;

  function draw() {
    const { friend } = get();
    if (friend) { drawReadOnly(); return; }
    const a = edit;
    const sw = (on, label, fn) => h('button', { type: 'button', class: 'switch', role: 'switch', 'aria-checked': on ? 'true' : 'false', 'aria-label': label, onclick: fn },
      h('span', { class: 'switch-knob', 'aria-hidden': 'true' }));
    const card = (title, text, on, toggle, extra) => h('div', { class: `toggle-card${on ? ' on' : ''}` },
      h('div', { class: 'toggle-main' }, h('div', { class: 'toggle-copy' }, h('p', { class: 'toggle-title' }, title), text),
        h('div', { class: 'toggle-side' }, h('span', { class: 'toggle-state' }, on ? 'เปิด' : 'ปิด'), sw(on, title, toggle))),
      extra);
    const st = (label, key) => { const el = stepper({ label, get: () => a.auto_news[key], set: (x) => { a.auto_news[key] = clamp(x); el.update(); soft(); }, step: 5, min: 0, max: 240, unit: 'นาที' }); return el; };
    const newsExtra = a.auto_news.enabled ? h('div', { class: 'toggle-extra auto-mins' },
      h('div', { class: 'stage-ctrl' }, h('span', { class: 'small' }, 'ก่อนข่าว'), st('ก่อนข่าว', 'before_min')),
      h('div', { class: 'stage-ctrl' }, h('span', { class: 'small' }, 'หลังข่าว'), st('หลังข่าว', 'after_min'))) : null;
    const opt = (list, val, exclude) => list.filter((t) => t !== exclude).map((t) => h('option', { value: t, selected: t === val }, t));
    const weekRow = (w, i) => {
      const li = h('li', { class: `week-row${w.from < w.to ? '' : ' bad'}` });
      const mark = () => li.classList.toggle('bad', !(w.from < w.to));
      const day = h('select', { class: 'input select', 'aria-label': `วัน ช่วงที่ ${i + 1}`, onchange: (e) => { w.dow = Number(e.target.value); soft(); } },
        DOW.slice(1).map((n, k) => h('option', { value: String(k + 1), selected: w.dow === k + 1 }, n)));
      const from = h('select', { class: 'input select', 'aria-label': `เริ่ม ช่วงที่ ${i + 1}`, onchange: (e) => { w.from = e.target.value; mark(); soft(); } }, opt(TIMES, w.from, '24:00'));
      const to = h('select', { class: 'input select', 'aria-label': `จบ ช่วงที่ ${i + 1}`, onchange: (e) => { w.to = e.target.value; mark(); soft(); } }, opt(TIMES, w.to, '00:00'));
      li.append(day, h('span', { class: 'week-times' }, from, h('span', { class: 'muted', 'aria-hidden': 'true' }, 'ถึง'), to),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': `ลบช่วงที่ ${i + 1}`, onclick: () => { a.schedule.weekly.splice(i, 1); draw(); } }, icon('trash')));
      return li;
    };
    const hasFri = a.schedule.weekly.some((w) => w.dow === 5 && w.from === '21:00' && w.to === '24:00');
    const holiday = h('input', { type: 'checkbox', checked: a.schedule.us_holidays, onchange: (e) => { a.schedule.us_holidays = e.target.checked; soft(); } });
    const schedExtra = a.schedule.enabled ? h('div', { class: 'toggle-extra auto-sched' },
      a.schedule.weekly.length ? h('ol', { class: 'week-list' }, a.schedule.weekly.map(weekRow)) : h('p', { class: 'muted small' }, 'ยังไม่มีช่วงประจำสัปดาห์'),
      a.schedule.weekly.length ? h('p', { class: 'hint' }, 'เวลาไทย 24:00 คือสิ้นวันนั้น') : null,
      h('div', { class: 'row gap wrap' },
        h('button', { class: 'btn small', type: 'button', disabled: a.schedule.weekly.length >= 14, onclick: () => { a.schedule.weekly.push({ dow: 1, from: '00:00', to: '06:00' }); draw(); } }, icon('plus'), 'เพิ่มช่วง'),
        hasFri ? null : h('button', { class: 'btn small', type: 'button', disabled: a.schedule.weekly.length >= 14, onclick: () => { a.schedule.weekly.push({ ...FRIDAY_NIGHT }); draw(); } }, icon('clock'), 'ไม่เทรดคืนวันศุกร์')),
      h('label', { class: 'check' }, holiday, h('span', null, 'วันหยุดตลาดหุ้นสหรัฐ (ทั้งวัน เวลานิวยอร์ก)'))) : null;
    newsText = h('p', { class: 'toggle-text' }, newsLine(a));
    mount(box,
      card('งดช่วงข่าวอัตโนมัติ', newsText, a.auto_news.enabled, () => { a.auto_news.enabled = !a.auto_news.enabled; draw(); }, newsExtra),
      card('ตารางเวลา', h('p', { class: 'toggle-text' }, 'งดเข้าไม้ตามวันและเวลาที่ตั้งไว้ทุกสัปดาห์ (เวลาไทย) และวันที่ตลาดหุ้นสหรัฐปิด'),
        a.schedule.enabled, () => { a.schedule.enabled = !a.schedule.enabled; if (a.schedule.enabled && !a.schedule.weekly.length) a.schedule.weekly.push({ ...FRIDAY_NIGHT }); draw(); }, schedExtra),
      errBox, saveBox, statusBox);
    soft();
    drawStatus();
  }

  function drawReadOnly() {
    const a = base;
    const row = (k, v) => [h('dt', null, k), h('dd', null, v)];
    mount(box, h('dl', { class: 'kv' },
      row('งดช่วงข่าวอัตโนมัติ', a.auto_news.enabled ? `เปิด ก่อนข่าว ${a.auto_news.before_min} นาที หลังข่าว ${a.auto_news.after_min} นาที` : 'ปิด'),
      row('ตารางเวลา', a.schedule.enabled
        ? [a.schedule.weekly.map((w) => `${DOW[w.dow]} ${w.from} ถึง ${w.to}`).join(', ') || 'ไม่มีช่วงประจำสัปดาห์', a.schedule.us_holidays ? ' และวันหยุดตลาดหุ้นสหรัฐ' : ''].join('')
        : 'ปิด')), statusBox);
    drawStatus();
  }

  async function send(btn) {
    const { bot } = get();
    const next = clone(edit);
    sending = true;
    busy(btn, true, 'กำลังส่ง…');
    try {
      const row = await patchDesired(bot.id, (d) => {
        d.auto_news = { ...(d.auto_news && typeof d.auto_news === 'object' ? d.auto_news : {}), ...next.auto_news };
        d.schedule = { ...(d.schedule && typeof d.schedule === 'object' ? d.schedule : {}), ...next.schedule };
      });
      base = readAuto(row.desired); edit = clone(base);
      toast('ส่งการตั้งเวลาให้บอทแล้ว เครื่องจะคำนวณช่วงงดใหม่', 'good');
      onSent && onSent(row);
    } catch (e) { toast(errText(e), 'error', 6000); }
    sending = false;
    draw();
  }

  box.update(true);
  return box;
}
