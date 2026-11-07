// Shared bot helpers: desired-state JSON, online/pending state, agent rejections, effective EA state.
import { app, emit } from './state.js';
import { ApiError } from './api.js';
import { h, icon, agoSeconds, copyButton, serverToUtc, callout } from './util.js';

// desired JSON (bot_control.desired), as written by this website:
// { live: bool,
//   control: { mode: 'run'|'pause', lots: number|null, allow_long: bool, allow_short: bool, max_spread: number|null, note: string },
//   blackouts: [{ from_utc: ISO, to_utc: ISO, label: string }],
//   params: null | { <SPEC 4.2 key>: value } }
// Unknown fields written by other parts are preserved.
const num = (x) => (x === null || x === undefined || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));

export function normDesired(d) {
  const src = d && typeof d === 'object' ? JSON.parse(JSON.stringify(d)) : {};
  const c = src.control && typeof src.control === 'object' ? src.control : {};
  return {
    ...src,
    live: !!src.live,
    control: {
      ...c,
      mode: c.mode === 'pause' ? 'pause' : 'run',
      lots: num(c.lots),
      allow_long: c.allow_long !== false,
      allow_short: c.allow_short !== false,
      max_spread: num(c.max_spread),
      note: c.note ?? src.note ?? '',
    },
    blackouts: Array.isArray(src.blackouts) ? src.blackouts.filter((b) => b && b.from_utc && b.to_utc) : [],
    params: src.params && typeof src.params === 'object' ? src.params : null,
  };
}

// Read-modify-write with optimistic concurrency (version); one retry on a conflict.
export async function patchDesired(botId, mutate) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctl = await app.api.botControl(botId);
    if (!ctl) throw new ApiError('not_found', 'no bot_control row', 'บอทนี้ยังไม่มีแถวควบคุม ให้รัน python dobby_agent.py register ที่เครื่องอีกครั้ง');
    const next = normDesired(ctl.desired);
    mutate(next);
    try {
      const row = await app.api.updateDesired(botId, next, ctl.version);
      emit('control-updated', row);
      return row;
    } catch (e) {
      if (e.code === 'version_conflict' && attempt === 0) continue;
      throw e;
    }
  }
  return null;
}

export function onlineInfo(bot, st) {
  const now = Date.now();
  const seenAge = bot && bot.last_seen ? (now - Date.parse(bot.last_seen)) / 1000 : Infinity;
  let hbAge = Infinity;
  if (st && Number.isFinite(st.heartbeat_gmt_unix)) hbAge = now / 1000 - st.heartbeat_gmt_unix;
  else if (bot && bot.agent_state && Number.isFinite(bot.agent_state.ea_heartbeat_age_s)) hbAge = bot.agent_state.ea_heartbeat_age_s;
  return { online: seenAge < 60 && hbAge < 120, agentOnline: seenAge < 60, eaOnline: hbAge < 120, seenAge, hbAge };
}

export function onlineBadge(info) {
  if (info.online) return h('span', { class: 'badge good' }, h('span', { class: 'dot' }), 'ออนไลน์');
  if (!info.agentOnline) {
    return h('span', { class: 'badge off', title: 'เอเจนต์บนเครื่องไม่ได้ส่งข้อมูลเกิน 60 วินาที' }, h('span', { class: 'dot' }),
      Number.isFinite(info.seenAge) ? `ออฟไลน์ (เห็นล่าสุด ${agoSeconds(Math.round(info.seenAge))})` : 'ยังไม่เคยออนไลน์');
  }
  return h('span', { class: 'badge warn', title: 'เอเจนต์ทำงาน แต่ EA ไม่ได้อัปเดตไฟล์สถานะเกิน 120 วินาที' }, icon('warn'),
    `EA ไม่ตอบสนอง (${Number.isFinite(info.hbAge) ? agoSeconds(Math.round(info.hbAge)) : 'ไม่มีสถานะ'})`);
}

export function appliedVersion(bot) {
  const v = bot && bot.agent_state && bot.agent_state.applied_version;
  return Number.isFinite(Number(v)) ? Number(v) : 0;
}
export const isPending = (bot, ctl) => !!(ctl && appliedVersion(bot) < ctl.version);

