// ผู้ช่วย AI (SPEC 10.4): the floating "ถาม AI" button and the chat panel. Answers stream from the Edge Function
// `chat` (api.chat, SPEC 10.3); in demo mode from a local simulation (chat-demo.js). The answer text is rendered with
// a small Markdown subset built from DOM nodes (never innerHTML) and links only to pages of this site (#/...).
import { h, icon, mount, fmtThai, toast, errText, confirmDialog } from './util.js';
import { app, selectBot } from './state.js';
import { PARAM_BY_KEY, formatValue } from './params.js';

export const PROPOSAL_KEY = 'dobby-ai-proposal';
const MAX_LEN = 4000;
const SUGGESTIONS = [
  'ทำไมไม้ล่าสุดถึงเปิด',
  'สรุปผลสัปดาห์นี้ให้หน่อย',
  'ตอนนี้บอทกำลังทำอะไรอยู่',
  'ถ้าเลื่อนล็อกชั้นแรกให้เร็วขึ้น จะดีไหม',
];
const NOT_READY = new Set(['ai_not_configured', 'not_deployed']);
const STOPPED = new Set(['ai_disabled', 'ai_daily_limit', 'ai_monthly_budget']);

let ui = null; // the panel of the current shell (rebuilt when the shell is rebuilt)

const convKey = () => `dobby-ai-conv:${app.user ? app.user.id : ''}`;
function storedConv() { try { return localStorage.getItem(convKey()) || null; } catch { return null; } }
function storeConv(id) { try { if (id) localStorage.setItem(convKey(), id); else localStorage.removeItem(convKey()); } catch { /* private mode */ } }
const narrow = () => window.matchMedia('(max-width: 1023px)').matches;

// What the user is looking at: the page, the selected bot and (on the trade page) the trade.
function pageContext(extra = {}) {
  const raw = location.hash.replace(/^#\/?/, '');
  const parts = raw.split('?')[0].split('/').map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
  const ctx = { page: parts[0] || 'dashboard' };
  if (app.botId) ctx.bot_id = app.botId;
  if (ctx.page === 'trade' && parts[1]) ctx.trade_key = parts[1];
  return { ...ctx, ...extra };
}

// ------------------------------------------------------------------ Markdown subset
const INLINE_RE = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\))/g;
function inline(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('**')) out.push(h('strong', null, t.slice(2, -2)));
    else if (t.startsWith('`')) out.push(h('code', null, t.slice(1, -1)));
    else {
      const lm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(t);
      const href = lm[2];
      out.push(/^#\/[\w\-/%|.:?=&]*$/.test(href) ? h('a', { href, class: 'chat-link' }, lm[1]) : lm[1]);
    }
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
const LIST_RE = /^\s*(?:[-*•]|(\d+)[.)])\s+(.*)$/;
const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
export function renderMd(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (/^```/.test(line.trim())) {
      const body = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) body.push(lines[i++]);
      i++;
      blocks.push(h('pre', { class: 'chat-pre' }, h('code', null, body.join('\n'))));
      continue;
    }
    if (/^\s*\|/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        if (!/^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i]) || !/-/.test(lines[i])) rows.push(cells(lines[i]));
        i++;
      }
      const [head, ...body] = rows;
      blocks.push(h('div', { class: 'chat-table-wrap' }, h('table', { class: 'chat-table' },
        head ? h('thead', null, h('tr', null, head.map((c) => h('th', null, inline(c))))) : null,
        h('tbody', null, body.map((r) => h('tr', null, r.map((c) => h('td', null, inline(c)))))))));
      continue;
    }
    if (LIST_RE.test(line)) {
      const ordered = !!LIST_RE.exec(line)[1];
      const items = [];
      while (i < lines.length && LIST_RE.test(lines[i])) items.push(h('li', null, inline(LIST_RE.exec(lines[i++])[2])));
      blocks.push(h(ordered ? 'ol' : 'ul', { class: 'chat-list' }, items));
      continue;
    }
    if (/^#{1,4}\s+/.test(line)) { blocks.push(h('p', { class: 'chat-h' }, inline(line.replace(/^#{1,4}\s+/, '')))); i++; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() && !LIST_RE.test(lines[i]) && !/^\s*\|/.test(lines[i]) && !/^```/.test(lines[i].trim()) && !/^#{1,4}\s+/.test(lines[i])) para.push(lines[i++]);
    const kids = [];
    para.forEach((p, k) => { if (k) kids.push(h('br')); kids.push(...inline(p)); });
    blocks.push(h('p', null, kids));
  }
  return blocks;
}

