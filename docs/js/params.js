// Every Dobby3 EA input (v3.03 + the four v3.04 remote inputs, SPEC 4.1, + the eight v3.05 runner inputs, SPEC 11), in EA order.
// key      EA input name (also the .set key and the remote-file key)
// group    display group (GROUPS)
// type     bool | double | int | long | datetime
// def      EA default
// min/max  bounds used by the preset form; rmin/rmax = stricter EA-side bounds for the remote file (SPEC 4.2)
// remote   true only for the SPEC 4.2 allow-list: the web may push it to EA v3.04+ (desired.params)
// advanced hidden behind "แสดงค่าขั้นสูง" in the preset form
// label    Thai label, help = the EA comment
// The remote file also carries one-shot COMMANDS (not inputs, not preset rows): see COMMANDS below.

export const GROUPS = [
  { id: 'modules', title: 'สูตรและขนาดล็อต', en: 'Modules and lots' },
  { id: 'a', title: 'สูตร A_new', en: 'A_new (RSI divergence)' },
  { id: 'ny', title: 'สูตร NY breakout', en: 'NY opening-range breakout' },
  { id: 'c5', title: 'สูตร C5G', en: 'C5G (VWAP + RSI hook)' },
  { id: 'virtual', title: 'พอร์ตจำลองและจุดหยุด', en: 'Virtual portfolio' },
  { id: 'safety', title: 'ความปลอดภัย', en: 'Safety' },
  { id: 'opts', title: 'ตัวเลือก v3.01 และ ASIA16', en: 'v3.01 options' },
  { id: 'lock', title: 'ล็อกกำไรใกล้ TP', en: 'v3.02 near-TP stop lock' },
  { id: 'lock1', title: 'ล็อกขั้นที่ 1', en: 'v3.03 stage-1 lock' },
  { id: 'remote', title: 'รับคำสั่งจากเว็บ (ตั้งที่เครื่องเท่านั้น)', en: 'v3.04 remote (web)' },
  { id: 'runner', title: 'โหมด runner (ปล่อยให้วิ่งหลัง TP)', en: 'v3.05 runner (web)', hint: 'ค่าที่ทดสอบ: เก็บ 75 % / ก้าว 0.5 / ไม่จำกัด' },
];

// The EA version that knows a group's inputs (undefined = every supported EA). Shown only when the bot is at least that.
export const GROUP_SINCE = { runner: 3.05 };
export const RUNNER_SINCE = 3.05;
export const runnerSupported = (eaVersion) => parseFloat(String(eaVersion || '')) >= RUNNER_SINCE;
export const RUNNER_WARNING = 'ทดสอบในคอมแล้ว ยังไม่ผ่าน Strategy Tester กำไรเพิ่มมาจากไม้ส่วนน้อยที่วิ่งไกล';

const B = (key, group, def, label, help, o = {}) => ({ key, group, type: 'bool', def, label, help, remote: false, advanced: false, ...o });
const D = (key, group, def, min, max, step, label, help, o = {}) =>
  ({ key, group, type: 'double', def, min, max, step, label, help, remote: false, advanced: false, ...o });
const I = (key, group, def, min, max, label, help, o = {}) =>
  ({ key, group, type: 'int', def, min, max, step: 1, label, help, remote: false, advanced: false, ...o });
const L = (key, group, def, label, help, o = {}) =>
  ({ key, group, type: 'long', def, min: 1, max: 2147483647, step: 1, label, help, remote: false, advanced: true, ...o });
const R = { remote: true };
const ADV = { advanced: true };

