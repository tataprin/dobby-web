// ภาพรวม: the hero (hallmark stamp + one-sentence status + today's P&L, then today's price line with Dobby's trades
// stamped on it), the engraved numbers row, the open trade with an SL - entry - price - TP gauge, recent trades, then
// details. Realtime; read again after 20 s without news or when a phone wakes the page (SPEC 5 page 2).
import { h, mount, icon, fmtNum, fmtSigned, fmtPct, pnl, fmtThai, timeEl, serverToUtc, parseWall, toast, errText, confirmDialog,
  errorState, loadingState, isoUtc, toneOf, utcToServer, ago, debounce, thaiDayKey, money, duration, onWake, busy } from '../util.js';
import { app, currentBot, updateBotRow, on, ownsBot, canControl } from '../state.js';
import { normDesired, patchDesired, onlineInfo, rejectionsBlock, isPending, heroState } from '../botctl.js';
import { modChip, sideEl, kv, panel, noBotState, onOff, pageHead } from '../views.js';
import { runnerSupported, capResetToken, minutesToClock } from '../params.js';
import { prepareRows, pairTrades, REASON_LABELS, tradeHref, rebaseBalances, statsOf } from '../journal.js';
import { strategyHealth, riskStats, sinceStart, dietz } from '../analytics.js';
import { roundsOf, currentRound, roundTitle, botPnlOf } from '../rounds.js';
import { riskStrip } from '../insights.js';
import { currentValues, summaryText, toDesiredParams } from '../simple.js';
import { hallmark } from '../hallmark.js';
import { priceChart, readBars } from '../pricechart.js';
import { tvChartPanel } from '../tvchart.js';

