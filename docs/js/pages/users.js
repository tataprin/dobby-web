// ผู้ใช้ (admin): two views.
//   บอทของสมาชิก  every other user's bots at a glance, read only (RLS lets the admin SELECT them; writes stay owner-only):
//                 status, trading state, blackout, rejections, versions, strategies + lots, lock stages, daily cap,
//                 balance / today / since start, open trades, the last trade, the settings summary, saved presets,
//                 and "ดูบอทนี้" (opens ภาพรวม / ประวัติ / ตั้งค่าบอท for that bot in view-only mode).
//   ผู้ใช้และรหัสเชิญ  admin_overview, invites (create with copy, list, revoke), set role / approve / disable.
//   ผู้ช่วย AI       users-ai.js: on / off, limits, budget, model, this month's usage (SPEC 10.4).
import { h, mount, icon, fmtNum, fmtSigned, fmtThai, ago, toast, errText, confirmDialog, errorState, loadingState, emptyState, field, busy,
  copyText, callout, money, serverToUtc, thaiDayKey, toneOf, onWake } from '../util.js';
import { app, selectBot } from '../state.js';
import { renderAi } from './users-ai.js';
import { panel, pageHead, modChip, sideEl } from '../views.js';
import { normDesired, onlineInfo, heroState, rejectionInfo, activeBlackout, isPending } from '../botctl.js';
import { currentValues, summaryText, lockText, pctText, STRATS, ASIA } from '../simple.js';
import { EVENT_LABELS, REASON_LABELS } from '../journal.js';
import { botPnlOf } from '../rounds.js';

// a rejection in a 28 px chip (the full reason is the chip's title and on the bot's ตั้งค่าบอท page)
const shortReject = (code) => (/lots/.test(code) ? 'ล็อตถูกลดตามเพดานเครื่อง' : /live/.test(code) ? 'เครื่องไม่ให้เปิดเทรดจริง'
  : /param|cap|unknown|v304/.test(code) ? 'เครื่องไม่รับค่าที่ส่ง' : /remote_control/.test(code) ? 'เครื่องปิดการสั่งจากเว็บ' : 'เครื่องปฏิเสธคำสั่ง');
const TABS = [{ id: 'bots', label: 'บอทของสมาชิก', icon: 'monitor' }, { id: 'people', label: 'ผู้ใช้และรหัสเชิญ', icon: 'users' }, { id: 'ai', label: 'ผู้ช่วย AI', icon: 'chat' }];
const initial = (name) => { const s = String(name || '?').trim(); return (/^[เ-ไ]/.test(s) ? s.slice(0, 2) : s.slice(0, 1)).toUpperCase(); };

export async function render(root, ctx) {
  const tab = TABS.some((t) => t.id === ctx.query.get('tab')) ? ctx.query.get('tab') : 'bots';
  root.append(pageHead('ผู้ใช้', 'ดูบอทของสมาชิกทุกคนแบบดูอย่างเดียว และจัดการผู้ใช้กับรหัสเชิญ', null, 'start'),
    h('div', { class: 'view-tabs' }, h('nav', { class: 'segmented', 'aria-label': 'มุมมอง' }, TABS.map((t) => h('a', {
      href: `#/users${t.id === 'bots' ? '' : `?tab=${t.id}`}`, class: tab === t.id ? 'on' : '', 'aria-current': tab === t.id ? 'page' : null,
    }, icon(t.icon), t.label)))));
  if (tab === 'ai') return renderAi(root, ctx);
  return tab === 'bots' ? renderBots(root, ctx) : renderPeople(root, ctx);
}

