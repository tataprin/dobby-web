// วิธีใช้: short illustrated sections, linked from the "?" button of every page (#/guide/<section>).
import { h, icon, fmtNum, fmtSigned } from '../util.js';
import { app, loadBots, isAdmin } from '../state.js';
import { pageHead, ADMIN_SEES } from '../views.js';
import { startTour } from '../tour.js';
import { calculate, HORIZON30 } from '../lotcalc.js';
import { ART_DASHBOARD, ART_SETTINGS, ART_PROGRESS, ART_LIVE, ART_NEWS, ART_LOCK, ART_SMARTSCREEN } from '../guide-art.js';

export const SECTIONS = [
  { id: 'start', title: 'เริ่มต้นใช้งาน', icon: 'play', short: 'สมัคร โหลดแอป ตั้งค่า กดเริ่ม' },
  { id: 'dashboard', title: 'อ่านหน้าภาพรวม', icon: 'home', short: 'สถานะ ยอดเงิน ไม้ที่เปิด' },
  { id: 'settings', title: 'เปลี่ยนการตั้งค่าบอท', icon: 'sliders', short: 'สูตร ล็อต ล็อกกำไร แล้วกดส่ง' },
  { id: 'live', title: 'เปิด/ปิดเทรดจริง', icon: 'power', short: 'สวิตช์ใหญ่ กับหยุดชั่วคราว' },
  { id: 'news', title: 'งดเข้าไม้ช่วงข่าว', icon: 'clock', short: 'หลบข่าวแรง ก่อน 30 หลัง 90 นาที' },
  { id: 'lock', title: 'ล็อกกำไรคืออะไร', icon: 'shield', short: 'เลื่อน SL มาเป็นกำไร' },
  { id: 'risk', title: 'ความเสี่ยง', icon: 'warn', short: 'อ่านก่อนเพิ่มล็อต' },
  { id: 'history', title: 'ดูประวัติ', icon: 'history', short: 'ทุกไม้ กราฟ ปฏิทิน' },
  { id: 'machines', title: 'เครื่องของฉัน', icon: 'monitor', short: 'ชื่อ บอทหลัก ลบเครื่อง' },
  { id: 'trouble', title: 'แก้ปัญหาที่พบบ่อย', icon: 'help', short: 'ออฟไลน์ ค่าไม่เปลี่ยน Windows เตือน' },
];

const art = (svg) => h('figure', { class: 'g-art', html: svg });
const steps = (...items) => h('ol', { class: 'g-steps' }, items.map(([t, d]) => h('li', null, h('strong', null, t), d ? h('span', null, d) : null)));
const tip = (text) => h('p', { class: 'g-tip' }, icon('info'), h('span', null, text));
const linkBtn = (href, label, ic, primary) => h('a', { class: `btn ${primary ? 'primary' : ''}`, href }, ic ? icon(ic) : null, label);

function section(id, ...kids) {
  const s = SECTIONS.find((x) => x.id === id);
  return h('section', { class: 'g-sec', id: `g-${id}`, 'aria-labelledby': `gh-${id}` },
    h('div', { class: 'g-head' }, h('span', { class: 'g-ico' }, icon(s.icon)), h('h2', { id: `gh-${id}` }, s.title)), ...kids);
}

function faq(id, q, ...a) {
  return h('details', { class: 'faq', id: `g-${id}` }, h('summary', null, q), h('div', { class: 'faq-a' }, ...a));
}

