// Boot, theme, hash router and the app shell.
import { createApi, isConfigured, wantsDemo } from './api.js';
import { app, on, emit, isAdmin, loadBots, selectBot, currentBot, prefs } from './state.js';
import { h, icon, ingot, mount, loadingState, errorState, emptyState, errText, openModal } from './util.js';

// ------------------------------------------------------------------ theme
const THEMES = ['system', 'light', 'dark'];
const THEME_LABEL = { system: 'ตามระบบ', light: 'สว่าง', dark: 'มืด' };
const mql = window.matchMedia('(prefers-color-scheme: dark)');
export const themePref = () => (THEMES.includes(prefs.get('theme', 'system')) ? prefs.get('theme', 'system') : 'system');
export const resolvedTheme = () => { const p = themePref(); return p === 'system' ? (mql.matches ? 'dark' : 'light') : p; };
export function setTheme(pref) {
  prefs.set('theme', pref);
  applyTheme();
}
function applyTheme() {
  const p = themePref();
  if (p === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = p;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = resolvedTheme() === 'dark' ? '#121821' : '#f4f6f9';
  document.querySelectorAll('[data-theme-btn]').forEach(updateThemeBtn);
  emit('theme', resolvedTheme());
}
mql.addEventListener('change', () => { if (themePref() === 'system') applyTheme(); });

function themeButton() {
  const b = h('button', {
    class: 'icon-btn', type: 'button', dataset: { themeBtn: '1' },
    onclick: () => { const i = THEMES.indexOf(themePref()); setTheme(THEMES[(i + 1) % THEMES.length]); },
  });
  updateThemeBtn(b);
  return b;
}
function updateThemeBtn(b) {
  const p = themePref();
  b.replaceChildren(icon(p === 'system' ? 'auto' : p === 'light' ? 'sun' : 'moon'));
  b.setAttribute('aria-label', `ธีม: ${THEME_LABEL[p]} (กดเพื่อเปลี่ยน)`);
  b.title = `ธีม: ${THEME_LABEL[p]}`;
}

// ------------------------------------------------------------------ routes
const P = {
  login: () => import('./pages/login.js'),
  gate: () => import('./pages/gate.js'),
  dashboard: () => import('./pages/dashboard.js'),
  history: () => import('./pages/history.js'),
  control: () => import('./pages/control.js'),
  presets: () => import('./pages/presets.js'),
  news: () => import('./pages/news.js'),
  users: () => import('./pages/users.js'),
  downloads: () => import('./pages/downloads.js'),
  audit: () => import('./pages/audit.js'),
  settings: () => import('./pages/settings.js'),
};

export const NAV = [
  { name: 'dashboard', title: 'ภาพรวม', icon: 'home', tab: true },
  { name: 'history', title: 'ประวัติ', icon: 'history', tab: true },
  { name: 'control', title: 'ควบคุม', icon: 'sliders', tab: true },
  { name: 'presets', title: 'พรีเซ็ต', icon: 'doc', tab: true },
  { name: 'calc', title: 'คำนวณล็อต', icon: 'calc' },
  { name: 'news', title: 'ข่าว', icon: 'news' },
  { name: 'downloads', title: 'ดาวน์โหลดและติดตั้ง', icon: 'box' },
  { name: 'audit', title: 'บันทึกการเปลี่ยนแปลง', icon: 'list' },
  { name: 'users', title: 'ผู้ใช้', icon: 'users', admin: true },
  { name: 'settings', title: 'ตั้งค่า', icon: 'gear' },
];

const ROUTES = {
  login: { load: P.login, access: 'public' },
  reset: { load: P.gate, fn: 'renderReset', access: 'any' },
  invite: { load: P.gate, fn: 'renderInvite', access: 'pending' },
  mfa: { load: P.gate, fn: 'renderMfa', access: 'mfa' },
  disabled: { load: P.gate, fn: 'renderDisabled', access: 'disabled' },
  dashboard: { load: P.dashboard },
  history: { load: P.history },
  control: { load: P.control },
  presets: { load: P.presets },
  calc: { load: P.presets, fn: 'renderCalc' },
  news: { load: P.news },
  users: { load: P.users, admin: true },
  downloads: { load: P.downloads },
  audit: { load: P.audit },
  settings: { load: P.settings },
};

export function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  if (/^(access_token|error|refresh_token|type)=/.test(raw)) return { name: '', parts: [], query: new URLSearchParams() };
  const [path, qs] = raw.split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  return { name: parts[0] || '', parts: parts.slice(1), query: new URLSearchParams(qs || '') };
}

