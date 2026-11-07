// ภาพรวม: the hero (hallmark stamp + one-sentence status + today's P&L, then today's price line with Dobby's trades
// stamped on it), the engraved numbers row, the open trade with an SL - entry - price - TP gauge, recent trades, then
// details. Realtime + 30 s fallback poll (SPEC 5 page 2).
import { h, mount, icon, fmtNum, fmtSigned, fmtPct, pnl, fmtThai, timeEl, serverToUtc, parseWall, toast, errText, confirmDialog,
  errorState, loadingState, isoUtc, toneOf, utcToServer, ago, debounce, thaiDayKey, money, duration } from '../util.js';
import { app, currentBot, updateBotRow, on, ownsBot } from '../state.js';
import { normDesired, patchDesired, onlineInfo, rejectionsBlock, isPending, heroState } from '../botctl.js';
import { modChip, sideEl, kv, panel, noBotState, onOff, pageHead } from '../views.js';
import { minutesToClock } from '../params.js';
import { prepareRows, pairTrades, REASON_LABELS } from '../journal.js';
import { currentValues, summaryText } from '../simple.js';
import { hallmark } from '../hallmark.js';
import { priceChart, readBars } from '../pricechart.js';

const DAY = 86400000;

function lockModules(s) {
  const m = /A=(\w+)\s+NY=(\w+)\s+C5G=(\w+)/.exec(s || '');
  if (!m) return s || '—';
  const on = [['A_new', m[1]], ['NY', m[2]], ['C5G', m[3]]].filter(([, v]) => v === 'true').map(([k]) => k);
  return on.length ? on.join(', ') : 'ไม่มีสูตร';
}

// hallmark colour + the word struck under "Dobby"
function stampOf(hs, info, st) {
  if (hs.tone === 'live') return { tone: 'gold', state: st && st.account && st.account.mode === 'REAL' ? 'เทรดจริง' : 'ทำงาน' };
  if (hs.tone === 'paused') return { tone: 'slate', state: 'หยุดอยู่' };
  if (hs.tone === 'off') {
    if (!info.agentOnline && Number.isFinite(info.seenAge)) return { tone: 'cinnabar', state: 'ออฟไลน์' };
    return { tone: 'slate', state: info.agentOnline ? 'รอสถานะ' : 'ยังไม่เชื่อม' };
  }
  if (/จุดหยุดรายวัน/.test(hs.title)) return { tone: 'slate', state: 'หยุดวันนี้' };
  return { tone: 'cinnabar', state: hs.tone === 'critical' ? 'มีปัญหา' : 'ต้องดู' };
}

