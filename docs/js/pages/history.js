// History: journal table, paired trades, equity curve, daily calendar heatmap, per-module stats, CSV export.
import { h, mount, icon, fmtNum, fmtSigned, fmtPct, pnl, fmtThai, timeEl, utcToServer, thaiDayKey, thaiDateInputToUtc,
  duration, downloadCsv, errorState, loadingState, emptyState, debounce, toneOf, field } from '../util.js';
import { app, currentBot, on, ownsBot } from '../state.js';
import { prepareRows, pairTrades, moduleStats, dailyPnl, equitySeries, journalCsvRows, JOURNAL_HEADER, MODULES,
  EVENT_LABELS, REASON_LABELS } from '../journal.js';
import { modChip, sideEl, panel, pageHead, noBotState } from '../views.js';
import { prefs } from '../state.js';

const CHART_CDN = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/auto/+esm';
let chartMod = null;
async function loadChart() {
  if (!chartMod) chartMod = import(CHART_CDN).then((m) => m.default || m.Chart);
  return chartMod;
}

const DAY = 86400000;
const TABS = [{ id: 'overview', label: 'ภาพรวม' }, { id: 'trades', label: 'รายการเทรด' }, { id: 'journal', label: 'บันทึกทั้งหมด' }];

export async function render(root, ctx) {
  const bot = currentBot();
  if (!bot) { root.append(pageHead('ประวัติ', null, null, 'history'), noBotState()); return; }
  const off = bot.server_utc_offset_min ?? 0;
  const cur = 'บัญชี';
  let rows = [], loadedAll = false;
  const today = thaiDayKey(Date.now());
  const ago = (d) => thaiDayKey(Date.now() - d * DAY);
  const f = { from: ago(29), to: today, module: '', event: '', serverDay: '' };
  let tab = TABS.some((t) => t.id === ctx.query.get('tab')) ? ctx.query.get('tab') : prefs.get('history-tab', 'overview');
  let chart = null;
  let journalShown = 100;

  root.append(pageHead('ประวัติ', h('span', { class: 'row gap wrap' }, h('strong', { class: 'bot-name' }, bot.name),
    ownsBot(bot) ? null : h('span', { class: 'chip live' }, icon('eye'), `ของ ${bot.owner_name || 'สมาชิก'}`),
    h('span', null, 'ทุกไม้ กราฟพอร์ต และปฏิทินกำไรรายวัน')), null, 'history'));
  // view tabs, then one filter bar (labelled 44 px controls on the 12-column grid), then the view
  const filterBox = h('div', { class: 'filters', role: 'group', 'aria-label': 'ตัวกรอง' });
  const tabsBox = h('div', { class: 'segmented', role: 'tablist', 'aria-label': 'มุมมอง' });
  const body = h('div', { class: 'stack-lg' });
  root.append(h('div', { class: 'view-tabs' }, tabsBox), filterBox, body);
  body.append(loadingState('กำลังโหลดบันทึก…'));

  async function load(all) {
    const fromServer = all ? null : utcToServer(Date.now() - 95 * DAY, off).replace(/\./g, '-').replace(' ', 'T');
    const raw = await ctx.api.journal(bot.id, { fromServer });
    rows = prepareRows(raw, off);
    loadedAll = !!all;
  }

  try { await load(false); } catch (e) { body.replaceChildren(errorState(e, () => ctx.route())); return; }

  // ---------------- filters
  const fromIn = h('input', { class: 'input', type: 'date', value: f.from });
  const toIn = h('input', { class: 'input', type: 'date', value: f.to });
  const modSel = h('select', { class: 'input select' }, h('option', { value: '' }, 'ทุกสูตร'), MODULES.map((m) => h('option', { value: m }, m)));
  // the event filter only applies to "บันทึกทั้งหมด", so it sits in that panel's head
  const evSel = h('select', { class: 'input select ev-sel', 'aria-label': 'เหตุการณ์' }, h('option', { value: '' }, 'ทุกเหตุการณ์'));
  const fillEvents = () => {
    const evs = [...new Set(rows.map((r) => r.event))].sort();
    mount(evSel, h('option', { value: '' }, 'ทุกเหตุการณ์'), evs.map((e) => h('option', { value: e, selected: e === f.event }, `${EVENT_LABELS[e] || e} (${e})`)));
  };
  fillEvents();
  const quickBtns = [];
  const quick = (label, days) => { const b = h('button', {
    type: 'button', role: 'radio', dataset: { days: String(days) },
    onclick: async () => {
      f.to = today; f.serverDay = '';
      f.from = days ? ago(days - 1) : '';
      fromIn.value = f.from; toIn.value = f.to;
      if (!days && !loadedAll) { body.replaceChildren(loadingState()); await safeLoad(true); }
      draw();
    },
  }, label); quickBtns.push(b); return b; };
  // the quick range that matches the dates (none when the dates were typed)
  const markQuick = () => quickBtns.forEach((b) => {
    const d = Number(b.dataset.days);
    const on = f.to === today && (d ? f.from === ago(d - 1) : !f.from);
    b.className = on ? 'on' : ''; b.setAttribute('aria-checked', on ? 'true' : 'false');
  });
  async function safeLoad(all) {
    try { await load(all); fillEvents(); } catch (e) { body.replaceChildren(errorState(e, () => ctx.route())); throw e; }
  }
  const onFilter = debounce(async () => {
    f.from = fromIn.value; f.to = toIn.value; f.module = modSel.value; f.event = evSel.value; f.serverDay = '';
    if (!loadedAll && f.from && thaiDateInputToUtc(f.from) < Date.now() - 94 * DAY) { body.replaceChildren(loadingState()); try { await safeLoad(true); } catch { return; } }
    journalShown = 100;
    draw();
  }, 200);
  [fromIn, toIn, modSel, evSel].forEach((el) => el.addEventListener('change', onFilter));
  const fld = (label, ctrl, cls) => { const w = field(label, ctrl, { cls }); return w; };
  const modField = fld('สูตร', modSel, 'f-sel');
  filterBox.append(
    fld('ตั้งแต่', fromIn, 'f-date f-half'), fld('ถึง', toIn, 'f-date f-half'),
    h('div', { class: 'field f-range' }, h('span', { class: 'label' }, 'ช่วงเวลา'),
      h('div', { class: 'segmented wide', role: 'radiogroup', 'aria-label': 'ช่วงเวลา' }, quick('7 วัน', 7), quick('30 วัน', 30), quick('ทั้งหมด', 0))),
    modField);

  const drawTabs = () => tabsBox.replaceChildren(...TABS.map((t) => h('button', {
    type: 'button', role: 'tab', 'aria-selected': tab === t.id ? 'true' : 'false', class: tab === t.id ? 'on' : '',
    onclick: () => { tab = t.id; prefs.set('history-tab', tab); drawTabs(); draw(); },
  }, t.label)));
  drawTabs();

  // ---------------- filtering
  function range() {
    const a = f.from ? thaiDateInputToUtc(f.from) : -Infinity;
    const b = f.to ? thaiDateInputToUtc(f.to, true) : Infinity;
    return [a, b];
  }
  function filtered(useEvent) {
    const [a, b] = range();
    return rows.filter((r) => r.utc >= a && r.utc <= b && (!f.module || r.tag === f.module) && (!useEvent || !f.event || r.event === f.event));
  }

  // Trades are paired over ALL rows of the module (so a trade crossing the range edge stays whole), then kept when
  // they closed (or, still open, opened) inside the range. A calendar click narrows to one server day.
  function tradesInRange() {
    const [a, b] = range();
    return pairTrades(rows.filter((r) => !f.module || r.tag === f.module)).filter((t) => {
      if (f.serverDay) return !t.open && t.day === f.serverDay;
      const at = t.open ? t.openUtc : t.closeUtc;
      return at >= a && at <= b;
    });
  }

  function draw() {
    if (chart) { chart.destroy(); chart = null; }
    markQuick();
    const all = filtered(false);
    const trades = tradesInRange();
    if (!rows.length) {
      body.replaceChildren(emptyState('ยังไม่มีบันทึก', 'เมื่อ EA เริ่มทำงานและเอเจนต์ส่งบันทึกขึ้นมา รายการจะขึ้นที่นี่'));
      return;
    }
    if (tab === 'overview') drawOverview(all, trades);
    else if (tab === 'trades') drawTrades(trades);
    else drawJournal(filtered(true));
  }

  // ---------------- overview
  function drawOverview(all, trades) {
    const stats = moduleStats(trades);
    const closed = trades.filter((t) => !t.open);
    if (!closed.length) {
      body.replaceChildren(emptyState('ไม่มีเทรดที่ปิดแล้วในช่วงนี้', 'ลองขยายช่วงวันที่ หรือเลือก "ทั้งหมด"'));
      return;
    }
    const chartBox = h('div', { class: 'chart-box' }, loadingState('กำลังวาดกราฟ…'));
    const series = equitySeries(all);
    body.replaceChildren(
      statsPanel(stats),
      panel('กราฟพอร์ตจำลอง', { sub: 'ยอดพอร์ตที่บอทนับเอง หลังปิดแต่ละไม้' }, chartBox,
        h('details', { class: 'table-view' }, h('summary', null, 'ดูเป็นตาราง'),
          h('div', { class: 'table-wrap' }, h('table', { class: 'rtable compact' },
            h('thead', null, h('tr', null, ['เวลา', 'สูตร', 'กำไร', 'พอร์ตจำลอง'].map((t) => h('th', { scope: 'col' }, t)))),
            h('tbody', null, series.slice().reverse().slice(0, 200).map((p) => h('tr', null,
              h('td', { 'data-label': 'เวลา' }, timeEl(p.utc, off)), h('td', { 'data-label': 'สูตร' }, p.tag),
              h('td', { 'data-label': 'กำไร', class: 'num' }, pnl(p.pnl)), h('td', { 'data-label': 'พอร์ตจำลอง', class: 'num' }, fmtNum(p.v))))))))),
      calendarPanel(all));
    drawChart(chartBox, series);
  }

  function statsPanel(stats) {
    const head = ['สูตร', 'เทรด', 'อัตราชนะ', 'สุทธิ', 'เฉลี่ยชนะ', 'เฉลี่ยแพ้', 'Profit factor', 'ดีที่สุด', 'แย่ที่สุด'];
    const line = (label, s, isTotal) => h('tr', { class: isTotal ? 'total' : '' },
      h('td', { 'data-label': 'สูตร' }, isTotal ? h('strong', null, label) : modChip(label)),
      h('td', { 'data-label': 'เทรด', class: 'num' }, `${s.trades} (${s.wins}/${s.losses})`),
      h('td', { 'data-label': 'อัตราชนะ', class: 'num' }, s.winRate === null ? '—' : fmtPct(s.winRate, 0)),
      h('td', { 'data-label': 'สุทธิ', class: 'num' }, pnl(s.net)),
      h('td', { 'data-label': 'เฉลี่ยชนะ', class: 'num' }, s.avgWin === null ? '—' : pnl(s.avgWin)),
      h('td', { 'data-label': 'เฉลี่ยแพ้', class: 'num' }, s.avgLoss === null ? '—' : pnl(s.avgLoss)),
      h('td', { 'data-label': 'Profit factor', class: 'num' }, s.profitFactor === null ? '—' : s.profitFactor === Infinity ? '∞' : fmtNum(s.profitFactor)),
      h('td', { 'data-label': 'ดีที่สุด', class: 'num' }, s.best === null ? '—' : pnl(s.best)),
      h('td', { 'data-label': 'แย่ที่สุด', class: 'num' }, s.worst === null ? '—' : pnl(s.worst)));
    return panel('สรุปตามสูตร', { sub: 'นับเฉพาะไม้ที่ปิดแล้วในช่วงที่เลือก' },
      h('div', { class: 'table-wrap' }, h('table', { class: 'rtable' },
        h('thead', null, h('tr', null, head.map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', null, stats.rows.map((s) => line(s.module, s)), line('รวม', stats.total, true)))));
  }

  async function drawChart(box, series) {
    if (series.length < 2) { box.replaceChildren(h('p', { class: 'muted' }, 'ต้องมีไม้ที่ปิดแล้วอย่างน้อย 2 ไม้จึงจะวาดกราฟได้')); return; }
    let Chart;
    try { Chart = await loadChart(); } catch {
      box.replaceChildren(h('p', { class: 'muted' }, 'โหลดไลบรารีกราฟ (Chart.js) ไม่ได้ ดูตัวเลขได้จากตารางด้านล่าง'));
      return;
    }
    if (!box.isConnected) return;
    const dayLabel = new Intl.DateTimeFormat('th-TH-u-ca-gregory', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short' });
    const narrow = box.clientWidth < 520;
    // resolve tokens (some are color-mix()) to plain rgba() for the canvas: a fresh probe element per token (a reused one
    // can return a stale computed colour), then a 1x1 canvas turns any CSS colour syntax into rgba()
    const font = getComputedStyle(document.documentElement).getPropertyValue('--font-ui').trim();
    const numFont = getComputedStyle(document.documentElement).getPropertyValue('--font-num').trim();
    const col = (n) => {
      const probe = h('span', { style: { position: 'absolute', visibility: 'hidden', color: `var(${n})` } });
      document.body.append(probe);
      const c = getComputedStyle(probe).color;
      probe.remove();
      const cv = document.createElement('canvas'); cv.width = cv.height = 1;
      const cx = cv.getContext('2d', { willReadFrequently: true });
      if (!cx) return c;
      cx.fillStyle = c; cx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = cx.getImageData(0, 0, 1, 1).data;
      return `rgba(${r}, ${g}, ${b}, ${Math.round((a / 255) * 100) / 100})`;
    };
    const C = { line: col('--gold-ink'), ink: col('--ink'), slate: col('--slate'), hair: col('--hair'), sheet: col('--inverse'), onSheet: col('--on-inverse') };
    const canvas = h('canvas', { role: 'img', 'aria-label': `กราฟพอร์ตจำลอง จาก ${fmtNum(series[0].v)} ถึง ${fmtNum(series[series.length - 1].v)}` });
    box.replaceChildren(canvas);
    if (chart) chart.destroy();
    chart = new Chart(canvas, {
      type: 'line',
      data: {
        labels: series.map((p) => dayLabel.format(new Date(p.utc))),
        datasets: [{
          label: 'พอร์ตจำลอง', data: series.map((p) => p.v), borderColor: C.line, backgroundColor: C.line,
          borderWidth: 1.8, pointRadius: 0, pointHoverRadius: 4, pointHitRadius: 12, tension: 0, borderJoinStyle: 'round',
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: C.sheet, titleColor: C.onSheet, bodyColor: C.onSheet, borderWidth: 0, cornerRadius: 10,
            padding: 10, displayColors: false,
            titleFont: { family: font, weight: '600' }, bodyFont: { family: numFont },
            callbacks: {
              title: (items) => fmtThai(series[items[0].dataIndex].utc, 'datetime'),
              label: (item) => `พอร์ตจำลอง ${fmtNum(item.parsed.y)}`,
              afterLabel: (item) => { const p = series[item.dataIndex]; return `${p.tag} ${fmtSigned(p.pnl)}`; },
            },
          },
        },
        scales: {
          x: { ticks: { color: C.slate, maxTicksLimit: narrow ? 4 : 6, maxRotation: 0, autoSkipPadding: 18, font: { family: font, size: 12 } }, grid: { display: false }, border: { color: C.hair } },
          y: { position: 'right', ticks: { color: C.slate, font: { family: numFont, size: 12 } }, grid: { color: C.hair }, border: { display: false } },
        },
      },
    });
  }

  function calendarPanel(all) {
    const days = dailyPnl(all);
    if (!days.size) return panel('ปฏิทินกำไรรายวัน', {}, h('p', { class: 'muted' }, 'ไม่มีไม้ที่ปิดในช่วงนี้'));
    const keys = [...days.keys()].sort();
    const maxAbs = Math.max(...[...days.values()].map((d) => Math.abs(d.pnl)), 1);
    const months = [];
    const first = new Date(keys[0] + 'T00:00:00Z'), last = new Date(keys[keys.length - 1] + 'T00:00:00Z');
    for (let y = first.getUTCFullYear(), m = first.getUTCMonth(); y < last.getUTCFullYear() || (y === last.getUTCFullYear() && m <= last.getUTCMonth()); m === 11 ? (y++, m = 0) : m++) months.push([y, m]);
    const wd = ['จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส', 'อา'];
    const monthEl = ([y, m]) => {
      const start = Date.UTC(y, m, 1);
      const lead = (new Date(start).getUTCDay() + 6) % 7;
      const n = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      const cells = [];
      for (let i = 0; i < lead; i++) cells.push(h('span', { class: 'cal-cell blank', 'aria-hidden': 'true' }));
      for (let d = 1; d <= n; d++) {
        const key = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const v = days.get(key);
        const dow = (lead + d - 1) % 7;
        if (!v) { cells.push(h('span', { class: `cal-cell none${dow >= 5 ? ' wkend' : ''}` }, h('span', { class: 'cal-d' }, String(d)))); continue; }
        const lvl = Math.max(1, Math.ceil((Math.abs(v.pnl) / maxAbs) * 4));
        const label = `${d} ${fmtThai(Date.UTC(y, m, d, 5), 'month')}: ${fmtSigned(v.pnl)} จาก ${v.trades} ไม้ (ชนะ ${v.wins})`;
        cells.push(h('button', {
          type: 'button', class: `cal-cell ${v.pnl >= 0 ? 'pos' : 'neg'} l${lvl}`, title: label, 'aria-label': label,
          onclick: () => { f.serverDay = key; tab = 'trades'; drawTabs(); draw(); },
        }, h('span', { class: 'cal-d' }, String(d)), h('span', { class: 'cal-v' }, fmtSigned(v.pnl, 0))));
      }
      return h('div', { class: 'cal-month' }, h('h3', null, fmtThai(Date.UTC(y, m, 15), 'month')),
        h('div', { class: 'cal-grid' }, wd.map((w) => h('span', { class: 'cal-wd', 'aria-hidden': 'true' }, w)), cells));
    };
    return panel('ปฏิทินกำไรรายวัน', { sub: 'แบ่งวันตามเวลาเซิร์ฟเวอร์ (วันเดียวกับจุดหยุดรายวันของ EA) กดวันที่เพื่อดูเทรดของวันนั้น' },
      h('div', { class: 'cal' }, months.map(monthEl)),
      h('div', { class: 'cal-legend', 'aria-hidden': 'true' },
        h('span', null, 'ขาดทุน'), [4, 3, 2, 1].map((l) => h('span', { class: `cal-key neg l${l}` })),
        h('span', { class: 'cal-key none' }), [1, 2, 3, 4].map((l) => h('span', { class: `cal-key pos l${l}` })), h('span', null, 'กำไร')));
  }

  // ---------------- trades
  function drawTrades(trades) {
    const list = trades.slice().reverse();
    const csvBtn = h('button', { class: 'btn small', type: 'button', disabled: !list.length, onclick: () => exportTrades(list) }, icon('download'), 'ส่งออก CSV');
    if (!list.length) { body.replaceChildren(panel('รายการเทรด', { actions: csvBtn }, h('p', { class: 'muted' }, 'ไม่มีเทรดในช่วงนี้'), f.serverDay ? h('button', { class: 'btn small', type: 'button', onclick: () => { f.serverDay = ''; draw(); } }, 'ดูทั้งช่วง') : null)); return; }
    const dayChip = f.serverDay ? h('div', { class: 'row gap wrap' }, h('span', { class: 'chip pending' }, `เฉพาะวันที่ ${f.serverDay} (เวลาเซิร์ฟเวอร์)`),
      h('button', { class: 'btn small ghost', type: 'button', onclick: () => { f.serverDay = ''; draw(); } }, icon('x'), 'ดูทั้งช่วง')) : null;
    body.replaceChildren(panel('รายการเทรด', { actions: csvBtn, sub: `${list.length} ไม้ จับคู่เปิดกับปิดของแต่ละสูตรตามลำดับเวลา` }, dayChip,
      h('div', { class: 'table-wrap' }, h('table', { class: 'rtable' },
        h('thead', null, h('tr', null, ['เปิด', 'สูตร', 'ฝั่ง', 'ล็อต', 'ราคาเข้า', 'ราคาออก', 'ผล', 'ถือ', 'กำไร'].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', null, list.map((t) => h('tr', { class: t.open ? 'open-row' : '' },
          h('td', { 'data-label': 'เปิด' }, Number.isFinite(t.openUtc) ? timeEl(t.openUtc, off) : '—'),
          h('td', { 'data-label': 'สูตร' }, modChip(t.module), t.step ? h('span', { class: 'muted small' }, ` ไม้แก้ ${t.step}`) : null),
          h('td', { 'data-label': 'ฝั่ง' }, sideEl(t.side)),
          h('td', { 'data-label': 'ล็อต', class: 'num' }, fmtNum(t.lots)),
          h('td', { 'data-label': 'ราคาเข้า', class: 'num' }, fmtNum(t.openPrice)),
          h('td', { 'data-label': 'ราคาออก', class: 'num' }, t.open ? '—' : fmtNum(t.closePrice)),
          h('td', { 'data-label': 'ผล' }, t.open ? h('span', { class: 'chip pending' }, 'ยังเปิดอยู่')
            : [REASON_LABELS[t.reason] || t.reason || '—', t.events.includes('LOCK') || t.events.includes('LOCK1') ? h('span', { class: 'muted small' }, ' (มีล็อก)') : null]),
          h('td', { 'data-label': 'ถือ' }, !t.open && Number.isFinite(t.openUtc) ? duration(t.closeUtc - t.openUtc) : '—'),
          h('td', { 'data-label': 'กำไร', class: 'num' }, t.open ? '—' : pnl(t.pnl)))))))));
  }

  function exportTrades(list) {
    downloadCsv(`dobby_trades_${safe(bot.name)}_${f.serverDay || `${f.from || 'all'}_${f.to || 'all'}`}.csv`,
      ['open_thai', 'close_thai', 'open_server', 'close_server', 'module', 'side', 'lots', 'entry', 'exit', 'pnl', 'reason', 'minutes', 'v_balance'],
      list.map((t) => [
        Number.isFinite(t.openUtc) ? fmtThai(t.openUtc, 'seconds') : '', t.open ? '' : fmtThai(t.closeUtc, 'seconds'),
        Number.isFinite(t.openUtc) ? utcToServer(t.openUtc, off, true) : '', t.open ? '' : utcToServer(t.closeUtc, off, true),
        t.module, t.side, t.lots, t.openPrice, t.open ? '' : t.closePrice, t.open ? '' : t.pnl, t.open ? 'OPEN' : t.reason,
        !t.open && Number.isFinite(t.openUtc) ? Math.round((t.closeUtc - t.openUtc) / 60000) : '', t.vBalance ?? '',
      ]));
  }

  // ---------------- journal
  function drawJournal(list) {
    const desc = list.slice().reverse();
    const csvBtn = h('button', {
      class: 'btn small', type: 'button', disabled: !desc.length,
      onclick: () => downloadCsv(`dobby_journal_${safe(bot.name)}_${f.from || 'all'}_${f.to || 'all'}.csv`, JOURNAL_HEADER, journalCsvRows(list)),
    }, icon('download'), 'ส่งออก CSV');
    if (!desc.length) { body.replaceChildren(panel('บันทึกทั้งหมด', { actions: h('div', { class: 'panel-actions' }, evSel, csvBtn) }, h('p', { class: 'muted' }, 'ไม่มีบันทึกตามตัวกรองนี้'))); return; }
    const shown = desc.slice(0, journalShown);
    body.replaceChildren(panel('บันทึกทั้งหมด', { actions: h('div', { class: 'panel-actions' }, evSel, csvBtn), sub: `${desc.length} แถว เวลาไทย (ชี้ที่เวลาเพื่อดูเวลาเซิร์ฟเวอร์)` },
      h('div', { class: 'table-wrap' }, h('table', { class: 'rtable journal' },
        h('thead', null, h('tr', null, ['เวลา', 'เหตุการณ์', 'สูตร', 'ฝั่ง', 'ล็อต', 'ราคา', 'SL', 'TP', 'กำไร', 'พอร์ตจำลอง', 'รายละเอียด'].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', null, shown.map((r) => h('tr', { class: `ev-${r.event.toLowerCase()}` },
          h('td', { 'data-label': 'เวลา' }, timeEl(r.utc, off, 'seconds')),
          h('td', { 'data-label': 'เหตุการณ์' }, h('span', { class: `ev ev-${evTone(r.event)}`, title: r.event }, EVENT_LABELS[r.event] || r.event)),
          h('td', { 'data-label': 'สูตร' }, r.tag || '—'),
          h('td', { 'data-label': 'ฝั่ง' }, r.side && r.side !== 'NONE' ? sideEl(r.side) : '—'),
          h('td', { 'data-label': 'ล็อต', class: 'num' }, r.lots ? fmtNum(r.lots) : '—'),
          h('td', { 'data-label': 'ราคา', class: 'num' }, r.price ? fmtNum(r.price) : '—'),
          h('td', { 'data-label': 'SL', class: 'num opt' }, r.sl ? fmtNum(r.sl) : '—'),
          h('td', { 'data-label': 'TP', class: 'num opt' }, r.tp ? fmtNum(r.tp) : '—'),
          h('td', { 'data-label': 'กำไร', class: 'num' }, r.event === 'CLOSE' ? pnl(r.pnl) : '—'),
          h('td', { 'data-label': 'พอร์ตจำลอง', class: 'num opt' }, fmtNum(r.v_balance)),
          h('td', { 'data-label': 'รายละเอียด', class: 'detail' }, r.detail || '')))))),
      desc.length > journalShown ? h('div', { class: 'row center' }, h('button', {
        class: 'btn', type: 'button', onclick: () => { journalShown += 200; draw(); },
      }, `แสดงเพิ่ม (เหลืออีก ${desc.length - journalShown} แถว)`)) : null));
  }

  draw();

  // realtime: new journal rows
  const addRow = debounce(() => { fillEvents(); draw(); }, 600);
  const unsub = ctx.api.subscribeBot(bot.id, {
    journal: (row) => { rows = prepareRows([...rows, row], off); if (tab !== 'overview' || !chart) addRow(); else addRow(); },
  });
  const offTheme = on('theme', () => { if (tab === 'overview') draw(); });
  return () => { unsub(); offTheme(); if (chart) chart.destroy(); };
}

function evTone(e) {
  if (e === 'CLOSE' || e === 'OPEN') return 'trade';
  if (e.startsWith('LOCK') || e.startsWith('NEAR') || e.startsWith('SHADOW')) return 'lock';
  if (e === 'ERROR' || e === 'DAYCAP') return 'bad';
  if (e === 'CONTROL' || e === 'REMOTE' || e === 'START' || e === 'STOP') return 'sys';
  return 'other';
}

const safe = (s) => String(s || 'bot').replace(/[^\p{L}\p{M}\p{N}_-]+/gu, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
