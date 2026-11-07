// Downloads (private bucket `downloads`) and the Thai step-by-step setup guide for a friend's PC.
import { h, icon, fmtBytes, fmtThai, toast, errText, confirmDialog, errorState, loadingState, busy, copyButton, callout, newId } from '../util.js';
import { app, isAdmin } from '../state.js';
import { cmdBlock } from '../botctl.js';
import { panel, pageHead } from '../views.js';

export async function render(root, ctx) {
  root.append(pageHead('ดาวน์โหลดและติดตั้ง', 'ทุกอย่างที่ต้องใช้เพื่อให้บอทบนคอมพิวเตอร์ของคุณขึ้นที่เว็บนี้'));
  const filesBox = h('div');
  root.append(filesBox, guide(ctx), advancedGuide(ctx));
  filesBox.append(panel('ไฟล์', {}, loadingState()));
  let files = [];
  const load = async () => { files = await ctx.api.listDownloads(); };

  async function draw() {
    try { await load(); } catch (e) { filesBox.replaceChildren(panel('ไฟล์', {}, errorState(e, () => draw()))); return; }
    const up = h('input', { type: 'file', class: 'sr-only', id: newId('up') });
    up.addEventListener('change', async () => {
      const f = up.files[0];
      up.value = '';
      if (!f) return;
      if (files.some((x) => x.name === f.name)) {
        const ok = await confirmDialog(`แทนที่ ${f.name}?`, 'มีไฟล์ชื่อนี้อยู่แล้ว ไฟล์เดิมจะถูกแทนที่', { ok: 'แทนที่' });
        if (!ok) return;
      }
      toast(`กำลังอัปโหลด ${f.name}…`);
      try { await ctx.api.uploadDownload(f); toast(`อัปโหลด ${f.name} แล้ว`, 'good'); draw(); } catch (e) { toast(errText(e), 'error', 6000); }
    });
    filesBox.replaceChildren(panel('ไฟล์', {
      sub: 'ไฟล์ EA (.ex5) และพรีเซ็ตจากผู้ดูแล ดาวน์โหลดได้เฉพาะสมาชิกที่ได้รับอนุมัติ',
      actions: isAdmin() ? h('label', { class: 'btn small', for: up.id, tabindex: '0', onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); up.click(); } } }, icon('upload'), 'อัปโหลดไฟล์') : null,
    },
    isAdmin() ? up : null,
    files.length ? h('ul', { class: 'file-list' }, files.map((f) => h('li', { class: 'file' },
      h('div', { class: 'grow' }, h('p', { class: 'file-name' }, f.name,
        /^dobbyapp.*\.exe$/i.test(f.name) ? [' ', h('span', { class: 'chip good' }, 'แอป Dobby: เริ่มที่นี่')] : null),
        h('p', { class: 'muted small' }, [f.size != null ? fmtBytes(f.size) : null, f.updated_at ? `อัปเดต ${fmtThai(Date.parse(f.updated_at), 'date')}` : null].filter(Boolean).join(', '))),
      h('button', {
        class: 'btn small', type: 'button',
        onclick: async (e) => {
          busy(e.currentTarget, true);
          try {
            const url = await ctx.api.downloadUrl(f.name);
            if (!url) toast('โหมดตัวอย่าง: ไม่มีไฟล์จริงให้ดาวน์โหลด', 'info');
            else { const a = h('a', { href: url, download: f.name, rel: 'noopener' }); document.body.append(a); a.click(); a.remove(); }
          } catch (ex) { toast(errText(ex), 'error'); }
          busy(e.currentTarget, false);
        },
      }, icon('download'), 'ดาวน์โหลด'),
      isAdmin() ? h('button', {
        class: 'icon-btn', type: 'button', 'aria-label': `ลบ ${f.name}`,
        onclick: async () => {
          const ok = await confirmDialog(`ลบ ${f.name}?`, 'สมาชิกจะดาวน์โหลดไฟล์นี้ไม่ได้อีก (ลบถาวร)', { ok: 'ลบ', danger: true });
          if (!ok) return;
          try { await ctx.api.deleteDownload(f.name); toast('ลบไฟล์แล้ว', 'good'); draw(); } catch (ex) { toast(errText(ex), 'error'); }
        },
      }, icon('trash')) : null)))
      : h('p', { class: 'muted' }, isAdmin() ? 'ยังไม่มีไฟล์ อัปโหลดไฟล์ EA (.ex5) และพรีเซ็ต (.set) ให้เพื่อน' : 'ผู้ดูแลยังไม่ได้อัปโหลดไฟล์')));
  }
  draw();
}

