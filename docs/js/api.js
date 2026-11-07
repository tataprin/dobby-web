// One interface, two implementations:
//   SupabaseApi  the real backend (Supabase auth + Postgres + realtime + storage, SPEC 2)
//   DemoApi      in-memory synthetic data from demo.js; every write works (lost on reload)
//
// Interface (all async unless noted; errors are ApiError with a Thai `.thai` message):
//   mode ('supabase'|'demo'), config {url, key}                                  (properties)
//   init(), user() -> {id,email}|null (sync), onAuth(cb(event, user)) -> off (sync)
//   signIn(email, pw), signUp(email, pw) -> {needsConfirm}, signOut(), resetPassword(email), updatePassword(pw)
//   reauthenticate(pw)                       fresh password sign-in for the live gate (SPEC 2.4)
//   mfaFactors() -> [{id,status,friendly_name}], mfaEnroll() -> {id, qr, secret, uri}, mfaVerify(id, code),
//   mfaUnenroll(id), aal() -> {current, next}
//   profile(), redeemInvite(code) -> 'ok'|'already_approved', setDisplayName(name)
//   liveGateStatus() -> 'ok'|'reauth_required'|'mfa_required'   (RPC live_gate_status, asked before the ON modal)
//   listBots(), renameBot(botId, name), deleteBot(botId), botStatus(botId) -> row|null, botControl(botId) -> row|null,
//   updateDesired(botId, desired, expectedVersion) -> control row, journal(botId, {fromServer, toServer}) -> rows (desc)
//   subscribeBot(botId, {status, control, bot, journal}) -> unsubscribe (sync)
//   listPresets(), createPreset({name, params, notes}), updatePreset(id, patch), deletePreset(id)
//   listAudit({limit}), listNews({fromIso}), saveNews(row), deleteNews(id)
//   adminOverview(), listInvites(), createInvite(role, days, note) -> code, revokeInvite(code),
//   adminSetUser(userId, role, approved, disabled)
//   adminBots() -> other users' bots, adminPresets() -> other users' presets   (admin, read only; RLS SELECT only)
//   journalTail(botId, n) -> the newest n journal rows (desc)
//   Writes to a bot are for its owner only: renameBot / deleteBot / updateDesired on someone else's bot throw
//   ApiError('read_only') before anything is sent (RLS would refuse them anyway: 0 rows).
//   listDownloads() -> [{name,size,updated_at}], downloadUrl(name) -> url|null, uploadDownload(file), deleteDownload(name)
// Feature batch (SPEC 9; the same owner-only rule for every write, the admin reads):
//   bars(botId, fromIso, toIso) -> [{t, close, vwap}] ascending                                   (9.1)
//   listCashFlows(botId) -> rows (desc), addCashFlow(botId, {ts, amount, note}),
//   updateCashFlow(botId, id, patch), deleteCashFlow(botId, id)                                    (9.2)
//   listTradeNotes(botId) -> rows, saveTradeNote(botId, key, {note, tags}), deleteTradeNote(botId, key)   (9.6)
//   listPushSubscriptions() -> my rows, savePushSubscription({endpoint, p256dh, auth, ua, events}) (RPC register_push_subscription),
//   updatePushSubscription(endpoint, patch), deletePushSubscription(endpoint), sendTestPush() -> {ok}      (9.7)
//   A table that is not in the database yet raises ApiError('not_deployed') (schema.sql not updated).
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { createDemoDb, DEMO_OFFSET_MIN } from './demo.js';
import { sleep, utcToServer } from './util.js';
import { normalizeParams, remoteSubset, REMOTE_KEYS, formatValue, PARAM_BY_KEY } from './params.js';

export const SUPABASE_CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/+esm';

// ------------------------------------------------------------------ errors
export class ApiError extends Error {
  constructor(code, message, thai) {
    super(message || code);
    this.code = code;
    this.thai = thai || THAI[code] || null;
  }
}

// Database error codes are raised as the exact message (supabase/README.md "Contract notes").
const THAI = {
  reauth_required: 'ต้องยืนยันรหัสผ่านอีกครั้ง (ภายใน 5 นาที) ก่อนเปิดเทรดจริง',
  mfa_required: 'บัญชีนี้เปิด 2FA ไว้ ต้องใส่รหัส 6 หลักก่อนเปิดเทรดจริง',
  invite_invalid: 'รหัสเชิญไม่ถูกต้อง หมดอายุ ถูกยกเลิก หรือถูกใช้ไปแล้ว',
  already_approved: 'บัญชีนี้ได้รับอนุมัติแล้ว ไม่ต้องใช้รหัสเชิญ',
  not_authenticated: 'ยังไม่ได้เข้าสู่ระบบ หรือเซสชันหมดอายุ เข้าสู่ระบบใหม่',
  not_approved: 'บัญชียังไม่ได้รับอนุมัติ ใส่รหัสเชิญก่อน',
  admin_only: 'รายการนี้สำหรับผู้ดูแลระบบเท่านั้น',
  account_disabled: 'บัญชีนี้ถูกระงับ ติดต่อผู้ดูแลระบบ',
  invite_not_found: 'ไม่พบรหัสเชิญนี้',
  role_invalid: 'สิทธิ์ต้องเป็น admin หรือ member',
  days_invalid: 'อายุรหัสเชิญต้องอยู่ระหว่าง 1 ถึง 365 วัน',
  user_not_found: 'ไม่พบผู้ใช้นี้',
  cannot_demote_self: 'ผู้ดูแลระบบลดสิทธิ์หรือยกเลิกอนุมัติของตัวเองไม่ได้',
  cannot_disable_self: 'ผู้ดูแลระบบระงับบัญชีของตัวเองไม่ได้',
  name_invalid: 'ชื่อต้องยาว 1 ถึง 60 ตัวอักษร (ชื่อบอท 1 ถึง 100)',
  desired_invalid: 'รูปแบบคำสั่งไม่ถูกต้อง',
  bot_id_immutable: 'เปลี่ยนรหัสบอทไม่ได้',
  version_conflict: 'มีการเปลี่ยนคำสั่งจากที่อื่นพร้อมกัน โหลดค่าล่าสุดแล้ว ลองอีกครั้ง',
  not_found: 'ไม่พบข้อมูล (หรือไม่มีสิทธิ์เห็น)',
  aal2_required: 'ต้องยืนยันรหัส 2FA ก่อนทำรายการนี้',
  network: 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ตรวจอินเทอร์เน็ตแล้วลองใหม่',
  permission: 'ไม่มีสิทธิ์ทำรายการนี้ (บัญชียังไม่ได้รับอนุมัติ หรือไม่ใช่เจ้าของบอท)',
  invalid_credentials: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง',
  email_not_confirmed: 'ยังไม่ได้ยืนยันอีเมล เปิดลิงก์ในอีเมลที่ระบบส่งไปก่อน แล้วเข้าสู่ระบบอีกครั้ง',
  user_exists: 'อีเมลนี้สมัครไว้แล้ว ลองเข้าสู่ระบบ หรือใช้ "ลืมรหัสผ่าน"',
  weak_password: 'รหัสผ่านสั้นหรือเดาง่ายเกินไป ใช้อย่างน้อย 8 ตัวอักษร',
  mfa_invalid: 'รหัส 2FA ไม่ถูกต้องหรือหมดเวลา ลองรหัสใหม่จากแอป',
  rate_limit: 'ลองบ่อยเกินไป รอสักครู่แล้วลองใหม่',
  session_expired: 'เซสชันหมดอายุ เข้าสู่ระบบใหม่',
  same_password: 'รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสเดิม',
  storage: 'จัดการไฟล์ไม่สำเร็จ',
  read_only: 'บอทนี้เป็นของสมาชิกคนอื่น ผู้ดูแลดูได้อย่างเดียว สั่งงานไม่ได้',
  not_deployed: 'ส่วนนี้ยังไม่พร้อมในฐานข้อมูล ผู้ดูแลต้องรัน supabase/schema.sql รุ่นใหม่ก่อน',
  push_not_ready: 'ฝั่งเซิร์ฟเวอร์ยังไม่ได้ตั้งค่าการแจ้งเตือน (ผู้ดูแลต้องติดตั้งฟังก์ชัน notify ตามคู่มือใน supabase/README.md)',
  subscription_invalid: 'ข้อมูลการสมัครรับแจ้งเตือนของเบราว์เซอร์นี้ไม่ถูกต้อง ลองปิดแล้วเปิดใหม่',
  events_invalid: 'เรื่องที่จะแจ้งไม่ถูกต้อง',
};