export function pendingChip(bot, ctl, info) {
  if (!ctl) return null;
  if (!isPending(bot, ctl)) {
    return h('span', { class: 'chip good', title: `คำสั่งรุ่น ${ctl.version}` }, icon('check'), `เครื่องรับคำสั่งแล้ว (v${ctl.version})`);
  }
  return h('span', { class: 'chip pending', title: `เว็บ v${ctl.version} / เครื่อง v${appliedVersion(bot)}` },
    h('span', { class: 'pulse', 'aria-hidden': 'true' }),
    info && !info.agentOnline ? 'รอเครื่องรับคำสั่ง (เครื่องออฟไลน์)' : 'รอเครื่องรับคำสั่ง');
}

const LIMITS = 'python dobby_agent.py limits';
const REJECTIONS = {
  live_not_allowed_locally: {
    title: 'เครื่องนี้ไม่อนุญาตให้เว็บเปิดเทรดจริง',
    text: 'เอเจนต์คงค่าเดิมไว้ ถ้าต้องการให้เว็บเปิดได้ ให้รันคำสั่งนี้ที่เครื่องนั้น แล้วกดเปิดเทรดจริงอีกครั้ง',
    cmd: `${LIMITS} --allow-live on`,
  },
  params_not_allowed_locally: {
    title: 'เครื่องนี้ไม่รับพรีเซ็ตจากเว็บ',
    text: 'ค่าพรีเซ็ตไม่ถูกส่งไปที่ EA เปิดรับที่เครื่องด้วยคำสั่งนี้ และใน EA v3.04 ตั้ง InpRemoteParams = true',
    cmd: `${LIMITS} --allow-params on`,
  },
  remote_control_disabled: {
    title: 'เครื่องนี้ปิดการควบคุมจากเว็บ',
    text: 'เอเจนต์ไม่เขียนไฟล์ควบคุมเลย คำสั่งจากเว็บทุกอย่างจะไม่ถูกใช้',
    cmd: `${LIMITS} --allow-control on`,
  },
  lots_clamped: {
    title: 'ล็อตเกินเพดานของเครื่อง จึงถูกลดลงเหลือเท่าเพดาน',
    text: 'เพดานล็อตเปลี่ยนได้ที่เครื่องเท่านั้น',
    cmd: `${LIMITS} --max-lots 0.10`,
  },
  params_lots_over_limit: {
    title: 'ล็อตในพรีเซ็ตเกินเพดานของเครื่อง ทั้งชุดถูกปฏิเสธ',
    text: 'ลดล็อตในพรีเซ็ต หรือเพิ่มเพดานที่เครื่อง',
    cmd: `${LIMITS} --max-lots 0.10`,
  },
  params_cap_over_limit: {
    title: 'จุดหยุดรายวันในพรีเซ็ตเกินเพดานของเครื่อง ทั้งชุดถูกปฏิเสธ',
    text: 'ลด InpDailyCapPct ในพรีเซ็ต หรือเพิ่มเพดานที่เครื่อง',
    cmd: `${LIMITS} --max-cap 10`,
  },
  params_unknown_key: {
    title: 'พรีเซ็ตมีค่าที่ส่งจากเว็บไม่ได้ ทั้งชุดถูกปฏิเสธ',
    text: 'ส่งได้เฉพาะค่าที่มีป้าย "ส่งจากเว็บได้" ค่าอื่นต้องโหลด .set ที่เครื่อง',
  },
  params_need_ea_v304: {
    title: 'EA บนเครื่องนี้ยังไม่ใช่ v3.04 จึงรับพรีเซ็ตจากเว็บไม่ได้',
    text: 'อัปเดต EA เป็น v3.04 (หน้าดาวน์โหลด) แล้วตั้ง InpRemoteParams = true',
  },
  params_out_of_bounds: {
    title: 'มีค่าในพรีเซ็ตที่อยู่นอกช่วงที่ EA รับได้ ทั้งชุดถูกปฏิเสธ',
    text: 'ตรวจค่าที่ขึ้นสีแดงในหน้าพรีเซ็ต (เช่น ล็อกขั้นแรกต้องต่ำกว่าขั้นสอง) หรือเพดานของ EA (InpRemoteMaxLots / InpRemoteMaxCapPct) ต่ำกว่าค่าที่ส่ง',
  },
  offset_unknown: {
    title: 'เครื่องยังไม่รู้เวลา server ของโบรก',
    text: 'ยังไม่ได้อ่านสถานะจาก EA ช่วง blackout จึงยังเขียนไม่ได้ ตรวจว่า MT5 เปิดอยู่และ EA ติดชาร์ต หรือตั้งเองใน agent_config.json ช่อง server_utc_offset_min (เช่น 120)',
  },
  bad_blackout: {
    title: 'มีช่วง blackout ที่อ่านไม่ได้ จึงถูกข้าม',
    text: 'ลบแล้วเพิ่มช่วงนั้นใหม่ในหน้าสั่งบอท',
  },
  offset_unconfirmed: {
    title: 'เครื่องยังยืนยันเวลา server ไม่ได้',
    text: 'มักเกิดตอนตลาดปิดหรือ MT5 ปิดอยู่ เวลา blackout อาจคลาดได้จนกว่าราคาจะขยับ ถ้าจำเป็นตั้งเองได้ใน agent_config.json ช่อง server_utc_offset_min (เช่น 120)',
  },
};

