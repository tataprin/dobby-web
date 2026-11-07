// Inline SVG illustrations for the guide and the welcome tour. Colours come from the CSS tokens, so they follow the
// light / dark theme. Drawn on a 360-wide canvas so the text stays readable on a phone.
const T = ''; // text inherits the page font

export const ART_DASHBOARD = `<svg viewBox="0 0 360 236" role="img" aria-label="ตัวอย่างหน้าภาพรวม: สถานะ ยอดเงิน ไม้ที่เปิด และเทรดล่าสุด">
<rect x="1" y="1" width="358" height="234" rx="16" fill="var(--surface)" stroke="var(--line)"/>
<rect x="14" y="14" width="332" height="66" rx="12" fill="var(--gold-soft)"/>
<rect x="14" y="14" width="5" height="66" rx="2.5" fill="var(--gold)"/>
<circle cx="44" cy="47" r="15" fill="var(--surface)"/><path d="M35 52l6-7 5 4 7-9" fill="none" stroke="var(--gold-lo)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
<text x="68" y="42" ${T} font-size="15" font-weight="700" fill="var(--ink)">บอทกำลังเทรดจริง</text>
<text x="68" y="62" ${T} font-size="11.5" fill="var(--ink-2)">มีไม้เปิดอยู่ 1 ไม้</text>
<g ${T} font-size="10.5">
<rect x="14" y="90" width="104" height="48" rx="10" fill="var(--surface-2)"/><text x="24" y="107" fill="var(--muted)">ยอดเงิน</text><text x="24" y="127" font-size="14" font-weight="700" fill="var(--ink)">342.10</text>
<rect x="128" y="90" width="104" height="48" rx="10" fill="var(--surface-2)"/><text x="138" y="107" fill="var(--muted)">วันนี้</text><text x="138" y="127" font-size="14" font-weight="700" fill="var(--pos)">+12.40</text>
<rect x="242" y="90" width="104" height="48" rx="10" fill="var(--surface-2)"/><text x="252" y="107" fill="var(--muted)">ตั้งแต่เริ่ม</text><text x="252" y="127" font-size="14" font-weight="700" fill="var(--pos)">+42.10</text>
</g>
<rect x="14" y="148" width="332" height="74" rx="10" fill="var(--surface-2)"/>
<text x="24" y="166" ${T} font-size="10.5" fill="var(--muted)">ไม้ที่เปิดอยู่</text>
<rect x="30" y="184" width="300" height="7" rx="3.5" fill="var(--line)"/>
<rect x="30" y="184" width="96" height="7" rx="3.5" fill="color-mix(in srgb, var(--neg) 45%, var(--surface))"/>
<rect x="126" y="184" width="204" height="7" rx="3.5" fill="color-mix(in srgb, var(--pos) 45%, var(--surface))"/>
<rect x="125" y="179" width="2" height="17" fill="var(--ink-2)"/><circle cx="214" cy="187.5" r="6.5" fill="var(--pos)" stroke="var(--surface)" stroke-width="2.5"/>
<g ${T} font-size="10" fill="var(--muted)"><text x="24" y="211">SL</text><text x="112" y="211">ราคาเข้า</text><text x="320" y="211">TP</text></g>
<g ${T} font-size="11" font-weight="700" fill="#fff">
<circle cx="334" cy="22" r="10" fill="var(--primary)"/><text x="330.5" y="26">1</text>
<circle cx="112" cy="94" r="10" fill="var(--primary)"/><text x="108.5" y="98">2</text>
<circle cx="334" cy="156" r="10" fill="var(--primary)"/><text x="330.5" y="160">3</text>
</g></svg>`;

