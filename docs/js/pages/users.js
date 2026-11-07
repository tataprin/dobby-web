// Users (admin): admin_overview, invites (create with copy, list, revoke), set role / approve / disable.
import { h, icon, fmtThai, ago, toast, errText, confirmDialog, errorState, loadingState, emptyState, field, busy, copyText, callout } from '../util.js';
import { app } from '../state.js';
import { panel, pageHead } from '../views.js';

export async function render(root, ctx) {
  root.append(pageHead('ผู้ใช้', 'จัดการเพื่อนที่ใช้เว็บนี้ ผู้ดูแลไม่เห็นยอดเงินหรือการตั้งค่าบอทของเพื่อน', null, 'start'));
  const inviteBox = h('div'), usersBox = h('div'), invitesBox = h('div');
  root.append(h('div', { class: 'grid-2' }, inviteBox, invitesBox), usersBox);
  usersBox.append(loadingState());
  let users = [], invites = [];
  const load = async () => { [users, invites] = await Promise.all([ctx.api.adminOverview(), ctx.api.listInvites()]); };
  try { await load(); } catch (e) { usersBox.replaceChildren(errorState(e, () => ctx.route())); return; }

  // create invite
  const roleIn = h('select', { class: 'input select' }, h('option', { value: 'member' }, 'สมาชิก (member)'), h('option', { value: 'admin' }, 'ผู้ดูแล (admin)'));
  const daysIn = h('input', { class: 'input', type: 'number', min: '1', max: '365', value: '7', inputmode: 'numeric' });
  const noteIn = h('input', { class: 'input', type: 'text', maxlength: 120, placeholder: 'เช่น ชื่อเพื่อน' });
  const result = h('div', { 'aria-live': 'polite' });
  const err = h('p', { class: 'field-error', role: 'alert' });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, icon('plus'), 'สร้างรหัสเชิญ');
  inviteBox.append(panel('สร้างรหัสเชิญ', { sub: 'ส่งรหัสให้เพื่อน เพื่อนสมัครที่หน้าเข้าสู่ระบบแล้วใส่รหัสนี้' },
    h('form', {
      class: 'stack',
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        const days = Number(daysIn.value);
        if (!(days >= 1 && days <= 365)) { err.textContent = 'อายุรหัส 1 ถึง 365 วัน'; return; }
        if (roleIn.value === 'admin') {
          const ok = await confirmDialog('สร้างรหัสสำหรับผู้ดูแล?', 'คนที่ใช้รหัสนี้จะจัดการผู้ใช้และรหัสเชิญได้ทั้งหมด', { ok: 'สร้าง' });
          if (!ok) return;
        }
        busy(btn, true, 'กำลังสร้าง…');
        try {
          const code = await ctx.api.createInvite(roleIn.value, days, noteIn.value.trim());
          const msg = `รหัสเชิญ Dobby: ${code}\nสมัครที่ ${location.origin}${location.pathname}#/login?tab=signup\nรหัสหมดอายุใน ${days} วัน`;
          result.replaceChildren(callout('good', 'สร้างรหัสแล้ว',
            h('p', { class: 'invite-code' }, code),
            h('div', { class: 'row gap wrap' },
              h('button', { class: 'btn small', type: 'button', onclick: () => copyText(code, 'คัดลอกรหัสแล้ว') }, icon('copy'), 'คัดลอกรหัส'),
              h('button', { class: 'btn small', type: 'button', onclick: () => copyText(msg, 'คัดลอกข้อความเชิญแล้ว') }, icon('copy'), 'คัดลอกข้อความเชิญ'))));
          noteIn.value = '';
          await load(); drawInvites(); drawUsers();
        } catch (ex) { err.textContent = errText(ex); }
        busy(btn, false);
      },
    },
    h('div', { class: 'grid-2 tight' }, field('สิทธิ์', roleIn), field('อายุ (วัน)', daysIn)),
    field('บันทึกช่วยจำ', noteIn), err, btn, result)));

  const userName = (id) => { const u = users.find((x) => x.user_id === id); return u ? (u.display_name || u.email || id.slice(0, 8)) : id ? id.slice(0, 8) : '—'; };

  function inviteState(i) {
    if (i.revoked) return ['ยกเลิกแล้ว', 'off'];
    if (i.used_by || i.used_at) return [`ใช้แล้วโดย ${userName(i.used_by)}`, 'good'];
    if (Date.parse(i.expires_at) <= Date.now()) return ['หมดอายุ', 'off'];
    return ['ใช้ได้', 'live'];
  }

  function drawInvites() {
    const active = invites.filter((i) => inviteState(i)[0] === 'ใช้ได้');
    invitesBox.replaceChildren(panel(`รหัสเชิญ (ใช้ได้ ${active.length})`, {},
      invites.length ? h('ul', { class: 'invite-list' }, invites.map((i) => {
        const [label, tone] = inviteState(i);
        const usable = label === 'ใช้ได้';
        return h('li', { class: `invite ${usable ? '' : 'dim'}` },
          h('div', { class: 'grow' },
            h('p', null, h('code', { class: 'invite-code small' }, i.code), ' ', h('span', { class: `chip ${tone}` }, label), i.role === 'admin' ? h('span', { class: 'chip warn' }, 'admin') : null),
            h('p', { class: 'muted small' }, i.note ? `${i.note} ` : '', usable ? `หมดอายุ ${fmtThai(Date.parse(i.expires_at), 'short')}` : `สร้าง ${fmtThai(Date.parse(i.created_at), 'date')}`)),
          usable ? h('div', { class: 'row gap' },
            h('button', { class: 'icon-btn', type: 'button', 'aria-label': `คัดลอก ${i.code}`, onclick: () => copyText(i.code, 'คัดลอกรหัสแล้ว') }, icon('copy')),
            h('button', {
              class: 'btn small ghost danger-text', type: 'button',
              onclick: async () => {
                const ok = await confirmDialog(`ยกเลิกรหัส ${i.code}?`, 'รหัสนี้จะใช้สมัครไม่ได้อีก', { ok: 'ยกเลิกรหัส', danger: true });
                if (!ok) return;
                try { await ctx.api.revokeInvite(i.code); await load(); drawInvites(); toast('ยกเลิกรหัสแล้ว', 'good'); } catch (e) { toast(errText(e), 'error'); }
              },
            }, 'ยกเลิก')) : null);
      })) : h('p', { class: 'muted' }, 'ยังไม่มีรหัสเชิญ')));
  }

  function drawUsers() {
    const me = app.user && app.user.id;
    if (!users.length) { usersBox.replaceChildren(emptyState('ยังไม่มีผู้ใช้')); return; }
    usersBox.replaceChildren(panel(`ผู้ใช้ทั้งหมด (${users.length})`, { sub: 'เห็นแค่ชื่อ อีเมล และจำนวนบอท ไม่มีข้อมูลยอดเงิน' },
      h('div', { class: 'table-wrap' }, h('table', { class: 'rtable users' },
        h('thead', null, h('tr', null, ['ผู้ใช้', 'สิทธิ์', 'อนุมัติ', 'ระงับ', 'บอท', 'บอทออนไลน์ล่าสุด', 'สมัครเมื่อ'].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', null, users.map((u) => {
          const self = u.user_id === me;
          const set = async (patch, el) => {
            el.disabled = true;
            try {
              await ctx.api.adminSetUser(u.user_id, patch.role ?? null, patch.approved ?? null, patch.disabled ?? null);
              Object.assign(u, patch);
              toast(`อัปเดต ${u.display_name || u.email} แล้ว`, 'good');
            } catch (e) { toast(errText(e), 'error', 6000); await load(); }
            drawUsers();
          };
          const role = h('select', { class: 'input select small', 'aria-label': `สิทธิ์ของ ${u.display_name}`, disabled: self, onchange: (e) => set({ role: e.target.value }, e.target) },
            h('option', { value: 'member', selected: u.role === 'member' }, 'member'), h('option', { value: 'admin', selected: u.role === 'admin' }, 'admin'));
          const appr = h('input', { type: 'checkbox', class: 'toggle', role: 'switch', checked: u.approved, disabled: self, 'aria-label': `อนุมัติ ${u.display_name}`, onchange: (e) => set({ approved: e.target.checked }, e.target) });
          const dis = h('input', {
            type: 'checkbox', class: 'toggle danger', role: 'switch', checked: u.disabled, disabled: self, 'aria-label': `ระงับ ${u.display_name}`,
            onchange: async (e) => {
              if (e.target.checked) {
                const ok = await confirmDialog(`ระงับบัญชี ${u.display_name || u.email}?`, 'ผู้ใช้นี้จะเข้าเว็บไม่ได้และเห็นข้อมูลไม่ได้ บอทบนเครื่องของเขายังทำงาน แต่เอเจนต์จะส่งข้อมูลไม่ได้', { ok: 'ระงับ', danger: true });
                if (!ok) { e.target.checked = false; return; }
              }
              set({ disabled: e.target.checked }, e.target);
            },
          });
          return h('tr', { class: u.disabled ? 'dim' : '' },
            h('td', { 'data-label': 'ผู้ใช้' }, h('strong', null, u.display_name || '—'), self ? h('span', { class: 'chip' }, 'คุณ') : null, h('div', { class: 'muted small' }, u.email || '')),
            h('td', { 'data-label': 'สิทธิ์' }, role),
            h('td', { 'data-label': 'อนุมัติ' }, appr),
            h('td', { 'data-label': 'ระงับ' }, dis),
            h('td', { 'data-label': 'บอท', class: 'num' }, String(u.bots ?? 0)),
            h('td', { 'data-label': 'บอทออนไลน์ล่าสุด' }, u.last_seen ? ago(Date.parse(u.last_seen)) : '—'),
            h('td', { 'data-label': 'สมัครเมื่อ' }, fmtThai(Date.parse(u.created_at), 'date')));
        }))))));
  }

  drawInvites();
  drawUsers();
}
