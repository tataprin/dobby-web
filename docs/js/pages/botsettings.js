// ตั้งค่าบอท (SPEC 7 + SPEC 5 page 4): what the bot uses now, the simple settings editor, live switch, pause/resume,
// buy/sell sides and news blackouts. Settings are sent as desired.params = the full set of SPEC 4.2 remote keys
// (patchDesired: read-modify-write with the version check). EA v3.03 bots: read-only + .set download.
import { h, mount, icon, fmtNum, fmtThai, toast, errText, confirmDialog, openModal, errorState, loadingState, field, busy, isoUtc,
  utcToThaiInput, thaiInputToUtc, utcToServer, until, callout, newId, downloadBlob, onWake } from '../util.js';
import { app, currentBot, updateBotRow, on, ownsBot, canControl } from '../state.js';
import { normDesired, patchDesired, onlineInfo, onlineBadge, pendingChip, rejectionsBlock, appliedVersion, isPending, applyProgress } from '../botctl.js';
import { liveSwitch, appliedLive } from '../liveswitch.js';
import { panel, pageHead, noBotState, stepper, bigToggle, segmented, progressSteps, helpBtn } from '../views.js';
import { normalizeParams, presetFromLive, remoteSubset, defaults, PARAM_BY_KEY, coerce, runnerSupported, RUNNER_WARNING, RUNNER_KEYS, isCommandKey, unsupportedKeys, vwapTolSupported,
  runnerSafetyTooClose, RUNNER_SAFETY_WARNING } from '../params.js';
import { PROPOSAL_KEY } from '../chat.js';
import { buildSet, setFileName } from '../setfile.js';
import { autoBlackouts } from '../autoblackout.js';
import { botPnlOf } from '../rounds.js';
import { STRATS, ASIA, lockMode, lotsSame, mainLot, currentValues, setLotsAll, syncMaxLots, setLockMode, fixHiddenLocks,
  autoFromBalance, autoLot, toDesiredParams, summaryRows, summaryText, describeChanges, validateSimple, riskHint,
  matchesEffective, pctText } from '../simple.js';

const MIN = 60000;
export const NEWS_RE = /NFP|Non-Farm|CPI|FOMC/i;
const clone = (x) => JSON.parse(JSON.stringify(x));
const DRAFT = 'dobby-settings-draft';
function readDraft(botId) {
  try { const d = JSON.parse(sessionStorage.getItem(DRAFT) || 'null'); return d && d.botId === botId ? d : null; } catch { return null; }
}
function writeDraft(d) { try { if (d) sessionStorage.setItem(DRAFT, JSON.stringify(d)); else sessionStorage.removeItem(DRAFT); } catch { /* ignore */ } }

