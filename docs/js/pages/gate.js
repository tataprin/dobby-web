// Pages between sign-in and the app: invite code, 2FA at sign-in, password reset, disabled account.
import { h, icon, field, busy, errText, callout, toast, loadingState } from '../util.js';
import { cleanCode, CODE_RE } from './login.js';
import { THAI_ERRORS } from '../api.js';
import { adminSeesNotice } from '../views.js';

function card(title, lead, ...kids) {
  return h('section', { class: 'auth-card' }, h('h1', null, title), lead ? h('p', { class: 'lead' }, lead) : null, ...kids);
}
const signOutBtn = (ctx) => h('button', { class: 'btn ghost block', type: 'button', onclick: () => ctx.signOut() }, icon('logout'), 'ออกจากระบบ');

export function renderInvite(root, ctx) {
  const code = h('input', { class: 'input code', type: 'text', autocomplete: 'off', autocapitalize: 'characters', spellcheck: false, required: true, placeholder: 'เช่น 7FKEKYJUVZ' });
  const pre = ctx.query.get('err');
  const err = h('p', { class: 'field-error', role: 'alert' }, pre ? (THAI_ERRORS[pre] || 'ใช้รหัสเชิญไม่สำเร็จ') : '');
  const btn = h('button', { class: 'btn primary big block', type: 'submit' }, 'ใช้รหัสเชิญ');
  root.append(card('ใส่รหัสเชิญ', 'บัญชีนี้สมัครแล้ว แต่ยังไม่ได้รับอนุมัติ ขอรหัสเชิญ 10 ตัวจากผู้ดูแลบอท แล้วใส่ด้านล่าง',
    h('p', { class: 'muted' }, 'อีเมล: ', ctx.app.user ? ctx.app.user.email : ''),
    h('form', {
      class: 'stack',
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        const c = cleanCode(code.value);
        if (!CODE_RE.test(c)) { err.textContent = 'รหัสเชิญมี 10 ตัว ใช้ A-Z และ 2-9 (ไม่มี I, O, 0, 1)'; return; }
        busy(btn, true, 'กำลังตรวจ…');
        try {
          const res = await ctx.api.redeemInvite(c);
          toast(res === 'already_approved' ? 'บัญชีนี้ได้รับอนุมัติอยู่แล้ว' : 'ยินดีต้อนรับ บัญชีได้รับอนุมัติแล้ว', 'good');
          await ctx.refreshSession();
          ctx.nav('#/dashboard', true);
        } catch (ex) {
          busy(btn, false);
          err.textContent = errText(ex);
        }
      },
    }, field('รหัสเชิญ', code), ctx.app.mode === 'demo' ? h('p', { class: 'hint' }, 'โหมดตัวอย่าง: ใช้ DEMKH7K3QP') : null, err, btn),
    adminSeesNotice(),
    signOutBtn(ctx)));
}

export async function renderMfa(root, ctx) {
  root.append(loadingState());
  let factor = null;
  try { factor = (await ctx.api.mfaFactors()).find((f) => f.status === 'verified'); } catch (e) { /* shown below */ }
  root.replaceChildren();
  if (!factor) { ctx.app.needMfa = false; await ctx.refreshSession(); ctx.nav('#/dashboard', true); return; }
  const input = h('input', { class: 'input otp', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9]{6}', maxlength: 6, required: true, placeholder: '000000' });
  const err = h('p', { class: 'field-error', role: 'alert' });
  const btn = h('button', { class: 'btn primary big block', type: 'submit' }, icon('shield'), 'ยืนยัน');
  root.append(card('ยืนยัน 2FA', 'บัญชีนี้เปิดการยืนยันสองขั้นไว้ ใส่รหัส 6 หลักจากแอปยืนยันตัวตน',
    h('form', {
      class: 'stack',
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        busy(btn, true, 'กำลังตรวจ…');
        try {
          await ctx.api.mfaVerify(factor.id, input.value.trim());
          await ctx.refreshSession();
          ctx.nav('#/dashboard', true);
        } catch (ex) {
          busy(btn, false);
          err.textContent = errText(ex);
          input.select();
        }
      },
    }, field(`รหัสจาก ${factor.friendly_name || 'แอปยืนยันตัวตน'}`, input),
    ctx.app.mode === 'demo' ? h('p', { class: 'hint' }, 'โหมดตัวอย่าง: ตัวเลข 6 หลักอะไรก็ได้ (ยกเว้น 000000)') : null, err, btn),
    signOutBtn(ctx)));
  setTimeout(() => input.focus(), 30);
}

export function renderReset(root, ctx) {
  if (!ctx.app.user) {
    root.append(card('ลิงก์หมดอายุหรือใช้ไปแล้ว', 'ขอลิงก์ตั้งรหัสผ่านใหม่อีกครั้งที่หน้าเข้าสู่ระบบ',
      h('a', { class: 'btn primary big block', href: '#/login?tab=forgot' }, 'ขอลิงก์ใหม่')));
    return;
  }
  const pw = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', minlength: 8, required: true });
  const pw2 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', minlength: 8, required: true });
  const err = h('p', { class: 'field-error', role: 'alert' });
  const btn = h('button', { class: 'btn primary big block', type: 'submit' }, 'บันทึกรหัสผ่านใหม่');
  root.append(card('ตั้งรหัสผ่านใหม่', `สำหรับ ${ctx.app.user.email}`,
    h('form', {
      class: 'stack',
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        if (pw.value.length < 8) { err.textContent = 'รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร'; return; }
        if (pw.value !== pw2.value) { err.textContent = 'รหัสผ่านสองช่องไม่ตรงกัน'; return; }
        busy(btn, true, 'กำลังบันทึก…');
        try {
          await ctx.api.updatePassword(pw.value);
          toast('เปลี่ยนรหัสผ่านแล้ว', 'good');
          await ctx.refreshSession();
          ctx.nav('#/dashboard', true);
        } catch (ex) {
          busy(btn, false);
          err.textContent = errText(ex);
        }
      },
    }, field('รหัสผ่านใหม่', pw, { hint: 'อย่างน้อย 8 ตัวอักษร' }), field('ยืนยันรหัสผ่านใหม่', pw2), err, btn)));
}

export function renderDisabled(root, ctx) {
  root.append(card('บัญชีนี้ถูกระงับ', 'ติดต่อผู้ดูแลบอทถ้าคิดว่าเป็นความผิดพลาด',
    callout('info', null, h('p', null, 'บอทบนเครื่องของคุณยังทำงานตามค่าที่ตั้งไว้ล่าสุด การระงับบัญชีเว็บไม่ได้หยุดบอท')),
    signOutBtn(ctx)));
}
