// Control: mode, sides, lots (lower only), max spread, note, blackouts, web params; desired vs applied; bot settings.
import { h, icon, fmtNum, fmtThai, toast, errText, confirmDialog, errorState, loadingState, field, busy, isoUtc,
  utcToThaiInput, thaiInputToUtc, utcToServer, serverToUtc, until, callout, newId } from '../util.js';
import { app, currentBot, updateBotRow, loadBots, on } from '../state.js';
import { normDesired, patchDesired, onlineInfo, onlineBadge, pendingChip, rejectionsBlock, appliedVersion, isPending, cmdBlock } from '../botctl.js';
import { liveSwitch, appliedLive } from '../liveswitch.js';
import { kv, panel, pageHead, noBotState, onOff } from '../views.js';
import { REMOTE_KEYS } from '../params.js';

const MIN = 60000;
export const NEWS_RE = /NFP|Non-Farm|CPI|FOMC/i;

export async function render(root, ctx) {
  const bot0 = currentBot();
  if (!bot0) { root.append(noBotState()); return; }
  let bot = bot0, st = null, ctl = null, news = [];
  root.append(loadingState());
  try {
    const [s, c, n] = await Promise.all([ctx.api.botStatus(bot.id), ctx.api.botControl(bot.id),
      ctx.api.listNews({ fromIso: new Date(Date.now() - 3 * 3600e3).toISOString() }).catch(() => [])]);
    st = s ? s.status : null; ctl = c; news = n || [];
  } catch (e) { root.replaceChildren(errorState(e, () => ctx.route())); return; }
  root.replaceChildren();
  if (!ctl) {
    root.append(pageHead('ควบคุม', bot.name), callout('warn', 'บอทนี้ยังไม่มีแถวควบคุม',
      h('p', null, 'ให้รันคำสั่ง register ที่เครื่องอีกครั้ง (แถวควบคุมถูกสร้างตอน register เท่านั้น)'), cmdBlock('python dobby_agent.py register --name "ชื่อเครื่อง" --force')));
    return;
  }
  const off = () => bot.server_utc_offset_min ?? 0;

  const headBox = h('div'), statusBox = h('div'), liveBox = h('div'), formBox = h('div'), boBox = h('div'), paramsBox = h('div'), limitsBox = h('div'), manageBox = h('div');
  root.append(headBox, statusBox, liveBox, h('div', { class: 'grid-2 control-grid' }, formBox, boBox), paramsBox, h('div', { class: 'grid-2' }, limitsBox, manageBox));

  const drawHead = () => headBox.replaceChildren(pageHead('ควบคุม', h('span', { class: 'muted' }, bot.name), onlineBadge(onlineInfo(bot, st))));

  // skip re-rendering interactive sections when nothing they show changed (keeps keyboard focus on ticks)
  const sigs = {};
  const changed = (key, val) => { const s = JSON.stringify(val); if (sigs[key] === s) return false; sigs[key] = s; return true; };

  function drawStatus(force) {
    const info = onlineInfo(bot, st);
    const pend = isPending(bot, ctl);
    const as = bot.agent_state || {};
    if (!changed('status', [ctl.version, ctl.updated_at, appliedVersion(bot), pend, info.agentOnline, as.rejected, as.last_error,
      st && st.remote && st.remote.rejects, st && st.control && st.control.warn]) && force !== true) return;
    statusBox.replaceChildren(panel('สถานะคำสั่ง', { cls: 'cmd-status' },
      h('div', { class: 'row gap wrap' }, pendingChip(bot, ctl, info),
        h('span', { class: 'muted small' }, `เว็บ v${ctl.version} เครื่องใช้ v${appliedVersion(bot)}`),
        ctl.updated_at ? h('span', { class: 'muted small' }, `แก้ล่าสุด ${fmtThai(Date.parse(ctl.updated_at), 'short')}`) : null),
      pend && !info.agentOnline ? h('p', { class: 'muted small' }, 'เครื่องออฟไลน์อยู่ คำสั่งจะถูกใช้เมื่อเอเจนต์กลับมาออนไลน์') : null,
      rejectionsBlock(bot, st)));
  }

  const drawLive = (force) => {
    const d = normDesired(ctl.desired);
    if (!changed('live', [d.live, d.control.mode, ctl.version, appliedVersion(bot), appliedLive(st), onlineInfo(bot, st).agentOnline]) && force !== true) return;
    liveBox.replaceChildren(liveSwitch({ bot, ctl, st, compact: true }));
  };

  function ceilings() {
    const lim = (bot.agent_state && bot.agent_state.limits) || {};
    const eff = st && st.remote && st.remote.effective;
    const lots = [st && st.params && st.params.max_lots, lim.max_lots, eff && eff.InpMaxLots].filter((x) => Number.isFinite(Number(x)) && x !== null).map(Number);
    const spread = st && st.params && Number.isFinite(st.params.max_spread_input) ? st.params.max_spread_input : null;
    return { lots: lots.length ? Math.min(...lots) : null, spread };
  }

  // ---------------- general form
  function drawForm() {
    const d = normDesired(ctl.desired);
    const base = JSON.parse(JSON.stringify(d.control));
    const cap = ceilings();
    const fid = newId('ctl');
    let mode = d.control.mode;
    const modeSeg = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'โหมด' });
    const drawMode = () => modeSeg.replaceChildren(...[['run', 'ทำงาน', 'play'], ['pause', 'หยุดชั่วคราว', 'pause']].map(([v, t, ic]) => h('button', {
      type: 'button', role: 'radio', 'aria-checked': mode === v ? 'true' : 'false', class: mode === v ? 'on' : '',
      onclick: () => { mode = v; drawMode(); dirty(); },
    }, icon(ic), t)));
    drawMode();
    const longIn = h('input', { type: 'checkbox', checked: d.control.allow_long, onchange: () => dirty() });
    const shortIn = h('input', { type: 'checkbox', checked: d.control.allow_short, onchange: () => dirty() });
    const lotsIn = h('input', { class: 'input', type: 'number', inputmode: 'decimal', step: '0.01', min: '0.01', max: cap.lots ?? '', value: d.control.lots ?? '', placeholder: 'ตาม EA', oninput: () => dirty() });
    const spreadIn = h('input', { class: 'input', type: 'number', inputmode: 'decimal', step: '0.05', min: '0.05', max: cap.spread ?? '', value: d.control.max_spread ?? '', placeholder: 'ตาม EA', oninput: () => dirty() });
    const noteIn = h('input', { class: 'input', type: 'text', maxlength: 120, value: d.control.note || '', placeholder: 'เช่น ข่าวแรงคืนนี้', oninput: () => dirty() });
    const err = h('p', { class: 'field-error', role: 'alert' });
    const save = h('button', { class: 'btn primary', type: 'submit', disabled: true }, icon('check'), 'ส่งคำสั่ง');
    const reset = h('button', { class: 'btn ghost', type: 'button', disabled: true, onclick: () => drawForm() }, 'คืนค่า');
    function values() {
      const num = (el) => (el.value.trim() === '' ? null : Number(el.value));
      return { mode, allow_long: longIn.checked, allow_short: shortIn.checked, lots: num(lotsIn), max_spread: num(spreadIn), note: noteIn.value.trim() };
    }
    function dirty() {
      const v = values();
      const changed = Object.keys(v).some((k) => (v[k] ?? null) !== (base[k] ?? (k === 'note' ? '' : null)));
      save.disabled = !changed; reset.disabled = !changed;
    }
    const form = h('form', {
      id: fid, class: 'stack',
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        const v = values();
        if (v.lots !== null && (!(v.lots >= 0.01) || (cap.lots !== null && v.lots > cap.lots + 1e-9))) { err.textContent = `ล็อตต้องอยู่ระหว่าง 0.01 ถึง ${fmtNum(cap.lots)} (ลดได้อย่างเดียว)`; return; }
        if (v.max_spread !== null && (!(v.max_spread >= 0.05) || (cap.spread !== null && v.max_spread > cap.spread + 1e-9))) { err.textContent = `สเปรดสูงสุดต้องอยู่ระหว่าง 0.05 ถึง ${fmtNum(cap.spread)} (EA ยอมให้เข้มขึ้นเท่านั้น)`; return; }
        if (!v.allow_long && !v.allow_short) {
          const ok = await confirmDialog('ปิดทั้งสองฝั่ง?', 'บอทจะไม่เปิดไม้ใหม่ทั้งซื้อและขาย (เหมือนหยุดชั่วคราว)', { ok: 'ส่งคำสั่ง' });
          if (!ok) return;
        }
        if (base.mode === 'pause' && v.mode === 'run') {
          const ok = await confirmDialog('ให้บอททำงานต่อ?', 'บอทจะกลับมาเปิดไม้ใหม่ได้ตามสัญญาณ (ถ้าสวิตช์เทรดจริงเปิดอยู่)', { ok: 'ทำงานต่อ' });
          if (!ok) return;
        }
        busy(save, true, 'กำลังส่ง…');
        try {
          ctl = await patchDesired(bot.id, (n) => {
            for (const k of Object.keys(v)) if ((v[k] ?? null) !== (base[k] ?? (k === 'note' ? '' : null))) n.control[k] = v[k];
          });
          toast('ส่งคำสั่งแล้ว รอเครื่องรับคำสั่ง', 'good');
          drawAll();
        } catch (ex) { busy(save, false); err.textContent = errText(ex); }
      },
    },
    h('div', { class: 'field' }, h('span', { class: 'label' }, 'โหมด'), modeSeg),
    h('fieldset', { class: 'field checks' }, h('legend', null, 'ฝั่งที่เปิดได้'),
      h('label', { class: 'check' }, longIn, 'ซื้อ (BUY)'), h('label', { class: 'check' }, shortIn, 'ขาย (SELL)')),
    h('div', { class: 'grid-2 tight' },
      field('ล็อต', lotsIn, { hint: cap.lots !== null ? `ว่าง = ตาม EA ลดได้อย่างเดียว ไม่เกิน ${fmtNum(cap.lots)}` : 'ว่าง = ตาม EA (ลดได้อย่างเดียว)' }),
      field('สเปรดสูงสุด ($)', spreadIn, { hint: cap.spread !== null ? `ว่าง = ตาม EA (${fmtNum(cap.spread)}) ตั้งได้เข้มกว่าเท่านั้น` : 'ว่าง = ตาม EA' })),
    field('หมายเหตุ', noteIn, { hint: 'ไปอยู่ในไฟล์ควบคุมและบันทึกของ EA' }),
    err, h('div', { class: 'row gap' }, save, reset));
    formBox.replaceChildren(panel('คำสั่งทั่วไป', {}, form));
  }

  // ---------------- blackouts
  function drawBlackouts() {
    const d = normDesired(ctl.desired);
    const now = Date.now();
    const list = d.blackouts.map((b, i) => ({ ...b, i, from: Date.parse(b.from_utc), to: Date.parse(b.to_utc) })).sort((a, b) => a.from - b.from);
    const past = list.filter((b) => b.to <= now);
    const item = (b) => {
      const state = b.to <= now ? 'ผ่านไปแล้ว' : b.from <= now ? 'กำลังงดเข้าไม้' : until(b.from);
      const sameDay = fmtThai(b.from, 'date') === fmtThai(b.to, 'date');
      return h('li', { class: `bo ${b.to <= now ? 'past' : b.from <= now ? 'active' : ''}` },
        h('div', { class: 'bo-main' },
          h('p', { class: 'bo-time' }, `${fmtThai(b.from, 'short')} ถึง ${fmtThai(b.to, sameDay ? 'time' : 'short')}`),
          h('p', { class: 'muted small' }, b.label || 'ไม่มีชื่อ', ' ', h('span', null, `(เซิร์ฟเวอร์ ${utcToServer(b.from, off())} ถึง ${utcToServer(b.to, off()).slice(11)})`))),
        h('span', { class: `chip ${b.from <= now && b.to > now ? 'warn' : ''}` }, state),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': `ลบช่วง ${fmtThai(b.from, 'short')}`, onclick: () => removeBo(b) }, icon('trash')));
    };
    const upcoming = news.filter((n) => NEWS_RE.test(n.name) && Date.parse(n.ts_utc) > now - 90 * MIN).slice(0, 12);
    const newsSel = h('select', { class: 'input select', 'aria-label': 'เลือกข่าว' },
      upcoming.length ? upcoming.map((n) => h('option', { value: String(n.id) }, `${n.name} ${fmtThai(Date.parse(n.ts_utc), 'short')}`)) : h('option', { value: '' }, 'ไม่มีข่าว NFP / CPI / FOMC ที่จะถึง'));
    const fromIn = h('input', { class: 'input', type: 'datetime-local', value: utcToThaiInput(Math.ceil(now / (15 * MIN)) * 15 * MIN) });
    const toIn = h('input', { class: 'input', type: 'datetime-local', value: utcToThaiInput(Math.ceil(now / (15 * MIN)) * 15 * MIN + 2 * 3600e3) });
    const labelIn = h('input', { class: 'input', type: 'text', maxlength: 60, placeholder: 'เช่น ประชุม FOMC' });
    const err = h('p', { class: 'field-error', role: 'alert' });
    const serverHint = h('p', { class: 'hint' });
    const updHint = () => {
      const a = thaiInputToUtc(fromIn.value), b = thaiInputToUtc(toIn.value);
      serverHint.textContent = Number.isFinite(a) && Number.isFinite(b) ? `เวลาเซิร์ฟเวอร์: ${utcToServer(a, off())} ถึง ${utcToServer(b, off())}` : '';
    };
    fromIn.addEventListener('input', updHint); toIn.addEventListener('input', updHint); updHint();
    const applied = (st && st.control && st.control.blackouts) || [];
    boBox.replaceChildren(panel('ช่วงงดเข้าไม้', { sub: 'ใส่เป็นเวลาไทย ระบบเก็บเป็น UTC และเอเจนต์แปลงเป็นเวลาเซิร์ฟเวอร์ให้ EA' },
      list.length ? h('ul', { class: 'bo-list' }, list.map(item)) : h('p', { class: 'muted' }, 'ยังไม่มีช่วงงดเข้าไม้'),
      past.length ? h('button', { class: 'btn small ghost', type: 'button', onclick: () => clearPast() }, icon('trash'), `ล้างช่วงที่ผ่านไปแล้ว (${past.length})`) : null,
      h('div', { class: 'subpanel' },
        h('h3', null, 'งดช่วงข่าว (ก่อน 30 นาที หลัง 90 นาที)'),
        h('div', { class: 'row gap wrap' }, newsSel, h('button', {
          class: 'btn', type: 'button', disabled: !upcoming.length,
          onclick: (e) => {
            const n = upcoming.find((x) => String(x.id) === newsSel.value);
            if (n) addBo(Date.parse(n.ts_utc) - 30 * MIN, Date.parse(n.ts_utc) + 90 * MIN, n.name, e.currentTarget);
          },
        }, icon('plus'), 'เพิ่ม')),
        h('a', { class: 'small', href: '#/news' }, 'ดูข่าวทั้งหมด')),
      h('form', {
        class: 'subpanel stack',
        onsubmit: (e) => {
          e.preventDefault();
          err.textContent = '';
          const a = thaiInputToUtc(fromIn.value), b = thaiInputToUtc(toIn.value);
          if (!Number.isFinite(a) || !Number.isFinite(b)) { err.textContent = 'เลือกเวลาเริ่มและเวลาจบ'; return; }
          if (b <= a) { err.textContent = 'เวลาจบต้องหลังเวลาเริ่ม'; return; }
          if (b <= Date.now()) { err.textContent = 'ช่วงนี้ผ่านไปแล้ว'; return; }
          if (b - a > 7 * 864e5) { err.textContent = 'ช่วงเดียวยาวได้ไม่เกิน 7 วัน (ถ้าจะหยุดนานกว่านั้นใช้ "หยุดชั่วคราว")'; return; }
          addBo(a, b, labelIn.value.trim() || 'กำหนดเอง', e.submitter);
        },
      },
      h('h3', null, 'กำหนดเอง (เวลาไทย)'),
      h('div', { class: 'grid-2 tight' }, field('เริ่ม', fromIn), field('จบ', toIn)), serverHint,
      field('ชื่อ', labelIn), err,
      h('div', { class: 'row gap wrap' },
        h('button', { class: 'btn', type: 'submit' }, icon('plus'), 'เพิ่มช่วงนี้'),
        h('button', { class: 'btn ghost', type: 'button', onclick: (e) => addBo(Date.now(), Date.now() + 2 * 3600e3, 'งดเข้าไม้ 2 ชม.', e.currentTarget) }, icon('clock'), 'ตั้งแต่ตอนนี้ 2 ชม.'))),
      h('details', { class: 'subpanel' }, h('summary', null, `ช่วงที่ EA ใช้อยู่ (${applied.length})`),
        applied.length ? h('ul', { class: 'plain' }, applied.map((b) => h('li', null,
          `${fmtThai(serverToUtc(b[0], off()), 'short')} ถึง ${fmtThai(serverToUtc(b[1], off()), 'short')}`, h('span', { class: 'muted small' }, ` (เซิร์ฟเวอร์ ${b[0]} ถึง ${b[1]})`))))
          : h('p', { class: 'muted small' }, 'ไม่มี'))));
  }

  async function addBo(from, to, label, btn) {
    busy(btn, true);
    try {
      ctl = await patchDesired(bot.id, (d) => {
        d.blackouts = d.blackouts.filter((b) => Date.parse(b.to_utc) > Date.now());
        d.blackouts.push({ from_utc: isoUtc(from), to_utc: isoUtc(to), label });
        d.blackouts.sort((a, b) => a.from_utc.localeCompare(b.from_utc));
      });
      toast(`เพิ่มช่วงงดเข้าไม้ ${fmtThai(from, 'short')} แล้ว`, 'good');
      drawAll();
    } catch (e) { busy(btn, false); toast(errText(e), 'error', 6000); }
  }
  async function removeBo(b) {
    try {
      ctl = await patchDesired(bot.id, (d) => { d.blackouts = d.blackouts.filter((x) => !(x.from_utc === b.from_utc && x.to_utc === b.to_utc)); });
      toast('ลบช่วงงดเข้าไม้แล้ว', 'good');
      drawAll();
    } catch (e) { toast(errText(e), 'error', 6000); }
  }
  async function clearPast() {
    try {
      ctl = await patchDesired(bot.id, (d) => { d.blackouts = d.blackouts.filter((x) => Date.parse(x.to_utc) > Date.now()); });
      drawAll();
    } catch (e) { toast(errText(e), 'error', 6000); }
  }

  // ---------------- web params
  function drawParams(force) {
    const d = normDesired(ctl.desired);
    const r = st && st.remote;
    if (!changed('params', [d.params, r && { ...r, effective: null }]) && force !== true) return;
    const keys = d.params ? Object.keys(d.params) : [];
    paramsBox.replaceChildren(panel('ค่าพรีเซ็ตจากเว็บ', { sub: 'ใช้กับ EA v3.04 ที่ตั้ง InpRemoteParams = true และเครื่องที่อนุญาต --allow-params on' },
      d.params ? h('p', null, `ส่งค่าไว้ ${keys.length} ค่า (จาก ${REMOTE_KEYS.length} ค่าที่ส่งได้)`) : h('p', { class: 'muted' }, 'ไม่ได้ส่งค่าพรีเซ็ต EA ใช้ค่าจาก Inputs/.set ที่เครื่อง'),
      r ? kv([
        ['EA รับค่าจากเว็บ', onOff(r.params_enabled)],
        ['EA ให้เว็บเปิด/ปิดเทรดจริง', onOff(r.live_enabled)],
        ['ไฟล์ remote', r.file_exists ? `มี (v${r.version ?? '—'})` : 'ยังไม่มี'],
        ['EA ใช้ค่ารุ่น', r.applied_version ?? '—'],
        r.pending ? ['สถานะ', h('span', { class: 'chip pending' }, `รอ: ${r.waiting === 'open position' ? 'มีไม้เปิดอยู่' : r.waiting === 'pending order' ? 'มีคำสั่งรอ' : r.waiting || 'รอ'}`)] : null,
        r.ceilings ? ['เพดานของ EA', `ล็อต ${fmtNum(r.ceilings.max_lots)} จุดหยุดรายวัน ${fmtNum(r.ceilings.max_cap_pct, 1)}%`] : null,
      ]) : h('p', { class: 'muted small' }, 'EA บนเครื่องนี้ไม่รายงานส่วน remote (ต้องเป็น v3.04) ค่าพรีเซ็ตจากเว็บจะยังไม่มีผล'),
      h('div', { class: 'row gap wrap' },
        h('a', { class: 'btn', href: '#/presets' }, icon('doc'), 'เลือกพรีเซ็ตเพื่อส่ง'),
        d.params ? h('button', {
          class: 'btn ghost', type: 'button',
          onclick: async (e) => {
            const ok = await confirmDialog('หยุดส่งค่าพรีเซ็ตจากเว็บ?', 'เอเจนต์จะไม่เขียนค่าพรีเซ็ตลงไฟล์ remote อีก ค่าที่ EA ใช้อยู่ไม่ถูกเปลี่ยนทันที', { ok: 'หยุดส่งค่า' });
            if (!ok) return;
            busy(e.currentTarget, true);
            try { ctl = await patchDesired(bot.id, (n) => { n.params = null; }); toast('หยุดส่งค่าพรีเซ็ตแล้ว', 'good'); drawAll(); } catch (ex) { busy(e.currentTarget, false); toast(errText(ex), 'error'); }
          },
        }, 'หยุดส่งค่าพรีเซ็ต') : null)));
  }

  // ---------------- limits + manage
  function drawLimits(force) {
    const lim = bot.agent_state && bot.agent_state.limits;
    if (!changed('limits', lim || null) && force !== true) return;
    limitsBox.replaceChildren(panel('ขีดจำกัดของเครื่อง', { sub: 'ตั้งที่เครื่องเท่านั้น เว็บเกินค่านี้ไม่ได้' },
      lim ? kv([
        ['ควบคุมจากเว็บ', onOff(lim.allow_remote_control, 'อนุญาต', 'ไม่อนุญาต')],
        ['เปิดเทรดจริงจากเว็บ', onOff(lim.allow_remote_live, 'อนุญาต', 'ไม่อนุญาต')],
        ['ส่งพรีเซ็ตจากเว็บ', onOff(lim.allow_remote_params, 'อนุญาต', 'ไม่อนุญาต')],
        ['เพดานล็อต', fmtNum(lim.max_lots)],
        ['เพดานจุดหยุดรายวัน', `${fmtNum(lim.max_daily_cap_pct, 1)}%`],
      ]) : h('p', { class: 'muted' }, 'เอเจนต์ยังไม่ได้รายงานขีดจำกัด'),
      h('p', { class: 'muted small' }, 'เปลี่ยนที่เครื่องด้วยคำสั่ง เช่น'),
      cmdBlock('python dobby_agent.py limits --allow-live on --max-lots 0.10')));
  }

  function drawManage() {
    const nameIn = h('input', { class: 'input', type: 'text', maxlength: 100, value: bot.name, required: true });
    const err = h('p', { class: 'field-error', role: 'alert' });
    const save = h('button', { class: 'btn', type: 'submit' }, 'บันทึกชื่อ');
    manageBox.replaceChildren(panel('จัดการบอท', {},
      h('form', {
        class: 'stack',
        onsubmit: async (e) => {
          e.preventDefault();
          err.textContent = '';
          const n = nameIn.value.trim();
          if (!n) { err.textContent = 'ใส่ชื่อบอท'; return; }
          busy(save, true);
          try { const row = await ctx.api.renameBot(bot.id, n); bot = { ...bot, ...row }; updateBotRow(bot); await loadBots(); toast('เปลี่ยนชื่อแล้ว', 'good'); drawHead(); busy(save, false); }
          catch (ex) { busy(save, false); err.textContent = errText(ex); }
        },
      }, field('ชื่อบอท', nameIn), err, save),
      h('div', { class: 'danger-zone' },
        h('p', null, h('strong', null, 'ลบบอทนี้จากเว็บ')),
        h('p', { class: 'muted small' }, 'ลบสถานะ บันทึก และคำสั่งของบอทนี้ในฐานข้อมูลถาวร บอทบนเครื่องยังทำงานต่อ แต่เอเจนต์จะส่งข้อมูลไม่ได้จนกว่าจะ register ใหม่'),
        h('button', {
          class: 'btn danger', type: 'button',
          onclick: async () => {
            const ok = await confirmDialog(`ลบ "${bot.name}" ถาวร?`, 'ประวัติและคำสั่งทั้งหมดของบอทนี้ในเว็บจะถูกลบและกู้คืนไม่ได้ บอทบนเครื่องไม่หยุดทำงาน', { ok: 'ลบถาวร', danger: true });
            if (!ok) return;
            try { await ctx.api.deleteBot(bot.id); toast('ลบบอทแล้ว', 'good'); await loadBots(); ctx.nav('#/dashboard'); }
            catch (ex) { toast(errText(ex), 'error', 6000); }
          },
        }, icon('trash'), 'ลบบอท'))));
  }

  function drawAll() { drawHead(); drawStatus(true); drawLive(true); drawForm(); drawBlackouts(); drawParams(true); drawLimits(true); drawManage(); }
  drawAll();

  const unsub = ctx.api.subscribeBot(bot.id, {
    status: (row) => { st = row.status; drawHead(); drawStatus(); drawLive(); drawParams(); },
    control: (row) => { ctl = row; drawStatus(); drawLive(); },
    bot: (row) => { bot = { ...bot, ...row }; updateBotRow(bot); drawHead(); drawStatus(); drawLive(); drawLimits(); },
  });
  const offCtl = on('control-updated', (row) => { if (row && row.bot_id === bot.id) { ctl = row; drawStatus(); drawLive(); drawBlackouts(); drawParams(); } });
  const tick = setInterval(() => { drawHead(); }, 10000);
  return () => { unsub(); offCtl(); clearInterval(tick); };
}