export const PARAMS = [
  // Modules and lots
  B('InpUseA', 'modules', true, 'เปิดสูตร A_new', 'Run A_new (RSI divergence)', R),
  B('InpUseNY', 'modules', true, 'เปิดสูตร NY', 'Run NY opening-range breakout', R),
  B('InpUseC5G', 'modules', true, 'เปิดสูตร C5G', 'Run C5G (VWAP + RSI hook)', R),
  D('InpLotsA', 'modules', 0.02, 0.01, 5, 0.01, 'ล็อต A_new', 'A_new lots', { ...R, lots: true }),
  D('InpLotsNY', 'modules', 0.02, 0.01, 5, 0.01, 'ล็อต NY', 'NY lots', { ...R, lots: true }),
  D('InpLotsC5G', 'modules', 0.02, 0.01, 5, 0.01, 'ล็อต C5G', 'C5G lots', { ...R, lots: true }),
  D('InpMaxLots', 'modules', 0.02, 0.01, 5, 0.01, 'เพดานล็อตทุกสูตร',
    'Ceiling for every base lot (the control file can never exceed it)', { ...R, lots: true }),
  D('InpRecoveryMult', 'modules', 1.0, 1.0, 2.0, 0.1, 'ตัวคูณล็อตไม้แก้', 'Recovery trade lot = base x this (1 = same size)', R),

  // A_new
  D('InpA_SLCap', 'a', 6.0, 1, 50, 0.5, 'SL สูงสุด ($)', 'SL cap $'),
  D('InpA_TPRatio', 'a', 1.5, 0.5, 5, 0.1, 'TP เท่ากับกี่เท่าของ SL', 'TP = ratio x SL'),
  D('InpA_ATRMult', 'a', 1.5, 0.5, 5, 0.1, 'ตัวคูณ ATR ของ SL', 'SL = min(mult x ATR14, cap)'),
  I('InpA_PivotM', 'a', 3, 1, 10, 'จำนวนแท่งแต่ละข้างของ pivot', 'Pivot bars each side', ADV),
  I('InpA_PivotN', 'a', 40, 5, 200, 'ช่วงหาจุดสุดขั้วใหม่ (แท่ง)', 'New N-bar extreme; previous pivot within N', ADV),
  I('InpA_TimeStop', 'a', 48, 1, 500, 'ปิดตามเวลา (แท่ง M15)', 'Time stop, M15 bars'),
  B('InpA_Rollover', 'a', true, 'ไม่เข้าไม้ช่วงข้ามวัน', 'No entries with decision time 23:30-01:15'),

  // NY breakout
  D('InpNY_Cap', 'ny', 8.0, 1, 50, 0.5, 'SL สูงสุด ($)', 'SL cap $'),
  D('InpNY_Floor', 'ny', 3.0, 0.5, 50, 0.5, 'SL ต่ำสุด ($)', 'SL floor $'),
  D('InpNY_ATRMult', 'ny', 2.0, 0.5, 5, 0.1, 'ตัวคูณ ATR ของ SL', 'SL = clip(mult x ATR14 at the range bar, floor, cap)'),
  D('InpNY_TPRatio', 'ny', 1.0, 0.5, 5, 0.1, 'TP เท่ากับกี่เท่าของ SL', 'TP = ratio x SL'),
  D('InpNY_Buffer', 'ny', 0.20, 0, 5, 0.05, 'ระยะเผื่อเบรกเอาต์ ($)', 'Breakout buffer $'),
  I('InpNY_RangeMin', 'ny', 990, 0, 1439, 'แท่งกรอบราคา (นาทีของวัน เวลาเซิร์ฟเวอร์)', 'Range bar open, server minute (990 = 16:30)', { ...ADV, minutes: true }),
  I('InpNY_LastMin', 'ny', 1245, 0, 1439, 'นาทีสุดท้ายที่ตั้งคำสั่ง (เวลาเซิร์ฟเวอร์)',
    'Last decision minute an order is (re)armed (1245 = 20:45, live to 21:00)', { ...ADV, minutes: true }),
  I('InpNY_FlatMin', 'ny', 1380, 0, 1439, 'ปิดไม้ NY ทุกวันเวลา (เวลาเซิร์ฟเวอร์)', 'Flat at this server minute every day (1380 = 23:00)', { ...ADV, minutes: true }),

  // C5G
  D('InpC5_Cap', 'c5', 10.0, 1, 50, 0.5, 'ข้ามไม้ถ้า SL เกิน ($)', 'Skip if SL distance above this $'),
  D('InpC5_Floor', 'c5', 4.0, 0.5, 50, 0.5, 'SL ต่ำสุด ($)', 'SL floor $'),
  D('InpC5_ATRMult', 'c5', 1.0, 0.5, 5, 0.1, 'ตัวคูณ ATR ของ SL', 'SL = max(mult x ATR14, floor)'),
  D('InpC5_TPRatio', 'c5', 1.5, 0.5, 5, 0.1, 'TP เท่ากับกี่เท่าของ SL', 'TP = ratio x SL'),
  I('InpC5_TimeStop', 'c5', 48, 1, 500, 'ปิดตามเวลา (แท่ง M15)', 'Time stop, M15 bars'),
  I('InpC5_MinBars', 'c5', 4, 0, 96, 'แท่งสัญญาณต้องเป็นแท่งที่ N ของวันขึ้นไป', 'Signal bar must be at least the Nth bar of the server day', ADV),
  I('InpC5_Touch', 'c5', 3, 1, 20, 'แตะ VWAP ภายใน N แท่งล่าสุด', 'VWAP touch within the last N bars', ADV),

  // Virtual portfolio
  D('InpVirtualStart', 'virtual', 200.0, 1, 10000000, 1, 'ทุนเริ่มต้นของพอร์ตจำลอง',
    'Virtual starting balance (account currency, USC on the cent account)', { ...R, rminEx: 0 }),
  D('InpKillBalance', 'virtual', 0.0, 0, 10000000, 1, 'หยุดเปิดไม้เมื่อพอร์ตจำลองเหลือ', 'Stop opening at or below this virtual balance (0 = only at 0)', R),
  D('InpDailyCapPct', 'virtual', 10.0, 1, 100, 0.5, 'จุดหยุดรายวัน (% ของทุนต้นวัน)',
    "No new entry once today's closed P&L <= -X% of the day-start balance", { ...R, capPct: true }),
  { key: 'InpStartDate', group: 'virtual', type: 'datetime', def: 0, min: 0, max: 4102444800, step: 1, label: 'เริ่มนับดีลตั้งแต่ (0 = อัตโนมัติ)',
    help: 'Count deals from here (0 = the date Dobby2 remembered / first attach)', remote: false, advanced: true },

  // Safety
  L('InpMagicA', 'safety', 26102402, 'Magic ของ A_new', 'A_new magic (same as Dobby2: history continues)'),
  L('InpMagicNY', 'safety', 26102403, 'Magic ของ NY', 'NY magic'),
  L('InpMagicC5G', 'safety', 26102404, 'Magic ของ C5G', 'C5G magic'),
  D('InpMaxSpread', 'safety', 1.00, 0, 10, 0.05, 'สเปรดสูงสุดที่ยอมเข้าไม้ ($)',
    'No new MARKET entry if Ask-Bid above this $ (0 = off)', { ...R, rmin: 0.05, rmax: 2.0 }),
  B('InpUseControl', 'safety', true, 'อ่านไฟล์ควบคุม', 'Read Common\\Files\\Dobby\\dobby2_control.txt (AI supervisor)', ADV),
  B('InpAllowLive', 'safety', false, 'อนุญาตเทรดบัญชีจริง', 'Must be true to open trades on a REAL account'),
  B('InpControlInTester', 'safety', false, 'อ่านไฟล์ควบคุมใน Strategy Tester', 'Testing only: read the control file in the Strategy Tester too', ADV),

  // v3.01 options
  B('InpVolGate', 'opts', false, 'เปิดตัวกรองความผันผวน', 'NY + C5G trade only when the market is active enough (A always on)', R),
  D('InpVolGatePct', 'opts', 1.75, 0.5, 5.0, 0.05, 'เกณฑ์ความผันผวน (%)',
    'Gate: 20-day average daily range as % of the last close must be >= this', R),
  I('InpMaxAttempts', 'opts', 2, 1, 4, 'จำนวนไม้ต่อสูตรต่อวัน',
    'Trades per module per server day after losses: 2 = v3.00 (entry + 1 recovery), max 4', R),
  D('InpConfluenceMult', 'opts', 1.0, 1.0, 2.0, 0.1, 'ตัวคูณล็อตเมื่อสัญญาณตรงกัน',
    'Lot x this when another module entered the same direction within InpConfluenceMin (1 = off)', R),
  I('InpConfluenceMin', 'opts', 60, 0, 240, 'ช่วงเวลาสัญญาณตรงกัน (นาที)', 'Confluence window, minutes', R),
  B('InpUseAsia', 'opts', false, 'เปิดสูตร ASIA16', 'Run module 4 ASIA16 (long 01:15 -> 16:15 server, Mon-Fri)', R),
  D('InpLotsAsia', 'opts', 0.01, 0.01, 5, 0.01, 'ล็อต ASIA16', 'ASIA16 lots (fixed; research used 0.01)', { ...R, lots: true }),
  L('InpMagicAsia', 'opts', 26102405, 'Magic ของ ASIA16', 'ASIA16 magic'),
  I('InpAsia_EntryMin', 'opts', 75, 0, 1439, 'ASIA16 นาทีแรกที่เข้าไม้ (เวลาเซิร์ฟเวอร์)', 'ASIA16 first entry minute, server (75 = 01:15)', { ...ADV, minutes: true }),
  I('InpAsia_LastMin', 'opts', 120, 0, 1439, 'ASIA16 นาทีสุดท้ายที่เข้าไม้ (เวลาเซิร์ฟเวอร์)',
    'ASIA16 last entry minute, server (120 = 02:00): retry bars while spread is wide', { ...ADV, minutes: true }),
  I('InpAsia_ExitMin', 'opts', 975, 0, 1439, 'ASIA16 นาทีที่ปิดไม้ (เวลาเซิร์ฟเวอร์)', 'ASIA16 exit minute, server (975 = 16:15)', { ...ADV, minutes: true }),
  D('InpAsia_ATRMult', 'opts', 2.0, 0.5, 5, 0.1, 'ASIA16 ตัวคูณ ATR ของ SL', 'ASIA16 SL = clamp(mult x ATR14(H1), floor, cap)', ADV),
  D('InpAsia_SLFloor', 'opts', 8.0, 0.5, 100, 0.5, 'ASIA16 SL ต่ำสุด ($)', 'ASIA16 SL floor $', ADV),
  D('InpAsia_SLCap', 'opts', 20.0, 0.5, 100, 0.5, 'ASIA16 SL สูงสุด ($)', 'ASIA16 SL cap $', ADV),
  D('InpAsia_MaxSpread', 'opts', 0.40, 0, 10, 0.05, 'ASIA16 สเปรดสูงสุด ($)', 'ASIA16: no entry while Ask-Bid above this $', ADV),

  // v3.02 near-TP lock
  B('InpLockEnable', 'lock', false, 'เปิดล็อกกำไรใกล้ TP',
    'Move the SL into profit once the trade is close to its TP (A, NY, C5G; not ASIA16)', R),
  D('InpLockAtPct', 'lock', 95.0, 50, 99.5, 0.5, 'เริ่มล็อกเมื่อกำไรถึง (% ของระยะ TP)',
    'Activate when the floating gain reaches this % of the TP distance', R),
  D('InpLockToPct', 'lock', 93.0, 1, 99, 0.5, 'ย้าย SL ไปที่ (% ของระยะ TP)',
    'New SL = entry +/- this % of the TP distance (must be below InpLockAtPct)', R),
  B('InpLock_A', 'lock', true, 'ใช้กับ A_new', 'Apply to A_new', R),
  B('InpLock_NY', 'lock', true, 'ใช้กับ NY', 'Apply to NY', R),
  B('InpLock_C5G', 'lock', true, 'ใช้กับ C5G', 'Apply to C5G', R),
  B('InpLockShadow', 'lock', true, 'บันทึก NEARTP / SHADOWLOCK แม้ปิดล็อก',
    'Journal NEARTP / SHADOWLOCK events even while the lock is off (forward evidence)', R),

  // v3.03 stage-1 lock
  B('InpLock1Enable', 'lock1', false, 'เปิดล็อกขั้นที่ 1',
    'Stage 1: gain >= InpLock1AtPct % of the TP distance -> SL to +InpLock1ToPct % (the 95->93 stage still applies later)', R),
  D('InpLock1AtPct', 'lock1', 82.0, 0, 99, 0.5, 'ขั้นที่ 1 เริ่มเมื่อกำไรถึง (% ของระยะ TP)',
    'Stage-1 activation, % of the TP distance (0 = stage 1 off; must be below InpLockAtPct)', R),
  D('InpLock1ToPct', 'lock1', 80.0, 1, 99, 0.5, 'ขั้นที่ 1 ย้าย SL ไปที่ (% ของระยะ TP)',
    'Stage-1 stop, % of the TP distance (below InpLock1AtPct and InpLockToPct)', R),

  // v3.04 remote (local only, never remotely changeable)
  B('InpRemoteParams', 'remote', false, 'รับค่าพรีเซ็ตจากเว็บ', 'Accept parameter changes from Common\\Files\\Dobby\\dobby3_remote.txt'),
  B('InpRemoteLive', 'remote', false, 'ให้เว็บเปิด/ปิดเทรดจริงได้', 'Let the remote file switch live trading on/off (replaces the InpAllowLive tick)'),
  D('InpRemoteMaxLots', 'remote', 0.10, 0.01, 5, 0.01, 'เพดานล็อตที่เว็บตั้งได้', 'Ceiling for every lot the remote file may set'),
  D('InpRemoteMaxCapPct', 'remote', 10.0, 1, 100, 0.5, 'เพดานจุดหยุดรายวันที่เว็บตั้งได้ (%)', 'Ceiling for InpDailyCapPct from the remote file'),

  // v3.05 runner (SPEC 11): at the TP touch the trade is not closed; the SL moves to KeepPct % of the TP distance and the
  // target ratchets up Step x d at a time. OFF = v3.04 behaviour exactly. Snapshotted at the open of each position.
  B('InpRunnerEnable', 'runner', false, 'เปิดโหมด runner',
    'Runner: at the TP touch keep the trade open with a ratcheting stop instead of closing (false = v3.04 behaviour exactly)', R),
  B('InpRunner_A', 'runner', true, 'ใช้กับ A_new', 'Runner allowed for module A_new', R),
  B('InpRunner_NY', 'runner', true, 'ใช้กับ NY', 'Runner allowed for module NY', R),
  B('InpRunner_C5G', 'runner', true, 'ใช้กับ C5G', 'Runner allowed for module C5G (ASIA16: never)', R),
  D('InpRunnerKeepPct', 'runner', 75.0, 50, 99, 1, 'เก็บกำไรขั้นต่ำเมื่อถึง TP (% ของระยะ TP)',
    'At the TP touch the SL moves to entry + this % of the TP distance (never below the stop in force)', R),
  D('InpRunnerStep', 'runner', 0.5, 0.1, 2.0, 0.1, 'ก้าวของเป้าและ SL (เท่าของระยะ SL)', 'Ratchet size in units of d (the stop distance)', R),
  I('InpRunnerMaxSteps', 'runner', 0, 0, 50, 'จำนวนก้าวสูงสุด (0 = ไม่จำกัด)',
    '0 = unlimited; when k reaches MaxSteps the broker TP is set to the current target (final)', R),
  D('InpRunnerSafetyTP', 'runner', 4.0, 0, 10, 0.5, 'TP สำรองฝั่งโบรกเกอร์ (เป้าถัดไป + N × ATR ขยับตามเป้า; 0 = ไม่ตั้ง)',
    'Broker-side TP at the next target + this x d, moved up with every ratchet (0 = no broker TP); only a safeguard against a disconnect, normally never closes the trade', R),
];

