// Settings: display name, password, 2FA (TOTP enroll with QR, unenroll), theme, account.
import { h, icon, fmtThai, toast, errText, confirmDialog, openModal, errorState, loadingState, field, busy, copyText, callout, newId } from '../util.js';
import { app, isAdmin } from '../state.js';
import { panel, pageHead } from '../views.js';
import { themeSegment } from '../app.js';

export async function render(root, ctx) {
  root.append(pageHead('ตั้งค่า', ctx.app.user ? ctx.app.user.email : ''));
  const nameBox = h('div'), pwBox = h('div'), mfaBox = h('div'), themeBox = h('div'), accBox = h('div');
  root.append(h('div', { class: 'grid-2' }, nameBox, pwBox), mfaBox, h('div', { class: 'grid-2' }, themeBox, accBox));

  // display name
  const nameIn = h('input', { class: 'input', type: 'text', maxlength: 60, required: true, value: (app.profile && app.profile.display_name) || '' });
  const nameErr = h('p', { class: 'field-error', role: 'alert' });
  const nameBtn = h('button', { class: 'btn primary', type: 'submit' }, 'บันทึกชื่อ');
  nameBox.append(panel('ชื่อที่แสดง', { sub: 'ผู้ดูแลเห็นชื่อนี้ในหน้าผู้ใช้' }, h('form', {
    class: 'stack',
    onsubmit: async (e) => {
      e.preventDefault();
      nameErr.textContent = '';
      const n = nameIn.value.trim();
      if (n.length < 1 || n.length > 60) { nameErr.textContent = 'ชื่อยาว 1 ถึง 60 ตัวอักษร'; return; }
      busy(nameBtn, true);
      try { await ctx.api.setDisplayName(n); app.profile = await ctx.api.profile(); toast('บันทึกชื่อแล้ว', 'good'); ctx.route(); }
      catch (ex) { nameErr.textContent = errText(ex); busy(nameBtn, false); }
    },
  }, field('ชื่อ', nameIn), nameErr, nameBtn)));

  // password
  const pw = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', minlength: 8, required: true });
  const pw2 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', minlength: 8, required: true });
  const pwErr = h('p', { class: 'field-error', role: 'alert' });
  const pwBtn = h('button', { class: 'btn', type: 'submit' }, icon('key'), 'เปลี่ยนรหัสผ่าน');
  pwBox.append(panel('รหัสผ่าน', { sub: 'ใช้รหัสผ่านนี้ทั้งที่เว็บและตอน login ของเอเจนต์' }, h('form', {
    class: 'stack',
    onsubmit: async (e) => {
      e.preventDefault();
      pwErr.textContent = '';
      if (pw.value.length < 8) { pwErr.textContent = 'รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร'; return; }
      if (pw.value !== pw2.value) { pwErr.textContent = 'รหัสผ่านสองช่องไม่ตรงกัน'; return; }
      busy(pwBtn, true);
      try { await ctx.api.updatePassword(pw.value); pw.value = ''; pw2.value = ''; toast('เปลี่ยนรหัสผ่านแล้ว', 'good'); }
      catch (ex) { pwErr.textContent = errText(ex); }
      busy(pwBtn, false);
    },
  }, field('รหัสผ่านใหม่', pw, { hint: 'อย่างน้อย 8 ตัวอักษร' }), field('ยืนยันรหัสผ่านใหม่', pw2), pwErr, pwBtn,
  h('p', { class: 'muted small' }, 'เอเจนต์บนเครื่องที่ล็อกอินไว้แล้วยังทำงานต่อ ถ้าต้องการตัดการเชื่อมต่อของเครื่องเก่า ให้รัน login ใหม่ที่เครื่องนั้น'))));

  // 2FA
  async function drawMfa() {
    mfaBox.replaceChildren(panel('ยืนยันตัวตนสองขั้น (2FA)', {}, loadingState()));
    let factors = [], aal = null;
    try { [factors, aal] = await Promise.all([ctx.api.mfaFactors(), ctx.api.aal().catch(() => null)]); }
    catch (e) { mfaBox.replaceChildren(panel('ยืนยันตัวตนสองขั้น (2FA)', {}, errorState(e, drawMfa))); return; }
    const verified = factors.filter((f) => f.status === 'verified');
    mfaBox.replaceChildren(panel('ยืนยันตัวตนสองขั้น (2FA)', { sub: 'ใช้แอป เช่น Google Authenticator, Microsoft Authenticator หรือ 1Password' },
      verified.length
        ? [callout('good', '2FA เปิดอยู่', h('p', null, 'ตอนเข้าสู่ระบบ และทุกครั้งที่เปิดเทรดจริง ต้องใส่รหัส 6 หลักจากแอป')),
          h('ul', { class: 'plain' }, verified.map((f) => h('li', { class: 'row gap wrap between' },
            h('span', null, icon('shield'), ' ', f.friendly_name || 'TOTP', f.created_at ? h('span', { class: 'muted small' }, ` ตั้งเมื่อ ${fmtThai(Date.parse(f.created_at), 'date')}`) : null),
            h('button', { class: 'btn small ghost danger-text', type: 'button', onclick: () => unenroll(f, aal) }, 'ปิด 2FA'))))]
        : [h('p', null, 'ยังไม่ได้เปิด 2FA แนะนำให้เปิด: ถ้ารหัสผ่านหลุด คนอื่นก็ยังเปิดเทรดจริงบนบอทของคุณไม่ได้'),
          h('button', { class: 'btn primary', type: 'button', onclick: (e) => enroll(e.currentTarget) }, icon('shield'), 'เปิด 2FA')]));
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

  themeBox.append(panel('ธีม', { sub: 'สว่าง มืด หรือตามการตั้งค่าของเครื่อง' }, themeSegment()));
  const p = app.profile || {};
  accBox.append(panel('บัญชี', {},
    h('dl', { class: 'kv' },
      h('dt', null, 'อีเมล'), h('dd', null, app.user ? app.user.email : '—'),
      h('dt', null, 'สิทธิ์'), h('dd', null, isAdmin() ? 'ผู้ดูแล (admin)' : 'สมาชิก (member)'),
      h('dt', null, 'สมัครเมื่อ'), h('dd', null, p.created_at ? fmtThai(Date.parse(p.created_at), 'date') : '—'),
      h('dt', null, 'โหมด'), h('dd', null, app.mode === 'demo' ? 'ตัวอย่าง (ข้อมูลสมมติ)' : 'เชื่อมต่อ Supabase')),
    h('button', { class: 'btn ghost', type: 'button', onclick: () => ctx.signOut() }, icon('logout'), 'ออกจากระบบ')));
}
