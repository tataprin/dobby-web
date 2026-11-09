// Synthetic, deterministic demo data (no real account data). The owner's two bots with ~3 weeks of journal, a live status
// with an open position, invites, presets, news and audit rows; plus friends the owner (admin) sees read-only: นก (live,
// open trade), บีม (paused, offline for 3 h, a blackout, an agent rejection), มิ้นท์ (approved, no bot yet), พลอย (waiting
// for approval) and a disabled old account. Dates are relative to "now" so the demo always looks current;
// the pattern itself is fixed by the seeds below. "Today" is always treated as a trading day.
import { templateParams, remoteSubset, normalizeParams, RUNNER_KEYS, runnerSupported } from './params.js';
import { autoFromBalance } from './simple.js';
import { wallString, isoUtc } from './util.js';

export const DEMO_OFFSET_MIN = 120; // demo broker server = UTC+2
const DAY = 86400000, HOUR = 3600000, MIN = 60000;
const r2 = (x) => Math.round(x * 100) / 100;
const f2 = (x) => Number(x).toFixed(2);
const pad3 = (n) => String(n).padStart(3, '0');

export function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Smooth synthetic gold-like price path (server wall clock ms -> price).
function price(wall) {
  const t = wall / HOUR;
  return 3986 + 34 * Math.sin(t / 24.1) + 13 * Math.sin(t / 2.9 + 1.3) + 4.2 * Math.sin(t * 1.7 + 0.4) + 1.6 * Math.sin(t * 6.1);
}

const tsServer = (wall) => wallString(wall, '-', true).replace(' ', 'T');
const tsEa = (wall) => wallString(wall, '.', true);

const MODS = ['A_new', 'NY', 'C5G', 'ASIA16'];
const MAGIC = { A_new: 26102402, NY: 26102403, C5G: 26102404, ASIA16: 26102405 };

// ------------------------------------------------------------------ bot simulation
export class BotSim {
  constructor(cfg, nowUtc) {
    this.cfg = cfg;
    this.r = rng(cfg.seed);
    this.rows = [];
    this.nextId = cfg.idBase;
    this.pos = 9000000 + cfg.seed % 1000 * 1000;
    this.params = normalizeParams(cfg.params);
    this.vb = this.params.InpVirtualStart;
    this.stat = Object.fromEntries(MODS.map((m) => [m, { trades: 0, wins: 0, losses: 0, net: 0, day_stops: 0 }]));
    this.position = null;
    // EA v3.05 (SPEC 11): status schema 6, runner fields, the daily-cap reset command
    this.v6 = runnerSupported(cfg.ea);
    this.capReset = { seen: 0, applied: 0, today: 0 }; // last token seen / applied, resets today
    this.lastError = '';
    this.lastEvent = '';
    this.applied = { ...cfg.applied };
    this.remote = cfg.remote ? { version: cfg.applied.version, applied_version: cfg.applied.version, pending: false, waiting: '', rejects: '' } : null;
    this.generate(nowUtc);
  }

  add(wall, event, tag, side, lots, px, sl, tp, pnl, step, detail) {
    const row = {
      id: this.nextId++, bot_id: this.cfg.id, ts_server: tsServer(wall), event, tag, side, lots: lots ?? 0,
      price: px ?? null, sl: sl ?? null, tp: tp ?? null, pnl: pnl ?? 0, v_balance: r2(this.vb), step: step ?? 0, detail: detail || '',
      line_hash: `demo-${this.cfg.id}-${this.nextId}`,
    };
    this.rows.push(row);
    this.lastEvent = `${tsEa(wall)} ${tag} ${event} ${detail || ''}`.trim();
    if (event === 'ERROR') this.lastError = `${tsEa(wall)} ${tag} ERROR ${detail}`;
    return row;
  }

  lotsFor(step) {
    const base = this.params.InpLotsA;
    if (!step) return base;
    return Math.max(0.01, Math.floor(base * this.params.InpRecoveryMult * 100 + 1e-9) / 100);
  }

  desc(mod, side, px) {
    const r = this.r;
    const rsiA = (30 + r() * 20).toFixed(1), rsiB = (35 + r() * 20).toFixed(1);
    if (mod === 'A_new') {
      return side === 'BUY'
        ? `bull div: low ${f2(px - 2 - r() * 3)} rsi ${rsiB} vs earlier low ${f2(px - 3 - r() * 6)} rsi ${rsiA}`
        : `bear div: high ${f2(px + 2 + r() * 3)} rsi ${(100 - +rsiB).toFixed(1)} vs earlier high ${f2(px + 3 + r() * 6)} rsi ${(100 - +rsiA).toFixed(1)}`;
    }
    if (mod === 'NY') return `NY ${side === 'BUY' ? 'long' : 'short'} breakout: range ${f2(px - 6)}-${f2(px + 0.4)} buffer 0.20`;
    const v = f2(px + (side === 'BUY' ? -0.8 : 0.8));
    return `C5G ${side === 'BUY' ? 'long' : 'short'}: VWAP ${v} touched, close ${f2(px)}, RSI hook ${rsiA}->${rsiB}`;
  }

  // One complete trade; returns {closeWall, pnl}
  trade(mod, t, step, maxClose = Infinity) {
    const r = this.r, P = this.params;
    const lots = this.lotsFor(step);
    const sl = mod === 'A_new' ? 6 : mod === 'NY' ? r2(3 + r() * 5) : r2(4 + r() * 5.8);
    const tpd = r2(sl * (mod === 'NY' ? P.InpNY_TPRatio : mod === 'A_new' ? P.InpA_TPRatio : P.InpC5_TPRatio));
    const side = r() < 0.56 ? 'BUY' : 'SELL';
    const dir = side === 'BUY' ? 1 : -1;
    const entry = r2(price(t));
    const slP = r2(entry - dir * sl), tpP = r2(entry + dir * tpd);
    const u = r();
    // a strategy going through a bad patch (so ประวัติ shows one in "จับตา"): same random draws, fewer wins
    const weak = this.cfg.weak && this.cfg.weak.module === mod && t >= this.weakFrom;
    let outcome = weak ? (u < 0.27 ? 'TP' : u < 0.31 ? 'LOCK' : u < 0.34 ? 'LOCK1' : u < 0.40 ? 'TIME' : 'SL')
      : u < 0.39 ? 'TP' : u < 0.48 ? 'LOCK' : u < 0.53 ? 'LOCK1' : u < 0.57 ? 'TIME' : 'SL';
    if (outcome === 'LOCK1' && !P.InpLock1Enable) outcome = 'TP';
    if (outcome === 'LOCK' && !P.InpLockEnable) outcome = 'TP';
    let dur = (18 + r() * 230) * MIN;
    if (outcome === 'TIME') dur = 48 * 15 * MIN;
    if (mod === 'NY') dur = Math.min(dur, (23 * 60 * MIN) - (t % DAY) - 2 * MIN);
    dur = Math.max(12 * MIN, Math.min(dur, maxClose - t));
    const per = 100 * lots, cost = 0.22 * per;
    const lockTo = P.InpLockToPct / 100, lock1At = P.InpLock1AtPct / 100, lock1To = P.InpLock1ToPct / 100, lockAt = P.InpLockAtPct / 100;
    const move = outcome === 'TP' ? tpd : outcome === 'LOCK' ? lockTo * tpd : outcome === 'LOCK1' ? lock1To * tpd
      : outcome === 'TIME' ? (r() - 0.45) * sl : -sl;
    const pnl = r2(move * per - cost);
    const exit = r2(entry + dir * move);
    const atr = (sl * (0.8 + r() * 0.6)).toFixed(2), rsi = (35 + r() * 30).toFixed(1);
    if (mod === 'A_new') this.add(t, 'SIGNAL', mod, side, lots, entry, null, null, 0, step, `${side === 'BUY' ? 'bull' : 'bear'} divergence on the closed M15 bar`);
    this.add(t + 1000, 'OPEN', mod, side, lots, entry, slP, tpP, 0, step, `d=${f2(sl)} tp=${f2(tpd)} atr=${atr} rsi=${rsi} | ${this.desc(mod, side, entry)}`);
    const close = t + dur;
    const lockOn = P.InpLockEnable && P[`InpLock_${mod === 'C5G' ? 'C5G' : mod === 'NY' ? 'NY' : 'A'}`];
    if (outcome === 'LOCK1' || (outcome === 'LOCK' && r() < 0.4)) {
      const g = r2(tpd * lock1At + 0.05);
      const nsl = r2(entry + dir * tpd * lock1To);
      const a1 = Math.round(lock1At * 100), t1 = Math.round(lock1To * 100);
      this.add(close - 9 * MIN, 'NEAR1', mod, side, lots, r2(entry + dir * g), slP, tpP, 0, step, `gain ${f2(g)} = ${a1}% of TP ${f2(tpd)} (stage 1 ${P.InpLock1Enable ? 'ON' : 'shadow'})`);
      if (P.InpLock1Enable) this.add(close - 9 * MIN + 5000, 'LOCK1', mod, side, lots, r2(entry + dir * g), nsl, tpP, 0, step, `gain ${f2(g)} >= ${a1}% of TP ${f2(tpd)} -> SL ${f2(nsl)} locks about +${f2(tpd * lock1To * per)} (${t1}%)`);
      else this.add(close - 9 * MIN + 5000, 'SHADOWLOCK1', mod, side, lots, r2(entry + dir * g), slP, tpP, 0, step, `stage 1 would move SL to ${f2(nsl)} (off)`);
    }
    if (outcome === 'LOCK' || (outcome === 'TP' && r() < 0.5)) {
      const g = r2(tpd * lockAt + 0.02);
      const nsl = r2(entry + dir * tpd * lockTo);
      const a2 = Math.round(lockAt * 100), t2 = Math.round(lockTo * 100);
      this.add(close - 2 * MIN, 'NEARTP', mod, side, lots, r2(entry + dir * g), slP, tpP, 0, step, `gain ${f2(g)} = ${a2}% of TP ${f2(tpd)} (lock ${lockOn ? 'ON' : 'off'})`);
      if (lockOn) this.add(close - 2 * MIN + 1000, 'LOCK', mod, side, lots, r2(entry + dir * g), nsl, tpP, 0, step, `gain ${f2(g)} >= ${a2}% of TP ${f2(tpd)} -> SL ${f2(nsl)} locks about +${f2(tpd * lockTo * per)} (${t2}%)`);
      else this.add(close - 2 * MIN + 1000, 'SHADOWLOCK', mod, side, lots, r2(entry + dir * g), slP, tpP, 0, step, `lock would move SL to ${f2(nsl)} (off)`);
    }
    if (mod === 'C5G' && this.nextId % 23 === 0 && outcome !== 'SL') {
      this.add(close - 30 * MIN, 'ERROR', mod, side, lots, entry, slP, tpP, 0, step, 'lock modify failed: retcode 10016 invalid stops');
    }
    this.vb += pnl;
    const reason = outcome === 'LOCK1' ? 'LOCK' : outcome;
    const tail = mod === 'NY' && pnl > 0 ? ' NY win: no more NY trades today' : '';
    this.add(close, 'CLOSE', mod, side, lots, exit, null, null, pnl, step, `reason=${reason} pos=${this.pos++}${tail}`);
    const s = this.stat[mod];
    s.trades++; s.net = r2(s.net + pnl);
    if (pnl > 0) s.wins++; else s.losses++;
    return { closeWall: close, pnl };
  }

