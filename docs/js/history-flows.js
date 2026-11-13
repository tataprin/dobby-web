// ประวัติ > เงินฝาก-ถอน (SPEC 9.2): suggestions from the agent to confirm or dismiss ("เทรดมือ / ไม่ใช่เงินฝาก"), manual
// rows to add, edit and delete, totals, and after a confirmed flow the offer to raise or lower the bot's starting capital
// (desired.params.InpVirtualStart, sent like any other setting, with the version check) with the SPEC 7.3 lot for it.
import { h, mount, icon, fmtNum, fmtThai, money, toast, errText, confirmDialog, openModal, field, busy, callout, newId,
  utcToThaiInput, thaiInputToUtc, isoUtc } from './util.js';
import { flowTotals, sinceStart } from './analytics.js';
import { botPnlOf } from './rounds.js';
import { normDesired, patchDesired } from './botctl.js';
import { currentValues, autoLot, mainLot, toDesiredParams } from './simple.js';
import { normalizeParams } from './params.js';
import { panel, segmented } from './views.js';

// ctx: { api, bot, ro, st, flows, reload(): Promise, offsetMin }
export function flowsView(c) {
  const { bot, ro, st } = c;
  const cur = (st && st.account && st.account.currency) || 'USD';
  const flows = c.flows || [];
  const sug = flows.filter((f) => f.status === 'suggested').sort((a, b) => b.ts.localeCompare(a.ts));
  const conf = flows.filter((f) => f.status === 'confirmed').sort((a, b) => b.ts.localeCompare(a.ts));
  const dism = flows.filter((f) => f.status === 'dismissed').sort((a, b) => b.ts.localeCompare(a.ts));
  const tot = flowTotals(flows);
  const since = sinceStart(st, flows, c.offsetMin);
  const box = h('div', { class: 'stack-lg' });
  const fig = (label, value, foot) => h('div', { class: 'fig' }, h('p', { class: 'fig-label' }, label), h('p', { class: 'fig-value' }, value), h('div', { class: 'fig-foot' }, foot));
  const kind = (a) => (Number(a) >= 0 ? 'ฝาก' : 'ถอน');
  const when = (f) => fmtThai(Date.parse(f.ts), 'datetime');

  const actionBtn = (label, ic, cls, fn) => h('button', { class: `btn small ${cls}`.trim(), type: 'button', onclick: (e) => fn(e.currentTarget) }, ic ? icon(ic) : null, label);
  const sugItem = (f) => h('li', { class: 'flow sug' },
    h('div', { class: 'flow-main' },
      h('p', { class: 'flow-title' }, `ยอดเงินในบัญชี${Number(f.amount) >= 0 ? 'เพิ่มขึ้น' : 'ลดลง'} `, money(f.amount, { signed: true, unit: cur })),
      h('p', { class: 'muted small' }, `${when(f)} น.`, f.balance_after !== null && f.balance_after !== undefined ? ` ยอดหลังเปลี่ยน ${fmtNum(f.balance_after)}` : '', ' ไม่ได้มาจากไม้ของ Dobby')),
    ro ? h('span', { class: 'chip pending' }, 'รอเจ้าของยืนยัน') : h('div', { class: 'flow-actions' },
      actionBtn(Number(f.amount) >= 0 ? 'ยืนยันว่าเป็นเงินฝาก' : 'ยืนยันว่าเป็นการถอน', 'check', 'primary', (b) => setStatus(f, 'confirmed', b)),
      actionBtn('เทรดมือ / ไม่ใช่เงินฝาก', null, '', (b) => setStatus(f, 'dismissed', b))));
  const confItem = (f) => h('li', { class: 'flow' },
    h('div', { class: 'flow-main' },
      h('p', { class: 'flow-title' }, h('span', { class: `chip ${Number(f.amount) >= 0 ? 'good' : ''}` }, kind(f.amount)), ' ', f.note && f.note !== AUTO_NOTE ? f.note : (f.source === 'auto' ? 'ตรวจพบอัตโนมัติ' : 'เพิ่มเอง')),
      h('p', { class: 'muted small' }, `${when(f)} น.`, f.source === 'auto' ? ' ตรวจพบอัตโนมัติ' : ' เพิ่มเอง')),
    h('span', { class: 'flow-amt' }, money(f.amount, { signed: true, unit: cur })),
    ro ? null : h('div', { class: 'flow-actions' },
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': `แก้ไขรายการ ${when(f)}`, title: 'แก้ไข', onclick: () => editDialog(f) }, icon('edit')),
      f.source === 'manual'
        ? h('button', { class: 'icon-btn', type: 'button', 'aria-label': `ลบรายการ ${when(f)}`, title: 'ลบ', onclick: () => del(f) }, icon('trash'))
        : h('button', { class: 'icon-btn', type: 'button', 'aria-label': `ไม่ใช่เงินฝาก ${when(f)}`, title: 'ไม่ใช่เงินฝาก (ย้ายไปรายการที่ปัดตก)', onclick: (e) => setStatus(f, 'dismissed', e.currentTarget) }, icon('x'))));
  const dismItem = (f) => h('li', { class: 'flow' },
    h('div', { class: 'flow-main' }, h('p', { class: 'flow-title' }, money(f.amount, { signed: true, unit: cur })), h('p', { class: 'muted small' }, `${when(f)} น. ไม่นับเป็นเงินฝาก-ถอน (เช่น เทรดมือ)`)),
    ro ? null : h('div', { class: 'flow-actions' }, actionBtn('กู้คืน', 'refresh', 'ghost', (b) => setStatus(f, 'suggested', b))));

  mount(box,
    h('section', { class: 'figs', 'aria-label': 'สรุปเงินฝาก-ถอน' },
      fig('ฝากเข้า', money(tot.deposits, { unit: cur }), h('p', null, `${conf.filter((f) => Number(f.amount) > 0).length} รายการที่ยืนยันแล้ว`)),
      fig('ถอนออก', money(Math.abs(tot.withdrawals), { unit: cur }), h('p', null, `${conf.filter((f) => Number(f.amount) < 0).length} รายการที่ยืนยันแล้ว`)),
      fig('เงินฝากสุทธิ', money(tot.net, { signed: true, unit: cur }), h('p', null, sug.length ? `รอยืนยันอีก ${sug.length} รายการ` : 'ไม่มีรายการรอยืนยัน')),
      fig('กำไรจากการเทรด', since ? money(since.pnl, { signed: true, unit: cur }) : '—',
        h('p', null, since ? ['ตั้งแต่เริ่ม ไม่นับเงินฝาก-ถอน', since.pct !== null ? [' (', h('span', { class: 'num' }, `${since.pct >= 0 ? '+' : '−'}${fmtNum(Math.abs(since.pct), 1)}%`), ')'] : ''] : 'ยังไม่มีสถานะจากบอท'))),
    sug.length ? panel('รอยืนยัน', { sub: 'ยอดเงินในบัญชีเปลี่ยนโดยไม่ได้มาจากไม้ของ Dobby แอปที่เครื่องตรวจพบ ช่วยบอกว่าเป็นเงินฝาก-ถอนหรือไม่' },
      h('ul', { class: 'flow-list' }, sug.map(sugItem))) : null,
    panel('เงินฝาก-ถอนที่ยืนยันแล้ว', { actions: ro ? null : h('button', { class: 'btn small', type: 'button', onclick: () => editDialog(null) }, icon('plus'), 'เพิ่มรายการ'),
      sub: 'ไม่นับเป็นกำไรขาดทุนของบอท ใช้ถ่วงทุนเวลาคิดผลตอบแทนเป็น %' },
    conf.length ? h('ul', { class: 'flow-list' }, conf.map(confItem)) : h('p', { class: 'muted' }, ro ? 'ยังไม่มีรายการ' : 'ยังไม่มีรายการ ถ้าฝากหรือถอนเงินจากบัญชีเทรด กด "เพิ่มรายการ" หรือรอแอปที่เครื่องตรวจพบเอง'),
    dism.length ? h('details', { class: 'table-view' }, h('summary', null, `ที่บอกว่าไม่ใช่เงินฝาก-ถอน (${dism.length})`), h('ul', { class: 'flow-list' }, dism.map(dismItem))) : null),
    callout('info', 'กำไรจากการเทรดคิดอย่างไร',
      h('p', null, 'นับเฉพาะกำไรขาดทุนจากไม้ของ Dobby (ยอดเงินที่เปลี่ยนไป หักเงินฝาก-ถอนออก) เงินที่ฝากเข้าหรือถอนออกจึงไม่ทำให้ดูเหมือนกำไรหรือขาดทุน'),
      h('p', null, '% ต่อเดือนและตั้งแต่เริ่มคิดแบบ modified Dietz: เงินฝากนับเป็นทุนเฉพาะช่วงเวลาที่อยู่ในบัญชี')));

  async function setStatus(f, status, btn) {
    busy(btn, true);
    try {
      await c.api.updateCashFlow(bot.id, f.id, { status });
      toast(status === 'confirmed' ? 'ยืนยันแล้ว' : status === 'dismissed' ? 'ย้ายไปรายการที่ไม่ใช่เงินฝาก-ถอนแล้ว' : 'กู้คืนเป็นรายการรอยืนยันแล้ว', 'good');
      await c.reload();
      if (status === 'confirmed') offerAdjust(Number(f.amount));
    } catch (e) { busy(btn, false); toast(errText(e), 'error', 6000); }
  }

  async function del(f) {
    const ok = await confirmDialog('ลบรายการนี้?', `${kind(f.amount)} ${fmtNum(Math.abs(f.amount))} ${cur} เมื่อ ${when(f)} น. ทุนของบอทไม่ถูกเปลี่ยน`, { ok: 'ลบ', danger: true });
    if (!ok) return;
    try { await c.api.deleteCashFlow(bot.id, f.id); toast('ลบแล้ว', 'good'); await c.reload(); } catch (e) { toast(errText(e), 'error', 6000); }
  }

  function editDialog(f) {
    let type = f ? (Number(f.amount) >= 0 ? 'in' : 'out') : 'in';
    const seg = segmented({ label: 'รายการ', wide: true, get: () => type, set: (v) => { type = v; seg.update(); }, options: [{ value: 'in', label: 'ฝากเข้า' }, { value: 'out', label: 'ถอนออก' }] });
    const amt = h('input', { class: 'input', type: 'number', inputmode: 'decimal', step: '0.01', min: '0.01', required: true, value: f ? Math.abs(Number(f.amount)) : '' });
    const when0 = f ? Date.parse(f.ts) : Date.now();
    const at = h('input', { class: 'input', type: 'datetime-local', required: true, value: utcToThaiInput(when0) });
    const note = h('input', { class: 'input', type: 'text', maxlength: 120, value: f && f.note && f.note !== AUTO_NOTE ? f.note : '', placeholder: 'เช่น โอนเพิ่มจากบัญชีออมทรัพย์' });
    const err = h('p', { class: 'field-error', role: 'alert' });
    const fid = newId('flow');
    const m = openModal({
      title: f ? 'แก้ไขรายการ' : 'เพิ่มเงินฝาก-ถอน',
      body: h('form', {
        id: fid, class: 'stack',
        onsubmit: async (e) => {
          e.preventDefault();
          err.textContent = '';
          const a = Number(amt.value), t = thaiInputToUtc(at.value);
          if (!(a > 0)) { err.textContent = 'ใส่จำนวนเงินมากกว่า 0'; return; }
          if (!Number.isFinite(t)) { err.textContent = 'เลือกวันเวลา'; return; }
          if (t > Date.now() + 60000) { err.textContent = 'วันเวลาต้องไม่อยู่ในอนาคต'; return; }
          const amount = Math.round((type === 'in' ? a : -a) * 100) / 100;
          const btn = m.foot.querySelector('button[type=submit]');
          busy(btn, true);
          try {
            if (f) await c.api.updateCashFlow(bot.id, f.id, { amount, ts: isoUtc(t), note: note.value.trim() || null });
            else await c.api.addCashFlow(bot.id, { ts: isoUtc(t), amount, note: note.value.trim() });
            m.close();
            toast(f ? 'แก้ไขแล้ว' : 'เพิ่มรายการแล้ว', 'good');
            await c.reload();
            const delta = f ? amount - Number(f.amount) : amount;
            if (Math.abs(delta) >= 0.01) offerAdjust(delta);
          } catch (ex) { busy(btn, false); err.textContent = errText(ex); }
        },
      },
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'รายการ'), seg),
      h('div', { class: 'grid-2 tight' }, field(`จำนวน (${cur})`, amt), field('วันเวลา (เวลาไทย)', at)),
      field('หมายเหตุ', note), err),
      actions: [{ label: 'ยกเลิก' }, { label: f ? 'บันทึก' : 'เพิ่มรายการ', kind: 'primary', submit: true, form: fid, icon: f ? 'check' : 'plus' }],
    });
    setTimeout(() => amt.focus(), 50);
  }

  // owner only: InpVirtualStart += amount (EA v3.04 remote params, normal version check) and the SPEC 7.3 lot for it
  async function offerAdjust(amount) {
    if (ro || !Number.isFinite(amount) || !amount) return;
    let ctl;
    try { ctl = await c.api.botControl(bot.id); } catch { return; }
    if (!ctl) return;
    const d = normDesired(ctl.desired);
    const canSend = st ? !!st.remote : parseFloat(bot.ea_version || '0') >= 3.04;
    const vals = currentValues(st, d.params).values;
    // the bot counts InpVirtualStart + its own P&L (SPEC 9.8): the dialog shows that sum, the start moves by the amount
    const pnl = botPnlOf(st);
    const now = Number(vals.InpVirtualStart) || 0;
    const next = Math.round((now + amount) * 100) / 100;
    const countNow = Math.round((now + pnl) * 100) / 100, countNext = Math.round((next + pnl) * 100) / 100;
    const lot = autoLot(countNext), curLot = mainLot(vals);
    const tooLow = next < 10;
    openModal({
      title: 'ปรับทุนของบอทด้วยไหม?',
      body: h('div', { class: 'stack' },
        h('p', null, `ทุนของบอทตอนนี้ ${fmtNum(countNow)} ${cur} ถ้ารวมรายการนี้ (${amount >= 0 ? '+' : '−'}${fmtNum(Math.abs(amount))}) จะเป็น ${fmtNum(countNext)} ${cur}`),
        h('p', { class: 'muted small' }, 'บอทใช้ทุนนี้คิดจุดหยุดรายวันและ % กำไร EA จะคำนวณประวัติใหม่ด้วยทุนใหม่ ส่วนกำไรจากการเทรดไม่เปลี่ยน'),
        h('p', null, `ถ้าใช้ล็อตอัตโนมัติจากทุน (ทุก 100 ${cur} = 0.01 ล็อต) ทุน ${fmtNum(countNext, 0)} ได้ล็อต ${fmtNum(lot)} ต่อไม้ (ตอนนี้ใช้ ${fmtNum(curLot)}) ถ้าต้องการเปลี่ยนล็อตด้วย ไปที่ตั้งค่าบอท > ตั้งให้อัตโนมัติจากทุน`),
        tooLow ? callout('warn', 'ทุนใหม่ต่ำเกินไป', h('p', null, 'ปรับทุนของบอทเองที่หน้าตั้งค่าบอทถ้าต้องการ')) : null,
        !canSend ? callout('warn', 'EA รุ่นนี้รับค่าจากเว็บไม่ได้', h('p', null, `เปลี่ยน InpVirtualStart เป็น ${next} ที่เครื่อง ${bot.name} เอง (EA v3.04 ส่งจากเว็บได้)`)) : null),
      actions: canSend && !tooLow ? [{ label: 'ไม่ต้อง' }, {
        label: `ปรับทุนเป็น ${fmtNum(countNext)}`, kind: 'primary', icon: 'check',
        onClick: async (close) => {
          try {
            await patchDesired(bot.id, (n) => {
              const base = n.params ? normalizeParams({ ...vals, ...n.params }) : normalizeParams(vals);
              base.InpVirtualStart = next;
              n.params = toDesiredParams(base, { eaVersion: (st && st.ea_version) || bot.ea_version, agentVersion: bot.agent_version });
            });
            close();
            toast(`ส่งทุน ${fmtNum(countNext)} ให้บอทแล้ว EA จะใช้เมื่อไม่มีไม้เปิด (ดูความคืบหน้าที่ตั้งค่าบอท)`, 'good', 6000);
          } catch (e) { toast(errText(e), 'error', 7000); }
        },
      }] : [{ label: 'ปิด' }],
    });
  }

  return box;
}

const AUTO_NOTE = 'balance change not explained by Dobby trades';
