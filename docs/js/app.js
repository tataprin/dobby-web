// Boot, theme, hash router and the app shell.
import { createApi, isConfigured, wantsDemo } from './api.js';
import { app, on, emit, isAdmin, loadBots, selectBot, currentBot, prefs, viewingFriend, backToMyBot } from './state.js';
import { h, icon, mount, loadingState, errorState, emptyState, errText, openModal } from './util.js';
import { maybeStartTour } from './tour.js';
import { brandMark } from './hallmark.js';
import { ticker } from './ticker.js';

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
  if (meta) meta.content = resolvedTheme() === 'dark' ? '#14191B' : '#F1F2EE';
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
  mount(b, icon(p === 'system' ? 'auto' : p === 'light' ? 'sun' : 'moon'));
  b.setAttribute('aria-label', `ธีม: ${THEME_LABEL[p]} (กดเพื่อเปลี่ยน)`);
  b.title = `ธีม: ${THEME_LABEL[p]}`;
}

// ------------------------------------------------------------------ routes
const P = {
  login: () => import('./pages/login.js'),
  gate: () => import('./pages/gate.js'),
  dashboard: () => import('./pages/dashboard.js'),
  bot: () => import('./pages/botsettings.js'),
  history: () => import('./pages/history.js'),
  news: () => import('./pages/news.js'),
  machines: () => import('./pages/machines.js'),
  guide: () => import('./pages/guide.js'),
  presets: () => import('./pages/presets.js'),
  users: () => import('./pages/users.js'),
  downloads: () => import('./pages/downloads.js'),
  audit: () => import('./pages/audit.js'),
  settings: () => import('./pages/settings.js'),
};

// Main navigation (sidebar top group; `tab` = mobile bottom bar) and the smaller "เพิ่มเติม" group (`more`).
export const NAV = [
  { name: 'dashboard', title: 'ภาพรวม', icon: 'home', tab: true },
  { name: 'bot', title: 'ตั้งค่าบอท', icon: 'sliders', tab: true },
  { name: 'history', title: 'ประวัติ', icon: 'history', tab: true },
  { name: 'news', title: 'ข่าว', icon: 'news' },
  { name: 'machines', title: 'เครื่องของฉัน', short: 'เครื่อง', icon: 'monitor', tab: true },
  { name: 'guide', title: 'วิธีใช้', icon: 'book' },
  { name: 'presets', title: 'พรีเซ็ตที่บันทึกไว้', icon: 'doc', more: true },
  { name: 'downloads', title: 'ดาวน์โหลดแอป', icon: 'download', more: true },
  { name: 'users', title: 'ผู้ใช้', icon: 'users', admin: true, more: true },
  { name: 'audit', title: 'บันทึกการเปลี่ยนแปลง', icon: 'list', more: true },
  { name: 'settings', title: 'ตั้งค่าบัญชี', icon: 'user', more: true },
];