  generate(nowUtc) {
    const cfg = this.cfg, r = this.r, P = this.params;
    const nowWall = nowUtc + DEMO_OFFSET_MIN * MIN;
    const today = Math.floor(nowWall / DAY) * DAY;
    const first = today - 21 * DAY;
    this.today = today;
    this.weakFrom = cfg.weak ? today - cfg.weak.days * DAY : Infinity;
    const t0 = first + 9 * HOUR + 2 * MIN;
    this.add(t0, 'START', 'A_new', 'NONE', P.InpLotsA, null, null, null, 0, 0,
      `v${cfg.ea} A_new+NY+C5G lots ${f2(P.InpLotsA)} (max ${f2(P.InpMaxLots)}) virtual ${f2(this.vb)} | mode REAL`);
    this.add(t0, 'CONTROL', 'A_new', 'NONE', P.InpLotsA, null, null, null, 0, 0,
      `control file W001 -> mode=run lots=${f2(P.InpLotsA)} long=true short=true max_spread=${f2(P.InpMaxSpread)} blackouts=0`);
    const openAt = cfg.openPosition ? Math.floor((nowWall - 37 * MIN) / (15 * MIN)) * 15 * MIN : Infinity;
    const pauseFrom = cfg.pausedDays ? today - cfg.pausedDays * DAY + 14 * HOUR : Infinity;
    let pausedLogged = false;
    for (let day = first; day <= today; day += DAY) {
      const dow = new Date(day).getUTCDay();
      if ((dow === 0 || dow === 6) && day !== today) continue;
      const dayStart = this.vb;
      let dayPnl = 0, stopped = false, nyWon = false;
      const capAmt = (P.InpDailyCapPct / 100) * dayStart;
      const busy = {}, attempts = {};
      const queue = [];
      const at = (h0, h1) => day + Math.floor((h0 + r() * (h1 - h0)) * 4) * 15 * MIN;
      if (r() < 0.5) queue.push({ mod: 'A_new', t: at(1.5, 21), step: 0 });
      if (r() < 0.62) queue.push({ mod: 'NY', t: day + (16 * 60 + 45 + Math.floor(r() * 8) * 15) * MIN + Math.floor(r() * 500) * 1000, step: 0 });
      if (r() < 0.6) queue.push({ mod: 'C5G', t: at(8, 19), step: 0 });
      if (r() < 0.3) queue.push({ mod: 'C5G', t: at(8, 19), step: 0 });
      if (day === today && nowWall - day > 4 * HOUR && !queue.some((q) => q.mod === 'A_new' && q.t < nowWall - 2 * HOUR)) {
        queue.push({ mod: 'A_new', t: day + 2 * HOUR + 15 * MIN, step: 0 });
      }
      const skipAt = at(9, 18);
      if (r() < 0.15 && skipAt < nowWall) this.add(skipAt, 'SKIP', 'C5G', 'NONE', P.InpLotsC5G, null, null, null, 0, 0, `SL distance ${f2(10.2 + r() * 3)} > cap ${f2(P.InpC5_Cap)}`);
      const pxNy = price(day + 16.5 * HOUR);
      if (day + 16.75 * HOUR < Math.min(nowWall, pauseFrom)) {
        this.add(day + 16 * HOUR + 45 * MIN, 'ARM', 'NY', 'NONE', P.InpLotsNY, null, null, null, 0, 0,
          `range ${f2(pxNy + 2.1)}-${f2(pxNy - 3.4)} d=${f2(Math.min(P.InpNY_Cap, 5.5))} buy stop ${f2(pxNy + 2.3)} sell stop ${f2(pxNy - 3.6)}`);
      }
      if (!pausedLogged && pauseFrom >= day && pauseFrom < day + DAY) {
        pausedLogged = true;
        this.add(pauseFrom, 'CONTROL', 'A_new', 'NONE', P.InpLotsA, null, null, null, 0, 0,
          `control file W${pad3(cfg.applied.version)} -> mode=pause lots=${f2(P.InpLotsA)} long=true short=true max_spread=${f2(P.InpMaxSpread)} blackouts=0 (web: live off)`);
      }
      let nyTraded = false;
      while (queue.length && !stopped) {
        queue.sort((a, b) => a.t - b.t);
        const q = queue.shift();
        if (busy[q.mod] && q.t < busy[q.mod]) q.t = busy[q.mod] + (15 + Math.floor(r() * 4) * 15) * MIN;
        if (q.t % DAY > 22 * HOUR) continue;
        if (q.mod === 'NY' && (nyWon || q.t % DAY > 21 * HOUR)) continue;
        if (q.t >= pauseFrom) continue;
        let maxClose = Infinity;
        if (day === today || q.t > today - DAY) {
          maxClose = (q.mod === 'C5G' && cfg.openPosition) ? openAt - 5 * MIN : nowWall - 10 * MIN;
          if (q.t + 20 * MIN > maxClose) continue;
        }
        attempts[q.mod] = (attempts[q.mod] || 0) + 1;
        const res = this.trade(q.mod, q.t, q.step, maxClose);
        if (q.mod === 'NY') nyTraded = true;
        busy[q.mod] = res.closeWall;
        dayPnl += res.pnl;
        if (q.mod === 'NY' && res.pnl > 0) nyWon = true;
        if (res.pnl < 0 && attempts[q.mod] < P.InpMaxAttempts && r() < 0.55) {
          queue.push({ mod: q.mod, t: res.closeWall + (15 + Math.floor(r() * 6) * 15) * MIN, step: q.step + 1 });
        }
        if (dayPnl <= -capAmt) {
          stopped = true;
          this.stat[q.mod].day_stops++;
          this.add(res.closeWall + 1000, 'DAYCAP', q.mod, 'NONE', 0, null, null, null, 0, 0,
            `day P&L ${f2(dayPnl)} <= -${f2(P.InpDailyCapPct)}% of the day start ${f2(dayStart)}: no new entries today`);
        }
      }
      if (!nyTraded && day < today && day + 21 * HOUR < pauseFrom) {
        this.add(day + 21 * HOUR, 'CANCEL', 'NY', 'NONE', P.InpLotsNY, null, null, null, 0, 0, 'NY pending stop orders removed at 21:00 (no breakout)');
      }
      if (day === today) { this.dayStart = dayStart; this.dayPnl = dayPnl; this.capHit = stopped; }
    }
    if (cfg.openPosition) {
      const sl = 6.4, tpd = r2(sl * P.InpC5_TPRatio);
      const lots = P.InpLotsC5G;
      // cfg.runnerPos (EA v3.05 demo): the trade passed TP0 and the runner ratcheted k times; the bid sits between the
      // k-th and the next target, the SL is the ratcheted floor, the broker TP is the safety TP (SPEC 11 §2)
      const run = this.v6 && cfg.runnerPos && P.InpRunnerEnable && P.InpRunner_C5G ? { k: cfg.runnerPos.k ?? 1 } : null;
      const stepD = r2(P.InpRunnerStep * sl);
      const above = run ? r2(tpd + run.k * stepD + 0.4 * stepD) : -2.6; // bid - entry
      const entry = r2(price(nowWall) - above);
      this.position = {
        module: 'C5G', ticket: this.pos++, side: 'BUY', lots, open_price: entry, sl: r2(entry - sl), tp: r2(entry + tpd),
        open_wall: openAt, tpd, sld: sl, anchor: above,
      };
      this.add(openAt + 1000, 'OPEN', 'C5G', 'BUY', lots, entry, this.position.sl, this.position.tp, 0, 0,
        `d=${f2(sl)} tp=${f2(tpd)} atr=${f2(sl)} rsi=47.9 | ${this.desc('C5G', 'BUY', entry)}`);
      if (run) {
        const p = this.position, per = 100 * lots;
        const tp0 = r2(entry + tpd);
        const lockOn = P.InpLockEnable && P.InpLock_C5G;
        let slNow = p.sl;
        if (P.InpLock1Enable && P.InpLock1AtPct > 0) {
          slNow = r2(entry + tpd * P.InpLock1ToPct / 100);
          this.add(openAt + 9 * MIN, 'LOCK1', 'C5G', 'BUY', lots, r2(entry + tpd * P.InpLock1AtPct / 100 + 0.03), slNow, p.tp, 0, 0,
            `gain ${f2(tpd * P.InpLock1AtPct / 100 + 0.03)} >= ${Math.round(P.InpLock1AtPct)}% of TP ${f2(tpd)} -> SL ${f2(slNow)} locks about +${f2(tpd * P.InpLock1ToPct / 100 * per)} (${Math.round(P.InpLock1ToPct)}%)`);
        }
        if (lockOn) {
          slNow = r2(entry + tpd * P.InpLockToPct / 100);
          this.add(openAt + 16 * MIN, 'LOCK', 'C5G', 'BUY', lots, r2(entry + tpd * P.InpLockAtPct / 100 + 0.02), slNow, p.tp, 0, 0,
            `gain ${f2(tpd * P.InpLockAtPct / 100 + 0.02)} >= ${Math.round(P.InpLockAtPct)}% of TP ${f2(tpd)} -> SL ${f2(slNow)} locks about +${f2(tpd * P.InpLockToPct / 100 * per)} (${Math.round(P.InpLockToPct)}%)`);
        }
        // touch: SL_conv = max(SL in force, E + KeepPct % of tpd); target T1 = TP0 + step; the broker TP is the safety
        // TP = next target + SafetyTP x d, moved up with every ratchet (a disconnect safeguard, normally never hit)
        const slConv = r2(Math.max(slNow, entry + tpd * P.InpRunnerKeepPct / 100));
        const safety = (target) => (P.InpRunnerSafetyTP > 0 ? r2(target + P.InpRunnerSafetyTP * sl) : 0);
        let target = r2(tp0 + stepD), slRun = slConv;
        p.tp = safety(target);
        this.add(openAt + 20 * MIN, 'RUN_ON', 'C5G', 'BUY', lots, tp0, slConv, p.tp, 0, 0, `price ${f2(tp0)} sl ${f2(slConv)} target ${f2(target)} (keep ${f2(P.InpRunnerKeepPct)}% step ${f2(P.InpRunnerStep)}d)`);
        for (let k = 1; k <= run.k; k++) {
          slRun = r2(Math.max(slRun, slConv + k * stepD));
          const hit = target;
          target = r2(tp0 + (k + 1) * stepD);
          p.tp = safety(target);
          this.add(openAt + (20 + 8 * k) * MIN, 'RUN_UP', 'C5G', 'BUY', lots, hit, slRun, p.tp, 0, 0, `k=${k} sl ${f2(slRun)} target ${f2(target)}`);
        }
        p.sl = slRun;
        p.runner = { converted: true, k: run.k, sl_floor: slRun, target };
      }
    }
    this.bid = r2(price(nowWall));
    // keep rows in time order with ids that follow it (like bigserial inserts)
    this.rows.sort((a, b) => a.ts_server.localeCompare(b.ts_server) || a.id - b.id);
    this.rows.forEach((row, i) => { row.id = cfg.idBase + i; row.line_hash = `demo-${cfg.id}-${i}`; });
    this.nextId = cfg.idBase + this.rows.length;
  }

