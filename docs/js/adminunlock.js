// The admin changing a member's bot settings (2026-11-10). The database wants the admin's own password again within
// the last 30 minutes, and the 6-digit 2FA code when the admin has 2FA (admin_edit_status, trigger bot_control_before).
// adminUnlock(ownerName) asks admin_edit_status() and, when needed, the password / code in one dialog. It resolves when
// the next write may go and throws ApiError('cancelled') when the admin closes the dialog; ApiError('read_only') when
// this account is no admin any more. One dialog at a time: parallel callers wait for the same one.
import { app } from './state.js';
import { ApiError } from './api.js';
import { h, openModal, loadingState, busy, errText, newId } from './util.js';

let pending = null;

// hint: the error code the database just raised ('admin_reauth_required' / 'admin_mfa_required'): skip the question
export function adminUnlock(ownerName, hint) {
  if (!pending) pending = run(ownerName, hint).finally(() => { pending = null; });
  return pending;
}

async function run(ownerName, hint) {
  const gate = hint || await app.api.adminEditStatus(); // 'not_deployed' (schema.sql not re-run) reaches the caller
  if (gate === 'ok') return;
  if (gate === 'admin_only') throw new ApiError('read_only');
  await dialog(ownerName || 'สมาชิก', gate);
}

function dialog(ownerName, gate) {
  return new Promise((resolve, reject) => {
    const api = app.api;
    let done = false;
    const m = openModal({
      title: 'ยืนยันรหัสผ่านแอดมิน',
      body: loadingState('กำลังเตรียม…'),
      actions: [{ label: 'ยกเลิก' }],
      onClose: () => { if (done) resolve(); else reject(new ApiError('cancelled')); },
    });
    const setBody = (...nodes) => { m.body.replaceChildren(...nodes.flat().filter(Boolean)); };
    const demoHint = app.mode === 'demo'
      ? h('p', { class: 'hint' }, 'โหมดตัวอย่าง: รหัสผ่านอะไรก็ได้ รหัส 2FA เป็นตัวเลข 6 หลักอะไรก็ได้ (ยกเว้น 000000)') : null;
    const finish = () => { done = true; m.close(); };

    function passwordStep(message) {
      const formId = newId('apw');
      const input = h('input', { type: 'password', id: `${formId}-in`, autocomplete: 'current-password', required: true, class: 'input' });
      const err = h('p', { class: 'field-error', role: 'alert' }, message || '');
      const form = h('form', {
        id: formId, class: 'stack',
        onsubmit: async (e) => {
          e.preventDefault();
          const btn = m.foot.querySelector('button[type=submit]');
          busy(btn, true, 'กำลังตรวจ…');
          err.textContent = '';
          try {
            await api.reauthenticate(input.value);
            let next = null;
            try { next = await api.adminEditStatus(); } catch { next = null; }
            if (next === 'admin_mfa_required') codeStep();
            else finish();
          } catch (ex) {
            busy(btn, false);
            err.textContent = errText(ex);
            input.select();
          }
        },
      },
      h('p', null, 'คุณกำลังตั้งค่าบอทของ ', h('strong', null, ownerName), ' ในฐานะแอดมิน ใส่รหัสผ่านของ ',
        h('strong', null, (app.user && app.user.email) || 'บัญชีแอดมิน'), ' อีกครั้ง แล้วตั้งค่าบอทของสมาชิกได้ 30 นาที'),
      h('div', { class: 'field' }, h('label', { for: `${formId}-in` }, 'รหัสผ่านแอดมิน'), input),
      demoHint, err);
      setBody(form);
      m.setActions([{ label: 'ยกเลิก' }, { label: 'ยืนยันรหัสผ่าน', kind: 'primary', submit: true, form: formId, icon: 'key' }]);
      setTimeout(() => input.focus(), 30);
    }

    async function codeStep(message) {
      setBody(loadingState('กำลังเตรียม 2FA…'));
      let factor = null;
      try { factor = (await api.mfaFactors()).find((f) => f.status === 'verified'); } catch (ex) { message = errText(ex); }
      if (!factor) { finish(); return; } // no verified factor any more: the database will say if it still wants one
      const formId = newId('aotp');
      const input = h('input', {
        type: 'text', id: `${formId}-in`, inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9]{6}', maxlength: 6,
        required: true, class: 'input otp', placeholder: '000000',
      });
      const err = h('p', { class: 'field-error', role: 'alert' }, message || '');
      const form = h('form', {
        id: formId, class: 'stack',
        onsubmit: async (e) => {
          e.preventDefault();
          const btn = m.foot.querySelector('button[type=submit]');
          busy(btn, true, 'กำลังตรวจ…');
          err.textContent = '';
          try { await api.mfaVerify(factor.id, input.value.trim()); finish(); } catch (ex) { busy(btn, false); err.textContent = errText(ex); input.select(); }
        },
      },
      h('p', null, 'ใส่รหัส 6 หลักจากแอปยืนยันตัวตน (', factor.friendly_name || 'TOTP', ')'),
      h('div', { class: 'field' }, h('label', { for: `${formId}-in` }, 'รหัส 2FA'), input),
      demoHint, err);
      setBody(form);
      m.setActions([{ label: 'ยกเลิก' }, { label: 'ยืนยันรหัส', kind: 'primary', submit: true, form: formId, icon: 'shield' }]);
      setTimeout(() => input.focus(), 30);
    }

    if (gate === 'admin_mfa_required') codeStep();
    else passwordStep();
  });
}
