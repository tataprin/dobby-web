// Inline SVG illustrations for the guide and the welcome tour, drawn in the Hallmark palette (porcelain / sheet,
// graphite line, fine gold = Dobby, jade = profit / buy, cinnabar = loss / sell). Colours come from the CSS tokens,
// so they follow the light / dark theme. Drawn on a 360-wide canvas so the text stays readable on a phone.
import { octagonPath } from './hallmark.js';

const plate = (x, y, s) => `<path d="${octagonPath(x, y, s, s * 0.11)}" fill="var(--gold)"/><path d="${octagonPath(x + s * 0.08, y + s * 0.08, s * 0.84, s * 0.08)}" fill="none" stroke="var(--hm-engrave)" stroke-opacity=".6" stroke-width="1"/>`;
const badge = (x, y, n) => `<circle cx="${x}" cy="${y}" r="9" fill="var(--ink)"/><text x="${x}" y="${y + 4}" text-anchor="middle" font-size="11" font-weight="600" fill="var(--bg)">${n}</text>`;
const sw = (x, y, on) => `<rect x="${x}" y="${y}" width="36" height="21" rx="10.5" fill="${on ? 'var(--jade)' : 'var(--well-strong)'}"/><circle cx="${on ? x + 25.5 : x + 10.5}" cy="${y + 10.5}" r="7.5" fill="#fff"/>`;

export const ART_DASHBOARD = `<svg viewBox="0 0 360 236" role="img" aria-label="ตัวอย่างหน้าภาพรวม: ตราประทับสถานะ กราฟราคาพร้อมจุดเข้าออกของบอท และยอดเงิน">
<rect x="12" y="10" width="336" height="150" rx="16" fill="var(--sheet)" stroke="var(--hair)"/>
${plate(24, 22, 40)}
<text x="44" y="46" text-anchor="middle" font-size="8.5" font-weight="700" fill="var(--hm-engrave)">Dobby</text>
<text x="76" y="38" font-size="13" font-weight="600" fill="var(--ink)">บอทกำลังเทรดจริง</text>
<text x="76" y="55" font-size="10.5" fill="var(--slate)">มีไม้เปิดอยู่ 1 ไม้</text>
<text x="334" y="35" text-anchor="end" font-size="9.5" fill="var(--slate)">วันนี้</text>
<text x="334" y="55" text-anchor="end" font-size="17" font-weight="600" fill="var(--jade)">+24.45</text>
<path d="M24 92H334M24 116H334M24 140H334" stroke="var(--hair)"/>
<path d="M24 138L42 131L58 134L76 121L94 125L112 112L130 115L150 102L168 106L186 113L204 108L222 119L240 111L258 99L276 103L294 92L312 88L330 82" fill="none" stroke="var(--ink)" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round"/>
<path d="M150 102L204 98M240 111L276 116" stroke-dasharray="1.5 3" stroke-linecap="round"/>
<path d="M150 102L204 98" stroke="var(--jade)" stroke-dasharray="1.5 3"/><path d="M240 111L276 116" stroke="var(--cinnabar)" stroke-dasharray="1.5 3"/>
<path d="M150 95.5l5.6 10h-11.2z" fill="var(--jade)" stroke="var(--sheet)" stroke-width="1.5"/>
<circle cx="204" cy="98" r="4.2" fill="var(--sheet)" stroke="var(--jade)" stroke-width="2"/>
<path d="M240 117.5l5.6-10h-11.2z" fill="var(--cinnabar)" stroke="var(--sheet)" stroke-width="1.5"/>
<circle cx="276" cy="116" r="4.2" fill="var(--sheet)" stroke="var(--cinnabar)" stroke-width="2"/>
<circle cx="330" cy="82" r="8" fill="var(--ink)" opacity=".1"/><circle cx="330" cy="82" r="3.4" fill="var(--ink)"/>
<path d="M12 178H348M12 226H348M124 178V226M236 178V226" stroke="var(--hair)"/>
<g font-size="9.5" fill="var(--slate)"><text x="14" y="194">ยอดเงิน</text><text x="134" y="194">วันนี้</text><text x="246" y="194">ตั้งแต่เริ่ม</text></g>
<g font-size="15" font-weight="600"><text x="14" y="215" fill="var(--ink)">420.43</text><text x="134" y="215" fill="var(--jade)">+24.45</text><text x="246" y="215" fill="var(--jade)">+120.43</text></g>
${badge(68, 20, 1)}${badge(26, 84, 2)}${badge(112, 186, 3)}
</svg>`;