  // SPEC 8: the last 96 closed M15 bars as bots.agent_state.bars = {tf, t: [bar open, UTC s], c: [close], vwap: [...]}.
  // Closes follow the same price path as the demo trades (so the trade marks sit on the line) plus a small
  // deterministic jitter that does not touch the simulation's random sequence. VWAP is anchored to each server day.
  bars(nowUtc) {
    const rows = this.barsBetween(nowUtc - 96 * 15 * MIN - 15 * MIN, nowUtc, nowUtc).slice(-96);
    return { tf: 'M15', t: rows.map((b) => Math.floor(Date.parse(b.t) / 1000)), c: rows.map((b) => b.close), vwap: rows.map((b) => b.vwap) };
  }

  // SPEC 9.1: rows of the `bars` table {t: bar open (UTC ISO), close, vwap} for closed M15 bars in [fromUtc, toUtc].
  // VWAP is accumulated from the start of each server day, so any window gives the same values.
  // anchors (optional, demo only): [{w: server wall ms, p: price}] of one trade (entry, lock triggers, exit) that the
  // closes are bent towards, so a trade page chart shows the price actually reaching that trade's levels.
  barsBetween(fromUtc, toUtc, nowUtc = Date.now(), anchors = null) {
    const tf = 15 * MIN, off = DEMO_OFFSET_MIN * MIN;
    const A = anchors && anchors.length ? anchors.map((a) => ({ w: a.w, d: a.p - price(a.w) })) : null;
    const bend = (w) => {
      if (!A) return 0;
      if (w <= A[0].w) return A[0].d * Math.max(0, 1 - (A[0].w - w) / (90 * MIN));
      const last = A[A.length - 1];
      if (w >= last.w) return last.d * Math.max(0, 1 - (w - last.w) / (45 * MIN));
      for (let i = 1; i < A.length; i++) if (w <= A[i].w) { const f = (w - A[i - 1].w) / (A[i].w - A[i - 1].w || 1); return A[i - 1].d + (A[i].d - A[i - 1].d) * f; }
      return 0;
    };
    const lastOpen = Math.floor((nowUtc + off) / tf) * tf - tf; // the newest closed bar
    const a = Math.floor((fromUtc + off) / tf) * tf, b = Math.min(lastOpen, Math.floor((toUtc + off) / tf) * tf);
    if (!(b >= a)) return [];
    const jitter = (k) => { const r = rng((this.cfg.seed % 997) * 7919 + k); return (r() - 0.5) * 1.1 + (r() - 0.5) * 0.7; };
    const out = [];
    let day = null, pv = 0, vol = 0;
    for (let open = Math.floor(a / DAY) * DAY; open <= b; open += tf) {
      const k = Math.floor(open / tf);
      const close = r2(price(open + tf) + jitter(k) + bend(open + tf));
      const d = Math.floor(open / DAY);
      if (d !== day) { day = d; pv = 0; vol = 0; }
      const v = 1 + rng(k * 31 + 7)() * 2.5;
      pv += close * v; vol += v;
      if (open >= a) out.push({ t: new Date(open - off).toISOString(), close, vwap: r2(pv / vol) });
    }
    return out;
  }

  // the price anchors of the trade opened at openUtc (OPEN, NEAR / LOCK triggers, CLOSE), for barsBetween
  anchorsFor(openUtc) {
    const w0 = openUtc + DEMO_OFFSET_MIN * MIN;
    const i = this.rows.findIndex((r) => r.event === 'OPEN' && Math.abs(Date.parse(r.ts_server + 'Z') - w0) < 90000);
    if (i < 0) return null;
    const tag = this.rows[i].tag, out = [];
    for (let j = i; j < this.rows.length; j++) {
      const r = this.rows[j];
      if (r.tag !== tag || !(r.price > 0)) continue;
      if (j > i && r.event === 'OPEN') break;
      if (['OPEN', 'NEAR1', 'NEARTP', 'LOCK1', 'LOCK', 'RUN_ON', 'RUN_UP', 'CLOSE'].includes(r.event)) out.push({ w: Date.parse(r.ts_server + 'Z'), p: r.price });
      if (r.event === 'CLOSE') break;
    }
    return out;
  }

  tick(nowUtc) {
    const nowWall = nowUtc + DEMO_OFFSET_MIN * MIN;
    const anchor = this.position ? this.position.open_price + (this.position.anchor ?? 2.6) : price(nowWall);
    this.bid = r2(this.bid + (anchor - this.bid) * 0.08 + (this.r() - 0.5) * 0.7);
  }

  // runner flags of a position JSON (EA v3.05, SPEC 11 §4): on = the runner was allowed for this trade at its open
  runnerJson(mod, p) {
    if (!this.v6) return undefined;
    const P = this.params;
    if (p && p.runner) return { on: true, converted: true, k: p.runner.k, sl_floor: p.runner.sl_floor, target: p.runner.target };
    const key = mod === 'A_new' ? 'InpRunner_A' : mod === 'NY' ? 'InpRunner_NY' : mod === 'C5G' ? 'InpRunner_C5G' : null;
    return { on: !!(p && key && P.InpRunnerEnable && P[key]), converted: false, k: 0, sl_floor: null, target: null };
  }

