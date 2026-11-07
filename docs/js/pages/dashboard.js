// ภาพรวม: hero "กำลังเทรดจริง / หยุดอยู่ / ออฟไลน์" with one sentence why, balance, today, open trade with a simple
// SL - entry - TP bar, recent trades, then details. Realtime + 30 s fallback poll (SPEC 5 page 2).
import { h, mount, icon, fmtNum, fmtSigned, fmtPct, pnl, fmtThai, timeEl, serverToUtc, parseWall, toast, errText, confirmDialog,
  errorState, loadingState, isoUtc, toneOf, utcToServer, ago, debounce } from '../util.js';
import { app, currentBot, updateBotRow, on } from '../state.js';
import { normDesired, patchDesired, onlineInfo, rejectionsBlock, isPending, heroState } from '../botctl.js';
import { modChip, sideEl, kv, panel, noBotState, onOff, pageHead } from '../views.js';
import { minutesToClock } from '../params.js';
import { prepareRows, pairTrades, REASON_LABELS } from '../journal.js';
import { currentValues, summaryText } from '../simple.js';

const DAY = 86400000;

function lockModules(s) {
  const m = /A=(\w+)\s+NY=(\w+)\s+C5G=(\w+)/.exec(s || '');
  if (!m) return s || '—';
  const on = [['A_new', m[1]], ['NY', m[2]], ['C5G', m[3]]].filter(([, v]) => v === 'true').map(([k]) => k);
  return on.length ? on.join(', ') : 'ไม่มีสูตร';
}