// ------------------------------------------------------------------ proposals (SPEC 10.5)
// from / to arrive as raw values (number or boolean) from the function, as strings from the demo
function fmtVal(key, v) {
  if (v === null || v === undefined || v === '') return '—';
  const p = PARAM_BY_KEY[key];
  if (typeof v === 'boolean' || (p && p.type === 'bool')) return v === true || v === 'true' ? 'เปิด' : 'ปิด';
  return p ? formatValue(p, v) : String(v);
}
function applyProposal(p) {
  try {
    sessionStorage.setItem(PROPOSAL_KEY, JSON.stringify({ bot_id: p.bot_id, changes: p.changes, summary: p.summary || '', ts: Date.now() }));
  } catch { toast('เบราว์เซอร์นี้เก็บข้อเสนอไว้ไม่ได้ ลองปิดโหมดส่วนตัว', 'error'); return; }
  if (app.botId !== p.bot_id) selectBot(p.bot_id);
  if (ui) ui.close(); // the panel would cover the settings page's save bar
  const target = '#/bot?ai=1';
  if (location.hash === target) window.dispatchEvent(new HashChangeEvent('hashchange')); else location.hash = target;
}

function proposalCard(p) {
  const changes = Array.isArray(p.changes) ? p.changes : [];
  return h('div', { class: 'chat-proposal' },
    h('p', { class: 'cp-title' }, icon('sliders'), h('span', null, `ข้อเสนอเปลี่ยนค่าของ ${p.bot_name || 'บอท'}`)),
    p.summary ? h('p', { class: 'cp-summary' }, p.summary) : null,
    h('ul', { class: 'change-list' }, changes.map((c) => h('li', null,
      h('span', { class: 'cl-label' }, c.label || c.key), h('span', { class: 'cl-from' }, fmtVal(c.key, c.from)),
      h('span', { class: 'cl-arrow', 'aria-hidden': 'true' }, '→'), h('span', { class: 'cl-to' }, fmtVal(c.key, c.to))))),
    p.caution ? h('p', { class: 'cp-caution' }, icon('warn'), h('span', null, p.caution)) : null,
    h('div', { class: 'cp-actions' },
      h('button', { class: 'btn primary small', type: 'button', onclick: () => applyProposal(p) }, 'ดูและใช้ค่านี้'),
      h('span', { class: 'muted small' }, 'ยังไม่มีอะไรเปลี่ยน จนกว่าคุณจะกดส่งในหน้าตั้งค่าบอท')));
}

