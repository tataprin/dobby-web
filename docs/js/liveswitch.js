// Live trading switch (SPEC 0 rule 2, 2.4, 5 Dashboard).
// OFF: a plain confirm. ON: ask live_gate_status() first, then a fresh password sign-in and, when the account has a
// verified TOTP factor, a 6-digit code (aal2); then desired.live = true. The database enforces the same gate.
import { app, ownsBot } from './state.js';
import { normDesired, patchDesired, isPending, pendingChip, onlineInfo, cmdBlock } from './botctl.js';
import { h, icon, openModal, confirmDialog, toast, callout, errText, loadingState, busy, newId } from './util.js';

export function appliedLive(st) {
  if (!st) return null;
  if (st.remote && st.remote.live_enabled && typeof st.remote.live === 'boolean') return st.remote.live && (st.control || {}).mode !== 'pause';
  return (st.control || {}).mode === 'run' && !(st.flags || {}).live_locked;
}

export function liveSwitch({ bot, ctl, st, compact = false }) {
  const d = normDesired(ctl && ctl.desired);
  const on = d.live;
  const info = onlineInfo(bot, st);
  const pending = isPending(bot, ctl);
  const eff = appliedLive(st);
  const labelId = newId('live');
  const sw = h('button', {
    class: `liveswitch${on ? ' on' : ''}`, type: 'button', role: 'switch', 'aria-checked': on ? 'true' : 'false', 'aria-labelledby': labelId,
    disabled: !ctl, onclick: () => requestLive(bot, !on, st),
  }, h('span', { class: 'track', 'aria-hidden': 'true' }, h('span', { class: 'knob' })), h('span', { class: 'sw-text' }, on ? 'เปิด' : 'ปิด'));
  const effText = eff === null ? 'ยังไม่มีสถานะจากเครื่อง'
    : eff ? 'ที่เครื่อง: บอทเปิดไม้ได้' : 'ที่เครื่อง: บอทไม่เปิดไม้ใหม่';
  return h('section', { class: `live-panel${on ? ' on' : ''}${compact ? ' compact' : ''}`, 'aria-label': 'สวิตช์เทรดจริง' },
    h('div', { class: 'live-row' },
      h('div', { class: 'live-copy' },
        h('h2', { id: labelId, class: 'live-title' }, 'เทรดจริง'),
        h('p', { class: 'live-desc' }, on ? 'เปิดอยู่ บอทส่งคำสั่งซื้อขายในบัญชีจริงได้' : 'ปิดอยู่ บอทไม่เปิดไม้ใหม่ ไม้ที่เปิดอยู่ยังมี SL/TP ตามเดิม')),
      sw),
    h('div', { class: 'live-meta' },
      pendingChip(bot, ctl, info),
      h('span', { class: `chip ${eff ? 'live' : ''}` }, effText),
      !pending && eff !== null && eff !== on && ctl && d.control.mode !== 'pause'
        ? h('span', { class: 'chip warn' }, icon('warn'), 'เครื่องยังไม่ตรงกับคำสั่ง ดูคำเตือนด้านล่าง') : null));
}

export async function requestLive(bot, on, st) {
  if (!on) {
    const ok = await confirmDialog(ownsBot(bot) ? 'ปิดการเทรดจริง?' : `ปิดการเทรดจริงของบอท ${bot.owner_name || 'สมาชิก'}?`,
      'บอทจะหยุดเปิดไม้ใหม่ทันทีที่เครื่องรับคำสั่ง ไม้ที่เปิดอยู่ไม่ถูกปิด และยังมี SL/TP ที่โบรกเกอร์ตามเดิม',
      { ok: 'ปิดเทรดจริง', danger: true });
    if (!ok) return false;
    try {
      await patchDesired(bot.id, (d) => { d.live = false; });
      toast('ส่งคำสั่งปิดเทรดจริงแล้ว รอเครื่องรับคำสั่ง', 'good');
      return true;
    } catch (e) {
      toast(errText(e), 'error', 6000);
      return false;
    }
  }
  return openLiveOnModal(bot, st);
}

function preWarnings(bot, st) {
  const out = [];
  const lim = (bot.agent_state && bot.agent_state.limits) || null;
  const info = onlineInfo(bot, st);
  if (lim && lim.allow_remote_live === false) {
    out.push(callout('warn', 'เครื่องนี้ยังไม่อนุญาตให้เว็บเปิดเทรดจริง',
      h('p', null, 'คำสั่งจะถูกเอเจนต์ปฏิเสธ (live_not_allowed_locally) ให้รันคำสั่งนี้ที่เครื่องนั้นก่อน:'),
      cmdBlock('python dobby_agent.py limits --allow-live on')));
  }
  if (st && st.flags && st.flags.live_locked && !(st.remote && st.remote.live_enabled)) {
    out.push(callout('warn', 'EA ยังล็อกการเทรดจริงอยู่',
      h('p', null, 'ตั้ง InpAllowLive = true ใน Inputs ของ EA ที่เครื่อง (หรือใช้ EA v3.04 กับ InpRemoteLive = true) ไม่อย่างนั้นบอทจะไม่เปิดไม้แม้สวิตช์เปิด')));
  }
  if (!info.agentOnline) out.push(callout('info', 'เครื่องออฟไลน์อยู่', h('p', null, 'คำสั่งจะมีผลเมื่อเอเจนต์บนเครื่องกลับมาออนไลน์')));
  return out;
}

