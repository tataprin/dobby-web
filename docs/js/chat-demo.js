// Demo mode only (SPEC 10.4): a scripted stand-in for the AI assistant. It reads the demo data through DemoApi and
// streams a fixed-pattern answer, so the chat panel can be tried without an Anthropic key. No AI is called.
import { ApiError } from './api.js';
import { fmtNum, fmtSigned, fmtThai, sleep } from './util.js';
import { prepareRows, pairTrades, moduleStats, tradeHref } from './journal.js';
import { whyOpened, explainEvent, closeReasonText } from './explain.js';
import { PARAM_BY_KEY, liveValuesFromStatus, formatValue } from './params.js';

const thaiTime = (ms) => (Number.isFinite(ms) ? fmtThai(ms, 'datetime') : '—');
const sideTh = (s) => (s === 'SELL' ? 'ขาย' : 'ซื้อ');

async function loadTrades(api, bot) {
  const rows = prepareRows(await api.journal(bot.id), bot.server_utc_offset_min ?? 0);
  return { rows, trades: pairTrades(rows) };
}

function explainTrade(t, rows) {
  const why = whyOpened(t);
  const mine = rows.filter((r) => r.tag === t.module && r.wall >= (t.openWall ?? 0) && r.wall <= (t.closeWall ?? Infinity));
  const lines = [`**ไม้ ${t.module} ${sideTh(t.side)} ${fmtNum(t.lots)} ล็อต** เปิดเมื่อ ${thaiTime(t.openUtc)} ที่ราคา ${fmtNum(t.openPrice)}`, ''];
  lines.push('**ทำไมบอทเปิดไม้นี้**');
  for (const l of why.lines.length ? why.lines : [`บันทึกของ EA: ${why.raw || 'ไม่มีรายละเอียด'}`]) lines.push(`- ${l}`);
  lines.push('', '**เกิดอะไรขึ้นต่อ**');
  for (const r of mine.filter((x) => x.event !== 'OPEN').slice(0, 8)) lines.push(`- ${thaiTime(r.utc)}: ${explainEvent(r, t).text}`);
  if (!t.open) lines.push('', `สรุป: ${closeReasonText(t.reason)} ${t.pnl >= 0 ? 'ได้' : 'เสีย'} ${fmtSigned(t.pnl)}`);
  else lines.push('', 'ไม้นี้ยังเปิดอยู่');
  if (t.key) lines.push('', `[ดูกราฟของไม้นี้](${tradeHref(t.key)})`);
  return lines.join('\n');
}

function summaryText(trades, days) {
  const from = Date.now() - days * 86400e3;
  const recent = trades.filter((t) => !t.open && (t.closeUtc ?? 0) >= from);
  if (!recent.length) return `ช่วง ${days} วันที่ผ่านมายังไม่มีไม้ที่ปิดแล้ว`;
  const s = moduleStats(recent);
  const lines = [`**${days} วันที่ผ่านมา** ปิดไปแล้ว ${s.total.trades} ไม้ ชนะ ${s.total.wins} ไม้ (${fmtNum(s.total.winRate, 0)}%) รวม ${fmtSigned(s.total.net)}`, '',
    '| สูตร | ไม้ | ชนะ | กำไร/ขาดทุน |', '|---|---|---|---|'];
  for (const r of s.rows) lines.push(`| ${r.module} | ${r.trades} | ${fmtNum(r.winRate, 0)}% | ${fmtSigned(r.net)} |`);
  const best = recent.reduce((a, b) => (b.pnl > a.pnl ? b : a));
  lines.push('', `ไม้ที่ดีที่สุดคือ ${best.module} เมื่อ ${thaiTime(best.closeUtc)} ได้ ${fmtSigned(best.pnl)}`);
  lines.push('ผลนี้คือผลที่ผ่านมา ไม่ได้บอกว่าสัปดาห์หน้าจะเป็นแบบเดียวกัน');
  return lines.join('\n');
}