// ------------------------------------------------------------------ บอทของสมาชิก (read only)
async function renderBots(root, ctx) {
  const box = h('div', { class: 'members' }, loadingState('กำลังโหลดบอทของสมาชิก…'));
  root.append(box);
  let users = [], bots = [], presets = [];
  const data = {}; // botId -> {st, ctl, tail}

  async function load() {
    [users, bots, presets] = await Promise.all([ctx.api.adminOverview(), ctx.api.adminBots(), ctx.api.adminPresets().catch(() => [])]);
    await Promise.all(bots.map(async (b) => {
      const [s, c, t] = await Promise.all([ctx.api.botStatus(b.id).catch(() => null), ctx.api.botControl(b.id).catch(() => null), ctx.api.journalTail(b.id, 30).catch(() => [])]);
      data[b.id] = { st: s ? s.status : null, ctl: c, tail: t || [] };
    }));
  }
  try { await load(); } catch (e) { mount(box, errorState(e, () => ctx.route())); return undefined; }

  function draw() {
    const me = app.user && app.user.id;
    const members = users.filter((u) => u.user_id !== me);
    if (!members.length) { mount(box, emptyState('ยังไม่มีสมาชิก', 'สร้างรหัสเชิญในแท็บ "ผู้ใช้และรหัสเชิญ" แล้วส่งให้เพื่อน')); return; }
    const rank = (u) => (u.disabled ? 4 : !u.approved ? 3 : bots.some((b) => b.owner === u.user_id) ? 1 : 2);
    members.sort((a, b) => rank(a) - rank(b) || String(a.display_name || a.email).localeCompare(String(b.display_name || b.email), 'th'));
    mount(box, overviewFigs(members), members.map((u) => memberBlock(u)));
  }

  // four counts at the top: members, bots online, trading live, open trades
  function overviewFigs(members) {
    const approved = members.filter((u) => u.approved && !u.disabled).length;
    const pending = members.filter((u) => !u.approved && !u.disabled).length;
    const online = bots.filter((b) => onlineInfo(b, (data[b.id] || {}).st).online).length;
    const live = bots.filter((b) => heroState(b, (data[b.id] || {}).st, (data[b.id] || {}).ctl).tone === 'live').length;
    const open = bots.reduce((n, b) => n + (((data[b.id] || {}).st || {}).positions || []).filter((p) => p.open).length, 0);
    const pnl = bots.reduce((n, b) => n + Number((((data[b.id] || {}).st || {}).virtual || {}).day_pnl || 0), 0);
    const fig = (label, value, foot) => h('div', { class: 'fig' }, h('p', { class: 'fig-label' }, label), h('p', { class: 'fig-value' }, value), h('div', { class: 'fig-foot' }, h('p', null, foot)));
    return h('section', { class: 'figs', 'aria-label': 'สรุปสมาชิก' },
      fig('สมาชิก', h('span', { class: 'num' }, String(approved)), pending ? `รออนุมัติ ${pending} คน` : 'อนุมัติแล้วทุกคน'),
      fig('บอทออนไลน์', [h('span', { class: 'num' }, String(online)), h('span', { class: 'unit' }, `จาก ${bots.length}`)], bots.length - online ? `ออฟไลน์ ${bots.length - online} เครื่อง` : 'ทุกเครื่องออนไลน์'),
      fig('เทรดจริงอยู่', [h('span', { class: 'num' }, String(live)), h('span', { class: 'unit' }, 'เครื่อง')], open ? `ไม้ที่เปิดอยู่ ${open} ไม้` : 'ไม่มีไม้เปิดอยู่'),
      fig('กำไรขาดทุนวันนี้ รวม', money(pnl, { signed: true, unit: 'USD' }), 'รวมทุกบอทของสมาชิก'));
  }

  function memberBlock(u) {
    const own = bots.filter((b) => b.owner === u.user_id);
    const name = u.display_name || u.email || 'สมาชิก';
    const state = u.disabled ? ['ระงับ', 'bad'] : !u.approved ? ['รออนุมัติ', 'warn'] : ['อนุมัติแล้ว', 'good'];
    const mine = presets.filter((p) => p.owner === u.user_id);
    return h('section', { class: 'member', 'aria-label': name },
      h('div', { class: 'member-head' },
        h('span', { class: 'avatar', 'aria-hidden': 'true' }, initial(name)),
        h('div', { class: 'grow member-who' }, h('h2', { class: 'member-name' }, name), h('p', { class: 'muted small' }, u.email || '')),
        h('div', { class: 'chips member-chips' },
          h('span', { class: 'chip' }, u.role === 'admin' ? 'ผู้ดูแล' : 'สมาชิก'),
          h('span', { class: `chip ${state[1]}` }, icon(state[1] === 'good' ? 'check' : 'warn'), state[0]),
          h('span', { class: 'chip quiet-chip' }, own.length ? `${own.length} บอท` : 'ไม่มีบอท'))),
      // one bot: a full-width card with the facts in two columns; more: two cards per row (equal heights)
      own.length ? h('div', { class: own.length === 1 ? 'member-bots single' : 'grid-2 member-bots' }, own.map((b) => botCard(b, mine)))
        : h('div', { class: 'member-empty' },
          h('span', { class: 'pos-empty-ico', 'aria-hidden': 'true' }, icon(u.disabled ? 'lock' : !u.approved ? 'clock' : 'monitor')),
          h('div', { class: 'grow' },
            h('p', { class: 'state-title' }, u.disabled ? 'บัญชีนี้ถูกระงับ' : !u.approved ? 'ยังไม่ได้รับอนุมัติ' : 'ยังไม่มีบอท'),
            h('p', { class: 'muted' }, u.disabled ? 'เข้าเว็บไม่ได้ และเห็นข้อมูลไม่ได้' : !u.approved ? 'สมัครแล้ว แต่ยังไม่ได้ใส่รหัสเชิญหรือยังไม่ได้รับอนุมัติ'
              : 'เมื่อเชื่อมคอมที่เปิด MT5 กับเว็บแล้ว บอทจะขึ้นที่นี่')),
          !u.approved && !u.disabled ? h('a', { class: 'btn', href: '#/users?tab=people' }, icon('users'), 'ไปที่ผู้ใช้และรหัสเชิญ') : null));
  }

  function botCard(b, mine) {
    const { st, ctl, tail } = data[b.id] || {};
    const off = b.server_utc_offset_min ?? 0;
    const info = onlineInfo(b, st);
    const hs = heroState(b, st, ctl);
    const d = normDesired(ctl && ctl.desired);
    const cur = (st && st.account && st.account.currency) || 'USD';
    const v = st ? currentValues(st, d.params).values : null;
    const a = (st && st.account) || {}, vv = (st && st.virtual) || {};
    const ver = (st && st.ea_version) || b.ea_version || '';
    // trading state in one chip, from the owner's commands (online / offline is the status line under the name);
    // anything that stops trading on the PC side (daily cap, MT5 not answering, EA live lock) is an extra alert chip
    const stateChip = !ctl ? ['chip quiet-chip', 'power', 'ยังไม่มีคำสั่ง']
      : d.control.mode === 'pause' ? ['chip pending', 'pause', 'หยุดชั่วคราว']
        : !d.live ? ['chip pending', 'power', 'ปิดเทรดจริง'] : ['chip live', 'zap', 'เทรดจริง'];
    const blocked = info.agentOnline && !['live', 'paused', 'off'].includes(hs.tone) ? hs.title : '';
    // alerts: an active / next blackout, what the PC refused, a command not yet received
    const now = Date.now();
    const bo = activeBlackout(st, off);
    const nextBo = d.blackouts.map((x) => ({ from: Date.parse(x.from_utc), to: Date.parse(x.to_utc), label: x.label })).filter((x) => x.to > now).sort((x, y) => x.from - y.from)[0];
    const as = b.agent_state || {};
    const rejected = Array.isArray(as.rejected) ? as.rejected : as.rejected ? [as.rejected] : [];
    const alerts = [
      blocked ? h('span', { class: 'chip bad' }, icon('warn'), blocked) : null,
      bo ? h('span', { class: 'chip warn' }, icon('clock'), `งดเข้าไม้ถึง ${fmtThai(bo.to, 'time')}`)
        : nextBo ? h('span', { class: 'chip quiet-chip' }, icon('clock'), `งดเข้าไม้ ${fmtThai(nextBo.from, 'short')}`) : null,
      ...rejected.slice(0, 2).map((r) => { const ri = rejectionInfo(r); return h('span', { class: 'chip bad', title: `${ri.title}: ${ri.text}` }, icon('warn'), shortReject(ri.code)); }),
      ctl && isPending(b, ctl) ? h('span', { class: 'chip pending' }, h('span', { class: 'pulse', 'aria-hidden': 'true' }), 'รอเครื่องรับคำสั่ง') : null,
    ].filter(Boolean);
    const since = (vv.balance ?? 0) - (vv.start ?? 0);
    const open = st ? (st.positions || []).filter((p) => p.open) : [];
    // the last closed trade in the newest journal rows, else the last event
    const lastClose = (tail || []).find((r) => r.event === 'CLOSE');
    const lastRow = (tail || [])[0];
    const when = (ts) => { const t = serverToUtc(ts, off); return thaiDayKey(t) === thaiDayKey(now) ? `วันนี้ ${fmtThai(t, 'time')}` : fmtThai(t, 'short'); };
    const fact = (label, value) => h('div', { class: 'fbot-fact' }, h('dt', null, label), h('dd', null, value));
    const stratChips = v ? [...STRATS, ASIA].filter((s) => v[s.use]).map((s) => h('span', { class: 'chip' }, `${s.id === 'ASIA16' ? 'ASIA16' : s.id} ${fmtNum(v[s.lots])}`)) : [];
    return h('article', { class: `fbot tone-${hs.tone}` },
      h('div', { class: 'fbot-head' },
        h('div', { class: 'grow' },
          h('h3', { class: 'fbot-name' }, b.name),
          h('p', { class: `machine-status ${info.online ? 'is-on' : 'is-off'}` }, h('span', { class: 'dot', 'aria-hidden': 'true' }),
            h('span', { class: 'st' }, info.online ? 'ออนไลน์' : info.agentOnline ? 'MT5 ไม่ตอบ' : Number.isFinite(info.seenAge) ? 'ออฟไลน์' : 'ยังไม่เคยเชื่อมต่อ'),
            h('span', null, b.last_seen ? `เห็นล่าสุด ${ago(Date.parse(b.last_seen))}` : ''))),
        h('span', { class: stateChip[0] }, icon(stateChip[1]), stateChip[2])),
      alerts.length ? h('div', { class: 'chips' }, alerts) : null,
      st ? h('dl', { class: 'fbot-figs' },
        h('div', null, h('dt', null, `ยอดเงิน ${cur}`), h('dd', null, money(a.balance))),
        h('div', null, h('dt', null, 'วันนี้'), h('dd', null, money(vv.day_pnl, { signed: true }))),
        h('div', null, h('dt', null, 'ตั้งแต่เริ่ม'), h('dd', null, money(since, { signed: true }))))
        : h('p', { class: 'muted' }, 'ยังไม่มีสถานะจากเครื่องนี้'),
      h('dl', { class: 'fbot-facts' },
        fact('สูตรและล็อต', stratChips.length ? h('span', { class: 'chips' }, stratChips) : (v ? 'ปิดทุกสูตร' : '—')),
        fact('ล็อกกำไร', v ? lockText(v).replace(/^ล็อก /, '') : '—'),
        fact('ขาดทุนต่อวัน', v ? `${pctText(v.InpDailyCapPct)}%` : '—'),
        fact('รุ่น', [ver ? `EA ${ver}` : 'EA ?', b.agent_version ? `, แอป ${b.agent_version}` : '']),
        fact('ไม้ที่เปิด', open.length ? h('span', { class: 'fbot-open' }, open.map((p) => h('span', { class: 'fbot-pos' },
          sideEl(p.side), ' ', modChip(p.module), ' ', h('span', { class: 'muted' }, h('span', { class: 'num' }, fmtNum(p.lots)), ' ล็อต'), ' ',
          h('span', { class: `num pnl ${toneOf((p.profit || 0) + (p.swap || 0))}` }, fmtSigned((p.profit || 0) + (p.swap || 0)))))) : 'ไม่มี'),
        fact('ล่าสุด', lastClose ? [modChip(lastClose.tag), ' ', REASON_LABELS[(/reason=(\w+)/.exec(lastClose.detail || '') || [])[1]] || 'ปิดไม้', ' ',
          h('span', { class: `num pnl ${toneOf(lastClose.pnl)}` }, fmtSigned(lastClose.pnl)), h('span', { class: 'muted' }, ` ${when(lastClose.ts_server)}`)]
          : lastRow ? [EVENT_LABELS[lastRow.event] || lastRow.event, h('span', { class: 'muted' }, ` ${when(lastRow.ts_server)}`)] : '—')),
      v ? h('p', { class: 'fbot-summary' }, h('strong', null, 'ค่าที่ใช้อยู่ '), summaryText(v, cur, botPnlOf(st))) : null,
      h('div', { class: 'fbot-presets' }, h('span', { class: 'muted small' }, 'พรีเซ็ต'),
        mine.length ? mine.map((p) => h('a', { class: 'chip quiet-chip', href: `#/presets/${encodeURIComponent(p.id)}` }, icon('doc'), p.name)) : h('span', { class: 'muted small' }, 'ยังไม่มี')),
      h('div', { class: 'fbot-foot' },
        h('button', { class: 'btn', type: 'button', onclick: () => openBot(b, '#/dashboard') }, icon('eye'), 'ดูบอทนี้'),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => openBot(b, '#/history') }, icon('history'), 'ประวัติ'),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => openBot(b, '#/bot') }, icon('sliders'), 'ค่าทั้งหมด')));
  }

  function openBot(b, hash) {
    if (!app.friendBots.some((x) => x.id === b.id)) app.friendBots.push({ ...b, owner_name: (app.people[b.owner] || {}).name || 'สมาชิก' });
    if (location.hash !== hash) history.pushState(null, '', hash);
    if (b.id !== app.botId) selectBot(b.id); else ctx.route();
  }

  draw();
  const reload = async () => { try { await load(); if (box.isConnected) draw(); } catch { /* keep the last data */ } };
  const tick = setInterval(reload, 30000);
  const offWake = onWake(reload); // a phone froze the page: every "online" on it is old
  return () => { clearInterval(tick); offWake(); };
}

