// เครื่องของฉัน: one card per bot (status, last seen, EA version, rename, delete from the website, set as default).
// bots.name update and bots delete are allowed to the owner by RLS (delete cascades bot_status/journal/bot_control).
import { h, mount, icon, fmtNum, fmtThai, ago, toast, errText, openModal, errorState, loadingState, field, busy, callout, newId } from '../util.js';
import { app, loadBots, selectBot, updateBotRow, defaultBotId, setDefaultBot } from '../state.js';
import { onlineInfo, normDesired } from '../botctl.js';
import { pageHead, noBotState } from '../views.js';

export async function render(root, ctx) {
  root.append(pageHead('เครื่องของฉัน', 'คอมทุกเครื่องที่เชื่อมกับเว็บนี้ เปลี่ยนชื่อ เลือกบอทหลัก หรือลบออกจากเว็บ', null, 'machines'));
  const listBox = h('div', { class: 'machines' });
  root.append(listBox);
  listBox.append(loadingState());
  const data = {}; // botId -> {st, ctl}

  async function loadAll() {
    await loadBots();
    await Promise.all(app.bots.map(async (b) => {
      const [s, c] = await Promise.all([ctx.api.botStatus(b.id).catch(() => null), ctx.api.botControl(b.id).catch(() => null)]);
      data[b.id] = { st: s ? s.status : null, ctl: c };
    }));
  }
  try { await loadAll(); } catch (e) { mount(listBox, errorState(e, () => ctx.route())); return; }

  function draw() {
    if (!app.bots.length) { mount(listBox, noBotState()); return; }
    const def = defaultBotId() && app.bots.some((b) => b.id === defaultBotId()) ? defaultBotId() : (app.bots.length === 1 ? app.bots[0].id : '');
    mount(listBox, 
      h('div', { class: 'machine-grid' }, app.bots.map((b) => card(b, b.id === def))),
      h('section', { class: 'add-machine' },
        h('span', { class: 'add-ico' }, icon('plus')),
        h('div', { class: 'grow' }, h('h2', null, 'เพิ่มเครื่องใหม่'),
          h('p', { class: 'muted' }, 'โหลดแอป Dobby ไปเปิดที่คอมเครื่องใหม่ เข้าสู่ระบบด้วยบัญชีนี้ แล้วทำตามตัวช่วย เครื่องจะขึ้นที่นี่เอง')),
        h('a', { class: 'btn', href: '#/downloads' }, icon('download'), 'ดาวน์โหลดแอป')));
  }

  function card(b, isDefault) {
    const { st, ctl } = data[b.id] || {};
    const info = onlineInfo(b, st);
    const d = normDesired(ctl && ctl.desired);
    const acc = (st && st.account) || {};
    const ver = (st && st.ea_version) || b.ea_version || '';
    const old = ver && parseFloat(ver) < 3.04;
    const tone = info.online ? 'good' : info.agentOnline ? 'warn' : 'off';
    const statusText = info.online ? 'ออนไลน์' : info.agentOnline ? 'MT5 ไม่ตอบ' : Number.isFinite(info.seenAge) ? 'ออฟไลน์' : 'ยังไม่เคยเชื่อมต่อ';
    const live = !!d.live && d.control.mode !== 'pause';
    return h('article', { class: `machine tone-${tone}${b.id === app.botId ? ' current' : ''}` },
      h('div', { class: 'machine-head' },
        h('span', { class: 'machine-ico' }, icon('monitor')),
        h('div', { class: 'grow' },
          h('h2', { class: 'machine-name' }, b.name),
          h('p', { class: 'machine-status' }, h('span', { class: 'dot', 'aria-hidden': 'true' }), statusText,
            h('span', { class: 'muted' }, ` · เห็นล่าสุด ${b.last_seen ? ago(Date.parse(b.last_seen)) : 'ไม่เคย'}`))),
        isDefault ? h('span', { class: 'chip live' }, icon('star'), 'บอทหลัก') : null),
      h('dl', { class: 'machine-facts' },
        h('div', null, h('dt', null, 'รุ่น EA'), h('dd', null, ver ? `v${ver}` : '—', old ? h('span', { class: 'chip warn' }, 'อัปเดตได้') : null)),
        h('div', null, h('dt', null, 'เทรดจริง'), h('dd', null, live ? h('span', { class: 'good-text' }, 'เปิด') : 'ปิด')),
        h('div', null, h('dt', null, 'บัญชี'), h('dd', null, acc.balance != null ? `${acc.mode === 'REAL' ? 'จริง' : acc.mode || ''} ${fmtNum(acc.balance)} ${acc.currency || ''}`.trim() : '—')),
        h('div', null, h('dt', null, 'แอป Dobby'), h('dd', null, b.agent_version ? `v${b.agent_version}` : '—')),
        h('div', null, h('dt', null, 'สัญลักษณ์'), h('dd', null, (st && st.symbol) || b.symbol || '—')),
        h('div', null, h('dt', null, 'เชื่อมเมื่อ'), h('dd', null, b.created_at ? fmtThai(Date.parse(b.created_at), 'date') : '—'))),
      old ? h('p', { class: 'hint' }, 'รุ่นนี้เปลี่ยนค่าจากเว็บไม่ได้ อัปเดตเป็น 3.04 ได้จากหน้า ', h('a', { href: '#/bot' , onclick: (e) => { e.preventDefault(); openBot(b, '#/bot'); } }, 'ตั้งค่าบอท')) : null,
      h('div', { class: 'machine-actions' },
        h('button', { class: 'btn small', type: 'button', onclick: () => openBot(b, '#/dashboard') }, icon('home'), 'ดูภาพรวม'),
        h('button', { class: 'btn small', type: 'button', onclick: () => openBot(b, '#/bot') }, icon('sliders'), 'ตั้งค่าบอท'),
        h('button', { class: 'btn small ghost', type: 'button', onclick: () => renameDialog(b) }, icon('edit'), 'เปลี่ยนชื่อ'),
        isDefault ? null : h('button', { class: 'btn small ghost', type: 'button', onclick: () => { setDefaultBot(b.id); selectBot(b.id); toast(`ตั้ง "${b.name}" เป็นบอทหลักแล้ว เปิดเว็บครั้งหน้าจะเห็นบอทนี้ก่อน`, 'good'); draw(); } }, icon('star'), 'ตั้งเป็นบอทหลัก'),
        h('button', { class: 'btn small ghost danger-text', type: 'button', onclick: () => deleteDialog(b, live) }, icon('trash'), 'ลบออกจากเว็บ')));
  }

  function openBot(b, hash) {
    if (b.id !== app.botId) selectBot(b.id);
    ctx.nav(hash);
  }

  function renameDialog(b) {
    const nameIn = h('input', { class: 'input', type: 'text', maxlength: 100, value: b.name, required: true });
    const err = h('p', { class: 'field-error', role: 'alert' });
    const fid = newId('rn');
    const m = openModal({
      title: 'เปลี่ยนชื่อเครื่อง',
      body: h('form', {
        id: fid, class: 'stack',
        onsubmit: async (e) => {
          e.preventDefault();
          const n = nameIn.value.trim();
          if (!n) { err.textContent = 'ใส่ชื่อเครื่อง'; return; }
          const btn = m.foot.querySelector('button[type=submit]');
          busy(btn, true);
          try {
            const row = await ctx.api.renameBot(b.id, n);
            updateBotRow({ ...b, ...row });
            await loadBots();
            m.close();
            toast('เปลี่ยนชื่อแล้ว', 'good');
            draw();
          } catch (ex) { busy(btn, false); err.textContent = errText(ex); }
        },
      }, field('ชื่อที่จะเห็นในเว็บ', nameIn, { hint: 'เช่น คอมที่บ้าน หรือ โน้ตบุ๊ก (ชื่อในแอปที่เครื่องไม่เปลี่ยน)' }), err),
      actions: [{ label: 'ยกเลิก' }, { label: 'บันทึกชื่อ', kind: 'primary', submit: true, form: fid, icon: 'check' }],
    });
    setTimeout(() => nameIn.select(), 30);
  }

  function deleteDialog(b, live) {
    const agree = h('input', { type: 'checkbox' });
    const m = openModal({
      title: `ลบ "${b.name}" ออกจากเว็บ?`,
      body: h('div', { class: 'stack' },
        h('p', null, 'การลบนี้เอาเครื่องออกจาก ', h('strong', null, 'เว็บนี้เท่านั้น'), ' อ่านก่อนกด:'),
        h('ul', { class: 'explain-list' },
          h('li', null, icon('trash'), h('span', null, 'เครื่องนี้จะหายจากเว็บ พร้อมประวัติการเทรด สถานะ และคำสั่งที่เก็บไว้ในเว็บ ', h('strong', null, 'กู้คืนไม่ได้'))),
          h('li', null, icon('monitor'), h('span', null, h('strong', null, 'ไม่ได้หยุดบอทที่คอมเครื่องนั้น: '), 'EA ใน MT5 ยังเทรดต่อตามค่าล่าสุด ถ้าจะหยุดเทรด ให้ปิดที่ MT5 หรือปิดเทรดจริงก่อนลบ')),
          h('li', null, icon('refresh'), h('span', null, 'แอป Dobby ที่เครื่องนั้นจะส่งข้อมูลขึ้นเว็บไม่ได้อีก ถ้าจะกลับมาดูที่เว็บ ต้อง ', h('strong', null, 'เชื่อมเครื่องใหม่'), ' ในแอป (ตัวช่วยตั้งค่า → ตั้งชื่อเครื่อง)'))),
        live ? callout('warn', 'เครื่องนี้ยังเปิดเทรดจริงอยู่', h('p', null, 'ถ้าต้องการให้หยุดเทรด ปิดสวิตช์เทรดจริงในหน้าตั้งค่าบอทก่อน แล้วรอให้เครื่องรับคำสั่ง จากนั้นค่อยลบ')) : null,
        h('label', { class: 'check agree' }, agree, 'เข้าใจแล้ว: ลบจากเว็บเท่านั้น ต้องเชื่อมเครื่องใหม่ถ้าจะใช้อีก')),
      actions: [{ label: 'ยกเลิก' }, { label: 'ลบออกจากเว็บ', kind: 'danger', icon: 'trash', disabled: true, onClick: async () => {
        const btn = m.foot.querySelector('.btn.danger');
        busy(btn, true, 'กำลังลบ…');
        try {
          await ctx.api.deleteBot(b.id);
          if (defaultBotId() === b.id) setDefaultBot('');
          delete data[b.id];
          m.close();
          await loadBots();
          toast(`ลบ "${b.name}" ออกจากเว็บแล้ว`, 'good');
          draw();
        } catch (ex) { busy(btn, false); toast(errText(ex), 'error', 6000); }
      } }],
    });
    agree.addEventListener('change', () => { const btn = m.foot.querySelector('.btn.danger'); if (btn) btn.disabled = !agree.checked; });
  }

  draw();
  // live-ish: refresh the cards every 15 s (last seen, online state)
  const subs = app.bots.map((b) => ctx.api.subscribeBot(b.id, { bot: (row) => { updateBotRow(row); } }));
  const tick = setInterval(async () => {
    try { await loadAll(); draw(); } catch { /* keep */ }
  }, 15000);
  return () => { subs.forEach((u) => u()); clearInterval(tick); };
}