export function render(root, ctx) {
  const target = ctx.parts[0] || '';
  root.append(pageHead('วิธีใช้', 'อ่านทีละหัวข้อ สั้น ๆ พร้อมรูป', h('button', { class: 'btn', type: 'button', onclick: () => startTour() }, icon('play'), 'ดูทัวร์แนะนำอีกครั้ง')));

  // two columns on wide screens (sections + a sticky list of topics, like ตั้งค่าบอท); one column with the topics first below
  const main = h('div', { class: 'guide-main' });
  const toc = h('nav', { class: 'g-toc', 'aria-label': 'หัวข้อ' }, SECTIONS.map((s) => h('a', {
    href: `#/guide/${s.id}`,
    onclick: (e) => { e.preventDefault(); history.replaceState(null, '', `#/guide/${s.id}`); go(s.id); },
  }, h('span', { class: 'g-toc-n', 'aria-hidden': 'true' }, String(SECTIONS.indexOf(s) + 1)), h('span', { class: 'g-toc-copy' }, h('strong', null, s.title), h('span', { class: 'muted small' }, s.short)))));
  root.append(h('div', { class: 'guide-layout' }, main, toc));

  const r = calculate(300, 0.03);
  const demo = app.mode === 'demo';

  main.append(
    section('start',
      h('p', null, 'ทำครั้งเดียวราว 15 นาที หลังจากนั้นใช้แค่เว็บนี้ ดูสด สั่งงาน และดูประวัติได้จากมือถือ'),
      h('div', { class: 'g-flow' },
        flow('user', '1 สมัคร', 'ขอรหัสเชิญจากเจ้าของบอท สมัครที่หน้าเข้าสู่ระบบ'),
        flow('download', '2 โหลดแอป', 'จากหน้า ดาวน์โหลดแอป โหลด DobbyApp.exe ไปไว้บนคอม Windows ที่เปิด MT5'),
        flow('gear', '3 ตั้งค่าในแอป', 'เข้าสู่ระบบ เลือกบอท Dobby ใส่ทุนแล้วกดตั้งให้อัตโนมัติ เชื่อม MT5'),
        flow('play', '4 กดเริ่ม', 'กด "เริ่มทำงาน Dobby" ภายในหนึ่งนาทีบอทขึ้นที่หน้าภาพรวม')),
      tip('ใน MT5 ต้องเปิดปุ่ม Algo Trading ให้เป็นสีเขียว และเปิดคอมทิ้งไว้ บอทเทรดจากคอมเครื่องนั้น ไม่ใช่จากเว็บ'),
      isAdmin() ? null : tip(ADMIN_SEES),
      h('div', { class: 'row gap wrap' }, linkBtn('#/downloads', 'ดาวน์โหลดแอป', 'download', true), linkBtn('#/machines', 'เครื่องของฉัน', 'monitor')),
      demo ? h('div', { class: 'g-demo' },
        h('p', null, h('strong', null, 'โหมดตัวอย่าง: '), 'ลองดูหน้าตาตอนที่ยังไม่มีบอท (หน้าภาพรวมจะสอน 3 ขั้นให้)'),
        app.api.noBots
          ? h('button', { class: 'btn small', type: 'button', onclick: async () => { app.api.setDemoNoBots(false); await loadBots(); ctx.nav('#/dashboard'); } }, icon('refresh'), 'แสดงบอทตัวอย่างอีกครั้ง')
          : h('button', { class: 'btn small', type: 'button', onclick: async () => { app.api.setDemoNoBots(true); await loadBots(); ctx.nav('#/dashboard'); } }, icon('monitor'), 'ดูตอนยังไม่มีบอท')) : null),

    section('dashboard',
      art(ART_DASHBOARD),
      steps(
        ['ตราประทับ Dobby', 'บอกสถานะในคำเดียว: ตราสีทองคือกำลังเทรดจริง ตราสีเทาคือหยุดอยู่ ตราสีแดงชาดคือออฟไลน์หรือมีปัญหา ข้าง ๆ มีเหตุผลหนึ่งประโยค และกำไรขาดทุนวันนี้'],
        ['กราฟราคาทองวันนี้', 'เส้นคือราคา XAUUSD 24 ชั่วโมงล่าสุด ▲ สีเขียวคือบอทเปิดไม้ซื้อ ▼ สีแดงคือเปิดไม้ขาย วงกลมคือจุดปิดไม้ (ขอบเขียวกำไร ขอบแดงขาดทุน) แตะหรือชี้ที่จุดเพื่อดูรายละเอียด'],
        ['ยอดเงินและกำไร', 'ยอดเงินในบัญชี มูลค่ารวมไม้ที่เปิด กำไรขาดทุนวันนี้ (เส้นใต้ตัวเลขจะเต็มเมื่อขาดทุนถึงจุดหยุดรายวัน) และกำไรตั้งแต่เริ่ม'],
        ['ไม้ที่เปิดอยู่', 'เส้นจาก SL ผ่านราคาเข้าไปถึง TP จุดกลมคือราคาตอนนี้ ฝั่งขวาสีเขียวคือกำไร ถ้าขึ้น "ล็อกกำไรแล้ว" ไม้นี้ไม่ขาดทุนแล้ว'],
        ['เทรดล่าสุด', 'ไม้ที่ปิดแล้ว กำไรสีเขียว ขาดทุนสีแดง กด "ดูทั้งหมดในประวัติ" เพื่อดูทุกไม้']),
      tip('ตัวเลขอัปเดตเองแบบสด ป้าย "ข้อมูลสด" ใต้หัวข้อบอกว่ากำลังรับข้อมูลสดอยู่ ราคาทองมุมบนของทุกหน้าเทียบกับแท่งแรกของวันโบรก'),
      h('div', { class: 'row gap wrap' }, linkBtn('#/dashboard', 'ไปหน้าภาพรวม', 'home'))),

    section('settings',
      art(ART_SETTINGS),
      steps(
        ['ดู "ค่าที่บอทใช้อยู่ตอนนี้"', 'กล่องบนสุดสรุปเป็นภาษาง่าย ๆ ว่าเปิดสูตรไหน ล็อตเท่าไร ทุนเท่าไร และล็อกกำไรกี่ชั้น'],
        ['ปรับค่า', 'ทุนในบัญชี ล็อต (เท่ากันทุกสูตร หรือแยกแต่ละสูตร) เปิด/ปิดสูตร ล็อกกำไร และขาดทุนสูงสุดต่อวัน ไม่แน่ใจ กด "ตั้งให้อัตโนมัติจากทุน"'],
        ['กด "บันทึกและส่งให้บอท"', 'แถบด้านล่างบอกว่าเปลี่ยนกี่อย่าง กดแล้วดูความคืบหน้า 3 ขั้น']),
      art(ART_PROGRESS),
      tip('EA เปลี่ยนค่าตอนไม่มีไม้เปิดเท่านั้น ถ้ามีไม้ค้างจะขึ้น "รอให้ไม่มีไม้ค้าง" เป็นเรื่องปกติ'),
      tip('แต่ละเครื่องมี "ล็อตสูงสุดที่เว็บสั่งได้" ที่ตั้งในแอปที่เครื่อง เว็บตั้งเกินไม่ได้ ถ้าขึ้นว่าเกินเพดาน ลดล็อต หรือไปเพิ่มในแอป (ตั้งค่า แล้วเลือก ความปลอดภัย)'),
      tip('บอทรุ่น 3.03 เปลี่ยนค่าจากเว็บไม่ได้ (อ่านอย่างเดียว) หน้าตั้งค่าบอทจะบอกวิธีอัปเดตเป็น 3.04 ใน 3 ขั้น หรือโหลดค่าเป็นไฟล์ .set ไปใส่ใน MT5 เอง'),
      h('div', { class: 'row gap wrap' }, linkBtn('#/bot', 'ไปหน้าตั้งค่าบอท', 'sliders'))),

    section('live',
      art(ART_LIVE),
      steps(
        ['ปิดเทรดจริง', 'กดสวิตช์ "เทรดจริง" แล้วยืนยัน บอทหยุดเปิดไม้ใหม่ ไม้ที่เปิดอยู่ยังมี SL/TP ที่โบรกเกอร์ตามเดิม'],
        ['เปิดเทรดจริง', 'ต้องใส่รหัสผ่านอีกครั้ง (และรหัส 2FA 6 หลักถ้าเปิดไว้) เพื่อกันคนอื่นมาเปิดแทนคุณ'],
        ['รอเครื่องรับคำสั่ง', 'ป้าย "เครื่องรับคำสั่งแล้ว" ขึ้นเมื่อคอมที่บ้านได้รับแล้ว ปกติไม่เกินครึ่งนาที']),
      tip('"หยุดชั่วคราว" ก็ทำให้บอทไม่เปิดไม้ใหม่เหมือนกัน ใช้พักสั้น ๆ ได้ และกด "ทำงานต่อ" ได้เลยโดยไม่ต้องใส่รหัสผ่าน'),
      tip('ถ้าขึ้น "เครื่องนี้ไม่อนุญาตให้เว็บเปิดเทรดจริง" ไปที่แอป Dobby ที่เครื่องนั้น เปิด ตั้งค่า แล้วเลือก ความปลอดภัย และติ๊กอนุญาต'),
      h('div', { class: 'row gap wrap' }, linkBtn('#/bot', 'ไปที่สวิตช์เทรดจริง', 'power'), linkBtn('#/settings', 'เปิด 2FA', 'shield'))),

    section('news',
      art(ART_NEWS),
      h('p', null, 'ข่าวแรงของสหรัฐ (NFP, CPI, FOMC) ทำให้ราคาทองวิ่งแรงและสเปรดกว้าง บอทจึงควรงดเปิดไม้ใหม่ช่วงนั้น: 30 นาทีก่อนข่าว ถึง 90 นาทีหลังข่าว'),
      steps(
        ['ทางลัด', 'หน้าตั้งค่าบอท การ์ด "งดเข้าไม้ช่วงข่าว" กด "งดข่าวถัดไป"'],
        ['เลือกเอง', 'หน้า ข่าว กดปุ่มงดเข้าไม้ข้างข่าวที่ต้องการ'],
        ['เหตุด่วน', 'กด "งด 2 ชม. จากตอนนี้" (มีบนหน้าภาพรวมด้วย)']),
      tip('เวลาในเว็บเป็นเวลาไทยทั้งหมด ไม้ที่เปิดอยู่แล้วยังวิ่งต่อตามปกติระหว่างช่วงงด'),
      h('div', { class: 'row gap wrap' }, linkBtn('#/news', 'ไปหน้าข่าว', 'news'))),

    section('lock',
      art(ART_LOCK),
      h('p', null, 'ปกติไม้จะจบที่ TP (กำไร) หรือ SL (ขาดทุน) ถ้าราคาวิ่งเกือบถึง TP แล้วย้อนกลับ อาจกลายเป็นขาดทุนได้ ',
        h('strong', null, 'ล็อกกำไร'), ' คือเมื่อกำไรวิ่งถึง X% ของทาง TP บอทจะเลื่อน SL ขึ้นมาอยู่ฝั่งกำไรที่ Y%'),
      h('div', { class: 'g-example' },
        h('p', null, h('strong', null, 'ตัวอย่าง 85 กับ 83 '), 'TP อยู่ห่างราคาเข้า 10 $ พอราคาวิ่งไป 8.5 $ (85%) บอทเลื่อน SL ไปที่ +8.3 $ (83%) ต่อให้ราคากลับลง ไม้ก็ยังปิดที่กำไรราว 83% ของ TP'),
        h('p', null, h('strong', null, '2 ชั้น '), 'ชั้นแรกถึง 85% เลื่อน SL ไป 83% แล้วชั้นใกล้ TP ถึง 95% เลื่อนไป 93% (ค่าที่ตั้งอัตโนมัติ)')),
      tip('ข้อแลกเปลี่ยน: ล็อกเร็วเกินไป ไม้ที่กำลังจะถึง TP อาจโดน SL ใหม่ก่อน ได้กำไรน้อยกว่า TP เล็กน้อย ถ้าไม่แน่ใจใช้ค่าอัตโนมัติ'),
      h('div', { class: 'row gap wrap' }, linkBtn('#/bot', 'ตั้งล็อกกำไร', 'shield'))),

    section('risk',
      h('ul', { class: 'g-list' },
        h('li', null, 'การเทรดทองมีความเสี่ยง เงินในบัญชี ', h('strong', null, 'ลดลงได้มาก'), ' แม้บอทจะมีจุดหยุดรายวัน ใช้เฉพาะเงินที่เสียได้'),
        h('li', null, 'ตัวเลขประมาณการในเว็บมาจาก ', h('strong', null, 'ผลจำลองย้อนหลัง'), ' (ม.ค. 2025 ถึง ต.ค. 2026) ไม่ใช่คำทำนาย ตลาดแบบปี 2025 ให้ผลแย่กว่าปี 2026 มาก'),
        h('li', null, 'จุดหยุดรายวันกันการเปิดไม้ใหม่ แต่ไม้ที่เปิดอยู่ยังวิ่งต่อ วันที่แย่จึงเสียเกินจุดหยุดได้ (ราว 1 ใน 3 ของวันที่ขาดทุน)'),
        h('li', null, 'ล็อตใหญ่ขึ้น กำไรอาจมากขึ้น แต่โอกาสที่ทุนจะเหลือครึ่งสูงขึ้นเร็วกว่า เริ่มจากค่าอัตโนมัติ (ทุก 100 ของทุน = 0.01 ล็อต)')),
      r && r.inRange ? h('div', { class: 'g-risk' },
        h('p', { class: 'small muted' }, 'ตัวอย่าง ทุน 300 ล็อต 0.03 ผลจำลอง 30 วัน'),
        h('div', { class: 'g-risk-row' },
          riskBox('1 ใน 10 ครั้ง แย่กว่า', fmtSigned(r.horizon.p10, 0), 'neg'),
          riskBox('ค่ากลาง', fmtSigned(r.horizon.median, 0), 'pos'),
          riskBox('1 ใน 10 ครั้ง ดีกว่า', fmtSigned(r.horizon.p90, 0), 'pos'),
          riskBox('โอกาสทุนเหลือครึ่ง', `${Math.round(r.horizon.halfPct)}%`, 'warn')),
        h('p', { class: 'small muted' }, `โอกาสที่ทุน 280 จะเหลือครึ่งใน 30 วัน: ${HORIZON30.map((x) => `ล็อต ${fmtNum(x.lot)} ราว ${Math.round(x.halfPct)}%`).join(', ')}`)) : null,
      h('div', { class: 'row gap wrap' }, linkBtn('#/calc', 'เครื่องคำนวณล็อต', 'calc'))),

    section('history',
      steps(
        ['ภาพรวม', 'สรุปตามสูตร กราฟพอร์ต และปฏิทินกำไรรายวัน กดวันในปฏิทินเพื่อดูเทรดของวันนั้น'],
        ['รายการเทรด', 'ทุกไม้ที่ปิดแล้ว เปิด-ปิดเมื่อไร ผลเป็นอย่างไร'],
        ['บันทึกทั้งหมด', 'ทุกเหตุการณ์ของบอท (สำหรับคนที่อยากดูละเอียด) ส่งออกเป็น CSV เปิดใน Excel ได้']),
      h('div', { class: 'row gap wrap' }, linkBtn('#/history', 'ไปหน้าประวัติ', 'history'))),

    section('machines',
      steps(
        ['บอทหลัก', 'มีหลายเครื่อง เลือก "ตั้งเป็นบอทหลัก" เว็บจะเปิดเครื่องนี้ก่อนทุกครั้ง สลับเครื่องได้ที่ช่องเลือกด้านบน'],
        ['เปลี่ยนชื่อ', 'ตั้งชื่อที่จำง่าย เช่น "คอมที่บ้าน" (ไม่กระทบบอท)'],
        ['ลบออกจากเว็บ', 'เอาเครื่องออกจากเว็บพร้อมประวัติ แต่ไม่ได้หยุดบอทที่คอมเครื่องนั้น ถ้าจะกลับมาใช้ ต้องเชื่อมเครื่องใหม่ในแอป']),
      isAdmin() ? tip('ผู้ดูแล: ดูบอทของสมาชิกทุกคนได้ที่หน้า ผู้ใช้ แท็บ "บอทของสมาชิก" หรือเลือกจากช่องบอทด้านบน ดูได้อย่างเดียว สั่งงานไม่ได้') : null,
      h('div', { class: 'row gap wrap' }, linkBtn('#/machines', 'ไปหน้าเครื่องของฉัน', 'monitor'))),

    section('trouble',
      faq('offline', 'บอทขึ้นว่า "ออฟไลน์"',
        h('ul', { class: 'g-list' },
          h('li', null, 'คอมเครื่องนั้นเปิดอยู่ไหม ไม่ได้เข้าโหมด Sleep และต่ออินเทอร์เน็ต'),
          h('li', null, 'แอป Dobby ยังเปิดอยู่ไหม (ปิดหน้าต่างแอป = หยุดส่งข้อมูล แต่ EA ใน MT5 อาจยังเทรดอยู่)'),
          h('li', null, 'ให้แอปเปิดเองหลังเปิดคอม: ในแอป เปิด ตั้งค่า แล้วเลือก เริ่มอัตโนมัติ และติ๊ก "เปิดพร้อม Windows"'),
          h('li', null, 'ถ้าขึ้น "MT5 ไม่ตอบ": MT5 เปิดอยู่ไหม EA ติดกราฟ XAUUSD M15 ไหม และปุ่ม Algo Trading เป็นสีเขียวไหม'))),
      faq('pending', 'ค้างที่ "รอเครื่องรับคำสั่ง"',
        h('ul', { class: 'g-list' },
          h('li', null, 'ถ้าเครื่องออฟไลน์ คำสั่งจะรอไว้ และถูกใช้ทันทีที่เครื่องกลับมาออนไลน์ ไม่ต้องกดซ้ำ'),
          h('li', null, 'ถ้าเครื่องออนไลน์แต่ค้างเกิน 1 นาที ปิดแล้วเปิดแอป Dobby ใหม่ที่เครื่องนั้น'),
          h('li', null, 'ถ้ามีคำเตือนสีเหลืองใต้สถานะ ทำตามที่เขียนไว้ (มักเป็นการอนุญาตในแอป)'))),
      faq('unchanged', 'ส่งค่าแล้ว แต่ค่าไม่เปลี่ยน',
        h('ul', { class: 'g-list' },
          h('li', null, 'ดู 3 ขั้นในหน้าตั้งค่าบอท: ค้างที่ "รอให้ไม่มีไม้ค้าง" เป็นเรื่องปกติ EA เปลี่ยนค่าเมื่อไม้ปิดแล้ว'),
          h('li', null, '"เครื่องไม่ยอมใช้ค่านี้" อ่านเหตุผลในกล่องสีเหลือง เช่น ล็อตเกินเพดานของเครื่อง หรือเครื่องยังไม่อนุญาตให้เว็บเปลี่ยนค่า'),
          h('li', null, 'บอทรุ่น 3.03 เปลี่ยนค่าจากเว็บไม่ได้ ต้องอัปเดตเป็น 3.04 (หน้าตั้งค่าบอทมีขั้นตอน)'))),
      faq('windows', 'Windows เตือนตอนเปิดแอป ("Windows protected your PC")',
        art(ART_SMARTSCREEN),
        h('p', null, 'แอปยังไม่ได้ลงลายเซ็นดิจิทัล Windows จึงเตือน ไม่ใช่ไวรัส: กด ', h('strong', null, 'More info'), ' (ข้อมูลเพิ่มเติม) แล้วกด ', h('strong', null, 'Run anyway'), ' (เรียกใช้ต่อไป)'),
        tip('ดาวน์โหลดจากหน้า ดาวน์โหลดแอป ของเว็บนี้เท่านั้น อย่ารับไฟล์ที่ส่งต่อกันทางแชต')),
      faq('password', 'ลืมรหัสผ่าน',
        h('p', null, 'ที่หน้าเข้าสู่ระบบ เลือกแท็บ "ลืมรหัสผ่าน" ใส่อีเมล แล้วเปิดลิงก์ในอีเมลบนเครื่องเดียวกัน'))),
  );

  function go(id) {
    const el = document.getElementById(`g-${id}`);
    if (!el) return;
    if (el.tagName === 'DETAILS') el.open = true;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1400);
  }
  if (target) requestAnimationFrame(() => setTimeout(() => go(target), 30));
}

function flow(ic, title, text) {
  return h('div', { class: 'g-flow-step' }, h('span', { class: 'g-flow-ico' }, icon(ic)), h('strong', null, title), h('span', { class: 'muted small' }, text));
}
function riskBox(label, value, tone) {
  return h('div', { class: `g-risk-box ${tone}` }, h('span', { class: 'small muted' }, label), h('strong', null, value));
}
