// First-login welcome tour: 4 short dismissible steps, remembered in localStorage (prefs uses try/catch).
import { h, icon, mount } from './util.js';
import { prefs } from './state.js';
import { ART_WELCOME, ART_DASHBOARD, ART_SETTINGS, ART_HELP } from './guide-art.js';

const KEY = 'tour-done';
const STEPS = [
  {
    title: 'ยินดีต้อนรับสู่ Dobby', art: ART_WELCOME,
    text: 'เว็บนี้ใช้ดูและสั่งบอททองของคุณ จากมือถือหรือคอมก็ได้ หลังตั้งแอปที่คอมครั้งแรกแล้ว ใช้แค่เว็บนี้อย่างเดียว',
    points: ['ภาพรวม: บอทกำลังทำอะไรอยู่', 'ตั้งค่าบอท: เปลี่ยนค่าในที่เดียว', 'ประวัติ: ทุกไม้ที่เทรด'],
  },
  {
    title: 'ภาพรวม: ดูบอทแบบสด', art: ART_DASHBOARD,
    text: 'การ์ดใหญ่ด้านบนบอกสถานะในคำเดียว: เทรดจริงอยู่ หยุดอยู่ หรือออฟไลน์ พร้อมเหตุผล ตามด้วยยอดเงิน กำไรวันนี้ และไม้ที่เปิดอยู่',
    points: ['ตัวเลขอัปเดตเอง ไม่ต้องรีเฟรช', 'ปุ่ม "หยุดชั่วคราว" อยู่บนการ์ดสถานะ'],
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

export const tourDone = () => prefs.get(KEY, '') === '1';

export function maybeStartTour() {
  if (tourDone() || document.querySelector('dialog.tour')) return;
  startTour();
}

export function startTour() {
  let i = 0;
  const finish = () => { prefs.set(KEY, '1'); try { dlg.close(); } catch { /* closed */ } dlg.remove(); };
  const body = h('div', { class: 'tour-body' });
  const dlg = h('dialog', { class: 'modal tour', 'aria-label': 'แนะนำการใช้งาน' }, body);
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(); });
  function draw() {
    const s = STEPS[i];
    const last = i === STEPS.length - 1;
    mount(body, 
      h('div', { class: 'tour-art', html: s.art }),
      h('div', { class: 'tour-copy' },
        h('p', { class: 'tour-step' }, `${i + 1} / ${STEPS.length}`),
        h('h2', null, s.title),
        h('p', null, s.text),
        h('ul', { class: 'tour-points' }, s.points.map((p) => h('li', null, icon('check'), h('span', null, p))))),
      h('div', { class: 'tour-foot' },
        h('div', { class: 'tour-dots', 'aria-hidden': 'true' }, STEPS.map((_, k) => h('span', { class: k === i ? 'on' : '' }))),
        h('div', { class: 'row gap' },
          last ? null : h('button', { class: 'btn ghost', type: 'button', onclick: finish }, 'ข้าม'),
          i > 0 ? h('button', { class: 'btn', type: 'button', onclick: () => { i--; draw(); } }, 'ย้อนกลับ') : null,
          h('button', { class: 'btn primary', type: 'button', onclick: () => { if (last) finish(); else { i++; draw(); } } },
            last ? 'เริ่มใช้งาน' : 'ถัดไป', last ? null : icon('chevron')))));
    const btn = body.querySelector('.btn.primary');
    if (btn) btn.focus();
  }
  document.body.append(dlg);
  dlg.showModal();
  draw();
}
