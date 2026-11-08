// SPEC 7: the simple bot settings model shared by the website and the app.
// The editor keeps a full params object (every SPEC 4.2 remote key); the simple fields read and write those keys.
// Nothing here talks to the API.
import { normalizeParams, remoteSubset, REMOTE_KEYS, PARAM_BY_KEY, sameValue, coerce, liveValuesFromStatus } from './params.js';
import { calculate, HORIZON30, BASE_BALANCE } from './lotcalc.js';
import { fmtNum, fmtSigned } from './util.js';

// 7.1 bot catalog (one kind today; the kind is implied, no DB field)
export const BOT_KINDS = [
  { id: 'dobby', name: 'Dobby', text: 'บอททอง XAUUSD กราฟ 15 นาที 3 สูตร (A_new, NY, C5G) + ASIA16 เสริม' },
];

export const STRATS = [
  { id: 'A_new', use: 'InpUseA', lots: 'InpLotsA', lock: 'InpLock_A', title: 'A_new', text: 'จับจังหวะราคากลับตัว ทำงานได้ทั้งวัน' },
  { id: 'NY', use: 'InpUseNY', lots: 'InpLotsNY', lock: 'InpLock_NY', title: 'NY', text: 'เข้าตามการเบรกกรอบราคาตอนตลาดนิวยอร์กเปิด (ช่วงค่ำเวลาไทย)' },
  { id: 'C5G', use: 'InpUseC5G', lots: 'InpLotsC5G', lock: 'InpLock_C5G', title: 'C5G', text: 'เข้าตามแนวโน้มเมื่อราคาย่อมาแตะเส้นค่าเฉลี่ย (VWAP)' },
];
export const ASIA = { id: 'ASIA16', use: 'InpUseAsia', lots: 'InpLotsAsia', title: 'เอเชีย (ASIA16)', text: 'สูตรเสริม: ซื้อช่วงตลาดเอเชียเปิด ปิดไม้ช่วงบ่าย ล็อตคงที่' };
const MOD_LOT_KEYS = STRATS.map((s) => s.lots);

const r2 = (x) => Math.round(Number(x) * 100) / 100;
const r1 = (x) => Math.round(Number(x) * 10) / 10;
export const pctText = (x) => (Number.isInteger(r1(x)) ? String(r1(x)) : fmtNum(x, 1));

// ------------------------------------------------------------------ reading
export function lockMode(v) {
  if (v.InpLockEnable && v.InpLock1Enable && v.InpLock1AtPct > 0) return 2;
  if (v.InpLockEnable) return 1;
  if (v.InpLock1Enable && v.InpLock1AtPct > 0) return 2;
  return 0;
}
export const lotsSame = (v) => MOD_LOT_KEYS.every((k) => sameValue(v[k], v[MOD_LOT_KEYS[0]]));
export const enabledStrats = (v) => STRATS.filter((s) => v[s.use]);
export function mainLot(v) {
  const on = enabledStrats(v);
  const list = (on.length ? on : STRATS).map((s) => v[s.lots]);
  return Math.max(...list);
}

// Values the bot uses now. EA v3.04: status.remote.effective (complete). Older EA: what status.params/options expose.
// Returns { values (full normalized params), known: Set of keys the status reported, source, readOnly }.
export function currentValues(st, fallbackParams) {
  const { values, source } = liveValuesFromStatus(st);
  const base = normalizeParams({ ...(fallbackParams || {}), ...values });
  return { values: base, known: new Set(Object.keys(values)), source, readOnly: !(st && st.remote) };
}

// ------------------------------------------------------------------ writing
export function setLotsAll(v, lot) {
  for (const k of MOD_LOT_KEYS) v[k] = r2(lot);
  v.InpMaxLots = r2(lot);
}
export function syncMaxLots(v) {
  v.InpMaxLots = r2(Math.max(...MOD_LOT_KEYS.map((k) => v[k])));
}
export function setLockMode(v, mode) {
  v.InpLockEnable = mode >= 1;
  v.InpLock1Enable = mode === 2;
  if (mode === 2 && !(v.InpLock1AtPct >= 10)) { v.InpLock1AtPct = 85; v.InpLock1ToPct = 83; }
  if (mode >= 1 && !(v.InpLock_A || v.InpLock_NY || v.InpLock_C5G)) { v.InpLock_A = true; v.InpLock_NY = true; v.InpLock_C5G = true; }
  fixHiddenLocks(v);
}
// The EA checks the bounds of every lock key even when that stage is off (SPEC 4.2/4.3): keep hidden values valid.
export function fixHiddenLocks(v) {
  if (!v.InpLock1Enable && v.InpLock1AtPct > 0) {
    if (v.InpLock1AtPct > v.InpLockAtPct - 0.5) v.InpLock1AtPct = Math.max(10, r1(v.InpLockAtPct - 10));
    if (v.InpLock1AtPct > v.InpLockAtPct - 0.5) v.InpLock1AtPct = 0;
    const lim = Math.min(v.InpLock1AtPct, v.InpLockToPct) - 0.5;
    if (v.InpLock1AtPct > 0 && (v.InpLock1ToPct > lim || v.InpLock1ToPct < 1)) v.InpLock1ToPct = Math.max(1, r1(lim - 1.5));
  }
}