function step(title, ...body) {
  return h('li', { class: 'guide-step' }, h('h3', null, title), ...body);
}

function guide(ctx) {
  return panel('ติดตั้งบนคอมพิวเตอร์ของคุณ ด้วยแอป Dobby', { sub: 'ทำครั้งเดียว ราว 15 นาที ไม่ต้องลง Python ใช้คอมพิวเตอร์ Windows ที่เปิดทิ้งไว้ได้' },
    h('ol', { class: 'guide' },
      step('ติดตั้ง MetaTrader 5 และล็อกอินบัญชี',
        h('p', null, 'ดาวน์โหลด MT5 จากเว็บโบรกเกอร์ของคุณ ติดตั้ง แล้วล็อกอินบัญชีเทรด (File แล้ว Login to Trade Account)'),
        h('p', { class: 'muted small' }, 'แนะนำให้ลองกับบัญชีทดลอง (Demo) ก่อน แล้วค่อยใช้บัญชีจริง')),
      step('ดาวน์โหลดแอป Dobby',
        h('p', null, 'กดดาวน์โหลดไฟล์ ', h('code', null, 'DobbyApp.exe'), ' จากรายการไฟล์ด้านบน (ไฟล์เดียว ไม่ต้องติดตั้ง) เก็บไว้ที่ไหนก็ได้ เช่น บนเดสก์ท็อป')),
      step('เปิดแอป (ครั้งแรก Windows อาจเตือน)',
        h('p', null, 'ดับเบิลคลิก ', h('code', null, 'DobbyApp.exe'), ' ถ้าขึ้นหน้าจอสีฟ้า ', h('strong', null, '"Windows protected your PC"'),
          ' (Windows ป้องกันพีซีของคุณ) เป็นเพราะแอปยังไม่ได้ลงลายเซ็นดิจิทัล (code signing) ไม่ใช่ไวรัส:'),
        h('ul', null,
          h('li', null, 'กด ', h('strong', null, 'More info'), ' (ข้อมูลเพิ่มเติม)'),
          h('li', null, 'แล้วกด ', h('strong', null, 'Run anyway'), ' (เรียกใช้ต่อไป)')),
        h('p', { class: 'muted small' }, 'ดาวน์โหลดจากหน้านี้เท่านั้น อย่ารับไฟล์ DobbyApp.exe ที่ส่งต่อกันทางแชต')),
      step('ทำตามตัวช่วยตั้งค่าในแอป',
        h('ul', null,
          h('li', null, h('strong', null, 'เข้าสู่ระบบ'), ' ด้วยอีเมลและรหัสผ่านเดียวกับเว็บนี้ (แอปเก็บแค่ token ไม่เก็บรหัสผ่าน)'),
          h('li', null, h('strong', null, 'เลือก MT5'), ' ที่ล็อกอินบัญชีที่จะให้ Dobby เทรด'),
          h('li', null, h('strong', null, 'ติดตั้ง EA'), ': แอปคัดลอก ', h('code', null, 'Dobby3_v304.ex5'), ' และพรีเซ็ต .set จากรายการด้านบนไปไว้ใน MT5 ให้เอง'),
          h('li', null, h('strong', null, 'ตั้งชื่อเครื่อง'), ' (ชื่อจะขึ้นที่เว็บ) หรือเลือกบอทเดิมของคุณ'),
          h('li', null, h('strong', null, 'ความปลอดภัย'), ': ค่าเริ่มต้นปลอดภัย เว็บสั่งหยุด/ทำงานต่อได้ แต่เปิดเทรดจริงและส่งพรีเซ็ตไม่ได้ จนกว่าคุณจะติ๊กอนุญาตในแอป'))),
      step('ใน MT5: ติด EA ใส่กราฟ (ครั้งเดียว)',
        h('ul', null,
          h('li', null, 'กด Ctrl+N เปิดหน้าต่าง Navigator คลิกขวาที่ Expert Advisors แล้วกด ', h('strong', null, 'Refresh')),
          h('li', null, 'เปิดกราฟทอง ', h('strong', null, 'XAUUSD กรอบเวลา M15'), ' (หรือชื่อที่โบรกใช้ เช่น XAUUSD.f) ใช้กราฟเดียวเท่านั้น'),
          h('li', null, 'ลาก ', h('strong', null, 'Dobby3_v304'), ' จาก Navigator ไปวางบนกราฟ'),
          h('li', null, 'แท็บ Inputs: กด ', h('strong', null, 'Load'), ' แล้วเลือกไฟล์ .set (บัญชีจริงต้องมี ', h('code', null, 'InpAllowLive = true'),
            ' หรือ v3.04 ตั้ง ', h('code', null, 'InpRemoteLive = true'), ' เพื่อให้เว็บเปิด/ปิดได้)'),
          h('li', null, 'แท็บ Common: ติ๊ก ', h('strong', null, 'Allow Algo Trading'), ' แล้วกด OK'),
          h('li', null, 'กดปุ่ม ', h('strong', null, 'Algo Trading'), ' บนแถบเครื่องมือด้านบนของ MT5 ให้เป็นสีเขียว')),
        h('p', { class: 'muted small' }, 'แอปไม่เปิด MT5 และไม่แตะการตั้งค่าใน MT5 เอง ขั้นนี้จึงต้องทำด้วยมือครั้งเดียว หน้าแรกของแอปมีขั้นตอนนี้ให้ดูด้วย')),
      step('กด "เริ่มทำงาน Dobby"',
        h('p', null, 'รายการ ', h('strong', null, 'ความพร้อม'), ' ในแอปต้องเป็นเครื่องหมายถูกสีเขียว: เข้าสู่ระบบ, เชื่อมเครื่อง, EA ทำงาน, Algo Trading, เทรดได้, รับคำสั่งจากเว็บ'),
        h('p', null, 'ภายในหนึ่งนาที เปิด ', h('a', { href: '#/dashboard' }, 'ภาพรวม'), ' จะเห็นยอดเงินและป้าย "ออนไลน์"'),
        h('p', { class: 'muted small' }, 'อยากให้ทำงานเองหลังเปิดเครื่อง: ในแอป ตั้งค่า > เริ่มอัตโนมัติ > ติ๊ก "เปิดพร้อม Windows" ปิดหน้าต่างแอป = หยุดส่งข้อมูล (EA ใน MT5 ยังทำงานต่อ)'))),
    callout('info', 'เรื่องความปลอดภัย',
      h('p', null, 'แอปและเอเจนต์ไม่ส่งคำสั่งซื้อขายเอง แค่อ่านไฟล์สถานะของ EA และเขียนไฟล์ควบคุม การเปิดเทรดจริงจากเว็บต้องใส่รหัสผ่านซ้ำ (และรหัส 2FA ถ้าเปิดไว้) ทุกครั้ง และเครื่องต้องอนุญาตไว้ในแอปก่อน'),
      h('p', null, 'หนึ่ง MT5 ใช้ได้กับโปรแกรม Dobby ตัวเดียว (แอป หรือ Python agent) ถ้าเปิดซ้อน ตัวที่สองจะบอกว่ามีอีกตัวทำงานอยู่')));
}

