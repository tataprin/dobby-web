// News page (2026-11-10, user's request): for each US news, which way gold USUALLY goes when the real number comes out
// above / at / below the forecast. General market tendency only (strong US data or high inflation -> Fed keeps rates high
// -> dollar and yields up -> gold down), written for a reader who is not a trader; never a prediction or advice.
// guideFor(title, currency) -> null | { th, kind, why }
//   kind 'hot'   higher than forecast -> gold usually down  (inflation, jobs, growth)
//        'cold'  higher than forecast -> gold usually up    (unemployment rate, jobless claims)
//        'rate'  the Fed's rate: higher -> gold down; at forecast -> the statement / press conference decides
//        'talk'  no number: hawkish words -> gold down, dovish words -> gold up
//        'off'   US bank holiday
// lean(kind, forecast, previous) -> null | { dir: 'up'|'down', text }: what "at forecast" means against last time.
const WHY = {
  infl: 'เงินเฟ้อสูง → เฟดคงดอกเบี้ยสูงนานขึ้น → ดอลลาร์และผลตอบแทนพันธบัตรขึ้น → ทองมักลง',
  wage: 'ค่าจ้างขึ้นแรง → เงินเฟ้อมีแรงหนุน → เฟดไม่รีบลดดอกเบี้ย → ทองมักลง',
  jobs: 'จ้างงานดี → เศรษฐกิจแข็ง เฟดไม่รีบลดดอกเบี้ย → ดอลลาร์แข็ง → ทองมักลง',
  growth: 'เศรษฐกิจดี → เฟดไม่รีบลดดอกเบี้ย → ดอลลาร์แข็ง → ทองมักลง',
  unemp: 'ว่างงานสูง → เศรษฐกิจอ่อน เฟดมีเหตุลดดอกเบี้ย → ดอลลาร์อ่อน → ทองมักขึ้น',
  claims: 'คนขอสวัสดิการว่างงานมาก → ตลาดแรงงานอ่อน เฟดมีเหตุลดดอกเบี้ย → ทองมักขึ้น',
  rate: 'ดอกเบี้ยสูง → ถือทองเสียโอกาสได้ดอกเบี้ย และดอลลาร์แข็ง → ทองมักลง',
  talk: 'ไม่มีตัวเลขให้เทียบ ถ้าพูดแนวเข้มงวด (ยังไม่ลดดอกเบี้ย กังวลเงินเฟ้อ) ทองมักลง ถ้าพูดแนวผ่อนคลาย (ใกล้ลดดอกเบี้ย) ทองมักขึ้น',
  off: 'ตลาดสหรัฐหยุด คนเทรดน้อย ราคาอาจวิ่งแคบหรือกระชากผิดปกติ',
};

// first match wins: the specific names before the general ones
const RULES = [
  [/bank holiday/i, 'วันหยุดธนาคารสหรัฐ', 'off', 'off'],
  [/unemployment rate/i, 'อัตราว่างงาน', 'cold', 'unemp'],
  [/unemployment claims|jobless claims|continuing claims/i, 'คนขอสวัสดิการว่างงาน (รายสัปดาห์)', 'cold', 'claims'],
  [/core cpi/i, 'เงินเฟ้อพื้นฐาน CPI (ไม่รวมอาหารและพลังงาน)', 'hot', 'infl'],
  [/\bcpi\b/i, 'เงินเฟ้อผู้บริโภค (CPI)', 'hot', 'infl'],
  [/core ppi/i, 'ราคาผู้ผลิตพื้นฐาน (PPI)', 'hot', 'infl'],
  [/\bppi\b/i, 'ราคาผู้ผลิต (PPI)', 'hot', 'infl'],
  [/core pce/i, 'เงินเฟ้อ PCE พื้นฐาน (ตัวที่เฟดดู)', 'hot', 'infl'],
  [/\bpce\b/i, 'เงินเฟ้อ PCE', 'hot', 'infl'],
  [/inflation expectations/i, 'คาดการณ์เงินเฟ้อของผู้บริโภค', 'hot', 'infl'],
  [/average hourly earnings/i, 'ค่าจ้างรายชั่วโมง', 'hot', 'wage'],
  [/employment cost/i, 'ต้นทุนค่าจ้าง', 'hot', 'wage'],
  [/\badp\b/i, 'การจ้างงานภาคเอกชน (ADP)', 'hot', 'jobs'],
  [/non-?farm|\bnfp\b/i, 'การจ้างงานนอกภาคเกษตร (NFP)', 'hot', 'jobs'],
  [/jolts|job openings/i, 'ตำแหน่งงานว่าง (JOLTS)', 'hot', 'jobs'],
  [/federal funds rate|interest rate decision|rate decision/i, 'ดอกเบี้ยนโยบายเฟด', 'rate', 'rate'],
  [/press conference/i, 'แถลงข่าวหลังประชุมเฟด', 'talk', 'talk'],
  [/fomc statement/i, 'แถลงการณ์หลังประชุมเฟด', 'talk', 'talk'],
  [/minutes/i, 'บันทึกการประชุมเฟด', 'talk', 'talk'],
  [/beige book/i, 'รายงานเศรษฐกิจของเฟด (Beige Book)', 'talk', 'talk'],
  [/(fomc|\bfed\b|powell).*(speaks|speech|testif)/i, 'เจ้าหน้าที่เฟดพูด', 'talk', 'talk'],
  [/\bgdp\b/i, 'การเติบโตทางเศรษฐกิจ (GDP)', 'hot', 'growth'],
  [/core retail sales/i, 'ยอดค้าปลีกพื้นฐาน (ไม่รวมรถยนต์)', 'hot', 'growth'],
  [/retail sales/i, 'ยอดค้าปลีก', 'hot', 'growth'],
  [/ism manufacturing/i, 'ดัชนีภาคการผลิต ISM', 'hot', 'growth'],
  [/ism services|ism non-manufacturing/i, 'ดัชนีภาคบริการ ISM', 'hot', 'growth'],
  [/\bpmi\b/i, 'ดัชนีผู้จัดการฝ่ายซื้อ (PMI)', 'hot', 'growth'],
  [/durable goods/i, 'ยอดสั่งซื้อสินค้าคงทน', 'hot', 'growth'],
  [/consumer confidence/i, 'ความเชื่อมั่นผู้บริโภค', 'hot', 'growth'],
  [/consumer sentiment/i, 'ความเชื่อมั่นผู้บริโภค (มิชิแกน)', 'hot', 'growth'],
  [/empire state/i, 'ภาคการผลิตนิวยอร์ก', 'hot', 'growth'],
  [/philly fed|philadelphia fed/i, 'ภาคการผลิตฟิลาเดลเฟีย', 'hot', 'growth'],
  [/industrial production/i, 'ผลผลิตภาคอุตสาหกรรม', 'hot', 'growth'],
  [/housing starts|building permits/i, 'การเริ่มสร้างบ้าน / ใบอนุญาตก่อสร้าง', 'hot', 'growth'],
  [/home sales/i, 'ยอดขายบ้าน', 'hot', 'growth'],
  [/factory orders/i, 'ยอดสั่งซื้อภาคโรงงาน', 'hot', 'growth'],
  [/personal spending/i, 'การใช้จ่ายของประชาชน', 'hot', 'growth'],
  [/personal income/i, 'รายได้ของประชาชน', 'hot', 'growth'],
  [/nfib|small business/i, 'ความเชื่อมั่นธุรกิจขนาดเล็ก', 'hot', 'growth'],
];