export function nav(hash, replace = false) {
  const target = hash.startsWith('#') ? hash : `#/${hash.replace(/^\/+/, '')}`;
  if (location.hash === target) { route(); return; }
  if (replace) { history.replaceState(null, '', target); route(); } else location.hash = target;
}

// ------------------------------------------------------------------ session
const PENDING_INVITE = 'pending-invite';
export function rememberInvite(code) { prefs.set(PENDING_INVITE, code || ''); }

export async function refreshSession() {
  app.user = app.api.user();
  app.profile = null;
  app.needMfa = false;
  if (!app.user) { app.bots = []; app.botId = null; return; }
  try {
    const a = await app.api.aal();
    app.needMfa = a.current === 'aal1' && a.next === 'aal2';
  } catch { /* MFA API unavailable: ignore */ }
  app.profile = await app.api.profile();
  const pending = prefs.get(PENDING_INVITE, '');
  if (pending && (!app.profile || !app.profile.approved) && !(app.profile && app.profile.disabled)) {
    try { await app.api.redeemInvite(pending); app.profile = await app.api.profile(); } catch { /* user can retype it */ }
    rememberInvite('');
  }
  if (app.profile && app.profile.approved && !app.profile.disabled && !app.needMfa) await loadBots();
}

// ------------------------------------------------------------------ shell
let shell = null;
let cleanup = null;
let seq = 0;

function navLink(item, cls) {
  return h('a', { href: `#/${item.name}`, class: cls, dataset: { route: item.name } }, icon(item.icon), h('span', null, item.title));
}

function botPicker() {
  const box = h('div', { class: 'botpick' });
  const draw = () => {
    box.replaceChildren();
    if (!app.bots.length) return;
    if (app.bots.length === 1) { box.append(h('span', { class: 'botname', title: 'บอทของคุณ' }, app.bots[0].name)); return; }
    const sel = h('select', { class: 'input select', 'aria-label': 'เลือกบอท', onchange: (e) => selectBot(e.target.value) },
      app.bots.map((b) => h('option', { value: b.id, selected: b.id === app.botId }, b.name)));
    box.append(sel);
  };
  draw();
  on('bots-loaded', draw);
  on('bot-changed', draw);
  return box;
}

function openMoreSheet() {
  const items = NAV.filter((n) => !n.tab && (!n.admin || isAdmin()));
  const m = openModal({
    title: 'เมนู',
    body: h('nav', { class: 'sheet-nav', 'aria-label': 'เมนูทั้งหมด' },
      items.map((it) => h('a', { href: `#/${it.name}`, onclick: () => m.close() }, icon(it.icon), h('span', null, it.title))),
      h('div', { class: 'sheet-row' }, h('span', null, 'ธีม'), themeSegment(() => {})),
      h('button', { class: 'btn ghost block', type: 'button', onclick: () => { m.close(); signOut(); } }, icon('logout'), 'ออกจากระบบ')),
  });
}

export function themeSegment(onChange) {
  const box = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'ธีม' });
  const draw = () => {
    box.replaceChildren(...THEMES.map((t) => h('button', {
      type: 'button', role: 'radio', 'aria-checked': themePref() === t ? 'true' : 'false', class: themePref() === t ? 'on' : '',
      onclick: () => { setTheme(t); draw(); onChange && onChange(t); },
    }, icon(t === 'system' ? 'auto' : t === 'light' ? 'sun' : 'moon'), THEME_LABEL[t])));
  };
  draw();
  return box;
}