export function rejectionInfo(entry) {
  const code = typeof entry === 'string' ? entry : (entry && (entry.code || entry.reason)) || 'unknown';
  const detail = typeof entry === 'object' && entry ? (entry.detail || entry.message || '') : '';
  const base = code.split(':')[0];
  let info = REJECTIONS[base];
  if (!info) {
    if (/live/.test(base)) info = REJECTIONS.live_not_allowed_locally;
    else if (/cap/.test(base)) info = REJECTIONS.params_cap_over_limit;
    else if (/lot/.test(base)) info = /param/.test(base) ? REJECTIONS.params_lots_over_limit : REJECTIONS.lots_clamped;
    else if (/param/.test(base)) info = REJECTIONS.params_not_allowed_locally;
    else if (/control/.test(base)) info = REJECTIONS.remote_control_disabled;
  }
  return { code, detail, ...(info || { title: `เอเจนต์ปฏิเสธคำสั่ง (${code})`, text: 'ดูรายละเอียดใน agent_decisions.log ที่เครื่องนั้น' }) };
}

export function cmdBlock(cmd) {
  return h('div', { class: 'cmd' }, h('code', null, cmd), copyButton(cmd, 'คัดลอก'));
}

export function rejectionsBlock(bot, st) {
  const out = [];
  const as = (bot && bot.agent_state) || {};
  const list = Array.isArray(as.rejected) ? as.rejected : as.rejected ? [as.rejected] : [];
  const warns = Array.isArray(as.warnings) ? as.warnings.filter((w) => !list.includes(w)) : [];
  for (const r of [...list, ...warns]) {
    const info = rejectionInfo(r);
    out.push(callout('warn', info.title,
      h('p', null, info.text, info.detail ? ` (${info.detail})` : ''),
      info.cmd ? h('p', { class: 'muted small' }, 'รันในโฟลเดอร์ของเอเจนต์บนเครื่องนั้น:') : null,
      info.cmd ? cmdBlock(info.cmd) : null,
      h('p', { class: 'muted small' }, `รหัส: ${info.code}`)));
  }
  if (as.last_error) out.push(callout('critical', 'เอเจนต์รายงานข้อผิดพลาด', h('p', null, String(as.last_error))));
  if (st && st.remote && st.remote.rejects) out.push(callout('warn', 'EA ปฏิเสธค่าจากเว็บ (REMOTE REJECT)', h('p', null, String(st.remote.rejects))));
  if (st && st.control && st.control.warn) out.push(callout('warn', 'EA เตือนเรื่องไฟล์ควบคุม', h('p', null, String(st.control.warn))));
  return out.length ? h('div', { class: 'stack' }, out) : null;
}