export async function render(root, ctx) {
  const bot0 = currentBot();
  if (!bot0) { root.append(pageHead('ภาพรวม', null, null, 'dashboard'), noBotState()); return; }
  let bot = bot0, st = null, ctl = null, rtState = '', rows = [];
  root.append(loadingState('กำลังโหลดสถานะบอท…'));
  const off = () => bot.server_utc_offset_min ?? 0;
  try {
    const [s, c, bots] = await Promise.all([ctx.api.botStatus(bot.id), ctx.api.botControl(bot.id), ctx.api.listBots().catch(() => [])]);
    st = s ? s.status : null; ctl = c;
    const fresh = bots.find((b) => b.id === bot.id); // last_seen in app.bots may be minutes old
    if (fresh) { bot = { ...bot, ...fresh }; updateBotRow(bot); }
  } catch (e) {
    mount(root, errorState(e, () => ctx.route()));
    return;
  }
  mount(root);

  const headBox = h('div');
  const heroBox = h('div');
  const warnBox = h('div');
  const kpiBox = h('div');
  const posBox = h('div');
  const recentBox = h('div');
  const detailBox = h('div');
  root.append(headBox, heroBox, warnBox, kpiBox, h('div', { class: 'grid-2 dash-grid' }, posBox, recentBox), detailBox);

  // journal for the recent trades list (last 14 days, server time)
  (async () => {
    try {
      const fromServer = utcToServer(Date.now() - 14 * DAY, off()).replace(/\./g, '-').replace(' ', 'T');
      rows = prepareRows(await ctx.api.journal(bot.id, { fromServer }), off());
    } catch { rows = []; }
    drawRecent(true);
  })();

  function drawHead() {
    const chips = [
      (st && st.ea_version) || bot.ea_version ? h('span', { class: 'chip' }, `EA ${(st && st.ea_version) || bot.ea_version}`) : null,
      st && st.account && st.account.mode ? h('span', { class: `chip ${st.account.mode === 'REAL' ? 'real' : ''}` }, st.account.mode === 'REAL' ? 'บัญชีจริง' : `บัญชี ${st.account.mode}`) : null,
      h('span', { class: `chip ${rtState === 'SUBSCRIBED' ? 'good' : ''}`, title: rtState === 'SUBSCRIBED' ? 'รับข้อมูลแบบสด' : 'ดึงข้อมูลใหม่ทุก 30 วินาที' },
        rtState === 'SUBSCRIBED' ? [h('span', { class: 'live-dot', 'aria-hidden': 'true' }), 'สด'] : 'ทุก 30 วินาที'),
    ];
    mount(headBox, pageHead('ภาพรวม', h('span', { class: 'row gap wrap' }, h('span', { class: 'chip bot-chip' }, icon('monitor'), bot.name), chips), null, 'dashboard'));
  }

  const sigs = {};
  const changed = (key, val) => { const s = JSON.stringify(val); if (sigs[key] === s) return false; sigs[key] = s; return true; };

  function drawHero(force) {
    const hs = heroState(bot, st, ctl);
    const d = normDesired(ctl && ctl.desired);
    const paused = d.control.mode === 'pause';
    const pending = isPending(bot, ctl);
    const info = onlineInfo(bot, st);
    const updated = st && Number.isFinite(st.heartbeat_gmt_unix) ? st.heartbeat_gmt_unix * 1000 : bot.last_seen ? Date.parse(bot.last_seen) : NaN;
    const summary = st ? summaryText(currentValues(st).values, (st.account && st.account.currency) || 'USD') : '';
    const ageBucket = Number.isFinite(updated) ? Math.min(12, Math.floor((Date.now() - updated) / 10000)) : -1;
    if (!changed('hero', [hs, paused, pending, !!ctl, summary, ageBucket, info.online]) && !force) return;
    mount(heroBox, h('section', { class: `hero tone-${hs.tone}`, 'aria-live': 'polite' },
      h('div', { class: 'hero-main' },
        h('div', { class: 'hero-art', 'aria-hidden': 'true', html: HERO_ART[hs.tone] || HERO_ART.off }),
        h('div', { class: 'hero-copy' },
          h('p', { class: 'hero-kicker' }, h('span', { class: 'dot' }), info.online ? 'ออนไลน์' : 'ออฟไลน์',
            Number.isFinite(updated) ? h('span', { class: 'muted' }, ` · อัปเดต ${ago(updated)}`) : null),
          h('h2', { class: 'hero-title' }, hs.title),
          h('p', { class: 'hero-text' }, hs.text),
          hs.help ? h('a', { class: 'small hero-help', href: '#/guide/offline' }, icon('help'), 'วิธีแก้เมื่อบอทออฟไลน์') : null)),
      h('div', { class: 'hero-actions' },
        h('button', {
          class: `btn ${paused ? 'primary' : ''}`, type: 'button', disabled: !ctl,
          onclick: (e) => togglePause(e.currentTarget, !paused),
        }, icon(paused ? 'play' : 'pause'), paused ? 'ทำงานต่อ' : 'หยุดชั่วคราว'),
        h('button', { class: 'btn', type: 'button', disabled: !ctl, onclick: (e) => blackout2h(e.currentTarget) }, icon('clock'), 'งดเข้าไม้ 2 ชม.'),
        h('a', { class: 'btn ghost', href: '#/bot' }, icon('sliders'), 'ตั้งค่าบอท')),
      paused && pending ? h('p', { class: 'muted small' }, 'สั่งหยุดแล้ว รอเครื่องรับคำสั่ง') : null,
      summary ? h('a', { class: 'hero-summary', href: '#/bot' }, h('span', { class: 'muted small' }, 'ค่าที่ใช้อยู่'), h('span', null, summary), icon('chevron')) : null));
  }

  async function togglePause(btn, pause) {
    if (!pause) {
      const ok = await confirmDialog('ให้บอททำงานต่อ?', 'บอทจะกลับมาเปิดไม้ใหม่ได้ตามสัญญาณ (ถ้าสวิตช์เทรดจริงเปิดอยู่)', { ok: 'ทำงานต่อ' });
      if (!ok) return;
    } else {
      const ok = await confirmDialog('หยุดชั่วคราว?', 'บอทจะหยุดเปิดไม้ใหม่ ไม้ที่เปิดอยู่ไม่ถูกปิด และยังมี SL/TP ตามเดิม', { ok: 'หยุดชั่วคราว' });
      if (!ok) return;
    }
    btn.disabled = true;
    try {
      ctl = await patchDesired(bot.id, (d) => { d.control.mode = pause ? 'pause' : 'run'; });
      toast(pause ? 'ส่งคำสั่งหยุดชั่วคราวแล้ว' : 'ส่งคำสั่งทำงานต่อแล้ว', 'good');
    } catch (e) { toast(errText(e), 'error', 6000); }
    drawHero(true);
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
    drawHero(true);
  }

  function drawWarn() {
    const as = bot.agent_state || {};
    if (!changed('warn', [as.rejected, as.last_error, st && st.remote && st.remote.rejects, st && st.control && st.control.warn])) return;
    mount(warnBox, rejectionsBlock(bot, st) || '');
  }

  function drawKpi() {
    if (!st) { mount(kpiBox, panel(null, {}, h('p', { class: 'muted' }, 'ยังไม่มีตัวเลขจากบอท เมื่อแอปที่เครื่องส่งสถานะขึ้นมา ยอดเงินและกำไรจะขึ้นที่นี่'))); return; }
    const a = st.account || {}, v = st.virtual || {}, p = st.params || {};
    const cur = a.currency || '';
    const floating = (a.equity ?? 0) - (a.balance ?? 0);
    const since = (v.balance ?? 0) - (v.start ?? 0);
    const capPct = p.daily_cap_pct ?? 10;
    const capAmt = (capPct / 100) * (v.day_start || 0);
    const loss = Math.max(0, -(v.day_pnl || 0));
    const used = capAmt > 0 ? Math.min(1, loss / capAmt) : 0;
    const tone = v.day_cap_hit || used >= 0.8 ? 'critical' : used >= 0.5 ? 'warn' : 'ok';
    const wr = v.trades ? Math.round((v.wins / v.trades) * 100) : null;
    mount(kpiBox, h('section', { class: 'kpi-cards', 'aria-label': 'ยอดเงินและกำไร' },
      kpi('ยอดเงินในบัญชี', fmtNum(a.balance), cur,
        Math.abs(floating) >= 0.005 ? h('span', null, 'รวมไม้ที่เปิดอยู่ ', h('span', { class: `num ${toneOf(floating)}` }, fmtNum(a.equity)), ` (${fmtSigned(floating)})`) : 'ไม่มีไม้ค้าง'),
      h('div', { class: `kpi-card tone-${tone}` },
        h('p', { class: 'kpi-label' }, 'วันนี้'),
        h('p', { class: `kpi-value num ${toneOf(v.day_pnl)}` }, fmtSigned(v.day_pnl), h('span', { class: 'unit' }, ` ${cur}`)),
        h('div', { class: 'meter', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(used * 100)), 'aria-label': 'ขาดทุนวันนี้เทียบกับจุดหยุดรายวัน' },
          h('span', { class: 'meter-fill', style: { width: `${(v.day_cap_hit ? 1 : used) * 100}%` } })),
        h('p', { class: 'kpi-sub' }, v.day_cap_hit ? [icon('warn'), ' ถึงจุดหยุดแล้ว วันนี้ไม่เปิดไม้ใหม่']
          : (v.day_pnl || 0) >= 0 ? `ยังไม่ขาดทุน · หยุดเมื่อ −${fmtNum(capAmt, 0)} (${fmtNum(capPct, 0)}%)` : `ใช้ไป ${fmtPct(used * 100, 0)} ของจุดหยุด −${fmtNum(capAmt, 0)}`)),
      kpi('กำไรตั้งแต่เริ่ม', h('span', { class: `num ${toneOf(since)}` }, fmtSigned(since)), cur,
        v.start ? `ทุน ${fmtNum(v.start, 0)} → ตอนนี้ ${fmtNum(v.balance)} (${fmtPct((since / v.start) * 100, 1, true)})` : null),
      kpi('เทรดทั้งหมด', String(v.trades ?? 0), 'ไม้', wr === null ? null : `ชนะ ${v.wins} แพ้ ${v.losses} (ชนะ ${wr}%)`)));
  }

  function kpi(label, value, unit, sub) {
    return h('div', { class: 'kpi-card' }, h('p', { class: 'kpi-label' }, label),
      h('p', { class: 'kpi-value' }, value, unit ? h('span', { class: 'unit' }, ` ${unit}`) : null),
      sub ? h('p', { class: 'kpi-sub' }, sub) : null);
  }

  function drawPositions() {
    const list = st ? (st.positions || []).filter((p) => p.open) : [];
    const mk = (st && st.market) || {};
    const cur = (st && st.account && st.account.currency) || '';
    mount(posBox, panel(list.length ? `ไม้ที่เปิดอยู่ (${list.length})` : 'ไม้ที่เปิดอยู่', { icon: 'bars', sub: mk.bid ? `ราคาทองตอนนี้ ${fmtNum(mk.bid)} (สเปรด ${fmtNum(mk.spread)})` : null },
      list.length ? h('div', { class: 'positions' }, list.map((p) => positionCard(p, mk, cur)))
        : h('div', { class: 'quiet' }, h('p', null, 'ไม่มีไม้เปิดอยู่'), h('p', { class: 'muted small' }, 'บอทกำลังรอสัญญาณ เมื่อเปิดไม้ จะขึ้นที่นี่ทันที'))));
  }

  function positionCard(p, mk, cur) {
    const dir = p.side === 'BUY' ? 1 : -1;
    const price = p.side === 'BUY' ? mk.bid : mk.ask;
    const tpDist = (p.tp - p.open_price) * dir, slDist = (p.open_price - p.sl) * dir;
    const gain = (price - p.open_price) * dir;
    // bar in "distance" terms: SL (left) -> entry -> TP (right), whatever the side
    const lo = -Math.max(slDist, 0.0001), hi = Math.max(tpDist, 0.0001);
    const t = (x) => Math.max(0, Math.min(1, (x - lo) / (hi - lo)));
    const slLocked = slDist < 0;
    let progress = '';
    if (Number.isFinite(gain) && tpDist > 0) {
      if (gain >= 0) progress = `ไปแล้ว ${fmtPct((gain / tpDist) * 100, 0)} ของทาง TP`;
      else if (slDist > 0) progress = `ติดลบ ${fmtPct((-gain / slDist) * 100, 0)} ของทาง SL`;
    }
    const openedUtc = serverToUtc(p.open_time, off());
    const money = (p.profit || 0) + (p.swap || 0);
    const slPos = slLocked ? t(-slDist) : 0;
    return h('article', { class: 'position' },
      h('div', { class: 'pos-head' }, modChip(p.module), sideEl(p.side), h('span', { class: 'num muted' }, `${fmtNum(p.lots)} ล็อต`),
        p.locked || slLocked ? h('span', { class: 'chip good' }, icon('shield'), 'ล็อกกำไรแล้ว') : p.near_tp ? h('span', { class: 'chip warn' }, 'ใกล้ TP') : null,
        h('span', { class: 'pos-pnl' }, pnl(money), h('span', { class: 'unit' }, ` ${cur}`))),
      Number.isFinite(gain) ? h('div', { class: 'ptrack', role: 'img', 'aria-label': `SL ${fmtNum(p.sl)} ราคาเข้า ${fmtNum(p.open_price)} ราคาตอนนี้ ${fmtNum(price)} TP ${fmtNum(p.tp)}` },
        h('div', { class: 'pt-bar' },
          h('span', { class: 'pt-loss', style: { width: `${t(0) * 100}%` } }),
          h('span', { class: 'pt-win', style: { left: `${t(0) * 100}%`, width: `${(1 - t(0)) * 100}%` } }),
          h('span', { class: 'pt-entry', style: { left: `${t(0) * 100}%` } }),
          slLocked ? h('span', { class: 'pt-lock', style: { left: `${slPos * 100}%` }, title: 'SL ใหม่ (ล็อกกำไร)' }) : null,
          h('span', { class: `pt-now ${gain >= 0 ? 'up' : 'down'}`, style: { left: `${t(gain) * 100}%` } })),
        h('div', { class: 'pt-labels' },
          h('span', null, h('b', null, slLocked ? 'SL เดิม' : 'SL'), h('span', { class: 'num' }, slLocked ? '' : fmtNum(p.sl))),
          h('span', { class: 'pt-mid', style: { left: `${t(0) * 100}%` } }, h('b', null, 'ราคาเข้า'), h('span', { class: 'num' }, fmtNum(p.open_price))),
          h('span', { class: 'pt-r' }, h('b', null, 'TP'), h('span', { class: 'num' }, fmtNum(p.tp))))) : null,
      h('p', { class: 'pos-progress' }, progress, slLocked ? ` · SL ล็อกกำไรไว้ ${fmtSigned(-slDist * 100 * p.lots)} ${cur}` : ''),
      h('p', { class: 'muted small' }, 'เปิดเมื่อ ', timeEl(openedUtc, off(), 'short'), ` · ราคาตอนนี้ ${fmtNum(price)}`));
  }

  function drawRecent(force) {
    const trades = pairTrades(rows).filter((t) => !t.open).slice(-8).reverse();
    if (!changed('recent', trades.map((t) => [t.closeUtc, t.pnl])) && !force) return;
    const cur = (st && st.account && st.account.currency) || '';
    const today = fmtThai(Date.now(), 'date');
    mount(recentBox, panel('เทรดล่าสุด', { icon: 'history', actions: h('a', { class: 'btn small ghost', href: '#/history?tab=trades' }, 'ดูทั้งหมด', icon('chevron')) },
      trades.length ? h('ul', { class: 'trade-list' }, trades.map((t) => {
        const when = fmtThai(t.closeUtc, 'date') === today ? `วันนี้ ${fmtThai(t.closeUtc, 'time')}` : fmtThai(t.closeUtc, 'short');
        return h('li', { class: 'trade' },
          h('span', { class: `trade-ico ${t.pnl >= 0 ? 'pos' : 'neg'}`, 'aria-hidden': 'true' }, t.pnl >= 0 ? '+' : '−'),
          h('div', { class: 'trade-main' },
            h('p', null, modChip(t.module), ' ', sideEl(t.side), h('span', { class: 'muted small' }, ` ${fmtNum(t.lots)} ล็อต`)),
            h('p', { class: 'muted small' }, when, ' · ', REASON_LABELS[t.reason] || t.reason || 'ปิดไม้')),
          h('span', { class: 'trade-pnl' }, pnl(t.pnl), h('span', { class: 'unit' }, ` ${cur}`)));
      })) : h('div', { class: 'quiet' }, h('p', null, rows.length ? 'ยังไม่มีไม้ที่ปิดใน 14 วันนี้' : 'กำลังโหลด…'))));
  }

  function srvToThaiClock(min) {
    const t = ((min - off() + 420) % 1440 + 1440) % 1440;
    return minutesToClock(t);
  }

  function drawDetails() {
    if (!st) { mount(detailBox); return; }
    if (!changed('details', [st.modules, st.ny, st.options, st.control, st.last_event, st.last_error]) && detailBox.firstChild) return;
    const open = detailBox.querySelector('details') ? detailBox.querySelector('details').open : false;
    const ny = st.ny || {}, o = st.options || {}, c = st.control || {}, lock = o.lock || {}, lock1 = o.lock1 || {};
    const cur = (st.account && st.account.currency) || '';
    const bos = (c.blackouts || []).map((b) => {
      const from = serverToUtc(b[0], off()), to = serverToUtc(b[1], off());
      return h('li', null, `${fmtThai(from, 'short')} ถึง ${fmtThai(to, Math.floor(from / 864e5) === Math.floor(to / 864e5) ? 'time' : 'short')}`);
    });
    mount(detailBox, h('details', { class: 'panel more-details', open },
      h('summary', null, h('span', null, h('strong', null, 'รายละเอียดเพิ่มเติม'), h('span', { class: 'muted small' }, ' ผลแต่ละสูตร กรอบ NY ล็อกกำไร เหตุการณ์ล่าสุด'))),
      st.modules ? h('div', { class: 'table-wrap' }, h('table', { class: 'rtable' },
        h('thead', null, h('tr', null, ['สูตร', 'สถานะ', 'ล็อต', 'วันนี้', 'เทรด', 'ชนะ/แพ้', 'อัตราชนะ', `สุทธิ ${cur}`].map((x) => h('th', { scope: 'col' }, x)))),
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
        })))) : null,
      h('div', { class: 'grid-2' },
        panel('NY breakout', { cls: 'flat', sub: `กรอบราคาแท่ง ${srvToThaiClock(990)} น. เวลาไทย` }, kv([
          ['กรอบบน', h('span', { class: 'num' }, fmtNum(ny.range_high))],
          ['กรอบล่าง', h('span', { class: 'num' }, fmtNum(ny.range_low))],
          ['สถานะ', ny.state || '—'],
        ])),
        panel('ล็อกกำไร', { cls: 'flat' }, kv([
          ['ชั้นใกล้ TP', lock.enabled ? `ถึง ${fmtNum(lock.at_pct, 0)}% เลื่อน SL ไป ${fmtNum(lock.to_pct, 0)}%` : 'ปิด'],
          ['ชั้นแรก', lock1.enabled ? `ถึง ${fmtNum(lock1.at_pct, 0)}% เลื่อน SL ไป ${fmtNum(lock1.to_pct, 0)}%` : 'ปิด'],
          ['ใช้กับ', lockModules(lock.modules)],
        ])),
        panel('คำสั่งที่บอทใช้อยู่', { cls: 'flat', sub: c.applied_at ? `รับเมื่อ ${c.applied_at} (เวลาเซิร์ฟเวอร์)` : null }, kv([
          ['โหมด', c.mode === 'pause' ? 'หยุด' : 'ทำงาน'],
          ['ฝั่ง', `${c.allow_long ? 'ซื้อ' : ''}${c.allow_long && c.allow_short ? ' และ ' : ''}${c.allow_short ? 'ขาย' : ''}` || 'ไม่เปิดทั้งสองฝั่ง'],
          ['ช่วงงดเข้าไม้', bos.length ? h('ul', { class: 'plain' }, bos) : 'ไม่มี'],
          c.note ? ['หมายเหตุ', c.note] : null,
        ])),
        panel('เหตุการณ์ล่าสุด', { cls: 'flat' }, eventLine('ล่าสุด', st.last_event), eventLine('ข้อผิดพลาดล่าสุด', st.last_error, true)))));
  }

  function eventLine(label, text, isErr) {
    if (!text) return h('p', { class: 'muted' }, `${label}: ไม่มี`);
    const w = parseWall(text);
    const m = /^\d{4}\.\d{2}\.\d{2} \d{2}:\d{2}(:\d{2})?\s*/.exec(text);
    const rest = m ? text.slice(m[0].length) : text;
    return h('div', { class: `event-line ${isErr ? 'err' : ''}` },
      h('p', { class: 'muted small' }, label, m && Number.isFinite(w) ? [' ', timeEl(serverToUtc(text, off()), off(), 'seconds')] : null),
      h('p', { class: 'break' }, rest));
  }

  function drawAll() { drawHead(); drawHero(true); drawWarn(); drawKpi(); drawPositions(); drawRecent(true); drawDetails(); }
  drawAll();

  const onStatus = (row) => { if (!row || !row.status) return; st = row.status; drawHero(); drawWarn(); drawKpi(); drawPositions(); drawDetails(); };
  const onControl = (row) => { ctl = row; drawHero(); };
  const onBot = (row) => { bot = { ...bot, ...row }; updateBotRow(bot); drawHero(); drawWarn(); };
  const addRow = debounce(() => drawRecent(), 500);
  const unsub = ctx.api.subscribeBot(bot.id, {
    status: onStatus, control: onControl, bot: onBot,
    journal: (row) => { rows = prepareRows([...rows, row], off()); addRow(); },
    state: (s) => { rtState = s; drawHead(); },
  });
  const offCtl = on('control-updated', (row) => { if (row && row.bot_id === bot.id) onControl(row); });
  const ages = setInterval(() => drawHero(), 5000);
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

