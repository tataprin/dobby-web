// First-login welcome tour: 4 short dismissible steps. It opens once per browser, demo mode included: "seen" is written
// the moment it opens (so a reload half-way does not bring it back) to localStorage (prefs, try/catch), sessionStorage and
// a cookie, any one of which is enough (private windows and storage-blocking browsers keep at least one), plus memory.
// วิธีใช้ has "ดูทัวร์แนะนำอีกครั้ง" to replay it.
import { h, icon, mount } from './util.js';
import { prefs } from './state.js';
import { ART_WELCOME, ART_DASHBOARD, ART_SETTINGS, ART_HELP } from './guide-art.js';

const KEY = 'tour-done';
const COOKIE = 'dobby_tour';
let seenNow = false;
const cookiePath = () => { try { return location.pathname.replace(/[^/]*$/, '') || '/'; } catch { return '/'; } };
function readCookie() { try { return document.cookie.split(';').some((c) => c.trim() === `${COOKIE}=1`); } catch { return false; } }
function readSession() { try { return sessionStorage.getItem(`dobby-${KEY}`) === '1'; } catch { return false; } }
function markSeen() {
  seenNow = true;
  prefs.set(KEY, '1');
  try { sessionStorage.setItem(`dobby-${KEY}`, '1'); } catch { /* blocked */ }
  try { document.cookie = `${COOKIE}=1; max-age=31536000; path=${cookiePath()}; SameSite=Lax`; } catch { /* blocked */ }
}
const STEPS = [
  {
    title: 'ยินดีต้อนรับสู่ Dobby', art: ART_WELCOME,
    text: 'เว็บนี้ใช้ดูและสั่งบอททองของคุณ จากมือถือหรือคอมก็ได้ หลังตั้งแอปที่คอมครั้งแรกแล้ว ใช้แค่เว็บนี้อย่างเดียว',
    points: ['ภาพรวม: บอทกำลังทำอะไรอยู่', 'ตั้งค่าบอท: เปลี่ยนค่าในที่เดียว', 'ประวัติ: ทุกไม้ที่เทรด'],
  },
  {
    title: 'ภาพรวม: ดูบอทแบบสด', art: ART_DASHBOARD,
    text: 'ตราประทับ Dobby บอกสถานะในคำเดียว: สีทองคือเทรดจริงอยู่ สีเทาคือหยุดอยู่ สีแดงชาดคือออฟไลน์หรือมีปัญหา ใต้ตราคือกราฟราคาทองวันนี้ พร้อมจุดที่บอทเข้าและออก',
    points: ['▲ คือบอทซื้อ ▼ คือบอทขาย วงกลมคือจุดปิดไม้', 'ตัวเลขอัปเดตเอง ไม่ต้องรีเฟรช'],
  },
  {
    title: 'ตั้งค่าบอท: แก้แล้วกดส่งครั้งเดียว', art: ART_SETTINGS,
    text: 'เปิด/ปิดสูตร ปรับล็อต ทุน ล็อกกำไร และขาดทุนสูงสุดต่อวัน แล้วกด "บันทึกและส่งให้บอท" ไม่แน่ใจ กด "ตั้งให้อัตโนมัติจากทุน"',
    points: ['สวิตช์เทรดจริง หยุดชั่วคราว และงดเข้าไม้ช่วงข่าว อยู่หน้านี้ด้วย', 'บอทเปลี่ยนค่าตอนไม่มีไม้เปิด'],
  },
  {
    title: 'ติดตรงไหน กดปุ่ม ?', art: ART_HELP,
    text: 'ทุกหน้ามีปุ่ม "? วิธีใช้" มุมขวาบน พาไปคำอธิบายของหน้านั้น และหน้าวิธีใช้มีวิธีแก้ปัญหาที่พบบ่อย',
    points: ['ดูทัวร์นี้อีกครั้งได้ที่หน้า วิธีใช้'],
  },
];

export const tourDone = () => seenNow || prefs.get(KEY, '') === '1' || readSession() || readCookie();

export function maybeStartTour() {
  if (tourDone() || document.querySelector('dialog.tour')) return;
  startTour();
}

export function startTour() {
  if (document.querySelector('dialog.tour')) return;
  markSeen();
  let i = 0;
  const finish = () => { markSeen(); try { dlg.close(); } catch { /* closed */ } dlg.remove(); };
  const body = h('div', { class: 'tour-body' });
  const dlg = h('dialog', { class: 'modal tour', 'aria-label': 'แนะนำการใช้งาน' }, body);
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(); });
  function draw() {
    const s = STEPS[i];
    const last = i === STEPS.length - 1;
    mount(body, 
      h('div', { class: 'tour-art', html: s.art }),
      h('div', { class: 'tour-copy' },
        h('h2', null, s.title),
        h('p', null, s.text),
        h('ul', { class: 'tour-points' }, s.points.map((p) => h('li', null, icon('check'), h('span', null, p))))),
      h('div', { class: 'tour-foot' },
        h('div', { class: 'tour-dots', role: 'img', 'aria-label': `ขั้นที่ ${i + 1} จาก ${STEPS.length}` }, STEPS.map((_, k) => h('span', { class: k === i ? 'on' : '' }))),
        h('div', { class: 'row gap' },
          last ? null : h('button', { class: 'btn ghost', type: 'button', onclick: finish }, 'ข้าม'),
          i > 0 ? h('button', { class: 'btn', type: 'button', onclick: () => { i--; draw(); } }, 'ย้อนกลับ') : null,
          h('button', { class: 'btn primary', type: 'button', onclick: () => { if (last) finish(); else { i++; draw(); } } },
            last ? 'เริ่มใช้งาน' : 'ถัดไป'))));
    const btn = body.querySelector('.btn.primary');
    if (btn) btn.focus();
  }
  document.body.append(dlg);
  dlg.showModal();
  draw();
}
