// ประวัติ > ภาพรวม: counting rounds (SPEC 9.8). The panel lists every round with its own numbers; the owner starts a
// new round (with the summary of the round it closes, and optionally the bot's capital set to the real balance),
// names rounds, and undoes the latest one. A round only splits the history on the website: the bot never reads it.
import { h, icon, fmtNum, fmtThai, money, pnl, fmtPct, toast, errText, confirmDialog, openModal, field, busy, callout, newId } from './util.js';
import { roundsOf, currentRound, roundTitle, roundLabel, roundSummary, capitalFix, roundBase } from './rounds.js';
import { normDesired, patchDesired } from './botctl.js';
import { currentValues, toDesiredParams } from './simple.js';
import { normalizeParams } from './params.js';
import { panel } from './views.js';

const STALE_MS = 15 * 60000;

const range = (s) => {
  const a = Number.isFinite(s.from) ? fmtThai(s.from, 'dm') : 'เริ่มต้น';
  const b = Number.isFinite(s.to) ? fmtThai(s.to, 'dm') : 'ตอนนี้';
  return a === b ? a : `${a} – ${b}`;
};
const counts = (st) => (st.trades ? `${st.trades} ไม้ ชนะ ${st.wins} (${fmtPct(st.winRate, 0)})` : 'ยังไม่มีไม้ที่ปิด');

// c: { api, bot, ro, st, rows (rounds table rows), trades (paired, ascending, rebased), flows, firstUtc, selected (n),
//      select(n), changed(): Promise, ensureAll(): Promise }
export function roundsPanel(c) {
  const rounds = roundsOf(c.rows);
  const cur = (c.st && c.st.account && c.st.account.currency) || 'USD';
  const startBtn = c.ro ? null : h('button', { class: 'btn small', type: 'button', onclick: (e) => startRoundDialog(c, e.currentTarget) }, icon('refresh'), 'เริ่มนับรอบใหม่');
  if (!rounds.length) {
    return panel('รอบการนับ', { actions: startBtn, sub: 'อยากให้กำไรและจำนวนไม้เริ่มนับจาก 0 ใหม่ กดเริ่มนับรอบใหม่ ประวัติเดิมยังอยู่ครบ' },
      h('p', { class: 'muted' }, `ตอนนี้นับรวมทุกไม้ตั้งแต่ ${Number.isFinite(c.firstUtc) ? fmtThai(c.firstUtc, 'date') : 'เริ่มใช้'}`));
  }
  const sums = rounds.map((r) => roundSummary(r, c.trades, c.flows, c.firstUtc)).reverse();
  const last = currentRound(rounds);
  const actBtn = (label, ic, fn) => h('button', { class: 'icon-btn', type: 'button', 'aria-label': label, title: label, onclick: (e) => { e.stopPropagation(); fn(e.currentTarget); } }, icon(ic));
  return panel('รอบการนับ', { actions: startBtn, sub: 'แต่ละรอบนับไม้ที่ปิดในรอบนั้น กดที่รอบเพื่อดูกราฟและตัวเลขของรอบ' },
    h('div', { class: 'table-wrap' }, h('table', { class: 'rtable rounds' },
      h('thead', null, h('tr', null, ['รอบ', 'ช่วง', 'ไม้', 'อัตราชนะ', 'กำไร', 'ลดลงมากสุด', ''].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', null, sums.map((s) => {
        const r = s.round;
        return h('tr', {
          class: `click-row${c.selected === r.n ? ' sel' : ''}`, 'aria-selected': c.selected === r.n ? 'true' : 'false',
          onclick: (e) => { if (!e.target.closest('button')) c.select(r.n); },
        },
        h('td', { 'data-label': 'รอบ' }, h('button', { class: 'linklike strong', type: 'button', onclick: () => c.select(r.n) }, roundTitle(r)),
          r.current ? h('span', { class: 'chip good' }, 'รอบนี้') : null,
          r.name ? h('span', { class: 'round-name' }, r.name) : null),
        h('td', { 'data-label': 'ช่วง' }, range(s)),
        h('td', { 'data-label': 'ไม้', class: 'num' }, `${s.stats.trades} (${s.stats.wins}/${s.stats.losses})`),
        h('td', { 'data-label': 'อัตราชนะ', class: 'num' }, s.stats.winRate === null ? '—' : fmtPct(s.stats.winRate, 0)),
        h('td', { 'data-label': 'กำไร', class: 'num' }, pnl(s.net), s.pct !== null && s.stats.trades ? h('span', { class: 'muted small' }, ` ${fmtPct(s.pct, 1, true)}`) : null),
        h('td', { 'data-label': 'ลดลงมากสุด', class: 'num' }, s.maxDd > 0.005 ? `−${fmtNum(s.maxDd)}` : '—'),
        h('td', { 'data-label': '', class: 'row-actions' }, c.ro ? null : [
          actBtn(`ตั้งชื่อ${roundTitle(r)}`, 'edit', () => renameDialog(c, r)),
          r === last && rounds.length > 1 ? actBtn(`ยกเลิก${roundTitle(r)}`, 'x', () => undoDialog(c, s, rounds)) : null,
        ]));
      })))),
    c.st && c.st.account ? h('p', { class: 'muted small' }, 'ยอดเงินในบัญชีตอนนี้ ', money(c.st.account.balance, { unit: cur })) : null);
}