// The Python agent: the same engine as the app, for owners who prefer the command line.
function advancedGuide(ctx) {
  const cfg = ctx.api.config || {};
  const repo = 'https://github.com/tataprin/dobby-web';
  return h('details', { class: 'panel' }, h('summary', null, 'ขั้นสูง: ใช้ Python agent แทนแอป (บรรทัดคำสั่ง)'),
    h('p', { class: 'muted small' }, 'ทำงานเหมือนแอปทุกอย่าง ใช้แทนกันได้ แต่อย่าเปิดพร้อมกันกับแอปบน MT5 เดียวกัน ขั้นตอน MT5 เหมือนด้านบน'),
    h('ol', { class: 'guide' },
      step('ติดตั้ง Python',
        h('p', null, 'ดาวน์โหลด Python 3 จาก ', h('a', { href: 'https://www.python.org/downloads/', target: '_blank', rel: 'noopener' }, 'python.org'),
          ' ตอนติดตั้งติ๊ก ', h('strong', null, 'Add python.exe to PATH')),
        h('p', null, 'ดาวน์โหลดโฟลเดอร์ ', h('code', null, 'agent'), ' จาก ', h('a', { href: `${repo}/tree/main/agent`, target: '_blank', rel: 'noopener' }, 'GitHub'),
          ' (หรือไฟล์ dobby_agent.zip ด้านบน) แตกไฟล์ไว้ เช่นที่ ', h('code', null, 'C:\\Dobby\\agent')),
        h('p', null, 'เปิด Command Prompt ในโฟลเดอร์นั้น แล้วติดตั้งไลบรารี:'),
        cmdBlock('pip install -r requirements.txt')),
      step('ตั้งค่าเอเจนต์',
        h('p', null, 'รันคำสั่งนี้แล้วใส่ค่าสองค่าด้านล่างเมื่อถูกถาม:'),
        cmdBlock('python dobby_agent.py setup'),
        h('div', { class: 'cfg-copy' },
          h('p', { class: 'small' }, 'Supabase URL'), h('div', { class: 'cmd' }, h('code', null, cfg.url || '(ยังไม่ได้ตั้งค่า)'), cfg.url ? copyButton(cfg.url) : null),
          h('p', { class: 'small' }, 'Publishable key / anon key (คีย์สาธารณะ)'), h('div', { class: 'cmd' }, h('code', { class: 'break' }, cfg.key || '(ยังไม่ได้ตั้งค่า)'), cfg.key ? copyButton(cfg.key) : null)),
        app.mode === 'demo' ? h('p', { class: 'hint' }, 'โหมดตัวอย่าง: ค่าด้านบนเป็นตัวอย่าง ของจริงจะเป็นค่าของเว็บนี้') : null),
      step('ล็อกอินและลงทะเบียนเครื่อง',
        h('p', null, 'ล็อกอินด้วยอีเมลและรหัสผ่านเดียวกับเว็บนี้ (พิมพ์เองที่เครื่อง เอเจนต์เก็บแค่ token):'),
        cmdBlock('python dobby_agent.py login'),
        h('p', null, 'ตั้งชื่อเครื่องนี้ ชื่อจะขึ้นที่เว็บ:'),
        cmdBlock('python dobby_agent.py register --name "คอมที่บ้าน"')),
      step('ตั้งขีดจำกัดของเครื่อง',
        h('p', null, 'ค่าเริ่มต้นปลอดภัย: เว็บสั่งหยุด/ทำงานต่อได้ แต่เปิดเทรดจริงและส่งพรีเซ็ตไม่ได้ ถ้าต้องการให้เว็บทำได้:'),
        cmdBlock('python dobby_agent.py limits --allow-live on --allow-params on --max-lots 0.03 --max-cap 10'),
        h('p', { class: 'muted small' }, 'เพดานล็อตและจุดหยุดรายวันนี้ เว็บเกินไม่ได้เด็ดขาด')),
      step('เริ่มเอเจนต์',
        cmdBlock('python dobby_agent.py run'),
        h('p', null, 'เปิดหน้าต่างนี้ทิ้งไว้ (หรือใช้ไฟล์ ', h('code', null, 'run_agent.bat'), ') ภายในหนึ่งนาทีบอทจะขึ้นที่หน้าภาพรวมพร้อมป้าย "ออนไลน์"')),
      step('ตรวจที่เว็บ',
        h('p', null, 'เปิด ', h('a', { href: '#/dashboard' }, 'ภาพรวม'), ' ต้องเห็นยอดเงิน สถานะ และป้ายออนไลน์ ถ้าเห็นคำเตือนจากเอเจนต์ ให้ทำตามคำสั่งที่แสดง'))));
}
