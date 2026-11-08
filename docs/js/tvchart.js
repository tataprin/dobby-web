// Gold chart from TradingView: an extra view on ภาพรวม next to the hero line (which draws the broker's own M15 bars with
// Dobby's trades on them). Security: this page holds the Supabase session, so no TradingView script runs here. The
// chart is TradingView's own widget page inside a cross-origin, sandboxed <iframe> (no top navigation, no access to
// this page), configured through the URL hash the way their embed script does it. It loads when the panel first comes
// near the screen and is rebuilt when the timeframe or the site theme changes.
import { h, mount, icon } from './util.js';
import { prefs, on } from './state.js';
import { panel, segmented } from './views.js';

const HOST = 'https://www.tradingview-widget.com';
const SYMBOL = 'OANDA:XAUUSD'; // TradingView has no TMGM feed; OANDA's spot gold is the usual free widget source
const FULL_CHART = 'https://www.tradingview.com/chart/?symbol=OANDA%3AXAUUSD';
const INTERVALS = [
  { value: '15', label: '15 นาที' },
  { value: '60', label: '1 ชม.' },
  { value: '240', label: '4 ชม.' },
  { value: 'D', label: '1 วัน' },
];

// a site token as "rgb(r, g, b)" / "rgba(r, g, b, a)" (a fresh probe each time: a reused one can return a stale colour)
function token(name, alpha = 1) {
  const p = h('span', { style: { color: `var(${name})`, display: 'none' } });
  document.body.append(p);
  const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(getComputedStyle(p).color);
  p.remove();
  if (!m) return '';
  return alpha === 1 ? `rgb(${m[1]}, ${m[2]}, ${m[3]})` : `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${alpha})`;
}

const siteTheme = () => (getComputedStyle(document.documentElement).colorScheme === 'dark' ? 'dark' : 'light');

function widgetUrl(interval, theme) {
  const up = token('--jade'), down = token('--cinnabar');
  const cfg = {
    autosize: true, symbol: SYMBOL, interval, timezone: 'Asia/Bangkok', theme, style: '1', locale: 'th_TH',
    backgroundColor: token('--sheet'), gridColor: token('--slate', 0.1),
    allow_symbol_change: false, hide_top_toolbar: true, hide_side_toolbar: true, hide_volume: true,
    save_image: false, calendar: false, details: false, withdateranges: false,
    support_host: 'https://www.tradingview.com',
  };
  if (up && down) {
    cfg.overrides = {
      'mainSeriesProperties.candleStyle.upColor': up, 'mainSeriesProperties.candleStyle.downColor': down,
      'mainSeriesProperties.candleStyle.borderUpColor': up, 'mainSeriesProperties.candleStyle.borderDownColor': down,
      'mainSeriesProperties.candleStyle.wickUpColor': up, 'mainSeriesProperties.candleStyle.wickDownColor': down,
    };
  }
  return `${HOST}/embed-widget/advanced-chart/?locale=th_TH#${encodeURIComponent(JSON.stringify(cfg))}`;
}

export function tvChartPanel() {
  let interval = INTERVALS.some((o) => o.value === prefs.get('tv-interval')) ? prefs.get('tv-interval') : '15';
  let shown = false, theme = '';
  const wait = h('p', { class: 'tv-wait' }, 'กำลังโหลดกราฟจาก TradingView…');
  const frame = h('div', { class: 'tv-frame' }, wait);
  const seg = segmented({
    label: 'ช่วงเวลาของแท่งราคา', options: INTERVALS, get: () => interval,
    set: (v) => { if (v === interval) return; interval = v; prefs.set('tv-interval', v); seg.update(); load(); },
  });
  const el = panel('กราฟทองจาก TradingView', {
    cls: 'tv-panel', actions: seg, sub: 'ราคาจาก OANDA อาจต่างจากราคาที่โบรกของบอทเล็กน้อย',
  }, frame, h('div', { class: 'tv-foot' },
    h('p', { class: 'muted small' }, 'จุดเข้าออกของบอทดูได้ที่กราฟด้านบน'),
    h('a', { class: 'link-quiet tv-out', href: FULL_CHART, target: '_blank', rel: 'noopener noreferrer' }, 'เปิดใน TradingView', icon('external'))));

  function load() {
    shown = true;
    theme = siteTheme();
    wait.hidden = false;
    const f = h('iframe', {
      class: 'tv-iframe', title: 'กราฟราคาทอง XAUUSD จาก TradingView', src: widgetUrl(interval, theme),
      sandbox: 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox',
      referrerpolicy: 'no-referrer', scrolling: 'no', frameborder: '0',
      onload: () => { wait.hidden = true; },
    });
    mount(frame, wait, f);
  }

  // first load when the panel comes near the screen (a phone on mobile data never fetches it unless it scrolls down)
  const io = typeof IntersectionObserver === 'function' ? new IntersectionObserver((ents) => {
    if (ents.some((e) => e.isIntersecting)) { io.disconnect(); if (!shown) load(); }
  }, { rootMargin: '240px 0px' }) : null;
  if (io) io.observe(el); else setTimeout(load, 0);
  const offTheme = on('theme', () => { if (shown && siteTheme() !== theme) load(); });
  el.destroy = () => { if (io) io.disconnect(); offTheme(); };
  return el;
}
