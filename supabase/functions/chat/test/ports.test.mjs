// The Edge Function carries ports of the website's journal / analytics / params logic (it is one pasted file and
// cannot import docs/js). These tests run both on the same fixture and require identical results, and check that the
// generated params block is in sync with docs/js/params.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as fn from '../index.ts';
import * as webJournal from '../../../../docs/js/journal.js';
import * as webAnalytics from '../../../../docs/js/analytics.js';
import * as webParams from '../../../../docs/js/params.js';
import { journalFixture, jr, OFFSET, statusFixture } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

// Recovery steps, an orphan OPEN (a second OPEN before the CLOSE), a CLOSE without an OPEN, an ASIA16 trade.
function richJournal() {
  const rows = journalFixture();
  rows.push(
    jr('2026-11-03T09:00:00', 'CLOSE', 'NY', { side: 'BUY', lots: 0.03, price: 4010, pnl: 9.5, v_balance: 290, detail: 'reason=TP pos=8000 NY win: no more NY trades today' }),
    jr('2026-11-04T03:15:00', 'OPEN', 'ASIA16', { side: 'BUY', lots: 0.01, price: 3990, sl: 3980, tp: 0, detail: 'asia long' }),
    jr('2026-11-04T16:15:00', 'CLOSE', 'ASIA16', { side: 'BUY', lots: 0.01, price: 3996, pnl: 6, v_balance: 296, detail: 'reason=FLAT pos=8001' }),
    jr('2026-11-07T10:00:00', 'OPEN', 'A_new', { side: 'SELL', lots: 0.03, price: 4070, sl: 4076, tp: 4061, detail: 'd=6.00 tp=9.00 atr=5.00 rsi=61.0 | bear div: high 4071.00 rsi 60.1 vs earlier high 4069.20 rsi 66.0' }),
    jr('2026-11-07T10:40:00', 'OPEN', 'A_new', { side: 'SELL', lots: 0.04, price: 4075, sl: 4081, tp: 4066, step: 1, detail: 'd=6.00 tp=9.00 atr=5.00 rsi=63.0 | bear div' }),
    jr('2026-11-07T12:00:00', 'CLOSE', 'A_new', { side: 'SELL', lots: 0.04, price: 4066, pnl: 36, v_balance: 336.91, step: 1, detail: 'reason=TP pos=9010' }),
  );
  return rows;
}

function manyCloses(module, n, winEvery, { lots = 0.03, win: winPnl = 25, loss = -20 } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(2026, 9, 1 + i, 10, 0, 0)).toISOString().slice(0, 19);
    const win = i % winEvery === 0;
    out.push(jr(d, 'CLOSE', module, { side: 'BUY', lots, price: 4000, pnl: win ? winPnl : loss, v_balance: 300, detail: `reason=${win ? 'TP' : 'SL'} pos=${i}` }));
  }
  return out;
}

test('prepareRows / pairTrades / statsOf / moduleStats / dailyPnl match docs/js/journal.js', () => {
  const rows = richJournal();
  const mine = fn.prepareRows(structuredClone(rows), OFFSET);
  const web = webJournal.prepareRows(structuredClone(rows), OFFSET);
  assert.deepEqual(mine, web);
  const tm = fn.pairTrades(mine), tw = webJournal.pairTrades(web);
  assert.deepEqual(tm, tw);
  assert.equal(tm.length, 8);
  assert.ok(tm.some((t) => t.orphan), 'orphan OPEN kept as open');
  assert.ok(tm.some((t) => !t.open && !t.key), 'CLOSE without OPEN kept');
  assert.deepEqual(fn.statsOf(tm), webJournal.statsOf(tw));
  assert.deepEqual(fn.moduleStats(tm), webJournal.moduleStats(tw));
  assert.deepEqual([...fn.dailyPnl(mine)], [...webJournal.dailyPnl(web)]);
  assert.equal(fn.closeReason('reason=LOCK pos=1'), webJournal.closeReason('reason=LOCK pos=1'));
  for (const k of ['A_new|2026-11-05 09:00:01', 'bad', 'NY|2026-11-05T09:00:01', '|2026-11-05 09:00:01']) assert.deepEqual(fn.parseTradeKey(k), webJournal.parseTradeKey(k), k);
  assert.equal(fn.tradeKeyOf('C5G', '2026-11-06T10:15:01'), webJournal.tradeKeyOf('C5G', '2026-11-06T10:15:01'));
  assert.equal(fn.tradeHref('A_new|2026-11-05 09:00:01'), webJournal.tradeHref('A_new|2026-11-05 09:00:01'));
});