export async function render(root, ctx) {
  const bot0 = currentBot();
  if (!bot0) { root.append(pageHead('ตั้งค่าบอท', null, null, 'settings'), noBotState()); return; }
  let bot = bot0, st = null, ctl = null, news = [];
  // Someone else's bot. The admin may change its settings like the owner (2026-11-10: canControl; the admin's password
  // first, patchDesired / adminUnlock). viewOnly: every value shown, every control hidden or disabled, nothing is sent.
  const other = !ownsBot(bot0);
  const viewOnly = !canControl(bot0);
  const ownerName = bot0.owner_name || 'สมาชิก';
  root.append(loadingState('กำลังโหลดค่าของบอท…'));
  try {
    const [s, c, n, bots] = await Promise.all([ctx.api.botStatus(bot.id), ctx.api.botControl(bot.id),
      ctx.api.listNews({ fromIso: new Date(Date.now() - 3 * 3600e3).toISOString() }).catch(() => []), (other ? ctx.api.adminBots() : ctx.api.listBots()).catch(() => [])]);
    st = s ? s.status : null; ctl = c; news = n || [];
    const fresh = bots.find((b) => b.id === bot.id); // last_seen in app.bots may be minutes old
    if (fresh) { bot = { ...bot, ...fresh }; updateBotRow(bot); }
  } catch (e) { mount(root, errorState(e, () => ctx.route())); return; }
  mount(root);
  if (!ctl) {
    root.append(pageHead('ตั้งค่าบอท', bot.name, null, 'settings'), callout('warn', 'บอทนี้ยังเชื่อมกับเว็บไม่ครบ',
      h('p', null, 'เปิดแอป Dobby ที่เครื่องนั้น แล้วเชื่อมเครื่องกับเว็บอีกครั้ง (ตัวช่วยตั้งค่า → ตั้งชื่อเครื่อง) ถ้าใช้แบบคำสั่ง ให้รัน register --force')));
    return;
  }

  const cur = () => (st && st.account && st.account.currency) || 'USD';
  const pnlNow = () => botPnlOf(st); // the bot's own P&L since its start date: the capital it counts = InpVirtualStart + this
  const balNow = () => (st && st.account && st.account.balance > 0 ? Number(st.account.balance) : null);
  // a new status with another P&L or balance (a trade closed) redraws the capital row and its hints
  const moneyOf = () => `${pnlNow()}|${balNow()}`;
  let moneyKey = '';
  const off = () => bot.server_utc_offset_min ?? 0;
  const eaVer = () => (st && st.ea_version) || bot.ea_version || '';
  const canSend = () => (st ? !!st.remote : parseFloat(eaVer()) >= 3.04);
  // v3.05: the runner section is a switch only when the bot reports that version (older bots get an update callout and
  // never receive the runner keys, SPEC 11)
  const runnerOk = () => runnerSupported(eaVer());
  let runnerBuilt = null;
  const limits = () => (bot.agent_state && bot.agent_state.limits) || {};
  const minOf = (...xs) => { const n = xs.filter((x) => x !== null && x !== undefined && Number.isFinite(Number(x))).map(Number); return n.length ? Math.min(...n) : null; };
  const ceilings = () => {
    const r = st && st.remote, c = (r && r.ceilings) || {}, l = limits();
    return { lots: minOf(c.max_lots, l.max_lots), cap: minOf(c.max_cap_pct, l.max_daily_cap_pct), botName: bot.name };
  };

  // ---------------- values
  function computeBase() {
    const d = normDesired(ctl.desired);
    const cv = currentValues(st, canSend() ? d.params : null);
    if (!st && !d.params) cv.values = autoFromBalance(defaults(), 300);
    const eff = st && st.remote && st.remote.effective;
    const matches = !!(d.params && eff && matchesEffective(d.params, eff));
    const pending = !!(d.params && canSend() && !matches);
    const editBase = pending ? normalizeParams({ ...cv.values, ...d.params }) : cv.values;
    return { now: cv.values, editBase, matches, pending, readOnly: viewOnly || !canSend(), hasStatus: !!st };
  }
  let B = computeBase();
  let baseVals = clone(B.editBase);
  let v = clone(B.editBase);
  let lotMode = lotsSame(v) ? 'same' : 'per';
  let unlocked = false; // v3.03: edit only to download a .set
  let justSent = false;
  const draft = viewOnly ? null : readDraft(bot.id);
  if (draft && draft.v && JSON.stringify(draft.base) === JSON.stringify(baseVals) && describeChanges(baseVals, normalizeParams(draft.v), cur(), pnlNow()).length) {
    v = normalizeParams(draft.v);
    lotMode = lotsSame(v) ? 'same' : 'per';
    if (B.readOnly) unlocked = true;
    setTimeout(() => toast('กู้ค่าที่คุณแก้ค้างไว้ให้แล้ว (กด "ยกเลิก" ที่แถบด้านล่างถ้าไม่ต้องการ)', 'info', 5000), 300);
  }
  const editable = () => !viewOnly && (!B.readOnly || unlocked);
  const locked = () => !editable();
  const changes = () => describeChanges(baseVals, v, cur(), pnlNow());
  const errors = () => {
    const e = validateSimple(v, ceilings());
    const p = pnlNow();
    // the field takes the capital the bot counts, so a number at or under the bot's profit leaves no start
    if (e.InpVirtualStart && p > 0 && Number.isFinite(v.InpVirtualStart) && v.InpVirtualStart <= 0) e.InpVirtualStart = `ทุนของบอทต้องมากกว่ากำไรที่บอทนับไว้ (${fmtNum(p)} ${cur()})`;
    return e;
  };

  // ---------------- layout
  const headBox = h('div');
  const nowBox = h('section', { class: 'set-sec now-card', id: 'set-now', 'aria-label': 'ค่าที่บอทใช้อยู่ตอนนี้' });
  const liveBox = h('div'), pauseBox = h('div');
  const editorBox = h('section', { class: 'editor', 'aria-label': 'ปรับการตั้งค่าบอท', id: 'edit' });
  const aiNote = h('div', { class: 'ai-note', hidden: true }); // SPEC 10.5: the AI proposal's note above the editor
  const sidesBox = h('section', { class: 'set-sec', id: 'set-sides', 'aria-label': 'ฝั่งที่เข้าได้' });
  const boBox = h('section', { class: 'set-sec', id: 'set-bo', 'aria-label': 'งดเข้าไม้' });
  // งดเข้าไม้: the automatic part (SPEC 9.3, its own editor that keeps unsent edits) above the windows set by hand
  const auto = autoBlackouts({ get: () => ({ bot, ctl, friend: viewOnly }), onSent: (row) => { ctl = row; refreshAll(); } });
  const manualBox = h('div', { class: 'bo-manual' });
  boBox.append(
    h('div', { class: 'set-sec-head' }, h('h2', null, 'งดเข้าไม้'), viewOnly ? null : helpBtn('news', 'วิธีใช้'),
      h('p', null, viewOnly ? 'ช่วงที่บอทนี้ไม่เปิดไม้ใหม่' : 'ช่วงนี้บอทไม่เปิดไม้ใหม่ ไม้ที่เปิดอยู่ยังวิ่งต่อ')),
    h('div', { class: 'sub-head' }, h('h3', null, 'อัตโนมัติ'), h('p', null, 'ตามปฏิทินข่าวและตารางเวลา แอปที่เครื่องคำนวณช่วงงดให้เอง')),
    h('div', { class: 'group' }, auto),
    h('div', { class: 'sub-head' }, h('h3', null, 'ตั้งเอง'), h('p', null, 'งดทันที งดช่วงข่าวที่เลือก หรือกำหนดเวลาเอง')),
    manualBox);
  const bar = h('div', { class: 'action-bar', role: 'region', 'aria-label': 'บันทึกการเปลี่ยนแปลง', hidden: true });
  // section anchors (the app routes by hash, so they scroll instead of changing location.hash)
  const ANCHORS = [['set-now', 'ค่าที่ใช้อยู่'], ['set-switch', 'สวิตช์หลัก'], ['set-money', 'ทุนและล็อต'], ['set-strat', 'สูตร'],
    ['set-lock', 'ล็อกกำไร'], ['set-cap', 'ขาดทุนต่อวัน'], ['set-runner', 'runner'], ['set-vwap', 'C5G ก้ำกึ่ง VWAP'], ['set-adv', 'ขั้นสูง'], ['set-sides', 'ฝั่งที่เข้าได้'], ['set-bo', 'งดเข้าไม้']];
  const smooth = () => (window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');
  const anchors = h('nav', { class: 'anchors', 'aria-label': 'ส่วนต่าง ๆ ของหน้านี้' }, ANCHORS.map(([id, label]) => h('a', {
    href: `#${id}`, dataset: { target: id },
    onclick: (e) => { e.preventDefault(); const el = document.getElementById(id); if (!el) return; if (el.tagName === 'DETAILS') el.open = true; el.scrollIntoView({ behavior: smooth(), block: 'start' }); },
  }, label)));
  const markAnchor = () => {
    let cur = ANCHORS[0][0];
    for (const [id] of ANCHORS) { const el = document.getElementById(id); if (el && el.getBoundingClientRect().top < 150) cur = id; }
    anchors.querySelectorAll('a').forEach((a) => a.classList.toggle('on', a.dataset.target === cur));
  };
  let anchorQueued = false;
  const onScroll = () => { if (anchorQueued) return; anchorQueued = true; requestAnimationFrame(() => { anchorQueued = false; markAnchor(); }); };
  window.addEventListener('scroll', onScroll, { passive: true });
  root.append(headBox, h('div', { class: 'settings-layout' }, anchors, h('div', { class: 'settings-main' },
    nowBox,
    h('section', { class: 'set-sec', id: 'set-switch', 'aria-label': 'สวิตช์หลัก' },
      h('div', { class: 'set-sec-head' }, h('h2', null, 'สวิตช์หลัก'), h('p', null, 'มีผลทันทีที่เครื่องรับคำสั่ง')),
      h('div', { class: 'group' }, liveBox, pauseBox)),
    editorBox, sidesBox, boBox)),
  bar);
  requestAnimationFrame(markAnchor);

  const sigs = {};
  const changed = (key, val) => { const s = JSON.stringify(val); if (sigs[key] === s) return false; sigs[key] = s; return true; };

  function drawHead() {
    mount(headBox, pageHead('ตั้งค่าบอท',
      h('span', { class: 'row gap wrap' }, h('strong', { class: 'bot-name' }, bot.name),
        other ? h('span', { class: 'chip live' }, icon(viewOnly ? 'eye' : 'shield'), `ของ ${ownerName}`) : null, onlineBadge(onlineInfo(bot, st)),
        eaVer() ? h('span', { class: 'chip hide-sm' }, `EA ${eaVer()}`) : null),
      null, 'settings'));
  }

  // ---------------- "ค่าที่บอทใช้อยู่ตอนนี้"
  function drawNow(force) {
    const d = normDesired(ctl.desired);
    const prog = canSend() ? applyProgress(bot, ctl, st, B.matches) : null;
    const as = bot.agent_state || {};
    if (!changed('now', [B.now, B.pending, B.readOnly, B.hasStatus, prog, justSent, d.params, as.rejected, as.last_error,
      st && st.remote && st.remote.rejects, st && st.control && st.control.warn, ctl.version, appliedVersion(bot), cur(), pnlNow()]) && force !== true) return;
    const showProg = prog && (!prog.done || justSent);
    mount(nowBox,
      h('div', { class: 'set-sec-head' }, h('h2', null, 'ค่าที่บอทใช้อยู่ตอนนี้'),
        viewOnly ? h('span', { class: 'chip live' }, icon('eye'), 'ดูอย่างเดียว')
          : B.readOnly ? h('span', { class: 'chip warn' }, icon('lock'), `อ่านอย่างเดียว (บอทรุ่น ${eaVer() || '3.03'})`)
            : h('span', { class: 'chip good' }, icon('check'), 'เปลี่ยนจากเว็บได้')),
      h('div', { class: 'group', 'aria-live': 'polite' },
        B.hasStatus ? h('dl', { class: 'now-grid' }, summaryRows(B.now, cur(), pnlNow()).map(([k, val]) => h('div', { class: 'now-item' }, h('dt', null, k), h('dd', null, val))))
          : h('p', { class: 'muted group-note' }, 'ยังไม่ได้รับค่าจากบอท เมื่อเครื่องออนไลน์ ค่าจะขึ้นที่นี่'),
        showProg ? h('div', { class: 'now-progress' },
          B.pending ? h('p', { class: 'small' }, h('strong', null, 'ค่าใหม่ที่ส่งไป '), summaryText(normalizeParams({ ...B.now, ...d.params }), cur(), pnlNow())) : null,
          progressSteps(prog.steps),
          prog.done ? h('p', { class: 'good-text small' }, icon('check'), ' บอทใช้ค่าใหม่แล้ว') : null) : null,
        rejectionsBlock(bot, st),
        h('div', { class: 'now-foot' },
          h('a', { class: 'btn small', href: '#edit', onclick: (e) => { e.preventDefault(); editorBox.scrollIntoView({ behavior: smooth(), block: 'start' }); } }, icon('sliders'), editable() ? 'ปรับค่า' : 'ดูค่าทั้งหมด'),
          pendingChip(bot, ctl, onlineInfo(bot, st)),
          !showProg && prog && prog.done ? h('span', { class: 'muted small' }, 'ค่าล่าสุดที่ส่งจากเว็บ บอทใช้แล้ว') : null)));
  }

  // ---------------- live + pause cards
  function drawLive(force) {
    const d = normDesired(ctl.desired);
    if (!changed('live', [d.live, d.control.mode, ctl.version, appliedVersion(bot), appliedLive(st), onlineInfo(bot, st).agentOnline]) && force !== true) return;
    mount(liveBox, viewOnly ? liveReadOnly(d) : liveSwitch({ bot, ctl, st }));
  }
  // live state as a row without the switch (viewOnly's bot)
  function liveReadOnly(d) {
    const eff = appliedLive(st);
    return h('section', { class: `live-panel${d.live ? ' on' : ''}`, 'aria-label': 'เทรดจริง' },
      h('div', { class: 'live-row' },
        h('div', { class: 'live-copy' },
          h('p', { class: 'live-title' }, 'เทรดจริง'),
          h('p', { class: 'live-desc' }, d.live ? 'เจ้าของเปิดเทรดจริงไว้ บอทส่งคำสั่งซื้อขายในบัญชีจริงได้' : 'เจ้าของปิดเทรดจริงไว้ บอทไม่เปิดไม้ใหม่')),
        h('span', { class: `chip ${d.live ? 'live' : ''}` }, icon(d.live ? 'zap' : 'power'), d.live ? 'เปิดอยู่' : 'ปิดอยู่')),
      h('div', { class: 'live-meta' }, pendingChip(bot, ctl, onlineInfo(bot, st)),
        h('span', { class: `chip ${eff ? 'live' : ''}` }, eff === null ? 'ยังไม่มีสถานะจากเครื่อง' : eff ? 'ที่เครื่อง: บอทเปิดไม้ได้' : 'ที่เครื่อง: บอทไม่เปิดไม้ใหม่')));
  }
  function drawPause(force) {
    const d = normDesired(ctl.desired);
    const paused = d.control.mode === 'pause';
    const pend = isPending(bot, ctl);
    if (!changed('pause', [paused, pend]) && force !== true) return;
    mount(pauseBox, h('section', { class: `quick-card${paused ? ' is-paused' : ''}`, 'aria-label': 'หยุดชั่วคราว' },
      h('div', { class: 'quick-head' },
        h('div', null, h('h2', null, paused ? 'หยุดชั่วคราวอยู่' : 'หยุดชั่วคราว'),
          h('p', { class: 'muted' }, viewOnly ? (paused ? `${ownerName} สั่งหยุดไว้ บอทไม่เปิดไม้ใหม่` : 'ไม่ได้หยุด บอทเปิดไม้ใหม่ได้ตามสัญญาณ')
            : paused ? 'บอทไม่เปิดไม้ใหม่ จนกว่าจะกด "ทำงานต่อ"' : 'หยุดเปิดไม้ใหม่ชั่วคราว ไม้ที่เปิดอยู่ยังมี SL/TP ตามเดิม'),
          pend ? h('p', { class: 'muted small' }, 'รอเครื่องรับคำสั่ง…') : null),
        viewOnly ? h('span', { class: `chip ${paused ? 'pending' : 'good'}` }, icon(paused ? 'pause' : 'play'), paused ? 'หยุดอยู่' : 'ทำงานอยู่')
          : h('button', { class: `btn ${paused ? 'primary' : ''}`, type: 'button', onclick: (e) => togglePause(e.currentTarget, !paused) },
            icon(paused ? 'play' : 'pause'), paused ? 'ทำงานต่อ' : 'หยุดชั่วคราว'))));
  }
  async function togglePause(btn, pause) {
    if (!pause) {
      const ok = await confirmDialog('ให้บอททำงานต่อ?', 'บอทจะกลับมาเปิดไม้ใหม่ได้ตามสัญญาณ (ถ้าสวิตช์เทรดจริงเปิดอยู่)', { ok: 'ทำงานต่อ' });
      if (!ok) return;
    }
    busy(btn, true);
    try {
      ctl = await patchDesired(bot.id, (d) => { d.control.mode = pause ? 'pause' : 'run'; });
      toast(pause ? 'ส่งคำสั่งหยุดชั่วคราวแล้ว' : 'ส่งคำสั่งทำงานต่อแล้ว', 'good');
    } catch (e) { toast(errText(e), 'error', 6000); }
    refreshAll();
  }

  // ---------------- editor
  const updaters = [];
  const reg = (el) => { if (el && el.update) updaters.push(el); return el; };
  const errLine = (key) => { const p = h('p', { class: 'field-error', role: 'alert' }); p.update = () => { p.textContent = errors()[key] || ''; }; return reg(p); };
  const errLines = (...keys) => keys.map(errLine);
  const onChange = () => {
    fixHiddenLocks(v);
    for (const u of updaters) u.update();
    const body = editorBox.querySelector('.editor-body');
    if (body) body.classList.toggle('readonly', locked());
    drawBar();
    const ch = changes();
    writeDraft(ch.length ? { botId: bot.id, base: baseVals, v } : null);
  };
  const setKey = (k) => (x) => { v[k] = x; onChange(); };
  const getKey = (k) => () => v[k];

  function buildEditor() {
    updaters.length = 0;
    const ro = B.readOnly;
    const roBox = ro && !viewOnly ? h('div', { class: 'upgrade-box' }) : null;
    if (roBox) {
      roBox.update = () => {
        mount(roBox, 
          h('div', { class: 'upgrade-head' }, h('span', { class: 'upgrade-ico' }, icon('lock')),
            h('div', null,
              h('h3', null, `บอทนี้ยังเป็นรุ่น ${eaVer() || '3.03'} เปลี่ยนจากเว็บไม่ได้`),
              h('p', { class: 'muted' }, unlocked
                ? 'ลองปรับค่าด้านล่างได้ แล้วกด "ดาวน์โหลด .set" ที่แถบด้านล่าง นำไฟล์ไปโหลดใน MT5 (แท็บ Inputs → Load) ที่เครื่องนั้น'
                : 'ค่าด้านล่างคือค่าที่บอทใช้อยู่ (อ่านอย่างเดียว) สวิตช์เทรดจริง หยุดชั่วคราว และงดเข้าไม้ยังใช้ได้ตามปกติ'))),
          h('ol', { class: 'upgrade-steps' },
            h('li', null, h('strong', null, 'โหลดแอป Dobby รุ่นล่าสุด'), ' จากหน้า ', h('a', { href: '#/downloads' }, 'ดาวน์โหลดแอป'), ' แล้วเปิดที่เครื่อง ', bot.name),
            h('li', null, h('strong', null, 'ในแอปกด "เชื่อม MT5 / เปิด MT5 พร้อม Dobby"'), ' แอปติดตั้ง Dobby3_v305 กับไฟล์ Dobby3_v305_web.set ให้ แล้วใน MT5 เอา EA ตัวเดิมออกจากกราฟก่อน (ห้ามติด 2 ตัว) แล้วติดตัวใหม่แทน'),
            h('li', null, h('strong', null, 'ในแอป ตั้งค่า → ความปลอดภัย'), ' ติ๊ก "ให้เว็บส่งการตั้งค่าให้ Dobby" แล้วกลับมาที่หน้านี้ ค่าจะเปลี่ยนจากเว็บได้')),
          h('div', { class: 'row gap wrap' },
            h('a', { class: 'btn primary', href: '#/downloads' }, icon('download'), 'ดาวน์โหลดรุ่น 3.05'),
            unlocked ? h('button', { class: 'btn', type: 'button', onclick: () => downloadSet() }, icon('download'), 'ดาวน์โหลด .set ของค่าที่แก้')
              : h('button', { class: 'btn', type: 'button', onclick: () => { unlocked = true; onChange(); roBox.update(); } }, icon('edit'), 'ลองปรับค่าแล้วโหลดเป็นไฟล์ .set')));
      };
      reg(roBox);
    }

    // --- ทุนและล็อต
    // EA v3.04 counts virtual = InpVirtualStart + its own P&L since its start date (SPEC 9.8). The field shows and takes
    // that sum, "ทุนของบอท" (what the daily cap, the auto lot and the risk hint use), and stores InpVirtualStart = typed -
    // P&L, so typing the account balance never counts the bot's profit twice.
    const counted = () => Math.round((Number(v.InpVirtualStart) + pnlNow()) * 100) / 100;
    const startFor = (x) => Math.round((x - pnlNow()) * 100) / 100; // the InpVirtualStart that makes the bot count x
    moneyKey = moneyOf();
    const balStep = reg(stepper({
      label: 'ทุนของบอท', get: counted, step: 10, min: Math.max(10, Math.ceil(10 + pnlNow())), max: 10000000, decimals: 2,
      format: (x) => (Number.isInteger(x) ? String(x) : x.toFixed(2)),
      unit: cur(), disabled: locked,
      set: (x) => { v.InpVirtualStart = Number.isFinite(x) ? startFor(x) : NaN; onChange(); },
    }));
    balStep.classList.add('big');
    const useBal = h('button', { class: 'linklike', type: 'button', onclick: () => {
      const b = balNow();
      if (editable() && b !== null && startFor(b) >= 10) { v.InpVirtualStart = startFor(b); onChange(); }
    } });
    const balNote = h('span', { class: 'hint' });
    balNote.update = () => {
      const n = counted(), bal = balNow();
      const known = bal !== null && Number.isFinite(n);
      const same = known && Math.abs(n - bal) < 1;
      balNote.hidden = !known;
      useBal.hidden = !known || same || startFor(bal) < 10;
      useBal.disabled = locked();
      if (!known) return;
      useBal.textContent = `ใช้ยอดเงินในบัญชี (${fmtNum(bal)} ${cur()})`;
      // more than the account holds = a bigger daily cap than meant (warn); less is a choice (plain)
      mount(balNote, same ? h('span', { class: 'good-text' }, icon('check'), ` เท่ากับยอดเงินในบัญชี ${fmtNum(bal)} ${cur()}`)
        : n > bal ? h('span', { class: 'warn-text' }, `มากกว่ายอดเงินในบัญชี (${fmtNum(bal)} ${cur()}) จุดหยุดรายวันจะใหญ่กว่าที่ควร`)
          : `น้อยกว่ายอดเงินในบัญชี (${fmtNum(bal)} ${cur()})`);
    };
    reg(balNote);
    const pnlNote = h('span', { class: 'hint' });
    pnlNote.update = () => {
      const p = pnlNow();
      pnlNote.hidden = !p;
      if (!p) return;
      const since = st && st.virtual && st.virtual.start_date ? ` ตั้งแต่ ${fmtThai(Date.parse(`${st.virtual.start_date.slice(0, 10).replace(/\./g, '-')}T12:00:00Z`), 'dm')}` : '';
      mount(pnlNote, `รวม${p > 0 ? 'กำไร' : 'ขาดทุน'}ของบอท ${p > 0 ? '+' : '−'}${fmtNum(Math.abs(p))}${since} แล้ว บอทบวกส่วนนี้เอง เว็บจึงส่ง `,
        h('code', { class: 'ea-key' }, `InpVirtualStart ${fmtNum(v.InpVirtualStart)}`), ' ให้บอท');
    };
    reg(pnlNote);
    const autoBtn = h('button', { class: 'btn auto-btn', type: 'button', onclick: () => doAuto() }, icon('wand'), 'ตั้งให้อัตโนมัติจากทุน');
    autoBtn.update = () => { autoBtn.disabled = locked(); };
    reg(autoBtn);
    const autoText = h('span', { class: 'hint' });
    autoText.update = () => {
      const L = autoLot(counted());
      autoText.textContent = `ทุน ${fmtNum(counted(), 0)} ได้ล็อต ${fmtNum(L)} ทุกสูตร (ทุก 100 ${cur()} = 0.01 ล็อต) เปิด 3 สูตร ล็อกกำไร 2 ชั้น (85→83 และ 95→93) และหยุดเมื่อขาดทุน 10% ต่อวัน`;
    };
    reg(autoText);
    const risk = h('div', { class: 'risk-hint', 'aria-live': 'polite' });
    risk.update = () => {
      const lot = mainLot(v);
      const r = riskHint(counted(), lot, cur());
      risk.className = `risk-hint tone-${r.tone}`;
      mount(risk, icon(r.tone === 'warn' ? 'warn' : 'bars'),
        h('p', null, r.text, ' ', h('a', { href: `#/calc?balance=${Math.round(counted())}&lot=${lot}` }, 'ดูรายละเอียด'),
          h('span', { class: 'muted small' }, ' (ผลจำลองในอดีต ไม่ใช่คำทำนาย)')));
    };
    reg(risk);

    const lotSeg = reg(segmented({
      label: 'วิธีตั้งล็อต', wide: true, options: [{ value: 'same', label: 'เท่ากันทุกสูตร' }, { value: 'per', label: 'แยกแต่ละสูตร' }],
      get: () => lotMode, disabled: locked,
      set: (m) => { lotMode = m; if (m === 'same') setLotsAll(v, mainLot(v)); onChange(); },
    }));
    const lotMax = () => { const c = ceilings().lots; return c != null ? c : 5; };
    const sameStep = reg(stepper({ label: 'ล็อตต่อไม้ ทุกสูตร', get: () => mainLot(v), set: (x) => { setLotsAll(v, x); onChange(); }, step: 0.01, min: 0.01, max: lotMax(), decimals: 2, unit: 'ล็อต', disabled: locked }));
    sameStep.classList.add('big');
    const sameRow = setRow(h('label', { class: 'set-label', for: sameStep.input.id }, 'ล็อตต่อไม้'), [h('span', { class: 'hint' }, 'ทุกสูตรใช้ล็อตเท่ากัน')], sameStep);
    const perRows = h('div', { class: 'lot-per' }, STRATS.map((s) => h('div', { class: 'lot-row' },
      h('span', { class: 'lot-name' }, h('span', { class: `mod m${STRATS.indexOf(s) + 1}` }, h('span', { class: 'sw' })), s.title),
      reg(stepper({ label: `ล็อต ${s.title}`, get: getKey(s.lots), set: (x) => { v[s.lots] = x; syncMaxLots(v); onChange(); }, step: 0.01, min: 0.01, max: lotMax(), decimals: 2, unit: 'ล็อต', disabled: locked })))));
    const lotWrap = h('div', { class: 'lot-wrap' }, sameRow, perRows);
    lotWrap.style.display = 'contents';
    lotWrap.update = () => { sameRow.hidden = lotMode !== 'same'; perRows.hidden = lotMode !== 'per'; };
    reg(lotWrap);
    const ceilHint = h('p', { class: 'hint' });
    ceilHint.update = () => {
      const c = ceilings();
      const atMax = c.lots != null && mainLot(v) >= c.lots - 1e-9;
      mount(ceilHint, c.lots != null ? [`เพดานของเครื่อง ${bot.name} คือไม่เกิน ${fmtNum(c.lots)} ล็อตต่อไม้`,
        atMax ? h('span', { class: 'warn-text' }, ' ถึงเพดานแล้ว ถ้าต้องการมากกว่านี้ เพิ่ม "ล็อตสูงสุดที่เว็บสั่งได้" ในแอป Dobby ที่เครื่องนั้น (ตั้งค่า แล้วเลือก ความปลอดภัย)') : null]
        : 'เครื่องยังไม่ได้รายงานเพดานล็อต');
    };
    reg(ceilHint);

    // one line per distinct message (in "same lot" mode the three strategies share one message)
    const lotErr = h('div', { class: 'stack', role: 'alert' });
    lotErr.update = () => {
      const e = errors();
      const msgs = [...new Set(STRATS.map((s) => e[s.lots]).filter(Boolean))];
      mount(lotErr, msgs.map((m) => h('p', { class: 'field-error' }, m)));
      lotErr.hidden = !msgs.length;
    };
    reg(lotErr);
    const secMoney = h('section', { class: 'ed-sec', id: 'set-money' },
      secHead('ทุนและล็อต', 'บอทใช้ทุนนี้คำนวณกำไรขาดทุนและจุดหยุดรายวัน'),
      h('div', { class: 'group' },
        setRow(h('label', { class: 'set-label', for: balStep.input.id }, 'ทุนของบอท'), [balNote, useBal, pnlNote], balStep, errLines('InpVirtualStart')),
        setRow(h('span', { class: 'set-label' }, 'ตั้งให้อัตโนมัติจากทุน'), [autoText], autoBtn),
        risk,
        setRow(h('span', { class: 'set-label' }, 'วิธีตั้งล็อต'), [], lotSeg),
        lotWrap, h('div', { class: 'group-note' }, ceilHint, lotErr)));

    // --- สูตร
    const stratCards = STRATS.map((s) => {
      const lotChip = h('span', { class: 'chip' });
      const t = bigToggle({ title: s.title, text: s.text, get: getKey(s.use), set: setKey(s.use), disabled: locked, badge: lotChip });
      const up = t.update;
      t.update = () => { up(); lotChip.textContent = `${fmtNum(v[s.lots])} ล็อต`; };
      return reg(t);
    });
    const asiaStep = reg(stepper({ label: 'ล็อตเอเชีย', get: getKey('InpLotsAsia'), set: setKey('InpLotsAsia'), step: 0.01, min: 0.01, max: lotMax(), decimals: 2, unit: 'ล็อต', disabled: locked }));
    const asiaExtra = h('div', { class: 'toggle-extra' }, h('span', { class: 'small muted' }, 'ล็อตของสูตรเอเชีย (แยกจากสูตรหลัก)'), asiaStep, errLine('InpLotsAsia'));
    const asia = bigToggle({ title: ASIA.title, text: ASIA.text, get: getKey(ASIA.use), set: setKey(ASIA.use), disabled: locked, badge: h('span', { class: 'chip' }, 'สูตรเสริม'), extra: asiaExtra });
    const asiaUp = asia.update;
    asia.update = () => { asiaUp(); asiaExtra.hidden = !v.InpUseAsia; };
    reg(asia);
    const noneWarn = h('div');
    noneWarn.update = () => {
      mount(noneWarn, !STRATS.some((s) => v[s.use]) ? callout('warn', 'ปิดทุกสูตรหลัก', h('p', null, 'บอทจะไม่เปิดไม้ใหม่จากสูตรหลัก ถ้าแค่อยากพักชั่วคราว ใช้ปุ่ม "หยุดชั่วคราว" ด้านบนง่ายกว่า')) : '');
    };
    reg(noneWarn);
    const secStrat = h('section', { class: 'ed-sec', id: 'set-strat' },
      secHead('สูตรที่เปิดใช้', 'เปิดได้หลายสูตรพร้อมกัน แต่ละสูตรเข้าไม้แยกกัน'),
      h('div', { class: 'group toggle-grid' }, stratCards, asia, noneWarn));

    // --- ล็อกกำไร
    const lockSeg = reg(segmented({
      label: 'ล็อกกำไร', wide: true, disabled: locked, get: () => lockMode(v), set: (m) => { setLockMode(v, m); onChange(); },
      options: [{ value: 0, label: 'ไม่ล็อก' }, { value: 1, label: '1 ชั้น' }, { value: 2, label: '2 ชั้น' }],
    }));
    const stageRow = (name, atKey, toKey, cls) => {
      const atS = reg(stepper({ label: `${name}: กำไรถึงกี่ % ของ TP`, get: getKey(atKey), set: setKey(atKey), step: 1, min: atKey === 'InpLockAtPct' ? 50 : 10, max: 99.5, decimals: 1, unit: '%', trim: true, disabled: locked }));
      const toS = reg(stepper({ label: `${name}: เลื่อน SL ไปที่กี่ %`, get: getKey(toKey), set: setKey(toKey), step: 1, min: 1, max: 99, decimals: 1, unit: '%', trim: true, disabled: locked }));
      const txt = h('p', { class: 'small' });
      txt.update = () => { txt.textContent = `เมื่อกำไรวิ่งถึง ${pctText(v[atKey])}% ของทางไป TP บอทจะเลื่อน SL ไปที่ ${pctText(v[toKey])}% ต่อให้ราคากลับ ก็ยังได้กำไรราว ${pctText(v[toKey])}% ของ TP`; };
      reg(txt);
      const row = h('div', { class: `stage ${cls}` },
        h('p', { class: 'stage-name' }, name),
        h('div', { class: 'stage-ctrls' },
          h('div', { class: 'stage-ctrl' }, h('span', { class: 'small muted' }, 'เมื่อกำไรถึง (% ของทางไป TP)'), atS),
          h('div', { class: 'stage-ctrl' }, h('span', { class: 'small muted' }, 'เลื่อน SL ไปที่ (% ของทางไป TP)'), toS)),
        txt, errLine(atKey), errLine(toKey));
      return row;
    };
    const st1 = stageRow('ชั้นแรก', 'InpLock1AtPct', 'InpLock1ToPct', 's1');
    const st2 = stageRow('ชั้นใกล้ TP', 'InpLockAtPct', 'InpLockToPct', 's2');
    const noLock = h('p', { class: 'muted' }, 'ไม่ล็อก: ไม้จะวิ่งจนถึง TP หรือ SL เดิม (หรือหมดเวลา)');
    const stages = h('div', { class: 'stages' }, noLock, st1, st2);
    stages.update = () => { const m = lockMode(v); noLock.hidden = m !== 0; st1.hidden = m !== 2; st2.hidden = m === 0; };
    reg(stages);
    const ladder = h('div', { class: 'ladder', role: 'img' });
    ladder.update = () => drawLadder(ladder);
    reg(ladder);
    const secLock = h('section', { class: 'ed-sec', id: 'set-lock' },
      secHead('ล็อกกำไร', h('span', null, 'เลื่อน SL ขึ้นมาเป็นกำไรเมื่อราคาใกล้ TP ', h('a', { href: '#/guide/lock' }, 'ล็อกกำไรคืออะไร'))),
      h('div', { class: 'group' },
        setRow(h('span', { class: 'set-label' }, 'จำนวนชั้น'), [], lockSeg),
        ladder, stages));

    // --- ขาดทุนสูงสุดต่อวัน
    const capMax = () => { const c = ceilings().cap; return c != null ? c : 100; };
    const capStep = reg(stepper({ label: 'ขาดทุนสูงสุดต่อวัน', get: getKey('InpDailyCapPct'), set: setKey('InpDailyCapPct'), step: 0.5, min: 1, max: capMax(), decimals: 1, unit: '%', trim: true, disabled: locked }));
    capStep.classList.add('big');
    const capText = h('span', { class: 'hint' });
    capText.update = () => {
      const amt = (v.InpDailyCapPct / 100) * counted();
      capText.textContent = `≈ ${fmtNum(amt, 0)} ${cur()} ต่อวัน (จากทุน ${fmtNum(counted(), 0)}) ถึงแล้วบอทหยุดเปิดไม้ใหม่ถึงพรุ่งนี้ ไม้ที่เปิดอยู่ยังวิ่งต่อ`;
    };
    reg(capText);
    const secCap = h('section', { class: 'ed-sec', id: 'set-cap' },
      secHead('ขาดทุนสูงสุดต่อวัน', 'นับจากไม้ที่ปิดแล้ววันนี้ เทียบกับทุนต้นวัน'),
      h('div', { class: 'group' },
        setRow(h('label', { class: 'set-label', for: capStep.input.id }, 'หยุดเปิดไม้เมื่อขาดทุนถึง'),
          [capText, ceilings().cap != null ? h('span', { class: 'hint' }, `เพดานของเครื่องคือไม่เกิน ${pctText(ceilings().cap)}%`) : null], capStep, [errLine('InpDailyCapPct')])));

    // --- ขั้นสูง
    const adv = (label, key, ctrl, help) => h('div', { class: 'adv-row' },
      h('div', { class: 'adv-copy' }, h('p', { class: 'adv-label' }, label, ' ', h('code', { class: 'ea-key' }, key)), help ? h('p', { class: 'hint' }, help) : null),
      h('div', { class: 'adv-ctrl' }, ctrl, errLine(key.split(' ')[0])));
    const chk = (key, label) => {
      const inp = h('input', { type: 'checkbox', onchange: (e) => { v[key] = e.target.checked; onChange(); } });
      const l = h('label', { class: 'check' }, inp, label, ' ', h('code', { class: 'ea-key' }, key));
      l.update = () => { inp.checked = !!v[key]; inp.disabled = locked(); };
      return reg(l);
    };
    const volT = h('input', { type: 'checkbox', class: 'toggle', role: 'switch', 'aria-label': 'เปิดตัวกรองความผันผวน', onchange: (e) => { v.InpVolGate = e.target.checked; onChange(); } });
    volT.update = () => { volT.checked = !!v.InpVolGate; volT.disabled = locked(); };
    reg(volT);
    const advBox = h('details', { class: 'ed-sec adv', id: 'set-adv' },
      h('summary', null, h('strong', null, 'ขั้นสูง'), h('span', { class: 'muted small' }, 'ไม้แก้ จำนวนไม้ สัญญาณตรงกัน สเปรด และตัวกรอง ไม่ต้องแก้ก็ได้')),
      h('div', { class: 'group adv-list' },
        adv('ตัวคูณล็อตไม้แก้หลังแพ้', 'InpRecoveryMult', reg(stepper({ label: 'ตัวคูณไม้แก้', get: getKey('InpRecoveryMult'), set: setKey('InpRecoveryMult'), step: 0.1, min: 1, max: 2, decimals: 1, unit: '×', disabled: locked })), '1.0 = ไม้แก้ขนาดเท่าเดิม 1.5 = ใหญ่ขึ้นครึ่งหนึ่ง'),
        adv('ไม้สูงสุดต่อสูตรต่อวัน', 'InpMaxAttempts', reg(stepper({ label: 'ไม้สูงสุดต่อสูตรต่อวัน', get: getKey('InpMaxAttempts'), set: setKey('InpMaxAttempts'), step: 1, min: 1, max: 4, decimals: 0, unit: 'ไม้', disabled: locked })), 'รวมไม้แรกและไม้แก้หลังแพ้'),
        adv('ตัวคูณล็อตเมื่อสัญญาณตรงกัน', 'InpConfluenceMult', reg(stepper({ label: 'ตัวคูณสัญญาณตรงกัน', get: getKey('InpConfluenceMult'), set: setKey('InpConfluenceMult'), step: 0.1, min: 1, max: 2, decimals: 1, unit: '×', disabled: locked })), 'เมื่ออีกสูตรเพิ่งเข้าทางเดียวกัน 1.0 = ปิด'),
        adv('ช่วงเวลาสัญญาณตรงกัน', 'InpConfluenceMin', reg(stepper({ label: 'ช่วงเวลาสัญญาณตรงกัน', get: getKey('InpConfluenceMin'), set: setKey('InpConfluenceMin'), step: 5, min: 0, max: 240, decimals: 0, unit: 'นาที', disabled: locked }))),
        adv('สเปรดสูงสุดที่ยอมเข้าไม้', 'InpMaxSpread', reg(stepper({ label: 'สเปรดสูงสุด', get: getKey('InpMaxSpread'), set: setKey('InpMaxSpread'), step: 0.05, min: 0.05, max: 2, decimals: 2, unit: '$', disabled: locked })), 'สเปรดกว้างกว่านี้ บอทจะไม่เปิดไม้'),
        adv('ตัวกรองความผันผวน (NY และ C5G)', 'InpVolGate', volT, 'เทรดเฉพาะวันที่ตลาดเคลื่อนไหวพอ'),
        adv('เกณฑ์ความผันผวน', 'InpVolGatePct', reg(stepper({ label: 'เกณฑ์ความผันผวน', get: getKey('InpVolGatePct'), set: setKey('InpVolGatePct'), step: 0.05, min: 0.5, max: 5, decimals: 2, unit: '%', disabled: locked }))),
        h('div', { class: 'adv-row' }, h('div', { class: 'adv-copy' }, h('p', { class: 'adv-label' }, 'ล็อกกำไรใช้กับสูตร')),
          h('div', { class: 'adv-ctrl checks' }, chk('InpLock_A', 'A_new'), chk('InpLock_NY', 'NY'), chk('InpLock_C5G', 'C5G'), chk('InpLockShadow', 'บันทึกล็อกเงา'))),
        adv('หยุดถาวรเมื่อพอร์ตจำลองเหลือ', 'InpKillBalance', reg(stepper({ label: 'หยุดถาวรเมื่อเหลือ', get: getKey('InpKillBalance'), set: setKey('InpKillBalance'), step: 10, min: 0, max: 10000000, decimals: 0, unit: cur(), disabled: locked })), '0 = หยุดเมื่อเหลือ 0 เท่านั้น')));

    // --- โหมด runner (EA v3.05, SPEC 11): a switch only when the bot reports 3.05; older bots see how to update
    runnerBuilt = runnerOk();
    let secRunner;
    const runnerHead = secHead('โหมด runner (ปล่อยให้วิ่งหลัง TP)',
      h('span', null, 'เมื่อราคาถึง TP ไม่ปิดไม้ แต่กันกำไรไว้แล้วปล่อยให้วิ่งต่อ ', h('a', { href: '#/guide/runner' }, 'โหมด runner คืออะไร')));
    if (!runnerBuilt) {
      secRunner = h('section', { class: 'ed-sec', id: 'set-runner' }, runnerHead,
        h('div', { class: 'group' }, viewOnly
          ? h('p', { class: 'muted group-note' }, `บอทนี้เป็นรุ่น ${eaVer() || '3.04'} ยังไม่มีโหมด runner (มีตั้งแต่ EA v3.05)`)
          : callout('info', 'ต้องอัปเดต EA เป็น v3.05 และแอป Dobby 1.2.2 ก่อน',
            h('p', null, `บอทนี้รายงานรุ่น ${eaVer() || 'ไม่ทราบ'} โหลดแอป Dobby รุ่นล่าสุดจากหน้า `, h('a', { href: '#/downloads' }, 'ดาวน์โหลดแอป'),
              ' เปิดที่เครื่อง ', bot.name, ' แล้วกด "เชื่อม MT5 / เปิด MT5 พร้อม Dobby" แอปติดตั้ง Dobby3_v305 กับไฟล์ Dobby3_v305_web.set ให้ ส่วนนี้จะเปลี่ยนเป็นสวิตช์เมื่อบอทรายงานรุ่น 3.05 ค่าอื่น ๆ ยังตั้งจากเว็บได้ตามปกติ'),
            h('p', { class: 'muted small' }, 'หมายเหตุ: แอป Dobby ส่งค่าโหมด runner ให้เฉพาะบอทที่รายงานรุ่น 3.05 ขึ้นไป กับบอทรุ่นเก่ากว่า แอปตัดค่ากลุ่มนี้ออกเงียบ ๆ (ค่าอื่นยังส่งถึง) ถ้าเคยตั้งโหมด runner ไว้แล้วบอทไม่เปลี่ยน สาเหตุคือรุ่น EA นี้เอง'),
            h('div', { class: 'row gap wrap' }, h('a', { class: 'btn small', href: '#/downloads' }, icon('download'), 'ไปหน้าดาวน์โหลด')))));
    } else {
      const runWarn = h('div');
      runWarn.update = () => { mount(runWarn, v.InpRunnerEnable ? callout('warn', 'ยังเป็นโหมดทดลอง', h('p', null, RUNNER_WARNING)) : ''); };
      reg(runWarn);
      // a warning, not an error: the safety TP sits closer than one ratchet step (shown under the advanced numbers)
      const safetyWarn = h('p', { class: 'field-warn', role: 'status' });
      safetyWarn.update = () => { safetyWarn.textContent = runnerSafetyTooClose(v) ? RUNNER_SAFETY_WARNING : ''; safetyWarn.hidden = !runnerSafetyTooClose(v); };
      reg(safetyWarn);
      const noMod = h('p', { class: 'field-error', role: 'alert' });
      noMod.update = () => { noMod.textContent = v.InpRunnerEnable && !(v.InpRunner_A || v.InpRunner_NY || v.InpRunner_C5G) ? 'เปิดโหมด runner แต่ไม่ได้เลือกสูตรใดเลย จึงไม่มีผล' : ''; };
      reg(noMod);
      const runnerExtra = h('div', { class: 'toggle-extra runner-extra' },
        h('span', { class: 'small muted' }, 'ใช้กับสูตร (ASIA16 ไม่ใช้)'),
        h('div', { class: 'checks' }, chk('InpRunner_A', 'A_new'), chk('InpRunner_NY', 'NY'), chk('InpRunner_C5G', 'C5G')), noMod);
      const explain = h('p', { class: 'hint runner-explain' });
      explain.update = () => {
        explain.textContent = `เมื่อราคาถึง TP บอทไม่ปิดไม้ แต่เลื่อน SL ไปที่ ${pctText(v.InpRunnerKeepPct)}% ของกำไร TP (ในทางปฏิบัติ ล็อก ${pctText(v.InpLockToPct)}% ที่มีอยู่แล้วมักสูงกว่าจุดนี้ จึงใช้ค่าที่สูงกว่า) `
          + `แล้วขยับเป้าขึ้นทีละ ${fmtNum(v.InpRunnerStep, 1)} เท่าของระยะ SL (ราว ${fmtNum(v.InpRunnerStep, 1)} ATR) พร้อมเลื่อน SL ตามทีละก้าว จนราคาย่อกลับหนึ่งก้าวจึงปิดไม้ `
          + `ค่าที่ทดสอบ: เก็บ 75 % / ก้าว 0.5 / ไม่จำกัด ทดสอบในคอม (จำลอง) แล้ว ยังไม่ผ่าน Strategy Tester`;
      };
      reg(explain);
      const runT = bigToggle({
        title: 'โหมด runner', text: 'ปล่อยให้ไม้ที่ถึง TP วิ่งต่อ โดยมี SL กันกำไรขยับตาม ไม้ส่วนน้อยที่วิ่งไกลคือที่มาของกำไรเพิ่ม',
        get: getKey('InpRunnerEnable'), set: setKey('InpRunnerEnable'), disabled: locked, badge: h('span', { class: 'chip warn' }, 'ทดลอง'), extra: runnerExtra,
      });
      reg(runT);
      const runAdv = h('details', { class: 'subpanel runner-adv' },
        h('summary', null, 'ค่าขั้นสูงของ runner (เก็บ % ก้าว จำนวนก้าว TP สำรอง)'),
        h('div', { class: 'adv-list' },
          adv('เก็บกำไรขั้นต่ำเมื่อถึง TP', 'InpRunnerKeepPct', reg(stepper({ label: 'เก็บกำไรขั้นต่ำเมื่อถึง TP', get: getKey('InpRunnerKeepPct'), set: setKey('InpRunnerKeepPct'), step: 1, min: 50, max: 99, decimals: 0, unit: '% ของ TP', disabled: locked })),
            'SL ใหม่ตอนแตะ TP = ราคาเข้า + เท่านี้ % ของระยะ TP (ไม่ต่ำกว่า SL ที่ล็อกไว้แล้ว) ค่าที่ทดสอบ 75'),
          adv('ก้าวของเป้าและ SL', 'InpRunnerStep', reg(stepper({ label: 'ก้าวของเป้าและ SL', get: getKey('InpRunnerStep'), set: setKey('InpRunnerStep'), step: 0.1, min: 0.1, max: 2, decimals: 1, unit: '× ระยะ SL', disabled: locked })),
            'เป้าถัดไปอยู่สูงกว่าเดิมเท่านี้เท่าของระยะ SL ทุกครั้งที่ถึงเป้า SL ก็เลื่อนตามเท่ากัน ค่าที่ทดสอบ 0.5'),
          adv('จำนวนก้าวสูงสุด', 'InpRunnerMaxSteps', reg(stepper({ label: 'จำนวนก้าวสูงสุด', get: getKey('InpRunnerMaxSteps'), set: setKey('InpRunnerMaxSteps'), step: 1, min: 0, max: 50, decimals: 0, unit: 'ก้าว', disabled: locked })),
            '0 = ไม่จำกัด (ค่าที่ทดสอบ) ถ้าตั้งไว้ เมื่อครบจำนวนบอทจะตั้ง TP ที่โบรกไว้ที่เป้าสุดท้าย'),
          adv('TP สำรองฝั่งโบรกเกอร์', 'InpRunnerSafetyTP', reg(stepper({ label: 'TP สำรองฝั่งโบรกเกอร์', get: getKey('InpRunnerSafetyTP'), set: setKey('InpRunnerSafetyTP'), step: 0.5, min: 0, max: 10, decimals: 1, unit: '× ระยะ SL', disabled: locked })),
            'TP ที่โบรกตั้งไว้ที่ "เป้าถัดไป + เท่านี้เท่าของระยะ SL (ราว N × ATR)" และขยับตามเป้าทุกก้าว มีไว้กันกรณีคอมหลุดเท่านั้น ปกติไม่ปิดไม้ (0 = ไม่ตั้ง TP ที่โบรก)'),
          safetyWarn));
      secRunner = h('section', { class: 'ed-sec', id: 'set-runner' }, runnerHead,
        h('div', { class: 'group' }, runT, runWarn, explain, runAdv));
    }

    // --- C5G: a signal bar that closes a few cents on the wrong side of VWAP (EA v3.07 InpC5_VwapTol, r51)
    let secVwap;
    const vwHead = secHead('C5G: ไม้ที่ปิดก้ำกึ่งเส้น VWAP',
      'ปกติ C5G เปิดเมื่อแท่งปิดเลยเส้น VWAP ไปแล้วเท่านั้น ถ้าปิดห่างเส้นแค่ไม่กี่เซนต์ บอทที่อยู่คนละโบรกอาจเห็นคนละฝั่ง');
    if (!vwapTolSupported(eaVer(), bot.agent_version)) {
      secVwap = h('section', { class: 'ed-sec', id: 'set-vwap' }, vwHead,
        h('div', { class: 'group' }, viewOnly
          ? h('p', { class: 'muted group-note' }, 'บอทนี้ยังไม่มีค่านี้ (มีตั้งแต่ EA v3.07 กับแอป Dobby 1.3.1)')
          : callout('info', 'ต้องอัปเดต EA เป็น v3.07 และแอป Dobby 1.3.1 ก่อน',
            h('p', null, `บอทนี้รายงาน EA ${eaVer() || 'ไม่ทราบรุ่น'} แอป ${bot.agent_version || 'ไม่ทราบรุ่น'} ติดตั้งแอปใหม่ก่อน แล้วค่อยเปลี่ยน EA บนกราฟเป็น Dobby3_v307 ตอนไม่มีไม้เปิด ส่วนนี้จะกดเลือกได้เมื่อบอทรายงานรุ่นใหม่ทั้งสองตัว`))));
    } else {
      let lastOn = Number(v.InpC5_VwapTol) > 0 ? Number(v.InpC5_VwapTol) : 0.15;
      const tolSeg = reg(segmented({
        label: 'ไม้ C5G ที่ปิดก้ำกึ่งเส้น VWAP', wide: true, disabled: locked,
        get: () => (Number(v.InpC5_VwapTol) > 0 ? 1 : 0),
        set: (m) => {
          if (m) v.InpC5_VwapTol = lastOn;
          else { if (Number(v.InpC5_VwapTol) > 0) lastOn = Number(v.InpC5_VwapTol); v.InpC5_VwapTol = 0; }
          onChange();
        },
        options: [{ value: 0, label: 'ไม่เปิด (ค่าเดิม)' }, { value: 1, label: 'เปิด' }],
      }));
      const tolStep = reg(stepper({ label: 'ปิดเลยเส้นได้ไม่เกิน', get: getKey('InpC5_VwapTol'), set: (x) => { v.InpC5_VwapTol = x; lastOn = x; onChange(); },
        step: 0.05, min: 0.05, max: 0.5, decimals: 2, unit: '$', disabled: locked }));
      const tolRow = setRow(h('label', { class: 'set-label', for: tolStep.input.id }, 'ปิดเลยเส้นไปอีกฝั่งได้ไม่เกิน'),
        [h('span', { class: 'hint' }, '0.15 ขึ้นไปจะได้ไม้แบบวันที่ 13 พ.ย. ที่แท่งปิดเหนือเส้น 0.11')], tolStep, [errLine('InpC5_VwapTol')]);
      tolRow.update = () => { tolRow.hidden = !(Number(v.InpC5_VwapTol) > 0); };
      reg(tolRow);
      const tolText = h('p', { class: 'hint' });
      tolText.update = () => {
        const t = Number(v.InpC5_VwapTol) || 0;
        tolText.textContent = t > 0
          ? `ขายได้ถ้าแท่งปิดสูงกว่าเส้นไม่เกิน ${fmtNum(t, 2)} $ และซื้อได้ถ้าปิดต่ำกว่าเส้นไม่เกิน ${fmtNum(t, 2)} $ เงื่อนไขอื่นของ C5G เหมือนเดิมทุกข้อ ผลทดสอบปี 2026: ยังไม่มีระยะไหนดีกว่าแบบไม่เปิด ไม้ก้ำกึ่งแบบนี้ชนะราวครึ่งเดียว`
          : 'บอทเปิดเฉพาะเมื่อแท่งปิดเลยเส้น VWAP ไปแล้ว (ขายต้องปิดใต้เส้น ซื้อต้องปิดเหนือเส้น) เป็นค่าที่ใช้มาตลอดและผ่านการทดสอบ';
      };
      reg(tolText);
      secVwap = h('section', { class: 'ed-sec', id: 'set-vwap' }, vwHead,
        h('div', { class: 'group' }, setRow(h('span', { class: 'set-label' }, 'ไม้ก้ำกึ่งเส้น VWAP'), [], tolSeg), tolRow, tolText));
    }

    // --- presets + .set
    const tools = viewOnly
      ? h('div', { class: 'ed-tools' }, h('button', { class: 'btn ghost', type: 'button', onclick: () => downloadSet() }, icon('download'), 'ดาวน์โหลด .set ของค่านี้'))
      : h('div', { class: 'ed-tools' },
        h('button', { class: 'btn', type: 'button', onclick: () => loadPresetDialog() }, icon('folder'), 'โหลดจากพรีเซ็ตที่บันทึกไว้'),
        h('button', { class: 'btn', type: 'button', onclick: () => savePresetDialog() }, icon('save'), 'บันทึกเป็นพรีเซ็ต'),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => downloadSet() }, icon('download'), 'ดาวน์โหลด .set'));
    if (!viewOnly) { tools.querySelectorAll('button')[0].update = function () { this.disabled = locked(); }; reg(tools.querySelectorAll('button')[0]); }

    mount(editorBox, 
      h('div', { class: 'ed-head' },
        h('div', { class: 'section-label' }, h('h2', null, B.readOnly ? 'ค่าทั้งหมดของบอท' : 'ปรับการตั้งค่า'),
          h('p', { class: 'muted small' }, viewOnly ? `ค่าที่บอทของ ${ownerName} ใช้อยู่ ดูอย่างเดียว แก้ไม่ได้` : B.readOnly ? 'ค่าที่บอทรุ่นนี้รายงานมา' : 'แก้ได้หลายอย่าง แล้วกด "บันทึกและส่งให้บอท" ที่แถบด้านล่างครั้งเดียว')),
        helpBtn('settings')),
      roBox,
      h('div', { class: `editor-body${ro ? ' readonly' : ''}` }, secMoney, secStrat, secLock, secCap, secRunner, secVwap, advBox),
      tools);
    for (const u of updaters) u.update();
    editorBox.querySelector('.editor-body').classList.toggle('readonly', locked());
  }
  const secHead = (title, sub) => h('div', { class: 'sec-head' }, h('h3', null, title), sub ? h('p', null, sub) : null);
  // one settings row: label (+ hints) left, control right; extra lines (errors) under it
  const setRow = (label, hints, control, extra) => h('div', { class: 'set-row' },
    h('div', { class: 'set-row-main' }, h('div', { class: 'set-copy' }, label, ...(hints || []).filter(Boolean)), h('div', { class: 'set-ctrl' }, control)),
    ...(extra || []));

  // The lock ladder: price levels from TP down to the original SL, equally spaced (a trading "price ladder"), so
  // stages a few percent apart stay readable. The rail between the entry and the highest new SL is the profit kept.
  function drawLadder(el) {
    const m = lockMode(v);
    el.hidden = m === 0;
    if (m === 0) { mount(el); return; }
    const lv = [{ p: 100, k: 'tp', t: [h('strong', null, 'TP'), ' ปิดไม้ที่กำไรเต็ม'] }];
    const stage = (name, at, to) => {
      lv.push({ p: at, k: 'at', t: [h('strong', null, name), ` เมื่อกำไรวิ่งมาถึง ${pctText(at)}%`] });
      lv.push({ p: to, k: 'to', t: [h('strong', null, `SL ใหม่ ${pctText(to)}%`), ' ล็อกกำไรไว้เท่านี้'] });
    };
    stage(m === 2 ? 'ชั้นใกล้ TP' : 'ล็อกกำไร', v.InpLockAtPct, v.InpLockToPct);
    if (m === 2) stage('ชั้นแรก', v.InpLock1AtPct, v.InpLock1ToPct);
    lv.sort((a, b) => b.p - a.p || (a.k === 'at' ? -1 : 1));
    const keep = Math.max(...lv.filter((x) => x.k === 'to').map((x) => x.p));
    el.setAttribute('aria-label', `บันไดราคา: ${lv.map((x) => `${pctText(x.p)}%`).join(' ')} ราคาเข้า และ SL เดิม`);
    const row = (pct, k, text, cls = '') => h('div', { class: `ladder-row ${k} ${cls}`.trim() },
      h('span', { class: 'ladder-pct' }, pct), h('span', { class: 'ladder-rail' }, h('span', { class: 'ladder-mark' })), h('span', { class: 'ladder-text' }, text));
    mount(el,
      lv.map((x) => row(`${pctText(x.p)}%`, x.k, x.t, x.p <= keep ? 'safe' : '')),
      h('div', { class: 'ladder-row gap-row safe', 'aria-hidden': 'true' }, h('span'), h('span', { class: 'ladder-rail' }), h('span')),
      row('0%', 'entry', [h('strong', null, 'ราคาเข้า')], 'risk'),
      row('SL', 'sl', [h('strong', null, 'SL เดิม'), ' ขาดทุนเต็มถ้าราคาไม่ถึงชั้นแรก'], 'risk'));
  }

  async function doAuto() {
    if (!editable()) return;
    // the lot follows the capital the bot counts; the start itself stays (with a P&L it is not the balance)
    const keep = v.InpVirtualStart;
    const B0 = Math.round(counted());
    v = autoFromBalance(v, B0);
    if (pnlNow()) v.InpVirtualStart = keep;
    lotMode = 'same';
    onChange();
    toast(`ตั้งค่าอัตโนมัติสำหรับทุน ${fmtNum(B0, 0)} แล้ว: ${summaryText(v, cur(), pnlNow())} ตรวจแล้วกด "บันทึกและส่งให้บอท"`, 'good', 6500);
  }

  // ---------------- action bar
  function drawBar() {
    const ch = changes();
    const errs = errors();
    const nErr = new Set(Object.values(errs)).size;
    const show = ch.length > 0 && editable();
    bar.hidden = !show;
    document.body.classList.toggle('has-action-bar', show);
    if (!show) { mount(bar); return; }
    const sendLabel = B.readOnly ? 'ดาวน์โหลด .set' : 'บันทึกและส่งให้บอท';
    mount(bar, h('div', { class: 'ab-inner' },
      h('div', { class: 'ab-info' },
        h('button', { class: 'ab-count', type: 'button', onclick: () => showChanges(ch), 'aria-label': `ดูรายการ ${ch.length} การเปลี่ยนแปลง` },
          h('strong', null, `${ch.length} การเปลี่ยนแปลง`), h('span', { class: 'small' }, 'ดูรายการ')),
        nErr ? h('span', { class: 'ab-err' }, icon('warn'), `มีค่าที่ต้องแก้ ${nErr} จุด`) : null),
      h('div', { class: 'ab-btns' },
        h('button', { class: 'btn ghost', type: 'button', onclick: () => resetEdits() }, 'ยกเลิก'),
        h('button', { class: 'btn primary', type: 'button', disabled: nErr > 0, onclick: (e) => (B.readOnly ? downloadSet() : sendSettings(e.currentTarget)) },
          icon(B.readOnly ? 'download' : 'upload'), sendLabel))));
  }
  function resetEdits() {
    v = clone(baseVals);
    lotMode = lotsSame(v) ? 'same' : 'per';
    writeDraft(null);
    aiNote.hidden = true;
    onChange();
  }
  function changeList(ch) {
    return h('ul', { class: 'change-list' }, ch.map((c) => h('li', null,
      h('span', { class: 'cl-label' }, c.label), h('span', { class: 'cl-from' }, c.from || '—'), h('span', { class: 'cl-arrow', 'aria-hidden': 'true' }, '→'), h('span', { class: 'cl-to' }, c.to))));
  }
  function showChanges(ch) {
    openModal({ title: `สิ่งที่เปลี่ยน (${ch.length})`, body: changeList(ch), actions: [{ label: 'ปิด' }] });
  }

  async function sendSettings(btn) {
    const ch = changes();
    const errs = errors();
    if (Object.keys(errs).length) { toast('ยังมีค่าที่ต้องแก้ ดูข้อความสีแดงในแต่ละส่วน', 'error'); return; }
    const lim = limits(), r = st && st.remote;
    const warns = [];
    if (lim.allow_remote_params === false) {
      warns.push(callout('warn', 'เครื่องนี้ยังไม่อนุญาตให้เว็บเปลี่ยนค่า',
        h('p', null, `ในแอป Dobby ที่เครื่อง ${bot.name}: ตั้งค่า → ความปลอดภัย → ติ๊ก "ให้เว็บส่งการตั้งค่าให้ Dobby" ไม่อย่างนั้นเครื่องจะไม่ใช้ค่านี้`)));
    }
    if (r && r.params_enabled === false) warns.push(callout('warn', 'EA ยังไม่เปิดรับค่าจากเว็บ', h('p', null, `โหลดไฟล์ Dobby3_${runnerOk() ? 'v305' : 'v304'}_web.set ใน MT5 อีกครั้ง (แท็บ Inputs → Load) แล้วกด OK`)));
    if (!onlineInfo(bot, st).agentOnline) warns.push(callout('info', 'เครื่องออฟไลน์อยู่', h('p', null, 'ค่าจะถูกใช้เมื่อเครื่องกลับมาออนไลน์')));
    if (v.InpRunnerEnable && !baseVals.InpRunnerEnable) warns.push(callout('warn', 'กำลังเปิดโหมด runner', h('p', null, `${RUNNER_WARNING} มีผลกับไม้ที่เปิดหลังจากบอทรับค่า ไม้ที่เปิดอยู่ไม่เปลี่ยน`)));
    const open = st ? (st.positions || []).filter((p) => p.open).length : 0;
    const ok = await confirmDialog(`ส่งค่าใหม่ให้ ${bot.name}?`, h('div', { class: 'stack' },
      changeList(ch),
      h('p', { class: 'muted small' }, open ? `ตอนนี้มีไม้เปิดอยู่ ${open} ไม้ EA จะเปลี่ยนเป็นค่าใหม่เมื่อไม้ปิดแล้ว (ไม่ยุ่งกับไม้ที่เปิดอยู่)` : 'EA จะเปลี่ยนเป็นค่าใหม่ทันทีที่ได้รับ (เปลี่ยนตอนไม่มีไม้เปิดเท่านั้น)'),
      warns), { ok: 'ส่งให้บอท' });
    if (!ok) return;
    busy(btn, true, 'กำลังส่ง…');
    try {
      const params = toDesiredParams(v, { eaVersion: eaVer(), agentVersion: bot.agent_version });
      ctl = await patchDesired(bot.id, (d) => { d.params = params; });
      justSent = true;
      writeDraft(null);
      aiNote.hidden = true;
      B = computeBase();
      baseVals = clone(B.editBase);
      v = clone(B.editBase);
      lotMode = lotsSame(v) ? 'same' : 'per';
      onChange();
      drawNow(true);
      toast('ส่งค่าใหม่แล้ว ดูความคืบหน้าที่ "ค่าที่บอทใช้อยู่ตอนนี้"', 'good', 5000);
      nowBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) { busy(btn, false); toast(errText(e), 'error', 7000); }
  }

  // ---------------- presets and .set
  function fullPreset() {
    const base = st ? presetFromLive(st) : normalizeParams(defaults());
    const p = normalizeParams({ ...base, ...remoteSubset(v), InpAllowLive: false });
    if (B.readOnly) Object.assign(p, { InpRemoteParams: true, InpRemoteLive: true, InpRemoteMaxLots: 0.5, InpRemoteMaxCapPct: 10 });
    return p;
  }
  function downloadSet() {
    if (Object.keys(errors()).length) { toast('ยังมีค่าที่ต้องแก้ก่อนดาวน์โหลด', 'error'); return; }
    const p = fullPreset();
    const name = `${bot.name} ${new Date().toISOString().slice(0, 10)}`;
    const comments = [`Dobby3 settings for "${bot.name}" from Dobby Web ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
      summaryText(p, cur()),
      'InpAllowLive stays false. EA v3.03 on a REAL account: tick InpAllowLive = true in the Inputs tab before OK. EA v3.04+: the web live switch controls it (InpRemoteLive = true). The InpRunner* lines are read by EA v3.05 (older EAs ignore unknown keys).'];
    downloadBlob(setFileName(name), new Blob([buildSet(p, comments)], { type: 'application/octet-stream' }));
    toast('ดาวน์โหลดไฟล์ .set แล้ว นำไปโหลดใน MT5: คลิกขวาที่กราฟ → Expert list หรือดับเบิลคลิก EA → แท็บ Inputs → Load', 'good', 7000);
  }
  function savePresetDialog() {
    const nameIn = h('input', { class: 'input', type: 'text', maxlength: 100, value: `${bot.name} ${fmtThai(Date.now(), 'date')}` });
    const notesIn = h('input', { class: 'input', type: 'text', maxlength: 300, value: summaryText(v, cur()) });
    const fid = newId('sp');
    const err = h('p', { class: 'field-error', role: 'alert' });
    const m = openModal({
      title: 'บันทึกเป็นพรีเซ็ต',
      body: h('form', {
        id: fid, class: 'stack',
        onsubmit: async (e) => {
          e.preventDefault();
          const name = nameIn.value.trim();
          if (!name) { err.textContent = 'ตั้งชื่อพรีเซ็ต'; return; }
          const btn = m.foot.querySelector('button[type=submit]');
          busy(btn, true);
          try {
            await ctx.api.createPreset({ name, params: fullPreset(), notes: notesIn.value.trim() });
            m.close();
            toast(`บันทึกพรีเซ็ต "${name}" แล้ว ดูได้ที่ เพิ่มเติม → พรีเซ็ตที่บันทึกไว้`, 'good', 5000);
          } catch (ex) { busy(btn, false); err.textContent = errText(ex); }
        },
      }, h('p', { class: 'muted' }, 'เก็บค่าบนหน้าจอตอนนี้ไว้ใช้ทีหลัง หรือใช้กับบอทเครื่องอื่น'),
      field('ชื่อพรีเซ็ต', nameIn), field('บันทึกช่วยจำ', notesIn), err),
      actions: [{ label: 'ยกเลิก' }, { label: 'บันทึก', kind: 'primary', submit: true, form: fid, icon: 'save' }],
    });
    setTimeout(() => nameIn.select(), 30);
  }
  async function loadPresetDialog() {
    if (!editable()) return;
    const m = openModal({ title: 'โหลดจากพรีเซ็ตที่บันทึกไว้', body: loadingState(), actions: [{ label: 'ปิด' }], wide: true });
    let list = [];
    try { list = await ctx.api.listPresets(); } catch (e) { mount(m.body, errorState(e)); return; }
    if (!list.length) {
      mount(m.body, h('p', { class: 'muted' }, 'ยังไม่มีพรีเซ็ตที่บันทึกไว้ กด "บันทึกเป็นพรีเซ็ต" เพื่อเก็บค่าที่ใช้อยู่'));
      return;
    }
    mount(m.body, h('ul', { class: 'pick-list' }, list.map((p) => {
      const pv = normalizeParams(p.params);
      return h('li', null,
        h('div', { class: 'grow' }, h('p', { class: 'pick-name' }, p.name), h('p', { class: 'muted small' }, summaryText(pv, cur()))),
        h('button', { class: 'btn small primary', type: 'button', onclick: () => { applyPreset(p); m.close(); } }, 'ใช้ค่านี้'));
    })));
  }
  // A change the AI assistant proposed (SPEC 10.5): loaded as unsent edits, sent only with the normal confirm dialog.
  function applyAiProposal() {
    let p = null;
    try { p = JSON.parse(sessionStorage.getItem(PROPOSAL_KEY) || 'null'); sessionStorage.removeItem(PROPOSAL_KEY); } catch { p = null; }
    history.replaceState(null, '', '#/bot'); // a reload must not load it again
    if (!p) return;
    if (p.bot_id !== bot.id || !(Date.now() - Number(p.ts) < 3600e3)) { toast('ข้อเสนอนี้เก่าเกินไปหรือเป็นของบอทอื่น ถามผู้ช่วยใหม่อีกครั้ง', 'error', 6000); return; }
    if (!editable()) { toast('บอทนี้ยังรับค่าจากเว็บไม่ได้ จึงใช้ข้อเสนอนี้ไม่ได้', 'error', 6000); return; }
    const vals = {};
    let command = false;
    for (const c of Array.isArray(p.changes) ? p.changes : []) {
      if (c && isCommandKey(c.key)) { command = true; continue; } // cap_reset is a button on ภาพรวม, never a setting (SPEC 11)
      const def = PARAM_BY_KEY[c && c.key];
      if (!def || !def.remote) continue;
      if (unsupportedKeys(eaVer(), bot.agent_version).includes(c.key)) continue; // an older bot never gets runner / VWAP-tolerance keys
      const x = coerce(def, c.to);
      if (x !== undefined) vals[c.key] = x;
    }
    if (command) toast('การรีเซ็ตจุดหยุดรายวันไม่ใช่ค่าตั้งค่า ทำที่หน้าภาพรวม: แถบสีเหลือง "ถึงจุดหยุดรายวันแล้ว" กดปุ่ม "รีเซ็ตจุดหยุดรายวัน" แล้วยืนยัน', 'info', 9000);
    if (!Object.keys(vals).length) {
      if (command) { ctx.nav('#/dashboard'); return; }
      toast('ข้อเสนอนี้ไม่มีค่าที่เว็บเปลี่ยนให้ได้', 'error'); return;
    }
    v = normalizeParams({ ...v, ...vals });
    lotMode = lotsSame(v) ? 'same' : 'per';
    onChange();
    aiNote.replaceChildren(callout('info', 'ค่าที่ผู้ช่วย AI เสนอ',
      p.summary ? h('p', null, p.summary) : null,
      h('p', null, 'ยังไม่ได้ส่งให้บอท ตรวจรายการที่เปลี่ยนในแถบด้านล่าง แล้วกด "บันทึกและส่งให้บอท" ถ้าไม่ต้องการ กด "ยกเลิก"')));
    aiNote.hidden = false;
    aiNote.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function applyPreset(p) {
    const src = remoteSubset(normalizeParams(p.params));
    for (const k of unsupportedKeys(eaVer(), bot.agent_version)) delete src[k]; // an older bot keeps its (hidden) runner / VWAP-tolerance values
    v = normalizeParams({ ...v, ...src });
    lotMode = lotsSame(v) ? 'same' : 'per';
    onChange();
    toast(`โหลดค่าจาก "${p.name}" แล้ว ตรวจแล้วกด "บันทึกและส่งให้บอท"`, 'good', 5000);
  }

  // ---------------- sides (+ advanced control-file values)
  function drawSides(force) {
    const d = normDesired(ctl.desired);
    if (!changed('sides', [d.control, ctl.version, st && st.params && st.params.max_spread_input, limits().max_lots]) && force !== true) return;
    const sideVal = d.control.allow_long && d.control.allow_short ? 'both' : d.control.allow_long ? 'long' : d.control.allow_short ? 'short' : 'none';
    let sending = false;
    const seg = segmented({
      label: 'ฝั่งที่เข้าได้', wide: true, get: () => sideVal, disabled: () => sending || viewOnly,
      options: [{ value: 'both', label: 'ซื้อและขาย' }, { value: 'long', label: 'ซื้ออย่างเดียว' }, { value: 'short', label: 'ขายอย่างเดียว' }],
      set: async (val) => {
        if (val === sideVal || sending) return;
        sending = true; seg.update();
        try {
          ctl = await patchDesired(bot.id, (n) => { n.control.allow_long = val !== 'short'; n.control.allow_short = val !== 'long'; });
          toast(val === 'both' ? 'ให้เข้าได้ทั้งซื้อและขายแล้ว' : val === 'long' ? 'ให้เข้าเฉพาะฝั่งซื้อแล้ว' : 'ให้เข้าเฉพาะฝั่งขายแล้ว', 'good');
        } catch (e) { toast(errText(e), 'error', 6000); }
        sending = false;
        refreshAll();
      },
    });
    mount(sidesBox,
      h('div', { class: 'set-sec-head' }, h('h2', null, 'ฝั่งที่เข้าได้'), h('p', null, viewOnly ? 'ฝั่งที่บอทนี้เปิดไม้ได้' : 'เลือกแล้วส่งทันที ไม้ที่เปิดอยู่ไม่ถูกปิด')),
      h('div', { class: 'group' },
        h('div', { class: 'set-row' }, seg),
        sideVal === 'none' ? callout('warn', 'ปิดทั้งสองฝั่งอยู่', h('p', null, viewOnly ? 'บอทไม่เปิดไม้ใหม่' : 'บอทจะไม่เปิดไม้ใหม่ เลือก "ซื้อและขาย" เพื่อกลับมาปกติ')) : null,
        viewOnly ? controlReadOnly(d) : advancedControl(d)));
  }
  // control-file overrides as plain rows (viewOnly's bot)
  function controlReadOnly(d) {
    const c = d.control;
    const rows = [
      c.lots !== null ? ['ลดล็อตชั่วคราว', `${fmtNum(c.lots)} ล็อต`] : null,
      c.max_spread !== null ? ['สเปรดสูงสุด', `${fmtNum(c.max_spread)} $`] : null,
      c.note ? ['หมายเหตุ', c.note] : null,
    ].filter(Boolean);
    return rows.length ? h('dl', { class: 'kv' }, rows.map(([k, val]) => [h('dt', null, k), h('dd', null, val)])) : null;
  }
  function advancedControl(d) {
    const lim = limits();
    const capLots = minOf(st && st.params && st.params.max_lots, lim.max_lots, st && st.remote && st.remote.effective && st.remote.effective.InpMaxLots);
    const capSpread = st && st.params && Number.isFinite(st.params.max_spread_input) ? st.params.max_spread_input : null;
    const lotsIn = h('input', { class: 'input', type: 'number', inputmode: 'decimal', step: '0.01', min: '0.01', max: capLots ?? '', value: d.control.lots ?? '', placeholder: 'ตามค่าบอท' });
    const spreadIn = h('input', { class: 'input', type: 'number', inputmode: 'decimal', step: '0.05', min: '0.05', max: capSpread ?? '', value: d.control.max_spread ?? '', placeholder: 'ตามค่าบอท' });
    const noteIn = h('input', { class: 'input', type: 'text', maxlength: 120, value: d.control.note || '', placeholder: 'เช่น ข่าวแรงคืนนี้' });
    const err = h('p', { class: 'field-error', role: 'alert' });
    const save = h('button', { class: 'btn', type: 'submit' }, icon('check'), 'ส่งคำสั่งนี้');
    return h('details', { class: 'subpanel' }, h('summary', null, 'คำสั่งชั่วคราวขั้นสูง (ลดล็อต สเปรด หมายเหตุ)'),
      h('form', {
        class: 'stack',
        onsubmit: async (e) => {
          e.preventDefault();
          err.textContent = '';
          const num = (el) => (el.value.trim() === '' ? null : Number(el.value));
          const lots = num(lotsIn), spread = num(spreadIn);
          if (lots !== null && (!(lots >= 0.01) || (capLots !== null && lots > capLots + 1e-9))) { err.textContent = `ล็อตชั่วคราวต้องอยู่ระหว่าง 0.01 ถึง ${fmtNum(capLots)} (ลดได้อย่างเดียว)`; return; }
          if (spread !== null && (!(spread >= 0.05) || (capSpread !== null && spread > capSpread + 1e-9))) { err.textContent = `สเปรดต้องอยู่ระหว่าง 0.05 ถึง ${fmtNum(capSpread)} (ตั้งได้เข้มกว่าเท่านั้น)`; return; }
          busy(save, true, 'กำลังส่ง…');
          try {
            ctl = await patchDesired(bot.id, (n) => { n.control.lots = lots; n.control.max_spread = spread; n.control.note = noteIn.value.trim(); });
            toast('ส่งคำสั่งแล้ว รอเครื่องรับคำสั่ง', 'good');
            refreshAll();
          } catch (ex) { busy(save, false); err.textContent = errText(ex); }
        },
      },
      h('p', { class: 'hint' }, 'ใช้ไฟล์ควบคุม (ใช้ได้ทั้ง EA 3.03 และ 3.04) ปล่อยว่าง = ใช้ค่าของบอท'),
      h('div', { class: 'grid-2 tight' },
        field('ลดล็อตชั่วคราว', lotsIn, { hint: capLots !== null ? `ไม่เกิน ${fmtNum(capLots)}` : 'ลดได้อย่างเดียว' }),
        field('สเปรดสูงสุด ($)', spreadIn, { hint: capSpread !== null ? `ไม่เกิน ${fmtNum(capSpread)}` : 'ตั้งได้เข้มกว่าเท่านั้น' })),
      field('หมายเหตุ', noteIn, { hint: 'ไปอยู่ในบันทึกของ EA' }), err, save));
  }

  // ---------------- blackouts
  function drawBlackouts(force) {
    const d = normDesired(ctl.desired);
    if (!changed('bo', [d.blackouts, ctl.version, Math.floor(Date.now() / 60000)]) && force !== true) return;
    const now = Date.now();
    const list = d.blackouts.map((b) => ({ ...b, from: Date.parse(b.from_utc), to: Date.parse(b.to_utc) })).sort((a, b) => a.from - b.from);
    const past = list.filter((b) => b.to <= now);
    const item = (b) => {
      const state = b.to <= now ? 'ผ่านไปแล้ว' : b.from <= now ? 'กำลังงดอยู่' : until(b.from);
      const sameDay = fmtThai(b.from, 'date') === fmtThai(b.to, 'date');
      return h('li', { class: `bo ${b.to <= now ? 'past' : b.from <= now ? 'active' : ''}` },
        h('div', { class: 'bo-main' },
          h('p', { class: 'bo-time' }, `${fmtThai(b.from, 'short')} ถึง ${fmtThai(b.to, sameDay ? 'time' : 'short')} น.`),
          h('p', { class: 'muted small', title: `เวลาเซิร์ฟเวอร์ ${utcToServer(b.from, off())} ถึง ${utcToServer(b.to, off())}` }, b.label || 'ไม่มีชื่อ')),
        h('span', { class: `chip ${b.from <= now && b.to > now ? 'warn' : ''}` }, state),
        viewOnly ? null : h('button', { class: 'icon-btn', type: 'button', 'aria-label': `ลบช่วง ${fmtThai(b.from, 'short')}`, onclick: () => removeBo(b) }, icon('trash')));
    };
    const upcoming = news.filter((n) => NEWS_RE.test(n.name) && Date.parse(n.ts_utc) > now - 90 * MIN).slice(0, 12);
    const covered = (n) => { const t = Date.parse(n.ts_utc); return d.blackouts.some((x) => Date.parse(x.from_utc) <= t - 30 * MIN && Date.parse(x.to_utc) >= t + 90 * MIN); };
    const nextNews = upcoming.find((n) => !covered(n));
    const newsSel = h('select', { class: 'input select', 'aria-label': 'เลือกข่าว' },
      upcoming.length ? upcoming.map((n) => h('option', { value: String(n.id) }, `${n.name} ${fmtThai(Date.parse(n.ts_utc), 'short')}${covered(n) ? ' (งดไว้แล้ว)' : ''}`)) : h('option', { value: '' }, 'ไม่มีข่าวสำคัญที่จะถึง'));
    const fromIn = h('input', { class: 'input', type: 'datetime-local', value: utcToThaiInput(Math.ceil(now / (15 * MIN)) * 15 * MIN) });
    const toIn = h('input', { class: 'input', type: 'datetime-local', value: utcToThaiInput(Math.ceil(now / (15 * MIN)) * 15 * MIN + 2 * 3600e3) });
    const labelIn = h('input', { class: 'input', type: 'text', maxlength: 60, placeholder: 'เช่น ประชุม FOMC' });
    const err = h('p', { class: 'field-error', role: 'alert' });
    const serverHint = h('p', { class: 'hint' });
    const updHint = () => {
      const a = thaiInputToUtc(fromIn.value), b = thaiInputToUtc(toIn.value);
      serverHint.textContent = Number.isFinite(a) && Number.isFinite(b) ? `เวลาเซิร์ฟเวอร์ของโบรก: ${utcToServer(a, off())} ถึง ${utcToServer(b, off())}` : '';
    };
    fromIn.addEventListener('input', updHint); toIn.addEventListener('input', updHint); updHint();
    if (viewOnly) {
      mount(manualBox,
        h('div', { class: 'group' }, list.length ? h('ul', { class: 'bo-list' }, list.map(item)) : h('p', { class: 'muted group-note' }, 'ไม่มีช่วงงดเข้าไม้')));
      return;
    }
    mount(manualBox,
      h('div', { class: 'group' },
        setRow(h('p', { class: 'set-label' }, 'งดทันที'), [h('span', { class: 'hint' }, 'บอทไม่เปิดไม้ใหม่ 2 ชั่วโมงนับจากตอนนี้')],
          h('button', { class: 'btn', type: 'button', onclick: (e) => addBo(Date.now(), Date.now() + 2 * 3600e3, 'งดเข้าไม้ 2 ชม.', e.currentTarget) }, icon('clock'), 'งด 2 ชม.')),
        nextNews ? setRow(h('p', { class: 'set-label' }, 'ข่าวถัดไป'),
          [h('span', { class: 'hint' }, `${nextNews.name.replace(/\s*\(.*\)/, '')} ${fmtThai(Date.parse(nextNews.ts_utc), 'short')} น. งด 30 นาทีก่อนถึง 90 นาทีหลัง`)],
          h('button', {
            class: 'btn', type: 'button',
            onclick: (e) => addBo(Date.parse(nextNews.ts_utc) - 30 * MIN, Date.parse(nextNews.ts_utc) + 90 * MIN, nextNews.name, e.currentTarget),
          }, icon('news'), 'งดช่วงข่าวนี้')) : null,
      list.length ? h('ul', { class: 'bo-list' }, list.map(item)) : h('p', { class: 'muted group-note' }, 'ยังไม่มีช่วงงดเข้าไม้'),
      past.length ? h('div', { class: 'group-note' }, h('button', { class: 'btn small ghost', type: 'button', onclick: () => clearPast() }, icon('trash'), `ล้างช่วงที่ผ่านไปแล้ว (${past.length})`)) : null,
      h('details', { class: 'subpanel' }, h('summary', null, 'เลือกข่าวอื่น หรือกำหนดเวลาเอง'),
        h('div', { class: 'stack' },
          h('p', { class: 'small' }, 'งดช่วงข่าว (ก่อน 30 นาที หลัง 90 นาที)'),
          h('div', { class: 'row gap wrap' }, newsSel, h('button', {
            class: 'btn', type: 'button', disabled: !upcoming.length,
            onclick: (e) => { const n = upcoming.find((x) => String(x.id) === newsSel.value); if (n) addBo(Date.parse(n.ts_utc) - 30 * MIN, Date.parse(n.ts_utc) + 90 * MIN, n.name, e.currentTarget); },
          }, icon('plus'), 'เพิ่ม')),
          h('a', { class: 'small', href: '#/news' }, 'ดูปฏิทินข่าวทั้งหมด'),
          h('form', {
            class: 'stack',
            onsubmit: (e) => {
              e.preventDefault();
              err.textContent = '';
              const a = thaiInputToUtc(fromIn.value), b = thaiInputToUtc(toIn.value);
              if (!Number.isFinite(a) || !Number.isFinite(b)) { err.textContent = 'เลือกเวลาเริ่มและเวลาจบ'; return; }
              if (b <= a) { err.textContent = 'เวลาจบต้องหลังเวลาเริ่ม'; return; }
              if (b <= Date.now()) { err.textContent = 'ช่วงนี้ผ่านไปแล้ว'; return; }
              if (b - a > 7 * 864e5) { err.textContent = 'ช่วงเดียวยาวได้ไม่เกิน 7 วัน (ถ้าจะหยุดนานกว่านั้น ใช้ "หยุดชั่วคราว")'; return; }
              addBo(a, b, labelIn.value.trim() || 'กำหนดเอง', e.submitter);
            },
          },
          h('p', { class: 'small' }, 'กำหนดเอง (เวลาไทย)'),
          h('div', { class: 'grid-2 tight' }, field('เริ่ม', fromIn), field('จบ', toIn)), serverHint,
          field('ชื่อ', labelIn), err,
          h('button', { class: 'btn', type: 'submit' }, icon('plus'), 'เพิ่มช่วงนี้'))))));
  }
  async function addBo(from, to, label, btn) {
    busy(btn, true);
    try {
      ctl = await patchDesired(bot.id, (d) => {
        d.blackouts = d.blackouts.filter((b) => Date.parse(b.to_utc) > Date.now());
        d.blackouts.push({ from_utc: isoUtc(from), to_utc: isoUtc(to), label });
        d.blackouts.sort((a, b) => a.from_utc.localeCompare(b.from_utc));
      });
      toast(`งดเข้าไม้ ${fmtThai(from, 'short')} ถึง ${fmtThai(to, 'time')} น. แล้ว`, 'good');
      refreshAll();
    } catch (e) { busy(btn, false); toast(errText(e), 'error', 6000); }
  }
  async function removeBo(b) {
    try {
      ctl = await patchDesired(bot.id, (d) => { d.blackouts = d.blackouts.filter((x) => !(x.from_utc === b.from_utc && x.to_utc === b.to_utc)); });
      toast('ลบช่วงงดเข้าไม้แล้ว', 'good');
      refreshAll();
    } catch (e) { toast(errText(e), 'error', 6000); }
  }
  async function clearPast() {
    try { ctl = await patchDesired(bot.id, (d) => { d.blackouts = d.blackouts.filter((x) => Date.parse(x.to_utc) > Date.now()); }); refreshAll(); }
    catch (e) { toast(errText(e), 'error', 6000); }
  }

  // ---------------- refresh on new data
  function resync() {
    const prev = JSON.stringify(baseVals);
    const wasDirty = changes().length > 0;
    const roBefore = B.readOnly;
    B = computeBase();
    // the editor's shape changed: read-only flipped, or the bot's EA version crossed 3.05 (the runner section)
    if (B.readOnly !== roBefore || runnerOk() !== runnerBuilt) { baseVals = clone(B.editBase); v = clone(B.editBase); buildEditor(); return; }
    if (JSON.stringify(B.editBase) !== prev) {
      baseVals = clone(B.editBase);
      if (!wasDirty) { v = clone(B.editBase); lotMode = lotsSame(v) ? 'same' : 'per'; }
      onChange();
    } else if (moneyOf() !== moneyKey) { moneyKey = moneyOf(); onChange(); }
  }
  function refreshAll() { resync(); drawHead(); drawNow(); drawLive(); drawPause(); drawSides(); drawBlackouts(); auto.update(); drawBar(); }

  drawHead(); drawNow(true); drawLive(true); drawPause(true); buildEditor(); drawSides(true); drawBlackouts(true); drawBar();
  const presetId = viewOnly ? null : ctx.query.get('preset');
  if (presetId && editable()) {
    ctx.api.listPresets().then((list) => { const p = list.find((x) => x.id === presetId); if (p) applyPreset(p); }).catch(() => {});
  }
  editorBox.before(aiNote);
  if (!other && ctx.query.get('ai') === '1') applyAiProposal(); // the AI proposes for the asker's own bot only

  // fresh rows before the head badge can say "offline": a phone that froze the page, or a realtime socket that died
  // quietly, leaves last_seen ageing with nothing new coming in (the same rule as ภาพรวม)
  let lastSync = Date.now(), syncing = false;
  const heard = (fn) => (row) => { lastSync = Date.now(); fn(row); };
  async function reload() {
    if (syncing) return;
    syncing = true;
    try {
      const [s, c, bots] = await Promise.all([ctx.api.botStatus(bot.id), ctx.api.botControl(bot.id), other ? ctx.api.adminBots() : ctx.api.listBots()]);
      const b = bots.find((x) => x.id === bot.id);
      if (b) { bot = { ...bot, ...b }; updateBotRow(bot); }
      if (s) st = s.status;
      if (c) ctl = c;
      lastSync = Date.now();
      refreshAll();
    } catch { /* keep the last data */ }
    syncing = false;
  }
  const unsub = ctx.api.subscribeBot(bot.id, {
    status: heard((row) => { if (!row || !row.status) return; st = row.status; resync(); drawHead(); drawNow(); drawLive(); }),
    control: heard((row) => { ctl = row; refreshAll(); }),
    bot: heard((row) => { bot = { ...bot, ...row }; updateBotRow(bot); resync(); drawHead(); drawNow(); drawLive(); drawPause(); auto.update(); }),
  });
  const offCtl = on('control-updated', (row) => { if (row && row.bot_id === bot.id) { ctl = row; refreshAll(); } });
  const tick = setInterval(() => {
    if (document.hidden || syncing) return;
    if (Date.now() - lastSync > 20000) { reload(); return; }
    drawHead(); drawBlackouts(); auto.update();
  }, 15000);
  const poll = setInterval(reload, 30000);
  const offWake = onWake(() => { if (Date.now() - lastSync > 5000) reload(); });
  // Unsent edits are kept as a session draft and restored on return (no "Leave site?" prompt).
  return () => {
    unsub(); offCtl(); offWake(); clearInterval(tick); clearInterval(poll);
    window.removeEventListener('scroll', onScroll);
    document.body.classList.remove('has-action-bar');
  };
}
