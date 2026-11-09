// Plain-Thai explanations of the EA's journal details (SPEC 9.1 trade page: "ทำไมบอทเปิดไม้นี้" and the timeline).
// Every parser is a best effort: when a detail does not match a known format, the raw text is shown instead.
import { fmtNum, fmtSigned } from './util.js';
import { REASON_LABELS } from './journal.js';

const n = (x) => (x === undefined || x === null || x === '' ? NaN : Number(x));
const px = (x) => fmtNum(x, 2);
const CONTRACT = 100; // XAUUSD: 100 oz per lot, so a 1.00 $ move on 0.01 lot = 1.00 USD

// "d=6.00 tp=9.00 atr=10.75 rsi=39.2 | <reason>"
export function parseOpenDetail(detail) {
  const s = String(detail || '');
  const [head, ...rest] = s.split('|');
  const get = (k) => { const m = new RegExp(`\\b${k}=(-?[\\d.]+)`).exec(head); return m ? Number(m[1]) : NaN; };
  return { d: get('d'), tp: get('tp'), atr: get('atr'), rsi: get('rsi'), reason: rest.join('|').trim(), hasHead: /\bd=/.test(head) };
}

function divergence(reason, side) {
  const m = /(bull|bear)\s*div[a-z]*:\s*(low|high)\s+([\d.]+)\s+rsi\s+([\d.]+)\s+vs\s+earlier\s+(?:low|high)\s+([\d.]+)\s+rsi\s+([\d.]+)/i.exec(reason);
  if (!m) return null;
  const bull = m[1].toLowerCase() === 'bull';
  const [p1, r1, p0, r0] = [n(m[3]), n(m[4]), n(m[5]), n(m[6])];
  return bull
    ? `ราคาลงไปทำจุดต่ำใหม่ที่ ${px(p1)} ต่ำกว่าจุดต่ำก่อนหน้า ${px(p0)} แต่ RSI กลับไม่ต่ำตาม (${fmtNum(r1, 1)} เทียบกับ ${fmtNum(r0, 1)}) แปลว่าแรงขายเริ่มหมด (bullish divergence) บอทจึง${side === 'SELL' ? 'ขาย' : 'ซื้อ'}เพื่อรอราคาเด้งกลับ`
    : `ราคาขึ้นไปทำจุดสูงใหม่ที่ ${px(p1)} สูงกว่าจุดสูงก่อนหน้า ${px(p0)} แต่ RSI กลับไม่สูงตาม (${fmtNum(r1, 1)} เทียบกับ ${fmtNum(r0, 1)}) แปลว่าแรงซื้อเริ่มหมด (bearish divergence) บอทจึง${side === 'BUY' ? 'ซื้อ' : 'ขาย'}เพื่อรอราคาย่อกลับ`;
}

function vwapTouch(reason) {
  const m = /C5G\s+(long|short):\s*VWAP\s+([\d.]+)\s+touched,\s*close\s+([\d.]+),\s*RSI\s+hook\s+([\d.]+)\s*->\s*([\d.]+)/i.exec(reason);
  if (!m) return null;
  const long = m[1].toLowerCase() === 'long';
  return long
    ? `ราคาย่อลงมาแตะเส้น VWAP (ราคาเฉลี่ยถ่วงปริมาณของวัน) ที่ ${px(m[2])} แล้วแท่งปิดเหนือเส้นที่ ${px(m[3])} และ RSI หักหัวขึ้นจาก ${fmtNum(n(m[4]), 1)} เป็น ${fmtNum(n(m[5]), 1)} บอทจึงซื้อตามแรงที่กลับขึ้นมา`
    : `ราคาเด้งขึ้นมาแตะเส้น VWAP (ราคาเฉลี่ยถ่วงปริมาณของวัน) ที่ ${px(m[2])} แล้วแท่งปิดใต้เส้นที่ ${px(m[3])} และ RSI หักหัวลงจาก ${fmtNum(n(m[4]), 1)} เป็น ${fmtNum(n(m[5]), 1)} บอทจึงขายตามแรงที่กลับลงไป`;
}

// "range 4029.94-4041.68 spread 0.20 d=8.00 -> buy stop 4042.08 / sell stop 4029.74"
export function parseArm(detail) {
  const s = String(detail || '');
  const r = /range\s+([\d.]+)\s*-\s*([\d.]+)/i.exec(s);
  const buy = /buy\s+stop\s+(?:at\s+)?([\d.]+)/i.exec(s), sell = /sell\s+stop\s+(?:at\s+)?([\d.]+)/i.exec(s);
  if (!r && !buy && !sell) return null;
  const a = r ? n(r[1]) : NaN, b = r ? n(r[2]) : NaN;
  const sp = /spread\s+([\d.]+)/i.exec(s), d = /\bd=([\d.]+)/.exec(s);
  return { lo: Math.min(a, b), hi: Math.max(a, b), buy: buy ? n(buy[1]) : NaN, sell: sell ? n(sell[1]) : NaN, spread: sp ? n(sp[1]) : NaN, d: d ? n(d[1]) : NaN };
}

