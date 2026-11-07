// App-wide state and a tiny event bus.
export const app = {
  api: null,
  mode: '',          // 'supabase' | 'demo'
  user: null,        // {id, email}
  profile: null,     // profiles row
  bots: [],
  botId: null,
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
export const currentBot = () => app.bots.find((b) => b.id === app.botId) || null;

function store(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }
function load(k) { try { return localStorage.getItem(k); } catch { return null; } }

export function selectBot(id) {
  if (id === app.botId) return;
  app.botId = id;
  store('dobby-bot', id || '');
  emit('bot-changed', id);
}

export async function loadBots() {
  app.bots = await app.api.listBots();
  const saved = load('dobby-bot');
  if (!app.bots.some((b) => b.id === app.botId)) {
    app.botId = app.bots.some((b) => b.id === saved) ? saved : (app.bots[0] ? app.bots[0].id : null);
  }
  emit('bots-loaded', app.bots);
  return app.bots;
}

export function updateBotRow(row) {
  const i = app.bots.findIndex((b) => b.id === row.id);
  if (i >= 0) app.bots[i] = { ...app.bots[i], ...row };
}

export const prefs = {
  get: (k, d) => { const v = load(`dobby-${k}`); return v === null ? d : v; },
  set: (k, v) => store(`dobby-${k}`, v),
};