export const ART_SETTINGS = `<svg viewBox="0 0 360 230" role="img" aria-label="ตัวอย่างหน้าตั้งค่าบอท: สวิตช์สูตร ปุ่มเพิ่มลดล็อต และแถบบันทึก">
<rect x="1" y="1" width="358" height="228" rx="16" fill="var(--surface)" stroke="var(--line)"/>
<g ${T} font-size="12.5" fill="var(--ink)">
<rect x="14" y="14" width="332" height="38" rx="10" fill="var(--surface-2)"/><text x="26" y="38" font-weight="600">A_new</text>
<rect x="290" y="23" width="40" height="22" rx="11" fill="var(--primary)"/><circle cx="319" cy="34" r="8" fill="#fff"/>
<rect x="14" y="58" width="332" height="38" rx="10" fill="var(--surface-2)"/><text x="26" y="82" font-weight="600">NY</text>
<rect x="290" y="67" width="40" height="22" rx="11" fill="var(--primary)"/><circle cx="319" cy="78" r="8" fill="#fff"/>
<rect x="14" y="102" width="332" height="38" rx="10" fill="var(--surface-2)"/><text x="26" y="126" font-weight="600">เอเชีย</text>
<rect x="290" y="111" width="40" height="22" rx="11" fill="var(--line-2)"/><circle cx="301" cy="122" r="8" fill="#fff"/>
<text x="26" y="166" fill="var(--muted)" font-size="11.5">ล็อตต่อไม้</text>
<rect x="110" y="150" width="130" height="26" rx="13" fill="var(--surface-2)" stroke="var(--line-2)"/>
<text x="124" y="168" font-size="15" font-weight="700">−</text><text x="157" y="168" font-weight="700">0.03</text><text x="222" y="168" font-size="15" font-weight="700">+</text>
</g>
<rect x="14" y="186" width="332" height="32" rx="10" fill="var(--ink)"/>
<text x="26" y="206" ${T} font-size="11.5" fill="var(--bg)">1 การเปลี่ยนแปลง</text>
<rect x="196" y="191" width="142" height="22" rx="8" fill="var(--primary)"/>
<text x="205" y="206" ${T} font-size="11" font-weight="600" fill="#fff">บันทึกและส่งให้บอท</text>
</svg>`;

export const ART_PROGRESS = `<svg viewBox="0 0 360 64" role="img" aria-label="3 ขั้น: ส่งแล้ว เครื่องรับแล้ว EA ใช้ค่าใหม่แล้ว">
<path d="M40 22H320" stroke="var(--line-2)" stroke-width="3"/><path d="M40 22H180" stroke="var(--good)" stroke-width="3"/>
<circle cx="40" cy="22" r="13" fill="var(--good)"/><path d="M34 22l4 4 8-8" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
<circle cx="180" cy="22" r="13" fill="var(--good)"/><path d="M174 22l4 4 8-8" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
<circle cx="320" cy="22" r="13" fill="var(--surface)" stroke="var(--primary)" stroke-width="3"/><text x="316" y="27" ${T} font-size="13" font-weight="700" fill="var(--primary-ink)">3</text>
<g ${T} font-size="11.5" fill="var(--ink-2)" text-anchor="middle"><text x="40" y="54">ส่งแล้ว</text><text x="180" y="54">เครื่องรับแล้ว</text><text x="320" y="54">EA ใช้ค่าใหม่</text></g>
</svg>`;

export const ART_LIVE = `<svg viewBox="0 0 360 120" role="img" aria-label="สวิตช์เทรดจริง เปิดต้องใส่รหัสผ่านและรหัส 2FA">
<rect x="20" y="30" width="96" height="54" rx="27" fill="var(--gold)"/><circle cx="89" cy="57" r="21" fill="#fffdf5"/>
<text x="68" y="106" ${T} font-size="12" font-weight="600" fill="var(--ink-2)" text-anchor="middle">เทรดจริง เปิด</text>
<path d="M138 57h34" stroke="var(--muted)" stroke-width="3" stroke-dasharray="3 6" stroke-linecap="round"/>
<rect x="186" y="34" width="70" height="46" rx="10" fill="var(--surface-2)" stroke="var(--line-2)"/>
<g fill="var(--ink-2)"><circle cx="201" cy="57" r="4"/><circle cx="215" cy="57" r="4"/><circle cx="229" cy="57" r="4"/><circle cx="243" cy="57" r="4"/></g>
<text x="221" y="106" ${T} font-size="12" fill="var(--ink-2)" text-anchor="middle">รหัสผ่าน</text>
<path d="M300 26l26 10v18c0 15-11 26-26 30-15-4-26-15-26-30V36z" fill="var(--good-soft)" stroke="var(--good-ink)" stroke-width="3" stroke-linejoin="round"/>
<path d="M290 55l7 7 14-15" fill="none" stroke="var(--good-ink)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
<text x="300" y="106" ${T} font-size="12" fill="var(--ink-2)" text-anchor="middle">2FA (ถ้าเปิดไว้)</text>
</svg>`;

