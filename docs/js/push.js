// Web Push on this device (SPEC 9.7) and the ตั้งค่าบัญชี > การแจ้งเตือน section. The service worker (../sw.js) only
// shows the notification; the Edge Function `notify` sends it. Demo mode simulates the whole flow in the page.
import { h, icon, toast, errText, busy, mount, callout } from './util.js';
import { app } from './state.js';
import { ApiError } from './api.js';
import { VAPID_PUBLIC_KEY } from './config.js';

export const PUSH_EVENTS = [
  { id: 'open', label: 'เปิดไม้' },
  { id: 'close', label: 'ปิดไม้ พร้อมกำไรขาดทุน' },
  { id: 'daycap', label: 'ถึงจุดหยุดรายวัน' },
  { id: 'offline', label: 'เครื่องออฟไลน์เกิน 5 นาที' },
];
const ALL = PUSH_EVENTS.map((e) => e.id);
const DEMO_ENDPOINT = 'https://push.example.invalid/demo-this-device';
const demo = () => app.mode === 'demo';

export function pushSupport() {
  const ok = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  return { ok: demo() || ok, ios, standalone, permission: demo() ? 'default' : 'Notification' in window ? Notification.permission : 'unsupported' };
}

function keyBytes(b64url) {
  const pad = '='.repeat((4 - (b64url.length % 4)) % 4);
  const raw = atob((b64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function registration() {
  await navigator.serviceWorker.register('./sw.js', { scope: './' });
  return navigator.serviceWorker.ready;
}

export async function deviceSubscription() {
  if (demo()) return app.api.demoPushOn ? { endpoint: DEMO_ENDPOINT } : null;
  if (!pushSupport().ok) return null;
  const reg = await navigator.serviceWorker.getRegistration('./');
  return reg ? reg.pushManager.getSubscription() : null;
}

export async function enablePush(events) {
  if (demo()) {
    await app.api.savePushSubscription({ endpoint: DEMO_ENDPOINT, p256dh: 'demo', auth: 'demo', ua: navigator.userAgent.slice(0, 200), events });
    app.api.demoPushOn = true;
    return;
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new ApiError('push_denied', 'permission', perm === 'denied' ? 'เบราว์เซอร์บล็อกการแจ้งเตือนของเว็บนี้ไว้ เปิดได้ที่การตั้งค่าเว็บไซต์ของเบราว์เซอร์ แล้วลองอีกครั้ง' : 'ยังไม่ได้อนุญาตการแจ้งเตือน');
  const reg = await registration();
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(VAPID_PUBLIC_KEY) });
  const j = sub.toJSON();
  try {
    await app.api.savePushSubscription({ endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, ua: navigator.userAgent.slice(0, 200), events });
  } catch (e) { try { await sub.unsubscribe(); } catch { /* ignore */ } throw e; }
}

export async function disablePush() {
  const sub = await deviceSubscription();
  if (!sub) return;
  try { await app.api.deletePushSubscription(sub.endpoint); } catch { /* the row may be gone already */ }
  if (demo()) { app.api.demoPushOn = false; return; }
  try { await sub.unsubscribe(); } catch { /* ignore */ }
}

// ตั้งค่าบัญชี > การแจ้งเตือน
export function notifySection() {
  const group = h('div', { class: 'group' });
  const sec = h('section', { class: 'set-sec', id: 'acct-notify', 'aria-label': 'การแจ้งเตือน' },
    h('div', { class: 'set-sec-head' }, h('h2', null, 'การแจ้งเตือน'), h('p', null, 'ให้มือถือหรือคอมเครื่องนี้เด้งเตือนเมื่อบอทเปิดหรือปิดไม้ ถึงจุดหยุดรายวัน หรือเครื่องออฟไลน์')),
    group);
  let rows = [], sub = null, events = [...ALL], loadErr = null, testNote = null;
  const row = (label, hint, ...ctrl) => h('div', { class: 'set-row' }, h('div', { class: 'set-row-main' },
    h('div', { class: 'set-copy' }, h('p', { class: 'set-label' }, label), hint ? h('p', { class: 'hint' }, hint) : null),
    h('div', { class: 'set-ctrl' }, ...ctrl)));

  async function load() {
    mount(group, h('div', { class: 'set-row' }, h('p', { class: 'hint' }, 'กำลังโหลด…')));
    loadErr = null;
    try {
      [rows, sub] = await Promise.all([app.api.listPushSubscriptions(), deviceSubscription().catch(() => null)]);
      const mine = sub && rows.find((r) => r.endpoint === sub.endpoint);
      if (mine && Array.isArray(mine.events)) events = mine.events.filter((e) => ALL.includes(e));
      if (sub && !mine && !demo()) sub = { endpoint: sub.endpoint, orphan: true }; // subscribed in the browser, row missing
    } catch (e) { loadErr = e; }
    draw();
  }

  function draw() {
    const sup = pushSupport();
    const on = !!sub && !sub.orphan;
    const others = rows.filter((r) => !sub || r.endpoint !== sub.endpoint).length;
    let hint, ctrl;
    if (loadErr) {
      hint = loadErr.code === 'not_deployed' ? 'ฐานข้อมูลยังไม่พร้อมสำหรับการแจ้งเตือน ผู้ดูแลต้องรัน supabase/schema.sql รุ่นใหม่ก่อน' : errText(loadErr);
      ctrl = h('button', { class: 'btn', type: 'button', onclick: load }, icon('refresh'), 'ลองอีกครั้ง');
    } else if (!sup.ok) {
      hint = sup.ios && !sup.standalone ? 'บน iPhone ต้องเพิ่มเว็บนี้ลงหน้าจอโฮมก่อน (ดูวิธีด้านล่าง)' : 'เบราว์เซอร์นี้ไม่รองรับการแจ้งเตือนของเว็บ ลอง Chrome, Edge, Firefox หรือ Safari รุ่นใหม่';
      ctrl = h('span', { class: 'chip' }, 'ใช้ไม่ได้บนเครื่องนี้');
    } else if (sup.permission === 'denied') {
      hint = 'เบราว์เซอร์บล็อกการแจ้งเตือนของเว็บนี้ไว้ เปิดได้ที่การตั้งค่าเว็บไซต์ (รูปแม่กุญแจหน้าชื่อเว็บ) แล้วกลับมากดเปิดอีกครั้ง';
      ctrl = h('span', { class: 'chip bad' }, icon('x'), 'ถูกบล็อก');
    } else if (on) {
      hint = `เปิดอยู่บนเครื่องนี้${others ? ` และอีก ${others} เครื่อง` : ''} จะเด้งเตือนตามเรื่องที่เลือกด้านล่าง`;
      ctrl = [h('span', { class: 'chip good' }, icon('check'), 'เปิดอยู่'),
        h('button', { class: 'btn ghost', type: 'button', onclick: (e) => run(e.currentTarget, disablePush, 'ปิดการแจ้งเตือนบนเครื่องนี้แล้ว') }, 'ปิดบนเครื่องนี้')];
    } else {
      hint = `ยังไม่ได้เปิดบนเครื่องนี้${others ? ` (เปิดไว้แล้ว ${others} เครื่อง)` : ''} กดแล้วเบราว์เซอร์จะถามขออนุญาต`;
      ctrl = h('button', { class: 'btn primary', type: 'button', onclick: (e) => run(e.currentTarget, () => enablePush(events), 'เปิดการแจ้งเตือนแล้ว') }, icon('zap'), 'เปิดการแจ้งเตือน');
    }
    const checks = h('fieldset', { class: 'field checks push-events' }, h('legend', null, 'เรื่องที่จะแจ้ง'),
      PUSH_EVENTS.map((ev) => {
        const box = h('input', { type: 'checkbox', checked: events.includes(ev.id), disabled: !!loadErr || !sup.ok });
        box.addEventListener('change', async () => {
          events = box.checked ? [...new Set([...events, ev.id])] : events.filter((x) => x !== ev.id);
          if (on) {
            try { await app.api.updatePushSubscription(sub.endpoint, { events }); toast('บันทึกเรื่องที่จะแจ้งแล้ว', 'good', 2000); }
            catch (e) { toast(errText(e), 'error'); }
          }
        });
        return h('label', { class: 'check' }, box, h('span', null, ev.label));
      }));
    const testBtn = h('button', { class: 'btn', type: 'button', disabled: !on, onclick: (e) => sendTest(e.currentTarget) }, icon('news'), 'ส่งทดสอบ');
    mount(group,
      row('แจ้งเตือนบนเครื่องนี้', hint, ctrl),
      h('div', { class: 'set-row' }, checks),
      row('ส่งทดสอบ', on ? 'ส่งการแจ้งเตือนทดสอบไปทุกเครื่องที่เปิดไว้' : 'เปิดการแจ้งเตือนบนเครื่องนี้ก่อน', testBtn),
      testNote,
      h('p', { class: 'hint group-note push-ios' }, 'iPhone และ iPad: เปิดเว็บนี้ใน Safari กดปุ่มแชร์ เลือก "เพิ่มไปยังหน้าจอโฮม" แล้วเปิด Dobby จากไอคอนนั้นก่อน จึงจะเปิดการแจ้งเตือนได้ (iOS 16.4 ขึ้นไป)'));
  }

  async function run(btn, fn, okText) {
    busy(btn, true);
    try { await fn(); toast(okText, 'good'); testNote = null; await load(); }
    catch (e) { busy(btn, false); toast(errText(e), 'error', 7000); }
  }

  async function sendTest(btn) {
    busy(btn, true, 'กำลังส่ง…');
    testNote = null;
    try {
      const r = await app.api.sendTestPush();
      if (r && r.demo) {
        toast('โหมดตัวอย่าง: การแจ้งเตือนจริงจะขึ้นแบบนี้ "Dobby ทดสอบ: การแจ้งเตือนทำงานแล้ว"', 'good', 6000);
      } else if (r && r.sent === 0) {
        testNote = callout('info', 'ไม่มีเครื่องให้ส่ง', h('p', null, 'เซิร์ฟเวอร์ไม่พบเครื่องที่เปิดการแจ้งเตือนไว้ ลองปิดแล้วเปิดการแจ้งเตือนบนเครื่องนี้อีกครั้ง'));
      } else toast(`ส่งแล้ว${r && Number.isFinite(r.sent) ? ` ไป ${r.sent} เครื่อง` : ''}${r && r.failed ? ` (ไม่สำเร็จ ${r.failed})` : ''} ดูการแจ้งเตือนบนเครื่องนี้`, 'good', 5000);
    } catch (e) {
      testNote = e.code === 'push_not_ready' ? callout('info', 'ฝั่งเซิร์ฟเวอร์ยังไม่ได้ตั้งค่า', h('p', null, e.thai)) : callout('warn', 'ส่งทดสอบไม่สำเร็จ', h('p', null, errText(e)));
    }
    draw();
  }

  load();
  return sec;
}