export async function signOut() {
  try { await app.api.signOut(); } catch { /* ignore */ }
  app.user = null; app.profile = null; app.bots = []; app.botId = null;
  nav('#/login', true);
}

function demoBanner() {
  if (app.mode !== 'demo') return null;
  return h('div', { class: 'demo-banner', role: 'note' },
    h('strong', null, 'โหมดตัวอย่าง'),
    h('span', null, 'ข้อมูลทั้งหมดเป็นข้อมูลสมมติ ไม่ได้เชื่อมกับบอทจริง ทุกปุ่มกดได้ และการเปลี่ยนแปลงหายเมื่อโหลดหน้าใหม่'),
    isConfigured() ? h('a', { href: location.pathname }, 'ออกจากโหมดตัวอย่าง') : null);
}

function buildShell() {
  const main = h('main', { id: 'main', class: 'main', tabindex: '-1' });
  const userBox = h('div', { class: 'side-user' });
  const drawUser = () => userBox.replaceChildren(
    h('div', { class: 'side-user-name' }, (app.profile && app.profile.display_name) || (app.user && app.user.email) || ''),
    h('div', { class: 'muted small' }, app.user ? app.user.email : '', isAdmin() ? ' (ผู้ดูแล)' : ''),
    h('button', { class: 'btn ghost small', type: 'button', onclick: signOut }, icon('logout'), 'ออกจากระบบ'));
  drawUser();
  const sideNav = h('nav', { class: 'side-nav', 'aria-label': 'เมนูหลัก' });
  const drawNav = () => sideNav.replaceChildren(...NAV.filter((n) => !n.admin || isAdmin()).map((n) => navLink(n, 'side-link')));
  drawNav();
  const tabbar = h('nav', { class: 'tabbar', 'aria-label': 'เมนูหลัก' },
    NAV.filter((n) => n.tab).map((n) => navLink(n, 'tab-link')),
    h('button', { class: 'tab-link', type: 'button', onclick: openMoreSheet, dataset: { route: 'more' } }, icon('more'), h('span', null, 'เมนู')));
  const el = h('div', { class: 'shell' },
    h('a', { class: 'skip', href: '#main', onclick: (e) => { e.preventDefault(); main.focus(); } }, 'ข้ามไปที่เนื้อหา'),
    h('aside', { class: 'sidebar' },
      h('a', { class: 'brand', href: '#/dashboard' }, ingot(), h('span', null, 'Dobby')),
      sideNav, userBox),
    h('div', { class: 'col' },
      h('header', { class: 'topbar' },
        h('a', { class: 'brand brand-top', href: '#/dashboard', 'aria-label': 'Dobby หน้าแรก' }, ingot(), h('span', null, 'Dobby')),
        botPicker(),
        h('div', { class: 'top-actions' }, themeButton())),
      demoBanner(),
      main),
    tabbar);
  return { el, main, drawNav, drawUser };
}

