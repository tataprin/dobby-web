// Dobby Web layout audit (dev only; the app never loads this file).
// Run in the page (demo mode), e.g. from DevTools or the built-in browser's javascript tool:
//   await import('./dev/layout-audit.js'); const r = await window.__layoutAudit(); r.summary
// Options: __layoutAudit({ routes: ['dashboard', ...], themes: ['light', 'dark'], wait: 1400 })
// Checks every route at the current viewport width, in each theme:
//   rowHeights  boxes (panels, cards, stat cells) side by side in one visual row whose heights differ by > 2 px
//   edges       top-level boxes whose left / right edge is not on the content column or a 12-column grid line
//   fontSize    text below 13 px (chart axis labels in .pc-svg and the hallmark emblem excepted); SVG text is
//               measured at its rendered size (font-size x the SVG's scale)
//   controls    .btn not 40 / 48 px, .icon-btn not 40, inputs / selects not 44, segmented not 44, steppers not 44,
//               chips not 28, switches not 28, any other <button> / input whose height is not in the standard set
//   overflow    horizontal page overflow (document wider than the viewport)
//   contrast    text below 4.5:1 (3:1 for large text) against its composited background; disabled controls skipped
//   clipped     text cut off: scrollWidth > clientWidth on an element that hides or spills its overflow
//   overlap     children of a grid / flex container that run into each other (content wider than its track)
//   gaps        neighbours in one row of a CSS grid that are not exactly one column-gap apart
// Special routes: 'login' (signs the demo out and back in), 'nobot' (demo account without bots), 'dialogs'
// (welcome tour, a confirm dialog, a sheet with a form, a toast).
(() => {
  const TOL = 1.5;
  const BOX = ['.panel', '.fig', '.machine', '.group', '.hero', '.g-sec', '.g-toc', '.news-day', '.filters', '.audit-filters', '.dl-hero',
    '.add-machine', '.teach-empty', '.state.empty', '.state.error', '.pgroup', '.upgrade-box', '.auth-card', '.ab-inner'].join(',');
  const ROW_BOX = ['.panel', '.fig', '.machine', '.g-sec', '.news-day', '.pgroup', '.pos-fact', '.machine-facts > div', '.now-item', '.kpi', '.g-risk-box', '.create-opt', '.cal-month'].join(',');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (el) => {
    if (!el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.contentVisibility === 'hidden') return false;
      if (cs.clip && cs.clip.startsWith('rect(0px')) return false; // visually hidden (sr-only, phone table heads)
      if (e.tagName === 'DETAILS' && !e.open && e !== el && !(el.closest('summary') && el.closest('details') === e)) return false;
    }
    return true;
  };
  const path = (el) => {
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && parts.length < 4 && e.id !== 'main'; e = e.parentElement) {
      let s = e.tagName.toLowerCase();
      if (e.classList.length) s += '.' + [...e.classList].slice(0, 3).join('.');
      parts.unshift(s);
    }
    return parts.join(' > ');
  };
  const label = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 48);

  // colours: normalise any CSS colour (rgb, color(srgb), color-mix results) through a 1x1 canvas
  const cv = document.createElement('canvas'); cv.width = cv.height = 1;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  const rgba = (c) => {
    if (!c || c === 'transparent') return [0, 0, 0, 0];
    cx.clearRect(0, 0, 1, 1); cx.fillStyle = 'rgba(0,0,0,0)'; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1);
    const d = cx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  };
  const over = (top, bot) => { const a = top[3] + bot[3] * (1 - top[3]); if (!a) return [0, 0, 0, 0]; return [0, 1, 2].map((i) => (top[i] * top[3] + bot[i] * bot[3] * (1 - top[3])) / a).concat(a); };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const bgOf = (el) => {
    const chain = [];
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) chain.push(e);
    let bg = rgba(getComputedStyle(document.documentElement).backgroundColor);
    if (bg[3] < 1) bg = over(bg, [255, 255, 255, 1]);
    for (let i = chain.length - 1; i >= 0; i--) {
      const cs = getComputedStyle(chain[i]);
      if (chain[i].tagName === 'DIALOG' && chain[i].open) bg = [255, 255, 255, 1];
      const c = rgba(cs.backgroundColor);
      if (c[3] > 0) bg = over(c, bg);
    }
    return bg;
  };
  const opacityOf = (el) => { let o = 1; for (let e = el; e && e.nodeType === 1; e = e.parentElement) o *= Number(getComputedStyle(e).opacity); return o; };
  const textNodesOf = (el) => [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.replace(/[\s​⁠]/g, '').length > 0);

  function contentBox() {
    const m = document.querySelector('main#main');
    if (!m) return null;
    const r = m.getBoundingClientRect(), cs = getComputedStyle(m);
    const L = r.left + parseFloat(cs.paddingLeft), R = r.right - parseFloat(cs.paddingRight);
    const g = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--gutter')) || 16;
    const cw = (R - L - 11 * g) / 12;
    const lefts = [], rights = [];
    for (let k = 0; k < 12; k++) { lefts.push(L + k * (cw + g)); rights.push(L + k * (cw + g) + cw); }
    return { main: m, L, R, g, cw, lefts, rights };
  }

  // measure end states: jump every finite CSS transition / animation (theme colour fades, dialog fade-in, the hero's
  // strike) to its end. A hidden or throttled page produces no frames, so they would otherwise stay at their start.
  function finishAnimations() {
    if (!document.getAnimations) return;
    for (const a of document.getAnimations()) {
      try { const t = a.effect && a.effect.getComputedTiming(); if (t && Number.isFinite(t.endTime)) a.finish(); } catch { /* infinite or detached */ }
    }
  }

  function checkPage(where) {
    finishAnimations();
    const bare = !!document.querySelector('main.bare');
    const out = [];
    const add = (check, el, detail) => out.push({ where, check, el: el ? path(el) : '', text: el ? label(el) : '', detail });
    const vw = document.documentElement.clientWidth;
    // overflow
    if (document.documentElement.scrollWidth > window.innerWidth + 0.5) add('overflow', null, `page ${document.documentElement.scrollWidth}px wide in a ${window.innerWidth}px viewport`);
    for (const el of document.querySelectorAll('body *')) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.right > vw + 1 && !el.closest('.table-wrap, .anchors, .pc-svg, dialog, .toasts, .sr-only, .skip') && getComputedStyle(el).position !== 'fixed') { add('overflow', el, `right edge ${Math.round(r.right)} > ${vw}`); break; }
    }
    const cb = contentBox();
    const scope = document.querySelector('dialog[open]') || (cb ? cb.main : document.body);
    // row heights: boxes sharing a parent and a top edge
    const groups = new Map();
    for (const el of scope.querySelectorAll(ROW_BOX)) {
      if (!visible(el)) continue;
      const p = el.parentElement; if (!groups.has(p)) groups.set(p, []);
      groups.get(p).push(el);
    }
    for (const [, list] of groups) {
      const rows = new Map();
      for (const el of list) { const t = Math.round(el.getBoundingClientRect().top); const k = [...rows.keys()].find((x) => Math.abs(x - t) <= 2); rows.has(k) ? rows.get(k).push(el) : rows.set(t, [el]); }
      for (const [, row] of rows) {
        if (row.length < 2) continue;
        const hs = row.map((e) => e.getBoundingClientRect().height);
        if (Math.max(...hs) - Math.min(...hs) > 2) add('rowHeights', row[0].parentElement, `heights ${hs.map((x) => Math.round(x)).join(' / ')} in one row`);
      }
    }
    // overlap: children of a grid / flex container that run into each other (content wider than its track)
    for (const box of scope.querySelectorAll('*')) {
      if (!visible(box)) continue;
      const d = getComputedStyle(box).display;
      if (!/grid|flex/.test(d)) continue;
      const kids = [...box.children].filter((k) => visible(k) && getComputedStyle(k).position !== 'absolute' && getComputedStyle(k).position !== 'fixed');
      for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) {
        const a = kids[i].getBoundingClientRect(), b = kids[j].getBoundingClientRect();
        const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left), oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (ox > 1.5 && oy > 1.5) { add('overlap', kids[j], `overlaps a sibling by ${Math.round(ox)} x ${Math.round(oy)} px`); i = kids.length; break; }
      }
    }
    // gaps: neighbours in one row of a CSS grid sit exactly one column-gap apart (a child wider than its track shrinks it)
    for (const box of scope.querySelectorAll('*')) {
      if (!visible(box)) continue;
      const cs = getComputedStyle(box);
      if (!/grid/.test(cs.display)) continue;
      const cg = parseFloat(cs.columnGap); if (!(cg > 0) || cs.justifyContent.includes('space')) continue;
      const kids = [...box.children].filter((k) => visible(k) && !['absolute', 'fixed'].includes(getComputedStyle(k).position));
      const rows = [];
      for (const k of kids) { const r = k.getBoundingClientRect(); const row = rows.find((x) => Math.abs(x.top - r.top) <= 2); row ? row.items.push(r) : rows.push({ top: r.top, items: [r] }); }
      for (const row of rows) {
        row.items.sort((x, y) => x.left - y.left);
        for (let i = 1; i < row.items.length; i++) {
          const g = row.items[i].left - row.items[i - 1].right;
          if (Math.abs(g - cg) > 1.5) { add('gaps', box, `gap ${Math.round(g)}px between grid items, column-gap is ${cg}px`); break; }
        }
      }
    }
    // edges: top-level boxes on the content column / grid lines
    if (cb && !bare && !document.querySelector('dialog[open]')) {
      const near = (x, arr) => arr.some((v) => Math.abs(v - x) <= TOL);
      for (const el of cb.main.querySelectorAll(BOX)) {
        if (!visible(el) || el.parentElement.closest(BOX) || el.closest('.anchors, .action-bar')) continue;
        const r = el.getBoundingClientRect();
        if (!near(r.left, cb.lefts) || !near(r.right, cb.rights)) add('edges', el, `x ${Math.round(r.left)}..${Math.round(r.right)} not on the grid (column ${Math.round(cb.L)}..${Math.round(cb.R)}, gutter ${cb.g})`);
      }
      // the header and banners share the column
      for (const sel of ['.topbar-in', '.demo-in']) {
        const el = document.querySelector(sel); if (!el || !visible(el)) continue;
        const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
        const l = r.left + parseFloat(cs.paddingLeft), rr = r.right - parseFloat(cs.paddingRight);
        if (Math.abs(l - cb.L) > TOL || Math.abs(rr - cb.R) > TOL) add('edges', el, `inner ${Math.round(l)}..${Math.round(rr)} vs column ${Math.round(cb.L)}..${Math.round(cb.R)}`);
      }
    }
    // text: size, contrast, clipping
    for (const el of scope.querySelectorAll('*')) {
      if (!visible(el) || el.closest('.sr-only')) continue;
      const tn = textNodesOf(el);
      const isSvgText = el instanceof SVGElement;
      if (!tn.length && !(isSvgText && el.tagName === 'text' && el.textContent.trim())) continue;
      const cs = getComputedStyle(el);
      let fs = parseFloat(cs.fontSize);
      if (isSvgText) {
        const svg = el.ownerSVGElement; if (!svg) continue;
        if (el.closest('.pc-svg') || el.closest('.hm-svg') || el.closest('.brand-mark')) continue; // chart axes, emblem
        const vb = svg.viewBox && svg.viewBox.baseVal; const w = svg.getBoundingClientRect().width;
        if (vb && vb.width) fs = fs * (w / vb.width);
        // guide / tour illustrations are scaled pictures of the UI (role="img" with a text alternative): reported apart
        if (fs < 12.5) add(el.closest('.g-art, .tour-art, .teach-art') ? 'illustration' : 'fontSize', el, `${fs.toFixed(1)}px rendered`);
        continue;
      }
      if (fs < 12.5 && !el.closest('.pc-svg')) add('fontSize', el, `${fs}px`);
      // contrast
      if (!el.closest('[disabled], [aria-disabled="true"], .sr-only, .pc-svg, canvas') && !(el.matches('option'))) {
        if (!el.isConnected || !cs.color) continue; // re-rendered while the check ran
        const col = rgba(cs.color); const bg = bgOf(el); const o = opacityOf(el);
        const fg = over([col[0], col[1], col[2], col[3] * o], bg);
        const big = fs >= 24 || (fs >= 18.66 && Number(cs.fontWeight) >= 600);
        const cr = ratio(fg, bg);
        if (cr < (big ? 3 : 4.5) - 0.01) add('contrast', el, `${cr.toFixed(2)}:1${o < 1 ? ` (opacity ${o.toFixed(2)})` : ''}`);
      }
      // clipped
      if (!el.matches('input, select, textarea, option') && !el.closest('.table-wrap, .anchors, .pc-svg')) {
        const ox = cs.overflowX;
        if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 && (ox !== 'visible' || cs.textOverflow === 'ellipsis')) add('clipped', el, `scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth}`);
      }
    }
    // controls
    const H = (el) => Math.round(el.getBoundingClientRect().height * 10) / 10;
    const want = (el, ok, what) => { const h = H(el); if (!ok.some((x) => Math.abs(x - h) <= 0.6)) add('controls', el, `${what} ${h}px (standard ${ok.join(' / ')})`); };
    for (const el of scope.querySelectorAll('.btn')) if (visible(el)) want(el, [40, 48], 'button');
    for (const el of scope.querySelectorAll('.icon-btn')) if (visible(el)) want(el, [40], 'icon button');
    for (const el of scope.querySelectorAll('input.input:not(.otp), select.input')) if (visible(el)) want(el, [44], 'input');
    for (const el of scope.querySelectorAll('input.otp')) if (visible(el)) want(el, [48], 'code input');
    for (const el of scope.querySelectorAll('.segmented')) if (visible(el)) want(el, [44], 'segmented');
    for (const el of scope.querySelectorAll('.stepper')) if (visible(el)) want(el, [44], 'stepper');
    for (const el of scope.querySelectorAll('.chip')) if (visible(el)) want(el, [28], 'chip');
    for (const el of scope.querySelectorAll('.switch, .toggle, .liveswitch .track')) if (visible(el)) want(el, [28], 'switch');
    for (const el of document.querySelectorAll('.botpick-field, .botname')) if (visible(el)) want(el, [40], 'header control');
    for (const el of scope.querySelectorAll('button, input:not([type=hidden]), select')) {
      if (!visible(el) || el.matches('.btn, .icon-btn, .input, .switch, .toggle, .liveswitch, .botpick-select, input[type=checkbox], input[type=radio], input[type=file]')) continue;
      if (el.closest('.segmented, .stepper')) continue; // segments and +/- are parts of a 44 px control
      if (el.matches('.tab-link, .login-tabs button, .ab-count, .linklike, .cal-cell')) continue; // nav tabs, text buttons, calendar days
      add('controls', el, `unclassified control ${H(el)}px`);
    }
    // icons: one size (20) except 16 inline in chips / small text and the 22 px tab bar
    for (const el of scope.querySelectorAll('.ico')) {
      if (!visible(el)) continue;
      const w = Math.round(el.getBoundingClientRect().width);
      if (![16, 20, 22, 24, 28].includes(w)) add('icons', el, `icon ${w}px`);
    }
    return out;
  }

  // after a theme switch: force a full style recalc and let two frames pass before measuring
  async function settle(ms = 200) {
    void document.body.offsetHeight; void getComputedStyle(document.documentElement).color;
    await sleep(ms);
    // two frames, but never wait on requestAnimationFrame alone: it does not run while the page is hidden
    await Promise.race([new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))), sleep(120)]);
    finishAnimations();
  }
  const setTheme = async (t) => { document.documentElement.dataset.theme = t; await settle(); };

  async function goto(route, wait) {
    if (location.hash !== `#/${route}`) location.hash = `#/${route}`;
    await sleep(wait);
  }

  async function special(name, wait, themes, results) {
    const app = await import('../js/state.js');
    for (let i = 0; i < 50 && !app.app.api; i++) await sleep(100); // the app may still be booting after a reload
    if (name === 'nobot') {
      app.app.api.setDemoNoBots(true); await app.loadBots();
      await goto('dashboard', wait); location.hash = '#/machines'; await sleep(200); location.hash = '#/dashboard'; await sleep(wait);
      for (const t of themes) { await setTheme(t); results.push(...checkPage(`nobot dashboard ${t}`)); }
      app.app.api.setDemoNoBots(false); await app.loadBots(); await goto('dashboard', wait);
    } else if (name === 'dialogs') {
      const util = await import('../js/util.js');
      const tour = await import('../js/tour.js');
      await goto('dashboard', wait);
      for (const t of themes) {
        await setTheme(t);
        tour.startTour(); await sleep(400);
        results.push(...checkPage(`tour ${t}`));
        const d = document.querySelector('dialog.tour'); if (d) { d.close(); d.remove(); }
        const p = util.confirmDialog('หยุดชั่วคราว?', 'บอทจะหยุดเปิดไม้ใหม่ ไม้ที่เปิดอยู่ไม่ถูกปิด และยังมี SL/TP ตามเดิม', { ok: 'หยุดชั่วคราว' });
        await sleep(400); results.push(...checkPage(`confirm ${t}`));
        document.querySelector('dialog[open] .modal-foot .btn').click(); await p;
        util.toast('ส่งคำสั่งแล้ว รอเครื่องรับคำสั่ง', 'good'); await sleep(400);
        results.push(...checkPage(`toast ${t}`));
      }
    } else if (name === 'login') {
      const m = await import('../js/app.js');
      await m.signOut(); await sleep(wait);
      for (const t of themes) {
        await setTheme(t);
        for (const tab of ['signin', 'signup', 'forgot']) {
          const b = [...document.querySelectorAll('.login-tabs button')].find((x) => x.textContent.includes({ signin: 'เข้าสู่ระบบ', signup: 'สมัคร', forgot: 'ลืม' }[tab]));
          if (b) b.click(); await sleep(250);
          results.push(...checkPage(`login/${tab} ${t}`));
        }
      }
    }
  }

  window.__layoutAudit = async function (opts = {}) {
    const routes = opts.routes || ['dashboard', 'bot', 'history', 'history?tab=trades', 'history?tab=journal', 'news', 'machines', 'guide', 'presets', 'calc',
      'downloads', 'users', 'audit', 'settings', 'nobot', 'dialogs', 'login'];
    const themes = opts.themes || ['light', 'dark'];
    const wait = opts.wait || 1400;
    const before = document.documentElement.dataset.theme;
    const results = [];
    for (const r of routes) {
      if (['nobot', 'dialogs', 'login'].includes(r)) { await special(r, wait, themes, results); continue; }
      await goto(r, wait);
      for (const t of themes) {
        await setTheme(t);
        results.push(...checkPage(`${r} ${t}`));
        // open every <details> once so the content inside is audited too
        const closed = [...document.querySelectorAll('main details:not([open])')];
        if (closed.length) { closed.forEach((d) => { d.open = true; }); await sleep(250); results.push(...checkPage(`${r} ${t} (details open)`)); closed.forEach((d) => { d.open = false; }); }
      }
    }
    if (before) document.documentElement.dataset.theme = before; else delete document.documentElement.dataset.theme;
    const byCheck = {};
    for (const x of results) byCheck[x.check] = (byCheck[x.check] || 0) + 1;
    // 'illustration' is informational (see the header); everything else is a failure
    const failures = results.filter((x) => x.check !== 'illustration').length;
    const width = window.innerWidth;
    return { width, failures, summary: byCheck, results };
  };
})();
