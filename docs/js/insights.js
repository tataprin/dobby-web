// Strategy health and risk views (SPEC 9.4 / 9.5), shared by ประวัติ > ภาพรวม (full panels) and ภาพรวม (one compact
// strip). Numbers come from analytics.js; this file only words and lays them out.
import { h, icon, fmtNum, fmtPct, money, fmtThai } from './util.js';
import { HEALTH_WINDOW, HEALTH_MIN, HEALTH_LABEL } from './analytics.js';
import { modChip, panel } from './views.js';

const pfText = (x) => (x === null || x === undefined ? '—' : x === Infinity ? '∞' : fmtNum(x));
const TONE = { ok: 'good', watch: 'warn', bad: 'bad', few: '', none: '' };

function healthSentence(x) {
  if (x.status === 'none') return x.n ? `${x.n} ไม้ล่าสุด ชนะ ${x.wins} ไม้ ไม่มีผลทดสอบของสูตรนี้ให้เทียบ` : 'ยังไม่มีไม้ที่ปิดแล้ว';
  if (x.status === 'few') return x.n ? `มีไม้ที่ปิดแล้ว ${x.n} ไม้ ต้องมีอย่างน้อย ${HEALTH_MIN} ไม้จึงจะเทียบได้` : 'ยังไม่มีไม้ที่ปิดแล้วของสูตรนี้';
  const b = x.base, wr = Math.round(x.winRate), bwr = Math.round(b.winRate);
  const reasons = [];
  if (x.p < 0.10) reasons.push(`ชนะ ${wr}% น้อยกว่าที่ทดสอบไว้ (${bwr}%) มากกว่าปกติ`);
  if (x.pf !== null && x.pf < 1.0) reasons.push(`ขาดทุนรวมมากกว่ากำไรรวม (PF ${pfText(x.pf)})`);
  const chance = x.p < 0.10 ? ` ถ้าสูตรยังเหมือนตอนทดสอบ โอกาสที่จะชนะน้อยขนาดนี้มีราว ${fmtPct(x.p * 100, 0)}` : '';
  if (x.status === 'ok') return `${x.n} ไม้ล่าสุด ชนะ ${x.wins} ไม้ (${wr}%) ใกล้เคียงกับที่ทดสอบไว้ (${bwr}%) และกำไรรวมยังมากกว่าขาดทุน (PF ${pfText(x.pf)})`;
  if (x.status === 'watch') return `${x.n} ไม้ล่าสุด ${reasons.join(' และ ')} ยังไม่ถึงขั้นผิดปกติ แต่ควรจับตาดู${chance}`;
  return `${x.n} ไม้ล่าสุด ${reasons.join(' และ ') || 'ห่างจากที่ทดสอบไว้มาก'} ห่างจากผลทดสอบมาก ลองพิจารณาปิดสูตรนี้ชั่วคราวที่หน้าตั้งค่าบอท (เว็บไม่ปิดให้เอง)${chance}`;
}

export function healthPanel(health, { owner = true } = {}) {
  const items = health.filter((x) => x.base || x.n).map((x) => {
    const b = x.base;
    const cell = (label, live, base) => h('div', { class: 'hn-cell' }, h('dt', null, label), h('dd', null, live, base ? h('span', { class: 'hn-base' }, ` ทดสอบ ${base}`) : null));
    return h('li', { class: `health-item tone-${x.status}` },
      h('div', { class: 'health-head' }, modChip(x.module), h('span', { class: `chip ${TONE[x.status]}` }, x.status === 'ok' ? icon('check') : x.status === 'watch' || x.status === 'bad' ? icon('warn') : null, HEALTH_LABEL[x.status]),
        h('span', { class: 'muted small' }, x.n ? `${x.n} ไม้ล่าสุด` : '')),
      h('p', { class: 'health-text' }, healthSentence(x)),
      x.n && x.status !== 'few' ? h('dl', { class: 'health-nums' },
        cell('อัตราชนะ', h('span', { class: 'num' }, x.winRate === null ? '—' : fmtPct(x.winRate, 0)), b ? fmtPct(b.winRate, 0) : null),
        cell('Profit factor', h('span', { class: 'num' }, pfText(x.pf)), b ? fmtNum(b.pf) : null),
        cell('เฉลี่ยต่อไม้ (0.01 ล็อต)', money(x.expectancy, { signed: true }), b ? (b.expectancy >= 0 ? '+' : '') + fmtNum(b.expectancy) : null)) : null,
      x.status === 'bad' && owner ? h('a', { class: 'link-quiet', href: '#/bot' }, 'ไปที่ตั้งค่าบอท > สูตรที่เปิดใช้') : null);
  });
  return panel('สุขภาพของแต่ละสูตร', { sub: `เทียบ ${HEALTH_WINDOW} ไม้ล่าสุดของแต่ละสูตรกับผลทดสอบย้อนหลัง (คิดเป็นล็อต 0.01)` },
    h('ul', { class: 'health-list' }, items),
    h('p', { class: 'muted small' }, 'ผลทดสอบเป็นการจำลองย้อนหลังด้วย EA v3.04 ช่วง 15 ก.ค. ถึง 22 ต.ค. 2026 (209 ไม้) ไม่ใช่การพยากรณ์ ผลจริงต่างจากนี้ได้'));
}