function statusText(bot, st, ctl) {
  if (!st) return `ยังไม่มีสถานะล่าสุดจาก ${bot.name} (เครื่องอาจออฟไลน์)`;
  const a = st.account || {}, v = st.virtual || {};
  const open = (st.positions || []).filter((p) => p.open);
  const d = (ctl && ctl.desired) || {};
  const lines = [`**${bot.name}** ตอนนี้${d.control && d.control.mode === 'pause' ? 'หยุดเข้าไม้ใหม่ไว้' : 'ทำงานปกติ'}`];
  lines.push(`- ยอดเงินในบัญชี ${fmtNum(a.balance)} ${a.currency || ''}`.trim());
  if (Number.isFinite(Number(v.day_pnl))) lines.push(`- กำไร/ขาดทุนวันนี้ ${fmtSigned(Number(v.day_pnl))}`);
  lines.push(open.length ? `- มีไม้เปิดอยู่ ${open.length} ไม้: ${open.map((p) => `${p.module} ${sideTh(p.side)}`).join(', ')}` : '- ตอนนี้ไม่มีไม้เปิดอยู่');
  return lines.join('\n');
}

function lockProposal(bot, st, ctl) {
  const cur = { ...liveValuesFromStatus(st).values, ...(((ctl && ctl.desired) || {}).params || {}) };
  const at = Number(cur.InpLock1AtPct ?? 82), to = Number(cur.InpLock1ToPct ?? 80), top = Number(cur.InpLockAtPct ?? 95);
  const nAt = Math.min(at + 3, top - 2), nTo = Math.min(to + 3, nAt - 1);
  const ch = [['InpLock1Enable', cur.InpLock1Enable, true], ['InpLock1AtPct', at, nAt], ['InpLock1ToPct', to, nTo]]
    .filter(([, a, b]) => a !== b)
    .map(([key, from, to2]) => ({ key, label: PARAM_BY_KEY[key].label, from: from === undefined ? '—' : formatValue(PARAM_BY_KEY[key], from), to: formatValue(PARAM_BY_KEY[key], to2) }));
  return { id: `demo-${Date.now()}`, bot_id: bot.id, bot_name: bot.name, changes: ch,
    summary: `ให้ล็อกชั้นแรกเริ่มเมื่อกำไรถึง ${nAt}% ของทางไป TP แล้วย้าย SL ไปที่ ${nTo}%`,
    caution: 'ล็อกช้าลงเล็กน้อยแต่เก็บกำไรได้มากขึ้นเมื่อราคาไปต่อ ถ้าราคากลับตัวเร็ว ไม้ที่เคยล็อกได้อาจกลับไปโดน SL เดิม ค่านี้ยังไม่เคยทดสอบย้อนหลังกับข้อมูลจริงของคุณ' };
}