// ------------------------------------------------------------------ start a new round
export async function startRoundDialog(c, btn) {
  if (c.ro) return;
  busy(btn, true);
  try { await c.ensureAll(); } catch (e) { busy(btn, false); toast(errText(e), 'error', 6000); return; } finally { busy(btn, false); }
  const st = c.st;
  const cur = (st && st.account && st.account.currency) || 'USD';
  const rounds = roundsOf(c.rows);
  // the round this closes: the current one, or round 1 = everything so far
  const closing = currentRound(rounds) || { id: null, n: 1, name: (c.rows.find((r) => !r.started_at) || {}).name || '', from: -Infinity, to: Infinity, base: {} };
  const s = roundSummary({ ...closing, to: Infinity }, c.trades, c.flows, c.firstUtc);
  const fix = capitalFix(st);
  const hb = st && Number.isFinite(st.heartbeat_gmt_unix) ? st.heartbeat_gmt_unix * 1000 : NaN;
  const fresh = Number.isFinite(hb) && Date.now() - hb < STALE_MS;
  const canSend = st ? !!st.remote : parseFloat(c.bot.ea_version || '0') >= 3.04;
  const offerFix = !!(fix && fix.needed && fix.possible && fresh && canSend);

  const nameOld = h('input', { class: 'input', type: 'text', maxlength: 60, value: closing.name || '', placeholder: 'เช่น ทดลอง 0.03' });
  const nameNew = h('input', { class: 'input', type: 'text', maxlength: 60, placeholder: 'เช่น หลังปรับทุน' });
  // ticked when it lowers the capital the bot counts (a smaller daily cap); raising it is left to the owner to tick
  const fixBox = h('input', { type: 'checkbox', checked: offerFix && fix.diff > 0 });
  const err = h('p', { class: 'field-error', role: 'alert' });
  const fid = newId('round');
  const capPct = Number(st && st.params && st.params.daily_cap_pct) || 10;
  const capNote = fix ? `จุดหยุดรายวัน ${fmtNum(capPct, 0)}% จึงคิดจากทุนราว ${fmtNum(fix.virtual, 0)} (≈ ${fmtNum((capPct / 100) * fix.virtual, 0)} ต่อวัน) แทนที่จะเป็นราว ${fmtNum((capPct / 100) * fix.balance, 0)}` : '';
  const since = fix && fix.startDate ? fix.startDate.slice(0, 10).replace(/\./g, '-') : '';

  let capital = null;
  if (!fix) capital = null;
  else if (!fix.needed) capital = h('p', { class: 'muted small' }, `ทุนที่บอทนับ (${fmtNum(fix.virtual)}) ตรงกับยอดเงินในบัญชีแล้ว ไม่ต้องปรับ`);
  else if (!fix.possible) capital = callout('warn', 'ปรับทุนให้ตรงยอดในบัญชีไม่ได้', h('p', null, `กำไรที่บอทนับไว้ (${fmtNum(fix.botPnl)}) มากกว่ายอดเงินในบัญชี เช่น ถอนกำไรออกไปแล้ว ปรับทุนของบอทเองที่ตั้งค่าบอท`));
  else if (!canSend) capital = callout('warn', 'EA รุ่นนี้รับทุนจากเว็บไม่ได้', h('p', null, `ทุนที่บอทนับ ${fmtNum(fix.virtual)} ไม่ตรงกับยอดในบัญชี ${fmtNum(fix.balance)} ถ้าจะให้ตรง เปลี่ยน InpVirtualStart เป็น ${fmtNum(fix.next)} ที่เครื่อง ${c.bot.name} เอง`));
  else if (!fresh) capital = callout('warn', 'ยังปรับทุนตอนนี้ไม่ได้', h('p', null, `สถานะล่าสุดจากบอทเก่าเกิน 15 นาที${Number.isFinite(hb) ? ` (${fmtThai(hb, 'short')} น.)` : ''} รอให้แอปที่เครื่องออนไลน์ แล้วเริ่มรอบใหม่อีกครั้ง หรือเริ่มรอบไปก่อนแล้วปรับทุนทีหลังที่ตั้งค่าบอท`));
  else {
    capital = h('div', { class: 'stack' },
      h('label', { class: 'check agree' }, fixBox, h('span', null, `ให้บอทนับทุนเท่ายอดเงินในบัญชี (${fmtNum(fix.balance)} ${cur})`)),
      h('ul', { class: 'explain-list' },
        h('li', null, icon('info'), h('span', null, `ตอนนี้บอทนับทุน ${fmtNum(fix.virtual)} คือค่าที่ตั้งไว้ ${fmtNum(fix.start)} บวกกำไรของบอท ${fix.botPnl >= 0 ? '+' : '−'}${fmtNum(Math.abs(fix.botPnl))}${since ? ` ตั้งแต่ ${fmtThai(Date.parse(`${since}T12:00:00Z`), 'dm')}` : ''} แต่ยอดเงินในบัญชีมี ${fmtNum(fix.balance)} ${fix.diff > 0 ? 'กำไรก้อนนี้อยู่ในยอดเงินในบัญชีแล้วจึงถูกนับซ้ำ' : 'เช่น มีเงินฝากที่ยังไม่ได้บวกเข้าทุน'} ${capNote}`)),
        h('li', null, icon('send'), h('span', null, `บอทจะนับทุน ${fmtNum(fix.balance)} เท่ายอดเงินในบัญชี ล็อตไม่เปลี่ยน (เว็บส่งค่า ${fmtNum(fix.next)} แทน ${fmtNum(fix.start)} เพราะบอทบวกกำไรของตัวเองให้อีกที หน้าตั้งค่าบอทจะแสดงทุนของบอท ${fmtNum(fix.balance)})`)),
        h('li', null, icon('clock'), h('span', null, 'บอทใช้ค่าใหม่ตอนไม่มีไม้ค้าง ดูความคืบหน้าได้ที่ตั้งค่าบอท'))));
  }

  const m = openModal({
    title: 'เริ่มนับรอบใหม่?',
    body: h('form', {
      id: fid, class: 'stack',
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        const okBtn = m.foot.querySelector('button[type=submit]');
        busy(okBtn, true);
        const withFix = offerFix && fixBox.checked;
        try {
          const first = c.rows.find((r) => !r.started_at);
          const n1 = nameOld.value.trim();
          const add = [];
          if (closing.id === null && !first) add.push({ started_at: null, name: n1 });
          else if (closing.id !== null && n1 !== (closing.name || '')) await c.api.renameRound(c.bot.id, closing.id, n1);
          else if (closing.id === null && first && n1 !== (first.name || '')) await c.api.renameRound(c.bot.id, first.id, n1);
          add.push({ started_at: new Date().toISOString(), name: nameNew.value.trim(), base: { ...roundBase(st), capital_next: withFix ? fix.next : null } });
          await c.api.addRounds(c.bot.id, add);
        } catch (ex) { busy(okBtn, false); err.textContent = errText(ex); return; }
        let sent = false;
        if (withFix) {
          try { await sendCapital(c, fix.next); sent = true; } catch (ex) {
            toast(`เริ่มรอบใหม่แล้ว แต่ส่งทุนให้บอทไม่สำเร็จ: ${errText(ex)} ปรับเองได้ที่ตั้งค่าบอท`, 'error', 9000);
          }
        }
        m.close();
        if (!withFix || sent) toast(sent ? `เริ่มรอบที่ ${closing.n + 1} แล้ว และส่งให้บอทนับทุน ${fmtNum(fix.balance)} แล้ว บอทใช้เมื่อไม่มีไม้ค้าง` : `เริ่มรอบที่ ${closing.n + 1} แล้ว`, 'good', 6500);
        await c.changed(closing.n + 1);
      },
    },
    h('div', { class: 'round-close' },
      h('p', { class: 'round-close-title' }, `${roundLabel(closing)}: ${range({ from: s.from, to: Date.now() })}`),
      h('p', { class: 'round-close-figs' }, h('span', null, counts(s.stats)), ' ', money(s.net, { signed: true, unit: cur }), s.pct !== null ? h('span', { class: 'muted' }, ` (${fmtPct(s.pct, 1, true)})`) : null)),
    h('p', null, `ตัวเลขบนเว็บจะเริ่มนับจาก 0 ที่รอบที่ ${closing.n + 1} ประวัติเดิมยังอยู่ครบ ดูย้อนหลังได้ที่ตัวเลือก "รอบ" ในหน้าประวัติ และยกเลิกรอบใหม่ได้ถ้ากดผิด`),
    h('div', { class: 'grid-2 tight' },
      field(`ชื่อ${roundTitle(closing)} (ไม่บังคับ)`, nameOld), field(`ชื่อรอบที่ ${closing.n + 1} (ไม่บังคับ)`, nameNew)),
    capital,
    h('p', { class: 'muted small' }, 'การแบ่งรอบไม่เปลี่ยนการเทรดของบอท ตัวนับบนกราฟ MT5 ยังนับต่อจากเดิม'),
    err),
    actions: [{ label: 'ยกเลิก' }, { label: 'เริ่มรอบใหม่', kind: 'primary', submit: true, form: fid, icon: 'check' }],
  });
  const okBtn = m.foot.querySelector('button[type=submit]');
  const relabel = () => { if (okBtn) okBtn.lastChild.textContent = offerFix && fixBox.checked ? 'เริ่มรอบใหม่และส่งทุนให้บอท' : 'เริ่มรอบใหม่'; };
  fixBox.addEventListener('change', relabel);
  relabel();
}