// SPEC 7.3 "ตั้งให้อัตโนมัติจากทุน"
export function autoLot(balance) {
  const b = Number(balance);
  if (!(b > 0)) return 0.01;
  return Math.min(0.5, Math.max(0.01, Math.floor(b / 100 + 1e-9) / 100));
}
export function autoFromBalance(base, balance) {
  const L = autoLot(balance);
  const v = normalizeParams({ ...base });
  Object.assign(v, {
    InpUseA: true, InpUseNY: true, InpUseC5G: true, InpUseAsia: false, InpLotsAsia: 0.01,
    InpVirtualStart: Math.round(Number(balance)),
    InpLockEnable: true, InpLockAtPct: 95, InpLockToPct: 93, InpLock1Enable: true, InpLock1AtPct: 85, InpLock1ToPct: 83,
    InpLock_A: true, InpLock_NY: true, InpLock_C5G: true,
    InpRecoveryMult: 1.5, InpMaxAttempts: 4, InpConfluenceMult: 1.5, InpConfluenceMin: 60,
    InpDailyCapPct: 10, InpMaxSpread: 1.0, InpVolGate: false,
  });
  setLotsAll(v, L);
  return v;
}
// The PC's local defaults that go with an auto lot (shown as advice only; set in the app).
export const suggestedLocalMaxLots = (L) => Math.min(0.5, Math.max(0.02, r2(2 * L)));