export const THAI_ERRORS = THAI;

export function thaiError(e) {
  if (e instanceof ApiError) return e;
  const msg = String((e && (e.message || e.error_description || e.msg)) || e || '');
  const code = (e && (e.code || e.error_code)) || '';
  const low = msg.toLowerCase();
  const pick = (c) => new ApiError(c, msg);
  // exact database codes first
  const exact = msg.trim();
  if (THAI[exact] && !['network', 'permission', 'not_found', 'version_conflict'].includes(exact)) return pick(exact);
  for (const c of ['reauth_required', 'mfa_required', 'invite_invalid', 'already_approved', 'account_disabled', 'admin_only',
    'not_approved', 'cannot_demote_self', 'cannot_disable_self', 'desired_invalid', 'name_invalid']) {
    if (low.includes(c)) return pick(c);
  }
  if (code === 'PGRST205' || code === '42P01' || low.includes('could not find the table') || (low.includes('relation') && low.includes('does not exist'))) return pick('not_deployed');
  if (low.includes('duplicate key') || code === '23505') return new ApiError('duplicate', msg, 'มีรายการนี้อยู่แล้ว');
  if (code === 'reauthentication_needed' || low.includes('reauthentication')) {
    return new ApiError('reauthentication_needed', msg, 'ต้องยืนยันตัวตนใหม่ก่อนเปลี่ยนรหัสผ่าน ออกจากระบบแล้วเข้าใหม่ แล้วลองอีกครั้ง');
  }
  if (low.includes('invalid login credentials') || code === 'invalid_credentials') return pick('invalid_credentials');
  if (low.includes('email not confirmed') || code === 'email_not_confirmed') return pick('email_not_confirmed');
  if (low.includes('already registered') || code === 'user_already_exists') return pick('user_exists');
  if (low.includes('password should') || code === 'weak_password') return pick('weak_password');
  if (low.includes('different from the old') || code === 'same_password') return pick('same_password');
  if (low.includes('invalid totp') || low.includes('mfa_verification_failed') || code === 'mfa_verification_failed' || low.includes('challenge') && low.includes('expired')) return pick('mfa_invalid');
  if (low.includes('aal2') || code === 'insufficient_aal') return pick('aal2_required');
  if (low.includes('rate limit') || code === 'over_request_rate_limit' || code === 'over_email_send_rate_limit') return pick('rate_limit');
  if (low.includes('jwt expired') || code === 'PGRST301' || code === 'session_not_found') return pick('session_expired');
  if (code === '42501' || low.includes('permission denied') || low.includes('row-level security')) return pick('permission');
  if (low.includes('failed to fetch') || low.includes('networkerror') || low.includes('load failed')) return pick('network');
  return new ApiError(code || 'error', msg, msg ? `เกิดข้อผิดพลาด: ${msg}` : 'เกิดข้อผิดพลาด');
}

export function siteUrl() {
  return location.origin + location.pathname;
}

export function isConfigured() {
  return !!(SUPABASE_URL && SUPABASE_ANON_KEY);
}

export function wantsDemo() {
  return new URLSearchParams(location.search).get('demo') === '1';
}

export async function createApi() {
  if (wantsDemo()) return new DemoApi();
  if (!isConfigured()) return null;
  let mod;
  try {
    mod = await import(SUPABASE_CDN);
  } catch (e) {
    throw new ApiError('cdn', String(e), 'โหลดไลบรารี Supabase จาก cdn.jsdelivr.net ไม่ได้ ตรวจอินเทอร์เน็ตหรือตัวบล็อกโฆษณา แล้วโหลดหน้าใหม่');
  }
  const sb = mod.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'dobby-web-auth' },
  });
  return new SupabaseApi(sb);
}

const unwrap = ({ data, error }) => {
  if (error) throw thaiError(error);
  return data;
};

// ------------------------------------------------------------------ Supabase
export class SupabaseApi {
  constructor(sb) {
    this.sb = sb;
    this.mode = 'supabase';
    this.config = { url: SUPABASE_URL, key: SUPABASE_ANON_KEY };
    this.session = null;
    this.authCbs = new Set();
  }

  async init() {
    this.sb.auth.onAuthStateChange((event, session) => {
      this.session = session;
      // callbacks run outside the auth lock (supabase-js deadlocks if we await auth calls inside)
      setTimeout(() => { for (const cb of this.authCbs) cb(event, this.user()); }, 0);
    });
    const { data, error } = await this.sb.auth.getSession();
    if (error) throw thaiError(error);
    this.session = data.session;
  }

  user() {
    const u = this.session && this.session.user;
    return u ? { id: u.id, email: u.email } : null;
  }
  uid() { const u = this.user(); if (!u) throw new ApiError('session_expired'); return u.id; }
  onAuth(cb) { this.authCbs.add(cb); return () => this.authCbs.delete(cb); }