export const ART_SETTINGS = `<svg viewBox="0 0 360 230" role="img" aria-label="ตัวอย่างหน้าตั้งค่าบอท: สวิตช์สูตร ปุ่มเพิ่มลดล็อต และแถบบันทึก">
<rect x="12" y="10" width="336" height="166" rx="14" fill="var(--sheet)" stroke="var(--hair)"/>
<g font-size="12.5" fill="var(--ink)">
<text x="28" y="38" font-weight="600">A_new</text><text x="28" y="52" font-size="9.5" fill="var(--slate)">จับจังหวะราคากลับตัว</text>${sw(300, 28, true)}
<path d="M28 64H332" stroke="var(--hair)"/>
<text x="28" y="86" font-weight="600">NY</text><text x="28" y="100" font-size="9.5" fill="var(--slate)">เบรกกรอบตอนตลาดนิวยอร์กเปิด</text>${sw(300, 76, true)}
<path d="M28 112H332" stroke="var(--hair)"/>
<text x="28" y="134" font-weight="600">ล็อตต่อไม้</text>
<rect x="206" y="118" width="126" height="32" rx="8" fill="var(--sheet)" stroke="var(--hair-strong)"/>
<path d="M238 118V150M300 118V150" stroke="var(--hair)"/>
<text x="222" y="139" text-anchor="middle" font-size="15">−</text><text x="269" y="139" text-anchor="middle" font-weight="600">0.03</text><text x="316" y="139" text-anchor="middle" font-size="15">+</text>
</g>
<rect x="12" y="188" width="336" height="34" rx="12" fill="var(--inverse)"/>
<text x="26" y="209" font-size="11.5" fill="var(--on-inverse)">1 การเปลี่ยนแปลง</text>
<rect x="206" y="194" width="134" height="22" rx="7" fill="var(--gold)"/>
<text x="273" y="209" text-anchor="middle" font-size="10.5" font-weight="600" fill="var(--on-gold)">บันทึกและส่งให้บอท</text>
</svg>`;

export const ART_PROGRESS = `<svg viewBox="0 0 360 64" role="img" aria-label="3 ขั้น: ส่งแล้ว เครื่องรับแล้ว EA ใช้ค่าใหม่แล้ว">
<path d="M40 20H320" stroke="var(--hair-strong)" stroke-width="1.2"/><path d="M40 20H180" stroke="var(--jade)" stroke-width="1.2"/>
<circle cx="40" cy="20" r="12" fill="var(--jade)"/><path d="M34.5 20.5l3.8 3.8 7.2-7.6" fill="none" stroke="var(--sheet)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
<circle cx="180" cy="20" r="12" fill="var(--jade)"/><path d="M174.5 20.5l3.8 3.8 7.2-7.6" fill="none" stroke="var(--sheet)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
<circle cx="320" cy="20" r="12" fill="var(--sheet)" stroke="var(--gold-ink)" stroke-width="1.4"/><text x="320" y="24.5" text-anchor="middle" font-size="12" font-weight="600" fill="var(--gold-ink)">3</text>
<g font-size="11.5" fill="var(--ink)" text-anchor="middle"><text x="40" y="52">ส่งแล้ว</text><text x="180" y="52">เครื่องรับแล้ว</text><text x="320" y="52">EA ใช้ค่าใหม่</text></g>
</svg>`;