export const PARAM_BY_KEY = Object.fromEntries(PARAMS.map((p) => [p.key, p]));
export const REMOTE_KEYS = PARAMS.filter((p) => p.remote).map((p) => p.key);
export const LOT_KEYS = PARAMS.filter((p) => p.lots).map((p) => p.key);
export const RUNNER_KEYS = PARAMS.filter((p) => p.group === 'runner').map((p) => p.key);

// One-shot remote COMMANDS (SPEC 3.7 / 11): lines of the remote file that are not EA inputs. They travel inside
// desired.params next to the remote keys, so the allow-list of desired.params = REMOTE_KEYS + COMMAND_KEYS; they are
// never rows of the preset form, never in a .set, and normalizeParams drops them. The EA evaluates them as soon as it
// reads the file (not "when flat").
//   cap_reset   unix seconds (UTC, integer) = a fresh token per click of "รีเซ็ตจุดหยุดรายวัน" (ภาพรวม). Applied when the
//               token is newer than the last one seen, the daily cap is hit and the token's server day is today; the
//               agent accepts a token within 48 h of now.
export const COMMAND_WINDOW_S = 48 * 3600;
export const COMMANDS = [
  { key: 'cap_reset', type: 'int', min: 0, max: 4102444800, remote: true, command: true, label: 'รีเซ็ตจุดหยุดรายวัน (คำสั่งครั้งเดียว)',
    help: 'cap_reset=<unix seconds UTC>: one-shot daily-cap reset token sent by ภาพรวม -> รีเซ็ตจุดหยุดรายวัน (owner, EA v3.05); applied at once when the cap is hit today, else ignored; must be within 48 h of now' },
];
export const COMMAND_BY_KEY = Object.fromEntries(COMMANDS.map((c) => [c.key, c]));
export const COMMAND_KEYS = COMMANDS.map((c) => c.key);
export const isCommandKey = (k) => k in COMMAND_BY_KEY;
// Every key desired.params may carry (the proposal / agent allow-list).
export const DESIRED_KEYS = [...REMOTE_KEYS, ...COMMAND_KEYS];