export async function demoChat(api, { conversationId, message, context }, onEvent, signal) {
  const ai = api.aiDb();
  const c = ai.config;
  if (!c.enabled) throw new ApiError('ai_disabled');
  const limit = api.isAdmin() ? c.admin_daily_limit : c.member_daily_limit;
  if (api.aiUsedToday(api.uidCur) >= limit) throw new ApiError('ai_daily_limit');
  const check = () => { if (signal && signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; } };
  const nowIso = () => new Date().toISOString();

  let conv = conversationId ? ai.convs.find((x) => x.id === conversationId && x.user_id === api.uidCur) : null;
  if (conversationId && !conv) throw new ApiError('conversation_not_found');
  if (!conv) {
    conv = { id: `demo-conv-${ai.seq++}`, user_id: api.uidCur, title: message.trim().slice(0, 60), created_at: nowIso(), updated_at: nowIso() };
    ai.convs.push(conv);
  }
  ai.msgs.push({ id: ai.seq++, conversation_id: conv.id, role: 'user', content: message, context, created_at: nowIso() });
  ai.usage.push({ user_id: api.uidCur, ts: nowIso(), model: c.model, status: 'ok', cost_usd: 0.06, input_tokens: 21000, output_tokens: 1100 });
  onEvent({ type: 'start', conversation_id: conv.id, title: conv.title });
  await sleep(350); check();

  const bots = [...(await api.listBots()), ...(api.isAdmin() ? await api.adminBots() : [])];
  const bot = bots.find((b) => b.id === context.bot_id) || bots[0];
  let text = '';
  const proposals = [];
  const status = async (t) => { onEvent({ type: 'status', text: t }); await sleep(500); check(); };
  if (!bot) text = 'ยังไม่มีบอทที่เชื่อมกับบัญชีนี้ เชื่อมเครื่องก่อนที่หน้า "เครื่องของฉัน" แล้วค่อยถามเรื่องไม้ได้';
  else if (/ทำไม|เปิดไม้|ไม้นี้|เกิดอะไร|ไม้ล่าสุด/.test(message) || context.trade_key) {
    await status('กำลังดูรายละเอียดไม้…');
    const { rows, trades } = await loadTrades(api, bot);
    const t = (context.trade_key && trades.find((x) => x.key === context.trade_key)) || [...trades].reverse().find((x) => x.openUtc);
    text = t ? explainTrade(t, rows) : 'ยังไม่พบไม้ในประวัติของบอทนี้';
  } else if (/สรุป|ผล|กำไร|ขาดทุน|สัปดาห์|เดือน|win|ชนะ/i.test(message)) {
    await status('กำลังดูประวัติเทรด…');
    const { trades } = await loadTrades(api, bot);
    await status('กำลังคำนวณสถิติ…');
    text = summaryText(trades, /เดือน/.test(message) ? 30 : 7);
  } else if (/เปลี่ยน|ปรับ|ลอง|ล็อก|ตั้งค่า|ค่า/.test(message)) {
    await status('กำลังดูค่าที่ตั้งไว้…');
    const [s, ctl] = await Promise.all([api.botStatus(bot.id), api.botControl(bot.id)]);
    if (bot.owner !== api.uidCur) {
      text = `${bot.name} เป็นบอทของสมาชิกคนอื่น ผู้ช่วยดูค่าให้ได้ แต่เสนอให้เปลี่ยนไม่ได้ เพราะคุณสั่งงานบอทนี้ไม่ได้`;
    } else {
      const p = lockProposal(bot, s && s.status, ctl);
      text = ['ลองเลื่อนล็อกชั้นแรกให้ช้าลงเล็กน้อย เพื่อให้ไม้ที่วิ่งดีมีโอกาสเก็บกำไรมากขึ้น', '',
        '- ข้อดี: ไม้ที่ไปถึงใกล้ TP จะล็อกกำไรได้สูงขึ้น',
        '- ข้อเสีย: ไม้ที่กลับตัวเร็วอาจไม่ทันล็อก', '',
        'ผมเตรียมค่าไว้ในการ์ดด้านล่างแล้ว ยังไม่มีอะไรเปลี่ยนจนกว่าคุณจะกดส่งเองในหน้าตั้งค่าบอท'].join('\n');
      proposals.push(p);
    }
  } else if (/ตอนนี้|สถานะ|ทำอะไร|ยอด|เงิน/.test(message)) {
    await status('กำลังดูสถานะบอท…');
    const [s, ctl] = await Promise.all([api.botStatus(bot.id), api.botControl(bot.id)]);
    text = statusText(bot, s && s.status, ctl);
  } else {
    text = ['ถามได้ทุกเรื่องเกี่ยวกับบัญชีและบอทของคุณ เช่น', '',
      '- ทำไมไม้นี้ถึงเปิด และเกิดอะไรขึ้นกับไม้นี้',
      '- สรุปผลสัปดาห์นี้หรือเดือนนี้ แยกตามสูตร',
      '- ตอนนี้บอททำอะไรอยู่ มีไม้เปิดไหม',
      '- ลองเปลี่ยนค่านี้ดีไหม (ผู้ช่วยจะเสนอค่าให้ แล้วคุณกดใช้เอง)', '',
      'นี่คือโหมดตัวอย่าง คำตอบจึงเป็นแบบจำลอง เมื่อใช้งานจริง ผู้ช่วยจะอ่านข้อมูลจริงของบัญชีคุณผ่าน Claude'].join('\n');
  }

  for (let i = 0; i < text.length; i += 14) {
    onEvent({ type: 'text', delta: text.slice(i, i + 14) });
    await sleep(18); check();
  }
  for (const p of proposals) onEvent({ type: 'proposal', proposal: p });
  const msg = { id: ai.seq++, conversation_id: conv.id, role: 'assistant', content: text, context: { proposals, tools: [] }, created_at: nowIso() };
  ai.msgs.push(msg);
  conv.updated_at = nowIso();
  onEvent({ type: 'done', message_id: msg.id, used_today: api.aiUsedToday(api.uidCur), limit_today: limit });
}