export const ART_NEWS = `<svg viewBox="0 0 360 120" role="img" aria-label="งดเข้าไม้ 30 นาทีก่อนข่าว ถึง 90 นาทีหลังข่าว">
<rect x="96" y="36" width="230" height="34" rx="8" fill="var(--warn-soft)" stroke="color-mix(in srgb, var(--warn) 60%, transparent)"/>
<path d="M16 53H344" stroke="var(--line-2)" stroke-width="3" stroke-linecap="round"/>
<path d="M154 22v62" stroke="var(--crit)" stroke-width="3" stroke-linecap="round"/>
<circle cx="154" cy="22" r="9" fill="var(--crit)"/><path d="M154 17v6M154 26v.5" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/>
<g ${T} font-size="12" fill="var(--ink-2)" text-anchor="middle">
<text x="96" y="100">−30 นาที</text><text x="154" y="100" font-weight="700" fill="var(--crit-ink)">ข่าวออก</text><text x="326" y="100">+90 นาที</text>
<text x="240" y="58" font-weight="600" fill="var(--warn-ink)">บอทไม่เปิดไม้ใหม่</text></g>
</svg>`;

// Price over time: rises to 85 % of the way to TP, the SL moves up to 83 %, the price falls back and the trade still
// closes in profit.
export const ART_LOCK = `<svg viewBox="0 0 360 200" role="img" aria-label="ล็อกกำไร: ราคาวิ่งถึง 85% ของทาง TP บอทเลื่อน SL ไป 83% ราคากลับลงมา ไม้ปิดที่กำไร 83%">
<g ${T} font-size="11.5">
<path d="M52 30H340" stroke="var(--pos)" stroke-width="2" stroke-dasharray="6 5"/><text x="8" y="34" fill="var(--pos)" font-weight="700">TP</text>
<path d="M52 130H340" stroke="var(--ink-2)" stroke-width="2"/><text x="8" y="134" fill="var(--ink-2)">ราคาเข้า</text>
<path d="M52 180H160" stroke="var(--neg)" stroke-width="2" stroke-dasharray="6 5"/><text x="8" y="184" fill="var(--neg)" font-weight="700">SL</text>
<path d="M160 180V53" stroke="var(--gold-lo)" stroke-width="2.5" marker-end="url(#ah)"/>
<path d="M160 47H340" stroke="var(--gold)" stroke-width="3"/>
<text x="250" y="42" fill="var(--gold-ink)" font-weight="700">SL ใหม่ 83%</text>
<path d="M52 130 L80 118 L102 124 L128 92 L146 70 L160 45 L180 38 L198 33 L216 41 L236 47" fill="none" stroke="var(--primary)" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>
<circle cx="160" cy="45" r="5" fill="var(--primary)"/><text x="140" y="60" fill="var(--primary-ink)" font-weight="700" text-anchor="end">ถึง 85%</text>
<circle cx="236" cy="47" r="6" fill="var(--gold)" stroke="var(--surface)" stroke-width="2"/>
<text x="196" y="80" fill="var(--ink-2)">ราคากลับลง โดน SL ใหม่</text><text x="196" y="96" fill="var(--pos)" font-weight="700">ยังได้กำไรราว 83%</text>
</g>
<defs><marker id="ah" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="var(--gold-lo)"/></marker></defs>
</svg>`;

