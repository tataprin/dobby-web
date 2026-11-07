// Audit: who changed what, when (control, presets, bot deletes, invites, admin actions).
import { h, icon, fmtThai, errorState, loadingState, emptyState, callout } from '../util.js';
import { app, isAdmin } from '../state.js';
import { panel, pageHead } from '../views.js';

const ACTIONS = {
  control: 'เปลี่ยนคำสั่งบอท',
  preset_insert: 'สร้างพรีเซ็ต', preset_update: 'แก้พรีเซ็ต', preset_delete: 'ลบพรีเซ็ต',
  bot_delete: 'ลบบอท',
  invite_redeem: 'ใช้รหัสเชิญ',
  profile_display_name: 'เปลี่ยนชื่อที่แสดง',
  admin_create_invite: 'สร้างรหัสเชิญ', admin_revoke_invite: 'ยกเลิกรหัสเชิญ', admin_set_user: 'แก้สิทธิ์ผู้ใช้',
  admin_bootstrap_invite: 'รหัสเชิญแอดมินเริ่มต้น',
};
const GROUP = (a) => (a === 'control' || a === 'bot_delete' ? 'bot' : a.startsWith('preset_') ? 'preset' : a.startsWith('admin_') || a.startsWith('invite_') ? 'admin' : 'other');
const FILTERS = [['', 'ทั้งหมด'], ['bot', 'คำสั่งบอท'], ['preset', 'พรีเซ็ต'], ['admin', 'ผู้ใช้และรหัสเชิญ'], ['other', 'อื่น ๆ']];

export async function render(root, ctx) {
  root.append(pageHead('บันทึกการเปลี่ยนแปลง', 'ทุกการเปลี่ยนแปลงถูกบันทึกโดยฐานข้อมูล ใคร เมื่อไร ก่อนและหลัง', null, 'settings'));
  if (isAdmin()) {
    root.append(callout('info', null, h('p', null, 'ในฐานะผู้ดูแล คุณเห็นรายการของตัวเองทั้งหมด และเห็นเฉพาะรายการผู้ใช้/รหัสเชิญของคนอื่น คำสั่งบอทและพรีเซ็ตของเพื่อนเป็นข้อมูลส่วนตัว จึงไม่แสดงที่นี่')));
  }
  const filterBox = h('div', { class: 'filters' });
  const listBox = h('div');
  root.append(filterBox, listBox);
  listBox.append(loadingState());
  let rows = [], names = {};
  try {
    rows = await ctx.api.listAudit({ limit: 500 });
    if (isAdmin()) {
      try { for (const u of await ctx.api.adminOverview()) names[u.user_id] = u.display_name || u.email; } catch { /* names optional */ }
    }
  } catch (e) { listBox.replaceChildren(errorState(e, () => ctx.route())); return; }
  const botName = (id) => { const b = app.bots.find((x) => x.id === id); return b ? b.name : id ? 'บอทที่ลบแล้วหรือของผู้ใช้อื่น' : ''; };
  const actor = (id) => (!id ? 'ระบบ' : app.user && id === app.user.id ? 'คุณ' : names[id] || `ผู้ใช้ ${String(id).slice(0, 8)}`);

  let group = '', bot = '', shown = 100;
  const groupSel = h('select', { class: 'input select', 'aria-label': 'ประเภท', onchange: (e) => { group = e.target.value; shown = 100; draw(); } },
    FILTERS.map(([v, t]) => h('option', { value: v }, t)));
  const botIds = [...new Set(rows.map((r) => r.bot_id).filter(Boolean))];
  const botSel = h('select', { class: 'input select', 'aria-label': 'บอท', onchange: (e) => { bot = e.target.value; shown = 100; draw(); } },
    h('option', { value: '' }, 'ทุกบอท'), botIds.map((id) => h('option', { value: id }, botName(id))));
  filterBox.append(h('div', { class: 'row gap wrap' }, groupSel, botIds.length > 1 ? botSel : null));

  function draw() {
    const list = rows.filter((r) => (!group || GROUP(r.action) === group) && (!bot || r.bot_id === bot));
    if (!list.length) { listBox.replaceChildren(emptyState('ยังไม่มีรายการ', 'เมื่อมีการเปลี่ยนคำสั่ง พรีเซ็ต หรือผู้ใช้ รายการจะขึ้นที่นี่')); return; }
    listBox.replaceChildren(panel(null, {},
      h('ol', { class: 'audit-list' }, list.slice(0, shown).map((r) => {
        const changes = diffLines(r.before, r.after, r.action);
        return h('li', { class: `audit g-${GROUP(r.action)}` },
          h('div', { class: 'audit-head' },
            h('span', { class: 'audit-action' }, ACTIONS[r.action] || r.action),
            r.bot_id ? h('span', { class: 'chip' }, botName(r.bot_id)) : null,
            h('span', { class: 'muted small' }, `${actor(r.actor)} เมื่อ ${fmtThai(Date.parse(r.ts), 'seconds')}`)),
          changes.length ? h('ul', { class: 'changes' }, changes.slice(0, 10).map((c) => h('li', null, c)), changes.length > 10 ? h('li', { class: 'muted' }, `และอีก ${changes.length - 10} รายการ`) : null)
            : h('p', { class: 'muted small' }, 'ไม่มีค่าที่เปลี่ยน'),
          h('details', null, h('summary', null, 'ดูข้อมูลดิบ'),
            h('div', { class: 'grid-2 tight' },
              h('div', null, h('p', { class: 'small muted' }, 'ก่อน'), h('pre', { class: 'json' }, JSON.stringify(r.before, null, 1) || 'null')),
              h('div', null, h('p', { class: 'small muted' }, 'หลัง'), h('pre', { class: 'json' }, JSON.stringify(r.after, null, 1) || 'null')))));
      })),
      list.length > shown ? h('div', { class: 'row center' }, h('button', { class: 'btn', type: 'button', onclick: () => { shown += 100; draw(); } }, `แสดงเพิ่ม (เหลืออีก ${list.length - shown})`)) : null));
  }
  draw();
}

