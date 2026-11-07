// ผู้ใช้ > ผู้ช่วย AI (admin, SPEC 10.4): turn the assistant on / off, daily limits, the monthly budget, the Claude model,
// and this month's usage per user (from ai_usage; "month" and "today" in Thai time like the database).
import { h, mount, icon, fmtNum, toast, errText, errorState, loadingState, field, busy, callout } from '../util.js';
import { panel } from '../views.js';

const MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (ตอบละเอียดที่สุด ค่าเริ่มต้น)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (ราคาราวครึ่งหนึ่งของ Opus)' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (ถูกที่สุด ตอบสั้นกว่า)' },
];
const SETUP_URL = 'https://github.com/tataprin/dobby-web/blob/main/supabase/README.md';
const TH = 7 * 3600e3;
const thaiDay = (ms) => new Date(ms + TH).toISOString().slice(0, 10);
function monthStartUtc(now = Date.now()) {
  const d = new Date(now + TH);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - TH;
}
const usd = (n) => `${fmtNum(Number(n) || 0, 2)} USD`;

export async function renderAi(root, ctx) {
  const box = h('div', { class: 'stack-lg' });
  root.append(box);
  box.append(loadingState());
  let cfg, usage = [], people = [];
  try {
    [cfg, usage, people] = await Promise.all([ctx.api.aiConfig(), ctx.api.aiUsage(new Date(monthStartUtc()).toISOString()), ctx.api.adminOverview().catch(() => [])]);
  } catch (e) {
    if (e && e.code === 'not_deployed') {
      mount(box, callout('warn', 'ฐานข้อมูลยังไม่มีส่วนของผู้ช่วย AI',
        h('p', null, 'รัน supabase/schema.sql รุ่นล่าสุดใน Supabase SQL Editor ก่อน แล้วเปิดหน้านี้อีกครั้ง'),
        h('p', null, h('a', { href: SETUP_URL, target: '_blank', rel: 'noopener' }, 'ดูขั้นตอนทั้งหมด'))));
      return;
    }
    mount(box, errorState(e, () => ctx.route()));
    return;
  }
  if (!cfg) { mount(box, callout('warn', 'ไม่พบการตั้งค่าผู้ช่วย AI', h('p', null, 'รัน supabase/schema.sql อีกครั้ง'))); return; }

  // ---------------- settings form
  const on = h('input', { type: 'checkbox', class: 'toggle', role: 'switch', checked: !!cfg.enabled, 'aria-label': 'เปิดใช้ผู้ช่วย AI' });
  const memberIn = h('input', { class: 'input', type: 'number', min: '0', max: '1000', step: '1', inputmode: 'numeric', value: String(cfg.member_daily_limit) });
  const adminIn = h('input', { class: 'input', type: 'number', min: '0', max: '5000', step: '1', inputmode: 'numeric', value: String(cfg.admin_daily_limit) });
  const budgetIn = h('input', { class: 'input', type: 'number', min: '0', max: '100000', step: '1', inputmode: 'decimal', value: String(Number(cfg.monthly_budget_usd)) });
  const modelIn = h('select', { class: 'input select' }, MODELS.map((m) => h('option', { value: m.id, selected: m.id === cfg.model }, m.label)));
  const err = h('p', { class: 'field-error', role: 'alert' });
  const saveBtn = h('button', { class: 'btn primary', type: 'submit' }, icon('save'), 'บันทึก');
  const form = h('form', {
    class: 'stack ai-form',
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      const patch = { enabled: on.checked, member_daily_limit: Number(memberIn.value), admin_daily_limit: Number(adminIn.value),
        monthly_budget_usd: Number(budgetIn.value), model: modelIn.value };
      const int = (v, hi) => Number.isInteger(v) && v >= 0 && v <= hi;
      if (!int(patch.member_daily_limit, 1000) || !int(patch.admin_daily_limit, 5000)) { err.textContent = 'จำนวนครั้งต่อวันต้องเป็นจำนวนเต็ม (สมาชิก 0 ถึง 1,000 ผู้ดูแล 0 ถึง 5,000)'; return; }
      if (!(patch.monthly_budget_usd >= 0 && patch.monthly_budget_usd <= 100000)) { err.textContent = 'งบต่อเดือนต้องอยู่ระหว่าง 0 ถึง 100,000 USD'; return; }
      busy(saveBtn, true, 'กำลังบันทึก…');
      try {
        cfg = await ctx.api.updateAiConfig(patch);
        toast('บันทึกการตั้งค่าผู้ช่วย AI แล้ว', 'good');
        drawUsage();
      } catch (ex) { err.textContent = errText(ex); }
      busy(saveBtn, false);
    },
  },
  h('div', { class: 'set-row ai-switch' }, h('div', { class: 'set-row-main' },
    h('div', { class: 'set-copy' }, h('p', { class: 'set-label' }, 'เปิดใช้ผู้ช่วย AI'), h('p', { class: 'hint' }, 'ปิดแล้วทุกคนถามไม่ได้ ประวัติแชทยังอยู่')), on)),
  h('div', { class: 'grid-2 ai-fields' },
    field('สมาชิกถามได้วันละ (ครั้ง)', memberIn, { hint: 'ต่อคน นับตามวันเวลาไทย 0 = ปิดสำหรับสมาชิก' }),
    field('ผู้ดูแลถามได้วันละ (ครั้ง)', adminIn),
    field('งบต่อเดือน (USD)', budgetIn, { hint: 'รวมทุกคน ครบงบแล้วผู้ช่วยหยุดตอบจนถึงต้นเดือนหน้า' }),
    field('รุ่น Claude', modelIn, { hint: 'ใช้กับคำถามถัดไปทันที' })),
  err,
  h('div', { class: 'ai-actions' }, saveBtn));

  // ---------------- usage this month
  const usageBox = h('div');
  function drawUsage() {
    const today = thaiDay(Date.now());
    const byUser = new Map();
    let total = 0;
    for (const u of usage) {
      const r = byUser.get(u.user_id) || { month: 0, today: 0, cost: 0 };
      r.month += 1;
      if (thaiDay(Date.parse(u.ts)) === today) r.today += 1;
      r.cost += Number(u.cost_usd) || 0;
      byUser.set(u.user_id, r);
      total += Number(u.cost_usd) || 0;
    }
    const name = (id) => { const p = people.find((x) => x.user_id === id); return p ? (p.display_name || p.email || 'ผู้ใช้') : 'ผู้ใช้ที่ถูกลบ'; };
    const mail = (id) => { const p = people.find((x) => x.user_id === id); return p ? p.email || '' : ''; };
    const budget = Number(cfg.monthly_budget_usd) || 0;
    const pct = budget > 0 ? Math.min(100, (total / budget) * 100) : 100;
    const rows = [...byUser.entries()].sort((a, b) => b[1].cost - a[1].cost);
    mount(usageBox, panel('การใช้งานเดือนนี้', { sub: 'นับตามเวลาไทย ค่าใช้จ่ายคำนวณจากจำนวน token ตามราคาของ Anthropic' },
      h('div', { class: 'ai-budget' },
        h('div', { class: 'ai-budget-line' }, h('span', null, 'ใช้ไปแล้ว'), h('strong', { class: 'num' }, usd(total)), h('span', { class: 'muted' }, `จากงบ ${usd(budget)}`)),
        h('div', { class: pct >= 90 ? 'tone-warn' : '' }, h('div', { class: 'meter', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(pct)), 'aria-label': 'งบที่ใช้ไปแล้ว' },
          h('span', { class: 'meter-fill', style: `width:${pct.toFixed(1)}%` })))),
      rows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'rtable ai-usage' },
        h('thead', null, h('tr', null, ['ผู้ใช้', 'ถามวันนี้', 'ถามเดือนนี้', 'ค่าใช้จ่ายเดือนนี้'].map((t, i) => h('th', { scope: 'col', class: i ? 'num' : null }, t)))),
        h('tbody', null, rows.map(([id, r]) => h('tr', null,
          h('td', { 'data-label': 'ผู้ใช้' }, h('strong', null, name(id)), h('div', { class: 'muted small' }, mail(id))),
          h('td', { 'data-label': 'ถามวันนี้', class: 'num' }, String(r.today)),
          h('td', { 'data-label': 'ถามเดือนนี้', class: 'num' }, String(r.month)),
          h('td', { 'data-label': 'ค่าใช้จ่ายเดือนนี้', class: 'num' }, usd(r.cost)))))))
        : h('p', { class: 'muted' }, 'เดือนนี้ยังไม่มีใครถามผู้ช่วย AI')));
  }
  drawUsage();

  mount(box,
    panel('การตั้งค่าผู้ช่วย AI', { sub: 'ทุกคนที่ได้รับอนุมัติถามผู้ช่วยได้ ใช้ API key ของคุณ ผู้ช่วยอ่านได้เฉพาะข้อมูลที่ผู้ถามมีสิทธิ์เห็น และสั่งงานบอทเองไม่ได้' }, form),
    usageBox,
    callout('info', 'ถ้าผู้ช่วยยังตอบไม่ได้',
      h('p', null, 'ต้องสร้างฟังก์ชัน chat ใน Supabase และใส่ ANTHROPIC_API_KEY ครั้งเดียว ', h('a', { href: SETUP_URL, target: '_blank', rel: 'noopener' }, 'ดูขั้นตอน'))));
}