export const ART_LIVE = `<svg viewBox="0 0 360 120" role="img" aria-label="สวิตช์เทรดจริง เปิดต้องใส่รหัสผ่านและรหัส 2FA">
<rect x="24" y="34" width="84" height="46" rx="23" fill="var(--gold)"/><circle cx="85" cy="57" r="19" fill="#fff"/>
<path d="${octagonPath(78, 50, 14, 2)}" fill="var(--gold)"/>
<text x="66" y="106" font-size="12" fill="var(--ink)" text-anchor="middle">เทรดจริง เปิด</text>
<path d="M126 57h40" stroke="var(--hair-strong)" stroke-width="1.5" stroke-dasharray="2 5" stroke-linecap="round"/>
<rect x="182" y="36" width="74" height="42" rx="9" fill="var(--sheet)" stroke="var(--hair-strong)"/>
<g fill="var(--ink)"><circle cx="198" cy="57" r="3.5"/><circle cx="212" cy="57" r="3.5"/><circle cx="226" cy="57" r="3.5"/><circle cx="240" cy="57" r="3.5"/></g>
<text x="219" y="106" font-size="12" fill="var(--ink)" text-anchor="middle">รหัสผ่าน</text>
<path d="M300 28l24 9v17c0 14-10 24-24 28-14-4-24-14-24-28V37z" fill="none" stroke="var(--jade)" stroke-width="1.6" stroke-linejoin="round"/>
<path d="M291 55l6.5 6.5 12.5-13.5" fill="none" stroke="var(--jade)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
<text x="300" y="106" font-size="12" fill="var(--ink)" text-anchor="middle">2FA (ถ้าเปิดไว้)</text>
</svg>`;

export const ART_NEWS = `<svg viewBox="0 0 360 120" role="img" aria-label="งดเข้าไม้ 30 นาทีก่อนข่าว ถึง 90 นาทีหลังข่าว">
<rect x="96" y="38" width="230" height="30" rx="6" fill="var(--gold-tint)"/>
<path d="M16 53H344" stroke="var(--hair-strong)" stroke-width="1.2"/>
<path d="M96 38V68M326 38V68" stroke="var(--gold-ink)" stroke-width="1.2"/>
<path d="M154 24V82" stroke="var(--cinnabar)" stroke-width="1.6"/>
<circle cx="154" cy="22" r="5" fill="var(--cinnabar)"/>
<g font-size="12" fill="var(--ink)" text-anchor="middle">
<text x="96" y="100">−30 นาที</text><text x="154" y="100" font-weight="600" fill="var(--cinnabar)">ข่าวออก</text><text x="326" y="100">+90 นาที</text>
<text x="244" y="57.5" font-weight="500">บอทไม่เปิดไม้ใหม่</text></g>
</svg>`;

// Price over time: rises to 85 % of the way to TP, the SL moves up to 83 %, the price falls back and the trade still
// closes in profit.
export const ART_LOCK = `<svg viewBox="0 0 360 200" role="img" aria-label="ล็อกกำไร: ราคาวิ่งถึง 85% ของทางไป TP บอทเลื่อน SL ไป 83% ราคากลับลงมา ไม้ปิดที่กำไร 83%">
<g font-size="11.5">
<path d="M58 30H344" stroke="var(--jade)" stroke-width="1.4" stroke-dasharray="5 4"/><text x="10" y="34" fill="var(--jade)" font-weight="600">TP</text>
<path d="M58 130H344" stroke="var(--ink)" stroke-width="1.2"/><text x="10" y="134" fill="var(--ink)">ราคาเข้า</text>
<path d="M58 178H164" stroke="var(--cinnabar)" stroke-width="1.4" stroke-dasharray="5 4"/><text x="10" y="182" fill="var(--cinnabar)" font-weight="600">SL</text>
<path d="M164 178V58" stroke="var(--gold-ink)" stroke-width="1.2" stroke-dasharray="2 3"/>
<path d="M164 47H344" stroke="var(--gold)" stroke-width="3" stroke-linecap="round"/>
<text x="344" y="40" fill="var(--gold-ink)" font-weight="600" text-anchor="end">SL ใหม่ 83%</text>
<path d="M58 130L82 118L104 124L128 94L148 72L164 45L184 38L200 33L218 41L238 47" fill="none" stroke="var(--ink)" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
<path d="M164 39l5 5-5 5-5-5z" fill="var(--sheet)" stroke="var(--gold-ink)" stroke-width="1.6"/>
<text x="150" y="62" fill="var(--gold-ink)" font-weight="600" text-anchor="end">ถึง 85%</text>
<circle cx="238" cy="47" r="4.6" fill="var(--sheet)" stroke="var(--jade)" stroke-width="2.2"/>
<text x="200" y="84" fill="var(--ink)">ราคากลับลง โดน SL ใหม่</text><text x="200" y="101" fill="var(--jade)" font-weight="600">ยังได้กำไรราว 83%</text>
</g>
</svg>`;