// Bounds of a command value; null = fine, else the Thai reason. nowMs = the clock to measure the 48 h window against.
export function validateCommand(key, value, nowMs = Date.now()) {
  const c = COMMAND_BY_KEY[key];
  if (!c) return 'ไม่รู้จักคำสั่งนี้';
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n) || !Number.isInteger(n)) return 'ต้องเป็นจำนวนเต็ม (unix seconds)';
  if (n < c.min || n > c.max) return `ต้องอยู่ระหว่าง ${c.min} ถึง ${c.max}`;
  if (key === 'cap_reset' && Math.abs(n - Math.floor(nowMs / 1000)) > COMMAND_WINDOW_S) return 'token ต้องอยู่ภายใน 48 ชั่วโมงจากตอนนี้';
  return null;
}
// A fresh cap_reset token for one click.
export const capResetToken = (nowMs = Date.now()) => Math.floor(nowMs / 1000);

export function defaults() {
  return Object.fromEntries(PARAMS.map((p) => [p.key, p.def]));
}

// Normalise any loose object (from JSON / .set / form) to typed values; unknown keys dropped.
export function normalizeParams(obj) {
  const out = defaults();
  for (const p of PARAMS) {
    if (!obj || !(p.key in obj)) continue;
    const v = coerce(p, obj[p.key]);
    if (v !== undefined) out[p.key] = v;
  }
  return out;
}