function setActiveNav(name) {
  if (!shell) return;
  const tabNames = NAV.filter((n) => n.tab).map((n) => n.name);
  const routeName = name === 'calc' ? 'calc' : name;
  shell.el.querySelectorAll('[data-route]').forEach((a) => {
    const r = a.dataset.route;
    const active = r === routeName || (r === 'more' && !tabNames.includes(routeName));
    if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
}

function bareRoot() {
  shell = null;
  const root = h('main', { id: 'main', class: 'bare', tabindex: '-1' });
  const page = h('div', { class: 'bare-wrap' },
    h('header', { class: 'bare-head' }, h('span', { class: 'brand' }, ingot(), h('span', null, 'Dobby')), themeButton()),
    demoBanner(), root);
  mount(document.getElementById('app'), page);
  return root;
}

// ------------------------------------------------------------------ router
export async function route() {
  const my = ++seq;
  if (cleanup) { try { cleanup(); } catch (e) { console.error(e); } cleanup = null; }
  const parsed = parseHash();
  let name = parsed.name;
  const u = app.user;
  let target = name;
  if (!u) {
    if (!['login', 'reset'].includes(name)) target = 'login';
  } else if (name === 'reset') {
    target = 'reset';
  } else if (app.needMfa) target = 'mfa';
  else if (app.profile && app.profile.disabled) target = 'disabled';
  else if (!app.profile || !app.profile.approved) target = 'invite';
  else if (!ROUTES[name] || ['login', 'invite', 'mfa', 'disabled'].includes(name)) target = 'dashboard';
  if (target !== name) { history.replaceState(null, '', `#/${target}`); name = target; }

  const def = ROUTES[name];
  const shelled = !def.access;
  let root;
  if (shelled) {
    if (!shell) { shell = buildShell(); mount(document.getElementById('app'), shell.el); }
    shell.drawNav(); shell.drawUser();
    root = shell.main;
    setActiveNav(name);
  } else root = bareRoot();
  const navItem = NAV.find((n) => n.name === name);
  document.title = navItem ? `${navItem.title} | Dobby` : 'Dobby';
  mount(root, loadingState());
  window.scrollTo(0, 0);
  if (def.admin && !isAdmin()) { mount(root, emptyState('สำหรับผู้ดูแลระบบเท่านั้น', 'บัญชีนี้ไม่มีสิทธิ์เปิดหน้านี้')); return; }
  try {
    const mod = await def.load();
    if (my !== seq) return;
    root.replaceChildren();
    const ctx = { app, api: app.api, parts: parsed.parts, query: parsed.query, nav, refreshSession, route, signOut };
    const fn = mod[def.fn || 'render'];
    const c = await fn(root, ctx);
    if (my !== seq) { if (typeof c === 'function') c(); return; }
    cleanup = typeof c === 'function' ? c : null;
  } catch (e) {
    console.error(e);
    if (my === seq) mount(root, errorState(e, () => route()));
  }
}

// ------------------------------------------------------------------ boot
async function boot() {
  applyTheme();
  const appEl = document.getElementById('app');
  if (!wantsDemo() && !isConfigured()) {
    const mod = await import('./pages/setup.js');
    mount(appEl, mod.renderSetup());
    return;
  }
  mount(appEl, h('div', { class: 'boot' }, loadingState('กำลังเปิด Dobby…')));
  try {
    app.api = await createApi();
    app.mode = app.api.mode;
    document.documentElement.dataset.mode = app.mode;
    await app.api.init();
    app.api.onAuth(async (event, user) => {
      if (event === 'PASSWORD_RECOVERY') { await refreshSession(); nav('#/reset', true); return; }
      if (event === 'SIGNED_OUT') {
        if (app.user) { app.user = null; app.profile = null; app.bots = []; route(); }
        return;
      }
      if (user && (!app.user || app.user.id !== user.id)) { await refreshSession(); route(); }
    });
    await refreshSession();
  } catch (e) {
    console.error(e);
    mount(appEl, h('div', { class: 'bare-wrap' }, errorState(e, () => location.reload())));
    return;
  }
  window.addEventListener('hashchange', () => route());
  on('bot-changed', () => { if (currentBot()) route(); });
  route();
}

boot();

window.addEventListener('unhandledrejection', (e) => { console.error('unhandled', e.reason); });

// Right-align header cells above numeric columns (tables are built in many pages).
let alignQueued = false;
new MutationObserver(() => {
  if (alignQueued) return;
  alignQueued = true;
  requestAnimationFrame(() => {
    alignQueued = false;
    document.querySelectorAll('table.rtable:not([data-aligned])').forEach((t) => {
      const row = t.tBodies[0] && t.tBodies[0].rows[0];
      const heads = t.tHead && t.tHead.rows[0] ? [...t.tHead.rows[0].cells] : [];
      if (!row) return;
      heads.forEach((th, i) => { if (row.cells[i] && row.cells[i].classList.contains('num')) th.classList.add('num'); });
      t.dataset.aligned = '1';
    });
  });
}).observe(document.body, { childList: true, subtree: true });
export { errText };