// ------------------------------------------------------------------ ผู้ใช้และรหัสเชิญ
async function renderPeople(root, ctx) {
  const inviteBox = h('div'), usersBox = h('div'), invitesBox = h('div');
  root.append(h('div', { class: 'grid-2' }, inviteBox, invitesBox), usersBox);
  usersBox.append(loadingState());
  let users = [], invites = [];
  const load = async () => { [users, invites] = await Promise.all([ctx.api.adminOverview(), ctx.api.listInvites()]); };
  try { await load(); } catch (e) { usersBox.replaceChildren(errorState(e, () => ctx.route())); return; }

  // create invite
  const roleIn = h('select', { class: 'input select' }, h('option', { value: 'member' }, 'สมาชิก (member)'), h('option', { value: 'admin' }, 'ผู้ดูแล (admin)'));
  const daysIn = h('input', { class: 'input', type: 'number', min: '1', max: '365', value: '7', inputmode: 'numeric' });
  const noteIn = h('input', { class: 'input', type: 'text', maxlength: 120, placeholder: 'เช่น ชื่อเพื่อน' });
  const result = h('div', { 'aria-live': 'polite' });
  const err = h('p', { class: 'field-error', role: 'alert' });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, icon('plus'), 'สร้างรหัสเชิญ');
  inviteBox.append(panel('สร้างรหัสเชิญ', { sub: 'ส่งรหัสให้เพื่อน เพื่อนสมัครที่หน้าเข้าสู่ระบบแล้วใส่รหัสนี้' },
    h('form', {
      class: 'stack',
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        const days = Number(daysIn.value);
        if (!(days >= 1 && days <= 365)) { err.textContent = 'อายุรหัส 1 ถึง 365 วัน'; return; }
        if (roleIn.value === 'admin') {
          const ok = await confirmDialog('สร้างรหัสสำหรับผู้ดูแล?', 'คนที่ใช้รหัสนี้จะจัดการผู้ใช้และรหัสเชิญได้ทั้งหมด และเห็นบอทของทุกคน', { ok: 'สร้าง' });
          if (!ok) return;
        }
        busy(btn, true, 'กำลังสร้าง…');
        try {
          const code = await ctx.api.createInvite(roleIn.value, days, noteIn.value.trim());
          const msg = `รหัสเชิญ Dobby: ${code}\nสมัครที่ ${location.origin}${location.pathname}#/login?tab=signup\nรหัสหมดอายุใน ${days} วัน`;
          result.replaceChildren(callout('good', 'สร้างรหัสแล้ว',
            h('p', { class: 'invite-code' }, code),
            h('div', { class: 'row gap wrap' },
              h('button', { class: 'btn small', type: 'button', onclick: () => copyText(code, 'คัดลอกรหัสแล้ว') }, icon('copy'), 'คัดลอกรหัส'),
              h('button', { class: 'btn small', type: 'button', onclick: () => copyText(msg, 'คัดลอกข้อความเชิญแล้ว') }, icon('copy'), 'คัดลอกข้อความเชิญ'))));
          noteIn.value = '';
          await load(); drawInvites(); drawUsers();
        } catch (ex) { err.textContent = errText(ex); }
        busy(btn, false);
      },
    },
    h('div', { class: 'grid-2 tight' }, field('สิทธิ์', roleIn), field('อายุ (วัน)', daysIn)),
    field('บันทึกช่วยจำ', noteIn), err, btn, result)));

  const userName = (id) => { const u = users.find((x) => x.user_id === id); return u ? (u.display_name || u.email || id.slice(0, 8)) : id ? id.slice(0, 8) : '—'; };

  function inviteState(i) {
    if (i.revoked) return ['ยกเลิกแล้ว', 'off'];
    if (i.used_by || i.used_at) return [`ใช้แล้วโดย ${userName(i.used_by)}`, 'good'];
    if (Date.parse(i.expires_at) <= Date.now()) return ['หมดอายุ', 'off'];
    return ['ใช้ได้', 'live'];
  }

  function drawInvites() {
    const active = invites.filter((i) => inviteState(i)[0] === 'ใช้ได้');
    invitesBox.replaceChildren(panel(`รหัสเชิญ (ใช้ได้ ${active.length})`, {},
      invites.length ? h('ul', { class: 'invite-list' }, invites.map((i) => {
        const [label, tone] = inviteState(i);
        const usable = label === 'ใช้ได้';
        return h('li', { class: `invite ${usable ? '' : 'dim'}` },
          h('div', { class: 'grow' },
            h('p', null, h('code', { class: 'invite-code small' }, i.code), ' ', h('span', { class: `chip ${tone}` }, label), i.role === 'admin' ? h('span', { class: 'chip warn' }, 'admin') : null),
            h('p', { class: 'muted small' }, i.note ? `${i.note} ` : '', usable ? `หมดอายุ ${fmtThai(Date.parse(i.expires_at), 'short')}` : `สร้าง ${fmtThai(Date.parse(i.created_at), 'date')}`)),
          usable ? h('div', { class: 'row gap' },
            h('button', { class: 'icon-btn', type: 'button', 'aria-label': `คัดลอก ${i.code}`, onclick: () => copyText(i.code, 'คัดลอกรหัสแล้ว') }, icon('copy')),
            h('button', {
              class: 'btn small ghost danger-text', type: 'button',
              onclick: async () => {
                const ok = await confirmDialog(`ยกเลิกรหัส ${i.code}?`, 'รหัสนี้จะใช้สมัครไม่ได้อีก', { ok: 'ยกเลิกรหัส', danger: true });
                if (!ok) return;
                try { await ctx.api.revokeInvite(i.code); await load(); drawInvites(); toast('ยกเลิกรหัสแล้ว', 'good'); } catch (e) { toast(errText(e), 'error'); }
              },
            }, 'ยกเลิก')) : null);
      })) : h('p', { class: 'muted' }, 'ยังไม่มีรหัสเชิญ')));
  }

  function drawUsers() {
    const me = app.user && app.user.id;
    if (!users.length) { usersBox.replaceChildren(emptyState('ยังไม่มีผู้ใช้')); return; }
    usersBox.replaceChildren(panel(`ผู้ใช้ทั้งหมด (${users.length})`, { sub: 'สิทธิ์ การอนุมัติ และการระงับ ดูบอทของแต่ละคนได้ที่แท็บ "บอทของสมาชิก"' },
      h('div', { class: 'table-wrap' }, h('table', { class: 'rtable users' },
        h('thead', null, h('tr', null, ['ผู้ใช้', 'สิทธิ์', 'อนุมัติ', 'ระงับ', 'บอท', 'บอทออนไลน์ล่าสุด', 'สมัครเมื่อ'].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', null, users.map((u) => {
          const self = u.user_id === me;
          const set = async (patch, el) => {
            el.disabled = true;
            try {
              await ctx.api.adminSetUser(u.user_id, patch.role ?? null, patch.approved ?? null, patch.disabled ?? null);
              Object.assign(u, patch);
              toast(`อัปเดต ${u.display_name || u.email} แล้ว`, 'good');
            } catch (e) { toast(errText(e), 'error', 6000); await load(); }
            drawUsers();
          };
          const role = h('select', { class: 'input select small', 'aria-label': `สิทธิ์ของ ${u.display_name}`, disabled: self, onchange: (e) => set({ role: e.target.value }, e.target) },
            h('option', { value: 'member', selected: u.role === 'member' }, 'member'), h('option', { value: 'admin', selected: u.role === 'admin' }, 'admin'));
          const appr = h('input', { type: 'checkbox', class: 'toggle', role: 'switch', checked: u.approved, disabled: self, 'aria-label': `อนุมัติ ${u.display_name}`, onchange: (e) => set({ approved: e.target.checked }, e.target) });
          const dis = h('input', {
            type: 'checkbox', class: 'toggle danger', role: 'switch', checked: u.disabled, disabled: self, 'aria-label': `ระงับ ${u.display_name}`,
            onchange: async (e) => {
              if (e.target.checked) {
                const ok = await confirmDialog(`ระงับบัญชี ${u.display_name || u.email}?`, 'ผู้ใช้นี้จะเข้าเว็บไม่ได้และเห็นข้อมูลไม่ได้ บอทบนเครื่องของเขายังทำงาน แต่เอเจนต์จะส่งข้อมูลไม่ได้', { ok: 'ระงับ', danger: true });
                if (!ok) { e.target.checked = false; return; }
              }
              set({ disabled: e.target.checked }, e.target);
            },
          });
          return h('tr', { class: u.disabled ? 'dim' : '' },
            h('td', { 'data-label': 'ผู้ใช้' }, h('strong', null, u.display_name || '—'), self ? h('span', { class: 'chip' }, 'คุณ') : null, h('div', { class: 'muted small' }, u.email || '')),
            h('td', { 'data-label': 'สิทธิ์' }, role),
            h('td', { 'data-label': 'อนุมัติ' }, appr),
            h('td', { 'data-label': 'ระงับ' }, dis),
            h('td', { 'data-label': 'บอท', class: 'num' }, String(u.bots ?? 0)),
            h('td', { 'data-label': 'บอทออนไลน์ล่าสุด' }, u.last_seen ? ago(Date.parse(u.last_seen)) : '—'),
            h('td', { 'data-label': 'สมัครเมื่อ' }, fmtThai(Date.parse(u.created_at), 'date')));
        }))))));
  }

  drawInvites();
  drawUsers();
}