// InpVirtualStart = value, through desired.params like any other setting (EA v3.04, normal version check)
async function sendCapital(c, value) {
  const ctl = await c.api.botControl(c.bot.id);
  if (!ctl) throw new Error('no bot_control row');
  const vals = currentValues(c.st, normDesired(ctl.desired).params).values;
  await patchDesired(c.bot.id, (n) => {
    const base = n.params ? normalizeParams({ ...vals, ...n.params }) : normalizeParams(vals);
    base.InpVirtualStart = value;
    n.params = toDesiredParams(base, { eaVersion: (c.st && c.st.ea_version) || c.bot.ea_version });
  });
}

// ------------------------------------------------------------------ rename / undo
function renameDialog(c, r) {
  const inp = h('input', { class: 'input', type: 'text', maxlength: 60, value: r.name || '', placeholder: 'เช่น ทดลอง 0.03' });
  const err = h('p', { class: 'field-error', role: 'alert' });
  const fid = newId('rname');
  const m = openModal({
    title: `ตั้งชื่อ${roundTitle(r)}`,
    body: h('form', {
      id: fid, class: 'stack',
      onsubmit: async (e) => {
        e.preventDefault();
        const btn = m.foot.querySelector('button[type=submit]');
        busy(btn, true);
        try {
          const name = inp.value.trim();
          if (r.id === null) await c.api.addRounds(c.bot.id, [{ started_at: null, name }]);
          else await c.api.renameRound(c.bot.id, r.id, name);
          m.close();
          toast(name ? `ตั้งชื่อ${roundTitle(r)} เป็น "${name}" แล้ว` : `ลบชื่อ${roundTitle(r)} แล้ว`, 'good');
          await c.changed();
        } catch (ex) { busy(btn, false); err.textContent = errText(ex); }
      },
    }, field('ชื่อรอบ', inp, { hint: 'ไม่เกิน 60 ตัวอักษร เว้นว่างได้' }), err),
    actions: [{ label: 'ยกเลิก' }, { label: 'บันทึกชื่อ', kind: 'primary', submit: true, form: fid, icon: 'check' }],
  });
  setTimeout(() => inp.select(), 30);
}