// NY as EA v3.04 / v3.05 write it (2026-11-11): no OPEN row, a stop ORDER, a CANCEL / re-ORDER, an SL, a second try
// with lock rows (whose price is the position's open price), and a filled order that is still open.
function nyOrderJournal() {
  return [
    jr('2026-11-10T16:45:00', 'ARM', 'NY', { lots: 0.2, detail: 'range 4033.81-4057.81 spread 0.20 d=8.00 -> buy stop 4058.21 / sell stop 4033.61' }),
    jr('2026-11-10T16:45:00', 'ORDER', 'NY', { side: 'SELL', lots: 0.15, price: 4033.61, sl: 4041.61, tp: 3993.61, detail: 'sell stop at 4033.61 d=8.00' }),
    jr('2026-11-10T16:45:30', 'CANCEL', 'NY', { side: 'SELL', price: 4033.61, detail: 'volume 0.15 -> 0.20' }),
    jr('2026-11-10T16:45:31', 'ORDER', 'NY', { side: 'SELL', lots: 0.2, price: 4033.61, sl: 4041.61, tp: 3993.61, detail: 'sell stop at 4033.61 d=8.00' }),
    jr('2026-11-10T16:55:34', 'CLOSE', 'NY', { side: 'SELL', lots: 0.2, price: 4041.43, pnl: -160, v_balance: 1543.78, detail: 'reason=SL pos=431586312' }),
    jr('2026-11-10T17:00:00', 'ORDER', 'NY', { side: 'SELL', lots: 0.3, price: 4033.61, sl: 4041.61, tp: 3993.61, step: 1, detail: 'sell stop at 4033.61 d=8.00 (attempt 2 of 4) (runner on: keep 85%, step 0.50 d, max 0, safety TP +4.0 d)' }),
    jr('2026-11-10T18:21:16', 'NEAR1', 'NY', { side: 'SELL', lots: 0.3, price: 4025.8, sl: 4041.33, tp: 3993.33, detail: 'gain 7.53 = 94% of TP 8.00 (stage-1 lock ON)' }),
    jr('2026-11-10T18:21:16', 'LOCK1', 'NY', { side: 'SELL', lots: 0.3, price: 4033.33, sl: 4026.69, tp: 3993.33, detail: 'gain 7.53 >= 85% of TP 8.00 -> SL 4026.69' }),
    jr('2026-11-10T18:21:18', 'CLOSE', 'NY', { side: 'SELL', lots: 0.3, price: 4025.98, pnl: 220.5, v_balance: 1764.28, detail: 'reason=LOCK pos=431625774' }),
    jr('2026-11-11T16:45:00', 'ORDER', 'NY', { side: 'BUY', lots: 0.2, price: 4100.5, sl: 4092.5, tp: 4108.5, detail: 'buy stop at 4100.50 d=8.00' }),
    jr('2026-11-11T16:46:00', 'CANCEL', 'NY', { side: 'BUY', price: 4100.5, detail: 'order no longer wanted' }),
    jr('2026-11-12T16:45:00', 'ORDER', 'NY', { side: 'BUY', lots: 0.2, price: 4110.0, sl: 4102.0, tp: 4118.0, detail: 'buy stop at 4110.00 d=8.00' }),
  ];
}