export function coerce(p, v) {
  if (p.type === 'bool') {
    if (typeof v === 'boolean') return v;
    const s = String(v).trim().toLowerCase();
    if (s === 'true' || s === '1') return true;
    if (s === 'false' || s === '0') return false;
    return undefined;
  }
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  if (!Number.isFinite(n)) return undefined;
  if (p.type === 'double') return Math.round(n * 1e8) / 1e8;
  return Math.round(n);
}

const fmt = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1e6) / 1e6));

// Validation of a whole preset (for the form and the .set export). Returns {errors: {key: msg}, warnings: {key: msg}}.
export function validatePreset(v) {
  const errors = {}, warnings = {};
  const err = (k, m) => { if (!errors[k]) errors[k] = m; };
  const warn = (k, m) => { if (!warnings[k]) warnings[k] = m; };
  for (const p of PARAMS) {
    const x = v[p.key];
    if (p.type === 'bool') {
      if (typeof x !== 'boolean') err(p.key, 'ต้องเป็นเปิดหรือปิด');
      continue;
    }
    if (typeof x !== 'number' || !Number.isFinite(x)) { err(p.key, 'ต้องเป็นตัวเลข'); continue; }
    if (p.type !== 'double' && !Number.isInteger(x)) err(p.key, 'ต้องเป็นจำนวนเต็ม');
    if (x < p.min || x > p.max) err(p.key, `ต้องอยู่ระหว่าง ${fmt(p.min)} ถึง ${fmt(p.max)}`);
  }
  const at = v.InpLockAtPct, to = v.InpLockToPct, at1 = v.InpLock1AtPct, to1 = v.InpLock1ToPct;
  if (to > at - 0.5) err('InpLockToPct', `ต้องไม่เกิน ${fmt(at - 0.5)} (ต่ำกว่า InpLockAtPct อย่างน้อย 0.5)`);
  if (at1 !== 0 && (at1 < 10 || at1 > at - 0.5)) err('InpLock1AtPct', `ต้องเป็น 0 (ปิด) หรือ 10 ถึง ${fmt(at - 0.5)}`);
  if (at1 > 0) {
    const lim = Math.min(at1, to) - 0.5;
    if (to1 < 1 || to1 > lim) err('InpLock1ToPct', `ต้องอยู่ระหว่าง 1 ถึง ${fmt(lim)} (ต่ำกว่า InpLock1AtPct และ InpLockToPct)`);
  }
  if (v.InpLock1Enable && at1 === 0) warn('InpLock1AtPct', 'ค่า 0 = ปิดล็อกขั้นที่ 1 แม้จะเปิดสวิตช์ไว้');
  if (v.InpNY_Floor > v.InpNY_Cap) err('InpNY_Floor', 'SL ต่ำสุดต้องไม่เกิน SL สูงสุด');
  if (v.InpC5_Floor > v.InpC5_Cap) err('InpC5_Floor', 'SL ต่ำสุดต้องไม่เกินค่าข้ามไม้');
  if (v.InpAsia_SLFloor > v.InpAsia_SLCap) err('InpAsia_SLFloor', 'SL ต่ำสุดต้องไม่เกิน SL สูงสุด');
  if (!(v.InpNY_RangeMin < v.InpNY_LastMin)) err('InpNY_LastMin', 'ต้องอยู่หลังแท่งกรอบราคา (InpNY_RangeMin)');
  if (!(v.InpNY_LastMin < v.InpNY_FlatMin)) err('InpNY_FlatMin', 'ต้องอยู่หลัง InpNY_LastMin');
  if (v.InpAsia_EntryMin > v.InpAsia_LastMin) err('InpAsia_LastMin', 'ต้องไม่ก่อน InpAsia_EntryMin');
  if (!(v.InpAsia_LastMin < v.InpAsia_ExitMin)) err('InpAsia_ExitMin', 'ต้องอยู่หลัง InpAsia_LastMin');
  for (const k of ['InpLotsA', 'InpLotsNY', 'InpLotsC5G', 'InpLotsAsia']) {
    if (v[k] > v.InpMaxLots) warn(k, `สูงกว่า InpMaxLots (${fmt(v.InpMaxLots)}) EA จะใช้แค่ ${fmt(v.InpMaxLots)}`);
  }
  if (v.InpAllowLive) warn('InpAllowLive', 'พรีเซ็ตนี้เปิดเทรดบัญชีจริงทันทีที่โหลด ตรวจให้แน่ใจก่อนใช้');
  if (v.InpDailyCapPct > 10) warn('InpDailyCapPct', 'สูงกว่าค่าที่ทดสอบไว้ (10%)');
  if (v.InpMaxSpread === 0) warn('InpMaxSpread', '0 = ไม่กรองสเปรด');
  if (v.InpRemoteParams && v.InpLotsA > v.InpRemoteMaxLots) warn('InpRemoteMaxLots', 'ต่ำกว่าล็อตในพรีเซ็ตนี้ เว็บจะส่งล็อตนี้ไม่ได้');
  if (v.InpRunnerEnable) warn('InpRunnerEnable', RUNNER_WARNING);
  if (v.InpRunnerEnable && !(v.InpRunner_A || v.InpRunner_NY || v.InpRunner_C5G)) warn('InpRunner_A', 'เปิดโหมด runner แต่ไม่ได้เลือกสูตรใดเลย จึงไม่มีผล');
  if (runnerSafetyTooClose(v)) warn('InpRunnerSafetyTP', RUNNER_SAFETY_WARNING);
  return { errors, warnings };
}

