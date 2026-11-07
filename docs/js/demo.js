// Synthetic, deterministic demo data (no real account data). Two bots with ~3 weeks of journal, a live status with an
// open position, invites, presets, news and audit rows. Dates are relative to "now" so the demo always looks current;
// the pattern itself is fixed by the seeds below. "Today" is always treated as a trading day.
import { templateParams, remoteSubset, normalizeParams } from './params.js';
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
    let outcome = u < 0.39 ? 'TP' : u < 0.48 ? 'LOCK' : u < 0.53 ? 'LOCK1' : u < 0.57 ? 'TIME' : 'SL';
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
      const entry = r2(price(nowWall) - 2.6);
      const sl = 6.4, tpd = r2(sl * P.InpC5_TPRatio);
      const lots = P.InpLotsC5G;
      this.position = {
        module: 'C5G', ticket: this.pos++, side: 'BUY', lots, open_price: entry, sl: r2(entry - sl), tp: r2(entry + tpd),
        open_wall: openAt, tpd, sld: sl,
      };
      this.add(openAt + 1000, 'OPEN', 'C5G', 'BUY', lots, entry, this.position.sl, this.position.tp, 0, 0,
        `d=${f2(sl)} tp=${f2(tpd)} atr=${f2(sl)} rsi=47.9 | ${this.desc('C5G', 'BUY', entry)}`);
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
    const tf = 15 * MIN, n = 96;
    const nowWall = nowUtc + DEMO_OFFSET_MIN * MIN;
    const lastOpen = Math.floor(nowWall / tf) * tf - tf; // the newest closed bar
    const jitter = (k) => { const r = rng((this.cfg.seed % 997) * 7919 + k); return (r() - 0.5) * 1.1 + (r() - 0.5) * 0.7; };
    const t = [], c = [], vwap = [];
    let day = null, pv = 0, vol = 0;
    for (let i = n - 1; i >= 0; i--) {
      const open = lastOpen - i * tf;
      const k = Math.floor(open / tf);
      const close = r2(price(open + tf) + jitter(k));
      const d = Math.floor(open / DAY);
      if (d !== day) { day = d; pv = 0; vol = 0; }
      const v = 1 + rng(k * 31 + 7)() * 2.5;
      pv += close * v; vol += v;
      t.push(Math.floor((open - DEMO_OFFSET_MIN * MIN) / 1000));
      c.push(close);
      vwap.push(r2(pv / vol));
    }
    return { tf: 'M15', t, c, vwap };
  }

  tick(nowUtc) {
    const nowWall = nowUtc + DEMO_OFFSET_MIN * MIN;
    const anchor = this.position ? this.position.open_price + 2.6 : price(nowWall);
    this.bid = r2(this.bid + (anchor - this.bid) * 0.08 + (this.r() - 0.5) * 0.7);
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
    const row = this.add(nowUtc + DEMO_OFFSET_MIN * MIN, 'CLOSE', p.module, p.side, p.lots, this.bid, null, null, pnl, 0, `reason=${reason} pos=${p.ticket}`);
    this.position = null;
    return row;
  }

  posJson(mod, nowUtc) {
    const p = this.position;
    if (!p || p.module !== mod) return { open: false, module: mod };
    const dir = p.side === 'BUY' ? 1 : -1;
    const gain = (this.bid - p.open_price) * dir;
    const near = gain >= 0.95 * p.tpd;
    return {
      open: true, module: mod, ticket: p.ticket, side: p.side, lots: p.lots, open_price: p.open_price, sl: p.sl, tp: p.tp,
      profit: this.openProfit(), swap: 0, open_time: tsEa(p.open_wall), bars_held: Math.floor((nowUtc + DEMO_OFFSET_MIN * MIN - p.open_wall) / (15 * MIN)),
      comment: `Dobby3 ${mod}`, near_tp: near, locked: near && this.params.InpLockEnable,
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
    const st = {
      schema_version: cfg.remote ? 5 : 4, ea: 'Dobby3', ea_version: cfg.ea, tag: P.InpUseAsia ? 'A_new+NY+C5G+ASIA16' : 'A_new+NY+C5G',
      magic: P.InpMagicA, symbol: 'XAUUSD', server_time: tsEa(nowWall), heartbeat_gmt_unix: Math.floor(nowUtc / 1000),
      account: { mode: 'REAL', currency: 'USD', balance, equity: r2(balance + profit), connected: true, trade_permitted: true },
      virtual: {
        start_date: tsEa(this.today - 21 * DAY + 9 * HOUR), start: P.InpVirtualStart, balance: r2(this.vb), day: wallString(this.today, '.').slice(0, 10),
        day_start: r2(this.dayStart ?? this.vb), day_pnl: r2(this.dayPnl || 0), step: 0, day_stopped: !!this.capHit,
        day_cap_hit: !!this.capHit, kill_balance: P.InpKillBalance, killed: false, trades: tr, wins: wi, losses: lo, day_stops: ds,
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
      },
      last_event: this.lastEvent, last_error: this.lastError,
    };
    if (this.remote) {
      st.remote = {
        params_enabled: P.InpRemoteParams, live_enabled: P.InpRemoteLive, file_exists: true, version: this.remote.version,
        applied_version: this.remote.applied_version, pending: this.remote.pending, waiting: this.remote.waiting, live: a.live,
        rejects: this.remote.rejects, ceilings: { max_lots: P.InpRemoteMaxLots, max_cap_pct: P.InpRemoteMaxCapPct },
        effective: remoteSubset(P),
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

export function createDemoDb(nowUtc = Date.now()) {
  const iso = (ms) => new Date(ms).toISOString();
  const news = nextNews(nowUtc);
  const nextTier1 = news.find((n) => n.tier === 1 && Date.parse(n.ts_utc) > nowUtc + 12 * HOUR) || news.find((n) => n.tier === 1);
  const nfpFrom = Date.parse(nextTier1.ts_utc) - 30 * MIN, nfpTo = Date.parse(nextTier1.ts_utc) + 90 * MIN;
  const srv = (ms) => tsEa(ms + DEMO_OFFSET_MIN * MIN).slice(0, 16);

  // Bot 1 "คอมหลัก": EA v3.04 with the SPEC 7.3 values for a 300 balance (the generic Dobby3_v304_web.set).
  const p1 = { ...autoFromBalance(templateParams('ea-default'), 300), InpRemoteParams: true, InpRemoteLive: true, InpRemoteMaxLots: 0.50, InpRemoteMaxCapPct: 10 };
  // Bot 2 "DESKTOP-NPNL85P": an older EA v3.03 (web can only pause/resume and set blackouts; settings are read-only).
  const p2 = {
    ...templateParams('std-003'), InpLotsA: 0.02, InpLotsNY: 0.02, InpLotsC5G: 0.02, InpMaxLots: 0.02, InpVirtualStart: 200,
    InpLock1Enable: true, InpLock1AtPct: 82, InpLock1ToPct: 80, InpUseAsia: true, InpLotsAsia: 0.01, InpMaxAttempts: 2,
  };
  const sim1 = new BotSim({
    id: 'demo-bot-1', seed: 20261107, idBase: 100000, ea: '3.04', remote: true, params: p1, openPosition: true, accountExtra: 0,
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

  // local limits: SPEC 7.3 defaults (max lots = min(0.50, max(0.02, 2 x L)), daily cap 10)
  const limits1 = { allow_remote_control: true, allow_remote_live: true, allow_remote_params: true, max_lots: 0.06, max_daily_cap_pct: 10 };
  const limits2 = { allow_remote_control: true, allow_remote_live: false, allow_remote_params: false, max_lots: 0.04, max_daily_cap_pct: 10 };
  const agentState = (v, limits, sim) => ({
    agent_version: '1.0.0', applied_version: v, applied_at: iso(nowUtc - 26 * HOUR), limits, rejected: [], last_error: null,
    ea_heartbeat_age_s: 2, control_file_id: `W${pad3(v)}`, remote_file_version: sim.remote ? v : null,
    bars: sim.bars(nowUtc),
  });
  const bots = [
    {
      id: 'demo-bot-1', owner: DEMO_USER.id, name: 'คอมหลัก', created_at: iso(nowUtc - 21 * DAY), last_seen: iso(nowUtc - 2000),
      agent_version: '1.0.0', ea_version: '3.04', symbol: 'XAUUSD', server_utc_offset_min: DEMO_OFFSET_MIN, agent_state: agentState(14, limits1, sim1),
    },
    {
      id: 'demo-bot-2', owner: DEMO_USER.id, name: 'DESKTOP-NPNL85P', created_at: iso(nowUtc - 20 * DAY), last_seen: iso(nowUtc - 4000),
      agent_version: '1.0.0', ea_version: '3.03', symbol: 'XAUUSD', server_utc_offset_min: DEMO_OFFSET_MIN, agent_state: agentState(6, limits2, sim2),
    },
  ];
  const ctl = (bot_id, version, desired, ago) => ({ bot_id, version, desired, updated_by: DEMO_USER.id, updated_at: iso(nowUtc - ago) });
  const control = [
    ctl('demo-bot-1', 14, {
      live: true, control: { mode: 'run', lots: null, allow_long: true, allow_short: true, max_spread: null, note: '' },
      blackouts: [{ from_utc: isoUtc(nfpFrom), to_utc: isoUtc(nfpTo), label: nextTier1.name }], params: remoteSubset(normalizeParams(p1)),
    }, 26 * HOUR),
    ctl('demo-bot-2', 6, {
      live: false, control: { mode: 'run', lots: null, allow_long: true, allow_short: true, max_spread: null, note: 'พักไว้ก่อน' },
      blackouts: [], params: null,
    }, 50 * HOUR),
  ];

  const profiles = [
    { id: DEMO_USER.id, email: DEMO_USER.email, display_name: 'เจ้าของบอท', role: 'admin', approved: true, disabled: false, created_at: iso(nowUtc - 40 * DAY) },
    { id: 'demo-nok', email: 'nok@example.com', display_name: 'นก', role: 'member', approved: true, disabled: false, created_at: iso(nowUtc - 12 * DAY) },
    { id: 'demo-beam', email: 'beam@example.com', display_name: 'บีม', role: 'member', approved: true, disabled: false, created_at: iso(nowUtc - 9 * DAY) },
    { id: 'demo-ploy', email: 'ploy@example.com', display_name: 'พลอย', role: 'member', approved: false, disabled: false, created_at: iso(nowUtc - 1 * DAY) },
    { id: 'demo-old', email: 'old@example.com', display_name: 'บัญชีทดสอบเก่า', role: 'member', approved: true, disabled: true, created_at: iso(nowUtc - 30 * DAY) },
  ];
  const otherBots = { 'demo-nok': { bots: 1, last_seen: iso(nowUtc - 20000) }, 'demo-beam': { bots: 1, last_seen: iso(nowUtc - 3 * HOUR) } };

  const invites = [
    { code: 'DEMKH7K3QP', role: 'member', note: 'สำหรับเพื่อนคนใหม่', created_by: DEMO_USER.id, created_at: iso(nowUtc - DAY), expires_at: iso(nowUtc + 6 * DAY), used_by: null, used_at: null, revoked: false },
    { code: 'NKW4Z8RTBX', role: 'member', note: 'นก', created_by: DEMO_USER.id, created_at: iso(nowUtc - 13 * DAY), expires_at: iso(nowUtc - 6 * DAY), used_by: 'demo-nok', used_at: iso(nowUtc - 12 * DAY), revoked: false },
    { code: 'XPRD5M2HCD', role: 'member', note: 'ไม่ได้ใช้ หมดอายุ', created_by: DEMO_USER.id, created_at: iso(nowUtc - 11 * DAY), expires_at: iso(nowUtc - 4 * DAY), used_by: null, used_at: null, revoked: false },
    { code: 'RVK9P6LGEZ', role: 'admin', note: 'ส่งผิดคน', created_by: DEMO_USER.id, created_at: iso(nowUtc - 5 * DAY), expires_at: iso(nowUtc + 2 * DAY), used_by: null, used_at: null, revoked: true },
  ];

  const presets = [
    { id: 'demo-preset-1', owner: DEMO_USER.id, name: 'คอมหลัก ทุน 300 (ค่าอัตโนมัติ)', params: { ...p1 }, notes: 'ตรงกับที่รันอยู่บนคอมหลัก', created_at: iso(nowUtc - 20 * DAY), updated_at: iso(nowUtc - 3 * DAY) },
    { id: 'demo-preset-2', owner: DEMO_USER.id, name: 'ทดลอง 0.04 ล็อก 1 ชั้น', params: { ...templateParams('std-003'), InpLotsA: 0.04, InpLotsNY: 0.04, InpLotsC5G: 0.04, InpMaxLots: 0.04, InpVirtualStart: 400, InpRemoteMaxLots: 0.05 }, notes: 'ลองใน Strategy Tester ก่อนใช้จริง', created_at: iso(nowUtc - 6 * DAY), updated_at: iso(nowUtc - 6 * DAY) },
  ];

  const d14 = control[0].desired;
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
  ].sort((a, b) => b.ts.localeCompare(a.ts)).map((a, i) => ({ id: 900 - i, ...a }));

  const downloads = [
    { name: 'Dobby3_v304.ex5', size: 214532, updated_at: iso(nowUtc - 2 * DAY) },
    { name: 'DobbyApp.exe', size: 18874368, updated_at: iso(nowUtc - 2 * DAY) },
    { name: 'Dobby3_v304_web.set', size: 6114, updated_at: iso(nowUtc - 2 * DAY) },
    { name: 'dobby_agent.zip', size: 18240, updated_at: iso(nowUtc - 2 * DAY) },
  ];

  return {
    user: DEMO_USER, profiles, otherBots, invites, bots, control, sims: { 'demo-bot-1': sim1, 'demo-bot-2': sim2 },
    presets, audit, news, downloads,
    factors: [{ id: 'demo-totp-1', factor_type: 'totp', status: 'verified', friendly_name: 'มือถือ (ตัวอย่าง)', created_at: iso(nowUtc - 30 * DAY) }],
  };
}