// The full set of remote keys sent as desired.params (never InpAllowLive or local-only inputs).
export function toDesiredParams(v) {
  const out = remoteSubset(normalizeParams(v));
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

// ------------------------------------------------------------------ plain Thai text
export function lotsText(v) {
  const on = enabledStrats(v);
  if (!on.length) return 'ไม่มีสูตรที่เปิด';
  const lots = on.map((s) => v[s.lots]);
  if (lots.every((x) => sameValue(x, lots[0]))) return `ล็อต ${fmtNum(lots[0])} ${on.length > 1 ? 'ทุกสูตร' : ''}`.trim();
  return 'ล็อต ' + on.map((s) => `${s.title} ${fmtNum(v[s.lots])}`).join(' / ');
}
export function lockText(v, short = false) {
  const m = lockMode(v);
  const near = `${pctText(v.InpLockAtPct)}→${pctText(v.InpLockToPct)}`;
  const first = `${pctText(v.InpLock1AtPct)}→${pctText(v.InpLock1ToPct)}`;
  if (m === 0) return 'ไม่ล็อกกำไร';
  if (m === 1) return short ? `ล็อก 1 ชั้น (${near})` : `ล็อก 1 ชั้น (${near})`;
  return `ล็อก 2 ชั้น (${first}, ${near})`;
}
export function strategiesText(v) {
  const on = enabledStrats(v);
  if (!on.length) return 'ปิดทุกสูตร';
  if (on.length === STRATS.length) return `เปิด ${on.length} สูตร`;
  return `เปิด ${on.length} สูตร (${on.map((s) => s.title).join(', ')})`;
}
// The capital the bot counts. EA v3.04: virtual = InpVirtualStart + the bot's own P&L since its start date (SPEC 9.8),
// so on a bot the summaries show that sum (pnl from rounds.js botPnlOf); a preset (no bot) shows InpVirtualStart.
const capitalOf = (v, pnl) => Math.round((Number(v.InpVirtualStart) + (Number(pnl) || 0)) * 100) / 100;
const capitalText = (v, pnl) => { const x = capitalOf(v, pnl); return fmtNum(x, Number.isInteger(x) ? 0 : 2); };
// Short parts (presets, lists): "เปิด 3 สูตร", "ล็อต 0.03 ทุกสูตร", "ทุน 300 USD", "ล็อก 2 ชั้น (85→83, 95→93)", ...
export function summaryParts(v, currency = 'USD') {
  return [
    strategiesText(v),
    lotsText(v),
    `ทุน ${fmtNum(v.InpVirtualStart, 0)} ${currency}`.trim(),
    lockText(v),
    v.InpUseAsia ? `เอเชียเปิด ${fmtNum(v.InpLotsAsia)}` : 'เอเชียปิด',
    `หยุดเมื่อขาดทุน ${pctText(v.InpDailyCapPct)}%/วัน`,
  ];
}
// One plain Thai sentence: "เปิด 3 สูตร ล็อต 0.03 ทุกสูตร จากทุน 300 USD ล็อกกำไร 2 ชั้น (85→83 และ 95→93) ปิดสูตรเอเชีย
// และหยุดเปิดไม้เมื่อขาดทุนถึง 10% ต่อวัน"
export function summaryText(v, currency = 'USD', pnl = 0) {
  const m = lockMode(v);
  const near = `${pctText(v.InpLockAtPct)}→${pctText(v.InpLockToPct)}`;
  const first = `${pctText(v.InpLock1AtPct)}→${pctText(v.InpLock1ToPct)}`;
  const lock = m === 0 ? 'ไม่ล็อกกำไร' : m === 1 ? `ล็อกกำไร 1 ชั้น (${near})` : `ล็อกกำไร 2 ชั้น (${first} และ ${near})`;
  const asia = v.InpUseAsia ? `เปิดสูตรเอเชีย ${fmtNum(v.InpLotsAsia)} ล็อต` : 'ปิดสูตรเอเชีย';
  return `${strategiesText(v)} ${lotsText(v)} จากทุน ${capitalText(v, pnl)} ${currency} ${lock} ${asia} และหยุดเปิดไม้เมื่อขาดทุนถึง ${pctText(v.InpDailyCapPct)}% ต่อวัน`.replace(/\s+/g, ' ').trim();
}

// Label / value pairs for "ค่าที่บอทใช้อยู่ตอนนี้" (pnl given: a bot, "ทุนของบอท" = the capital it counts) and presets.
export function summaryRows(v, currency = 'USD', pnl = null) {
  const on = enabledStrats(v);
  const m = lockMode(v);
  return [
    ['สูตรที่เปิด', on.length ? on.map((s) => s.title).join(', ') : 'ปิดทุกสูตร'],
    ['ล็อตต่อไม้', on.length ? lotsText(v).replace(/^ล็อต /, '') : '—'],
    pnl === null ? ['ทุนตั้งต้น', `${fmtNum(v.InpVirtualStart, 0)} ${currency}`.trim()] : ['ทุนของบอท', `${capitalText(v, pnl)} ${currency}`.trim()],
    ['ล็อกกำไร', m === 0 ? 'ไม่ล็อก' : m === 1 ? `1 ชั้น ${pctText(v.InpLockAtPct)}→${pctText(v.InpLockToPct)}` : `2 ชั้น ${pctText(v.InpLock1AtPct)}→${pctText(v.InpLock1ToPct)}, ${pctText(v.InpLockAtPct)}→${pctText(v.InpLockToPct)}`],
    ['สูตรเอเชีย', v.InpUseAsia ? `เปิด ${fmtNum(v.InpLotsAsia)} ล็อต` : 'ปิด'],
    ['ขาดทุนสูงสุดต่อวัน', `${pctText(v.InpDailyCapPct)}%`],
  ];
}

const onOffText = (b) => (b ? 'เปิด' : 'ปิด');
// Field descriptors used to list (and count) changes in plain Thai.
const FIELDS = [
  { label: 'ทุนของบอท', text: (v, c, pnl) => `${capitalText(v, pnl)} ${c}` },
  ...STRATS.map((s) => ({ label: `สูตร ${s.title}`, text: (v) => onOffText(v[s.use]) })),
  { label: 'ล็อต', text: (v) => lotsText(v).replace(/^ล็อต /, '') },
  { label: 'สูตรเอเชีย', text: (v) => (v.InpUseAsia ? `เปิด ล็อต ${fmtNum(v.InpLotsAsia)}` : 'ปิด') },
  { label: 'ล็อกกำไร', text: (v) => lockText(v) },
  { label: 'ขาดทุนสูงสุดต่อวัน', text: (v) => `${pctText(v.InpDailyCapPct)}%` },
  { label: 'ล็อกใช้กับสูตร', text: (v) => STRATS.filter((s) => v[s.lock]).map((s) => s.title).join(', ') || 'ไม่มี', adv: true },
  { label: 'ไม้แก้หลังแพ้ (recovery)', text: (v) => `×${fmtNum(v.InpRecoveryMult, 1)}`, adv: true },
  { label: 'ไม้สูงสุดต่อสูตรต่อวัน', text: (v) => `${v.InpMaxAttempts} ไม้`, adv: true },
  { label: 'สัญญาณตรงกัน (confluence)', text: (v) => (v.InpConfluenceMult > 1 ? `×${fmtNum(v.InpConfluenceMult, 1)} ภายใน ${v.InpConfluenceMin} นาที` : `ปิด (×1.0, ${v.InpConfluenceMin} นาที)`), adv: true },
  { label: 'สเปรดสูงสุด', text: (v) => `${fmtNum(v.InpMaxSpread)} $`, adv: true },
  { label: 'ตัวกรองความผันผวน (vol gate)', text: (v) => (v.InpVolGate ? `เปิด ${fmtNum(v.InpVolGatePct)}%` : `ปิด (${fmtNum(v.InpVolGatePct)}%)`), adv: true },
];
export function describeChanges(from, to, currency = 'USD', pnl = 0) {
  const out = [];
  for (const f of FIELDS) {
    const a = f.text(from, currency, pnl), b = f.text(to, currency, pnl);
    if (a !== b) out.push({ label: f.label, from: a, to: b, adv: !!f.adv });
  }
  const keyDiff = REMOTE_KEYS.filter((k) => !sameValue(from[k], to[k]));
  if (!out.length && keyDiff.length) out.push({ label: 'ค่าอื่น ๆ', from: '', to: keyDiff.join(', '), adv: true });
  return out;
}

// ------------------------------------------------------------------ validation (Thai, with what to do)
// ceilings: { lots, cap, botName } (the lower of the EA remote ceilings and the PC's local limits)
export function validateSimple(v, ceil = {}) {
  const e = {};
  const name = ceil.botName ? `ของเครื่อง ${ceil.botName}` : 'ของเครื่อง';
  const fixLots = 'ลดล็อตลง หรือเพิ่ม "ล็อตสูงสุดที่เว็บสั่งได้" ในแอป Dobby ที่เครื่องนั้น (ตั้งค่า → ความปลอดภัย)';
  const lotErr = (x) => {
    if (!(x >= 0.01)) return 'ล็อตต้องอย่างน้อย 0.01';
    if (ceil.lots != null && x > ceil.lots + 1e-9) return `ล็อต ${fmtNum(x)} เกินเพดาน${name} (${fmtNum(ceil.lots)}) — ${fixLots}`;
    if (x > 5) return 'ล็อตสูงเกินไป';
    return null;
  };
  for (const s of STRATS) { const m = lotErr(v[s.lots]); if (m) e[s.lots] = m; }
  if (v.InpUseAsia || !(v.InpLotsAsia >= 0.01)) { const m = lotErr(v.InpLotsAsia); if (m) e.InpLotsAsia = m; }
  if (!(v.InpVirtualStart > 0)) e.InpVirtualStart = 'ใส่ทุนมากกว่า 0';
  else if (v.InpVirtualStart > 10000000) e.InpVirtualStart = 'ทุนสูงเกินไป';
  const capMax = ceil.cap != null ? ceil.cap : 100;
  if (!(v.InpDailyCapPct >= 1)) e.InpDailyCapPct = 'ตั้งได้อย่างน้อย 1%';
  else if (v.InpDailyCapPct > capMax + 1e-9) e.InpDailyCapPct = `ตั้งได้ไม่เกิน ${pctText(capMax)}% (เพดาน${name}) — ลดลง หรือเพิ่มเพดานในแอป Dobby ที่เครื่องนั้น`;
  const at = v.InpLockAtPct, to = v.InpLockToPct, at1 = v.InpLock1AtPct, to1 = v.InpLock1ToPct;
  const mode = lockMode(v);
  if (!(at >= 50 && at <= 99.5)) e.InpLockAtPct = 'ชั้นใกล้ TP ต้องเริ่มที่ 50% ถึง 99.5% ของ TP';
  if (!(to >= 1 && to <= at - 0.5)) e.InpLockToPct = `ต้องเลื่อน SL ไปต่ำกว่าจุดเริ่มล็อก (${pctText(at)}%) อย่างน้อย 0.5%`;
  if (mode === 2 || at1 > 0) {
    if (!(at1 >= 10)) e.InpLock1AtPct = 'ชั้นแรกต้องเริ่มที่ 10% ของ TP ขึ้นไป';
    else if (at1 > at - 0.5) e.InpLock1AtPct = `ชั้นแรกต้องต่ำกว่าชั้นใกล้ TP (${pctText(at)}%) — ลดชั้นแรก หรือเพิ่มชั้นใกล้ TP`;
    const lim = Math.min(at1, to) - 0.5;
    if (!e.InpLock1AtPct && !(to1 >= 1 && to1 <= lim)) e.InpLock1ToPct = `ชั้นแรกต้องเลื่อน SL ไปไม่เกิน ${pctText(lim)}% (ต่ำกว่าจุดเริ่มชั้นแรก และต่ำกว่า SL ของชั้นใกล้ TP)`;
  }
  if (!(v.InpRecoveryMult >= 1 && v.InpRecoveryMult <= 2)) e.InpRecoveryMult = 'ตั้งได้ 1.0 ถึง 2.0';
  if (!(v.InpMaxAttempts >= 1 && v.InpMaxAttempts <= 4 && Number.isInteger(v.InpMaxAttempts))) e.InpMaxAttempts = 'ตั้งได้ 1 ถึง 4 ไม้';
  if (!(v.InpConfluenceMult >= 1 && v.InpConfluenceMult <= 2)) e.InpConfluenceMult = 'ตั้งได้ 1.0 ถึง 2.0';
  if (!(v.InpConfluenceMin >= 0 && v.InpConfluenceMin <= 240)) e.InpConfluenceMin = 'ตั้งได้ 0 ถึง 240 นาที';
  if (!(v.InpMaxSpread >= 0.05 && v.InpMaxSpread <= 2)) e.InpMaxSpread = 'ส่งจากเว็บได้ 0.05 ถึง 2.00';
  if (!(v.InpVolGatePct >= 0.5 && v.InpVolGatePct <= 5)) e.InpVolGatePct = 'ตั้งได้ 0.5 ถึง 5.0%';
  if (!(v.InpKillBalance >= 0)) e.InpKillBalance = 'ต้องไม่ติดลบ';
  return e;
}

// ------------------------------------------------------------------ risk hint (SPEC 5.1 / 7.3)
export function riskHint(balance, lot, currency = 'USD') {
  const c = calculate(balance, lot);
  if (!c) return { tone: 'info', text: 'ใส่ทุนและล็อตเพื่อดูความเสี่ยงโดยประมาณ' };
  if (!c.inRange) {
    const lo = (HORIZON30[0].lot * balance) / BASE_BALANCE, hi = (HORIZON30[HORIZON30.length - 1].lot * balance) / BASE_BALANCE;
    const above = c.eqLot > HORIZON30[HORIZON30.length - 1].lot;
    if (!above) {
      // smaller than anything tested: the smallest tested lot is an upper bound for the risk
      const edge = calculate(balance, lo);
      const hz = edge && edge.horizon;
      if (hz) {
        return {
          tone: 'info', calc: edge,
          text: `ล็อตนี้เล็กกว่าที่ทดสอบไว้ ความเสี่ยงน่าจะต่ำกว่านี้: ที่ล็อต ${fmtNum(lo, 3)} ผลจำลองย้อนหลัง 30 วัน ค่ากลาง ${fmtSigned(hz.median, 0)} ${currency} แต่ 1 ใน 10 ครั้งขาดทุนเกิน ${fmtNum(-hz.p10, 0)} ${currency} และมีโอกาส ${Math.round(hz.halfPct)}% ที่ทุนเหลือครึ่ง`,
        };
      }
    }
    return {
      tone: 'warn',
      text: `ล็อต ${fmtNum(lot)} กับทุน ${fmtNum(balance, 0)} สูงกว่าช่วงที่ทดสอบไว้ (ทุนนี้ทดสอบที่ล็อตราว ${fmtNum(Math.max(0.01, lo), 2)} ถึง ${fmtNum(hi, 2)}) ความเสี่ยงสูงกว่าตัวเลขที่ทดสอบ ลดล็อต หรือกด "ตั้งให้อัตโนมัติจากทุน"`,
    };
  }
  const hz = c.horizon;
  const tone = hz.halfPct >= 45 ? 'warn' : 'info';
  return {
    tone, calc: c,
    text: `ผลจำลองย้อนหลัง 30 วัน: ค่ากลาง ${fmtSigned(hz.median, 0)} ${currency} แต่ 1 ใน 10 ครั้งขาดทุนเกิน ${fmtNum(-hz.p10, 0)} ${currency} และมีโอกาส ${Math.round(hz.halfPct)}% ที่ทุนเหลือครึ่ง`,
  };
}

// Compare a params object with the EA's effective values (only keys the EA reports).
export function matchesEffective(params, effective) {
  if (!params || !effective) return false;
  return Object.keys(params).every((k) => {
    if (!(k in effective) || !PARAM_BY_KEY[k]) return true;
    return sameValue(coerce(PARAM_BY_KEY[k], effective[k]), coerce(PARAM_BY_KEY[k], params[k]));
  });
}