async function undoDialog(c, s, rounds) {
  const r = s.round, prev = rounds[r.n - 2];
  const cur = (c.st && c.st.account && c.st.account.currency) || 'USD';
  const capNote = r.base && Number.isFinite(Number(r.base.capital_next)) && r.base.capital_next !== null
    ? ' ทุนของบอทที่ส่งไปตอนเริ่มรอบไม่เปลี่ยนกลับ ปรับเองได้ที่ตั้งค่าบอท' : '';
  const ok = await confirmDialog(`ยกเลิก${roundTitle(r)}?`,
    s.stats.trades ? `ไม้ของ${roundTitle(r)} (${counts(s.stats)} ${s.net >= 0 ? '+' : '−'}${fmtNum(Math.abs(s.net))} ${cur}) จะกลับไปรวมกับ${roundLabel(prev)} ประวัติการเทรดไม่หายไป${capNote}`
      : `${roundTitle(r)} ยังไม่มีไม้ที่ปิด ตัวเลขจะกลับไปนับรวมกับ${roundLabel(prev)}${capNote}`,
    { ok: `ยกเลิก${roundTitle(r)}`, cancel: 'ไม่ยกเลิก', danger: true });
  if (!ok) return;
  try {
    await c.api.deleteRound(c.bot.id, r.id);
    toast(`ยกเลิก${roundTitle(r)} แล้ว ไม้กลับไปรวมกับ${roundTitle(prev)}`, 'good');
    await c.changed(prev.n);
  } catch (e) { toast(errText(e), 'error', 6000); }
}