export const ART_SMARTSCREEN = `<svg viewBox="0 0 360 190" role="img" aria-label="หน้าจอสีฟ้า Windows protected your PC กด More info แล้วกด Run anyway">
<rect x="1" y="1" width="358" height="188" rx="12" fill="#1f5fae"/>
<g fill="#fff">
<text x="20" y="38" font-size="17" font-weight="600">Windows protected your PC</text>
<text x="20" y="62" font-size="11" opacity=".9">Microsoft Defender SmartScreen prevented an</text>
<text x="20" y="78" font-size="11" opacity=".9">unrecognized app from starting...</text>
<text x="20" y="104" font-size="12" font-weight="700" text-decoration="underline">More info</text>
</g>
<circle cx="96" cy="100" r="10" fill="var(--gold)"/><text x="96" y="104.5" text-anchor="middle" font-size="12" font-weight="700" fill="#20262A">1</text>
<rect x="196" y="140" width="76" height="30" rx="2" fill="#fff" opacity=".18" stroke="#fff"/>
<text x="206" y="160" font-size="12" font-weight="600" fill="#fff">Run anyway</text>
<rect x="280" y="140" width="64" height="30" rx="2" fill="#fff" opacity=".1" stroke="#fff" stroke-opacity=".6"/>
<text x="291" y="160" font-size="12" fill="#fff">Don't run</text>
<circle cx="196" cy="140" r="10" fill="var(--gold)"/><text x="196" y="144.5" text-anchor="middle" font-size="12" font-weight="700" fill="#20262A">2</text>
</svg>`;

export const ART_WELCOME = `<svg viewBox="0 0 360 150" role="img" aria-label="Dobby บนคอมและมือถือ">
<rect x="30" y="22" width="196" height="112" rx="12" fill="var(--sheet)" stroke="var(--hair-strong)"/>
<path d="M44 108H212M44 84H212M44 60H212" stroke="var(--hair)"/>
<path d="M44 104L62 96L78 99L96 84L114 88L132 72L150 76L168 62L186 66L210 48" fill="none" stroke="var(--ink)" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
<path d="M132 65.5l5.4 9.6h-10.8z" fill="var(--jade)" stroke="var(--sheet)" stroke-width="1.4"/>
<circle cx="186" cy="66" r="4" fill="var(--sheet)" stroke="var(--jade)" stroke-width="2"/>
<rect x="248" y="12" width="82" height="128" rx="16" fill="var(--sheet)" stroke="var(--hair-strong)"/>
${plate(270, 26, 38)}
<text x="289" y="49" text-anchor="middle" font-size="8" font-weight="700" fill="var(--hm-engrave)">Dobby</text>
<rect x="262" y="76" width="54" height="7" rx="3.5" fill="var(--well-strong)"/><rect x="262" y="90" width="38" height="7" rx="3.5" fill="var(--well-strong)"/>
<rect x="262" y="112" width="54" height="18" rx="6" fill="var(--gold)"/>
<path d="M8 140h344" stroke="var(--hair)" stroke-linecap="round"/>
</svg>`;

export const ART_HELP = `<svg viewBox="0 0 360 120" role="img" aria-label="ปุ่ม ? วิธีใช้ มุมขวาบนของทุกหน้า">
<rect x="20" y="16" width="320" height="88" rx="14" fill="var(--sheet)" stroke="var(--hair)"/>
<rect x="36" y="34" width="118" height="13" rx="6.5" fill="var(--ink)" opacity=".85"/>
<rect x="36" y="58" width="190" height="8" rx="4" fill="var(--well-strong)"/><rect x="36" y="74" width="150" height="8" rx="4" fill="var(--well-strong)"/>
<circle cx="262" cy="41" r="9" fill="none" stroke="var(--hair-strong)"/><text x="262" y="45" text-anchor="middle" font-size="11" font-weight="600" fill="var(--ink)">?</text>
<text x="278" y="45.5" font-size="12" font-weight="500" fill="var(--ink)">วิธีใช้</text>
<path d="M248 56h76" stroke="var(--gold)" stroke-width="2" stroke-linecap="round"/>
</svg>`;
