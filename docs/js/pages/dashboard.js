// Dashboard: live state of the selected bot (SPEC 5 page 2). Realtime + 30 s fallback poll.
import { h, icon, fmtNum, fmtSigned, fmtPct, pnl, fmtThai, timeEl, serverToUtc, parseWall, toast, errText, confirmDialog,
  errorState, loadingState, isoUtc, agoSeconds, toneOf } from '../util.js';
import { app, currentBot, updateBotRow, on } from '../state.js';
import { normDesired, patchDesired, onlineInfo, onlineBadge, rejectionsBlock, effectiveState, isPending } from '../botctl.js';
import { liveSwitch, appliedLive } from '../liveswitch.js';
import { modChip, sideEl, kv, panel, noBotState, onOff } from '../views.js';
import { minutesToClock } from '../params.js';

function lockModules(s) {
  const m = /A=(\w+)\s+NY=(\w+)\s+C5G=(\w+)/.exec(s || '');
  if (!m) return s || '—';
  const on = [['A_new', m[1]], ['NY', m[2]], ['C5G', m[3]]].filter(([, v]) => v === 'true').map(([k]) => k);
  return on.length ? on.join(', ') : 'ไม่มีสูตร';
}

export async function render(root, ctx) {
  const bot0 = currentBot();
  if (!bot0) { root.append(noBotState()); return; }
  let bot = bot0, st = null, ctl = null, rtState = '';
  root.append(loadingState('กำลังโหลดสถานะบอท…'));
  try {
    const [s, c] = await Promise.all([ctx.api.botStatus(bot.id), ctx.api.botControl(bot.id)]);
    st = s ? s.status : null; ctl = c;
  } catch (e) {
    root.replaceChildren(errorState(e, () => ctx.route()));
    return;
  }
  root.replaceChildren();

  const headBox = h('div');
  const liveBox = h('div', { class: 'live-wrap' });
  const stateBox = h('div');
  const warnBox = h('div');
  const kpiBox = h('div');
  const posBox = h('div');
  const modBox = h('div');
  const detailBox = h('div', { class: 'grid-2' });
  root.append(headBox, h('div', { class: 'dash-top' }, liveBox, stateBox), warnBox, kpiBox, posBox, modBox, detailBox);

  const off = () => bot.server_utc_offset_min ?? 0;

  function drawHead() {
    const info = onlineInfo(bot, st);
    const acc = (st && st.account) || {};
    const chips = [
      st && st.symbol ? h('span', { class: 'chip' }, st.symbol) : null,
      (st && st.ea_version) || bot.ea_version ? h('span', { class: 'chip' }, `EA v${(st && st.ea_version) || bot.ea_version}`) : null,
      acc.mode ? h('span', { class: `chip ${acc.mode === 'REAL' ? 'real' : ''}` }, acc.mode === 'REAL' ? `บัญชีจริง ${acc.currency || ''}` : `บัญชี ${acc.mode} ${acc.currency || ''}`) : null,
      st && st.server_time ? h('span', { class: 'chip', title: `เวลาไทย ${fmtThai(serverToUtc(st.server_time, off()), 'seconds')}` },
        `เวลาเซิร์ฟเวอร์ ${st.server_time.slice(11, 16)}`) : null,
      h('span', { class: `chip ${rtState === 'SUBSCRIBED' ? 'good' : ''}`, title: rtState === 'SUBSCRIBED' ? 'รับข้อมูลแบบสด' : 'ดึงข้อมูลใหม่ทุก 30 วินาที' },
        rtState === 'SUBSCRIBED' ? 'อัปเดตสด' : 'อัปเดตทุก 30 วินาที'),
    ];
    headBox.replaceChildren(h('div', { class: 'page-head' },
      h('div', { class: 'page-title' }, h('h1', null, bot.name), h('div', { class: 'page-sub chips' }, chips)),
      h('div', { class: 'page-actions' }, onlineBadge(info))));
  }

  // Re-render interactive sections only when what they show changed (status ticks every few seconds and
  // rebuilding a focused button would drop keyboard focus).
  const sigs = {};
  const changed = (key, val) => { const s = JSON.stringify(val); if (sigs[key] === s) return false; sigs[key] = s; return true; };

  function drawLive(force) {
    const d = normDesired(ctl && ctl.desired);
    const info = onlineInfo(bot, st);
    if (!changed('live', [d.live, d.control.mode, ctl && ctl.version, bot.agent_state && bot.agent_state.applied_version, appliedLive(st), info.agentOnline]) && !force) return;
    liveBox.replaceChildren(liveSwitch({ bot, ctl, st }));
  }

  function drawState(force) {
    const eff = effectiveState(st, bot, ctl);
    const d = normDesired(ctl && ctl.desired);
    const paused = d.control.mode === 'pause';
    const pending = isPending(bot, ctl);
    if (!changed('state', [eff, paused, pending, !!ctl]) && !force) return;
    stateBox.replaceChildren(h('section', { class: `state-panel tone-${eff.tone}`, 'aria-live': 'polite' },
      h('p', { class: 'state-label' }, h('span', { class: 'dot', 'aria-hidden': 'true' }), eff.label),
      h('p', { class: 'state-text' }, eff.text),
      h('div', { class: 'row gap wrap' },
        h('button', {
          class: `btn ${paused ? 'primary' : ''}`, type: 'button', disabled: !ctl,
          onclick: (e) => togglePause(e.currentTarget, !paused),
        }, icon(paused ? 'play' : 'pause'), paused ? 'ทำงานต่อ' : 'หยุดชั่วคราว'),
        h('button', { class: 'btn', type: 'button', disabled: !ctl, onclick: (e) => blackout2h(e.currentTarget) }, icon('clock'), 'งดเข้าไม้ 2 ชม.'),
        h('a', { class: 'btn ghost', href: '#/control' }, icon('sliders'), 'ตั้งค่าคำสั่ง')),
      paused && pending ? h('p', { class: 'muted small' }, 'สั่งหยุดแล้ว รอเครื่องรับคำสั่ง') : null));
  }

  async function togglePause(btn, pause) {
    if (!pause) {
      const ok = await confirmDialog('ให้บอททำงานต่อ?', 'บอทจะกลับมาเปิดไม้ใหม่ได้ตามสัญญาณ (ถ้าสวิตช์เทรดจริงเปิดอยู่)', { ok: 'ทำงานต่อ' });
      if (!ok) return;
    }
    btn.disabled = true;
    try {
      ctl = await patchDesired(bot.id, (d) => { d.control.mode = pause ? 'pause' : 'run'; });
      toast(pause ? 'ส่งคำสั่งหยุดชั่วคราวแล้ว' : 'ส่งคำสั่งทำงานต่อแล้ว', 'good');
    } catch (e) { toast(errText(e), 'error', 6000); }
    drawAll();
  }

  async function blackout2h(btn) {
    btn.disabled = true;
    const now = Date.now();
    try {
      ctl = await patchDesired(bot.id, (d) => {
        d.blackouts = d.blackouts.filter((b) => Date.parse(b.to_utc) > now);
        d.blackouts.push({ from_utc: isoUtc(now), to_utc: isoUtc(now + 2 * 3600e3), label: 'งดเข้าไม้ 2 ชม. (หน้าภาพรวม)' });
      });
      toast(`งดเข้าไม้ถึง ${fmtThai(now + 2 * 3600e3, 'time')} น. แล้ว`, 'good');
    } catch (e) { toast(errText(e), 'error', 6000); }
    drawAll();
  }

  function drawWarn() {
    const as = bot.agent_state || {};
    if (!changed('warn', [as.rejected, as.last_error, st && st.remote && st.remote.rejects, st && st.control && st.control.warn])) return;
    warnBox.replaceChildren(rejectionsBlock(bot, st) || '');
  }

  function drawKpi() {
    if (!st) { kpiBox.replaceChildren(panel(null, {}, h('p', { class: 'muted' }, 'ยังไม่มีสถานะจาก EA เมื่อเอเจนต์บนเครื่องส่งไฟล์สถานะ ตัวเลขจะขึ้นที่นี่'))); return; }
    const a = st.account || {}, v = st.virtual || {}, p = st.params || {};
    const cur = a.currency || '';
    const floating = (a.equity ?? 0) - (a.balance ?? 0);
    const vChange = v.start ? ((v.balance - v.start) / v.start) * 100 : null;
    const capPct = p.daily_cap_pct ?? 10;
    const capAmt = (capPct / 100) * (v.day_start || 0);
    const loss = Math.max(0, -(v.day_pnl || 0));
    const used = capAmt > 0 ? Math.min(1, loss / capAmt) : 0;
    const tone = v.day_cap_hit || used >= 0.8 ? 'critical' : used >= 0.5 ? 'warn' : 'ok';
    kpiBox.replaceChildren(h('section', { class: 'kpis', 'aria-label': 'ยอดเงิน' },
      kpi('ยอดเงินในบัญชี', fmtNum(a.balance), cur),
      kpi('มูลค่าสุทธิ (Equity)', fmtNum(a.equity), cur, Math.abs(floating) >= 0.005 ? h('span', { class: `num ${toneOf(floating)}` }, `ไม้ลอย ${fmtSigned(floating)}`) : 'ไม่มีไม้ลอย'),
      kpi('พอร์ตจำลอง', fmtNum(v.balance), cur, vChange !== null ? h('span', { class: `num ${toneOf(vChange)}` }, `${fmtPct(vChange, 1, true)} จากทุน ${fmtNum(v.start, 0)}`) : null),
      kpi('กำไรขาดทุนวันนี้', h('span', { class: `num ${toneOf(v.day_pnl)}` }, fmtSigned(v.day_pnl)), cur, `ทุนต้นวัน ${fmtNum(v.day_start)}`)),
    h('section', { class: `capbar tone-${tone}`, 'aria-label': 'จุดหยุดรายวัน' },
      h('div', { class: 'capbar-head' },
        h('span', null, `จุดหยุดรายวัน ${fmtNum(capPct, 1)}% = ${fmtSigned(-capAmt)} ${cur}`),
        h('span', { class: 'num' }, v.day_cap_hit ? [icon('warn'), ' ถึงจุดหยุดแล้ว วันนี้ไม่เปิดไม้ใหม่']
          : (v.day_pnl || 0) >= 0 ? `วันนี้ยังไม่ขาดทุน` : `ใช้ไปแล้ว ${fmtPct(used * 100, 0)}`)),
      h('div', { class: 'meter', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(used * 100)), 'aria-label': 'ขาดทุนวันนี้เทียบกับจุดหยุดรายวัน' },
        h('span', { class: 'meter-fill', style: { width: `${(v.day_cap_hit ? 1 : used) * 100}%` } })),
      h('p', { class: 'muted small' }, `วันของ EA: ${v.day || '—'} (เวลาเซิร์ฟเวอร์) เทรดทั้งหมด ${v.trades ?? 0} ไม้ ชนะ ${v.wins ?? 0} แพ้ ${v.losses ?? 0}`)));
  }

  function kpi(label, value, unit, sub) {
    return h('div', { class: 'kpi' }, h('p', { class: 'kpi-label' }, label),
      h('p', { class: 'kpi-value' }, value, unit ? h('span', { class: 'unit' }, ` ${unit}`) : null),
      sub ? h('p', { class: 'kpi-sub' }, sub) : null);
  }

  function drawPositions() {
    const list = st ? (st.positions || []).filter((p) => p.open) : [];
    const mk = (st && st.market) || {};
    const cur = (st && st.account && st.account.currency) || '';
    posBox.replaceChildren(panel('ไม้ที่เปิดอยู่', { sub: mk.bid ? `ราคา ${fmtNum(mk.bid)} / ${fmtNum(mk.ask)} สเปรด ${fmtNum(mk.spread)}` : null },
      list.length ? h('div', { class: 'positions' }, list.map((p) => positionCard(p, mk, cur))) : h('p', { class: 'muted' }, 'ไม่มีไม้เปิดอยู่')));
  }

  function positionCard(p, mk, cur) {
    const dir = p.side === 'BUY' ? 1 : -1;
    const price = p.side === 'BUY' ? mk.bid : mk.ask;
    const tpDist = (p.tp - p.open_price) * dir, slDist = (p.open_price - p.sl) * dir;
    const gain = (price - p.open_price) * dir;
    const span = p.tp - p.sl;
    const t = (x) => Math.max(0, Math.min(1, (x - p.sl) / span));
    let progress = '';
    if (Number.isFinite(gain) && tpDist > 0) {
      if (gain >= 0) progress = `ไปแล้ว ${fmtPct((gain / tpDist) * 100, 0)} ของทาง TP`;
      else if (slDist > 0) progress = `ติดลบ ${fmtPct((-gain / slDist) * 100, 0)} ของทาง SL`;
    }
    const slLocked = slDist < 0;
    const openedUtc = serverToUtc(p.open_time, off());
    const money = (p.profit || 0) + (p.swap || 0);
    return h('article', { class: 'position' },
      h('div', { class: 'pos-head' }, modChip(p.module), sideEl(p.side), h('span', { class: 'num' }, `${fmtNum(p.lots)} ล็อต`),
        p.locked ? h('span', { class: 'chip good' }, icon('shield'), 'ล็อกกำไรแล้ว') : p.near_tp ? h('span', { class: 'chip warn' }, 'ใกล้ TP') : null,
        h('span', { class: 'pos-pnl' }, pnl(money), h('span', { class: 'unit' }, ` ${cur}`))),
      span ? h('div', { class: 'track', role: 'img', 'aria-label': `SL ${fmtNum(p.sl)} ราคาเข้า ${fmtNum(p.open_price)} ราคาตอนนี้ ${fmtNum(price)} TP ${fmtNum(p.tp)}` },
        h('span', { class: 'track-bar' }),
        h('span', { class: 'track-entry', style: { left: `${t(p.open_price) * 100}%` } }),
        h('span', { class: `track-now ${gain >= 0 ? 'up' : 'down'}`, style: { left: `${t(price) * 100}%` } }),
        h('span', { class: 'track-l' }, 'SL'), h('span', { class: 'track-r' }, 'TP')) : null,
      h('p', { class: 'pos-progress' }, progress, slLocked ? ` SL ล็อกกำไรไว้ ${fmtSigned(-slDist * 100 * p.lots)} ${cur}` : ''),
      kv([
        ['ราคาเข้า', h('span', { class: 'num' }, fmtNum(p.open_price))],
        ['SL', h('span', { class: 'num' }, fmtNum(p.sl))],
        ['TP', h('span', { class: 'num' }, fmtNum(p.tp))],
        ['ราคาปิดตอนนี้', h('span', { class: 'num' }, fmtNum(price))],
        ['เปิดเมื่อ', h('span', null, timeEl(openedUtc, off(), 'short'), ` (${p.bars_held ?? 0} แท่ง M15)`)],
        ['ตั๋ว', h('span', { class: 'num muted' }, String(p.ticket ?? '—'))],
      ]));
  }

  function drawModules() {
    if (!st || !st.modules) { modBox.replaceChildren(); return; }
    const cur = (st.account && st.account.currency) || '';
    modBox.replaceChildren(panel('สูตร', { sub: 'ผลนับตั้งแต่เริ่มพอร์ตจำลอง' },
      h('div', { class: 'table-wrap' }, h('table', { class: 'rtable' },
        h('thead', null, h('tr', null, ['สูตร', 'สถานะ', 'ล็อต', 'วันนี้', 'เทรด', 'ชนะ/แพ้', 'อัตราชนะ', `สุทธิ ${cur}`].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', null, st.modules.map((m) => {
          const wr = m.trades ? (m.wins / m.trades) * 100 : null;
          const today = m.day_stopped ? 'หยุดวันนี้' : m.won_today ? 'ชนะแล้ววันนี้' : m.step ? `ไม้แก้ขั้น ${m.step}` : '—';
          return h('tr', { class: m.enabled ? '' : 'dim' },
            h('td', { 'data-label': 'สูตร' }, modChip(m.module)),
            h('td', { 'data-label': 'สถานะ' }, onOff(m.enabled)),
            h('td', { 'data-label': 'ล็อต', class: 'num' }, fmtNum(m.lots)),
            h('td', { 'data-label': 'วันนี้' }, today),
            h('td', { 'data-label': 'เทรด', class: 'num' }, String(m.trades ?? 0)),
            h('td', { 'data-label': 'ชนะ/แพ้', class: 'num' }, `${m.wins ?? 0}/${m.losses ?? 0}`),
            h('td', { 'data-label': 'อัตราชนะ', class: 'num' }, wr === null ? '—' : fmtPct(wr, 0)),
            h('td', { 'data-label': 'สุทธิ', class: 'num' }, pnl(m.net)));
        }))))));
  }

  function srvToThaiClock(min) {
    const t = ((min - off() + 420) % 1440 + 1440) % 1440;
    return minutesToClock(t);
  }

  function drawDetails() {
    if (!st) { detailBox.replaceChildren(); return; }
    const ny = st.ny || {}, o = st.options || {}, c = st.control || {}, lock = o.lock || {}, lock1 = o.lock1 || {};
    const bos = (c.blackouts || []).map((b) => {
      const from = serverToUtc(b[0], off()), to = serverToUtc(b[1], off());
      return h('li', null, `${fmtThai(from, 'short')} ถึง ${fmtThai(to, Math.floor(from / 864e5) === Math.floor(to / 864e5) ? 'time' : 'short')}`,
        h('span', { class: 'muted small' }, ` (เซิร์ฟเวอร์ ${b[0]} ถึง ${b[1]})`));
    });
    detailBox.replaceChildren(
      panel('NY breakout', { sub: `กรอบราคาแท่ง 16:30 เวลาเซิร์ฟเวอร์ (${srvToThaiClock(990)} น. เวลาไทย)` }, kv([
        ['กรอบบน', h('span', { class: 'num' }, fmtNum(ny.range_high))],
        ['กรอบล่าง', h('span', { class: 'num' }, fmtNum(ny.range_low))],
        ['ระยะ SL', h('span', { class: 'num' }, fmtNum(ny.sl_dist))],
        ['สถานะ', ny.state || '—'],
        ['วันที่ตั้งกรอบ', ny.armed_day || '—'],
      ])),
      panel('ล็อกกำไร', {}, kv([
        ['ล็อกใกล้ TP', lock.enabled ? `เปิด: กำไรถึง ${fmtNum(lock.at_pct, 1)}% ย้าย SL ไป ${fmtNum(lock.to_pct, 1)}%` : 'ปิด'],
        ['ใช้กับ', lockModules(lock.modules)],
        ['ล็อกขั้นที่ 1', lock1.enabled ? `เปิด: ${fmtNum(lock1.at_pct, 1)}% ย้าย SL ไป ${fmtNum(lock1.to_pct, 1)}%` : 'ปิด'],
        ['บันทึกเงา', lock.shadow ? 'เปิด' : 'ปิด'],
      ])),
      panel('ตัวเลือก', {}, kv([
        ['ไม้ต่อสูตรต่อวัน', String(o.max_attempts ?? '—')],
        ['สัญญาณตรงกัน', o.confluence_mult && o.confluence_mult > 1 ? `ล็อต x${fmtNum(o.confluence_mult)} ภายใน ${o.confluence_min} นาที` : 'ปิด'],
        ['ตัวกรองความผันผวน', o.vol_gate ? (o.vol_gate.enabled ? `เปิด ${fmtNum(o.vol_gate.value)}% (เกณฑ์ ${fmtNum(o.vol_gate.pct)}%) ${o.vol_gate.open ? 'ผ่าน' : 'ไม่ผ่าน'}` : 'ปิด') : '—'],
        ['ASIA16', o.asia ? (o.asia.enabled ? `เปิด ${fmtNum(o.asia.lots)} ล็อต ${o.asia.state || ''}` : 'ปิด') : '—'],
      ])),
      panel('คำสั่งที่ EA ใช้อยู่', { sub: c.applied_at ? `รับเมื่อ ${c.applied_at} (เวลาเซิร์ฟเวอร์)` : null }, kv([
        ['โหมด', c.mode === 'pause' ? 'หยุดชั่วคราว' : 'ทำงาน'],
        ['ล็อต', fmtNum(c.lots)],
        ['ฝั่ง', `${c.allow_long ? 'ซื้อ' : ''}${c.allow_long && c.allow_short ? ' และ ' : ''}${c.allow_short ? 'ขาย' : ''}` || 'ไม่เปิดทั้งสองฝั่ง'],
        ['สเปรดสูงสุด', fmtNum(c.max_spread)],
        ['ช่วงงดเข้าไม้', bos.length ? h('ul', { class: 'plain' }, bos) : 'ไม่มี'],
        ['รหัสไฟล์ควบคุม', c.id || (c.file_exists ? '—' : 'ไม่มีไฟล์ (ใช้ค่า Inputs)')],
        c.note ? ['หมายเหตุ', c.note] : null,
      ])),
      panel('เหตุการณ์ล่าสุด', { cls: 'span-2' }, eventLine('ล่าสุด', st.last_event), eventLine('ข้อผิดพลาดล่าสุด', st.last_error, true)),
    );
  }

  function eventLine(label, text, isErr) {
    if (!text) return h('p', { class: 'muted' }, `${label}: ไม่มี`);
    const w = parseWall(text);
    const m = /^\d{4}\.\d{2}\.\d{2} \d{2}:\d{2}(:\d{2})?\s*/.exec(text);
    const rest = m ? text.slice(m[0].length) : text;
    return h('div', { class: `event-line ${isErr ? 'err' : ''}` },
      h('p', { class: 'muted small' }, label, m && Number.isFinite(w) ? [' ', timeEl(serverToUtc(text, off()), off(), 'seconds')] : null),
      h('p', null, rest));
  }

  function drawAll() { drawHead(); drawLive(true); drawState(true); drawWarn(); drawKpi(); drawPositions(); drawModules(); drawDetails(); }
  drawAll();

  const onStatus = (row) => { if (!row || !row.status) return; st = row.status; drawHead(); drawLive(); drawState(); drawWarn(); drawKpi(); drawPositions(); drawModules(); drawDetails(); };
  const onControl = (row) => { ctl = row; drawLive(); drawState(); };
  const onBot = (row) => { bot = { ...bot, ...row }; updateBotRow(bot); drawHead(); drawLive(); drawState(); drawWarn(); };
  const unsub = ctx.api.subscribeBot(bot.id, {
    status: onStatus, control: onControl, bot: onBot,
    state: (s) => { rtState = s; drawHead(); },
  });
  const offCtl = on('control-updated', (row) => { if (row && row.bot_id === bot.id) onControl(row); });
  const ages = setInterval(drawHead, 5000);
  const poll = setInterval(async () => {
    if (rtState === 'SUBSCRIBED') return;
    try {
      const [s, c, bots] = await Promise.all([ctx.api.botStatus(bot.id), ctx.api.botControl(bot.id), ctx.api.listBots()]);
      const b = bots.find((x) => x.id === bot.id);
      if (b) onBot(b);
      if (c) onControl(c);
      if (s) onStatus(s);
    } catch { /* keep the last data */ }
  }, 30000);
  return () => { unsub(); offCtl(); clearInterval(ages); clearInterval(poll); };
}
