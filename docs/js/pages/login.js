// Sign in / sign up with invite code / forgot password.
import { h, icon, field, busy, errText, callout } from '../util.js';
import { rememberInvite } from '../app.js';
import { hallmark } from '../hallmark.js';

const TABS = [
  { id: 'signin', label: 'เข้าสู่ระบบ' },
  { id: 'signup', label: 'สมัครด้วยรหัสเชิญ' },
  { id: 'forgot', label: 'ลืมรหัสผ่าน' },
];
export const cleanCode = (s) => String(s || '').replace(/[\s-]/g, '').toUpperCase();
export const CODE_RE = /^[A-HJ-NP-Z2-9]{10}$/;

export function render(root, ctx) {
  let tab = TABS.some((t) => t.id === ctx.query.get('tab')) ? ctx.query.get('tab') : 'signin';
  const body = h('div', { class: 'auth-body' });
  const tabs = h('div', { class: 'login-tabs', role: 'tablist', 'aria-label': 'เลือกการทำงาน' });
  const draw = () => {
    tabs.replaceChildren(...TABS.map((t) => h('button', {
      type: 'button', role: 'tab', 'aria-selected': t.id === tab ? 'true' : 'false', class: t.id === tab ? 'on' : '',
      onclick: () => { tab = t.id; draw(); },
    }, t.label)));
    body.replaceChildren(tab === 'signin' ? signInForm(ctx) : tab === 'signup' ? signUpForm(ctx) : forgotForm(ctx));
  };
  draw();
  root.append(h('div', { class: 'login-page' },
    h('div', { class: 'login-mark' },
      hallmark({ tone: 'gold', state: 'XAUUSD', size: 'xl', title: 'Dobby' }),
      h('h1', { class: 'sr-only' }, 'Dobby Web'),
      h('p', { class: 'lead' }, h('span', { class: 'nowrap' }, 'ดูบอททองของคุณแบบสด ดูประวัติ'), ' ', h('span', { class: 'nowrap' }, 'และสั่งงานบอทได้จากมือถือ'))),
    h('section', { class: 'auth-card', 'aria-label': 'เข้าสู่ระบบ' }, tabs, body),
    h('section', { class: 'auth-help', 'aria-label': 'ครั้งแรก' },
      h('p', { class: 'auth-help-title' }, 'ครั้งแรกที่ใช้ ทำ 3 ขั้นนี้'),
      h('ol', { class: 'teach-steps' },
        h('li', null, h('strong', null, 'สมัครด้วยรหัสเชิญ'), h('span', null, 'ขอรหัส 10 ตัวจากเจ้าของบอท แล้วกดแท็บ "สมัครด้วยรหัสเชิญ"')),
        h('li', null, h('strong', null, 'โหลดแอป Dobby ไปเปิดที่คอม'), h('span', null, 'คอม Windows ที่เปิด MT5 ไว้ ทำตามตัวช่วยในแอป แล้วกดเริ่ม')),
        h('li', null, h('strong', null, 'ใช้เว็บนี้ได้เลย'), h('span', null, 'ดูสด สั่งงาน และดูประวัติจากมือถือ'))),
      ctx.app.mode === 'demo' ? null : h('a', { class: 'btn ghost small', href: `${location.pathname}?demo=1#/dashboard` }, icon('play'), 'ลองดูโหมดตัวอย่างก่อน'))));
}

function demoHint(ctx, text) {
  return ctx.app.mode === 'demo' ? h('p', { class: 'hint demo-hint' }, text) : null;
}

function signInForm(ctx) {
  const email = h('input', { class: 'input', type: 'email', autocomplete: 'email', required: true });
  const pw = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', required: true });
  const err = h('p', { class: 'field-error', role: 'alert' });
  const btn = h('button', { class: 'btn primary big block', type: 'submit' }, 'เข้าสู่ระบบ');
  return h('form', {
    class: 'stack',
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      busy(btn, true, 'กำลังเข้าสู่ระบบ…');
      try {
        await ctx.api.signIn(email.value.trim(), pw.value);
        await ctx.refreshSession();
        ctx.nav('#/dashboard', true);
      } catch (ex) {
        busy(btn, false);
        err.textContent = errText(ex);
      }
    },
  },
  field('อีเมล', email), field('รหัสผ่าน', pw),
  demoHint(ctx, 'โหมดตัวอย่าง: ใส่อีเมลและรหัสผ่านอะไรก็ได้ ระบบจะถาม 2FA ต่อ (ตัวเลข 6 หลักอะไรก็ได้) ถ้าอยากเห็นบัญชีที่ยังไม่ได้รับอนุมัติ ใช้ ploy@example.com'),
  err, btn);
}