// A safety TP closer than one ratchet step sits between two targets: the broker may close the trade before the runner
// moves (a warning, never an error; SPEC 11).
export const RUNNER_SAFETY_WARNING = 'TP สำรองใกล้กว่าหนึ่งก้าว โบรกเกอร์อาจปิดไม้ก่อนที่ runner จะขยับ (ค่าที่ทดสอบ 4.0)';
export const runnerSafetyTooClose = (v) => Number(v.InpRunnerSafetyTP) > 0 && Number(v.InpRunnerSafetyTP) < Number(v.InpRunnerStep);

// Stricter EA-side bounds for the remote keys (SPEC 4.2). ceilings = {maxLots, maxCapPct} (EA remote ceilings and agent
// limits, the lower of each). Returns a list of {key, msg}.
export function validateRemote(v, ceilings = {}) {
  const out = [];
  const maxLots = ceilings.maxLots ?? Infinity, maxCap = ceilings.maxCapPct ?? Infinity;
  for (const p of PARAMS) {
    if (!p.remote) continue;
    const x = v[p.key];
    if (p.type === 'bool') continue;
    if (p.lots && (x < 0.01 || x > maxLots)) out.push({ key: p.key, msg: `ต้องอยู่ระหว่าง 0.01 ถึง ${fmt(maxLots)} (เพดานของเครื่อง)` });
    if (p.capPct && (x < 1 || x > maxCap)) out.push({ key: p.key, msg: `ต้องอยู่ระหว่าง 1 ถึง ${fmt(maxCap)} (เพดานของเครื่อง)` });
    if (p.rmin != null && (x < p.rmin || x > p.rmax)) out.push({ key: p.key, msg: `ส่งจากเว็บได้เฉพาะ ${fmt(p.rmin)} ถึง ${fmt(p.rmax)}` });
    if (p.rminEx != null && !(x > p.rminEx)) out.push({ key: p.key, msg: `ต้องมากกว่า ${fmt(p.rminEx)}` });
  }
  return out;
}