test('pairTrades: NY starts at its stop ORDER, the same in the function and docs/js/journal.js', () => {
  const rows = nyOrderJournal();
  const mine = fn.prepareRows(structuredClone(rows), OFFSET), web = webJournal.prepareRows(structuredClone(rows), OFFSET);
  const status = { positions: [{ open: true, module: 'NY', open_time: '2026.11.12 17:20:05', open_price: 4110.12 }, { open: false, module: 'C5G' }] };
  assert.deepEqual(fn.openNowOf(status, OFFSET), webJournal.openNowOf(status, OFFSET));
  for (const opts of [undefined, { openNow: fn.openNowOf(status, OFFSET) }]) {
    const tm = fn.pairTrades(mine, opts), tw = webJournal.pairTrades(web, opts);
    assert.deepEqual(tm, tw);
  }
  const closed = fn.pairTrades(mine);
  assert.equal(closed.length, 2, 'two closed NY trades, the cancelled and the pending order are none');
  const [sl, lock] = closed;
  assert.equal(sl.key, 'NY|2026-11-10 16:45:31');
  assert.equal(sl.lots, 0.2);
  assert.equal(sl.openPrice, 4033.43, 'entry from the P&L: 4041.43 - 160 / 20');
  assert.ok(sl.openApprox && sl.viaOrder);
  assert.equal(lock.key, 'NY|2026-11-10 17:00:00');
  assert.equal(lock.openPrice, 4033.33, 'entry from the LOCK1 row');
  assert.equal(lock.step, 1);
  assert.equal(lock.lockSteps.length, 1);
  assert.equal(lock.tp, 4025.61, 'runner: TP0 = safety TP + 4 x d');
  assert.equal(lock.safetyTp, 3993.61);
  // the fill: closes 4037.01 at 18:15 and 4023.48 at 18:30 (server) cross 4033.61 at about 18:18:46
  const S = (hm) => Date.UTC(2026, 10, 10, +hm.slice(0, 2), +hm.slice(3)) - OFFSET * 60000;
  const ts = ['17:45', '18:00', '18:15', '18:30'].map(S), cs = [4045.84, 4042.25, 4037.01, 4023.48];
  const est = fn.fillFromBars(lock, ts, cs);
  assert.equal(est, webJournal.fillFromBars(lock, ts, cs));
  assert.equal(Math.round((est - S('18:15')) / 1000), 226);
  assert.equal(fn.fillFromBars(sl, ts, cs), null, 'no close inside the 10 minutes of the first try');
  assert.equal(fn.fillFromBars(closed[0], [S('16:30'), S('16:50')], [4044, 4036]), webJournal.fillFromBars(closed[0], [S('16:30'), S('16:50')], [4044, 4036]));
  const withNow = fn.pairTrades(mine, { openNow: fn.openNowOf(status, OFFSET) });
  const live = withNow.find((t) => t.open);
  assert.equal(live.key, 'NY|2026-11-12 16:45:00');
  assert.equal(live.openPrice, 4110.12);
  assert.equal(live.openApprox, false);
  assert.equal(live.openUtc, Date.UTC(2026, 10, 12, 17, 20, 5) - OFFSET * 60000);
});

test('strategyHealth / binomCdf / flowTotals match docs/js/analytics.js, with every status reached', () => {
  const rows = [...manyCloses('A_new', 22, 2), ...manyCloses('NY', 20, 2, { win: 18 }), ...manyCloses('C5G', 25, 10), ...manyCloses('ASIA16', 3, 1, { lots: 0.01 }), ...manyCloses('C5G', 5, 1).map((r) => ({ ...r, tag: 'X9' }))];
  const toTrades = (prepared) => prepared.map((r) => ({ module: r.tag, open: false, closeUtc: r.utc, lots: r.lots, pnl: r.pnl ?? 0 }));
  const mine = fn.strategyHealth(toTrades(fn.prepareRows(structuredClone(rows), OFFSET)));
  const web = webAnalytics.strategyHealth(toTrades(webJournal.prepareRows(structuredClone(rows), OFFSET)));
  assert.deepEqual(mine, web);
  const by = Object.fromEntries(mine.map((h) => [h.module, h.status]));
  assert.deepEqual(by, { A_new: 'ok', NY: 'watch', C5G: 'bad', ASIA16: 'none', X9: 'none' });
  for (const [k, n, p] of [[0, 10, 0.5], [5, 20, 0.514], [12, 20, 0.605], [20, 20, 0.3], [-1, 3, 0.5]]) assert.equal(fn.binomCdf(k, n, p), webAnalytics.binomCdf(k, n, p));
  assert.deepEqual(fn.BASELINE, webAnalytics.BASELINE);
  const flows = [{ amount: 100, status: 'confirmed' }, { amount: -40, status: 'confirmed' }, { amount: 70, status: 'suggested' }, { amount: 'x', status: 'confirmed' }];
  assert.deepEqual(fn.flowTotals(flows), webAnalytics.flowTotals(flows));
});