export function guideFor(title, currency) {
  if (currency && String(currency).toUpperCase() !== 'USD') return null; // other currencies move gold another way
  const s = String(title || '');
  for (const [re, th, kind, why] of RULES) if (re.test(s)) return { th, kind, why: WHY[why] };
  return null;
}

// "0.3%" -> 0.3, "115K" -> 115000, "-286.3B" -> -2.863e11, "5.30|2.8" (bond auction) -> NaN
export function numOf(x) {
  const m = /^\s*([-+]?\d+(?:\.\d+)?)\s*([%KMBT]?)\s*$/i.exec(String(x ?? ''));
  if (!m) return NaN;
  const mult = { '': 1, '%': 1, K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[m[2].toUpperCase()];
  return Number(m[1]) * mult;
}

// "at forecast" against last time: higher inflation / stronger data than last time leans gold down a little, and so on.
export function lean(kind, forecast, previous) {
  if (kind !== 'hot' && kind !== 'cold') return null;
  const f = numOf(forecast), p = numOf(previous);
  if (!Number.isFinite(f) || !Number.isFinite(p) || f === p) return null;
  const higher = f > p;
  const dir = (kind === 'hot') === higher ? 'down' : 'up';
  return { dir, text: `คาด${higher ? 'สูง' : 'ต่ำ'}กว่าครั้งก่อน เอียงไปทางทอง${dir === 'up' ? 'ขึ้น' : 'ลง'}เล็กน้อย` };
}

// the three outcomes as rows: [label, dir ('up'|'down'|''), text]
export function outcomes(g, forecast, previous) {
  if (!g || g.kind === 'talk' || g.kind === 'off') return [];
  const above = g.kind === 'cold' ? 'up' : 'down';
  const below = above === 'up' ? 'down' : 'up';
  const word = (d) => (d === 'up' ? 'ทองมักขึ้น' : 'ทองมักลง');
  if (g.kind === 'rate') {
    return [
      ['สูงกว่าคาด', 'down', `${word('down')} (ขึ้นดอกเบี้ย หรือไม่ลดตามที่ตลาดคาด)`],
      ['ตามคาด', '', 'ตลาดรู้ล่วงหน้าแล้ว ราคามักไปวิ่งตอนแถลงการณ์และแถลงข่าวแทน'],
      ['ต่ำกว่าคาด', 'up', `${word('up')} (ลดดอกเบี้ยมากกว่าที่คาด)`],
    ];
  }
  const l = lean(g.kind, forecast, previous);
  return [
    ['สูงกว่าคาด', above, word(above)],
    ['ตามคาด', '', `ตลาดรู้ล่วงหน้าแล้ว ราคามักไม่วิ่งแรง${l ? ` (${l.text})` : ''}`],
    ['ต่ำกว่าคาด', below, word(below)],
  ];
}