// ------------------------------------------------------------------ the panel
function buildPanel() {
  const st = { convId: null, msgs: [], busy: false, ctrl: null, quota: null, notReady: false, stopped: null, view: 'chat', loadedFor: null };
  const titleId = 'chat-title';
  const sub = h('p', { class: 'chat-sub' });
  const body = h('div', { class: 'chat-body', 'aria-live': 'polite' });
  const input = h('textarea', {
    class: 'input chat-input', rows: 1, maxlength: MAX_LEN, placeholder: 'ถามเรื่องบอทของคุณได้ทุกเรื่อง', 'aria-label': 'คำถามถึงผู้ช่วย AI',
  });
  const sendBtn = h('button', { class: 'btn primary chat-send', type: 'submit', 'aria-label': 'ส่งคำถาม', title: 'ส่ง (Enter)' }, icon('send'));
  const meta = h('p', { class: 'chat-meta' });
  const form = h('form', { class: 'chat-form', onsubmit: (e) => { e.preventDefault(); if (st.busy) stop(); else send(input.value); } }, input, sendBtn);
  const histBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'บทสนทนาก่อนหน้า', title: 'บทสนทนาก่อนหน้า', onclick: () => (st.view === 'history' ? showChat() : showHistory()) }, icon('history'));
  const newBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'เริ่มบทสนทนาใหม่', title: 'เริ่มบทสนทนาใหม่', onclick: () => newChat() }, icon('plus'));
  const closeBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'ปิดผู้ช่วย AI', title: 'ปิด', onclick: () => close() }, icon('x'));
  const panel = h('section', { class: 'chat-panel', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': titleId, hidden: true },
    h('header', { class: 'chat-head' },
      h('div', { class: 'grow chat-title-box' }, h('h2', { id: titleId }, 'ผู้ช่วย AI'), sub),
      histBtn, newBtn, closeBtn),
    body,
    h('footer', { class: 'chat-foot' }, form, meta));
  const fab = h('button', { class: 'btn chat-fab', type: 'button', 'aria-haspopup': 'dialog', onclick: () => open() }, icon('chat'), h('span', { class: 'chat-fab-label' }, 'ถาม AI'));
  const root = h('div', { class: 'chat-root' }, fab, panel);

  // ---------------- helpers
  // While an answer streams the view follows it, until the user scrolls up to read; scrolling back down resumes.
  const nearBottom = () => body.scrollHeight - body.scrollTop - body.clientHeight < 80;
  let follow = true, progScroll = false;
  const toBottom = (force) => {
    if (force) follow = true;
    if (!follow || body.scrollHeight - body.scrollTop - body.clientHeight < 1) return;
    progScroll = true; // the scroll event this causes is not the user's
    body.scrollTop = body.scrollHeight;
  };
  body.addEventListener('scroll', () => { if (progScroll) { progScroll = false; return; } follow = nearBottom(); }, { passive: true });
  function grow() { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 160)}px`; }
  input.addEventListener('input', grow);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!st.busy) send(input.value); }
  });
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  body.addEventListener('click', (e) => { const a = e.target.closest('a.chat-link'); if (a && narrow()) close(); });

  function drawSub() {
    const b = app.bots.find((x) => x.id === app.botId) || app.friendBots.find((x) => x.id === app.botId);
    sub.textContent = b ? (app.friendBots.includes(b) ? `กำลังดูบอทของ ${b.owner_name || 'สมาชิก'}: ${b.name}` : `บอทที่เลือก: ${b.name}`) : 'ถามเรื่องบัญชีและบอทของคุณ';
  }
  function drawMeta() {
    const parts = [];
    if (app.mode === 'demo') parts.push('โหมดตัวอย่าง: คำตอบจำลอง ไม่ได้ใช้ AI จริง');
    const q = st.quota;
    if (q && q.enabled !== false && Number.isFinite(Number(q.limit_today))) {
      const left = Math.max(0, Number(q.limit_today) - Number(q.used_today || 0));
      parts.push(left > 0 ? `วันนี้ถามได้อีก ${left} ครั้ง` : 'วันนี้ถามครบจำนวนแล้ว');
    }
    meta.textContent = parts.join(' | ') || 'ผู้ช่วยอ่านข้อมูลบัญชีของคุณได้ แต่สั่งงานบอทเองไม่ได้';
    const blocked = st.notReady || !!st.stopped;
    input.disabled = blocked && !st.busy;
    sendBtn.disabled = blocked && !st.busy;
    mount(sendBtn, icon(st.busy ? 'stop' : 'send'));
    sendBtn.setAttribute('aria-label', st.busy ? 'หยุดตอบ' : 'ส่งคำถาม');
    sendBtn.title = st.busy ? 'หยุด' : 'ส่ง (Enter)';
  }
  function stateBlock() {
    if (st.notReady) {
      return h('div', { class: 'chat-state' }, icon('info'), h('div', null,
        h('p', { class: 'chat-state-title' }, 'ผู้ช่วย AI ยังไม่พร้อมใช้งาน'),
        h('p', null, app.profile && app.profile.role === 'admin'
          ? 'ต้องอัปเดตฐานข้อมูล (รัน schema.sql) สร้างฟังก์ชัน chat และใส่ ANTHROPIC_API_KEY ใน Supabase ก่อน ขั้นตอนอยู่ใน supabase/README.md หัวข้อ "ผู้ช่วย AI"'
          : 'ผู้ดูแลยังไม่ได้เปิดผู้ช่วย AI ลองใหม่ภายหลัง')));
    }
    if (st.stopped) return h('div', { class: 'chat-state' }, icon('clock'), h('div', null, h('p', null, st.stopped)));
    return null;
  }

  // ---------------- views
  function emptyView() {
    return h('div', { class: 'chat-empty' },
      h('p', { class: 'chat-empty-title' }, 'ถามอะไรเกี่ยวกับบอทก็ได้'),
      h('p', { class: 'muted' }, 'เช่น ทำไมไม้นี้ถึงเปิด สัปดาห์นี้ได้เท่าไร หรือลองเปลี่ยนค่านี้ดีไหม ผู้ช่วยอ่านข้อมูลจริงของบัญชีคุณ ส่วนการเปลี่ยนค่า ผู้ช่วยจะเสนอให้ แล้วคุณเป็นคนกดใช้เอง'),
      h('div', { class: 'chat-suggest' }, SUGGESTIONS.map((s) => h('button', { class: 'btn small chat-sug', type: 'button', disabled: st.notReady || !!st.stopped, onclick: () => send(s) }, s))));
  }
  function msgEl(m) {
    if (m.role === 'user') return h('div', { class: 'chat-msg user' }, h('div', { class: 'chat-bubble' }, m.content));
    const md = h('div', { class: 'chat-md' }, renderMd(m.content));
    const props = ((m.context && m.context.proposals) || []).map(proposalCard);
    return h('div', { class: 'chat-msg ai' }, md, ...props);
  }
  function showChat() {
    st.view = 'chat';
    histBtn.setAttribute('aria-pressed', 'false');
    const blk = stateBlock();
    mount(body, blk, ...(st.msgs.length ? st.msgs.map(msgEl) : [blk ? null : emptyView()]));
    toBottom(true);
    drawMeta();
  }
  async function showHistory() {
    st.view = 'history';
    histBtn.setAttribute('aria-pressed', 'true');
    mount(body, h('p', { class: 'chat-status' }, h('span', { class: 'chat-dot' }), 'กำลังโหลดบทสนทนา…'));
    let list = [];
    try { list = await app.api.listConversations(); } catch (e) {
      if (st.view !== 'history') return;
      mount(body, h('div', { class: 'chat-state' }, icon('warn'), h('p', null, errText(e))));
      return;
    }
    if (st.view !== 'history') return;
    const back = h('button', { class: 'linklike back chat-back', type: 'button', onclick: () => showChat() }, icon('chevron'), 'กลับไปที่แชท');
    if (!list.length) { mount(body, back, h('p', { class: 'muted chat-hist-empty' }, 'ยังไม่มีบทสนทนาก่อนหน้า')); return; }
    mount(body, back, h('ul', { class: 'chat-hist' }, list.map((c) => h('li', { class: c.id === st.convId ? 'on' : '' },
      h('button', { class: 'linklike chat-hist-open', type: 'button', onclick: () => loadConv(c.id) },
        h('span', { class: 'chat-hist-title' }, c.title), h('span', { class: 'muted small' }, fmtThai(Date.parse(c.updated_at), 'datetime'))),
      h('button', {
        class: 'icon-btn', type: 'button', 'aria-label': `ลบบทสนทนา ${c.title}`, title: 'ลบ',
        onclick: async () => {
          if (!(await confirmDialog('ลบบทสนทนานี้?', `"${c.title}" จะหายไปถาวร`, { ok: 'ลบ', danger: true }))) return;
          try {
            await app.api.deleteConversation(c.id);
            if (c.id === st.convId) { st.convId = null; st.msgs = []; storeConv(null); }
            showHistory();
          } catch (e) { toast(errText(e), 'error'); }
        },
      }, icon('trash'))))));
  }
  async function loadConv(id) {
    st.view = 'chat';
    mount(body, h('p', { class: 'chat-status' }, h('span', { class: 'chat-dot' }), 'กำลังโหลด…'));
    try {
      const rows = await app.api.conversationMessages(id);
      st.convId = id; st.msgs = rows; storeConv(id);
    } catch (e) {
      st.convId = null; st.msgs = []; storeConv(null);
      if (!NOT_READY.has(e && e.code)) toast(errText(e), 'error');
    }
    showChat();
  }
  function newChat() {
    if (st.busy) stop();
    st.convId = null; st.msgs = []; storeConv(null);
    showChat();
    input.focus();
  }

  // ---------------- quota
  async function refreshQuota() {
    try {
      st.quota = await app.api.aiQuota();
      st.notReady = false;
      st.stopped = st.quota && st.quota.enabled === false ? 'ผู้ดูแลปิดผู้ช่วย AI ไว้ชั่วคราว'
        : st.quota && st.quota.budget_reached ? 'ใช้งบผู้ช่วย AI ของเดือนนี้ครบแล้ว ติดต่อผู้ดูแล'
        : st.quota && Number(st.quota.used_today) >= Number(st.quota.limit_today) ? 'วันนี้ถามครบจำนวนแล้ว ถามใหม่ได้พรุ่งนี้ (นับตามเวลาไทย)' : null;
    } catch (e) {
      st.quota = null;
      st.notReady = NOT_READY.has(e && e.code);
    }
    if (st.view === 'chat' && !st.busy) showChat(); else drawMeta();
  }

  // ---------------- sending
  async function send(textRaw, extraCtx = {}) {
    const text = String(textRaw || '').trim();
    if (!text || st.busy) return;
    if (text.length > MAX_LEN) { toast(`คำถามยาวเกินไป (ไม่เกิน ${MAX_LEN.toLocaleString('th-TH')} ตัวอักษร)`, 'error'); return; }
    if (st.view !== 'chat') showChat();
    input.value = ''; grow();
    const context = pageContext(extraCtx);
    st.msgs.push({ role: 'user', content: text, context });
    const userEl = msgEl(st.msgs[st.msgs.length - 1]);
    const md = h('div', { class: 'chat-md' });
    const status = h('p', { class: 'chat-status' }, h('span', { class: 'chat-dot' }), 'กำลังคิด…');
    const aiEl = h('div', { class: 'chat-msg ai pending' }, status, md);
    body.querySelector('.chat-empty')?.remove();
    body.append(userEl, aiEl);
    toBottom(true);
    st.busy = true; drawMeta();
    const ctrl = new AbortController();
    st.ctrl = ctrl;
    let answer = '';
    const proposals = [];
    let raf = 0;
    const paint = () => { raf = 0; mount(md, renderMd(answer)); toBottom(); };
    try {
      await app.api.chat({ conversationId: st.convId, message: text, context }, (ev) => {
        if (!ev || ctrl.signal.aborted) return;
        if (ev.type === 'start') { if (ev.conversation_id) { st.convId = ev.conversation_id; storeConv(ev.conversation_id); } }
        else if (ev.type === 'status') { status.hidden = false; mount(status, h('span', { class: 'chat-dot' }), ev.text || 'กำลังทำงาน…'); toBottom(); }
        else if (ev.type === 'text') { status.hidden = true; answer += ev.delta || ''; if (!raf) raf = requestAnimationFrame(paint); }
        else if (ev.type === 'proposal' && ev.proposal) { proposals.push(ev.proposal); aiEl.append(proposalCard(ev.proposal)); toBottom(); }
        else if (ev.type === 'done') {
          if (st.quota) { st.quota.used_today = ev.used_today ?? st.quota.used_today; st.quota.limit_today = ev.limit_today ?? st.quota.limit_today; }
          if (Number(ev.used_today) >= Number(ev.limit_today)) st.stopped = 'วันนี้ถามครบจำนวนแล้ว ถามใหม่ได้พรุ่งนี้ (นับตามเวลาไทย)';
        } else if (ev.type === 'error') {
          const err = new Error(ev.message || ev.code); err.code = ev.code; err.thai = ev.message; throw err;
        }
      }, ctrl.signal);
      if (raf) { cancelAnimationFrame(raf); paint(); }
      status.remove();
      aiEl.classList.remove('pending');
      if (!answer.trim() && !proposals.length) mount(md, h('p', { class: 'muted' }, 'ผู้ช่วยไม่ได้ตอบข้อความ ลองถามใหม่อีกครั้ง'));
      st.msgs.push({ role: 'assistant', content: answer || '', context: { proposals } });
    } catch (e) {
      if (raf) { cancelAnimationFrame(raf); paint(); }
      status.remove();
      aiEl.classList.remove('pending');
      if (ctrl.signal.aborted || (e && e.name === 'AbortError')) {
        aiEl.append(h('p', { class: 'muted small' }, 'หยุดตอบแล้ว'));
        st.msgs.push({ role: 'assistant', content: answer || '(หยุดตอบ)', context: { proposals } });
      } else {
        // text that streamed before a refusal / overload is not saved by the function: drop it here too
        answer = '';
        mount(md);
        aiEl.querySelectorAll('.chat-proposal').forEach((el) => el.remove());
        const code = e && e.code;
        if (NOT_READY.has(code)) st.notReady = true;
        if (STOPPED.has(code)) st.stopped = errText(e);
        if (code === 'conversation_not_found') { st.convId = null; storeConv(null); } // deleted elsewhere: retry starts a new one
        aiEl.append(h('div', { class: 'chat-error' }, icon('warn'), h('span', { class: 'grow' }, errText(e)),
          NOT_READY.has(code) || STOPPED.has(code) ? null
            : h('button', { class: 'btn small', type: 'button', onclick: () => { aiEl.remove(); userEl.remove(); send(text, extraCtx); } }, icon('refresh'), 'ลองอีกครั้ง')));
        st.msgs.pop(); // the question stays on screen; the next send starts clean
      }
    } finally {
      st.busy = false; st.ctrl = null;
      drawMeta();
      toBottom();
      if (!narrow() || !panel.hidden) input.focus();
    }
  }
  function stop() { if (st.ctrl) st.ctrl.abort(); }

  // ---------------- open / close
  async function open(prefill, extraCtx) {
    if (panel.hidden) {
      panel.hidden = false;
      fab.hidden = true;
      document.body.classList.add('chat-open');
      drawSub();
      if (st.loadedFor !== (app.user && app.user.id)) {
        st.loadedFor = app.user && app.user.id;
        const saved = storedConv();
        if (saved) await loadConv(saved); else showChat();
        refreshQuota();
      } else { showChat(); refreshQuota(); }
    }
    if (prefill) send(prefill, extraCtx || {});
    else setTimeout(() => input.focus(), 30);
  }
  function close() {
    if (panel.hidden) return;
    panel.hidden = true;
    fab.hidden = false;
    document.body.classList.remove('chat-open');
    fab.focus();
  }
  return { root, open, close, drawSub, isOpen: () => !panel.hidden };
}

// The launcher for one shell. app.js appends the returned element to the shell.
export function chatLauncher() {
  ui = buildPanel();
  return ui.root;
}
// Open the panel from anywhere (e.g. the trade page's "ถาม AI เรื่องไม้นี้"); prefill is sent right away.
export function openChat(prefill, extraContext) { if (ui) ui.open(prefill, extraContext); }
export function refreshChatBot() { if (ui && ui.isOpen()) ui.drawSub(); }