function signUpForm(ctx) {
  const email = h('input', { class: 'input', type: 'email', autocomplete: 'email', required: true });
  const pw = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', minlength: 8, required: true });
  const pw2 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', minlength: 8, required: true });
  const code = h('input', { class: 'input code', type: 'text', autocomplete: 'off', autocapitalize: 'characters', spellcheck: false, required: true, placeholder: 'เช่น 7FKEKYJUVZ' });
  const err = h('p', { class: 'field-error', role: 'alert' });
  const done = h('div');
  const btn = h('button', { class: 'btn primary big block', type: 'submit' }, 'สมัครสมาชิก');
  const form = h('form', {
    class: 'stack',
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      const c = cleanCode(code.value);
      if (!CODE_RE.test(c)) { err.textContent = 'รหัสเชิญมี 10 ตัว ใช้ A-Z และ 2-9 (ไม่มี I, O, 0, 1)'; code.focus(); return; }
      if (pw.value.length < 8) { err.textContent = 'รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร'; pw.focus(); return; }
      if (pw.value !== pw2.value) { err.textContent = 'รหัสผ่านสองช่องไม่ตรงกัน'; pw2.focus(); return; }
      busy(btn, true, 'กำลังสมัคร…');
      try {
        const res = await ctx.api.signUp(email.value.trim(), pw.value);
        if (res.needsConfirm) {
          rememberInvite(c);
          form.replaceChildren(callout('good', 'สมัครแล้ว เหลืออีกขั้นเดียว',
            h('p', null, `ระบบส่งอีเมลยืนยันไปที่ ${email.value.trim()} เปิดลิงก์ในอีเมล แล้วกลับมาเข้าสู่ระบบ ระบบจะใช้รหัสเชิญให้อัตโนมัติ`),
            h('p', { class: 'muted small' }, 'ไม่เห็นอีเมล? ดูในโฟลเดอร์สแปม')));
          return;
        }
        try { await ctx.api.redeemInvite(c); } catch (ex) { rememberInvite(''); await ctx.refreshSession(); ctx.nav(`#/invite?err=${encodeURIComponent(ex.code || 'invite_invalid')}`, true); return; }
        await ctx.refreshSession();
        ctx.nav('#/dashboard', true);
      } catch (ex) {
        busy(btn, false);
        err.textContent = errText(ex);
      }
    },
  },
  field('อีเมล', email), field('รหัสผ่าน', pw, { hint: 'อย่างน้อย 8 ตัวอักษร' }), field('ยืนยันรหัสผ่าน', pw2),
  field('รหัสเชิญ', code, { hint: 'ขอจากผู้ดูแลบอท รหัสมีอายุจำกัด' }),
  demoHint(ctx, 'โหมดตัวอย่าง: รหัสเชิญที่ใช้ได้คือ DEMKH7K3QP'),
  err, btn, done);
  return form;
}

function forgotForm(ctx) {
  const email = h('input', { class: 'input', type: 'email', autocomplete: 'email', required: true });
  const err = h('p', { class: 'field-error', role: 'alert' });
  const btn = h('button', { class: 'btn primary big block', type: 'submit' }, 'ส่งลิงก์ตั้งรหัสผ่านใหม่');
  const form = h('form', {
    class: 'stack',
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      busy(btn, true, 'กำลังส่ง…');
      try {
        await ctx.api.resetPassword(email.value.trim());
        form.replaceChildren(callout('good', 'ส่งลิงก์แล้ว',
          h('p', null, 'ถ้าอีเมลนี้มีบัญชี จะได้รับลิงก์ตั้งรหัสผ่านใหม่ เปิดลิงก์บนเครื่องนี้ เว็บจะพาไปหน้าตั้งรหัสผ่านเอง')));
      } catch (ex) {
        busy(btn, false);
        err.textContent = errText(ex);
      }
    },
  },
  h('p', { class: 'muted' }, 'ใส่อีเมลที่ใช้สมัคร ระบบจะส่งลิงก์สำหรับตั้งรหัสผ่านใหม่ให้'),
  field('อีเมล', email), err, btn,
  h('p', { class: 'muted small' }, icon('info'), ' ลิงก์ใช้ได้ครั้งเดียวและหมดอายุเร็ว'));
  return form;
}