function nyBreakout(armRow, side) {
  const a = armRow && parseArm(armRow.detail);
  if (!a || !Number.isFinite(a.lo)) return null;
  const up = side !== 'SELL';
  return `บอทจับกรอบราคาของแท่งเปิดตลาดนิวยอร์กได้ ${px(a.lo)} ถึง ${px(a.hi)} แล้วตั้งคำสั่งรอไว้สองทาง: ซื้อเมื่อราคาทะลุขึ้น${Number.isFinite(a.buy) ? `ที่ ${px(a.buy)}` : ''} และขายเมื่อราคาหลุดลง${Number.isFinite(a.sell) ? `ที่ ${px(a.sell)}` : ''} ราคา${up ? 'ทะลุขึ้น' : 'หลุดลง'}ก่อน จึงได้ไม้${up ? 'ซื้อ' : 'ขาย'}`;
}

// "ทำไมบอทเปิดไม้นี้": a list of plain sentences, and whether the formats were understood (else the caller shows raw).
// trade: from pairTrades; ctx: { signal, arm, order } journal rows of the same trade (optional)
export function whyOpened(trade, ctx = {}) {
  const o = parseOpenDetail(trade.openDetail);
  const lines = [];
  let understood = false;
  const reason = o.reason || '';
  const mod = trade.module;
  let main = null;
  if (mod === 'A_new' || /div/i.test(reason)) main = divergence(reason, trade.side);
  if (!main && (mod === 'C5G' || /VWAP/i.test(reason))) main = vwapTouch(reason);
  if (!main && mod === 'NY') main = nyBreakout(ctx.arm, trade.side) || (/NY\s+(long|short)/i.test(reason) ? nyBreakout({ detail: reason }, trade.side) : null);
  if (!main && ctx.signal && /divergence/i.test(ctx.signal.detail || '')) {
    main = `เจอสัญญาณ divergence ${/bear/i.test(ctx.signal.detail) ? 'ขาลง' : 'ขาขึ้น'} บนแท่ง M15 ที่เพิ่งปิด`;
  }
  if (main) { lines.push(main); understood = true; }
  const lots = Number(trade.lots) || 0;
  if (Number.isFinite(o.d) && o.d > 0) {
    const risk = o.d * CONTRACT * lots, reward = Number.isFinite(o.tp) ? o.tp * CONTRACT * lots : NaN;
    lines.push(`ตั้ง SL ห่างราคาเข้า ${fmtNum(o.d)} $ (ถ้าโดน เสียราว ${fmtNum(risk)} ที่ ${fmtNum(lots)} ล็อต)`
      + (Number.isFinite(o.tp) ? ` และ TP ห่าง ${fmtNum(o.tp)} $ (ถ้าถึง ได้ราว ${fmtNum(reward)}) กำไรที่หวังเป็น ${fmtNum(o.tp / o.d, 1)} เท่าของความเสี่ยง` : ''));
    understood = true;
  }
  const facts = [];
  if (Number.isFinite(o.atr)) facts.push(`ATR (ระยะแกว่งเฉลี่ยต่อแท่ง) ${fmtNum(o.atr)} $`);
  if (Number.isFinite(o.rsi)) facts.push(`RSI ${fmtNum(o.rsi, 1)}`);
  if (facts.length) lines.push(`ตอนเปิดไม้: ${facts.join(' และ ')}`);
  if (trade.step) lines.push(`เป็นไม้แก้ขั้นที่ ${trade.step} หลังไม้ก่อนหน้าของสูตรนี้แพ้ ล็อตจึงใหญ่ขึ้นตามตัวคูณที่ตั้งไว้`);
  return { lines, understood, raw: trade.openDetail || '' };
}

const RETCODES = {
  10004: 'โบรกเสนอราคาใหม่ (requote)', 10006: 'โบรกปฏิเสธคำสั่ง', 10014: 'ขนาดล็อตไม่ถูกต้อง', 10015: 'ราคาไม่ถูกต้อง',
  10016: 'ระดับ SL/TP ใกล้ราคาเกินไปหรือไม่ถูกต้อง', 10018: 'ตลาดปิดอยู่', 10019: 'เงินในบัญชีไม่พอ', 10027: 'ปุ่ม Algo Trading ใน MT5 ปิดอยู่',
};