// Small illustrations for the hero (inline SVG, theme colours).
const HERO_ART = {
  live: `<svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="var(--gold-soft)"/><path d="M14 42l10-12 8 6 14-18" fill="none" stroke="var(--gold-lo)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M40 18h6v6" fill="none" stroke="var(--gold-lo)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  good: `<svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="var(--good-soft)"/><path d="M20 33l8 8 16-17" fill="none" stroke="var(--good-ink)" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  paused: `<svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="var(--paused-soft)"/><path d="M26 22v20M38 22v20" stroke="var(--paused)" stroke-width="5" stroke-linecap="round"/></svg>`,
  warn: `<svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="var(--warn-soft)"/><path d="M32 16l16 30H16z" fill="none" stroke="var(--warn-ink)" stroke-width="4" stroke-linejoin="round"/><path d="M32 28v8M32 41v1" stroke="var(--warn-ink)" stroke-width="4" stroke-linecap="round"/></svg>`,
  critical: `<svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="var(--crit-soft)"/><path d="M23 23l18 18M41 23L23 41" stroke="var(--crit-ink)" stroke-width="5" stroke-linecap="round"/></svg>`,
  off: `<svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="var(--surface-2)"/><path d="M22 26a14 14 0 0 1 20 0M26 31a8 8 0 0 1 12 0" fill="none" stroke="var(--muted)" stroke-width="3.5" stroke-linecap="round"/><circle cx="32" cy="38" r="3" fill="var(--muted)"/><path d="M18 18l28 28" stroke="var(--muted)" stroke-width="3.5" stroke-linecap="round"/></svg>`,
};