export const ART_SMARTSCREEN = `<svg viewBox="0 0 360 190" role="img" aria-label="หน้าจอสีฟ้า Windows protected your PC กด More info แล้วกด Run anyway">
<rect x="1" y="1" width="358" height="188" rx="12" fill="#1f5fae"/>
<g ${T} fill="#fff">
<text x="20" y="38" font-size="17" font-weight="600">Windows protected your PC</text>
<text x="20" y="62" font-size="11" opacity=".9">Microsoft Defender SmartScreen prevented an</text>
<text x="20" y="78" font-size="11" opacity=".9">unrecognized app from starting...</text>
<text x="20" y="104" font-size="12" font-weight="700" text-decoration="underline">More info</text>
</g>
<circle cx="96" cy="100" r="11" fill="var(--gold)"/><text x="92" y="105" ${T} font-size="12" font-weight="700" fill="#1d1503">1</text>
<rect x="196" y="140" width="76" height="30" rx="2" fill="#fff" opacity=".18" stroke="#fff"/>
<text x="206" y="160" ${T} font-size="12" font-weight="600" fill="#fff">Run anyway</text>
<rect x="280" y="140" width="64" height="30" rx="2" fill="#fff" opacity=".1" stroke="#fff" stroke-opacity=".6"/>
<text x="291" y="160" ${T} font-size="12" fill="#fff">Don't run</text>
<circle cx="196" cy="140" r="11" fill="var(--gold)"/><text x="192" y="145" ${T} font-size="12" font-weight="700" fill="#1d1503">2</text>
</svg>`;

export const ART_WELCOME = `<svg viewBox="0 0 360 150" role="img" aria-label="Dobby บนมือถือและคอม">
<rect x="34" y="24" width="190" height="112" rx="12" fill="var(--surface-2)" stroke="var(--line-2)" stroke-width="2"/>
<rect x="46" y="36" width="166" height="76" rx="6" fill="var(--surface)"/>
<path d="M58 96l26-26 20 14 30-34 26 22 40-30" fill="none" stroke="var(--gold)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
<rect x="246" y="14" width="80" height="128" rx="14" fill="var(--surface)" stroke="var(--line-2)" stroke-width="2"/>
<rect x="256" y="30" width="60" height="28" rx="7" fill="var(--gold-soft)"/>
<circle cx="268" cy="44" r="5" fill="var(--gold)"/><rect x="278" y="40" width="30" height="7" rx="3.5" fill="var(--gold-lo)" opacity=".5"/>
<rect x="256" y="66" width="60" height="9" rx="4.5" fill="var(--line)"/><rect x="256" y="81" width="42" height="9" rx="4.5" fill="var(--line)"/>
<rect x="256" y="108" width="60" height="20" rx="7" fill="var(--primary)"/>
<path d="M7 130h346" stroke="var(--line)" stroke-width="2" stroke-linecap="round"/>
</svg>`;

export const ART_HELP = `<svg viewBox="0 0 360 120" role="img" aria-label="ปุ่ม ? มุมขวาบนของทุกหน้า">
<rect x="20" y="16" width="320" height="88" rx="14" fill="var(--surface)" stroke="var(--line)"/>
<rect x="36" y="34" width="120" height="14" rx="7" fill="var(--ink-2)" opacity=".7"/>
<rect x="36" y="58" width="190" height="10" rx="5" fill="var(--line)"/><rect x="36" y="76" width="150" height="10" rx="5" fill="var(--line)"/>
<rect x="246" y="28" width="80" height="30" rx="15" fill="var(--primary-soft)" stroke="color-mix(in srgb, var(--primary) 35%, transparent)"/>
<circle cx="264" cy="43" r="9" fill="var(--primary)"/><text x="260.5" y="47.5" ${T} font-size="12" font-weight="700" fill="#fff">?</text>
<text x="280" y="48" ${T} font-size="12" font-weight="600" fill="var(--primary-ink)">วิธีใช้</text>
</svg>`;