export function closeReasonText(reason) {
  return {
    TP: 'ราคาถึง TP', SL: 'ราคาโดน SL', LOCK: 'ราคาย้อนกลับมาโดน SL ที่เลื่อนมาล็อกกำไรไว้', TIME: 'ถือครบเวลาสูงสุดของสูตร บอทจึงปิดเอง',
    FLAT: 'ปิดตอนสิ้นวันตามกติกาของสูตร', MANUAL: 'ปิดด้วยมือ', RUN: 'โหมด runner: ราคาผ่าน TP แล้ววิ่งต่อ จนย้อนกลับมาโดน SL กันกำไรที่ขยับตามไว้',
  }[reason] || (reason ? `ปิดไม้ (${REASON_LABELS[reason] || reason})` : 'ปิดไม้');
}

// One timeline row -> { text, understood }. trade gives side / lots for nicer wording (optional).
export function explainEvent(r, trade = {}) {
  const d = String(r.detail || '');
  const side = r.side && r.side !== 'NONE' ? r.side : trade.side;
  const sideTh = side === 'SELL' ? 'ขาย' : 'ซื้อ';
  let m;
  switch (r.event) {
    case 'SIGNAL':
      if (/divergence/i.test(d)) return { text: `เจอสัญญาณ divergence ${/bear/i.test(d) ? 'ขาลง' : 'ขาขึ้น'} บนแท่ง M15 ที่เพิ่งปิด`, understood: true };
      break;
    case 'ARM': {
      const a = parseArm(d);
      if (a && Number.isFinite(a.lo)) {
        return { text: `จับกรอบราคา NY ได้ ${px(a.lo)} ถึง ${px(a.hi)} ตั้งคำสั่งรอ${Number.isFinite(a.buy) ? ` ซื้อที่ ${px(a.buy)}` : ''}${Number.isFinite(a.sell) ? ` และขายที่ ${px(a.sell)}` : ''}${Number.isFinite(a.d) ? ` (SL ห่าง ${fmtNum(a.d)} $)` : ''}`, understood: true };
      }
      break;
    }
    case 'ORDER':
      if ((m = /(buy|sell)\s+(stop|limit)\s+at\s+([\d.]+)(?:\s+d=([\d.]+))?/i.exec(d))) {
        return { text: `ตั้งคำสั่งรอ${m[1].toLowerCase() === 'buy' ? 'ซื้อ' : 'ขาย'}ที่ ${px(m[3])}${m[4] ? ` (SL ห่าง ${fmtNum(n(m[4]))} $)` : ''}`, understood: true };
      }
      break;
    case 'OPEN':
      if (r.price > 0) {
        return { text: `เปิดไม้${sideTh} ${fmtNum(r.lots)} ล็อต ที่ ${px(r.price)}${r.sl > 0 ? ` SL ${px(r.sl)}` : ''}${r.tp > 0 ? ` TP ${px(r.tp)}` : ''}`, understood: true };
      }
      break;
    case 'NEAR1': case 'NEARTP':
      if ((m = /gain\s+([\d.]+)\s*=\s*([\d.]+)%\s*of\s+TP\s+([\d.]+)/i.exec(d))) {
        const stage = r.event === 'NEAR1' ? 'ชั้นแรก' : 'ชั้นใกล้ TP';
        const off = /\b(off|shadow)\b/i.test(d) ? ` (${stage}ปิดอยู่ จึงยังไม่เลื่อน SL)` : '';
        return { text: `กำไรวิ่งถึง ${fmtNum(n(m[2]), 0)}% ของทางไป TP (${fmtNum(n(m[1]))} จาก ${fmtNum(n(m[3]))} $) ถึงจุดล็อก${stage}${off}`, understood: true };
      }
      break;
    case 'LOCK1': case 'LOCK':
      if ((m = /gain\s+([\d.]+)\s*>=\s*([\d.]+)%\s*of\s+TP\s+([\d.]+)\s*->\s*SL\s+([\d.]+)\s+locks\s+about\s+([+-]?[\d.]+)\s*\(([\d.]+)%\)/i.exec(d))) {
        return { text: `เลื่อน SL ไปที่ ${px(m[4])} ล็อกกำไรไว้ราว ${fmtSigned(n(m[5]))} (${fmtNum(n(m[6]), 0)}% ของทางไป TP) ถ้าราคาย้อนกลับ ไม้นี้ยังปิดเป็นกำไร`, understood: true };
      }
      break;
    case 'SHADOWLOCK': case 'SHADOWLOCK1':
      if ((m = /move\s+SL\s+to\s+([\d.]+)/i.exec(d))) return { text: `ล็อกเงา (ปิดอยู่): ถ้าเปิดไว้ SL จะเลื่อนไปที่ ${px(m[1])} บอทแค่จดไว้ ไม่ได้เลื่อนจริง`, understood: true };
      break;
    case 'CLOSE': {
      const reason = (/reason=(\w+)/.exec(d) || [])[1] || '';
      const parts = [closeReasonText(reason)];
      if (r.price > 0) parts.push(`ที่ ${px(r.price)}`);
      const pnl = Number(r.pnl);
      if (Number.isFinite(pnl)) parts.push(pnl >= 0 ? `ได้ ${fmtSigned(pnl)}` : `เสีย ${fmtSigned(pnl)}`);
      let text = parts.join(' ');
      if (/NY win: no more NY trades today/i.test(d)) text += ' และเพราะ NY ชนะแล้ว วันนี้จะไม่เปิด NY อีก';
      return { text, understood: !!reason };
    }
    case 'DAYCAP':
      if ((m = /day\s+P&L\s+(-?[\d.]+)\s*<=\s*-?([\d.]+)%\s*of\s+(?:the\s+day\s+start\s+)?([\d.]+)/i.exec(d))) {
        return { text: `ขาดทุนวันนี้ ${fmtSigned(n(m[1]))} ถึงจุดหยุด ${fmtNum(n(m[2]), 0)}% ของทุนต้นวัน ${fmtNum(n(m[3]))} วันนี้บอทไม่เปิดไม้ใหม่แล้ว`, understood: true };
      }
      break;
    // EA v3.05 (SPEC 11): "RUN_ON price <p> sl <s> target <t>", "RUN_UP k <n> sl <s> target <t>", DAYCAP_RESET "day P&L <a> -> 0.00, day start <b> -> <c>, token <t>" / "IGNORED: <reason>"
    case 'RUN_ON':
      if ((m = /sl\s+([\d.]+).*?target\s+([\d.]+)/i.exec(d))) return { text: `ราคาถึง TP แล้ว โหมด runner ไม่ปิดไม้: เลื่อน SL กันกำไรไปที่ ${px(m[1])} และตั้งเป้าถัดไปที่ ${px(m[2])}`, understood: true };
      break;
    case 'RUN_UP':
      if ((m = /k\s*=?\s*(\d+).*?sl\s+([\d.]+).*?target\s+([\d.]+)/i.exec(d))) return { text: `runner ถึงเป้า ขยับครั้งที่ ${m[1]}: SL กันกำไรไปที่ ${px(m[2])} เป้าถัดไป ${px(m[3])}`, understood: true };
      break;
    case 'DAYCAP_RESET':
      if (/IGNORED/i.test(d)) return { text: `คำสั่งรีเซ็ตจุดหยุดรายวันถูกข้าม (${d.replace(/^.*IGNORED:\s*/i, '')})`, understood: true };
      if ((m = /day\s+P&L\s+(-?[\d.]+)\s*->\s*(-?[\d.]+).*?day\s+start\s+([\d.]+)\s*->\s*([\d.]+)/i.exec(d))) {
        return { text: `เจ้าของกดรีเซ็ตจุดหยุดรายวัน: กำไรขาดทุนวันนี้ ${fmtSigned(n(m[1]))} เริ่มนับใหม่จาก 0 ทุนต้นวัน ${fmtNum(n(m[3]))} เป็น ${fmtNum(n(m[4]))} บอทเปิดไม้ใหม่ได้อีกวันนี้`, understood: true };
      }
      break;
    case 'CANCEL':
      if ((m = /removed\s+at\s+(\d{1,2}:\d{2})/i.exec(d))) return { text: `ยกเลิกคำสั่งรอตอน ${m[1]} (เวลาเซิร์ฟเวอร์)${/no breakout/i.test(d) ? ' เพราะราคาไม่ทะลุกรอบ' : ''}`, understood: true };
      break;
    case 'SKIP':
      if ((m = /SL\s+distance\s+([\d.]+)\s*>\s*cap\s+([\d.]+)/i.exec(d))) return { text: `ข้ามสัญญาณ: SL ต้องห่าง ${fmtNum(n(m[1]))} $ เกินเพดานของสูตร ${fmtNum(n(m[2]))} $ (เสี่ยงเกินไป)`, understood: true };
      break;
    case 'ERROR':
      if ((m = /retcode\s+(\d+)/i.exec(d))) {
        const why = RETCODES[Number(m[1])];
        return { text: `${/modify|lock/i.test(d) ? 'เลื่อน SL ไม่สำเร็จ' : 'คำสั่งไม่สำเร็จ'}: ${why || `โบรกตอบรหัส ${m[1]}`}`, understood: true };
      }
      break;
    default:
  }
  return { text: d || '—', understood: false };
}
