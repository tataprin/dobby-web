// ตั้งค่าบัญชี: grouped rows like ตั้งค่าบอท (label left, control right). Display name, password (dialog), 2FA (TOTP enroll
// with QR, unenroll), theme, account facts and sign out.
import { h, icon, fmtThai, toast, errText, confirmDialog, openModal, field, busy, copyText, newId, mount } from '../util.js';
import { app, isAdmin } from '../state.js';
import { pageHead, ADMIN_SEES } from '../views.js';
import { themeSegment } from '../app.js';

// one settings row: label (+ hint) left, control right
const row = (label, hint, ...ctrl) => h('div', { class: 'set-row' },
  h('div', { class: 'set-row-main' },
    h('div', { class: 'set-copy' }, h('p', { class: 'set-label' }, label), hint ? h('p', { class: 'hint' }, hint) : null),
    h('div', { class: 'set-ctrl' }, ...ctrl)));
const section = (id, title, sub, ...rows) => h('section', { class: 'set-sec', id, 'aria-label': title },
  h('div', { class: 'set-sec-head' }, h('h2', null, title), sub ? h('p', null, sub) : null),
  h('div', { class: 'group' }, ...rows));

export async function render(root, ctx) {
  root.append(pageHead('ตั้งค่าบัญชี', ctx.app.user ? ctx.app.user.email : '', null, 'live'));
  const mfaRow = h('div', { class: 'set-row' });
  const p = app.profile || {};

  // display name (inline form: input + save)
  const nameIn = h('input', { class: 'input', type: 'text', maxlength: 60, required: true, value: p.display_name || '', 'aria-label': 'ชื่อที่แสดง' });
  const nameErr = h('p', { class: 'field-error', role: 'alert' });
  const nameBtn = h('button', { class: 'btn', type: 'submit' }, 'บันทึก');
  const nameForm = h('form', {
    class: 'set-row',
    onsubmit: async (e) => {
      e.preventDefault();
      nameErr.textContent = '';
      const n = nameIn.value.trim();
      if (n.length < 1 || n.length > 60) { nameErr.textContent = 'ชื่อยาว 1 ถึง 60 ตัวอักษร'; return; }
      busy(nameBtn, true);
      try { await ctx.api.setDisplayName(n); app.profile = await ctx.api.profile(); toast('บันทึกชื่อแล้ว', 'good'); ctx.route(); }
      catch (ex) { nameErr.textContent = errText(ex); busy(nameBtn, false); }
    },
  }, h('div', { class: 'set-row-main' },
    h('div', { class: 'set-copy' }, h('p', { class: 'set-label' }, 'ชื่อที่แสดง'), h('p', { class: 'hint' }, 'ผู้ดูแลเห็นชื่อนี้ในหน้าผู้ใช้')),
    h('div', { class: 'set-ctrl acct-name' }, nameIn, nameBtn)), nameErr);

  root.append(h('div', { class: 'settings-main' },
    section('acct-profile', 'โปรไฟล์', null, nameForm),
    section('acct-security', 'ความปลอดภัย', 'รหัสผ่านใช้ทั้งที่เว็บและแอป Dobby ที่เครื่อง',
      row('รหัสผ่าน', 'อย่างน้อย 8 ตัวอักษร เครื่องที่ล็อกอินไว้แล้วยังทำงานต่อ',
        h('button', { class: 'btn', type: 'button', onclick: () => passwordDialog() }, icon('key'), 'เปลี่ยนรหัสผ่าน')),
      mfaRow),
    section('acct-display', 'การแสดงผล', null, row('ธีม', 'สว่าง มืด หรือตามการตั้งค่าของเครื่อง', themeSegment())),
    isAdmin() ? null : section('acct-privacy', 'ความเป็นส่วนตัว', null,
      row('ผู้ดูแลเว็บ', ADMIN_SEES, h('span', { class: 'chip' }, icon('eye'), 'ดูอย่างเดียว'))),
    section('acct-account', 'บัญชี', null,
      h('dl', { class: 'kv' },
        h('dt', null, 'อีเมล'), h('dd', null, app.user ? app.user.email : '—'),
        h('dt', null, 'สิทธิ์'), h('dd', null, isAdmin() ? 'ผู้ดูแล (admin)' : 'สมาชิก (member)'),
        h('dt', null, 'สมัครเมื่อ'), h('dd', null, p.created_at ? fmtThai(Date.parse(p.created_at), 'date') : '—'),
        h('dt', null, 'โหมด'), h('dd', null, app.mode === 'demo' ? 'ตัวอย่าง (ข้อมูลสมมติ)' : 'เชื่อมต่อ Supabase')),
      row('ออกจากระบบ', 'ออกจากเว็บบนเครื่องนี้', h('button', { class: 'btn', type: 'button', onclick: () => ctx.signOut() }, icon('logout'), 'ออกจากระบบ')))));

  function passwordDialog() {
    const pw = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', minlength: 8, required: true });
    const pw2 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', minlength: 8, required: true });
    const err = h('p', { class: 'field-error', role: 'alert' });
    const fid = newId('pw');
    const m = openModal({
      title: 'เปลี่ยนรหัสผ่าน',
      body: h('form', {
        id: fid, class: 'stack',
        onsubmit: async (e) => {
          e.preventDefault();
          err.textContent = '';
          if (pw.value.length < 8) { err.textContent = 'รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร'; return; }
          if (pw.value !== pw2.value) { err.textContent = 'รหัสผ่านสองช่องไม่ตรงกัน'; return; }
          const btn = m.foot.querySelector('button[type=submit]');
          busy(btn, true);
          try { await ctx.api.updatePassword(pw.value); m.close(); toast('เปลี่ยนรหัสผ่านแล้ว', 'good'); }
          catch (ex) { busy(btn, false); err.textContent = errText(ex); }
        },
      }, field('รหัสผ่านใหม่', pw, { hint: 'อย่างน้อย 8 ตัวอักษร' }), field('ยืนยันรหัสผ่านใหม่', pw2), err,
      h('p', { class: 'hint' }, 'แอปที่เครื่องที่ล็อกอินไว้แล้วยังทำงานต่อ ถ้าต้องการตัดการเชื่อมต่อของเครื่องเก่า ให้ล็อกอินใหม่ที่เครื่องนั้น')),
      actions: [{ label: 'ยกเลิก' }, { label: 'เปลี่ยนรหัสผ่าน', kind: 'primary', submit: true, form: fid, icon: 'key' }],
    });
    setTimeout(() => pw.focus(), 50);
  }

  // 2FA row
  async function drawMfa() {
    const fill = (hint, ...ctrl) => mount(mfaRow, h('div', { class: 'set-row-main' },
      h('div', { class: 'set-copy' }, h('p', { class: 'set-label' }, 'ยืนยันตัวตนสองขั้น (2FA)'), h('p', { class: 'hint' }, hint)),
      h('div', { class: 'set-ctrl' }, ...ctrl)));
    fill('กำลังโหลด…', h('span', { class: 'spinner', 'aria-hidden': 'true' }));
    let factors = [], aal = null;
    try { [factors, aal] = await Promise.all([ctx.api.mfaFactors(), ctx.api.aal().catch(() => null)]); }
    catch (e) { fill(errText(e), h('button', { class: 'btn', type: 'button', onclick: drawMfa }, icon('refresh'), 'ลองอีกครั้ง')); return; }
    const verified = factors.filter((f) => f.status === 'verified');
    if (verified.length) {
      const f = verified[0];
      fill(`เปิดอยู่: ${f.friendly_name || 'TOTP'}${f.created_at ? ` ตั้งเมื่อ ${fmtThai(Date.parse(f.created_at), 'date')}` : ''} ตอนเข้าสู่ระบบและทุกครั้งที่เปิดเทรดจริง ต้องใส่รหัส 6 หลักจากแอป`,
        h('span', { class: 'chip good' }, icon('shield'), 'เปิดอยู่'),
        h('button', { class: 'btn ghost danger-text', type: 'button', onclick: () => unenroll(f, aal) }, 'ปิด 2FA'));
    } else {
      fill('ยังไม่ได้เปิด แนะนำให้เปิด: ถ้ารหัสผ่านหลุด คนอื่นก็ยังเปิดเทรดจริงบนบอทของคุณไม่ได้ ใช้แอป เช่น Google Authenticator หรือ 1Password',
        h('button', { class: 'btn primary', type: 'button', onclick: (e) => enroll(e.currentTarget) }, icon('shield'), 'เปิด 2FA'));
    }
  }

  async function enroll(btn) {
    busy(btn, true);
    let data;
    try { data = await ctx.api.mfaEnroll(); } catch (e) { busy(btn, false); toast(errText(e), 'error', 6000); return; }
    busy(btn, false);
    const qr = String(data.qr || '');
    const src = qr.startsWith('<svg') ? `data:image/svg+xml;utf8,${encodeURIComponent(qr)}` : qr;
    const code = h('input', { class: 'input otp', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9]{6}', maxlength: 6, required: true, placeholder: '000000' });
    const err = h('p', { class: 'field-error', role: 'alert' });
    const fid = newId('enr');
    const m = openModal({
      title: 'เปิด 2FA',
      body: h('form', {
        id: fid, class: 'stack',
        onsubmit: async (e) => {
          e.preventDefault();
          err.textContent = '';
          const b = m.foot.querySelector('button[type=submit]');
          busy(b, true);
          try { await ctx.api.mfaVerify(data.id, code.value.trim()); m.close(); toast('เปิด 2FA แล้ว', 'good'); drawMfa(); }
          catch (ex) { busy(b, false); err.textContent = errText(ex); code.select(); }
        },
      },
      h('ol', { class: 'steps' },
        h('li', null, 'เปิดแอปยืนยันตัวตนบนมือถือ แล้วสแกน QR นี้'),
        h('li', null, 'ใส่รหัส 6 หลักที่แอปแสดง เพื่อยืนยันว่าตั้งสำเร็จ')),
      h('div', { class: 'qr' }, src ? h('img', { src, alt: 'QR สำหรับตั้ง 2FA', width: 200, height: 200 }) : null),
      h('details', null, h('summary', null, 'สแกนไม่ได้? ใส่รหัสลับเอง'),
        h('div', { class: 'cmd' }, h('code', { class: 'break' }, data.secret || ''), h('button', { class: 'btn small', type: 'button', onclick: () => copyText(data.secret || '') }, icon('copy'), 'คัดลอก'))),
      field('รหัส 6 หลัก', code), err,
      app.mode === 'demo' ? h('p', { class: 'hint' }, 'โหมดตัวอย่าง: QR นี้สแกนไม่ได้ ใส่ตัวเลข 6 หลักอะไรก็ได้ (ยกเว้น 000000)') : null),
      actions: [{ label: 'ยกเลิก' }, { label: 'ยืนยันและเปิด 2FA', kind: 'primary', submit: true, form: fid }],
    });
    setTimeout(() => code.focus(), 50);
  }

  async function unenroll(f, aal) {
    const ok = await confirmDialog('ปิด 2FA?', 'การเปิดเทรดจริงจะเหลือแค่การใส่รหัสผ่านซ้ำ บัญชีจะปลอดภัยน้อยลง', { ok: 'ปิด 2FA', danger: true });
    if (!ok) return;
    const doIt = async () => { await ctx.api.mfaUnenroll(f.id); toast('ปิด 2FA แล้ว', 'good'); drawMfa(); };
    try {
      if (aal && aal.current !== 'aal2') throw Object.assign(new Error('aal2'), { code: 'aal2_required' });
      await doIt();
    } catch (e) {
      if (e.code !== 'aal2_required') { toast(errText(e), 'error', 6000); return; }
      // Supabase needs an aal2 session to remove a verified factor: verify a code first.
      const code = h('input', { class: 'input otp', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9]{6}', maxlength: 6, required: true });
      const err = h('p', { class: 'field-error', role: 'alert' });
      const fid = newId('un');
      const m = openModal({
        title: 'ยืนยันรหัสก่อนปิด 2FA',
        body: h('form', {
          id: fid, class: 'stack',
          onsubmit: async (ev) => {
            ev.preventDefault();
            try { await ctx.api.mfaVerify(f.id, code.value.trim()); await doIt(); m.close(); } catch (ex) { err.textContent = errText(ex); }
          },
        }, field('รหัส 6 หลักจากแอป', code), err),
        actions: [{ label: 'ยกเลิก' }, { label: 'ยืนยันและปิด 2FA', kind: 'danger', submit: true, form: fid }],
      });
      setTimeout(() => code.focus(), 50);
    }
  }
  drawMfa();
}