// Blackout windows in status.control.blackouts are [from, to] server-time strings.
export function activeBlackout(st, offsetMin) {
  const list = (st && st.control && st.control.blackouts) || [];
  const now = Date.now();
  for (const b of list) {
    const from = serverToUtc(Array.isArray(b) ? b[0] : b.from, offsetMin), to = serverToUtc(Array.isArray(b) ? b[1] : b.to, offsetMin);
    if (from <= now && now < to) return { from, to };
  }
  return null;
}

export function effectiveState(st, bot, ctl) {
  if (!st) return { tone: 'off', label: 'ยังไม่มีสถานะจาก EA', text: 'เมื่อเอเจนต์บนเครื่องอ่านไฟล์สถานะได้ ข้อมูลจะขึ้นที่นี่' };
  const off = bot ? bot.server_utc_offset_min : 0;
  const v = st.virtual || {}, a = st.account || {}, f = st.flags || {}, c = st.control || {};
  const open = (st.positions || []).filter((p) => p.open).length;
  if (v.killed) return { tone: 'critical', label: 'หยุดถาวร', text: 'พอร์ตจำลองแตะจุดตัดขาดทุน (InpKillBalance) EA ไม่เปิดไม้ใหม่' };
  if (a.connected === false) return { tone: 'critical', label: 'MT5 ไม่ได้เชื่อมต่อโบรกเกอร์', text: 'ตรวจอินเทอร์เน็ตหรือการล็อกอินบัญชีใน MT5 ที่เครื่อง' };
  if (f.live_locked) return { tone: 'warn', label: 'EA ล็อกการเทรดจริง', text: 'บัญชีจริงแต่ InpAllowLive = false ตั้งค่านี้ที่เครื่อง (หรือใช้ v3.04 กับ InpRemoteLive = true)' };
  if (a.trade_permitted === false) return { tone: 'warn', label: 'ปุ่ม Algo Trading ปิดอยู่', text: 'กดปุ่ม Algo Trading บนแถบเครื่องมือของ MT5 ที่เครื่อง ให้เป็นสีเขียว' };
  const keep = open ? ` ไม้ที่เปิดอยู่ ${open} ไม้ยังมี SL/TP ตามเดิม` : '';
  if (c.mode === 'pause') {
    const d = ctl ? normDesired(ctl.desired) : null;
    if (d && !d.live && d.control.mode !== 'pause') return { tone: 'paused', label: 'ปิดเทรดจริงอยู่', text: `สวิตช์เทรดจริงปิด บอทไม่เปิดไม้ใหม่${keep}` };
    if (d && d.live && d.control.mode !== 'pause') {
      return isPending(bot, ctl)
        ? { tone: 'paused', label: 'ปิดเทรดจริงอยู่', text: `รอเครื่องรับคำสั่งเปิดเทรดจริง${keep}` }
        : { tone: 'warn', label: 'ปิดเทรดจริงอยู่', text: `เว็บสั่งเปิดแล้ว แต่เครื่องยังไม่เปิดเทรดจริง ดูคำเตือน${keep}` };
    }
    return { tone: 'paused', label: 'หยุดชั่วคราว', text: `ไม่เปิดไม้ใหม่${keep}` };
  }
  const bo = activeBlackout(st, off);
  if (bo) return { tone: 'paused', label: 'ช่วงงดเข้าไม้', text: 'อยู่ในช่วงงดเข้าไม้ (ข่าว) ไม่เปิดไม้ใหม่จนกว่าจะพ้นช่วง' };
  if (v.day_cap_hit) return { tone: 'warn', label: 'ถึงจุดหยุดรายวัน', text: 'วันนี้ไม่เปิดไม้ใหม่แล้ว เริ่มใหม่วันพรุ่งนี้ (ตามเวลาเซิร์ฟเวอร์)' };
  return { tone: 'good', label: 'กำลังทำงาน', text: open ? `มีไม้เปิดอยู่ ${open} ไม้` : 'รอสัญญาณ ยังไม่มีไม้เปิด' };
}