export function remoteSubset(v) {
  return Object.fromEntries(REMOTE_KEYS.map((k) => [k, v[k]]));
}

// What the bot runs now, from the status JSON. EA v3.04 reports every remote key in status.remote.effective;
// older status files only expose part of the inputs (others stay unknown).
export function liveValuesFromStatus(st) {
  if (!st) return { values: {}, source: 'none' };
  const values = {};
  const set = (k, x) => { if (x !== undefined && x !== null && PARAM_BY_KEY[k]) { const c = coerce(PARAM_BY_KEY[k], x); if (c !== undefined) values[k] = c; } };
  const p = st.params || {}, o = st.options || {}, vr = st.virtual || {};
  set('InpA_SLCap', p.sl_cap); set('InpA_TPRatio', p.tp_ratio);
  set('InpLotsA', p.lots_input); set('InpLotsNY', p.lots_ny); set('InpLotsC5G', p.lots_c5g); set('InpMaxLots', p.max_lots);
  set('InpRecoveryMult', p.recovery_mult); set('InpDailyCapPct', p.daily_cap_pct); set('InpMaxSpread', p.max_spread_input);
  set('InpVirtualStart', vr.start); set('InpKillBalance', vr.kill_balance);
  set('InpMagicA', st.magic);
  const mods = Object.fromEntries((st.modules || []).map((m) => [m.module, m]));
  if (mods.A_new) set('InpUseA', mods.A_new.enabled);
  if (mods.NY) { set('InpUseNY', mods.NY.enabled); set('InpMagicNY', mods.NY.magic); }
  if (mods.C5G) { set('InpUseC5G', mods.C5G.enabled); set('InpMagicC5G', mods.C5G.magic); }
  if (o.vol_gate) { set('InpVolGate', o.vol_gate.enabled); set('InpVolGatePct', o.vol_gate.pct); }
  set('InpMaxAttempts', o.max_attempts); set('InpConfluenceMult', o.confluence_mult); set('InpConfluenceMin', o.confluence_min);
  if (o.asia) { set('InpUseAsia', o.asia.enabled); set('InpLotsAsia', o.asia.lots); set('InpMagicAsia', o.asia.magic); }
  if (o.lock) {
    set('InpLockEnable', o.lock.enabled); set('InpLockAtPct', o.lock.at_pct); set('InpLockToPct', o.lock.to_pct); set('InpLockShadow', o.lock.shadow);
    const m = /A=(\w+)\s+NY=(\w+)\s+C5G=(\w+)/.exec(o.lock.modules || '');
    if (m) { set('InpLock_A', m[1]); set('InpLock_NY', m[2]); set('InpLock_C5G', m[3]); }
  }
  if (o.lock1) { set('InpLock1Enable', o.lock1.enabled); set('InpLock1AtPct', o.lock1.at_pct); set('InpLock1ToPct', o.lock1.to_pct); }
  if (st.flags) set('InpAllowLive', st.flags.allow_live_input);
  // schema 6 (EA v3.05): params.runner = {enable, a, ny, c5g, keep_pct, step, max_steps, safety_tp}
  if (p.runner && typeof p.runner === 'object') {
    const rn = p.runner;
    set('InpRunnerEnable', rn.enable); set('InpRunner_A', rn.a); set('InpRunner_NY', rn.ny); set('InpRunner_C5G', rn.c5g);
    set('InpRunnerKeepPct', rn.keep_pct); set('InpRunnerStep', rn.step); set('InpRunnerMaxSteps', rn.max_steps); set('InpRunnerSafetyTP', rn.safety_tp);
  }
  let source = 'status';
  if (st.remote && st.remote.effective && typeof st.remote.effective === 'object') {
    for (const [k, x] of Object.entries(st.remote.effective)) set(k, x);
    if (st.remote.params_enabled !== undefined) set('InpRemoteParams', st.remote.params_enabled);
    if (st.remote.live_enabled !== undefined) set('InpRemoteLive', st.remote.live_enabled);
    if (st.remote.ceilings) { set('InpRemoteMaxLots', st.remote.ceilings.max_lots); set('InpRemoteMaxCapPct', st.remote.ceilings.max_cap_pct); }
    source = 'remote.effective';
  }
  return { values, source };
}

