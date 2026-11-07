// Downloads (private bucket `downloads`) and the Thai step-by-step setup guide for a friend's PC.
import { h, icon, fmtBytes, fmtThai, toast, errText, confirmDialog, errorState, loadingState, busy, copyButton, callout, newId } from '../util.js';
import { app, isAdmin } from '../state.js';
import { cmdBlock } from '../botctl.js';
import { panel, pageHead } from '../views.js';

export async function render(root, ctx) {
  root.append(pageHead('ดาวน์โหลดและติดตั้ง', 'ทุกอย่างที่ต้องใช้เพื่อให้บอทบนคอมพิวเตอร์ของคุณขึ้นที่เว็บนี้'));
  const filesBox = h('div');
  root.append(filesBox, guide(ctx));
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
      h('div', { class: 'grow' }, h('p', { class: 'file-name' }, f.name),
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
  const cfg = ctx.api.config || {};
  const repo = 'https://github.com/tataprin/dobby-web';
  return panel('ติดตั้งบนคอมพิวเตอร์ของคุณ', { sub: 'ทำครั้งเดียว ใช้เวลาราว 30 นาที ต้องใช้คอมพิวเตอร์ Windows ที่เปิดทิ้งไว้ได้' },
    h('ol', { class: 'guide' },
      step('ติดตั้ง MetaTrader 5 และล็อกอินบัญชี',
        h('p', null, 'ดาวน์โหลด MT5 จากเว็บโบรกเกอร์ของคุณ ติดตั้ง แล้วล็อกอินบัญชีเทรด (File แล้ว Login to Trade Account)'),
        h('p', { class: 'muted small' }, 'แนะนำให้ลองกับบัญชีทดลอง (Demo) ก่อน แล้วค่อยใช้บัญชีจริง')),
      step('ใส่ไฟล์ EA',
        h('p', null, 'ดาวน์โหลดไฟล์ ', h('code', null, 'Dobby3_v304.ex5'), ' จากรายการไฟล์ด้านบน'),
        h('p', null, 'ใน MT5 กด File แล้ว Open Data Folder เปิดโฟลเดอร์ ', h('code', null, 'MQL5\\Experts'), ' แล้ววางไฟล์ไว้ในนั้น'),
        h('p', null, 'กลับมาที่ MT5 คลิกขวาที่ Expert Advisors ในหน้าต่าง Navigator แล้วกด Refresh จะเห็น Dobby3')),
      step('เปิดกราฟ XAUUSD M15',
        h('p', null, 'เปิดกราฟทอง (XAUUSD หรือชื่อที่โบรกเกอร์ใช้ เช่น XAUUSD.f) แล้วเลือกกรอบเวลา M15 ใช้กราฟเดียวเท่านั้น')),
      step('ลาก EA ใส่กราฟและโหลดพรีเซ็ต',
        h('p', null, 'ลาก Dobby3 จาก Navigator ไปวางบนกราฟ ในหน้าต่างที่ขึ้นมา:'),
        h('ul', null,
          h('li', null, 'แท็บ Common: ติ๊ก ', h('strong', null, 'Allow Algo Trading')),
          h('li', null, 'แท็บ Inputs: กด ', h('strong', null, 'Load'), ' แล้วเลือกไฟล์ .set (ดาวน์โหลดจากด้านบน หรือส่งออกจากหน้าพรีเซ็ต)'),
          h('li', null, 'บัญชีจริง: ตั้ง ', h('code', null, 'InpAllowLive = true'), ' (หรือใน v3.04 ตั้ง ', h('code', null, 'InpRemoteLive = true'), ' เพื่อให้เว็บเปิด/ปิดได้)'),
          h('li', null, 'อยากให้เว็บส่งพรีเซ็ตได้: ตั้ง ', h('code', null, 'InpRemoteParams = true'), ' และเพดาน ', h('code', null, 'InpRemoteMaxLots'))),
        h('p', null, 'กด OK แล้วดูมุมขวาบนของกราฟ ต้องเห็นชื่อ Dobby3')),
      step('กดปุ่ม Algo Trading',
        h('p', null, 'ปุ่ม ', h('strong', null, 'Algo Trading'), ' บนแถบเครื่องมือด้านบนของ MT5 ต้องเป็นสีเขียว ถ้าเป็นสีแดง บอทจะไม่ส่งคำสั่งเลย')),
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
        h('p', null, 'เปิด ', h('a', { href: '#/dashboard' }, 'ภาพรวม'), ' ต้องเห็นยอดเงิน สถานะ และป้ายออนไลน์ ถ้าเห็นคำเตือนจากเอเจนต์ ให้ทำตามคำสั่งที่แสดง'))),
    callout('info', 'เรื่องความปลอดภัย',
      h('p', null, 'เอเจนต์ไม่ส่งคำสั่งซื้อขายเอง มันแค่อ่านไฟล์สถานะของ EA และเขียนไฟล์ควบคุม การเปิดเทรดจริงจากเว็บต้องใส่รหัสผ่านซ้ำ (และรหัส 2FA ถ้าเปิดไว้) ทุกครั้ง')));
}
