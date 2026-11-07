// Shown when js/config.js is empty (and ?demo=1 is not set).
import { h, icon, copyButton, callout } from '../util.js';
import { brandMark } from '../hallmark.js';

export function renderSetup() {
  const sample = 'export const SUPABASE_URL = "https://abcdefghijkl.supabase.co";\nexport const SUPABASE_ANON_KEY = "sb_publishable_...";';
  const site = location.origin + location.pathname;
  return h('div', { class: 'bare-wrap' },
    h('header', { class: 'bare-head wrap-col' }, h('span', { class: 'brand' }, brandMark(), h('span', { class: 'brand-word' }, 'Dobby'))),
    h('main', { id: 'main', class: 'bare wide' },
      h('section', { class: 'auth-card setup' },
        h('h1', null, 'เว็บนี้ยังไม่ได้เชื่อมกับฐานข้อมูล'),
        h('p', { class: 'lead' }, 'Dobby Web ต้องรู้ที่อยู่โปรเจกต์ Supabase ของคุณก่อน ใส่ 2 ค่าในไฟล์ ', h('code', null, 'docs/js/config.js'),
          ' แล้ว commit และ push ขึ้น GitHub เว็บจะเปิดหน้าเข้าสู่ระบบให้เอง'),
        h('div', { class: 'cmd block' }, h('pre', null, h('code', null, sample)), copyButton(sample)),
        h('ol', { class: 'steps' },
          h('li', null, 'สร้างโปรเจกต์ใหม่ที่ ', h('a', { href: 'https://supabase.com/dashboard', target: '_blank', rel: 'noopener' }, 'supabase.com'), ' (ฟรี)'),
          h('li', null, 'เปิด SQL Editor วางไฟล์ ', h('code', null, 'supabase/schema.sql'), ' ทั้งไฟล์ แล้วกด Run บรรทัดสุดท้ายคือรหัสเชิญแอดมิน เก็บไว้ใช้เอง'),
          h('li', null, 'ไปที่ Project Settings แล้วเปิด API Keys คัดลอก ', h('strong', null, 'Project URL'), ' และ ',
            h('strong', null, 'Publishable key (sb_publishable_...) หรือ legacy anon key'), ' มาใส่ใน config.js'),
          h('li', null, 'ที่ Authentication แล้วเปิด URL Configuration ตั้ง Site URL และ Redirect URLs เป็น ', h('code', null, site),
            ' (ใช้กับลิงก์ยืนยันอีเมลและลืมรหัสผ่าน)'),
          h('li', null, 'เปิดเว็บนี้อีกครั้ง สมัครด้วยอีเมลของคุณ แล้วใส่รหัสเชิญแอดมินจากข้อ 2')),
        callout('warn', 'ใส่เฉพาะคีย์สาธารณะ',
          h('p', null, 'Publishable key และ anon key เปิดเผยได้ ข้อมูลถูกป้องกันด้วย Row Level Security แต่ห้ามใส่ secret key หรือ service_role key ในไฟล์นี้เด็ดขาด')),
        h('div', { class: 'row gap' },
          h('a', { class: 'btn primary', href: `${location.pathname}?demo=1#/dashboard` }, icon('play'), 'ดูโหมดตัวอย่าง'),
          h('span', { class: 'muted small' }, 'ลองกดทุกหน้าด้วยข้อมูลสมมติ ไม่ต้องตั้งค่าอะไร')))));
}