  // EA v3.05 (SPEC 11 §3): the cap_reset token of the remote file, evaluated as soon as the file is read (never "when
  // flat"). Applied when newer than the last token seen, the cap is hit and the token's server day is today; otherwise
  // journaled as IGNORED and remembered anyway. Returns the journal row.
  capResetCmd(token, nowUtc) {
    const t = Math.floor(Number(token));
    if (!Number.isFinite(t) || t <= this.capReset.seen) return null;
    this.capReset.seen = t;
    const wall = nowUtc + DEMO_OFFSET_MIN * MIN;
    const sameDay = Math.floor((t * 1000 + DEMO_OFFSET_MIN * MIN) / DAY) === Math.floor(wall / DAY);
    let detail;
    if (!this.capHit) detail = `IGNORED: daily cap not hit (token ${t})`;
    else if (!sameDay) detail = `IGNORED: token from another server day (token ${t})`;
    else {
      const pnl0 = this.dayPnl || 0, start0 = this.dayStart ?? this.vb;
      this.dayStart = this.vb; this.dayPnl = 0; this.capHit = false;
      this.capReset.applied = t; this.capReset.today += 1;
      detail = `day P&L ${f2(pnl0)} -> 0.00, day start ${f2(start0)} -> ${f2(this.vb)}, token ${t}`;
    }
    return this.add(wall, 'DAYCAP_RESET', 'A_new', 'NONE', 0, null, null, null, 0, 0, detail);
  }

  // Demo only: one losing A_new recovery trade, closed a minute ago, that takes today over the daily cap, so the
  // ภาพรวม banner and "รีเซ็ตจุดหยุดรายวัน" can be tried. Returns the journal rows added.
  forceCapHit(nowUtc) {
    if (this.capHit) return [];
    const P = this.params, wall = nowUtc + DEMO_OFFSET_MIN * MIN;
    const dayStart = this.dayStart ?? this.vb;
    const capAmt = (P.InpDailyCapPct / 100) * dayStart;
    const need = Math.max(3, capAmt + (this.dayPnl || 0) + 0.5 + this.r() * 3); // the loss still missing to the cap
    const lots = this.lotsFor(1), per = 100 * lots, cost = 0.22 * per;
    const move = r2(Math.max(2, (need - cost) / per));
    const entry = r2(price(wall - 26 * MIN) + 1.1);
    const slP = r2(entry + move), tpP = r2(entry - move * P.InpA_TPRatio);
    const pnl = r2(-(move * per + cost));
    const rows = [];
    rows.push(this.add(wall - 26 * MIN, 'OPEN', 'A_new', 'SELL', lots, entry, slP, tpP, 0, 1,
      `d=${f2(move)} tp=${f2(move * P.InpA_TPRatio)} atr=${f2(move * 0.8)} rsi=63.2 | ${this.desc('A_new', 'SELL', entry)}`));
    this.vb = r2(this.vb + pnl);
    this.dayPnl = r2((this.dayPnl || 0) + pnl);
    const s = this.stat.A_new;
    s.trades++; s.losses++; s.net = r2(s.net + pnl); s.day_stops++;
    rows.push(this.add(wall - MIN, 'CLOSE', 'A_new', 'SELL', lots, slP, null, null, pnl, 1, `reason=SL pos=${this.pos++}`));
    this.capHit = true;
    rows.push(this.add(wall - MIN + 1000, 'DAYCAP', 'A_new', 'NONE', 0, null, null, null, 0, 0,
      `day P&L ${f2(this.dayPnl)} <= -${f2(P.InpDailyCapPct)}% of the day start ${f2(dayStart)}: no new entries today`));
    return rows;
  }

  openProfit() {
    const p = this.position;
    if (!p) return 0;
    const dir = p.side === 'BUY' ? 1 : -1;
    const px = p.side === 'BUY' ? this.bid : this.bid + this.spread();
    return r2((px - p.open_price) * dir * 100 * p.lots);
  }

  spread() { return this.cfg.spread ?? 0.21; }

  closePosition(nowUtc, reason = 'TIME') {
    const p = this.position;
    if (!p) return null;
    const pnl = r2(this.openProfit() - 0.22 * 100 * p.lots * 0.3);
    this.vb += pnl;
    this.dayPnl = (this.dayPnl || 0) + pnl;
    const s = this.stat[p.module];
    s.trades++; s.net = r2(s.net + pnl); if (pnl > 0) s.wins++; else s.losses++;
    // a runner past its TP closes with reason RUN (SPEC 11 §2), whatever closed it in the demo
    const row = this.add(nowUtc + DEMO_OFFSET_MIN * MIN, 'CLOSE', p.module, p.side, p.lots, this.bid, null, null, pnl, 0, `reason=${p.runner ? 'RUN' : reason} pos=${p.ticket}`);
    this.position = null;
    return row;
  }

  posJson(mod, nowUtc) {
    const p = this.position;
    if (!p || p.module !== mod) return { open: false, module: mod, runner: this.runnerJson(mod, null) };
    const dir = p.side === 'BUY' ? 1 : -1;
    const gain = (this.bid - p.open_price) * dir;
    const near = gain >= 0.95 * p.tpd;
    return {
      open: true, module: mod, ticket: p.ticket, side: p.side, lots: p.lots, open_price: p.open_price, sl: p.sl, tp: p.tp,
      profit: this.openProfit(), swap: 0, open_time: tsEa(p.open_wall), bars_held: Math.floor((nowUtc + DEMO_OFFSET_MIN * MIN - p.open_wall) / (15 * MIN)),
      comment: `D3 ${mod} d${f2(p.sld)} t${f2(p.tpd)}`, near_tp: near, locked: (near && this.params.InpLockEnable) || !!p.runner,
      runner: this.runnerJson(mod, p),
    };
  }

