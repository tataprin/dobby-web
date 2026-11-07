// The Edge Function "notify" (supabase/functions/notify/index.ts) cannot run here (Deno, npm:web-push, real push
// services). Its pure part - Thai texts, CORS, secret compare - sits between "BEGIN messages" / "END messages" in plain
// JavaScript; this test runs exactly that block in node. The rest of the file is checked for the contract by text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, '..', 'functions', 'notify', 'index.ts'), 'utf8');
const block = SRC.match(/\/\/ ==== BEGIN messages ====\r?\n([\s\S]*?)\/\/ ==== END messages ====/);
const M = await import('data:text/javascript;base64,' + Buffer.from(block[1], 'utf8').toString('base64'));

const BOT = { id: '11111111-2222-3333-4444-555555555555', name: 'คอมหลัก' };

test('OPEN: "เปิดไม้ C5G ซื้อ 0.10 ล็อต ที่ 4,121.78", title = the bot name', () => {
  const m = M.buildMessage('open', { id: 7, event: 'OPEN', tag: 'C5G', side: 'BUY', lots: 0.1, price: 4121.78 }, BOT);
  assert.equal(m.body, 'เปิดไม้ C5G ซื้อ 0.10 ล็อต ที่ 4,121.78');
  assert.equal(m.title, 'คอมหลัก');
  assert.equal(m.tag, `open:${BOT.id}:7`);
  assert.equal(m.url, 'https://tataprin.github.io/dobby-web/#/dashboard');
  assert.equal(M.buildMessage('open', { tag: 'NY', side: 'SELL', lots: '0.03', price: '998.5' }, BOT).body,
    'เปิดไม้ NY ขาย 0.03 ล็อต ที่ 998.50');
});

test('CLOSE: "ปิดไม้ C5G +83.20 USD (ล็อกกำไร)" and the other close reasons', () => {
  const close = (pnl, detail, currency) =>
    M.buildMessage('close', { tag: 'C5G', pnl, detail }, BOT, { currency }).body;
  assert.equal(close(83.2, 'reason=LOCK pos=420550760'), 'ปิดไม้ C5G +83.20 USD (ล็อกกำไร)');
  assert.equal(close(-12.5, 'reason=SL pos=1'), 'ปิดไม้ C5G -12.50 USD (ตัดขาดทุน)');
  assert.equal(close(1234.5, 'reason=TP pos=1 NY win: no more NY trades today', 'USD'), 'ปิดไม้ C5G +1,234.50 USD (ถึงเป้ากำไร)');
  assert.equal(close(-3, 'reason=MANUAL pos=9'), 'ปิดไม้ C5G -3.00 USD (ปิดเอง)');
  assert.equal(close(0, 'reason=OTHER pos=9'), 'ปิดไม้ C5G 0.00 USD');
  assert.equal(close(5, 'reason=EOD pos=9', 'EUR'), 'ปิดไม้ C5G +5.00 EUR (EOD)');
  assert.equal(close(5, ''), 'ปิดไม้ C5G +5.00 USD');
});

test('DAYCAP, offline and test texts', () => {
  assert.equal(M.buildMessage('daycap', { tag: 'ALL' }, BOT).body, 'ชนจุดหยุดรายวัน วันนี้ไม่เปิดไม้ใหม่');
  const off = M.buildMessage('offline', { name: 'x', last_seen: '2026-11-07T10:00:00Z' }, BOT);
  assert.equal(off.body, 'บอท คอมหลัก ขาดการติดต่อ');
  assert.equal(off.tag, `offline:${BOT.id}`, 'a second offline note replaces the first');
  const t = M.buildMessage('test', {}, null);
  assert.deepEqual([t.title, t.body], ['Dobby', 'ทดสอบการแจ้งเตือนจาก Dobby']);
  assert.equal(M.buildMessage('nonsense', {}, BOT), null);
  assert.equal(M.buildMessage('open', {}, {}).title, 'Dobby', 'no bot name -> Dobby');
  assert.ok(JSON.stringify(M.buildMessage('close', { tag: 'C5G', pnl: 1, detail: 'reason=TP' }, BOT)).length < 1000);
});

test('number formatting', () => {
  assert.equal(M.fmtNum(4121.78), '4,121.78');
  assert.equal(M.fmtNum(1234567.891, 2), '1,234,567.89');
  assert.equal(M.fmtNum(-0.5), '-0.50');
  assert.equal(M.fmtNum(null), '-');
  assert.equal(M.fmtSigned(83.2), '+83.20');
  assert.equal(M.fmtSigned(-1000), '-1,000.00');
});

test('CORS: only https://tataprin.github.io (plus configured extras) gets Allow-Origin', () => {
  assert.equal(M.corsHeaders('https://tataprin.github.io')['Access-Control-Allow-Origin'], 'https://tataprin.github.io');
  assert.equal(M.corsHeaders('https://evil.example')['Access-Control-Allow-Origin'], undefined);
  assert.equal(M.corsHeaders(null)['Access-Control-Allow-Origin'], undefined);
  assert.equal(M.corsHeaders('http://localhost:8000', ['http://localhost:8000'])['Access-Control-Allow-Origin'], 'http://localhost:8000');
  assert.match(M.corsHeaders('x')['Access-Control-Allow-Headers'], /authorization.*apikey.*content-type/);
});

test('secret compare and event list', () => {
  assert.equal(M.safeEqual('abc'.repeat(10), 'abc'.repeat(10)), true);
  assert.equal(M.safeEqual('abc'.repeat(10), 'abd'.repeat(10)), false);
  assert.equal(M.safeEqual('', ''), false);
  assert.equal(M.safeEqual(undefined, 'x'), false);
  assert.deepEqual(M.EVENTS, ['open', 'close', 'daycap', 'offline']);
  assert.equal(M.ttlFor('test'), 300);
  assert.ok(M.UUID_RE.test(BOT.id));
});

test('index.ts keeps the contract: secrets, both call kinds, 404/410 cleanup, no private key in the repo', () => {
  for (const s of ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT', 'NOTIFY_SECRET', 'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY']) assert.ok(SRC.includes(`"${s}"`), s);
  assert.match(SRC, /x-notify-secret/);
  assert.match(SRC, /auth\.getUser\(jwt\)/);
  assert.match(SRC, /code === 404 \|\| code === 410/);
  assert.match(SRC, /from\("push_subscriptions"\)\.delete\(\)/);
  assert.match(SRC, /npm:web-push@/);
  // a VAPID private key is 43 base64url characters; nothing like it may be in the source
  assert.doesNotMatch(SRC, /["'][A-Za-z0-9_-]{43}["']/);
});