// Full preset built from the live values (unknown inputs = EA defaults).
export function presetFromLive(st) {
  const { values } = liveValuesFromStatus(st);
  return normalizeParams({ ...defaults(), ...values, InpAllowLive: false });
}

export function diffParams(a, b, keys = PARAMS.map((p) => p.key)) {
  return keys.filter((k) => k in a && k in b && !sameValue(a[k], b[k]));
}

export function sameValue(x, y) {
  if (typeof x === 'number' && typeof y === 'number') return Math.abs(x - y) < 1e-9;
  return x === y;
}

export function formatValue(p, v) {
  if (v === undefined || v === null) return '—';
  if (p.type === 'bool') return v ? 'true' : 'false';
  if (p.type === 'double') {
    const d = p.step && p.step < 0.1 ? 2 : p.step && p.step < 1 ? 2 : 1;
    return Number(v).toFixed(Math.max(d, decimals(v)));
  }
  return String(v);
}

function decimals(v) {
  const s = String(v);
  const i = s.indexOf('.');
  return i < 0 ? 0 : Math.min(6, s.length - i - 1);
}

// Templates: sensible starting points. InpAllowLive stays false in every template.
const COMMON = {
  InpRecoveryMult: 1.5, InpMaxAttempts: 4, InpConfluenceMult: 1.5, InpConfluenceMin: 60,
  InpLockEnable: true, InpLockAtPct: 95, InpLockToPct: 93, InpLockShadow: true,
  InpLock1Enable: false, InpLock1AtPct: 82, InpLock1ToPct: 80,
  InpDailyCapPct: 10, InpMaxSpread: 1.0, InpUseAsia: false, InpAllowLive: false,
};

const lots = (x) => ({ InpLotsA: x, InpLotsNY: x, InpLotsC5G: x, InpMaxLots: x });

export const TEMPLATES = [
  {
    id: 'std-003', name: 'มาตรฐาน 0.03 / ทุน ~300',
    note: 'ทุกสูตรไม้ละ 0.03 พอร์ตจำลอง 300 ไม้แก้ x1.5 สูงสุด 4 ไม้ต่อสูตรต่อวัน ล็อกกำไร 95%→93%',
    params: { ...COMMON, ...lots(0.03), InpVirtualStart: 300, InpRemoteMaxLots: 0.03, InpRemoteMaxCapPct: 10 },
  },
  {
    id: 'std-010', name: '0.10 / ทุน ~1,000',
    note: 'สัดส่วนเดียวกับแบบมาตรฐาน ขยายเป็นไม้ละ 0.10 สำหรับพอร์ตราว 1,000',
    params: { ...COMMON, ...lots(0.10), InpVirtualStart: 1000, InpRemoteMaxLots: 0.10, InpRemoteMaxCapPct: 10 },
  },
  {
    id: 'safe-006', name: 'ระวัง 0.06 / ทุน ~1,000',
    note: 'ไม้ละ 0.06 บนพอร์ตราว 1,000 ไม่ขยายไม้แก้ ไม่คูณล็อตเมื่อสัญญาณตรงกัน สูงสุด 2 ไม้ต่อสูตรต่อวัน',
    params: {
      ...COMMON, ...lots(0.06), InpVirtualStart: 1000, InpRecoveryMult: 1.0, InpMaxAttempts: 2, InpConfluenceMult: 1.0,
      InpRemoteMaxLots: 0.06, InpRemoteMaxCapPct: 10,
    },
  },
  {
    id: 'ea-default', name: 'ค่าเริ่มต้นของ EA',
    note: 'ค่าตามโค้ด EA ทุกตัว (ไม้ละ 0.02 พอร์ตจำลอง 200 ไม่มีล็อกกำไร)',
    params: {},
  },
];

export function templateParams(id) {
  const t = TEMPLATES.find((x) => x.id === id) || TEMPLATES[0];
  return normalizeParams({ ...defaults(), ...t.params });
}

export function minutesToClock(m) {
  const hh = Math.floor(m / 60), mm = m % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