  status(nowUtc) {
    const P = this.params, a = this.applied, cfg = this.cfg;
    const nowWall = nowUtc + DEMO_OFFSET_MIN * MIN;
    const mins = Math.floor((nowWall % DAY) / MIN);
    const tr = MODS.reduce((s, m) => s + this.stat[m].trades, 0);
    const wi = MODS.reduce((s, m) => s + this.stat[m].wins, 0);
    const lo = MODS.reduce((s, m) => s + this.stat[m].losses, 0);
    const ds = MODS.reduce((s, m) => s + this.stat[m].day_stops, 0);
    const lotsFor = (m) => Math.min(m === 'NY' ? P.InpLotsNY : m === 'C5G' ? P.InpLotsC5G : m === 'ASIA16' ? P.InpLotsAsia : P.InpLotsA,
      m === 'ASIA16' ? 99 : P.InpMaxLots, a.lots ?? 99);
    const use = { A_new: P.InpUseA, NY: P.InpUseNY, C5G: P.InpUseC5G, ASIA16: P.InpUseAsia };
    const positions = MODS.map((m) => this.posJson(m, nowUtc));
    const firstOpen = positions.find((p) => p.open) || { open: false };
    const pxNy = r2(price(this.today + 16.5 * HOUR));
    const nyState = mins < 990 ? 'waiting for the 16:30 range bar'
      : mins < 1245 ? `armed: buy stop ${f2(pxNy + 2.3)} / sell stop ${f2(pxNy - 3.6)}` : 'none: outside order window';
    const balance = r2(this.vb + (cfg.accountExtra || 0));
    const profit = this.openProfit();
    const v6 = this.v6; // EA v3.05: schema 6 (SPEC 11 §4)
    const st = {
      schema_version: cfg.remote ? (v6 ? 6 : 5) : 4, ea: 'Dobby3', ea_version: cfg.ea, tag: P.InpUseAsia ? 'A_new+NY+C5G+ASIA16' : 'A_new+NY+C5G',
      magic: P.InpMagicA, symbol: 'XAUUSD', server_time: tsEa(nowWall), heartbeat_gmt_unix: Math.floor(nowUtc / 1000),
      account: { mode: 'REAL', currency: 'USD', balance, equity: r2(balance + profit), connected: true, trade_permitted: true },
      virtual: {
        start_date: tsEa(this.today - 21 * DAY + 9 * HOUR), start: P.InpVirtualStart, balance: r2(this.vb), day: wallString(this.today, '.').slice(0, 10),
        day_start: r2(this.dayStart ?? this.vb), day_pnl: r2(this.dayPnl || 0), step: 0, day_stopped: !!this.capHit,
        day_cap_hit: !!this.capHit, kill_balance: P.InpKillBalance, killed: false, trades: tr, wins: wi, losses: lo, day_stops: ds,
        ...(v6 ? { cap_reset_applied: this.capReset.applied, cap_resets_today: this.capReset.today } : {}),
      },
      modules: MODS.map((m) => ({
        module: m, enabled: !!use[m], magic: MAGIC[m], lots: lotsFor(m), step: 0, day_stopped: !!this.capHit,
        won_today: this.rows.some((x) => x.event === 'CLOSE' && x.tag === m && x.pnl > 0 && x.ts_server.startsWith(wallString(this.today, '-').slice(0, 10))),
        ...this.stat[m],
      })),
      positions, position: firstOpen,
      ny: { armed_day: wallString(this.today, '.').slice(0, 10), range_high: r2(pxNy + 2.1), range_low: r2(pxNy - 3.4), sl_dist: 5.5, state: nyState },
      options: {
        vol_gate: { enabled: P.InpVolGate, pct: P.InpVolGatePct, value: 1.92, open: true },
        max_attempts: P.InpMaxAttempts, confluence_mult: P.InpConfluenceMult, confluence_min: P.InpConfluenceMin,
        asia: { enabled: P.InpUseAsia, lots: P.InpLotsAsia, magic: P.InpMagicAsia, done_today: false, sl_dist: 0, state: '' },
        lock: { enabled: P.InpLockEnable, at_pct: P.InpLockAtPct, to_pct: P.InpLockToPct, modules: `A=${P.InpLock_A} NY=${P.InpLock_NY} C5G=${P.InpLock_C5G}`, shadow: P.InpLockShadow },
        lock1: { enabled: P.InpLock1Enable, at_pct: P.InpLock1AtPct, to_pct: P.InpLock1ToPct },
      },
      market: { bid: this.bid, ask: r2(this.bid + this.spread()), spread: this.spread() },
      last_bar: {
        bar_time: tsEa(Math.floor(nowWall / (15 * MIN)) * 15 * MIN - 15 * MIN), rsi: 51.3, atr: 6.12, sl_dist: 6, h4_close: r2(price(nowWall - HOUR)),
        h4_ema: r2(price(nowWall - 9 * HOUR)), trend: 1, bull: false, bear: false, signal: 0, vwap: r2(this.bid - 1.4), c5_signal: 0, note: '',
      },
      control: {
        file_exists: true, mode: a.live && a.mode === 'run' ? 'run' : 'pause', lots: lotsFor('A_new'), allow_long: a.allow_long, allow_short: a.allow_short,
        max_spread: a.max_spread ?? P.InpMaxSpread, blackouts: (a.blackouts || []).map((b) => [b[0], b[1]]), id: `W${pad3(a.version)}`,
        note: a.note || '', warn: '', applied_at: a.applied_at || tsEa(nowWall - 2 * HOUR),
      },
      flags: { live_locked: false, allow_live_input: true },
      params: {
        sl_cap: P.InpA_SLCap, tp_ratio: P.InpA_TPRatio, lots_input: P.InpLotsA, lots_ny: P.InpLotsNY, lots_c5g: P.InpLotsC5G, max_lots: P.InpMaxLots,
        recovery_mult: P.InpRecoveryMult, daily_cap_pct: P.InpDailyCapPct, max_spread_input: P.InpMaxSpread, modules: 'A_new+NY+C5G',
        ...(v6 ? { runner: { enable: P.InpRunnerEnable, a: P.InpRunner_A, ny: P.InpRunner_NY, c5g: P.InpRunner_C5G,
          keep_pct: P.InpRunnerKeepPct, step: P.InpRunnerStep, max_steps: P.InpRunnerMaxSteps, safety_tp: P.InpRunnerSafetyTP } } : {}),
      },
      last_event: this.lastEvent, last_error: this.lastError,
    };
    if (this.remote) {
      // an EA below 3.05 does not know the runner keys, so its effective set has none of them
      const effective = remoteSubset(P);
      if (!v6) for (const k of RUNNER_KEYS) delete effective[k];
      st.remote = {
        params_enabled: P.InpRemoteParams, live_enabled: P.InpRemoteLive, file_exists: true, version: this.remote.version,
        applied_version: this.remote.applied_version, pending: this.remote.pending, waiting: this.remote.waiting, live: a.live,
        rejects: this.remote.rejects, ceilings: { max_lots: P.InpRemoteMaxLots, max_cap_pct: P.InpRemoteMaxCapPct },
        effective,
      };
    }
    return st;
  }
}

// ------------------------------------------------------------------ whole demo database
export const DEMO_USER = { id: 'demo-owner', email: 'owner@example.com' };