const DAY = 86400000;
// daily-cap reset (EA v3.05, SPEC 11): the status must be younger than this, and a sent token is given this long
const CAP_STALE_MS = 15 * 60000, CAP_TIMEOUT_MS = 3 * 60000;

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
  let bot = bot0, st = null, ctl = null, rtState = '', rows = [], journalReady = false, flows = [], rounds = [];
  const other = !ownsBot(bot0); // someone else's bot (the admin looking at a member's bot)
  // nothing is sent: no pause, no blackout. The admin may change a member's bot like its owner (2026-11-10), after the
  // admin's password (patchDesired / adminUnlock).
  const ro = !canControl(bot0);
  root.append(loadingState('กำลังโหลดสถานะบอท…'));
  const off = () => bot.server_utc_offset_min ?? 0;
  try {
    const [s, c, bots] = await Promise.all([ctx.api.botStatus(bot.id), ctx.api.botControl(bot.id), (other ? ctx.api.adminBots() : ctx.api.listBots()).catch(() => [])]);
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
  const capBox = h('div', { hidden: true }); // the daily-cap banner with "รีเซ็ตจุดหยุดรายวัน" (SPEC 11)
  const warnBox = h('div', { class: 'stack', hidden: true });
  const figsBox = h('div');
  const riskBox = h('div', { hidden: true });
  const posBox = h('section', { class: 'panel dsec', 'aria-label': 'ไม้ที่เปิดอยู่' });
  const recentBox = h('section', { class: 'panel dsec', 'aria-label': 'เทรดล่าสุด' });
  const detailBox = h('div', { hidden: true });
  const tvBox = tvChartPanel(); // TradingView's gold chart, an extra view (loads when scrolled near)
  root.append(headBox, hero, capBox, warnBox, figsBox, riskBox, h('div', { class: 'dash-cols' }, posBox, recentBox), tvBox, detailBox);
  const eaVer = () => (st && st.ea_version) || bot.ea_version || '';
  setTimeout(() => hero.classList.remove('intro'), 1600);

  // journal for the chart marks, the recent trades list and the risk strip (last 30 days, server time, or since the
  // current round began when that is earlier: SPEC 9.8); confirmed cash flows for the % of "ตั้งแต่เริ่ม" (SPEC 9.2)
  (async () => {
    try { rounds = roundsOf(await ctx.api.listRounds(bot.id)); } catch { rounds = []; } // table not deployed: no rounds
    if (rounds.length) drawFigs();
    try {
      const r = currentRound(rounds);
      const fromUtc = Math.min(Date.now() - 30 * DAY, r ? r.from : Infinity);
      const fromServer = utcToServer(fromUtc, off()).replace(/\./g, '-').replace(' ', 'T');
      rows = prepareRows(await ctx.api.journal(bot.id, { fromServer }), off());
    } catch { rows = []; }
    journalReady = true;
    drawRecent(true);
    drawChart(true);
    drawRisk();
    drawPositions(true);
    if (rounds.length) drawFigs();
  })();
  ctx.api.listCashFlows(bot.id).then((f) => { flows = f || []; drawFigs(); }).catch(() => {});
  // the line waits for the journal (so the marks stamp in with it), but not forever
  setTimeout(() => { if (!journalReady) { journalReady = true; drawChart(true); } }, 1500);

  function drawHead() {
    const chips = [
      (st && st.ea_version) || bot.ea_version ? h('span', { class: 'chip hide-sm' }, `EA ${(st && st.ea_version) || bot.ea_version}`) : null,
      st && st.account && st.account.mode ? h('span', { class: `chip ${st.account.mode === 'REAL' ? 'real' : ''}` }, st.account.mode === 'REAL' ? 'บัญชีจริง' : `บัญชี ${st.account.mode}`) : null,
      h('span', { class: 'chip', title: rtState === 'SUBSCRIBED' ? 'รับข้อมูลแบบสด' : 'ดึงข้อมูลใหม่ทุก 20 วินาที' },
        rtState === 'SUBSCRIBED' ? [h('span', { class: 'live-dot', 'aria-hidden': 'true' }), 'ข้อมูลสด'] : 'อัปเดตทุก 20 วินาที'),
    ];
    if (other) chips.unshift(h('span', { class: 'chip live' }, icon(ro ? 'eye' : 'shield'), `ของ ${bot.owner_name || 'สมาชิก'}`));
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
    const summary = st ? summaryText(currentValues(st).values, cur() || 'USD', botPnlOf(st)) : '';
    const ageBucket = Number.isFinite(updated) ? Math.min(12, Math.floor((Date.now() - updated) / 10000)) : -1;
    const v = (st && st.virtual) || {};
    const stamp = stampOf(hs, info, st);
    const demoCap = ctx.api.mode === 'demo' && !other && typeof ctx.api.demoHitCap === 'function' && runnerSupported(eaVer()) && st && v.day_cap_hit !== true;
    if (changed('hero', [hs, paused, pending, !!ctl, summary, ageBucket, info.online, stamp, v.day_pnl, v.day_cap_hit, demoCap, cur()]) || force) {
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
          h('button', { class: 'btn small', type: 'button', disabled: !ctl, onclick: (e) => blackout2h(e.currentTarget) }, icon('clock'), 'งดเข้าไม้ 2 ชม.'),
          // demo only: a losing day that hits the cap, so the banner and "รีเซ็ตจุดหยุดรายวัน" can be tried (SPEC 11)
          demoCap ? h('button', {
            class: 'btn small ghost', type: 'button', title: 'โหมดตัวอย่างเท่านั้น: ไม้แพ้หนึ่งไม้จนถึงจุดหยุดรายวัน',
            onclick: async (e) => { busy(e.currentTarget, true); try { await ctx.api.demoHitCap(bot.id); } catch (err) { toast(errText(err), 'error'); } },
          }, icon('warn'), 'ตัวอย่าง: จำลองวันที่ถึงจุดหยุด') : null),
        paused && pending && !ro ? h('p', { class: 'muted small hero-note' }, 'สั่งหยุดแล้ว รอเครื่องรับคำสั่ง') : null);
    }
  }

  // ---------------- daily-cap banner + "รีเซ็ตจุดหยุดรายวัน" (EA v3.05, SPEC 11)
  // The token lives in desired.params.cap_reset and IS its send time (unix seconds), so any device sees the same
  // pending state. It is applied by the EA when the cap is hit today; the agent rejects the WHOLE params block once a
  // token is older than 48 h, so the token is removed from desired.params as soon as it is done: the status reports it
  // (cap_reset_applied), the cap is no longer hit, or 3 minutes passed without an answer.
  let capDone = 0, capTimedOut = 0, capClearing = null; // tokens already announced / timed out; the clearing patch in flight
  let capClearTries = 0, capClearToken = 0; // a few retries per token when the clearing patch fails (offline, conflicts)
  const capToken = () => { const d = normDesired(ctl && ctl.desired); const t = d.params ? Number(d.params.cap_reset) : NaN; return Number.isFinite(t) && t > 0 ? Math.floor(t) : 0; };
  const capResolved = (token, v) => !!(token && st && (Number(v.cap_reset_applied) >= token || v.day_cap_hit === false));
  const capAge = (token) => Date.now() - token * 1000;
  // take the token out of desired.params (owner only, a few tries per token; every other value stays). Not on a
  // member's bot the admin looks at: a background patch there would ask for the admin's password out of nowhere; any
  // later change drops a stale token anyway (patchDesired).
  function clearCapToken(token) {
    if (other || capClearing || !ctl) return;
    if (token !== capClearToken) { capClearToken = token; capClearTries = 0; }
    if (capClearTries >= 5) return;
    capClearTries += 1;
    capClearing = patchDesired(bot.id, (d) => { if (d.params && typeof d.params === 'object') { const { cap_reset, ...rest } = d.params; d.params = rest; } }, { keepCommand: true })
      .then((row) => { ctl = row || ctl; }, () => {})
      .finally(() => { capClearing = null; if (capToken() === token) setTimeout(drawCap, 5000); });
  }
  // why the button cannot be used now (null = it can). Owner, control row, EA >= 3.05, app online, status < 15 min,
  // InpRemoteParams on, and the PC allows settings from the web (otherwise the command would never reach the EA).
  function capReason() {
    const info = onlineInfo(bot, st);
    const lim = (bot.agent_state && bot.agent_state.limits) || {};
    if (ro) return `ดูได้อย่างเดียว (บอทของ ${bot.owner_name || 'สมาชิก'})`;
    if (!ctl) return 'บอทนี้ยังเชื่อมกับเว็บไม่ครบ (ไม่มีแถวควบคุม)';
    if (!runnerSupported(eaVer())) return `ต้องอัปเดต EA เป็น v3.05 และแอป Dobby 1.2.2 ก่อน (บอทนี้รุ่น ${eaVer() || 'ไม่ทราบ'})`;
    if (!info.agentOnline) return 'แอป Dobby ที่เครื่องออฟไลน์อยู่ คำสั่งจะยังไม่ถึงบอท';
    const hb = st && Number.isFinite(st.heartbeat_gmt_unix) ? st.heartbeat_gmt_unix * 1000 : NaN;
    if (!Number.isFinite(hb) || Date.now() - hb > CAP_STALE_MS) return 'สถานะล่าสุดจากบอทเก่ากว่า 15 นาที รอให้บอทส่งสถานะใหม่ก่อน';
    if (!(st.remote && st.remote.params_enabled)) return 'EA ยังไม่เปิดรับคำสั่งจากเว็บ (InpRemoteParams) โหลด Dobby3_v305_web.set ใน MT5 อีกครั้ง';
    if (lim.allow_remote_params === false) return 'เครื่องนี้ยังไม่อนุญาตให้เว็บส่งค่า (แอป Dobby → ตั้งค่า → ความปลอดภัย)';
    return null;
  }
  function drawCap() {
    const v = (st && st.virtual) || {};
    const hit = v.day_cap_hit === true;
    const token = capToken();
    if (token && capResolved(token, v)) {
      // done: the EA took it (or the cap cleared by itself); say so once and take the token out of desired.params
      if (capDone !== token) { capDone = token; if (Number(v.cap_reset_applied) >= token) toast('บอทรีเซ็ตจุดหยุดรายวันแล้ว วันนี้เปิดไม้ใหม่ได้อีก', 'good', 6000); }
      clearCapToken(token);
    } else if (token && capAge(token) > CAP_TIMEOUT_MS) {
      // no answer in 3 minutes: the token comes out (a stale one would make the PC refuse every setting after 48 h)
      capTimedOut = token;
      clearCapToken(token);
    }
    const timedOut = !!capTimedOut && hit; // the message stays until the next click or the cap clears
    const waiting = !!token && !capResolved(token, v) && capAge(token) <= CAP_TIMEOUT_MS;
    const reason = capReason();
    const pct = Number(v.day_start) > 0 ? ((Number(v.day_pnl) || 0) / Number(v.day_start)) * 100 : null;
    const capPct = Number(st && st.params && st.params.daily_cap_pct) || 10;
    if (!changed('cap', [hit, v.day_pnl, v.day_start, v.cap_reset_applied, v.cap_resets_today, reason, waiting, timedOut, cur()])) return;
    capBox.hidden = !hit;
    if (!hit) { mount(capBox); return; }
    mount(capBox, h('div', { class: 'callout warn cap-banner', role: 'status' }, icon('warn'),
      h('div', null,
        h('p', { class: 'callout-title' }, 'ถึงจุดหยุดรายวันแล้ว'),
        h('p', null, 'วันนี้ ', money(v.day_pnl, { signed: true, unit: cur() }), pct !== null ? ` (${fmtPct(pct, 1, true)})` : '',
          ' บอทหยุดเปิดไม้ใหม่จนถึงวันถัดไป (ตามเวลาเซิร์ฟเวอร์) ไม้ที่เปิดอยู่ยังวิ่งต่อ'),
        Number(v.cap_resets_today) > 0 ? h('p', { class: 'muted small' }, `วันนี้รีเซ็ตไปแล้ว ${v.cap_resets_today} ครั้ง ทุนต้นวันตอนนี้ ${fmtNum(v.day_start)} ${cur()}`) : null,
        h('div', { class: 'cap-actions' },
          h('button', { class: 'btn small', type: 'button', disabled: !!reason || waiting, onclick: (e) => capResetClick(e.currentTarget) }, icon('refresh'), 'รีเซ็ตจุดหยุดรายวัน'),
          waiting ? h('span', { class: 'chip pending' }, h('span', { class: 'pulse', 'aria-hidden': 'true' }), 'ส่งคำสั่งแล้ว รอบอทรับ')
            : timedOut ? h('span', { class: 'warn-text small' }, 'ยังไม่ได้รับ ตรวจว่าแอปเปิดอยู่ แล้วกดอีกครั้งได้')
              : reason ? h('span', { class: 'muted small' }, reason)
                : h('span', { class: 'muted small' }, `ให้บอทเทรดต่อได้วันนี้ จุดหยุดใหม่ ${fmtNum(capPct, 0)}% ของทุนตอนนี้ (ตัดสินใจเอง)`),
          h('a', { class: 'small', href: '#/guide/capreset' }, 'คืออะไร')))));
  }
  async function capResetClick(btn) {
    const reason = capReason();
    if (reason) { toast(reason, 'error', 6000); return; }
    const v = (st && st.virtual) || {};
    const c = cur() || 'USD';
    const capPct = Number(st.params && st.params.daily_cap_pct) || 10;
    const balNow = Number(v.balance), loss = Number(v.day_pnl) || 0;
    const ok = await confirmDialog('รีเซ็ตจุดหยุดรายวัน?', h('div', { class: 'stack' },
      h('ul', null,
        h('li', null, `ทุนต้นวันจะเปลี่ยนจาก ${fmtNum(v.day_start)} เป็นพอร์ตจำลองตอนนี้ ${fmtNum(balNow)} ${c} และกำไรขาดทุนวันนี้เริ่มนับใหม่จาก 0 (ขาดทุน ${fmtNum(Math.abs(loss))} ที่เกิดแล้วยังอยู่ในบัญชีเหมือนเดิม)`),
        h('li', null, `บอทกลับมาเปิดไม้ใหม่ได้ทันทีที่รับคำสั่ง และวันนี้อาจขาดทุนได้อีก ${fmtNum(capPct, 0)}% (≈ ${fmtNum((capPct / 100) * (balNow || 0), 0)} ${c}) ก่อนถึงจุดหยุดอีกครั้ง`),
        h('li', null, 'ไม้ที่เปิดอยู่ สวิตช์เทรดจริง และค่าอื่น ๆ ไม่เปลี่ยน รีเซ็ตได้มากกว่าหนึ่งครั้งต่อวัน'),
        h('li', null, 'นี่เป็นการตัดสินใจของเจ้าของบอท จุดหยุดรายวันมีไว้กันวันที่แย่ลามไปทั้งพอร์ต ถ้าไม่แน่ใจ รอวันถัดไปปลอดภัยกว่า')),
      h('p', { class: 'muted small' }, 'คำสั่งส่งผ่านแอป Dobby ที่เครื่อง บอทรับทันที (ไม่ต้องรอให้ไม้ปิด) ปกติไม่เกินครึ่งนาที')),
    { ok: 'รีเซ็ตและให้เทรดต่อ', danger: true });
    if (!ok) return;
    busy(btn, true, 'กำลังส่ง…');
    const token = capResetToken();
    try {
      if (capClearing) await capClearing;
      ctl = await patchDesired(bot.id, (d) => {
        // the current params (what the web last sent, else what the bot runs now) + the fresh token
        const base = d.params && typeof d.params === 'object' && Object.keys(d.params).length ? d.params : toDesiredParams(currentValues(st).values, { eaVersion: eaVer() });
        d.params = { ...base, cap_reset: token };
      }, { keepCommand: true });
      capTimedOut = 0;
      toast('ส่งคำสั่งแล้ว รอบอทรับ', 'good');
    } catch (e) { busy(btn, false); toast(errText(e), 'error', 6000); }
    drawCap();
  }

  function drawChart(animate) {
    if (!journalReady) return;
    const bars = readBars(bot);
    const mk = (st && st.market) || {};
    const trades = pairTrades(rows);
    chart.update({
      bars, trades, bid: Number(mk.bid), now: Date.now(), offsetMin: off(),
      emptyText: 'กราฟราคาจะขึ้นเมื่อแอปเวอร์ชันใหม่ส่งข้อมูล',
      onTrade: (t) => { if (t.key) location.hash = tradeHref(t.key); },
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
    const ss = sinceStart(st, flows, off());
    const since = ss ? ss.pnl : (v.balance ?? 0) - (v.start ?? 0);
    const capPct = p.daily_cap_pct ?? 10;
    const capAmt = (capPct / 100) * (v.day_start || 0);
    const loss = Math.max(0, -(v.day_pnl || 0));
    const used = capAmt > 0 ? Math.min(1, loss / capAmt) : 0;
    const tone = v.day_cap_hit || used >= 0.8 ? 'critical' : used >= 0.5 ? 'warn' : 'ok';
    const wr = v.trades ? Math.round((v.wins / v.trades) * 100) : null;
    const fig = (label, value, foot, cls = '', title = null) => h('div', { class: `fig ${cls}`.trim(), title },
      h('p', { class: 'fig-label' }, label), h('p', { class: 'fig-value' }, value), h('div', { class: 'fig-foot' }, foot));
    // SPEC 9.8: after a new round, "รอบนี้" (the closed trades since the round began, from the journal) replaces "ตั้งแต่เริ่ม"
    const R = roundNow();
    const lastFig = R ? fig('รอบนี้', R.ready ? money(R.s.net, { signed: true, unit: c }) : '—', [
      h('p', null, R.pct !== null && R.ready ? [h('span', { class: 'num' }, fmtPct(R.pct, 1, true)), ` จากทุน ${fmtNum(R.startCap, 0)}`]
        : `${roundTitle(R.r)}${R.r.name ? ` ${R.r.name}` : ''}`),
      h('p', null, `เริ่ม ${fmtThai(R.r.from, 'dm')} `, !R.ready ? 'กำลังนับ…' : R.s.trades ? `${R.s.trades} ไม้ ชนะ ${fmtPct(R.s.winRate, 0)}` : 'ยังไม่มีไม้ที่ปิด'),
    ], '', `${roundTitle(R.r)}${R.r.name ? ` ${R.r.name}` : ''} ดูทุกรอบได้ที่หน้าประวัติ`)
      : fig('ตั้งแต่เริ่ม', money(since, { signed: true, unit: c }),
        h('p', null, v.start ? [h('span', { class: 'num' }, fmtPct(ss && ss.pct !== null ? ss.pct : (since / v.start) * 100, 1, true)),
          ss && ss.weighted ? ' ไม่นับเงินฝาก-ถอน' : ` จากทุน ${fmtNum(v.start, 0)}`] : 'ยังไม่มีทุนตั้งต้น'),
        '', wr === null ? null : `${v.trades} ไม้ ชนะ ${wr}%`);
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
      lastFig));
  }

  // the current round's numbers from the journal (null without rounds)
  function roundNow() {
    const r = currentRound(rounds);
    if (!r) return null;
    const closed = journalReady ? pairTrades(rows).filter((t) => !t.open && t.closeUtc >= r.from) : [];
    const s = statsOf(closed);
    const startCap = Number(r.base && r.base.balance) > 0 ? Number(r.base.balance) : null;
    return { r, s, startCap, ready: journalReady, pct: startCap ? dietz(s.net, startCap, flows, r.from, Date.now()) : null };
  }

  // the compact risk strip (SPEC 9.5; the full panels are in ประวัติ > ภาพรวม)
  function drawRisk() {
    if (!journalReady) return;
    // v_balance on one footing (the EA recomputes it when its starting capital changes); a round counts its own trades
    const trades = pairTrades(rebaseBalances(rows, st));
    const r = currentRound(rounds);
    const mine = r ? trades.filter((t) => (t.open ? t.openUtc : t.closeUtc) >= r.from) : trades;
    if (!changed('risk', [trades.length, trades.length ? trades[trades.length - 1].closeUtc : 0, st && st.virtual && st.virtual.balance, r && r.from])) return;
    const closed = trades.filter((t) => !t.open);
    riskBox.hidden = !closed.length;
    mount(riskBox, closed.length ? riskStrip(riskStats(mine, st), strategyHealth(trades), cur(), r ? 'ในรอบนี้' : 'ใน 30 วัน') : '');
  }

  function drawPositions(force) {
    const list = st ? (st.positions || []).filter((p) => p.open) : [];
    const mk = (st && st.market) || {};
    if (!changed('pos', [list, mk.bid, cur(), Math.floor(Date.now() / 60000)]) && !force) return;
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
    // EA v3.05 runner state (SPEC 11): on = allowed for this trade; converted = past TP0, SL ratchets; p.tp = the safety TP
    const rn = p.runner && typeof p.runner === 'object' ? p.runner : null;
    const runnerOn = !!(rn && rn.on), converted = !!(rn && rn.converted);
    if (converted) progress = 'ผ่าน TP เดิมแล้ว วิ่งต่อในโหมด runner';
    // a converted runner is measured against its next target, not the broker safety TP (which it almost never reaches)
    const target = converted && Number.isFinite(Number(rn.target)) ? Number(rn.target) : null;
    const goalLeft = target !== null ? (target - price) * dir : tpLeft, goalDist = target !== null ? (target - p.open_price) * dir : tpDist;
    return h('article', { class: 'position' },
      h('div', { class: 'pos-summary' }, sideEl(p.side), modChip(p.module), h('span', { class: 'muted' }, h('span', { class: 'num' }, fmtNum(p.lots)), ' ล็อต'),
        p.locked || slLocked ? h('span', { class: 'chip live' }, icon('shield'), 'ล็อกกำไรแล้ว') : p.near_tp ? h('span', { class: 'chip warn' }, 'ใกล้ TP') : null,
        converted ? h('span', { class: 'chip live', title: 'ผ่าน TP แล้ว ปล่อยให้วิ่งต่อ SL กันกำไรขยับตาม' }, icon('zap'), 'runner วิ่งอยู่')
          : runnerOn ? h('span', { class: 'chip quiet-chip', title: 'ไม้นี้เปิดโหมด runner: เมื่อถึง TP จะไม่ปิด แต่ปล่อยให้วิ่งต่อ' }, 'runner') : null,
        h('span', { class: 'pos-pnl' }, money(pl, { signed: true, unit: c }))),
      converted ? h('p', { class: 'pos-runner' }, `runner: ขยับแล้ว ${Number(rn.k) || 0} ครั้ง, SL กันกำไร ${fmtNum(rn.sl_floor)}, เป้า ${fmtNum(rn.target)}`) : null,
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
          h('span', { class: 'pt-r' }, h('b', null, converted ? 'TP สำรอง' : 'TP'), h('span', { class: 'num' }, fmtNum(p.tp))))) : null,
      progress ? h('p', { class: 'pos-progress' }, progress) : null,
      openKey(p.module) ? h('a', { class: 'link-quiet pos-link', href: tradeHref(openKey(p.module)) }, 'ดูกราฟและเหตุผลที่เปิดไม้นี้', icon('chevron')) : null,
      full ? h('dl', { class: 'pos-facts' },
        fact('ราคาตอนนี้', h('span', { class: 'num' }, fmtNum(price)), ['เข้าที่ ', h('span', { class: 'num' }, fmtNum(p.open_price))]),
        fact('เปิดมาแล้ว', Number.isFinite(openedUtc) ? duration(Date.now() - openedUtc) : '—', `ตั้งแต่ ${opened}`),
        fact(target !== null ? 'ห่างจากเป้าถัดไป' : 'ห่างจาก TP', [h('span', { class: 'num' }, fmtNum(goalLeft)), h('span', { class: 'unit' }, ` $ (${pctOf(goalLeft)})`)],
          [target !== null ? 'ถึงเป้าถัดไปได้ราว ' : 'ถึง TP ได้ราว ', h('span', { class: 'num pos' }, fmtSigned(goalDist * contract))]),
        slLocked
          ? fact('SL ล็อกกำไรไว้', money(-slDist * contract, { signed: true, unit: c }), ['SL อยู่ที่ ', h('span', { class: 'num' }, fmtNum(p.sl))])
          : fact('ห่างจาก SL', [h('span', { class: 'num' }, fmtNum(slLeft)), h('span', { class: 'unit' }, ` $ (${pctOf(slLeft)})`)],
            ['โดน SL เสียราว ', h('span', { class: 'num neg' }, fmtSigned(-slDist * contract))]))
        : h('p', { class: 'muted small' }, `เปิดเมื่อ ${opened}`));
  }

  // the journal's OPEN row of the position that is still open (for the link to its trade page)
  function openKey(mod) {
    const t = pairTrades(rows).filter((x) => x.open && x.module === mod).pop();
    return t ? t.key : '';
  }

  // the last 6 closed trades (the full list is one click away), amounts right-aligned; each row opens its trade page
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
        return h('li', null, h(t.key ? 'a' : 'div', { class: 'trade', href: t.key ? tradeHref(t.key) : null },
          h('span', { class: `trade-ico ${buy ? 'buy' : 'sell'}`, 'aria-hidden': 'true' }, buy ? '▲' : '▼'),
          h('div', { class: 'trade-main' },
            h('p', null, modChip(t.module), ' ', h('span', { class: `side ${buy ? 'buy' : 'sell'}` }, buy ? 'ซื้อ' : 'ขาย'), ' ', h('span', { class: 'muted' }, h('span', { class: 'num' }, fmtNum(t.lots)), ' ล็อต')),
            h('p', { class: 'muted small' }, `${when} ${REASON_LABELS[t.reason] || t.reason || 'ปิดไม้'}`)),
          h('span', { class: 'trade-pnl' }, money(t.pnl, { signed: true, unit: c }))));
      })) : h('div', { class: 'pos-empty' }, h('span', { class: 'pos-empty-ico' }, icon('history')),
        h('p', { class: 'state-title' }, journalReady ? 'ยังไม่มีไม้ที่ปิดใน 30 วันนี้' : 'กำลังโหลด…')));
  }

  function srvToThaiClock(min) {
    const t = ((min - off() + 420) % 1440 + 1440) % 1440;
    return minutesToClock(t);
  }

  function drawDetails() {
    detailBox.hidden = !st;
    if (!st) { mount(detailBox); return; }
    if (!changed('details', [st.modules, st.ny, st.options, st.control, st.params && st.params.runner, st.last_event, st.last_error]) && detailBox.firstChild) return;
    const open = detailBox.querySelector('details') ? detailBox.querySelector('details').open : false;
    const ny = st.ny || {}, o = st.options || {}, c = st.control || {}, lock = o.lock || {}, lock1 = o.lock1 || {};
    const rn = st.params && st.params.runner && typeof st.params.runner === 'object' ? st.params.runner : null; // EA v3.05
    const runnerRow = rn ? ['โหมด runner', rn.enable
      ? `เปิด (${[rn.a && 'A_new', rn.ny && 'NY', rn.c5g && 'C5G'].filter(Boolean).join(', ') || 'ไม่มีสูตร'}) เก็บ ${fmtNum(rn.keep_pct, 0)}% ก้าว ${fmtNum(rn.step, 1)} ${rn.max_steps > 0 ? `สูงสุด ${rn.max_steps} ก้าว` : 'ไม่จำกัด'}`
      : 'ปิด'] : null;
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
          runnerRow,
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

  function drawAll() { drawHead(); drawHero(true); drawCap(); drawWarn(); drawFigs(); drawPositions(); drawRecent(true); drawDetails(); }
  drawAll();

  const redrawChart = debounce(() => drawChart(false), 120);
  const onStatus = (row) => { if (!row || !row.status) return; st = row.status; drawHero(); drawCap(); drawWarn(); drawFigs(); drawPositions(); drawDetails(); drawRisk(); redrawChart(); };
  const onControl = (row) => { ctl = row; drawHero(); drawCap(); };
  const onBot = (row) => {
    const barsBefore = JSON.stringify(bot.agent_state && bot.agent_state.bars && bot.agent_state.bars.t ? bot.agent_state.bars.t.slice(-1) : null);
    bot = { ...bot, ...row }; updateBotRow(bot); drawHero(); drawCap(); drawWarn();
    const barsNow = JSON.stringify(bot.agent_state && bot.agent_state.bars && bot.agent_state.bars.t ? bot.agent_state.bars.t.slice(-1) : null);
    if (barsBefore !== barsNow) redrawChart();
  };
  const addRow = debounce(() => { drawRecent(); drawChart(false); drawRisk(); drawPositions(true); if (rounds.length) drawFigs(); }, 500);

  // Fresh rows before any "offline" verdict. An online PC sends a status row every ~10 s and its bots row every
  // 30 s, so 20 s without a word means the page does not know: a phone froze it, or the realtime socket died while it
  // still says SUBSCRIBED, and the rows it missed are never replayed. Ask the database again instead of letting
  // last_seen age into "offline" (the old poll ran only while realtime was not joined).
  const STALE_MS = 20000;
  let lastSync = Date.now(), lastTry = 0, syncing = null;
  const heard = (fn) => (row) => { lastSync = Date.now(); fn(row); };
  function resync() {
    if (syncing) return syncing;
    lastTry = Date.now();
    syncing = (async () => {
      try {
        const [s, c, bots] = await Promise.all([ctx.api.botStatus(bot.id), ctx.api.botControl(bot.id), other ? ctx.api.adminBots() : ctx.api.listBots()]);
        const b = bots.find((x) => x.id === bot.id);
        if (b) onBot(b);
        if (c) onControl(c);
        if (s) onStatus(s);
        lastSync = Date.now();
      } catch { /* keep the last data; the next tick asks again */ }
      syncing = null;
      drawHero();
    })();
    return syncing;
  }
  const unsub = ctx.api.subscribeBot(bot.id, {
    status: heard(onStatus), control: heard(onControl), bot: heard(onBot),
    journal: heard((row) => { rows = prepareRows([...rows, row], off()); addRow(); }),
    // joined again after a drop: what changed while it was down is not replayed
    state: (s) => { const was = rtState; rtState = s; drawHead(); if (s === 'SUBSCRIBED' && was && was !== 'SUBSCRIBED') resync(); },
  });
  const offCtl = on('control-updated', (row) => { if (row && row.bot_id === bot.id) onControl(row); });
  const offTheme = on('theme', () => drawChart(false));
  const ages = setInterval(() => {
    if (document.hidden) return;
    if (Date.now() - lastSync > STALE_MS) {
      if (syncing) return; // keep the last picture until the answer is in
      if (Date.now() - lastTry > 15000) { resync(); return; }
    }
    drawHero(); drawCap(); // drawCap: the 15-min status age and the 3-min token timeout move with the clock
  }, 5000);
  const offWake = onWake(() => { if (Date.now() - lastSync > 5000) resync(); });
  return () => { unsub(); offCtl(); offTheme(); offWake(); clearInterval(ages); chart.destroy(); tvBox.destroy(); };
}