const short = (v) => {
  if (v === undefined) return '(ไม่มี)';
  if (v === null) return 'null';
  if (v === '') return '(ว่าง)';
  if (typeof v === 'object') return Array.isArray(v) ? `${v.length} รายการ` : `${Object.keys(v).length} ค่า`;
  const s = String(v);
  return s.length > 40 ? s.slice(0, 40) + '…' : s;
};

// Human lines for the interesting differences between two JSON values.
export function diffLines(before, after, action) {
  if (action === 'control') return controlDiff(before || {}, after || {});
  if (!before && after) return Object.entries(after).filter(([k]) => k !== 'params' && k !== 'id' && k !== 'owner').map(([k, v]) => `${k}: ${short(v)}`);
  if (before && !after) return Object.entries(before).filter(([k]) => k !== 'params' && k !== 'id' && k !== 'owner').map(([k, v]) => `${k}: ${short(v)} (ลบ)`);
  const out = [];
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const k of keys) {
    if (['updated_at', 'created_at', 'id', 'owner'].includes(k)) continue;
    const a = (before || {})[k], b = (after || {})[k];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    if (k === 'params' && a && b && typeof a === 'object' && typeof b === 'object') {
      for (const p of new Set([...Object.keys(a), ...Object.keys(b)])) if (JSON.stringify(a[p]) !== JSON.stringify(b[p])) out.push(`${p}: ${short(a[p])} → ${short(b[p])}`);
    } else out.push(`${k}: ${short(a)} → ${short(b)}`);
  }
  return out;
}

function controlDiff(a, b) {
  const out = [];
  const ac = a.control || {}, bc = b.control || {};
  if (!!a.live !== !!b.live) out.push(b.live ? 'เปิดเทรดจริง' : 'ปิดเทรดจริง');
  const lab = { mode: 'โหมด', lots: 'ล็อต', allow_long: 'ฝั่งซื้อ', allow_short: 'ฝั่งขาย', max_spread: 'สเปรดสูงสุด', note: 'หมายเหตุ' };
  for (const k of new Set([...Object.keys(ac), ...Object.keys(bc)])) {
    if (JSON.stringify(ac[k] ?? null) === JSON.stringify(bc[k] ?? null)) continue;
    const fmt = (v) => (v === null || v === undefined || v === '' ? 'ตาม EA' : v === 'pause' ? 'หยุดชั่วคราว' : v === 'run' ? 'ทำงาน' : v === true ? 'เปิด' : v === false ? 'ปิด' : String(v));
    out.push(`${lab[k] || k}: ${fmt(ac[k])} → ${fmt(bc[k])}`);
  }
  const ab = a.blackouts || [], bb = b.blackouts || [];
  const key = (x) => `${x.from_utc}|${x.to_utc}`;
  const aSet = new Set(ab.map(key)), bSet = new Set(bb.map(key));
  for (const x of bb) if (!aSet.has(key(x))) out.push(`เพิ่มช่วงงดเข้าไม้ ${fmtThai(Date.parse(x.from_utc), 'short')} ถึง ${fmtThai(Date.parse(x.to_utc), 'time')}${x.label ? ` (${x.label})` : ''}`);
  for (const x of ab) if (!bSet.has(key(x))) out.push(`ลบช่วงงดเข้าไม้ ${fmtThai(Date.parse(x.from_utc), 'short')}${x.label ? ` (${x.label})` : ''}`);
  const ap = a.params || null, bp = b.params || null;
  if (JSON.stringify(ap) !== JSON.stringify(bp)) {
    if (!bp) out.push('หยุดส่งค่าพรีเซ็ตจากเว็บ');
    else if (!ap) out.push(`ส่งค่าพรีเซ็ต ${Object.keys(bp).length} ค่า`);
    else for (const k of Object.keys(bp)) if (JSON.stringify(ap[k]) !== JSON.stringify(bp[k])) out.push(`${k}: ${short(ap[k])} → ${short(bp[k])}`);
  }
  if (!out.length && !Object.keys(a).length) out.push('ลงทะเบียนบอท (คำสั่งแรก)');
  return out;
}