function nextNews(nowUtc) {
  const out = [];
  const add = (ms, name, tier, note) => out.push({ ts_utc: isoUtc(ms), name, tier, note: note || null });
  const startDay = Math.floor(nowUtc / DAY) * DAY;
  for (let i = -1; i < 35; i++) {
    const d = startDay + i * DAY;
    const dt = new Date(d);
    const dow = dt.getUTCDay(), date = dt.getUTCDate();
    if (dow === 5 && date <= 7) add(d + 13.5 * HOUR, 'US NFP (Non-Farm Payrolls)', 1, 'ตัวอย่าง: ตัวเลขจ้างงานนอกภาคเกษตร');
    if (dow === 3 && date >= 10 && date <= 16) add(d + 13.5 * HOUR, 'US CPI', 1, 'ตัวอย่าง: เงินเฟ้อผู้บริโภค');
    if (dow === 3 && date >= 17 && date <= 23) { add(d + 19 * HOUR, 'FOMC rate decision', 1, 'ตัวอย่าง: ประชุมกำหนดดอกเบี้ย'); add(d + 19.5 * HOUR, 'FOMC press conference', 1, 'ตัวอย่าง'); }
  }
  // always something soon
  add(Math.ceil((nowUtc + 5 * HOUR) / (30 * MIN)) * 30 * MIN, 'Fed Chair speech', 2, 'ตัวอย่าง: ข่าวที่ผู้ดูแลเพิ่มเอง');
  const seen = new Set();
  return out.filter((n) => { const k = n.ts_utc + n.name; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.ts_utc.localeCompare(b.ts_utc)).map((n, i) => ({ id: i + 1, ...n }));
}

// SPEC 9.3: what agent 1.2.0 reports from the Forex Factory week calendar (USD, High) next to the admin's news_events
// (the same moments under the calendar's own titles, plus two events the admin did not add), and the automatic
// windows it builds for the next 7 days: news [t - before, t + after], the weekly schedule (Thai time) and NYSE holidays.
const FF_TITLES = {
  'US CPI': [['CPI m/m', '0.3%', '0.2%'], ['Core CPI m/m', '0.3%', '0.3%']],
  'US NFP (Non-Farm Payrolls)': [['Non-Farm Employment Change', '115K', '22K'], ['Unemployment Rate', '4.3%', '4.3%']],
  'FOMC rate decision': [['Federal Funds Rate', '3.75%', '4.00%'], ['FOMC Statement', '', '']],
  'FOMC press conference': [['FOMC Press Conference', '', '']],
  'Fed Chair speech': [['Fed Chair Powell Speaks', '', '']],
};
const NYSE_HOLIDAYS = [['2026-11-26', 'Thanksgiving Day'], ['2026-12-25', 'Christmas Day'], ['2027-01-01', "New Year's Day"],
  ['2027-01-18', 'Martin Luther King Jr. Day'], ['2027-02-15', "Washington's Birthday"], ['2027-03-26', 'Good Friday'],
  ['2027-05-31', 'Memorial Day'], ['2027-06-18', 'Juneteenth'], ['2027-07-05', 'Independence Day'], ['2027-09-06', 'Labor Day'],
  ['2027-11-25', 'Thanksgiving Day'], ['2027-12-24', 'Christmas Day']];

function agentNews(nowUtc, news) {
  const out = [];
  for (const n of news) {
    const t = Date.parse(n.ts_utc);
    if (t < nowUtc - DAY || t > nowUtc + 6 * DAY) continue;
    for (const [title, forecast, previous] of FF_TITLES[n.name] || []) out.push({ title, ts_utc: isoUtc(t), currency: 'USD', impact: 'High', forecast, previous });
  }
  // two events only the calendar has: weekly jobless claims (Thursday 12:30 UTC) and ISM services (the next weekday 14:00 UTC)
  for (let i = 0; i < 7; i++) {
    const d = Math.floor(nowUtc / DAY) * DAY + i * DAY, dow = new Date(d).getUTCDay();
    if (dow === 4) out.push({ title: 'Unemployment Claims', ts_utc: isoUtc(d + 12.5 * HOUR), currency: 'USD', impact: 'High', forecast: '226K', previous: '219K' });
  }
  let ism = Math.floor(nowUtc / DAY) * DAY + DAY;
  while ([0, 6].includes(new Date(ism).getUTCDay())) ism += DAY;
  out.push({ title: 'ISM Services PMI', ts_utc: isoUtc(ism + 14 * HOUR), currency: 'USD', impact: 'High', forecast: '50.8', previous: '50.0' });
  return out.sort((a, b) => a.ts_utc.localeCompare(b.ts_utc));
}

function autoWindows(nowUtc, events, autoNews, schedule) {
  const w = [];
  if (autoNews && autoNews.enabled) {
    for (const e of events) {
      const t = Date.parse(e.ts_utc);
      w.push({ from: t - autoNews.before_min * MIN, to: t + autoNews.after_min * MIN, reason: e.title, kind: 'news' });
    }
  }
  if (schedule && schedule.enabled) {
    const thai = 7 * HOUR;
    for (let i = -1; i < 8; i++) {
      const d = Math.floor((nowUtc + thai) / DAY) * DAY + i * DAY; // Thai midnight (as a wall clock)
      const dow = ((new Date(d).getUTCDay() + 6) % 7) + 1;
      for (const x of schedule.weekly || []) {
        if (x.dow !== dow) continue;
        const [fh, fm] = x.from.split(':').map(Number), [th, tm] = x.to.split(':').map(Number);
        w.push({ from: d - thai + (fh * 60 + fm) * MIN, to: d - thai + (th * 60 + tm) * MIN, reason: 'ตารางเวลา', kind: 'schedule' });
      }
    }
    if (schedule.us_holidays) {
      for (const [day, name] of NYSE_HOLIDAYS) {
        const ny = Date.parse(`${day}T05:00:00Z`); // 00:00 New York (EST)
        w.push({ from: ny, to: ny + DAY, reason: name, kind: 'holiday' });
      }
    }
  }
  const keep = w.filter((x) => x.to > nowUtc && x.from < nowUtc + 7 * DAY).sort((a, b) => a.from - b.from);
  const merged = [];
  for (const x of keep) {
    const last = merged[merged.length - 1];
    if (last && x.from <= last.to) {
      last.to = Math.max(last.to, x.to);
      if (!last.reason.split(', ').includes(x.reason)) last.reason += `, ${x.reason}`;
      if (!last.kinds.includes(x.kind)) last.kinds.push(x.kind);
    } else merged.push({ ...x, kinds: [x.kind] });
  }
  return merged.map((x) => ({ from_utc: isoUtc(x.from), to_utc: isoUtc(x.to), reason: x.reason, kinds: x.kinds }));
}

// [{open, close}] journal rows of every closed trade, in time order
function closedTrades(sim) {
  const open = {}, out = [];
  for (const r of sim.rows) {
    if (r.event === 'OPEN') open[r.tag] = r;
    else if (r.event === 'CLOSE' && open[r.tag]) { out.push({ open: open[r.tag], close: r }); open[r.tag] = null; }
  }
  return out;
}
const keyOf = (row) => `${row.tag}|${row.ts_server.replace('T', ' ').slice(0, 19)}`;
// virtual balance just before a moment (UTC ms)
function vbAt(sim, utc) {
  const s = tsServer(utc + DEMO_OFFSET_MIN * MIN);
  let v = sim.params.InpVirtualStart;
  for (const r of sim.rows) { if (r.ts_server > s) break; if (r.event === 'CLOSE') v = r.v_balance; }
  return v;
}

export function createDemoDb(nowUtc = Date.now()) {
  const iso = (ms) => new Date(ms).toISOString();
  const news = nextNews(nowUtc);
  const nextTier1 = news.find((n) => n.tier === 1 && Date.parse(n.ts_utc) > nowUtc + 12 * HOUR) || news.find((n) => n.tier === 1);
  const nfpFrom = Date.parse(nextTier1.ts_utc) - 30 * MIN, nfpTo = Date.parse(nextTier1.ts_utc) + 90 * MIN;
  const srv = (ms) => tsEa(ms + DEMO_OFFSET_MIN * MIN).slice(0, 16);

  // Bot 1 "คอมหลัก": EA v3.05 (app 1.2.2) with the SPEC 7.3 values for a 300 balance (the generic Dobby3_v305_web.set);
  // the runner is off (its default), so the owner can try the switch, and the daily-cap reset (SPEC 11).
  const p1 = { ...autoFromBalance(templateParams('ea-default'), 300), InpRemoteParams: true, InpRemoteLive: true, InpRemoteMaxLots: 0.50, InpRemoteMaxCapPct: 10 };
  // Bot 2 "DESKTOP-NPNL85P": an older EA v3.03 (web can only pause/resume and set blackouts; settings are read-only).
  const p2 = {
    ...templateParams('std-003'), InpLotsA: 0.02, InpLotsNY: 0.02, InpLotsC5G: 0.02, InpMaxLots: 0.02, InpVirtualStart: 200,
    InpLock1Enable: true, InpLock1AtPct: 82, InpLock1ToPct: 80, InpUseAsia: true, InpLotsAsia: 0.01, InpMaxAttempts: 2,
  };
  // account balance = virtual + the cash flows below (a 100 deposit, a 50 one not confirmed yet, a -12.40 manual trade)
  const sim1 = new BotSim({
    id: 'demo-bot-1', seed: 20261107, idBase: 100000, ea: '3.05', remote: true, params: p1, openPosition: true, accountExtra: 137.6,
    weak: { module: 'C5G', days: 13 },
    applied: {
      version: 14, live: true, mode: 'run', lots: null, allow_long: true, allow_short: true, max_spread: null, note: '',
      blackouts: [[srv(nfpFrom), srv(nfpTo)]], applied_at: tsEa(nowUtc + DEMO_OFFSET_MIN * MIN - 26 * HOUR),
    },
  }, nowUtc);
  const sim2 = new BotSim({
    id: 'demo-bot-2', seed: 4242, idBase: 500000, ea: '3.03', remote: false, params: p2, openPosition: false, accountExtra: 48.5, pausedDays: 2,
    spread: 0.24,
    applied: {
      version: 6, live: false, mode: 'run', lots: null, allow_long: true, allow_short: true, max_spread: null, note: 'พักไว้ก่อน',
      blackouts: [], applied_at: tsEa(nowUtc + DEMO_OFFSET_MIN * MIN - 50 * HOUR),
    },
  }, nowUtc);

  // Friends (read-only for the admin). นก: EA v3.05 on a 500 balance, live, the runner on with the tested values and an
  // open C5G trade that already passed its TP and ratcheted once (the runner card state, SPEC 11).
  const pNok = { ...autoFromBalance(templateParams('ea-default'), 500), InpRemoteParams: true, InpRemoteLive: true, InpRemoteMaxLots: 0.50, InpRemoteMaxCapPct: 10, InpRunnerEnable: true };
  const simNok = new BotSim({
    id: 'demo-bot-nok', seed: 777029, idBase: 700000, ea: '3.05', remote: true, params: pNok, openPosition: true, runnerPos: { k: 1 }, accountExtra: 212.4, spread: 0.22,
    applied: {
      version: 9, live: true, mode: 'run', lots: null, allow_long: true, allow_short: true, max_spread: null, note: '',
      blackouts: [], applied_at: tsEa(nowUtc + DEMO_OFFSET_MIN * MIN - 30 * HOUR),
    },
  }, nowUtc);
  // บีม: EA v3.04 on 250, one lock stage 90->88 plus ASIA16, paused from the web, the PC offline for 3 h, a news blackout.
  const beamOffline = nowUtc - 3 * HOUR - 12 * MIN;
  const pBeam = {
    ...templateParams('std-003'), InpLotsA: 0.02, InpLotsNY: 0.02, InpLotsC5G: 0.02, InpMaxLots: 0.02, InpVirtualStart: 250,
    InpLockEnable: true, InpLockAtPct: 90, InpLockToPct: 88, InpLock1Enable: false, InpUseAsia: true, InpLotsAsia: 0.01,
    InpRemoteParams: true, InpRemoteLive: true, InpRemoteMaxLots: 0.10, InpRemoteMaxCapPct: 10, InpDailyCapPct: 8,
  };
  const simBeam = new BotSim({
    id: 'demo-bot-beam', seed: 31337, idBase: 800000, ea: '3.04', remote: true, params: pBeam, openPosition: false, accountExtra: 0, pausedDays: 1,
    spread: 0.25, offlineAt: beamOffline,
    applied: {
      version: 5, live: true, mode: 'pause', lots: null, allow_long: true, allow_short: true, max_spread: null, note: 'ไปต่างจังหวัด พักไว้',
      blackouts: [[srv(nfpFrom), srv(nfpTo)]], applied_at: tsEa(beamOffline + DEMO_OFFSET_MIN * MIN - 20 * HOUR),
    },
  }, beamOffline);

  // local limits: SPEC 7.3 defaults (max lots = min(0.50, max(0.02, 2 x L)), daily cap 10)
  const limits1 = { allow_remote_control: true, allow_remote_live: true, allow_remote_params: true, max_lots: 0.06, max_daily_cap_pct: 10 };
  const limits2 = { allow_remote_control: true, allow_remote_live: false, allow_remote_params: false, max_lots: 0.04, max_daily_cap_pct: 10 };
  // SPEC 9.3 settings: คอมหลัก uses both (news 30 / 60, no trading on Friday night, NYSE holidays); นก news only;
  // บีม news only, and its PC could not fetch the calendar before it went offline. DESKTOP-NPNL85P runs agent 1.0.0.
  const auto1 = { auto_news: { enabled: true, before_min: 30, after_min: 60, currencies: ['USD'], impact: ['High'] },
    schedule: { enabled: true, us_holidays: true, weekly: [{ dow: 5, from: '21:00', to: '24:00' }] } };
  const autoNok = { auto_news: { enabled: true, before_min: 30, after_min: 60, currencies: ['USD'], impact: ['High'] }, schedule: { enabled: false, us_holidays: true, weekly: [] } };
  const autoBeam = { auto_news: { enabled: true, before_min: 45, after_min: 90, currencies: ['USD'], impact: ['High'] } };
  const evs = agentNews(nowUtc, news);
  const newsState = (auto, at = nowUtc, extra = {}) => ({
    news: evs.filter((e) => Date.parse(e.ts_utc) > at - DAY), auto_blackouts: autoWindows(at, evs, auto.auto_news, auto.schedule),
    news_fetched_at: iso(at - 95 * MIN), ...extra,
  });
  const agentState = (v, limits, sim, at = nowUtc, rejected = [], extra = {}) => ({
    agent_version: '1.0.0', applied_version: v, applied_at: iso(at - 26 * HOUR), limits, rejected, last_error: null,
    ea_heartbeat_age_s: 2, control_file_id: `W${pad3(v)}`, remote_file_version: sim.remote ? v : null,
    bars: sim.bars(at), ...extra,
  });
  const limitsNok = { allow_remote_control: true, allow_remote_live: true, allow_remote_params: true, max_lots: 0.10, max_daily_cap_pct: 10 };
  const limitsBeam = { allow_remote_control: true, allow_remote_live: true, allow_remote_params: true, max_lots: 0.04, max_daily_cap_pct: 10 };
  const bots = [
    {
      id: 'demo-bot-1', owner: DEMO_USER.id, name: 'คอมหลัก', created_at: iso(nowUtc - 21 * DAY), last_seen: iso(nowUtc - 2000),
      agent_version: '1.2.1', ea_version: '3.05', symbol: 'XAUUSD', server_utc_offset_min: DEMO_OFFSET_MIN,
      agent_state: agentState(14, limits1, sim1, nowUtc, [], { agent_version: '1.2.1', ...newsState(auto1) }),
    },
    {
      id: 'demo-bot-2', owner: DEMO_USER.id, name: 'DESKTOP-NPNL85P', created_at: iso(nowUtc - 20 * DAY), last_seen: iso(nowUtc - 4000),
      agent_version: '1.0.0', ea_version: '3.03', symbol: 'XAUUSD', server_utc_offset_min: DEMO_OFFSET_MIN, agent_state: agentState(6, limits2, sim2),
    },
    {
      id: 'demo-bot-nok', owner: 'demo-nok', name: 'คอมนก', created_at: iso(nowUtc - 11 * DAY), last_seen: iso(nowUtc - 3000),
      agent_version: '1.2.1', ea_version: '3.05', symbol: 'XAUUSD', server_utc_offset_min: DEMO_OFFSET_MIN,
      agent_state: agentState(9, limitsNok, simNok, nowUtc, [], { agent_version: '1.2.1', ...newsState(autoNok) }),
    },
    {
      id: 'demo-bot-beam', owner: 'demo-beam', name: 'โน้ตบุ๊กบีม', created_at: iso(nowUtc - 8 * DAY), last_seen: iso(beamOffline), offline: true,
      agent_version: '1.2.0', ea_version: '3.04', symbol: 'XAUUSD', server_utc_offset_min: DEMO_OFFSET_MIN,
      agent_state: agentState(5, limitsBeam, simBeam, beamOffline, [{ code: 'lots_clamped', detail: '0.05 -> 0.04' }],
        { agent_version: '1.2.0', ...newsState(autoBeam, beamOffline, { news_error: 'HTTP Error 429: Too Many Requests', news_fetched_at: iso(beamOffline - 30 * HOUR) }) }),
    },
  ];
  const ctl = (bot_id, version, desired, ago, by = DEMO_USER.id) => ({ bot_id, version, desired, updated_by: by, updated_at: iso(nowUtc - ago) });
  const control = [
    ctl('demo-bot-1', 14, {
      live: true, control: { mode: 'run', lots: null, allow_long: true, allow_short: true, max_spread: null, note: '' },
      blackouts: [{ from_utc: isoUtc(nfpFrom), to_utc: isoUtc(nfpTo), label: nextTier1.name }], params: remoteSubset(normalizeParams(p1)), ...auto1,
    }, 26 * HOUR),
    ctl('demo-bot-2', 6, {
      live: false, control: { mode: 'run', lots: null, allow_long: true, allow_short: true, max_spread: null, note: 'พักไว้ก่อน' },
      blackouts: [], params: null,
    }, 50 * HOUR),
    ctl('demo-bot-nok', 9, {
      live: true, control: { mode: 'run', lots: null, allow_long: true, allow_short: true, max_spread: null, note: '' },
      blackouts: [], params: remoteSubset(normalizeParams(pNok)), ...autoNok,
    }, 30 * HOUR, 'demo-nok'),
    ctl('demo-bot-beam', 5, {
      live: true, control: { mode: 'pause', lots: null, allow_long: true, allow_short: true, max_spread: null, note: 'ไปต่างจังหวัด พักไว้' },
      blackouts: [{ from_utc: isoUtc(nfpFrom), to_utc: isoUtc(nfpTo), label: nextTier1.name }], params: remoteSubset(normalizeParams(pBeam)), ...autoBeam,
    }, 4 * HOUR, 'demo-beam'),
  ];

  const profiles = [
    { id: DEMO_USER.id, email: DEMO_USER.email, display_name: 'เจ้าของบอท', role: 'admin', approved: true, disabled: false, created_at: iso(nowUtc - 40 * DAY) },
    { id: 'demo-nok', email: 'nok@example.com', display_name: 'นก', role: 'member', approved: true, disabled: false, created_at: iso(nowUtc - 12 * DAY) },
    { id: 'demo-beam', email: 'beam@example.com', display_name: 'บีม', role: 'member', approved: true, disabled: false, created_at: iso(nowUtc - 9 * DAY) },
    { id: 'demo-mint', email: 'mint@example.com', display_name: 'มิ้นท์', role: 'member', approved: true, disabled: false, created_at: iso(nowUtc - 2 * DAY) },
    { id: 'demo-ploy', email: 'ploy@example.com', display_name: 'พลอย', role: 'member', approved: false, disabled: false, created_at: iso(nowUtc - 1 * DAY) },
    { id: 'demo-old', email: 'old@example.com', display_name: 'บัญชีทดสอบเก่า', role: 'member', approved: true, disabled: true, created_at: iso(nowUtc - 30 * DAY) },
  ];

  const invites = [
    { code: 'DEMKH7K3QP', role: 'member', note: 'สำหรับเพื่อนคนใหม่', created_by: DEMO_USER.id, created_at: iso(nowUtc - DAY), expires_at: iso(nowUtc + 6 * DAY), used_by: null, used_at: null, revoked: false },
    { code: 'NKW4Z8RTBX', role: 'member', note: 'นก', created_by: DEMO_USER.id, created_at: iso(nowUtc - 13 * DAY), expires_at: iso(nowUtc - 6 * DAY), used_by: 'demo-nok', used_at: iso(nowUtc - 12 * DAY), revoked: false },
    { code: 'XPRD5M2HCD', role: 'member', note: 'ไม่ได้ใช้ หมดอายุ', created_by: DEMO_USER.id, created_at: iso(nowUtc - 11 * DAY), expires_at: iso(nowUtc - 4 * DAY), used_by: null, used_at: null, revoked: false },
    { code: 'BM3Q7XWT4K', role: 'member', note: 'บีม', created_by: DEMO_USER.id, created_at: iso(nowUtc - 10 * DAY), expires_at: iso(nowUtc - 3 * DAY), used_by: 'demo-beam', used_at: iso(nowUtc - 9 * DAY), revoked: false },
    { code: 'MT8K2PQRZ5', role: 'member', note: 'มิ้นท์', created_by: DEMO_USER.id, created_at: iso(nowUtc - 3 * DAY), expires_at: iso(nowUtc + 4 * DAY), used_by: 'demo-mint', used_at: iso(nowUtc - 2 * DAY), revoked: false },
    { code: 'RVK9P6LGEZ', role: 'admin', note: 'ส่งผิดคน', created_by: DEMO_USER.id, created_at: iso(nowUtc - 5 * DAY), expires_at: iso(nowUtc + 2 * DAY), used_by: null, used_at: null, revoked: true },
  ];

  const presets = [
    { id: 'demo-preset-1', owner: DEMO_USER.id, name: 'คอมหลัก ทุน 300 (ค่าอัตโนมัติ)', params: { ...p1 }, notes: 'ตรงกับที่รันอยู่บนคอมหลัก', created_at: iso(nowUtc - 20 * DAY), updated_at: iso(nowUtc - 3 * DAY) },
    { id: 'demo-preset-2', owner: DEMO_USER.id, name: 'ทดลอง 0.04 ล็อก 1 ชั้น', params: { ...templateParams('std-003'), InpLotsA: 0.04, InpLotsNY: 0.04, InpLotsC5G: 0.04, InpMaxLots: 0.04, InpVirtualStart: 400, InpRemoteMaxLots: 0.05 }, notes: 'ลองใน Strategy Tester ก่อนใช้จริง', created_at: iso(nowUtc - 6 * DAY), updated_at: iso(nowUtc - 6 * DAY) },
  ];

  presets.push(
    { id: 'demo-preset-nok-1', owner: 'demo-nok', name: 'ทุน 500 อัตโนมัติ', params: { ...pNok }, notes: 'ใช้อยู่บนคอมนก', created_at: iso(nowUtc - 10 * DAY), updated_at: iso(nowUtc - 30 * HOUR) },
    { id: 'demo-preset-nok-2', owner: 'demo-nok', name: 'ระวัง 0.03 ล็อก 1 ชั้น', params: { ...pNok, InpLotsA: 0.03, InpLotsNY: 0.03, InpLotsC5G: 0.03, InpMaxLots: 0.03, InpLock1Enable: false }, notes: 'สำรองไว้ช่วงข่าว', created_at: iso(nowUtc - 6 * DAY), updated_at: iso(nowUtc - 6 * DAY) },
    { id: 'demo-preset-beam-1', owner: 'demo-beam', name: 'บีม 250 ล็อก 90→88', params: { ...pBeam }, notes: null, created_at: iso(nowUtc - 7 * DAY), updated_at: iso(nowUtc - 2 * DAY) },
  );

  const d14 = control[0].desired;
  const dNok = control[2].desired, dBeam = control[3].desired;
  const audit = [
    { ts: iso(nowUtc - 26 * HOUR), actor: DEMO_USER.id, bot_id: 'demo-bot-1', action: 'control', before: { ...d14, blackouts: [] }, after: d14 },
    { ts: iso(nowUtc - 50 * HOUR), actor: DEMO_USER.id, bot_id: 'demo-bot-2', action: 'control', before: { ...control[1].desired, live: true, control: { ...control[1].desired.control, note: '' } }, after: control[1].desired },
    { ts: iso(nowUtc - 3 * DAY), actor: DEMO_USER.id, bot_id: null, action: 'preset_update', before: { name: 'คอมหลัก ทุน 300 (ค่าอัตโนมัติ)', notes: '' }, after: { name: 'คอมหลัก ทุน 300 (ค่าอัตโนมัติ)', notes: 'ตรงกับที่รันอยู่บนคอมหลัก' } },
    { ts: iso(nowUtc - 4 * DAY), actor: DEMO_USER.id, bot_id: 'demo-bot-1', action: 'control', before: { ...d14, control: { ...d14.control, mode: 'pause' }, blackouts: [] }, after: { ...d14, blackouts: [] } },
    { ts: iso(nowUtc - 4 * DAY - 3 * HOUR), actor: DEMO_USER.id, bot_id: 'demo-bot-1', action: 'control', before: { ...d14, blackouts: [] }, after: { ...d14, control: { ...d14.control, mode: 'pause', note: 'ข่าวแรง พักก่อน' }, blackouts: [] } },
    { ts: iso(nowUtc - 5 * DAY), actor: DEMO_USER.id, bot_id: null, action: 'admin_revoke_invite', before: { code: 'RVK9P6LGEZ', revoked: false }, after: { code: 'RVK9P6LGEZ', revoked: true } },
    { ts: iso(nowUtc - 6 * DAY), actor: DEMO_USER.id, bot_id: null, action: 'preset_insert', before: null, after: { name: 'ทดลอง 0.04 ล็อก 1 ชั้น' } },
    { ts: iso(nowUtc - 12 * DAY), actor: 'demo-nok', bot_id: null, action: 'invite_redeem', before: { approved: false }, after: { approved: true, role: 'member' } },
    { ts: iso(nowUtc - 21 * DAY), actor: DEMO_USER.id, bot_id: 'demo-bot-1', action: 'control', before: null, after: { ...d14, blackouts: [] } },
    // friends: the admin reads every row; members read their own
    { ts: iso(nowUtc - 4 * HOUR), actor: 'demo-beam', bot_id: 'demo-bot-beam', action: 'control', before: { ...dBeam, blackouts: [] }, after: dBeam },
    { ts: iso(nowUtc - 26 * HOUR), actor: 'demo-beam', bot_id: 'demo-bot-beam', action: 'control', before: { ...dBeam, control: { ...dBeam.control, mode: 'run', note: '' }, blackouts: [] }, after: { ...dBeam, blackouts: [] } },
    { ts: iso(nowUtc - 2 * DAY), actor: 'demo-beam', bot_id: null, action: 'preset_update', before: { name: 'บีม 250', owner: 'demo-beam' }, after: { name: 'บีม 250 ล็อก 90→88', owner: 'demo-beam' } },
    { ts: iso(nowUtc - 8 * DAY), actor: 'demo-beam', bot_id: 'demo-bot-beam-old', action: 'bot_delete', before: { id: 'demo-bot-beam-old', owner: 'demo-beam', name: 'คอมเก่าบีม' }, after: null },
    { ts: iso(nowUtc - 9 * DAY), actor: 'demo-beam', bot_id: null, action: 'invite_redeem', before: { approved: false }, after: { approved: true, role: 'member' } },
    { ts: iso(nowUtc - 30 * HOUR), actor: 'demo-nok', bot_id: 'demo-bot-nok', action: 'control', before: { ...dNok, live: false }, after: dNok },
    { ts: iso(nowUtc - 6 * DAY), actor: 'demo-nok', bot_id: null, action: 'preset_insert', before: null, after: { name: 'ระวัง 0.03 ล็อก 1 ชั้น', owner: 'demo-nok' } },
    { ts: iso(nowUtc - 2 * DAY), actor: 'demo-mint', bot_id: null, action: 'invite_redeem', before: { approved: false }, after: { approved: true, role: 'member' } },
  ].sort((a, b) => b.ts.localeCompare(a.ts)).map((a, i) => ({ id: 900 - i, ...a }));

  const downloads = [
    { name: 'Dobby3_v305.ex5', size: 221870, updated_at: iso(nowUtc - 2 * DAY) },
    { name: 'DobbyApp.exe', size: 18874368, updated_at: iso(nowUtc - 2 * DAY) },
    { name: 'Dobby3_v305_web.set', size: 6498, updated_at: iso(nowUtc - 2 * DAY) },
    { name: 'dobby_agent.zip', size: 18240, updated_at: iso(nowUtc - 2 * DAY) },
  ];

  // SPEC 9.2 cash flows: คอมหลัก has a confirmed 100 deposit, an auto-detected +50 waiting for the owner, and a -12.40
  // the owner marked as a manual trade; นก has a confirmed auto-detected 200 deposit.
  const auto = 'balance change not explained by Dobby trades';
  const fl = (id, bot_id, ts, amount, source, status, balance_after, note) => ({ id, bot_id, ts: isoUtc(ts), amount, source, status, balance_after, note, created_at: iso(ts + 4 * MIN), updated_at: iso(ts + 4 * MIN) });
  const tDep = nowUtc - 10 * DAY + 3 * HOUR, tMan = nowUtc - 6 * DAY - 2 * HOUR, tSug = nowUtc - 26 * HOUR, tNok = nowUtc - 9 * DAY + 5 * HOUR;
  const flows = [
    fl(1, 'demo-bot-1', tDep, 100, 'manual', 'confirmed', null, 'โอนเพิ่มจากบัญชีออมทรัพย์'),
    fl(2, 'demo-bot-1', tMan, -12.4, 'auto', 'dismissed', r2(vbAt(sim1, tMan) + 100 - 12.4), auto),
    fl(3, 'demo-bot-1', tSug, 50, 'auto', 'suggested', r2(vbAt(sim1, tSug) + 137.6), auto),
    fl(4, 'demo-bot-nok', tNok, 200, 'auto', 'confirmed', r2(vbAt(simNok, tNok) + 212.4), auto),
  ];
  // SPEC 9.6 notes and tags on a few trades
  const t1 = closedTrades(sim1), tn = closedTrades(simNok);
  const pick = (list, pred, from = 0) => list.slice(0, list.length - from).reverse().find(pred);
  const nyWin = pick(t1, (x) => x.open.tag === 'NY' && x.close.pnl > 0);
  const c5Loss = pick(t1, (x) => x.open.tag === 'C5G' && x.close.pnl < 0, 2);
  const aTime = pick(t1, (x) => x.open.tag === 'A_new', 3);
  const note = (bot_id, x, tags, text, ago) => (x ? { bot_id, trade_key: keyOf(x.open), note: text, tags, updated_at: iso(nowUtc - ago), updated_by: bot_id === 'demo-bot-nok' ? 'demo-nok' : DEMO_USER.id } : null);
  const notes = [
    note('demo-bot-1', nyWin, ['ช่วงข่าว'], 'ข่าวออกตอนถือไม้อยู่ ราคาวิ่งแรงทั้งสองทาง แต่ยังถึง TP', 20 * HOUR),
    note('demo-bot-1', c5Loss, ['ตลาดผันผวน', 'เลื่อน SL เอง'], 'ราคาแกว่งแรงช่วงตลาดยุโรปเปิด ลองเลื่อน SL เองแล้วไม่ช่วย ครั้งหน้าปล่อยตามบอท', 3 * DAY),
    note('demo-bot-1', aTime, ['ปิดเอง'], null, 4 * DAY),
    note('demo-bot-nok', pick(tn, (x) => x.close.pnl < 0), ['ช่วงข่าว'], 'ลืมตั้งงดเข้าไม้ช่วงข่าว', 2 * DAY),
  ].filter(Boolean);

  return {
    user: DEMO_USER, profiles, invites, bots, control, sims: { 'demo-bot-1': sim1, 'demo-bot-2': sim2, 'demo-bot-nok': simNok, 'demo-bot-beam': simBeam },
    presets, audit, news, downloads, flows, notes, rounds: [],
    factors: [{ id: 'demo-totp-1', factor_type: 'totp', status: 'verified', friendly_name: 'มือถือ (ตัวอย่าง)', created_at: iso(nowUtc - 30 * DAY) }],
  };
}