test('params logic matches docs/js/params.js (defaults, remote keys, live values, remote validation)', () => {
  assert.deepEqual(fn.defaults(), webParams.defaults());
  assert.deepEqual(fn.REMOTE_KEYS, webParams.REMOTE_KEYS);
  const st = statusFixture({ options: { lock: { enabled: true, at_pct: 95, to_pct: 93, modules: 'A=true NY=false C5G=true', shadow: true }, max_attempts: 4 } });
  assert.deepEqual(fn.liveValuesFromStatus(st), webParams.liveValuesFromStatus(st));
  const v = { ...webParams.defaults(), InpLotsA: 0.2, InpDailyCapPct: 12, InpMaxSpread: 0.01, InpVirtualStart: 0 };
  assert.deepEqual(fn.validateRemote(v, { maxLots: 0.1, maxCapPct: 10 }), webParams.validateRemote(v, { maxLots: 0.1, maxCapPct: 10 }));
  for (const p of webParams.PARAMS) {
    for (const x of [true, 'false', '1', 3.14159, '7', 'abc']) assert.deepEqual(fn.coerce(p, x), webParams.coerce(p, x), `${p.key} ${x}`);
  }
});

test('open detail and NY range parsers match docs/js/explain.js', async () => {
  const web = await import('../../../../docs/js/explain.js');
  for (const d of ['d=6.00 tp=9.00 atr=5.10 rsi=38.2 | bull div: low 3998.50 rsi 41.0 vs earlier low 3995.20 rsi 35.5', 'no head', '']) {
    assert.deepEqual(JSON.stringify(fn.parseOpenDetail(d)), JSON.stringify(web.parseOpenDetail(d)));
  }
  for (const d of ['range 4029.94-4041.68 spread 0.20 d=8.00 -> buy stop 4042.08 / sell stop 4029.74', 'nothing']) {
    assert.deepEqual(JSON.stringify(fn.parseArm(d)), JSON.stringify(web.parseArm(d)));
  }
});

test('time helpers: Thai input windows and the turn header clock', () => {
  assert.equal(fn.parseThaiInput('2026-11-08'), Date.UTC(2026, 10, 7, 17, 0));
  assert.equal(fn.parseThaiInput('2026-11-08', true), Date.UTC(2026, 10, 8, 17, 0));
  assert.equal(fn.parseThaiInput('2026-11-08T09:30'), Date.UTC(2026, 10, 8, 2, 30));
  for (const bad of ['2026-02-30', '2026-13-01', '08/11/2026', 'today', '2026-11-08T25:00']) assert.equal(fn.parseThaiInput(bad), null, bad);
  assert.equal(fn.nowThai(Date.UTC(2026, 10, 8, 7, 0)), '2026-11-08 14:00 วันอาทิตย์');
  assert.equal(fn.thaiTime(fn.serverToUtc('2026.11.05 09:00:01', 120)), '2026-11-05 14:00');
});

test('generated params block matches docs/js/params.js (tools/sync_chat_params.mjs --check)', () => {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'tools', 'sync_chat_params.mjs'), '--check'], { encoding: 'utf8' });
  assert.match(out, /up to date/);
  assert.deepEqual(fn.PARAMS.map((p) => [p.key, p.type, p.def, p.min, p.max, p.remote, p.label]), webParams.PARAMS.map((p) => [p.key, p.type, p.def, p.min, p.max, p.remote, p.label]));
});

test('the user header escapes nothing it does not need to and fitJson keeps results small', () => {
  assert.equal(fn.renderUser('hi', {}), '[เวลาไทย - | หน้า - | บอทที่เลือก - | ไม้ -]\nhi');
  const big = { rows: Array.from({ length: 5000 }, (_, i) => ({ i, detail: 'x'.repeat(40) })) };
  const s = fn.fitJson(big, 30000);
  assert.ok(s.length <= 30000);
  const parsed = JSON.parse(s);
  assert.ok(parsed.rows.length < 5000 && parsed.rows.length > 100);
  assert.match(parsed.truncated, /shortened/);
});

test('cost: SPEC 10.3 prices per million tokens', () => {
  const u = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  fn.addUsage(u, { input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 1e6 }, 'claude-sonnet-5-5', 'claude-sonnet-5-5');
  assert.equal(Math.round(u.cost * 1e6) / 1e6, 2 + 10 + 0.2 + 2.5);
  const h = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  fn.addUsage(h, { input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 1e6 }, 'claude-haiku-5-5', 'claude-haiku-5-5');
  assert.equal(Math.round(h.cost * 1e6) / 1e6, 0.1 + 0.5 + 0.01 + 0.125);
});
