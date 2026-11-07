// App-wide state and a tiny event bus.
export const app = {
  api: null,
  mode: '',          // 'supabase' | 'demo'
  user: null,        // {id, email}
  profile: null,     // profiles row
  bots: [],          // my own bots (api.listBots(): owner = me)
  friendBots: [],    // admin only: everyone else's bots, read only, each with owner_name (api.adminBots())
  people: {},        // admin only: user_id -> {name, email, role, approved, disabled} (api.adminOverview())
  botId: null,       // the bot shown on ภาพรวม / ประวัติ / ตั้งค่าบอท (may be a friend's bot for the admin: view only)
};

const bus = new EventTarget();
export function on(name, fn) {
  const h = (e) => fn(e.detail);
  bus.addEventListener(name, h);
  return () => bus.removeEventListener(name, h);
}
export function emit(name, detail) {
  bus.dispatchEvent(new CustomEvent(name, { detail }));
}

export const isAdmin = () => !!(app.profile && app.profile.role === 'admin' && app.profile.approved && !app.profile.disabled);
// Ownership decides what may be written: never the role alone.
export const ownsBot = (b) => !!(b && app.user && b.owner === app.user.id);
export const currentBot = () => app.bots.find((b) => b.id === app.botId) || app.friendBots.find((b) => b.id === app.botId) || null;
// the admin is looking at someone else's bot (every control hidden, nothing is sent)
export const viewingFriend = () => { const b = currentBot(); return !!b && !ownsBot(b); };
export const personName = (id) => { const p = app.people[id]; return p ? p.name : ''; };

function store(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }
function load(k) { try { return localStorage.getItem(k); } catch { return null; } }

// The default bot ("บอทหลัก", chosen on เครื่องของฉัน) opens first; otherwise the last selected one. Only my own bots are
// remembered, so the admin's next visit always opens their own bot.
export const defaultBotId = () => load('dobby-default-bot') || '';
export function setDefaultBot(id) { store('dobby-default-bot', id || ''); emit('bots-loaded', app.bots); }
function myDefaultBot() {
  const def = defaultBotId(), saved = load('dobby-bot');
  return app.bots.find((b) => b.id === def) || app.bots.find((b) => b.id === saved) || app.bots[0] || null;
}
// The bot that writes go to (blackouts on ข่าว, presets "ใช้กับบอท"): the current bot when it is mine, else my own one.
export const myBot = () => { const b = currentBot(); return b && ownsBot(b) ? b : myDefaultBot(); };

export function selectBot(id) {
  if (id === app.botId) return;
  app.botId = id;
  if (app.bots.some((b) => b.id === id)) store('dobby-bot', id || '');
  emit('bot-changed', id);
}
export function backToMyBot() { const b = myDefaultBot(); selectBot(b ? b.id : null); }

export async function loadBots() {
  app.bots = await app.api.listBots();
  app.friendBots = [];
  if (isAdmin() && app.api.adminBots) {
    try {
      const [others, users] = await Promise.all([app.api.adminBots(), app.api.adminOverview()]);
      app.people = Object.fromEntries(users.map((u) => [u.user_id, { name: u.display_name || u.email || String(u.user_id).slice(0, 8), email: u.email || '', role: u.role, approved: u.approved, disabled: u.disabled }]));
      app.friendBots = others.map((b) => ({ ...b, owner_name: personName(b.owner) || 'สมาชิก' }));
    } catch { app.friendBots = []; }
  }
  if (!currentBot()) { const b = myDefaultBot(); app.botId = b ? b.id : null; }
  emit('bots-loaded', app.bots);
  return app.bots;
}

export function updateBotRow(row) {
  const i = app.bots.findIndex((b) => b.id === row.id);
  if (i >= 0) { app.bots[i] = { ...app.bots[i], ...row }; return; }
  const j = app.friendBots.findIndex((b) => b.id === row.id);
  if (j >= 0) app.friendBots[j] = { ...app.friendBots[j], ...row };
}

export const prefs = {
  get: (k, d) => { const v = load(`dobby-${k}`); return v === null ? d : v; },
  set: (k, v) => store(`dobby-${k}`, v),
};