const ROUTES = {
  login: { load: P.login, access: 'public' },
  reset: { load: P.gate, fn: 'renderReset', access: 'any' },
  invite: { load: P.gate, fn: 'renderInvite', access: 'pending' },
  mfa: { load: P.gate, fn: 'renderMfa', access: 'mfa' },
  disabled: { load: P.gate, fn: 'renderDisabled', access: 'disabled' },
  dashboard: { load: P.dashboard },
  bot: { load: P.bot },
  history: { load: P.history },
  news: { load: P.news },
  machines: { load: P.machines },
  guide: { load: P.guide },
  presets: { load: P.presets, nav: 'presets' },
  calc: { load: P.presets, fn: 'renderCalc', nav: 'presets', title: 'คำนวณล็อต' },
  users: { load: P.users, admin: true },
  downloads: { load: P.downloads },
  audit: { load: P.audit },
  settings: { load: P.settings },
};
// Old and alternative addresses keep working (bookmarks, links shared in chats).
const ALIASES = {
  control: 'bot', botsettings: 'bot', 'bot-settings': 'bot', params: 'bot',
  bots: 'machines', devices: 'machines', machine: 'machines',
  help: 'guide', howto: 'guide', account: 'settings', download: 'downloads', setup: 'downloads', home: 'dashboard',
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
  if (!app.user) { app.bots = []; app.friendBots = []; app.people = {}; app.botId = null; return; }
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

function navLink(item, cls, short = false) {
  return h('a', { href: `#/${item.name}`, class: cls, dataset: { route: item.name } }, icon(item.icon), h('span', null, short && item.short ? item.short : item.title));
}
const visible = (n) => !n.admin || isAdmin();

// Header bot picker. For the admin it also lists everyone else's bots, grouped under the owner's name (view only).
function botPicker() {
  const box = h('div', { class: 'botpick' });
  const draw = () => {
    mount(box);
    const friends = app.friendBots || [];
    if (!app.bots.length && !friends.length) return;
    if (app.bots.length === 1 && !friends.length) { box.append(h('a', { class: 'botname', href: '#/machines', title: 'เครื่องของฉัน' }, h('span', { class: 'botname-label' }, 'บอท'), h('span', { class: 'botname-text' }, app.bots[0].name))); return; }
    const opt = (b) => h('option', { value: b.id, selected: b.id === app.botId }, b.name);
    let options = app.bots.map(opt);
    if (friends.length) {
      const owners = [];
      for (const b of friends) { let g = owners.find((x) => x.owner === b.owner); if (!g) owners.push(g = { owner: b.owner, name: b.owner_name, bots: [] }); g.bots.push(b); }
      options = [
        h('optgroup', { label: 'บอทของฉัน' }, app.bots.length ? app.bots.map(opt) : h('option', { value: '', disabled: true }, 'ยังไม่มีบอท')),
        ...owners.map((g) => h('optgroup', { label: `ของ ${g.name} (ดูอย่างเดียว)` }, g.bots.map(opt))),
      ];
    }
    const sel = h('select', { class: 'botpick-select', 'aria-label': 'เลือกบอท', onchange: (e) => { if (e.target.value) selectBot(e.target.value); } }, options);
    const friend = viewingFriend();
    box.append(h('label', { class: `botpick-field${friend ? ' is-friend' : ''}` }, h('span', { class: 'botname-label' }, friend ? 'ดูบอท' : 'บอท'), sel, h('span', { class: 'botpick-chev', 'aria-hidden': 'true' }, icon('chevron'))));
  };
  draw();
  on('bots-loaded', draw);
  on('bot-changed', draw);
  return box;
}

function openMoreSheet() {
  const main = NAV.filter((n) => !n.tab && !n.more && visible(n));
  const more = NAV.filter((n) => n.more && visible(n));
  const link = (it) => h('a', { href: `#/${it.name}`, onclick: () => m.close() }, h('span', { class: 'sheet-ico' }, icon(it.icon)), h('span', null, it.title));
  const m = openModal({
    title: 'เมนู',
    body: h('nav', { class: 'sheet-nav', 'aria-label': 'เมนูทั้งหมด' },
      main.map(link),
      h('p', { class: 'nav-group' }, 'เพิ่มเติม'),
      more.map(link),
      h('div', { class: 'sheet-row' }, h('span', null, 'ธีม'), themeSegment(() => {})),
      h('button', { class: 'btn ghost block', type: 'button', onclick: () => { m.close(); signOut(); } }, icon('logout'), 'ออกจากระบบ')),
  });
}

export function themeSegment(onChange, iconsOnly = false) {
  const box = h('div', { class: `segmented${iconsOnly ? ' icons' : ''}`, role: 'radiogroup', 'aria-label': 'ธีม' });
  const draw = () => {
    mount(box, ...THEMES.map((t) => h('button', {
      type: 'button', role: 'radio', 'aria-checked': themePref() === t ? 'true' : 'false', class: themePref() === t ? 'on' : '',
      'aria-label': THEME_LABEL[t], title: THEME_LABEL[t],
      onclick: () => { setTheme(t); draw(); onChange && onChange(t); },
    }, icon(t === 'system' ? 'auto' : t === 'light' ? 'sun' : 'moon'), iconsOnly ? null : THEME_LABEL[t])));
  };
  on('theme', () => { if (box.isConnected) draw(); });
  draw();
  return box;
}

export async function signOut() {
  try { await app.api.signOut(); } catch { /* ignore */ }
  app.user = null; app.profile = null; app.bots = []; app.friendBots = []; app.people = {}; app.botId = null;
  nav('#/login', true);
}

function demoBanner() {
  if (app.mode !== 'demo') return null;
  const box = h('div', { class: 'demo-banner', role: 'note' });
  const inner = h('div', { class: 'demo-in wrap-col' });
  box.append(inner);
  const draw = () => mount(inner,
    h('strong', null, 'โหมดตัวอย่าง'),
    h('span', null, app.api && app.api.noBots ? 'กำลังแสดงบัญชีที่ยังไม่มีบอท' : 'ข้อมูลสมมติทั้งหมด ทุกปุ่มกดได้ และหายเมื่อโหลดหน้าใหม่'),
    app.api && app.api.noBots ? h('a', { href: '#/dashboard', onclick: async (e) => { e.preventDefault(); app.api.setDemoNoBots(false); await loadBots(); nav('#/dashboard'); } }, 'แสดงบอทตัวอย่างอีกครั้ง') : null,
    isConfigured() ? h('a', { href: location.pathname }, 'ออกจากโหมดตัวอย่าง') : null);
  draw();
  on('bots-loaded', draw);
  return box;
}

// Admin looking at someone else's bot: one clear line under the header, with the way back to their own bot.
function viewBanner() {
  const box = h('div', { class: 'view-banner', role: 'status', hidden: true });
  const inner = h('div', { class: 'view-in wrap-col' });
  box.append(inner);
  const draw = () => {
    const b = currentBot();
    const friend = viewingFriend();
    box.hidden = !friend;
    document.body.classList.toggle('viewing-friend', friend);
    if (!friend) { mount(inner); return; }
    mount(inner,
      h('span', { class: 'view-ico', 'aria-hidden': 'true' }, icon('eye')),
      h('p', { class: 'grow' }, 'กำลังดูบอทของ ', h('strong', null, b.owner_name || 'สมาชิก'), ' ดูอย่างเดียว สั่งงานไม่ได้'),
      app.bots.length ? h('button', { class: 'btn small', type: 'button', onclick: () => backToMyBot() }, 'กลับไปบอทของฉัน') : null);
  };
  draw();
  on('bots-loaded', draw);
  on('bot-changed', draw);
  return box;
}

// first letter for the avatar; a Thai leading vowel (เ แ โ ใ ไ) travels with its consonant
const initial = (name) => { const s = String(name).trim(); return (/^[เ-ไ]/.test(s) ? s.slice(0, 2) : s.slice(0, 1)).toUpperCase(); };

function buildShell() {
  const main = h('main', { id: 'main', class: 'main', tabindex: '-1' });
  const userBox = h('div', { class: 'side-user' });
  const drawUser = () => mount(userBox, 
    h('div', { class: 'side-user-row' },
      h('span', { class: 'avatar', 'aria-hidden': 'true' }, initial((app.profile && app.profile.display_name) || (app.user && app.user.email) || '?')),
      h('div', { class: 'grow' },
        h('div', { class: 'side-user-name' }, (app.profile && app.profile.display_name) || (app.user && app.user.email) || ''),
        h('div', { class: 'muted small side-user-mail', title: isAdmin() ? 'ผู้ดูแลระบบ' : null }, app.user ? app.user.email : ''))),
    h('div', { class: 'side-user-tools' }, themeSegment(() => {}, true),
      h('button', { class: 'icon-btn', type: 'button', onclick: signOut, 'aria-label': 'ออกจากระบบ', title: 'ออกจากระบบ' }, icon('logout'))));
  drawUser();
  const sideNav = h('nav', { class: 'side-nav', 'aria-label': 'เมนูหลัก' });
  const drawNav = () => mount(sideNav, 
    ...NAV.filter((n) => !n.more && visible(n)).map((n) => navLink(n, 'side-link')),
    h('p', { class: 'nav-group' }, 'เพิ่มเติม'),
    ...NAV.filter((n) => n.more && visible(n)).map((n) => navLink(n, 'side-link small-link')));
  drawNav();
  const tabbar = h('nav', { class: 'tabbar', 'aria-label': 'เมนูหลัก' },
    NAV.filter((n) => n.tab).map((n) => navLink(n, 'tab-link', true)),
    h('button', { class: 'tab-link', type: 'button', onclick: openMoreSheet, dataset: { route: 'more' } }, icon('menu'), h('span', null, 'เมนู')));
  const el = h('div', { class: 'shell' },
    h('a', { class: 'skip', href: '#main', onclick: (e) => { e.preventDefault(); main.focus(); } }, 'ข้ามไปที่เนื้อหา'),
    h('aside', { class: 'sidebar' },
      h('a', { class: 'brand', href: '#/dashboard' }, brandMark(), h('span', { class: 'brand-word' }, 'Dobby')),
      sideNav, userBox),
    h('div', { class: 'col' },
      h('header', { class: 'topbar' }, h('div', { class: 'topbar-in wrap-col' },
        h('a', { class: 'brand brand-top', href: '#/dashboard', 'aria-label': 'Dobby หน้าแรก' }, brandMark(), h('span', { class: 'brand-word' }, 'Dobby')),
        ticker(),
        botPicker(),
        h('div', { class: 'top-actions' },
          h('a', { class: 'icon-btn top-help', href: '#/guide', 'aria-label': 'วิธีใช้', title: 'วิธีใช้' }, icon('help')),
          themeButton()))),
      viewBanner(),
      demoBanner(),
      main),
    tabbar);
  return { el, main, drawNav, drawUser };
}

function setActiveNav(name) {
  if (!shell) return;
  const tabNames = NAV.filter((n) => n.tab).map((n) => n.name);
  const routeName = (ROUTES[name] && ROUTES[name].nav) || name;
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
    h('header', { class: 'bare-head wrap-col' }, h('span', { class: 'brand' }, brandMark(), h('span', { class: 'brand-word' }, 'Dobby')), themeButton()),
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
  if (ALIASES[name]) {
    name = ALIASES[name];
    const qs = parsed.query.toString();
    history.replaceState(null, '', `#/${[name, ...parsed.parts].map(encodeURIComponent).join('/')}${qs ? `?${qs}` : ''}`);
  }
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
  const navItem = NAV.find((n) => n.name === (def.nav || name));
  const pageTitle = def.title || (navItem && navItem.title);
  document.title = pageTitle ? `${pageTitle} | Dobby` : 'Dobby';
  mount(root, loadingState());
  window.scrollTo(0, 0);
  if (def.admin && !isAdmin()) { mount(root, emptyState('สำหรับผู้ดูแลระบบเท่านั้น', 'บัญชีนี้ไม่มีสิทธิ์เปิดหน้านี้')); return; }
  let mod;
  try { mod = await def.load(); } catch (e) {
    console.error(e);
    if (my === seq) pageFilesFailed(root, e);
    return;
  }
  try {
    if (my !== seq) return;
    mount(root);
    const ctx = { app, api: app.api, parts: parsed.parts, query: parsed.query, nav, refreshSession, route, signOut };
    const fn = mod[def.fn || 'render'];
    const c = await fn(root, ctx);
    if (my !== seq) { if (typeof c === 'function') c(); return; }
    cleanup = typeof c === 'function' ? c : null;
    if (shelled) maybeStartTour();
  } catch (e) {
    console.error(e);
    if (my === seq) mount(root, errorState(e, () => route()));
  }
}

// A page's files did not load. Right after an update this is usually the browser mixing an old cached file with new
// ones: reload once from a fresh address (index.html's dobbyFreshReload), or offer a button that does it.
function freshReload(auto) {
  if (window.dobbyFreshReload) return window.dobbyFreshReload(auto);
  if (auto) return false;
  const u = new URL(location.href);
  u.searchParams.set('_r', String(Date.now()));
  location.replace(u.href);
  return true;
}
function pageFilesFailed(root, e) {
  if (navigator.onLine === false) { mount(root, errorState({ thai: 'ไม่มีอินเทอร์เน็ต ต่อเน็ตแล้วกดลองอีกครั้ง' }, () => route())); return; }
  if (freshReload(true)) return;
  mount(root, h('div', { class: 'state error', role: 'alert' },
    icon('refresh'),
    h('p', { class: 'state-title' }, 'เว็บเพิ่งอัปเดต'),
    h('p', { class: 'muted' }, 'เบราว์เซอร์ยังเก็บไฟล์รุ่นเก่าไว้บางส่วน กดโหลดใหม่เพื่อใช้รุ่นล่าสุด'),
    h('button', { class: 'btn primary', type: 'button', onclick: () => freshReload(false) }, icon('refresh'), 'โหลดใหม่')));
  console.warn('page files failed to load', e);
}

// ------------------------------------------------------------------ boot
async function boot() {
  document.documentElement.dataset.booted = '1';
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
        if (app.user) { app.user = null; app.profile = null; app.bots = []; app.friendBots = []; app.people = {}; route(); }
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