export async function render(root, ctx) {
  const bot0 = currentBot();
  if (!bot0) { root.append(pageHead('ภาพรวม', null, null, 'dashboard'), noBotState()); return; }
  let bot = bot0, st = null, ctl = null, rtState = '', rows = [], journalReady = false;
  const ro = !ownsBot(bot0); // the admin viewing someone else's bot: no pause, no blackout, nothing is sent
  root.append(loadingState('กำลังโหลดสถานะบอท…'));
  const off = () => bot.server_utc_offset_min ?? 0;
  try {
    const [s, c, bots] = await Promise.all([ctx.api.botStatus(bot.id), ctx.api.botControl(bot.id), (ro ? ctx.api.adminBots() : ctx.api.listBots()).catch(() => [])]);
    st = s ? s.status : null; ctl = c;
    const fresh = bots.find((b) => b.id === bot.id); // last_seen in app.bots may be minutes old
    if (fresh) { bot = { ...bot, ...fresh }; updateBotRow(bot); }
  } catch (e) {
    mount(root, errorState(e, () => ctx.route()));
    return;
  }
  mount(root);
  const cur = () => (st && st.account && st.account.currency) || '';

  // ---------------- layout
  const headBox = h('div');
  const stampBox = h('div', { class: 'hero-stamp' });
  const copyBox = h('div', { class: 'hero-copy' });
  const todayBox = h('div', { class: 'hero-today' });
  const chart = priceChart();
  const footBox = h('div', { class: 'hero-foot' });
  const hero = h('section', { class: 'hero intro', 'aria-label': 'สถานะบอท' },
    h('div', { class: 'hero-top', 'aria-live': 'polite' }, stampBox, copyBox, todayBox),
    h('div', { class: 'hero-chart' }, chart),
    footBox);
  // empty boxes are hidden, so the column's 24 px rhythm never doubles
  const warnBox = h('div', { class: 'stack', hidden: true });
  const figsBox = h('div');
  const posBox = h('section', { class: 'panel dsec', 'aria-label': 'ไม้ที่เปิดอยู่' });
  const recentBox = h('section', { class: 'panel dsec', 'aria-label': 'เทรดล่าสุด' });
  const detailBox = h('div', { hidden: true });
  root.append(headBox, hero, warnBox, figsBox, h('div', { class: 'dash-cols' }, posBox, recentBox), detailBox);
  setTimeout(() => hero.classList.remove('intro'), 1600);

  // journal for the chart marks and the recent trades list (last 14 days, server time)
  (async () => {
    try {
      const fromServer = utcToServer(Date.now() - 14 * DAY, off()).replace(/\./g, '-').replace(' ', 'T');
      rows = prepareRows(await ctx.api.journal(bot.id, { fromServer }), off());
    } catch { rows = []; }
    journalReady = true;
    drawRecent(true);
    drawChart(true);
  })();
  // the line waits for the journal (so the marks stamp in with it), but not forever
  setTimeout(() => { if (!journalReady) { journalReady = true; drawChart(true); } }, 1500);

  function drawHead() {
    const chips = [
      (st && st.ea_version) || bot.ea_version ? h('span', { class: 'chip hide-sm' }, `EA ${(st && st.ea_version) || bot.ea_version}`) : null,
      st && st.account && st.account.mode ? h('span', { class: `chip ${st.account.mode === 'REAL' ? 'real' : ''}` }, st.account.mode === 'REAL' ? 'บัญชีจริง' : `บัญชี ${st.account.mode}`) : null,
      h('span', { class: 'chip', title: rtState === 'SUBSCRIBED' ? 'รับข้อมูลแบบสด' : 'ดึงข้อมูลใหม่ทุก 30 วินาที' },
        rtState === 'SUBSCRIBED' ? [h('span', { class: 'live-dot', 'aria-hidden': 'true' }), 'ข้อมูลสด'] : 'อัปเดตทุก 30 วินาที'),
    ];
    if (ro) chips.unshift(h('span', { class: 'chip live' }, icon('eye'), `ของ ${bot.owner_name || 'สมาชิก'}`));
    mount(headBox, pageHead('ภาพรวม', h('span', { class: 'row gap wrap' }, h('strong', { class: 'bot-name' }, bot.name), chips), null, 'dashboard'));
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
    const summary = st ? summaryText(currentValues(st).values, cur() || 'USD') : '';
    const ageBucket = Number.isFinite(updated) ? Math.min(12, Math.floor((Date.now() - updated) / 10000)) : -1;
    const v = (st && st.virtual) || {};
    const stamp = stampOf(hs, info, st);
    if (changed('hero', [hs, paused, pending, !!ctl, summary, ageBucket, info.online, stamp, v.day_pnl, cur()]) || force) {
      mount(stampBox, hallmark({ tone: stamp.tone, state: stamp.state, title: `Dobby: ${hs.title}` }));
      mount(copyBox,
        h('h2', { class: 'hero-title' }, hs.title),
        h('p', { class: 'hero-text' }, hs.text),
        h('p', { class: 'hero-meta' },
          Number.isFinite(updated) ? h('span', null, `อัปเดต${ago(updated) === 'เมื่อสักครู่' ? 'เมื่อสักครู่' : ` ${ago(updated)}`}`) : null,
          hs.help ? h('a', { class: 'hero-help', href: '#/guide/offline' }, 'วิธีแก้เมื่อบอทออฟไลน์') : null));
      mount(todayBox, st ? [
        h('span', { class: 'hero-today-label' }, 'กำไรขาดทุนวันนี้'),
        h('span', { class: 'hero-today-val' }, money(v.day_pnl, { signed: true, unit: cur() })),
      ] : h('span', { class: 'hero-today-label' }, 'ยังไม่มีตัวเลขจากบอท'));
      mount(footBox,
        summary ? h('a', { class: 'hero-summary', href: '#/bot', title: ro ? 'ดูค่าทั้งหมดในหน้าตั้งค่าบอท' : 'ดูหรือเปลี่ยนค่าในหน้าตั้งค่าบอท' }, h('strong', null, 'ค่าที่ใช้อยู่ '), summary) : h('span'),
        ro ? null : h('div', { class: 'hero-actions' },
          h('button', {
            class: `btn small ${paused ? 'primary' : ''}`, type: 'button', disabled: !ctl,
            onclick: (e) => togglePause(e.currentTarget, !paused),
          }, icon(paused ? 'play' : 'pause'), paused ? 'ทำงานต่อ' : 'หยุดชั่วคราว'),
          h('button', { class: 'btn small', type: 'button', disabled: !ctl, onclick: (e) => blackout2h(e.currentTarget) }, icon('clock'), 'งดเข้าไม้ 2 ชม.')),
        paused && pending && !ro ? h('p', { class: 'muted small hero-note' }, 'สั่งหยุดแล้ว รอเครื่องรับคำสั่ง') : null);
    }
  }

  function drawChart(animate) {
    if (!journalReady) return;
    const bars = readBars(bot);
    const mk = (st && st.market) || {};
    const trades = pairTrades(rows);
    chart.update({
      bars, trades, bid: Number(mk.bid), now: Date.now(), offsetMin: off(),
      emptyText: 'กราฟราคาจะขึ้นเมื่อแอปเวอร์ชันใหม่ส่งข้อมูล',
    }, { animate });
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
    const block = rejectionsBlock(bot, st);
    mount(warnBox, block || '');
    warnBox.hidden = !block;
  }

  // engraved figures: four identical stat cells (label, value, foot); same height by construction (CSS grid stretch)
  function drawFigs() {
    if (!st) { mount(figsBox, h('div', { class: 'state empty' }, h('p', { class: 'state-title' }, 'ยังไม่มีตัวเลขจากบอท'), h('p', { class: 'muted' }, 'เมื่อแอปที่เครื่องส่งสถานะขึ้นมา ยอดเงินและกำไรจะขึ้นที่นี่'))); return; }
    const a = st.account || {}, v = st.virtual || {}, p = st.params || {};
    const c = cur();
    const floating = (a.equity ?? 0) - (a.balance ?? 0);
    const since = (v.balance ?? 0) - (v.start ?? 0);
    const capPct = p.daily_cap_pct ?? 10;
    const capAmt = (capPct / 100) * (v.day_start || 0);
    const loss = Math.max(0, -(v.day_pnl || 0));
    const used = capAmt > 0 ? Math.min(1, loss / capAmt) : 0;
    const tone = v.day_cap_hit || used >= 0.8 ? 'critical' : used >= 0.5 ? 'warn' : 'ok';
    const wr = v.trades ? Math.round((v.wins / v.trades) * 100) : null;
    const fig = (label, value, foot, cls = '', title = null) => h('div', { class: `fig ${cls}`.trim(), title },
      h('p', { class: 'fig-label' }, label), h('p', { class: 'fig-value' }, value), h('div', { class: 'fig-foot' }, foot));
    mount(figsBox, h('section', { class: 'figs', 'aria-label': 'ยอดเงินและกำไร' },
      fig('ยอดเงินในบัญชี', money(a.balance, { unit: c }), h('p', null, a.mode === 'REAL' ? 'บัญชีจริงที่โบรก' : a.mode ? `บัญชี ${a.mode} ที่โบรก` : 'ยอดที่โบรก')),
      fig('มูลค่าพอร์ตตอนนี้', money(a.equity, { unit: c }),
        h('p', null, Math.abs(floating) >= 0.005 ? ['รวมไม้ที่เปิดอยู่ ', h('span', { class: `num ${toneOf(floating)}` }, fmtSigned(floating))] : 'ไม่มีไม้ค้าง')),
      fig('กำไรขาดทุนวันนี้', money(v.day_pnl, { signed: true, unit: c }), [
        h('div', { class: 'meter', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(used * 100)), 'aria-label': 'ขาดทุนวันนี้เทียบกับจุดหยุดรายวัน' },
          h('span', { class: 'meter-fill', style: { width: `${(v.day_cap_hit ? 1 : used) * 100}%` } })),
        h('p', null, v.day_cap_hit ? 'ถึงจุดหยุดแล้ว วันนี้ไม่เปิดไม้ใหม่'
          : (v.day_pnl || 0) >= 0 ? ['จุดหยุดรายวัน ', h('span', { class: 'num' }, `−${fmtNum(capAmt, 0)}`), ` (${fmtNum(capPct, 0)}%)`]
            : ['ใช้ไป ', h('span', { class: 'num' }, fmtPct(used * 100, 0)), ' ของจุดหยุด ', h('span', { class: 'num' }, `−${fmtNum(capAmt, 0)}`)]),
      ], `tone-${tone}`),
      fig('ตั้งแต่เริ่ม', money(since, { signed: true, unit: c }),
        h('p', null, v.start ? [h('span', { class: 'num' }, fmtPct((since / v.start) * 100, 1, true)), ` จากทุน ${fmtNum(v.start, 0)}`] : 'ยังไม่มีทุนตั้งต้น'),
        '', wr === null ? null : `${v.trades} ไม้ ชนะ ${wr}%`)));
  }

  function drawPositions() {
    const list = st ? (st.positions || []).filter((p) => p.open) : [];
    const mk = (st && st.market) || {};
    if (!changed('pos', [list, mk.bid, cur(), Math.floor(Date.now() / 60000)])) return;
    mount(posBox,
      h('div', { class: 'dsec-head' }, h('h2', null, list.length > 1 ? `ไม้ที่เปิดอยู่ ${list.length} ไม้` : 'ไม้ที่เปิดอยู่'),
        mk.bid ? h('p', null, 'สเปรด ', h('span', { class: 'num' }, fmtNum(mk.spread))) : null),
      list.length ? h('div', { class: 'positions' }, list.map((p) => positionRow(p, mk, cur(), list.length === 1)))
        : h('div', { class: 'pos-empty' }, h('span', { class: 'pos-empty-ico' }, icon('clock')), h('p', { class: 'state-title' }, 'ไม่มีไม้เปิดอยู่'),
          h('p', null, 'บอทกำลังรอสัญญาณ เมื่อเปิดไม้ จะขึ้นที่นี่และบนกราฟทันที')));
  }

  // one open trade: summary, the SL - entry - price - TP gauge, then four facts (price, time open, distance to TP / SL)
  function positionRow(p, mk, c, full) {
    const dir = p.side === 'BUY' ? 1 : -1;
    const price = p.side === 'BUY' ? mk.bid : mk.ask;
    const tpDist = (p.tp - p.open_price) * dir, slDist = (p.open_price - p.sl) * dir;
    const gain = (price - p.open_price) * dir;
    // gauge in "distance" terms: SL (left) -> entry -> TP (right), whatever the side
    const lo = -Math.max(slDist, 0.0001), hi = Math.max(tpDist, 0.0001);
    const t = (x) => Math.max(0, Math.min(1, (x - lo) / (hi - lo)));
    const slLocked = slDist < 0;
    let progress = '';
    if (Number.isFinite(gain) && tpDist > 0) {
      if (gain >= 0) progress = `ไปแล้ว ${fmtPct((gain / tpDist) * 100, 0)} ของทางไป TP`;
      else if (slDist > 0) progress = `ติดลบ ${fmtPct((-gain / slDist) * 100, 0)} ของทางไป SL`;
    }
    const openedUtc = serverToUtc(p.open_time, off());
    const pl = (p.profit || 0) + (p.swap || 0);
    const slPos = slLocked ? t(-slDist) : 0;
    const contract = 100 * (p.lots || 0); // XAUUSD: 100 oz per lot
    const tpLeft = (p.tp - price) * dir, slLeft = (price - p.sl) * dir;
    const pctOf = (x) => (Number.isFinite(x) && price > 0 ? `${fmtNum((x / price) * 100, 2)}%` : '');
    const fact = (label, value, sub) => h('div', { class: 'pos-fact' }, h('dt', null, label), h('dd', null, value), sub ? h('p', { class: 'fact-sub' }, sub) : null);
    const todayKey = thaiDayKey(Date.now());
    const opened = Number.isFinite(openedUtc) ? (thaiDayKey(openedUtc) === todayKey ? `วันนี้ ${fmtThai(openedUtc, 'time')}` : fmtThai(openedUtc, 'short')) : '—';
    return h('article', { class: 'position' },
      h('div', { class: 'pos-summary' }, sideEl(p.side), modChip(p.module), h('span', { class: 'muted' }, h('span', { class: 'num' }, fmtNum(p.lots)), ' ล็อต'),
        p.locked || slLocked ? h('span', { class: 'chip live' }, icon('shield'), 'ล็อกกำไรแล้ว') : p.near_tp ? h('span', { class: 'chip warn' }, 'ใกล้ TP') : null,
        h('span', { class: 'pos-pnl' }, money(pl, { signed: true, unit: c }))),
      Number.isFinite(gain) ? h('div', { class: 'ptrack', role: 'img', 'aria-label': `SL ${fmtNum(p.sl)} ราคาเข้า ${fmtNum(p.open_price)} ราคาตอนนี้ ${fmtNum(price)} TP ${fmtNum(p.tp)}` },
        h('div', { class: 'pt-bar' },
          h('span', { class: 'pt-loss', style: { width: `${t(0) * 100}%` } }),
          h('span', { class: 'pt-win', style: { left: `${t(0) * 100}%`, width: `${(1 - t(0)) * 100}%` } }),
          h('span', { class: 'pt-entry', style: { left: `${t(0) * 100}%` } }),
          slLocked ? h('span', { class: 'pt-lock', style: { left: `${slPos * 100}%` }, title: 'SL ใหม่ (ล็อกกำไร)' }) : null,
          h('span', { class: `pt-now ${gain >= 0 ? 'up' : 'down'}`, style: { left: `${t(gain) * 100}%` }, title: `ราคาตอนนี้ ${fmtNum(price)}` })),
        h('div', { class: 'pt-labels' },
          h('span', null, h('b', null, slLocked ? 'SL เดิม' : 'SL'), h('span', { class: 'num' }, slLocked ? '' : fmtNum(p.sl))),
          h('span', { class: 'pt-mid', style: { left: `${t(0) * 100}%` } }, h('b', null, 'ราคาเข้า'), h('span', { class: 'num' }, fmtNum(p.open_price))),
          h('span', { class: 'pt-r' }, h('b', null, 'TP'), h('span', { class: 'num' }, fmtNum(p.tp))))) : null,
      progress ? h('p', { class: 'pos-progress' }, progress) : null,
      full ? h('dl', { class: 'pos-facts' },
        fact('ราคาตอนนี้', h('span', { class: 'num' }, fmtNum(price)), ['เข้าที่ ', h('span', { class: 'num' }, fmtNum(p.open_price))]),
        fact('เปิดมาแล้ว', Number.isFinite(openedUtc) ? duration(Date.now() - openedUtc) : '—', `ตั้งแต่ ${opened}`),
        fact('ห่างจาก TP', [h('span', { class: 'num' }, fmtNum(tpLeft)), h('span', { class: 'unit' }, ` $ (${pctOf(tpLeft)})`)],
          ['ถึง TP ได้ราว ', h('span', { class: 'num pos' }, fmtSigned(tpDist * contract))]),
        slLocked
          ? fact('SL ล็อกกำไรไว้', money(-slDist * contract, { signed: true, unit: c }), ['SL อยู่ที่ ', h('span', { class: 'num' }, fmtNum(p.sl))])
          : fact('ห่างจาก SL', [h('span', { class: 'num' }, fmtNum(slLeft)), h('span', { class: 'unit' }, ` $ (${pctOf(slLeft)})`)],
            ['โดน SL เสียราว ', h('span', { class: 'num neg' }, fmtSigned(-slDist * contract))]))
        : h('p', { class: 'muted small' }, `เปิดเมื่อ ${opened}`));
  }

  // the last 6 closed trades (the full list is one click away), amounts right-aligned
  function drawRecent(force) {
    const trades = pairTrades(rows).filter((t) => !t.open).slice(-6).reverse();
    if (!changed('recent', trades.map((t) => [t.closeUtc, t.pnl])) && !force) return;
    const c = cur();
    const today = thaiDayKey(Date.now());
    mount(recentBox,
      h('div', { class: 'dsec-head' }, h('h2', null, 'เทรดล่าสุด'), h('a', { class: 'link-quiet', href: '#/history?tab=trades' }, 'ดูทั้งหมด')),
      trades.length ? h('ul', { class: 'trade-list' }, trades.map((t) => {
        const when = thaiDayKey(t.closeUtc) === today ? `วันนี้ ${fmtThai(t.closeUtc, 'time')}` : fmtThai(t.closeUtc, 'short');
        const buy = t.side === 'BUY';
        return h('li', { class: 'trade' },
          h('span', { class: `trade-ico ${buy ? 'buy' : 'sell'}`, 'aria-hidden': 'true' }, buy ? '▲' : '▼'),
          h('div', { class: 'trade-main' },
            h('p', null, modChip(t.module), ' ', h('span', { class: `side ${buy ? 'buy' : 'sell'}` }, buy ? 'ซื้อ' : 'ขาย'), ' ', h('span', { class: 'muted' }, h('span', { class: 'num' }, fmtNum(t.lots)), ' ล็อต')),
            h('p', { class: 'muted small' }, `${when} ${REASON_LABELS[t.reason] || t.reason || 'ปิดไม้'}`)),
          h('span', { class: 'trade-pnl' }, money(t.pnl, { signed: true, unit: c })));
      })) : h('div', { class: 'pos-empty' }, h('span', { class: 'pos-empty-ico' }, icon('history')),
        h('p', { class: 'state-title' }, journalReady ? 'ยังไม่มีไม้ที่ปิดใน 14 วันนี้' : 'กำลังโหลด…')));
  }

  function srvToThaiClock(min) {
    const t = ((min - off() + 420) % 1440 + 1440) % 1440;
    return minutesToClock(t);
  }

  function drawDetails() {
    detailBox.hidden = !st;
    if (!st) { mount(detailBox); return; }
    if (!changed('details', [st.modules, st.ny, st.options, st.control, st.last_event, st.last_error]) && detailBox.firstChild) return;
    const open = detailBox.querySelector('details') ? detailBox.querySelector('details').open : false;
    const ny = st.ny || {}, o = st.options || {}, c = st.control || {}, lock = o.lock || {}, lock1 = o.lock1 || {};
    const bos = (c.blackouts || []).map((b) => {
      const from = serverToUtc(b[0], off()), to = serverToUtc(b[1], off());
      return h('li', null, `${fmtThai(from, 'short')} ถึง ${fmtThai(to, Math.floor(from / 864e5) === Math.floor(to / 864e5) ? 'time' : 'short')}`);
    });
    mount(detailBox, h('details', { class: 'panel more-details', open },
      h('summary', null, h('strong', null, 'รายละเอียดเพิ่มเติม'), h('span', { class: 'muted' }, 'ผลแต่ละสูตร กรอบ NY ล็อกกำไร และเหตุการณ์ล่าสุด')),
      st.modules ? h('div', { class: 'table-wrap' }, h('table', { class: 'rtable' },
        h('thead', null, h('tr', null, ['สูตร', 'สถานะ', 'ล็อต', 'วันนี้', 'เทรด', 'ชนะ/แพ้', 'อัตราชนะ', `สุทธิ ${cur()}`].map((x) => h('th', { scope: 'col' }, x)))),
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
        panel('ล็อกกำไร', { cls: 'flat',}, kv([
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
        panel('เหตุการณ์ล่าสุด', { cls: 'flat',}, eventLine('ล่าสุด', st.last_event), eventLine('ข้อผิดพลาดล่าสุด', st.last_error, true)))));
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

  function drawAll() { drawHead(); drawHero(true); drawWarn(); drawFigs(); drawPositions(); drawRecent(true); drawDetails(); }
  drawAll();

  const redrawChart = debounce(() => drawChart(false), 120);
  const onStatus = (row) => { if (!row || !row.status) return; st = row.status; drawHero(); drawWarn(); drawFigs(); drawPositions(); drawDetails(); redrawChart(); };
  const onControl = (row) => { ctl = row; drawHero(); };
  const onBot = (row) => {
    const barsBefore = JSON.stringify(bot.agent_state && bot.agent_state.bars && bot.agent_state.bars.t ? bot.agent_state.bars.t.slice(-1) : null);
    bot = { ...bot, ...row }; updateBotRow(bot); drawHero(); drawWarn();
    const barsNow = JSON.stringify(bot.agent_state && bot.agent_state.bars && bot.agent_state.bars.t ? bot.agent_state.bars.t.slice(-1) : null);
    if (barsBefore !== barsNow) redrawChart();
  };
  const addRow = debounce(() => { drawRecent(); drawChart(false); }, 500);
  const unsub = ctx.api.subscribeBot(bot.id, {
    status: onStatus, control: onControl, bot: onBot,
    journal: (row) => { rows = prepareRows([...rows, row], off()); addRow(); },
    state: (s) => { rtState = s; drawHead(); },
  });
  const offCtl = on('control-updated', (row) => { if (row && row.bot_id === bot.id) onControl(row); });
  const offTheme = on('theme', () => drawChart(false));
  const ages = setInterval(() => drawHero(), 5000);
  const poll = setInterval(async () => {
    if (rtState === 'SUBSCRIBED') return;
    try {
      const [s, c, bots] = await Promise.all([ctx.api.botStatus(bot.id), ctx.api.botControl(bot.id), ro ? ctx.api.adminBots() : ctx.api.listBots()]);
      const b = bots.find((x) => x.id === bot.id);
      if (b) onBot(b);
      if (c) onControl(c);
      if (s) onStatus(s);
    } catch { /* keep the last data */ }
  }, 30000);
  return () => { unsub(); offCtl(); offTheme(); clearInterval(ages); clearInterval(poll); chart.destroy(); };
}