// foot: text / inline nodes (one line), or an array that starts with a block element (meter + line)
const cellEl = (label, value, foot, cls = '') => h('div', { class: `rk-cell ${cls}`.trim() }, h('p', { class: 'rk-label' }, label), h('p', { class: 'rk-value' }, value),
  foot ? h('div', { class: 'rk-foot' }, Array.isArray(foot) && foot[0] instanceof HTMLElement && foot[0].tagName === 'DIV' ? foot : h('p', null, foot)) : null);

export function riskPanel(r, cur, rangeLabel) {
  const b = r.budget;
  const tone = b.hit || (b.used ?? 0) >= 0.8 ? 'critical' : (b.used ?? 0) >= 0.5 ? 'warn' : 'ok';
  return panel('ความเสี่ยง', { sub: rangeLabel ? `จากไม้ที่ปิดในช่วงที่เลือก (${rangeLabel}) และสถานะวันนี้` : null },
    h('div', { class: 'rk-grid' },
      cellEl('ลดลงจากจุดสูงสุด', r.curDd === null ? '—' : money(-r.curDd, { signed: true, unit: cur }),
        r.curDd === null ? 'ยังไม่มีไม้ที่ปิด' : r.curDd > 0.005 ? [h('span', { class: 'num' }, fmtPct(-r.curDdPct, 1, true)), ' จากจุดสูงสุด ', h('span', { class: 'num' }, fmtNum(r.peak))] : 'อยู่ที่จุดสูงสุดของช่วงนี้'),
      cellEl('ลดลงมากสุดในช่วงนี้', money(-r.maxDd, { signed: true, unit: cur }),
        r.maxDd > 0.005 ? [h('span', { class: 'num' }, fmtPct(-r.maxDdPct, 1, true)), r.maxDdAt ? ` เมื่อ ${fmtThai(r.maxDdAt, 'date')}` : ''] : 'ไม่มีช่วงที่ลดลง'),
      cellEl('แพ้ติดกันตอนนี้', h('span', { class: 'fig-text' }, `${r.streak} ไม้`), `นานสุดในช่วงนี้ ${r.longestStreak} ไม้`),
      cellEl('งบขาดทุนวันนี้', b.used === null ? '—' : h('span', { class: 'num' }, fmtPct((b.hit ? 1 : b.used) * 100, 0)), b.known ? [
        h('div', { class: 'meter', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round((b.used || 0) * 100)), 'aria-label': 'ขาดทุนวันนี้เทียบกับจุดหยุดรายวัน' },
          h('span', { class: 'meter-fill', style: { width: `${(b.hit ? 1 : b.used || 0) * 100}%` } })),
        h('p', null, b.hit ? 'ถึงจุดหยุดแล้ว วันนี้ไม่เปิดไม้ใหม่' : ['จุดหยุด ', h('span', { class: 'num' }, `−${fmtNum(b.capAmt, 0)}`), ` (${fmtNum(b.capPct, 0)}% ของทุนต้นวัน)`]),
      ] : 'ยังไม่มีสถานะจากบอท', `tone-${tone}`)));
}

// ภาพรวม: one quiet strip (drawdown, losing streak, strategy health) with the way to the full view
// period: 'ใน 30 วัน' (the dashboard's journal window) or 'ในรอบนี้' (SPEC 9.8)
export function riskStrip(r, health, cur, period = 'ใน 30 วัน') {
  const judged = health.filter((x) => ['ok', 'watch', 'bad'].includes(x.status));
  const flagged = health.filter((x) => x.status === 'watch' || x.status === 'bad');
  const hv = !judged.length ? 'ยังน้อยเกินไป' : flagged.length ? flagged.map((x) => `${HEALTH_LABEL[x.status]} ${x.module}`).join(', ') : 'ปกติทุกสูตร';
  return h('section', { class: 'panel risk-strip', 'aria-label': 'ความเสี่ยง' },
    h('div', { class: 'dsec-head' }, h('h2', null, 'ความเสี่ยง'), h('a', { class: 'link-quiet', href: '#/history?tab=overview' }, 'ดูทั้งหมด')),
    h('div', { class: 'rk-grid three' },
      cellEl('ลดลงจากจุดสูงสุด', r.curDd === null ? '—' : money(-r.curDd, { signed: true, unit: cur }), r.curDd === null ? (period === 'ในรอบนี้' ? 'ยังไม่มีไม้ที่ปิดในรอบนี้' : 'ยังไม่มีไม้ที่ปิด') : r.maxDd > 0.005 ? `มากสุด${period} −${fmtNum(r.maxDd)}` : `ยังไม่เคยลดลง${period}`),
      cellEl('แพ้ติดกัน', h('span', { class: 'fig-text' }, `${r.streak} ไม้`), `นานสุด${period} ${r.longestStreak} ไม้`),
      cellEl('สุขภาพสูตร', h('span', { class: `fig-text${flagged.some((x) => x.status === 'bad') ? ' danger-text' : flagged.length ? ' warn-text' : ''}` }, hv),
        judged.length ? `เทียบ ${HEALTH_WINDOW} ไม้ล่าสุดกับผลทดสอบ` : `ต้องมีอย่างน้อย ${HEALTH_MIN} ไม้ต่อสูตร`)));
}