function openLiveOnModal(bot, st) {
  return new Promise((resolve) => {
    const api = app.api;
    let done = false;
    const m = openModal({
      title: ownsBot(bot) ? 'เปิดเทรดจริง' : `เปิดเทรดจริงให้บอทของ ${bot.owner_name || 'สมาชิก'}`, // the admin (2026-11-10)
      body: loadingState('กำลังตรวจการยืนยันตัวตน…'),
      actions: [{ label: 'ยกเลิก' }],
      onClose: () => resolve(done),
    });
    const warnings = preWarnings(bot, st);
    const demoHint = app.mode === 'demo'
      ? h('p', { class: 'hint' }, 'โหมดตัวอย่าง: รหัสผ่านอะไรก็ได้ รหัส 2FA เป็นตัวเลข 6 หลักอะไรก็ได้ (ยกเว้น 000000)') : null;

    const setBody = (...nodes) => { m.body.replaceChildren(...nodes.flat().filter(Boolean)); };

    async function start() {
      let gate = 'reauth_required';
      try { gate = await api.liveGateStatus(); } catch { /* RPC missing or failed: ask for the password */ }
      if (gate === 'ok') confirmStep();
      else if (gate === 'mfa_required') codeStep();
      else passwordStep();
    }

    function passwordStep(message) {
      const formId = newId('pw');
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
            let gate = null;
            try { gate = await api.liveGateStatus(); } catch { gate = null; }
            if (gate === 'mfa_required' || (gate === null && (await hasVerifiedFactor()))) codeStep();
            else await enable();
          } catch (ex) {
            busy(btn, false);
            err.textContent = errText(ex);
            input.select();
          }
        },
      },
      warnings,
      h('p', null, 'เพื่อความปลอดภัย ใส่รหัสผ่านของ ', h('strong', null, (app.user && app.user.email) || 'บัญชีนี้'), ' อีกครั้ง'),
      h('div', { class: 'field' }, h('label', { for: `${formId}-in` }, 'รหัสผ่าน'), input),
      demoHint, err);
      setBody(form);
      m.setActions([{ label: 'ยกเลิก' }, { label: 'ยืนยันรหัสผ่าน', kind: 'primary', submit: true, form: formId, icon: 'key' }]);
      setTimeout(() => input.focus(), 30);
    }

    async function hasVerifiedFactor() {
      try { return (await api.mfaFactors()).some((f) => f.status === 'verified'); } catch { return false; }
    }

    async function codeStep(message) {
      setBody(loadingState('กำลังเตรียม 2FA…'));
      let factor = null;
      try { factor = (await api.mfaFactors()).find((f) => f.status === 'verified'); } catch (ex) { message = errText(ex); }
      if (!factor) { await enable(); return; }
      const formId = newId('otp');
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
          try {
            await api.mfaVerify(factor.id, input.value.trim());
            await enable();
          } catch (ex) {
            busy(btn, false);
            err.textContent = errText(ex);
            input.select();
          }
        },
      },
      h('p', null, 'ใส่รหัส 6 หลักจากแอปยืนยันตัวตน (', factor.friendly_name || 'TOTP', ')'),
      h('div', { class: 'field' }, h('label', { for: `${formId}-in` }, 'รหัส 2FA'), input),
      demoHint, err);
      setBody(form);
      m.setActions([{ label: 'ยกเลิก' }, { label: 'ยืนยันรหัส', kind: 'primary', submit: true, form: formId, icon: 'shield' }]);
      setTimeout(() => input.focus(), 30);
    }

    function confirmStep() {
      setBody(warnings, h('p', null, 'คุณยืนยันตัวตนไปเมื่อไม่ถึง 5 นาทีที่แล้ว กดเปิดเพื่อให้บอทเริ่มส่งคำสั่งในบัญชีจริง'));
      m.setActions([{ label: 'ยกเลิก' }, { label: 'เปิดเทรดจริง', kind: 'live', onClick: () => enable() }]);
    }

    async function enable() {
      setBody(loadingState('กำลังส่งคำสั่ง…'));
      m.setActions([{ label: 'ยกเลิก' }]);
      try {
        await patchDesired(bot.id, (d) => { d.live = true; });
        done = true;
        m.close();
        toast('ส่งคำสั่งเปิดเทรดจริงแล้ว รอเครื่องรับคำสั่ง', 'good', 5000);
      } catch (ex) {
        if (ex.code === 'reauth_required') passwordStep(errText(ex));
        else if (ex.code === 'mfa_required') codeStep(errText(ex));
        else {
          setBody(callout('critical', 'เปิดเทรดจริงไม่สำเร็จ', h('p', null, errText(ex))));
          m.setActions([{ label: 'ปิด' }, { label: 'ลองอีกครั้ง', kind: 'primary', onClick: () => start() }]);
        }
      }
    }

    start();
  });
}