  async signIn(email, password) {
    const data = unwrap(await this.sb.auth.signInWithPassword({ email, password }));
    this.session = data.session;
    return this.user();
  }
  async signUp(email, password) {
    const data = unwrap(await this.sb.auth.signUp({ email, password, options: { emailRedirectTo: siteUrl() } }));
    if (data.session) this.session = data.session;
    // Supabase returns a user with no identities when the email already exists (and confirmations are on)
    if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) throw new ApiError('user_exists');
    return { needsConfirm: !data.session };
  }
  async signOut() {
    try { this.sb.removeAllChannels(); } catch { /* ignore */ }
    await this.sb.auth.signOut();
    this.session = null;
  }
  async resetPassword(email) { unwrap(await this.sb.auth.resetPasswordForEmail(email, { redirectTo: siteUrl() })); }
  async updatePassword(password) { unwrap(await this.sb.auth.updateUser({ password })); }
  async reauthenticate(password) {
    const email = this.session && this.session.user && this.session.user.email;
    if (!email) throw new ApiError('session_expired');
    const data = unwrap(await this.sb.auth.signInWithPassword({ email, password }));
    this.session = data.session;
  }

  async mfaFactors() {
    const data = unwrap(await this.sb.auth.mfa.listFactors());
    return (data.all || data.totp || []).filter((f) => f.factor_type === 'totp');
  }
  async mfaEnroll() {
    for (const f of await this.mfaFactors()) {
      if (f.status !== 'verified') await this.sb.auth.mfa.unenroll({ factorId: f.id });
    }
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const data = unwrap(await this.sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: `Dobby ${stamp}`, issuer: 'Dobby Web' }));
    return { id: data.id, qr: data.totp.qr_code, secret: data.totp.secret, uri: data.totp.uri };
  }
  async mfaVerify(factorId, code) {
    unwrap(await this.sb.auth.mfa.challengeAndVerify({ factorId, code }));
    const s = await this.sb.auth.getSession();
    this.session = s.data.session;
  }
  async mfaUnenroll(factorId) { unwrap(await this.sb.auth.mfa.unenroll({ factorId })); }
  async aal() {
    const data = unwrap(await this.sb.auth.mfa.getAuthenticatorAssuranceLevel());
    return { current: data.currentLevel, next: data.nextLevel };
  }

  async profile() {
    return unwrap(await this.sb.from('profiles').select('*').eq('id', this.uid()).maybeSingle());
  }
  async redeemInvite(code) {
    return unwrap(await this.sb.rpc('redeem_invite', { p_code: code }));
  }
  async setDisplayName(name) { unwrap(await this.sb.rpc('set_display_name', { p_name: name })); }
  async liveGateStatus() { return unwrap(await this.sb.rpc('live_gate_status')); }
  // bot_control is UPDATE only (rows come from register_bot); bots may be renamed or deleted by the owner.
  // The admin can read other users' bots (RLS), never write them: every write checks ownership first.
  async assertOwn(botId) {
    if (!this.ownIds || !this.ownIds.has(botId)) await this.listBots();
    if (!this.ownIds.has(botId)) throw new ApiError('read_only');
  }
  async renameBot(botId, name) {
    await this.assertOwn(botId);
    return unwrap(await this.sb.from('bots').update({ name }).eq('id', botId).eq('owner', this.uid()).select().single());
  }
  async deleteBot(botId) {
    await this.assertOwn(botId);
    unwrap(await this.sb.from('bots').delete().eq('id', botId).eq('owner', this.uid()));
  }

  async listBots() {
    const rows = unwrap(await this.sb.from('bots').select('*').eq('owner', this.uid()).order('created_at'));
    this.ownIds = new Set(rows.map((b) => b.id));
    return rows;
  }
  // admin: everyone else's bots and presets (read only)
  async adminBots() {
    return unwrap(await this.sb.from('bots').select('*').neq('owner', this.uid()).order('created_at'));
  }
  async adminPresets() {
    return unwrap(await this.sb.from('presets').select('*').neq('owner', this.uid()).order('updated_at', { ascending: false }));
  }
  async journalTail(botId, n = 30) {
    return unwrap(await this.sb.from('journal').select('*').eq('bot_id', botId).order('ts_server', { ascending: false }).order('id', { ascending: false }).limit(n));
  }
  async botStatus(botId) {
    return unwrap(await this.sb.from('bot_status').select('*').eq('bot_id', botId).maybeSingle());
  }
  async botControl(botId) {
    return unwrap(await this.sb.from('bot_control').select('*').eq('bot_id', botId).maybeSingle());
  }
  async updateDesired(botId, desired, expectedVersion) {
    await this.assertOwn(botId);
    let q = this.sb.from('bot_control').update({ desired }).eq('bot_id', botId);
    if (expectedVersion !== undefined && expectedVersion !== null) q = q.eq('version', expectedVersion);
    const data = unwrap(await q.select().maybeSingle());
    if (!data) throw new ApiError('version_conflict');
    return data;
  }
  async journal(botId, { fromServer, toServer, max = 20000 } = {}) {
    const out = [];
    const page = 1000;
    for (let from = 0; from < max; from += page) {
      let q = this.sb.from('journal').select('*').eq('bot_id', botId);
      if (fromServer) q = q.gte('ts_server', fromServer);
      if (toServer) q = q.lte('ts_server', toServer);
      const rows = unwrap(await q.order('ts_server', { ascending: false }).order('id', { ascending: false }).range(from, from + page - 1));
      out.push(...rows);
      if (rows.length < page) break;
    }
    return out;
  }
  subscribeBot(botId, h = {}) {
    if (!this.user()) return () => {}; // realtime only for signed-in users
    const ch = this.sb.channel(`bot-${botId}-${Math.random().toString(36).slice(2, 8)}`);
    const on = (table, filter, fn, event = '*') => {
      if (fn) ch.on('postgres_changes', { event, schema: 'public', table, filter }, (p) => p.new && Object.keys(p.new).length && fn(p.new));
    };
    on('bot_status', `bot_id=eq.${botId}`, h.status);
    on('bot_control', `bot_id=eq.${botId}`, h.control);
    on('bots', `id=eq.${botId}`, h.bot);
    on('journal', `bot_id=eq.${botId}`, h.journal, 'INSERT');
    ch.subscribe((state) => h.state && h.state(state));
    return () => { try { this.sb.removeChannel(ch); } catch { /* ignore */ } };
  }

  async listPresets() {
    return unwrap(await this.sb.from('presets').select('*').eq('owner', this.uid()).order('updated_at', { ascending: false }));
  }
  async createPreset({ name, params, notes }) {
    return unwrap(await this.sb.from('presets').insert({ owner: this.uid(), name, params, notes: notes || null }).select().single());
  }
  async updatePreset(id, patch) {
    return unwrap(await this.sb.from('presets').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id).select().single());
  }
  async deletePreset(id) { unwrap(await this.sb.from('presets').delete().eq('id', id)); }

  async listAudit({ limit = 300 } = {}) {
    return unwrap(await this.sb.from('audit').select('*').order('ts', { ascending: false }).limit(limit));
  }
  async listNews({ fromIso } = {}) {
    let q = this.sb.from('news_events').select('*');
    if (fromIso) q = q.gte('ts_utc', fromIso);
    return unwrap(await q.order('ts_utc').limit(300));
  }
  async saveNews(row) {
    const body = { ts_utc: row.ts_utc, name: row.name, tier: row.tier, note: row.note || null };
    if (row.id) return unwrap(await this.sb.from('news_events').update(body).eq('id', row.id).select().single());
    return unwrap(await this.sb.from('news_events').insert(body).select().single());
  }
  async deleteNews(id) { unwrap(await this.sb.from('news_events').delete().eq('id', id)); }

  async adminOverview() { return unwrap(await this.sb.rpc('admin_overview')); }
  async listInvites() { return unwrap(await this.sb.from('invites').select('*').order('created_at', { ascending: false })); }
  async createInvite(role, days, note) {
    return unwrap(await this.sb.rpc('create_invite', { p_role: role, p_days: days, p_note: note || null }));
  }
  async revokeInvite(code) { unwrap(await this.sb.rpc('revoke_invite', { p_code: code })); }
  async adminSetUser(userId, role, approved, disabled) {
    unwrap(await this.sb.rpc('admin_set_user', { p_user: userId, p_role: role, p_approved: approved, p_disabled: disabled }));
  }

  // ---- feature batch (SPEC 9)
  async bars(botId, fromIso, toIso) {
    return unwrap(await this.sb.from('bars').select('t,close,vwap').eq('bot_id', botId).gte('t', fromIso).lte('t', toIso).order('t').limit(3000));
  }
  async listCashFlows(botId) {
    return unwrap(await this.sb.from('cash_flows').select('*').eq('bot_id', botId).order('ts', { ascending: false }).limit(500));
  }
  async addCashFlow(botId, { ts, amount, note }) {
    await this.assertOwn(botId);
    return unwrap(await this.sb.from('cash_flows').insert({ bot_id: botId, ts, amount, note: note || null, source: 'manual', status: 'confirmed' }).select().single());
  }
  async updateCashFlow(botId, id, patch) {
    await this.assertOwn(botId);
    const body = { ...patch, updated_at: new Date().toISOString() };
    return unwrap(await this.sb.from('cash_flows').update(body).eq('id', id).eq('bot_id', botId).select().single());
  }
  async deleteCashFlow(botId, id) {
    await this.assertOwn(botId);
    unwrap(await this.sb.from('cash_flows').delete().eq('id', id).eq('bot_id', botId));
  }
  async listTradeNotes(botId) {
    return unwrap(await this.sb.from('trade_notes').select('*').eq('bot_id', botId).limit(5000));
  }
  async saveTradeNote(botId, key, { note, tags }) {
    await this.assertOwn(botId);
    const row = { bot_id: botId, trade_key: key, note: note || null, tags: tags || [], updated_at: new Date().toISOString(), updated_by: this.uid() };
    return unwrap(await this.sb.from('trade_notes').upsert(row, { onConflict: 'bot_id,trade_key' }).select().single());
  }
  async deleteTradeNote(botId, key) {
    await this.assertOwn(botId);
    unwrap(await this.sb.from('trade_notes').delete().eq('bot_id', botId).eq('trade_key', key));
  }
  async listPushSubscriptions() {
    return unwrap(await this.sb.from('push_subscriptions').select('*').eq('user_id', this.uid()).order('created_at'));
  }
  // RPC, not an upsert: a browser endpoint subscribed earlier by another account is taken over (RLS would refuse it)
  async savePushSubscription({ endpoint, p256dh, auth, ua, events }) {
    return unwrap(await this.sb.rpc('register_push_subscription', { p_endpoint: endpoint, p_p256dh: p256dh, p_auth: auth, p_ua: ua || null, p_events: events }));
  }
  async updatePushSubscription(endpoint, patch) {
    return unwrap(await this.sb.from('push_subscriptions').update(patch).eq('endpoint', endpoint).select().maybeSingle());
  }
  async deletePushSubscription(endpoint) {
    unwrap(await this.sb.from('push_subscriptions').delete().eq('endpoint', endpoint));
  }
  // The Edge Function `notify` (SPEC 9.7) with {event: "test"}: the apikey header and the user's access token.
  async sendTestPush() {
    const token = this.session && this.session.access_token;
    if (!token) throw new ApiError('session_expired');
    let res;
    try {
      res = await fetch(`${SUPABASE_URL}/functions/v1/notify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
        body: JSON.stringify({ event: 'test' }),
      });
    } catch { throw new ApiError('push_not_ready'); } // not deployed (no CORS answer) or offline
    if (res.status === 404) throw new ApiError('push_not_ready');
    let body = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    if (body && body.error === 'vapid_secrets_missing') throw new ApiError('push_not_ready', 'vapid_secrets_missing', 'ฝั่งเซิร์ฟเวอร์ตั้งค่าการแจ้งเตือนยังไม่ครบ (ยังไม่ได้ใส่คีย์ VAPID ใน Supabase secrets)');
    if (body && THAI[body.error]) throw new ApiError(body.error);
    if (!res.ok) throw new ApiError('push_failed', `notify ${res.status}`, `ส่งทดสอบไม่สำเร็จ (เซิร์ฟเวอร์ตอบ ${res.status}${body && (body.error || body.message) ? `: ${body.error || body.message}` : ''})`);
    return { ok: true, ...(body && typeof body === 'object' ? body : {}) };
  }

  async listDownloads() {
    const rows = unwrap(await this.sb.storage.from('downloads').list('', { limit: 200, sortBy: { column: 'name', order: 'asc' } }));
    return rows.filter((f) => f.id || f.metadata).map((f) => ({ name: f.name, size: f.metadata ? f.metadata.size : null, updated_at: f.updated_at || f.created_at }));
  }
  async downloadUrl(name) {
    const data = unwrap(await this.sb.storage.from('downloads').createSignedUrl(name, 300, { download: name }));
    return data.signedUrl;
  }
  async uploadDownload(file) {
    unwrap(await this.sb.storage.from('downloads').upload(file.name, file, { upsert: true, contentType: file.type || 'application/octet-stream' }));
  }
  async deleteDownload(name) { unwrap(await this.sb.storage.from('downloads').remove([name])); }
}

// ------------------------------------------------------------------ Demo
const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
const pad3 = (n) => String(n).padStart(3, '0');

export class DemoApi {
  constructor() {
    this.mode = 'demo';
    this.config = { url: 'https://your-project.supabase.co', key: 'sb_publishable_xxxxxxxxxxxxxxxxxxxxxxxx' };
    this.db = createDemoDb(Date.now());
    this.uidCur = this.db.user.id;
    this.signedIn = true;
    this.passwordAt = Date.now() - 2 * 3600e3; // signed in two hours ago -> live ON needs a fresh password
    this.aalLevel = 'aal2';
    this.authCbs = new Set();
    this.subs = new Set();
    this.agentTimers = {};
    this.timer = setInterval(() => this.tick(), 4000);
  }

  async wait(ms = 160) { await sleep(ms + Math.random() * 140); }

  async init() {}
  me() { return this.db.profiles.find((p) => p.id === this.uidCur); }
  user() { if (!this.signedIn) return null; const p = this.me(); return p ? { id: p.id, email: p.email } : null; }
  onAuth(cb) { this.authCbs.add(cb); return () => this.authCbs.delete(cb); }
  emitAuth(ev) { setTimeout(() => { for (const cb of this.authCbs) cb(ev, this.user()); }, 0); }
  need() { if (!this.signedIn) throw new ApiError('session_expired'); }

  async signIn(email, password) {
    await this.wait(300);
    if (!email || !password) throw new ApiError('invalid_credentials');
    const p = this.db.profiles.find((x) => x.email.toLowerCase() === String(email).trim().toLowerCase());
    this.uidCur = p ? p.id : this.db.user.id;
    this.signedIn = true;
    this.passwordAt = Date.now();
    this.aalLevel = 'aal1';
    this.emitAuth('SIGNED_IN');
    return this.user();
  }
  async signUp(email, password) {
    await this.wait(300);
    email = String(email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ApiError('invalid_email', 'invalid email', 'อีเมลไม่ถูกต้อง');
    if (String(password).length < 8) throw new ApiError('weak_password');
    if (this.db.profiles.some((p) => p.email === email)) throw new ApiError('user_exists');
    const id = 'demo-u' + Math.random().toString(36).slice(2, 8);
    this.db.profiles.push({ id, email, display_name: email.split('@')[0], role: 'member', approved: false, disabled: false, created_at: new Date().toISOString() });
    this.uidCur = id;
    this.signedIn = true;
    this.passwordAt = Date.now();
    this.aalLevel = 'aal1';
    this.emitAuth('SIGNED_IN');
    return { needsConfirm: false };
  }
  async signOut() { await this.wait(100); this.signedIn = false; this.emitAuth('SIGNED_OUT'); }
  async resetPassword(email) { await this.wait(300); if (!email) throw new ApiError('invalid_email', '', 'ใส่อีเมลก่อน'); }
  async updatePassword(pw) { await this.wait(300); if (String(pw).length < 8) throw new ApiError('weak_password'); }
  async reauthenticate(pw) {
    await this.wait(350);
    if (!pw) throw new ApiError('invalid_credentials');
    this.passwordAt = Date.now();
    this.aalLevel = 'aal1'; // a new password sign-in starts at aal1, like Supabase
  }

  myFactors() { return this.db.factors.filter((f) => (f.owner || this.db.user.id) === this.uidCur); }
  async mfaFactors() { await this.wait(80); return clone(this.myFactors()); }
  async mfaEnroll() {
    await this.wait(300);
    this.db.factors = this.db.factors.filter((f) => f.status === 'verified');
    const id = 'demo-totp-' + Math.random().toString(36).slice(2, 7);
    this.db.factors.push({ id, factor_type: 'totp', status: 'unverified', friendly_name: 'Dobby (ตัวอย่าง)', owner: this.uidCur, created_at: new Date().toISOString() });
    return { id, qr: demoQr(id), secret: 'DEMO' + id.slice(-5).toUpperCase() + 'JBSWY3DPEHPK3PXP', uri: `otpauth://totp/Dobby%20Web:demo?secret=DEMO&issuer=Dobby%20Web` };
  }
  async mfaVerify(factorId, code) {
    await this.wait(300);
    const f = this.db.factors.find((x) => x.id === factorId);
    if (!f) throw new ApiError('not_found');
    if (!/^\d{6}$/.test(String(code)) || code === '000000') throw new ApiError('mfa_invalid');
    f.status = 'verified';
    this.aalLevel = 'aal2';
  }
  async mfaUnenroll(factorId) {
    await this.wait(250);
    const f = this.db.factors.find((x) => x.id === factorId);
    if (f && f.status === 'verified' && this.aalLevel !== 'aal2') throw new ApiError('aal2_required');
    this.db.factors = this.db.factors.filter((x) => x.id !== factorId);
    this.aalLevel = 'aal1';
  }
  async aal() {
    const has = this.myFactors().some((f) => f.status === 'verified');
    return { current: this.aalLevel, next: has ? 'aal2' : 'aal1' };
  }

  async profile() { await this.wait(60); this.need(); return clone(this.me()); }
  async redeemInvite(code) {
    await this.wait(300);
    this.need();
    const me = this.me();
    if (me.disabled) throw new ApiError('account_disabled');
    if (me.approved) return 'already_approved';
    const c = String(code || '').replace(/[\s-]/g, '').toUpperCase();
    const inv = this.db.invites.find((i) => i.code === c);
    if (!inv || inv.used_by || inv.revoked || Date.parse(inv.expires_at) < Date.now()) throw new ApiError('invite_invalid');
    inv.used_by = me.id; inv.used_at = new Date().toISOString();
    me.approved = true; me.role = inv.role;
    this.audit(null, 'invite_redeem', { approved: false }, { approved: true, role: inv.role, code: c });
    return 'ok';
  }
  async setDisplayName(name) {
    await this.wait(); this.need();
    const n = String(name || '').trim();
    if (n.length < 1 || n.length > 60) throw new ApiError('name_invalid');
    const before = this.me().display_name;
    this.me().display_name = n;
    this.audit(null, 'profile_display_name', { display_name: before }, { display_name: n });
  }
  async liveGateStatus() {
    await this.wait(60); this.need();
    if (Date.now() - this.passwordAt > 300000) return 'reauth_required';
    if (this.myFactors().some((f) => f.status === 'verified') && this.aalLevel !== 'aal2') return 'mfa_required';
    return 'ok';
  }
  async renameBot(botId, name) {
    await this.wait();
    const b = this.ownBot(botId, true);
    const n = String(name || '').trim();
    if (n.length < 1 || n.length > 100) throw new ApiError('name_invalid');
    b.name = n;
    return clone(b);
  }
  async deleteBot(botId) {
    await this.wait();
    const b = this.ownBot(botId, true);
    this.db.bots = this.db.bots.filter((x) => x.id !== botId);
    this.db.control = this.db.control.filter((c) => c.bot_id !== botId);
    this.audit(botId, 'bot_delete', { id: b.id, owner: b.owner, name: b.name, created_at: b.created_at }, null);
  }

  isAdmin() { const p = this.me(); return p && p.approved && !p.disabled && p.role === 'admin'; }
  approvedOrThrow() { this.need(); const p = this.me(); if (!p || !p.approved || p.disabled) throw new ApiError('permission'); }

  async listBots() { await this.wait(); this.approvedOrThrow(); if (this.noBots) return []; return clone(this.db.bots.filter((b) => b.owner === this.uidCur)); }
  // Demo only: show the "no bot yet" state (reachable from the guide); the demo bots come back with on = false.
  setDemoNoBots(on) { this.noBots = !!on; }
  // the admin reads every bot (like the RLS SELECT policies); everyone else reads their own
  async adminBots() { await this.wait(); if (!this.isAdmin()) throw new ApiError('admin_only'); return clone(this.db.bots.filter((b) => b.owner !== this.uidCur)); }
  statusRow(botId) {
    const sim = this.db.sims[botId];
    // an offline PC stopped sending: its status is frozen at the moment it went quiet
    return sim ? { bot_id: botId, updated_at: new Date(sim.cfg.offlineAt || Date.now()).toISOString(), status: sim.status(sim.cfg.offlineAt || Date.now()) } : null;
  }
  readBot(botId) {
    this.approvedOrThrow();
    const b = this.db.bots.find((x) => x.id === botId && (x.owner === this.uidCur || this.isAdmin()));
    if (!b) throw new ApiError('not_found');
    return b;
  }
  // writes: the owner only. Someone else's bot is refused (RLS: 0 rows updated); `write` gives the clearer error.
  ownBot(botId, write = false) {
    this.approvedOrThrow();
    const b = this.db.bots.find((x) => x.id === botId);
    if (b && b.owner !== this.uidCur && write && this.isAdmin()) throw new ApiError('read_only');
    if (!b || b.owner !== this.uidCur) throw new ApiError('not_found');
    return b;
  }
  async botStatus(botId) { await this.wait(80); this.readBot(botId); return clone(this.statusRow(botId)); }
  async botControl(botId) { await this.wait(80); this.readBot(botId); return clone(this.db.control.find((c) => c.bot_id === botId) || null); }

  async updateDesired(botId, desired, expectedVersion) {
    await this.wait(250);
    this.ownBot(botId, true);
    const row = this.db.control.find((c) => c.bot_id === botId);
    if (!row) throw new ApiError('not_found');
    if (expectedVersion !== undefined && expectedVersion !== null && row.version !== expectedVersion) throw new ApiError('version_conflict');
    // live gate (SPEC 2.4), same rules as the database trigger
    const was = !!(row.desired && row.desired.live), now = !!desired.live;
    if (!was && now) {
      if (Date.now() - this.passwordAt > 300000) throw new ApiError('reauth_required', 'reauth_required');
      if (this.myFactors().some((f) => f.status === 'verified') && this.aalLevel !== 'aal2') throw new ApiError('mfa_required', 'mfa_required');
    }
    const before = clone(row.desired);
    row.desired = clone(desired);
    row.version += 1;
    row.updated_by = this.uidCur;
    row.updated_at = new Date().toISOString();
    this.audit(botId, 'control', before, row.desired);
    this.emit(botId, 'control', clone(row));
    this.scheduleAgent(botId);
    return clone(row);
  }

  async journal(botId, { fromServer, toServer } = {}) {
    await this.wait(200);
    this.readBot(botId);
    const rows = this.db.sims[botId].rows.filter((r) => (!fromServer || r.ts_server >= fromServer) && (!toServer || r.ts_server <= toServer));
    return clone(rows).reverse();
  }
  async journalTail(botId, n = 30) {
    await this.wait(80);
    this.readBot(botId);
    return clone(this.db.sims[botId].rows.slice(-n)).reverse();
  }

  subscribeBot(botId, handlers = {}) {
    if (!this.signedIn) return () => {};
    try { this.readBot(botId); } catch { return () => {}; } // realtime follows RLS
    const sub = { botId, h: handlers };
    this.subs.add(sub);
    setTimeout(() => handlers.state && handlers.state('SUBSCRIBED'), 50);
    return () => this.subs.delete(sub);
  }
  emit(botId, kind, payload) {
    for (const s of this.subs) if (s.botId === botId && s.h[kind]) { try { s.h[kind](clone(payload)); } catch (e) { console.error(e); } }
  }

  tick() {
    const now = Date.now();
    for (const bot of this.db.bots) {
      const sim = this.db.sims[bot.id];
      if (!sim || bot.offline) continue; // an offline PC sends nothing
      sim.tick(now);
      bot.last_seen = new Date(now - 1000).toISOString();
      bot.agent_state.ea_heartbeat_age_s = 1 + Math.floor(Math.random() * 4);
      // a new M15 bar closed: the agent sends the rolled 24 h window (SPEC 8)
      const bars = bot.agent_state.bars;
      if (bars && bars.t && now / 1000 - bars.t[bars.t.length - 1] >= 1800) bot.agent_state = { ...bot.agent_state, bars: sim.bars(now) };
      this.emit(bot.id, 'status', this.statusRow(bot.id));
      this.emit(bot.id, 'bot', bot);
    }
  }

  // Simulated PC agent (SPEC 3.4 step 4 / 3.5): applies a new version about 2.5 s later.
  scheduleAgent(botId) {
    clearTimeout(this.agentTimers[botId]);
    this.agentTimers[botId] = setTimeout(() => this.agentApply(botId), 2500);
  }
  agentApply(botId) {
    const bot = this.db.bots.find((b) => b.id === botId);
    const row = this.db.control.find((c) => c.bot_id === botId);
    const sim = this.db.sims[botId];
    const lim = bot.agent_state.limits;
    const d = row.desired || {};
    const c = d.control || {};
    const rejected = [];
    if (!lim.allow_remote_control) {
      bot.agent_state = { ...bot.agent_state, rejected: ['remote_control_disabled'] };
      this.emit(botId, 'bot', bot);
      return;
    }
    let live = !!d.live;
    if (live && !sim.applied.live && !lim.allow_remote_live) { rejected.push('live_not_allowed_locally'); live = sim.applied.live; }
    let lots = c.lots ?? null;
    if (lots !== null && lots > lim.max_lots) { lots = lim.max_lots; rejected.push('lots_clamped'); }
    const off = bot.server_utc_offset_min ?? DEMO_OFFSET_MIN;
    const now = Date.now();
    const blackouts = (d.blackouts || []).filter((b) => Date.parse(b.to_utc) > now).map((b) => [
      utcToServer(Date.parse(b.from_utc), off), utcToServer(Date.parse(b.to_utc), off),
    ]);
    sim.applied = {
      version: row.version, live, mode: c.mode === 'pause' ? 'pause' : 'run', lots, allow_long: c.allow_long !== false, allow_short: c.allow_short !== false,
      max_spread: c.max_spread ?? null, note: c.note || '', blackouts, applied_at: utcToServer(now, off, true),
    };
    const P = sim.params;
    const parts = [`mode=${live && sim.applied.mode === 'run' ? 'run' : 'pause'}`, `lots=${Number(lots ?? P.InpLotsA).toFixed(2)}`,
      `long=${sim.applied.allow_long}`, `short=${sim.applied.allow_short}`, `max_spread=${Number(sim.applied.max_spread ?? P.InpMaxSpread).toFixed(2)}`,
      `blackouts=${blackouts.length}`];
    sim.add(now + off * 60000, 'CONTROL', 'A_new', 'NONE', lots ?? P.InpLotsA, null, null, null, 0, 0,
      `control file W${pad3(row.version)} -> ${parts.join(' ')}${c.note ? ' note: ' + c.note : ''}`);
    this.emit(botId, 'journal', sim.rows[sim.rows.length - 1]);

    if (d.params && typeof d.params === 'object') {
      if (!lim.allow_remote_params) rejected.push('params_not_allowed_locally');
      else if (!sim.remote) rejected.push('params_need_ea_v304');
      else {
        const next = normalizeParams({ ...P, ...d.params });
        const unknown = Object.keys(d.params).filter((k) => !REMOTE_KEYS.includes(k));
        const overLots = ['InpLotsA', 'InpLotsNY', 'InpLotsC5G', 'InpMaxLots', 'InpLotsAsia'].some((k) => next[k] > lim.max_lots + 1e-9);
        if (unknown.length) rejected.push('params_unknown_key');
        else if (overLots) rejected.push('params_lots_over_limit');
        else if (next.InpDailyCapPct > lim.max_daily_cap_pct) rejected.push('params_cap_over_limit');
        else this.remoteParams(botId, sim, row.version, next);
      }
    }
    bot.agent_state = {
      ...bot.agent_state, applied_version: row.version, applied_at: new Date(now).toISOString(), rejected,
      control_file_id: `W${pad3(row.version)}`, remote_file_version: sim.remote ? row.version : null,
    };
    this.emit(botId, 'bot', bot);
    this.emit(botId, 'status', this.statusRow(botId));
  }
  // EA v3.04: params wait until the bot is flat (SPEC 4.3). The demo closes the open position after ~12 s.
  remoteParams(botId, sim, version, next) {
    sim.remote.version = version;
    const changes = Object.keys(next).filter((k) => REMOTE_KEYS.includes(k) && next[k] !== sim.params[k]);
    const apply = () => {
      const txt = changes.map((k) => `${k} ${formatValue(PARAM_BY_KEY[k], sim.params[k])}->${formatValue(PARAM_BY_KEY[k], next[k])}`).join(', ') || 'no change';
      sim.params = { ...sim.params, ...remoteSubset(next) };
      sim.remote.applied_version = version; sim.remote.pending = false; sim.remote.waiting = '';
      sim.add(Date.now() + DEMO_OFFSET_MIN * 60000, 'REMOTE', 'A_new', 'NONE', sim.params.InpLotsA, null, null, null, 0, 0, `REMOTE APPLY v${version}: ${txt}`);
      this.emit(botId, 'journal', sim.rows[sim.rows.length - 1]);
      this.emit(botId, 'status', this.statusRow(botId));
    };
    if (sim.position) {
      sim.remote.pending = true; sim.remote.waiting = 'open position';
      sim.add(Date.now() + DEMO_OFFSET_MIN * 60000, 'REMOTE', 'A_new', 'NONE', sim.params.InpLotsA, null, null, null, 0, 0, `REMOTE WAIT v${version}: open position`);
      this.emit(botId, 'journal', sim.rows[sim.rows.length - 1]);
      setTimeout(() => {
        if (sim.remote.version !== version) return;
        const closeRow = sim.closePosition(Date.now(), 'TIME');
        if (closeRow) this.emit(botId, 'journal', closeRow);
        apply();
      }, 12000);
    } else apply();
  }

  audit(botId, action, before, after) {
    const id = Math.max(0, ...this.db.audit.map((a) => a.id)) + 1;
    this.db.audit.unshift({ id, ts: new Date().toISOString(), actor: this.uidCur, bot_id: botId, action, before: clone(before) ?? null, after: clone(after) ?? null });
  }

  async listPresets() { await this.wait(); this.approvedOrThrow(); return clone(this.db.presets.filter((p) => p.owner === this.uidCur).sort((a, b) => b.updated_at.localeCompare(a.updated_at))); }
  async adminPresets() { await this.wait(); if (!this.isAdmin()) throw new ApiError('admin_only'); return clone(this.db.presets.filter((p) => p.owner !== this.uidCur).sort((a, b) => b.updated_at.localeCompare(a.updated_at))); }
  async createPreset({ name, params, notes }) {
    await this.wait(); this.approvedOrThrow();
    const now = new Date().toISOString();
    const row = { id: 'demo-preset-' + Math.random().toString(36).slice(2, 8), owner: this.uidCur, name, params: clone(params), notes: notes || null, created_at: now, updated_at: now };
    this.db.presets.push(row);
    this.audit(null, 'preset_insert', null, { name, owner: this.uidCur });
    return clone(row);
  }
  async updatePreset(id, patch) {
    await this.wait(); this.approvedOrThrow();
    const row = this.db.presets.find((p) => p.id === id && p.owner === this.uidCur);
    if (!row) throw new ApiError('not_found');
    const before = { name: row.name, notes: row.notes };
    Object.assign(row, clone(patch), { updated_at: new Date().toISOString() });
    this.audit(null, 'preset_update', before, { name: row.name, notes: row.notes });
    return clone(row);
  }
  async deletePreset(id) {
    await this.wait(); this.approvedOrThrow();
    const row = this.db.presets.find((p) => p.id === id && p.owner === this.uidCur);
    this.db.presets = this.db.presets.filter((p) => p.id !== id);
    if (row) this.audit(null, 'preset_delete', { name: row.name }, null);
  }

  async listAudit({ limit = 300 } = {}) {
    await this.wait(); this.approvedOrThrow();
    const mine = new Set(this.db.bots.filter((b) => b.owner === this.uidCur).map((b) => b.id));
    return clone(this.db.audit.filter((a) => this.isAdmin() || a.actor === this.uidCur || (a.bot_id && mine.has(a.bot_id))).slice(0, limit));
  }

  async listNews({ fromIso } = {}) { await this.wait(); this.approvedOrThrow(); return clone(this.db.news.filter((n) => !fromIso || n.ts_utc >= fromIso)); }
  async saveNews(row) {
    await this.wait(); if (!this.isAdmin()) throw new ApiError('admin_only');
    if (row.id) {
      const r = this.db.news.find((n) => n.id === row.id);
      Object.assign(r, { ts_utc: row.ts_utc, name: row.name, tier: row.tier, note: row.note || null });
    } else {
      if (this.db.news.some((n) => n.ts_utc === row.ts_utc && n.name === row.name)) throw new ApiError('duplicate', 'duplicate', 'มีข่าวชื่อนี้ในเวลานี้อยู่แล้ว');
      this.db.news.push({ id: Math.max(0, ...this.db.news.map((n) => n.id)) + 1, ts_utc: row.ts_utc, name: row.name, tier: row.tier, note: row.note || null });
    }
    this.db.news.sort((a, b) => a.ts_utc.localeCompare(b.ts_utc));
  }
  async deleteNews(id) { await this.wait(); if (!this.isAdmin()) throw new ApiError('admin_only'); this.db.news = this.db.news.filter((n) => n.id !== id); }

  async adminOverview() {
    await this.wait(); if (!this.isAdmin()) throw new ApiError('admin_only');
    return this.db.profiles.map((p) => {
      const own = this.db.bots.filter((b) => b.owner === p.id);
      return {
        user_id: p.id, display_name: p.display_name, role: p.role, approved: p.approved, disabled: p.disabled, created_at: p.created_at,
        bots: own.length, last_seen: own.length ? own.map((b) => b.last_seen).sort().pop() : null, email: p.email,
      };
    });
  }
  async listInvites() { await this.wait(); if (!this.isAdmin()) throw new ApiError('admin_only'); return clone(this.db.invites.slice().sort((a, b) => b.created_at.localeCompare(a.created_at))); }
  async createInvite(role = 'member', days = 7, note = null) {
    await this.wait(); if (!this.isAdmin()) throw new ApiError('admin_only');
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do { code = Array.from({ length: 10 }, () => A[Math.floor(Math.random() * A.length)]).join(''); } while (this.db.invites.some((i) => i.code === code));
    const now = Date.now();
    this.db.invites.push({ code, role, note: note || null, created_by: this.uidCur, created_at: new Date(now).toISOString(), expires_at: new Date(now + days * 86400000).toISOString(), used_by: null, used_at: null, revoked: false });
    this.audit(null, 'admin_create_invite', null, { code, role, days, note });
    return code;
  }
  async revokeInvite(code) {
    await this.wait(); if (!this.isAdmin()) throw new ApiError('admin_only');
    const inv = this.db.invites.find((i) => i.code === code);
    if (inv) { inv.revoked = true; this.audit(null, 'admin_revoke_invite', { code, revoked: false }, { code, revoked: true }); }
  }
  async adminSetUser(userId, role, approved, disabled) {
    await this.wait(); if (!this.isAdmin()) throw new ApiError('admin_only');
    const p = this.db.profiles.find((x) => x.id === userId);
    if (!p) throw new ApiError('user_not_found');
    // null = keep (like the RPC)
    role = role ?? p.role; approved = approved ?? p.approved; disabled = disabled ?? p.disabled;
    if (role !== 'admin' && role !== 'member') throw new ApiError('role_invalid');
    if (userId === this.uidCur && (role !== 'admin' || !approved)) throw new ApiError('cannot_demote_self');
    if (userId === this.uidCur && disabled) throw new ApiError('cannot_disable_self');
    const before = { role: p.role, approved: p.approved, disabled: p.disabled };
    Object.assign(p, { role, approved, disabled });
    this.audit(null, 'admin_set_user', { user: p.display_name, ...before }, { user: p.display_name, role, approved, disabled });
  }

  // ---- feature batch (SPEC 9), same rules as the RLS policies: the owner writes, the admin reads
  async bars(botId, fromIso, toIso) {
    await this.wait(120);
    this.readBot(botId);
    const sim = this.db.sims[botId];
    if (!sim) return [];
    // demo: a window that starts 3 h before a trade (the trade page) follows that trade's own prices
    const from = Date.parse(fromIso), to = Date.parse(toIso);
    return clone(sim.barsBetween(from, to, Date.now(), sim.anchorsFor(from + 3 * 3600000)));
  }
  async listCashFlows(botId) {
    await this.wait(); this.readBot(botId);
    return clone(this.db.flows.filter((f) => f.bot_id === botId).sort((a, b) => b.ts.localeCompare(a.ts)));
  }
  async addCashFlow(botId, { ts, amount, note }) {
    await this.wait(); this.ownBot(botId, true);
    const a = Number(amount);
    if (!Number.isFinite(a) || a === 0) throw new ApiError('amount_invalid', 'amount', 'จำนวนเงินต้องไม่เป็น 0');
    const now = new Date().toISOString();
    const row = { id: Math.max(0, ...this.db.flows.map((f) => f.id)) + 1, bot_id: botId, ts, amount: a, source: 'manual', status: 'confirmed', balance_after: null, note: note || null, created_at: now, updated_at: now };
    this.db.flows.push(row);
    this.audit(botId, 'cash_flow_insert', null, { amount: a, ts, note: row.note });
    return clone(row);
  }
  async updateCashFlow(botId, id, patch) {
    await this.wait(); this.ownBot(botId, true);
    const row = this.db.flows.find((f) => f.id === id && f.bot_id === botId);
    if (!row) throw new ApiError('not_found');
    if (patch.amount !== undefined && (!Number.isFinite(Number(patch.amount)) || Number(patch.amount) === 0)) throw new ApiError('amount_invalid', 'amount', 'จำนวนเงินต้องไม่เป็น 0');
    const before = { amount: row.amount, status: row.status, ts: row.ts, note: row.note };
    Object.assign(row, clone(patch), { updated_at: new Date().toISOString() });
    this.audit(botId, 'cash_flow_update', before, { amount: row.amount, status: row.status, ts: row.ts, note: row.note });
    return clone(row);
  }
  async deleteCashFlow(botId, id) {
    await this.wait(); this.ownBot(botId, true);
    const row = this.db.flows.find((f) => f.id === id && f.bot_id === botId);
    this.db.flows = this.db.flows.filter((f) => !(f.id === id && f.bot_id === botId));
    if (row) this.audit(botId, 'cash_flow_delete', { amount: row.amount, ts: row.ts, note: row.note }, null);
  }
  async listTradeNotes(botId) {
    await this.wait(80); this.readBot(botId);
    return clone(this.db.notes.filter((x) => x.bot_id === botId));
  }
  async saveTradeNote(botId, key, { note, tags }) {
    await this.wait(); this.ownBot(botId, true);
    let row = this.db.notes.find((x) => x.bot_id === botId && x.trade_key === key);
    if (!row) { row = { bot_id: botId, trade_key: key }; this.db.notes.push(row); }
    Object.assign(row, { note: note || null, tags: [...(tags || [])], updated_at: new Date().toISOString(), updated_by: this.uidCur });
    return clone(row);
  }
  async deleteTradeNote(botId, key) {
    await this.wait(); this.ownBot(botId, true);
    this.db.notes = this.db.notes.filter((x) => !(x.bot_id === botId && x.trade_key === key));
  }
  // push: own rows only (no admin read). The demo "device" is this browser tab.
  async listPushSubscriptions() { await this.wait(80); this.approvedOrThrow(); return clone(this.db.push.filter((x) => x.user_id === this.uidCur)); }
  // like the RPC register_push_subscription: validates, and an endpoint of another account is taken over
  async savePushSubscription({ endpoint, p256dh, auth, ua, events }) {
    await this.wait(); this.approvedOrThrow();
    if (!/^https:\/\//.test(endpoint || '') || !p256dh || !auth) throw new ApiError('subscription_invalid');
    if (events && !events.every((e) => ['open', 'close', 'daycap', 'offline'].includes(e))) throw new ApiError('events_invalid');
    let row = this.db.push.find((x) => x.endpoint === endpoint);
    if (row) row.user_id = this.uidCur;
    if (!row) { row = { id: Math.max(0, ...this.db.push.map((x) => x.id)) + 1, user_id: this.uidCur, endpoint, created_at: new Date().toISOString() }; this.db.push.push(row); }
    Object.assign(row, { p256dh, auth, ua: ua ? String(ua).slice(0, 500) : null, events: [...(events || ['open', 'close', 'daycap', 'offline'])] });
    return row.id;
  }
  async updatePushSubscription(endpoint, patch) {
    await this.wait(); this.approvedOrThrow();
    const row = this.db.push.find((x) => x.endpoint === endpoint && x.user_id === this.uidCur);
    if (row) Object.assign(row, clone(patch));
    return clone(row || null);
  }
  async deletePushSubscription(endpoint) {
    await this.wait(); this.approvedOrThrow();
    this.db.push = this.db.push.filter((x) => !(x.endpoint === endpoint && x.user_id === this.uidCur));
  }
  async sendTestPush() {
    await this.wait(500); this.approvedOrThrow();
    const n = this.db.push.filter((x) => x.user_id === this.uidCur).length;
    return { ok: true, sent: n, removed: 0, failed: 0, demo: true };
  }

  async listDownloads() { await this.wait(); this.approvedOrThrow(); return clone(this.db.downloads); }
  async downloadUrl() { await this.wait(); return null; }
  async uploadDownload(file) {
    await this.wait(400); if (!this.isAdmin()) throw new ApiError('admin_only');
    this.db.downloads = this.db.downloads.filter((f) => f.name !== file.name);
    this.db.downloads.push({ name: file.name, size: file.size, updated_at: new Date().toISOString() });
    this.db.downloads.sort((a, b) => a.name.localeCompare(b.name));
  }
  async deleteDownload(name) { await this.wait(); if (!this.isAdmin()) throw new ApiError('admin_only'); this.db.downloads = this.db.downloads.filter((f) => f.name !== name); }
}

// A QR-looking placeholder (not scannable) for the demo 2FA enrolment.
function demoQr(seed) {
  let s = 0;
  for (const ch of seed) s = (s * 31 + ch.charCodeAt(0)) >>> 0;
  const n = 25, cell = 8;
  let rects = '';
  const finder = (x, y) => `<rect x="${x * cell}" y="${y * cell}" width="${7 * cell}" height="${7 * cell}" fill="#111"/><rect x="${(x + 1) * cell}" y="${(y + 1) * cell}" width="${5 * cell}" height="${5 * cell}" fill="#fff"/><rect x="${(x + 2) * cell}" y="${(y + 2) * cell}" width="${3 * cell}" height="${3 * cell}" fill="#111"/>`;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const inFinder = (x < 8 && y < 8) || (x > n - 9 && y < 8) || (x < 8 && y > n - 9);
      s = (s * 1103515245 + 12345) >>> 0;
      if (!inFinder && (s >>> 16) % 2) rects += `<rect x="${x * cell}" y="${y * cell}" width="${cell}" height="${cell}" fill="#111"/>`;
    }
  }
  const size = n * cell;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-16 -16 ${size + 32} ${size + 32}"><rect x="-16" y="-16" width="${size + 32}" height="${size + 32}" fill="#fff"/>${rects}${finder(0, 0)}${finder(n - 7, 0)}${finder(0, n - 7)}</svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}
