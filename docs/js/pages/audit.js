// Audit: who changed what, when (control, presets, bot deletes, invites, admin actions). The admin receives every user's
// rows (RLS): each row names who did it and which bot (name + owner), with a filter by user.
import { h, icon, fmtThai, errorState, loadingState, emptyState, callout, field } from '../util.js';
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
  cash_flow_insert: 'เพิ่มเงินฝาก-ถอน', cash_flow_update: 'แก้เงินฝาก-ถอน', cash_flow_delete: 'ลบเงินฝาก-ถอน',
};
const GROUP = (a) => (a === 'control' || a === 'bot_delete' || a.startsWith('cash_flow_') ? 'bot' : a.startsWith('preset_') ? 'preset' : a.startsWith('admin_') || a.startsWith('invite_') ? 'admin' : 'other');
const FILTERS = [['', 'ทั้งหมด'], ['bot', 'คำสั่งบอท'], ['preset', 'พรีเซ็ต'], ['admin', 'ผู้ใช้และรหัสเชิญ'], ['other', 'อื่น ๆ']];

export async function render(root, ctx) {
  root.append(pageHead('บันทึกการเปลี่ยนแปลง', 'ทุกการเปลี่ยนแปลงถูกบันทึกโดยฐานข้อมูล ใคร เมื่อไร ก่อนและหลัง', null, 'settings'));
  if (isAdmin()) {
    root.append(callout('info', null, h('p', null, 'ในฐานะผู้ดูแล คุณเห็นรายการของสมาชิกทุกคน: คำสั่งบอท พรีเซ็ต การลบบอท และผู้ใช้กับรหัสเชิญ เลือกดูทีละคนได้จากช่อง "ผู้ใช้"')));
  }
  const filterBox = h('div', { class: 'audit-filters', role: 'group', 'aria-label': 'ตัวกรอง' });
  const listBox = h('div');
  root.append(filterBox, listBox);
  listBox.append(loadingState());
  let rows = [], names = {}, others = [];
  try {
    rows = await ctx.api.listAudit({ limit: 500 });
    if (isAdmin()) {
      try {
        const [users, bots] = await Promise.all([ctx.api.adminOverview(), ctx.api.adminBots ? ctx.api.adminBots() : []]);
        for (const u of users) names[u.user_id] = u.display_name || u.email;
        others = bots;
      } catch { /* names optional */ }
    }
  } catch (e) { listBox.replaceChildren(errorState(e, () => ctx.route())); return; }
  const me = app.user && app.user.id;
  // every bot this page can name: mine, everyone else's (admin), and deleted ones (from their bot_delete row)
  const botInfo = {};
  for (const b of app.bots) botInfo[b.id] = { name: b.name, owner: b.owner };
  for (const b of others) botInfo[b.id] = { name: b.name, owner: b.owner };
  for (const r of rows) if (r.action === 'bot_delete' && r.bot_id && r.before && !botInfo[r.bot_id]) botInfo[r.bot_id] = { name: r.before.name || 'บอทที่ลบแล้ว', owner: r.before.owner, deleted: true };
  const person = (id) => (!id ? 'ระบบ' : id === me ? 'คุณ' : names[id] || `ผู้ใช้ ${String(id).slice(0, 8)}`);
  // a member's own bot changed by someone else (only the admin can, 2026-11-10): the change is listed without a name.
  // Site owner's decision: members get no notice that the admin changed their bot.
  const actor = (id, r) => (id && id !== me && !names[id] && r && r.action === 'control' && botInfo[r.bot_id] && botInfo[r.bot_id].owner === me ? '' : person(id));
  const botName = (id) => { const b = botInfo[id]; return b ? b.name : id ? 'บอทที่ลบแล้วหรือของผู้ใช้อื่น' : ''; };
  const botLabel = (id) => {
    const b = botInfo[id];
    if (!b) return botName(id);
    return `${b.name}${b.owner && b.owner !== me ? ` ของ ${person(b.owner)}` : ''}${b.deleted ? ' (ลบแล้ว)' : ''}`;
  };
  // the people a row concerns: who did it, the bot's owner, the preset's owner, the user an admin action was about
  const concerns = (r) => {
    const out = new Set([r.actor]);
    if (r.bot_id && botInfo[r.bot_id]) out.add(botInfo[r.bot_id].owner);
    for (const x of [r.before, r.after]) if (x && typeof x === 'object' && x.owner) out.add(x.owner);
    return out;
  };

  let group = '', bot = '', who = '', shown = 100;
  const groupSel = h('select', { class: 'input select', onchange: (e) => { group = e.target.value; shown = 100; draw(); } },
    FILTERS.map(([v, t]) => h('option', { value: v }, t)));
  const botIds = [...new Set(rows.map((r) => r.bot_id).filter(Boolean))];
  const botSel = h('select', { class: 'input select', onchange: (e) => { bot = e.target.value; shown = 100; draw(); } },
    h('option', { value: '' }, 'ทุกบอท'), botIds.map((id) => h('option', { value: id }, botLabel(id))));
  const people = [...new Set(rows.flatMap((r) => [...concerns(r)]).filter(Boolean))].sort((a, b) => (a === me ? -1 : b === me ? 1 : person(a).localeCompare(person(b), 'th')));
  const whoSel = h('select', { class: 'input select', onchange: (e) => { who = e.target.value; shown = 100; draw(); } },
    h('option', { value: '' }, 'ทุกคน'), people.map((id) => h('option', { value: id }, person(id))));
  filterBox.append(field('ประเภท', groupSel), isAdmin() && people.length > 1 ? field('ผู้ใช้', whoSel) : null, botIds.length > 1 ? field('บอท', botSel) : null);

  function draw() {
    const list = rows.filter((r) => (!group || GROUP(r.action) === group) && (!bot || r.bot_id === bot) && (!who || concerns(r).has(who)));
    if (!list.length) { listBox.replaceChildren(emptyState('ยังไม่มีรายการ', 'เมื่อมีการเปลี่ยนคำสั่ง พรีเซ็ต หรือผู้ใช้ รายการจะขึ้นที่นี่')); return; }
    listBox.replaceChildren(panel(null, {},
      h('ol', { class: 'audit-list' }, list.slice(0, shown).map((r) => {
        const changes = diffLines(r.before, r.after, r.action);
        return h('li', { class: `audit g-${GROUP(r.action)}` },
          h('div', { class: 'audit-head' },
            h('span', { class: 'audit-action' }, ACTIONS[r.action] || r.action),
            r.bot_id ? h('span', { class: 'chip' }, icon('monitor'), botLabel(r.bot_id)) : null,
            h('span', { class: 'muted small' }, actor(r.actor, r) ? [h('strong', { class: 'audit-who' }, actor(r.actor, r)), ' '] : null, `เมื่อ ${fmtThai(Date.parse(r.ts), 'seconds')}`)),
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
  const autoLine = (x) => (x && x.enabled ? `เปิด ก่อน ${x.before_min ?? 0} หลัง ${x.after_min ?? 0} นาที` : 'ปิด');
  if (JSON.stringify(a.auto_news || null) !== JSON.stringify(b.auto_news || null)) out.push(`งดช่วงข่าวอัตโนมัติ: ${autoLine(a.auto_news)} → ${autoLine(b.auto_news)}`);
  const schLine = (x) => (x && x.enabled ? `เปิด ${(x.weekly || []).length} ช่วงต่อสัปดาห์${x.us_holidays ? ' และวันหยุดสหรัฐ' : ''}` : 'ปิด');
  if (JSON.stringify(a.schedule || null) !== JSON.stringify(b.schedule || null)) out.push(`ตารางเวลา: ${schLine(a.schedule)} → ${schLine(b.schedule)}`);
  const ap = a.params || null, bp = b.params || null;
  if (JSON.stringify(ap) !== JSON.stringify(bp)) {
    if (!bp) out.push('หยุดส่งค่าพรีเซ็ตจากเว็บ');
    else if (!ap) out.push(`ส่งค่าพรีเซ็ต ${Object.keys(bp).length} ค่า`);
    else for (const k of Object.keys(bp)) if (JSON.stringify(ap[k]) !== JSON.stringify(bp[k])) out.push(`${k}: ${short(ap[k])} → ${short(bp[k])}`);
  }
  if (!out.length && !Object.keys(a).length) out.push('ลงทะเบียนบอท (คำสั่งแรก)');
  return out;
}
