// Presets: list / create (template, .set import, live values) / duplicate / delete, grouped editor of every EA input
// with validation, diff vs live, .set export, "Apply to bot" (remote keys only), and the lot calculator (#/calc).
import { h, mount, icon, fmtNum, fmtSigned, fmtPct, fmtThai, toast, errText, confirmDialog, openModal, errorState, loadingState,
  emptyState, field, busy, downloadBlob, callout, newId, debounce } from '../util.js';
import { app, currentBot } from '../state.js';
import { GROUPS, PARAMS, PARAM_BY_KEY, REMOTE_KEYS, TEMPLATES, templateParams, normalizeParams, validatePreset, validateRemote,
  liveValuesFromStatus, presetFromLive, remoteSubset, formatValue, sameValue, minutesToClock, defaults } from '../params.js';
import { parseSet, buildSet, setFileName } from '../setfile.js';
import { patchDesired, cmdBlock, normDesired } from '../botctl.js';
import { calculate, tableForBalance, HORIZON30, DAILY_BASE, BASE_BALANCE, BASE_LOT } from '../lotcalc.js';
import { panel, pageHead } from '../views.js';

function tabs(active) {
  return h('nav', { class: 'segmented wide', 'aria-label': 'พรีเซ็ตและเครื่องคำนวณ' },
    h('a', { href: '#/presets', class: active === 'presets' ? 'on' : '', 'aria-current': active === 'presets' ? 'page' : null }, icon('doc'), 'พรีเซ็ต'),
    h('a', { href: '#/calc', class: active === 'calc' ? 'on' : '', 'aria-current': active === 'calc' ? 'page' : null }, icon('calc'), 'คำนวณล็อต'));
}

async function botStatus(ctx) {
  const bot = currentBot();
  if (!bot) return { bot: null, st: null };
  try { const s = await ctx.api.botStatus(bot.id); return { bot, st: s ? s.status : null }; } catch { return { bot, st: null }; }
}

export async function render(root, ctx) {
  if (ctx.parts[0]) return renderEditor(root, ctx, ctx.parts[0]);
  return renderList(root, ctx);
}

// ------------------------------------------------------------------ list
async function renderList(root, ctx) {
  root.append(pageHead('พรีเซ็ต', 'ชุดค่า Inputs ของ EA เก็บไว้ ส่งออกเป็น .set หรือส่งค่าที่ส่งได้ไปที่บอท'), tabs('presets'));
  const listBox = h('div');
  const createBox = h('div');
  root.append(createBox, listBox);
  listBox.append(loadingState());
  let presets = [], bot = null, st = null;
  try {
    [presets, { bot, st }] = await Promise.all([ctx.api.listPresets(), botStatus(ctx)]);
  } catch (e) { listBox.replaceChildren(errorState(e, () => ctx.route())); return; }

  // create
  const tplSel = h('select', { class: 'input select', 'aria-label': 'แม่แบบ' }, TEMPLATES.map((t) => h('option', { value: t.id }, t.name)));
  const tplNote = h('p', { class: 'hint' }, TEMPLATES[0].note);
  tplSel.addEventListener('change', () => { tplNote.textContent = (TEMPLATES.find((t) => t.id === tplSel.value) || {}).note || ''; });
  const fileIn = h('input', { type: 'file', accept: '.set,text/plain', class: 'sr-only', id: newId('set') });
  fileIn.addEventListener('change', () => { if (fileIn.files[0]) importSet(ctx, fileIn.files[0]); fileIn.value = ''; });
  createBox.append(panel('สร้างพรีเซ็ตใหม่', {},
    h('div', { class: 'create-grid' },
      h('div', { class: 'create-opt' }, h('h3', null, 'จากแม่แบบ'), tplSel, tplNote,
        h('button', { class: 'btn primary', type: 'button', onclick: (e) => fromTemplate(ctx, tplSel.value, e.currentTarget) }, icon('plus'), 'สร้างจากแม่แบบ')),
      h('div', { class: 'create-opt' }, h('h3', null, 'นำเข้าไฟล์ .set'),
        h('p', { class: 'hint' }, 'ไฟล์ที่บันทึกจากหน้า Inputs ของ MT5 (รองรับ UTF-16 และ UTF-8)'),
        h('label', { class: 'btn', for: fileIn.id, tabindex: '0', onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileIn.click(); } } }, icon('upload'), 'เลือกไฟล์ .set'), fileIn),
      h('div', { class: 'create-opt' }, h('h3', null, 'จากค่าที่บอทใช้อยู่'),
        h('p', { class: 'hint' }, bot ? (st ? (st.remote ? `${bot.name}: EA v3.04 รายงานค่าครบทุกค่าที่ส่งได้` : `${bot.name}: EA รายงานแค่บางค่า ที่เหลือใช้ค่าเริ่มต้นของ EA`) : `${bot.name}: ยังไม่มีสถานะ`) : 'ยังไม่มีบอท'),
        h('button', { class: 'btn', type: 'button', disabled: !st, onclick: (e) => fromLive(ctx, bot, st, e.currentTarget) }, icon('download'), 'สร้างจากบอท')))));

  const draw = () => {
    if (!presets.length) {
      listBox.replaceChildren(emptyState('ยังไม่มีพรีเซ็ต', 'เริ่มจากแม่แบบด้านบน หรือนำเข้าไฟล์ .set ที่มีอยู่'));
      return;
    }
    listBox.replaceChildren(panel(`พรีเซ็ตของฉัน (${presets.length})`, {},
      h('ul', { class: 'preset-list' }, presets.map((p) => {
        const v = normalizeParams(p.params);
        const { errors } = validatePreset(v);
        const lots = [...new Set([v.InpLotsA, v.InpLotsNY, v.InpLotsC5G])];
        return h('li', { class: 'preset' },
          h('div', { class: 'preset-main' },
            h('a', { class: 'preset-name', href: `#/presets/${encodeURIComponent(p.id)}` }, p.name),
            p.notes ? h('p', { class: 'muted small' }, p.notes) : null,
            h('div', { class: 'chips' },
              h('span', { class: 'chip' }, `ล็อต ${lots.map((x) => fmtNum(x)).join('/')}`),
              h('span', { class: 'chip' }, `ทุนจำลอง ${fmtNum(v.InpVirtualStart, 0)}`),
              h('span', { class: 'chip' }, v.InpLockEnable ? `ล็อก ${fmtNum(v.InpLockAtPct, 0)}→${fmtNum(v.InpLockToPct, 0)}` : 'ไม่ล็อกกำไร'),
              v.InpLock1Enable ? h('span', { class: 'chip' }, `ขั้น 1 ${fmtNum(v.InpLock1AtPct, 0)}→${fmtNum(v.InpLock1ToPct, 0)}`) : null,
              v.InpAllowLive ? h('span', { class: 'chip warn' }, icon('warn'), 'InpAllowLive = true') : null,
              Object.keys(errors).length ? h('span', { class: 'chip bad' }, icon('warn'), `ค่าไม่ถูกต้อง ${Object.keys(errors).length}`) : null),
            h('p', { class: 'muted small' }, `แก้ไขล่าสุด ${fmtThai(Date.parse(p.updated_at || p.created_at), 'short')}`)),
          h('div', { class: 'preset-actions' },
            h('a', { class: 'btn small', href: `#/presets/${encodeURIComponent(p.id)}` }, icon('edit'), 'แก้ไข'),
            h('button', { class: 'btn small', type: 'button', onclick: () => exportSet(p.name, v, p.notes) }, icon('download'), '.set'),
            h('button', {
              class: 'btn small', type: 'button',
              onclick: async (e) => { busy(e.currentTarget, true); try { const n = await ctx.api.createPreset({ name: `${p.name} (สำเนา)`.slice(0, 100), params: v, notes: p.notes }); presets.unshift(n); draw(); toast('ทำสำเนาแล้ว', 'good'); } catch (ex) { busy(e.currentTarget, false); toast(errText(ex), 'error'); } },
            }, icon('copy'), 'ทำสำเนา'),
            h('button', {
              class: 'btn small ghost danger-text', type: 'button', 'aria-label': `ลบ ${p.name}`,
              onclick: async () => {
                const ok = await confirmDialog(`ลบพรีเซ็ต "${p.name}"?`, 'ลบแล้วกู้คืนไม่ได้ (ไม่กระทบบอทที่รันอยู่)', { ok: 'ลบ', danger: true });
                if (!ok) return;
                try { await ctx.api.deletePreset(p.id); presets = presets.filter((x) => x.id !== p.id); draw(); toast('ลบแล้ว', 'good'); } catch (ex) { toast(errText(ex), 'error'); }
              },
            }, icon('trash'), 'ลบ')));
      }))));
  };
  draw();
}

async function fromTemplate(ctx, id, btn) {
  const t = TEMPLATES.find((x) => x.id === id) || TEMPLATES[0];
  busy(btn, true);
  try {
    const row = await ctx.api.createPreset({ name: t.name, params: templateParams(t.id), notes: t.note });
    ctx.nav(`#/presets/${encodeURIComponent(row.id)}`);
  } catch (e) { busy(btn, false); toast(errText(e), 'error'); }
}

async function fromLive(ctx, bot, st, btn) {
  busy(btn, true);
  try {
    const { source, values } = liveValuesFromStatus(st);
    const missing = PARAMS.filter((p) => !(p.key in values)).length;
    const row = await ctx.api.createPreset({
      name: `ค่าปัจจุบันของ ${bot.name} ${fmtThai(Date.now(), 'date')}`.slice(0, 100),
      params: presetFromLive(st),
      notes: source === 'remote.effective' ? `จากสถานะ EA (remote.effective) ค่าที่ไม่รายงาน ${missing} ค่าใช้ค่าเริ่มต้นของ EA` : `จากสถานะ EA (schema ${st.schema_version}) ค่าที่ไม่รายงาน ${missing} ค่าใช้ค่าเริ่มต้นของ EA ตรวจก่อนใช้`,
    });
    ctx.nav(`#/presets/${encodeURIComponent(row.id)}`);
  } catch (e) { busy(btn, false); toast(errText(e), 'error'); }
}

async function importSet(ctx, file) {
  let parsed;
  try {
    if (file.size > 512 * 1024) throw new Error('ไฟล์ใหญ่เกินไปสำหรับไฟล์ .set');
    parsed = parseSet(await file.arrayBuffer());
  } catch (e) { toast(`อ่านไฟล์ไม่ได้: ${errText(e)}`, 'error', 6000); return; }
  if (!parsed.found.length) { toast('ไม่พบค่า Inputs ของ Dobby3 ในไฟล์นี้', 'error', 6000); return; }
  const nameIn = h('input', { class: 'input', type: 'text', maxlength: 100, value: file.name.replace(/\.set$/i, '') });
  const { errors } = validatePreset(parsed.params);
  const body = h('div', { class: 'stack' },
    h('p', null, `พบ ${parsed.found.length} ค่าจาก ${PARAMS.length} ค่า`),
    parsed.missing.length ? callout('info', `ไม่มีในไฟล์ ${parsed.missing.length} ค่า ใช้ค่าเริ่มต้นของ EA`, h('p', { class: 'small mono-list' }, parsed.missing.join(', '))) : null,
    parsed.unknown.length ? callout('warn', `ไม่รู้จัก ${parsed.unknown.length} ค่า (ข้ามไป)`, h('p', { class: 'small mono-list' }, parsed.unknown.map((u) => u.key).join(', '))) : null,
    parsed.invalid.length ? callout('warn', `อ่านค่าไม่ได้ ${parsed.invalid.length} ค่า (ใช้ค่าเริ่มต้น)`, h('p', { class: 'small mono-list' }, parsed.invalid.map((u) => `${u.key}=${u.value}`).join(', '))) : null,
    Object.keys(errors).length ? callout('warn', `ค่าเกินขอบเขต ${Object.keys(errors).length} ค่า แก้ได้ในหน้าถัดไป`, h('p', { class: 'small mono-list' }, Object.keys(errors).join(', '))) : null,
    parsed.params.InpAllowLive ? callout('warn', 'ไฟล์นี้ตั้ง InpAllowLive = true', h('p', null, 'พรีเซ็ตที่โหลดแล้วเทรดบัญชีจริงทันที ตรวจก่อนใช้')) : null,
    field('ชื่อพรีเซ็ต', nameIn));
  openModal({
    title: 'นำเข้าไฟล์ .set', body,
    actions: [{ label: 'ยกเลิก' }, {
      label: 'นำเข้า', kind: 'primary', onClick: async (close) => {
        try {
          const row = await ctx.api.createPreset({ name: nameIn.value.trim() || file.name, params: parsed.params, notes: parsed.comments.slice(0, 4).join(' ').slice(0, 500) || `นำเข้าจาก ${file.name}` });
          close();
          ctx.nav(`#/presets/${encodeURIComponent(row.id)}`);
        } catch (e) { toast(errText(e), 'error'); }
      },
    }],
  });
}

function exportSet(name, params, notes) {
  const comments = [`Dobby3 preset "${name}" exported from Dobby Web ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`];
  if (notes) comments.push(String(notes).slice(0, 300));
  comments.push(params.InpAllowLive ? 'InpAllowLive = true: this preset trades a REAL account as soon as it is loaded.' : 'InpAllowLive stays false: switch live trading on by hand.');
  downloadBlob(setFileName(name), new Blob([buildSet(params, comments)], { type: 'application/octet-stream' }));
  toast('ส่งออกไฟล์ .set แล้ว', 'good');
}

// ------------------------------------------------------------------ editor
async function renderEditor(root, ctx, id) {
  root.append(loadingState());
  let preset, bot, st, ctl = null;
  try {
    const list = await ctx.api.listPresets();
    preset = list.find((p) => p.id === id);
    ({ bot, st } = await botStatus(ctx));
    if (bot) ctl = await ctx.api.botControl(bot.id).catch(() => null);
  } catch (e) { root.replaceChildren(errorState(e, () => ctx.route())); return; }
  root.replaceChildren();
  if (!preset) { root.append(emptyState('ไม่พบพรีเซ็ตนี้', 'อาจถูกลบไปแล้ว', h('a', { class: 'btn', href: '#/presets' }, 'กลับไปหน้าพรีเซ็ต'))); return; }

  const v = normalizeParams(preset.params);
  const saved = JSON.stringify(v);
  let showAdv = false, onlyDiff = false;
  const live = liveValuesFromStatus(st);
  const nameIn = h('input', { class: 'input title-input', type: 'text', maxlength: 100, value: preset.name, 'aria-label': 'ชื่อพรีเซ็ต' });
  const notesIn = h('textarea', { class: 'input', rows: 2, maxlength: 500, 'aria-label': 'บันทึก' }, preset.notes || '');
  const summary = h('div', { 'aria-live': 'polite' });
  const groupsBox = h('div', { class: 'groups' });
  const diffBox = h('div');
  const saveBtn = h('button', { class: 'btn primary', type: 'button', onclick: () => save() }, icon('check'), 'บันทึก');
  const exportBtn = h('button', { class: 'btn', type: 'button', onclick: () => exportSet(nameIn.value.trim() || preset.name, v, notesIn.value) }, icon('download'), 'ส่งออก .set');
  const applyBtn = h('button', { class: 'btn', type: 'button', disabled: !bot, onclick: () => applyToBot() }, icon('upload'), bot ? `ส่งไปที่ ${bot.name}` : 'ส่งไปที่บอท');
  const advIn = h('input', { type: 'checkbox', onchange: () => { showAdv = advIn.checked; drawGroups(); } });
  const diffIn = h('input', { type: 'checkbox', onchange: () => { onlyDiff = diffIn.checked; drawGroups(); }, disabled: live.source === 'none' });

  root.append(
    h('div', { class: 'editor-head' },
      h('a', { class: 'back', href: '#/presets' }, '‹ พรีเซ็ตทั้งหมด'),
      nameIn, notesIn,
      h('div', { class: 'toolbar' }, saveBtn, exportBtn, applyBtn,
        h('button', {
          class: 'btn ghost', type: 'button',
          onclick: async (e) => { busy(e.currentTarget, true); try { const n = await ctx.api.createPreset({ name: `${nameIn.value.trim() || preset.name} (สำเนา)`.slice(0, 100), params: v, notes: notesIn.value }); ctx.nav(`#/presets/${encodeURIComponent(n.id)}`); } catch (ex) { busy(e.currentTarget, false); toast(errText(ex), 'error'); } },
        }, icon('copy'), 'ทำสำเนา')),
      h('div', { class: 'row gap wrap' },
        h('label', { class: 'check' }, advIn, 'แสดงค่าขั้นสูง'),
        h('label', { class: 'check' }, diffIn, bot ? `เฉพาะค่าที่ต่างจาก ${bot.name}` : 'เฉพาะค่าที่ต่างจากบอท'))),
    summary, h('div', { class: 'editor-grid' }, groupsBox, diffBox));

  const isDirty = () => JSON.stringify(v) !== saved || nameIn.value.trim() !== preset.name || (notesIn.value || '') !== (preset.notes || '');
  nameIn.addEventListener('input', () => drawSummary());
  notesIn.addEventListener('input', () => drawSummary());

  function drawSummary() {
    const { errors, warnings } = validatePreset(v);
    const ne = Object.keys(errors).length, nw = Object.keys(warnings).length;
    saveBtn.disabled = ne > 0 || !isDirty() || !nameIn.value.trim();
    exportBtn.disabled = ne > 0;
    applyBtn.disabled = ne > 0 || !bot;
    mount(summary,
      ne ? callout('critical', `ค่าไม่ถูกต้อง ${ne} ค่า`, h('p', null, 'แก้ให้ถูกก่อนบันทึก ส่งออก หรือส่งไปที่บอท: ', Object.keys(errors).map((k, i) => [i ? ', ' : '', h('a', { href: `#f-${k}`, onclick: (e) => { e.preventDefault(); focusKey(k); } }, k)]))) : null,
      !ne && nw ? callout('warn', `คำเตือน ${nw} ข้อ`, h('ul', { class: 'plain' }, Object.entries(warnings).map(([k, m]) => h('li', null, h('code', null, k), ` ${m}`)))) : null,
      isDirty() ? h('p', { class: 'muted small' }, 'มีการแก้ไขที่ยังไม่บันทึก') : null);
  }

  function focusKey(k) {
    const p = PARAM_BY_KEY[k];
    if (p && p.advanced && !showAdv) { showAdv = true; advIn.checked = true; drawGroups(); }
    if (onlyDiff) { onlyDiff = false; diffIn.checked = false; drawGroups(); }
    const el = document.getElementById(`f-${k}`);
    if (el) { el.scrollIntoView({ block: 'center' }); el.focus(); }
  }

  function inputFor(p) {
    const idf = `f-${p.key}`;
    if (p.type === 'bool') {
      return h('input', { id: idf, type: 'checkbox', class: 'toggle', role: 'switch', checked: !!v[p.key], onchange: (e) => { v[p.key] = e.target.checked; changed(p.key); } });
    }
    return h('input', {
      id: idf, class: 'input num-in', type: 'number', inputmode: p.type === 'double' ? 'decimal' : 'numeric', step: String(p.step || 1),
      min: String(p.min), max: String(p.max), value: String(v[p.key]),
      oninput: (e) => { const n = e.target.value === '' ? NaN : Number(e.target.value); v[p.key] = Number.isFinite(n) ? (p.type === 'double' ? n : Math.round(n)) : NaN; changedSoon(p.key); },
    });
  }
  const changedSoon = debounce((k) => changed(k), 250);
  function changed() { drawSummary(); refreshFieldStates(); drawDiff(); }

  const fieldEls = {};
  function drawGroups() {
    const { errors, warnings } = validatePreset(v);
    groupsBox.replaceChildren(...GROUPS.map((g) => {
      const ps = PARAMS.filter((p) => p.group === g.id && (showAdv || !p.advanced || errors[p.key])
        && (!onlyDiff || (p.key in live.values && !sameValue(live.values[p.key], v[p.key]))));
      if (!ps.length) return null;
      return h('section', { class: 'pgroup', 'aria-label': g.title },
        h('h2', null, g.title, h('span', { class: 'muted small' }, ` ${g.en}`)),
        g.id === 'remote' ? h('p', { class: 'hint' }, 'ค่าเหล่านี้ตั้งที่เครื่องเท่านั้น (ใน .set) เว็บเปลี่ยนไม่ได้ ใช้กับ EA v3.04') : null,
        h('div', { class: 'pfields' }, ps.map((p) => {
          const lv = live.values[p.key];
          const diff = lv !== undefined && !sameValue(lv, v[p.key]);
          const box = h('div', { class: `pfield${p.type === 'bool' ? ' is-bool' : ''}${diff ? ' differs' : ''}${errors[p.key] ? ' has-error' : ''}` },
            h('div', { class: 'pf-head' },
              h('label', { for: `f-${p.key}` }, p.label),
              h('code', { class: 'pf-key' }, p.key),
              p.remote ? h('span', { class: 'tag remote', title: 'ส่งค่านี้ไปที่ EA v3.04 จากเว็บได้' }, 'ส่งจากเว็บได้') : h('span', { class: 'tag local', title: 'ต้องโหลด .set ที่เครื่อง' }, 'โหลด .set')),
            h('div', { class: 'pf-input' }, inputFor(p), p.minutes ? h('span', { class: 'muted small pf-clock' }, `= ${minutesToClock(v[p.key] || 0)} เวลาเซิร์ฟเวอร์`) : null),
            h('p', { class: 'hint' }, p.help, p.type !== 'bool' ? ` (${formatValue(p, p.min)} ถึง ${formatValue(p, p.max)}, ค่าเริ่มต้น ${formatValue(p, p.def)})` : ` (ค่าเริ่มต้น ${p.def ? 'true' : 'false'})`),
            h('p', { class: 'pf-live' }, lv !== undefined ? `บอทใช้: ${formatValue(p, lv)}` : ''),
            h('p', { class: 'field-error' }, errors[p.key] || ''),
            h('p', { class: 'field-warn' }, warnings[p.key] || ''));
          fieldEls[p.key] = box;
          return box;
        })));
    }).filter(Boolean));
    if (!groupsBox.children.length) groupsBox.append(emptyState('ไม่มีค่าที่ต่างจากบอท', 'พรีเซ็ตนี้ตรงกับค่าที่บอทรายงาน'));
  }

  function refreshFieldStates() {
    const { errors, warnings } = validatePreset(v);
    for (const [k, box] of Object.entries(fieldEls)) {
      if (!box.isConnected) continue;
      const p = PARAM_BY_KEY[k];
      const lv = live.values[k];
      box.classList.toggle('has-error', !!errors[k]);
      box.classList.toggle('differs', lv !== undefined && !sameValue(lv, v[k]));
      box.querySelector('.field-error').textContent = errors[k] || '';
      box.querySelector('.field-warn').textContent = warnings[k] || '';
      const clock = box.querySelector('.pf-clock');
      if (clock && p.minutes) clock.textContent = `= ${minutesToClock(Number.isFinite(v[k]) ? v[k] : 0)} เวลาเซิร์ฟเวอร์`;
    }
  }

  function drawDiff() {
    if (!bot) { diffBox.replaceChildren(panel('เทียบกับบอท', { cls: 'diff-panel' }, h('p', { class: 'muted' }, 'ยังไม่มีบอทให้เทียบ'))); return; }
    if (live.source === 'none') { diffBox.replaceChildren(panel('เทียบกับบอท', { cls: 'diff-panel' }, h('p', { class: 'muted' }, `${bot.name} ยังไม่มีสถานะ`))); return; }
    const keys = PARAMS.filter((p) => p.key in live.values && !sameValue(live.values[p.key], v[p.key]));
    const unknown = PARAMS.length - Object.keys(live.values).length;
    diffBox.replaceChildren(panel(`ต่างจาก ${bot.name} ${keys.length} ค่า`, {
      cls: 'diff-panel',
      sub: live.source === 'remote.effective' ? 'เทียบกับค่าที่ EA ใช้จริง (status.remote.effective)' : `เทียบกับค่าที่ EA รายงาน (ไม่ทราบ ${unknown} ค่า)`,
    },
    keys.length ? h('table', { class: 'diff' },
      h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'ค่า'), h('th', { scope: 'col' }, 'บอท'), h('th', { scope: 'col' }, 'พรีเซ็ต'))),
      h('tbody', null, keys.map((p) => h('tr', null,
        h('td', null, h('a', { href: `#f-${p.key}`, onclick: (e) => { e.preventDefault(); focusKey(p.key); } }, p.key), p.remote ? null : h('span', { class: 'tag local' }, '.set')),
        h('td', { class: 'num' }, formatValue(p, live.values[p.key])), h('td', { class: 'num' }, formatValue(p, v[p.key]))))))
      : h('p', { class: 'muted' }, 'ตรงกับบอททุกค่าที่รู้')));
  }

  async function save() {
    const name = nameIn.value.trim();
    if (!name) { toast('ใส่ชื่อพรีเซ็ต', 'error'); return; }
    busy(saveBtn, true, 'กำลังบันทึก…');
    try {
      preset = await ctx.api.updatePreset(preset.id, { name, params: v, notes: notesIn.value.trim() || null });
      toast('บันทึกแล้ว', 'good');
      ctx.route();
    } catch (e) { busy(saveBtn, false); toast(errText(e), 'error'); }
  }

  async function applyToBot() {
    const { errors } = validatePreset(v);
    if (Object.keys(errors).length) return;
    const lim = (bot.agent_state && bot.agent_state.limits) || {};
    const r = st && st.remote;
    const minOf = (...xs) => { const n = xs.filter((x) => Number.isFinite(Number(x)) && x !== null).map(Number); return n.length ? Math.min(...n) : undefined; };
    const ceil = { maxLots: minOf(r && r.ceilings && r.ceilings.max_lots, lim.max_lots), maxCapPct: minOf(r && r.ceilings && r.ceilings.max_cap_pct, lim.max_daily_cap_pct) };
    const rErrors = validateRemote(v, ceil);
    const remote = remoteSubset(v);
    const remoteChanges = REMOTE_KEYS.filter((k) => !(k in live.values) || !sameValue(live.values[k], v[k]));
    const def = defaults();
    const localChanges = PARAMS.filter((p) => !p.remote && !(p.key === 'InpAllowLive') && (p.key in live.values ? !sameValue(live.values[p.key], v[p.key]) : !sameValue(def[p.key], v[p.key])));
    const warn = [];
    if (!r) warn.push(callout('warn', 'EA บนเครื่องนี้ยังไม่ใช่ v3.04', h('p', null, 'เอเจนต์จะปฏิเสธหรือ EA จะไม่อ่านค่า อัปเดต EA เป็น v3.04 จากหน้าดาวน์โหลดก่อน')));
    else if (!r.params_enabled) warn.push(callout('warn', 'EA ยังไม่รับค่าจากเว็บ', h('p', null, 'ตั้ง InpRemoteParams = true ใน Inputs ของ EA ที่เครื่อง')));
    if (lim.allow_remote_params === false) warn.push(callout('warn', 'เครื่องนี้ไม่อนุญาตให้ส่งพรีเซ็ตจากเว็บ', h('p', null, 'รันคำสั่งนี้ที่เครื่องก่อน:'), cmdBlock('python dobby_agent.py limits --allow-params on')));
    const body = h('div', { class: 'stack' },
      rErrors.length ? callout('critical', 'ส่งไม่ได้: เกินขอบเขตที่ส่งจากเว็บได้', h('ul', { class: 'plain' }, rErrors.map((e) => h('li', null, h('code', null, e.key), ` ${e.msg}`)))) : null,
      ...warn,
      h('h3', null, `ค่าที่ส่งจากเว็บ (${remoteChanges.length} ค่าที่เปลี่ยน)`),
      remoteChanges.length ? h('table', { class: 'diff' }, h('tbody', null, remoteChanges.map((k) => h('tr', null,
        h('td', null, h('code', null, k)), h('td', { class: 'num' }, k in live.values ? formatValue(PARAM_BY_KEY[k], live.values[k]) : '?'),
        h('td', { 'aria-hidden': 'true' }, '→'), h('td', { class: 'num' }, formatValue(PARAM_BY_KEY[k], v[k]))))))
        : h('p', { class: 'muted' }, 'ค่าที่ส่งได้ตรงกับบอทแล้ว (จะส่งทั้ง 29 ค่าเพื่อยืนยัน)'),
      h('p', { class: 'muted small' }, 'EA ใช้ค่าใหม่เมื่อไม่มีไม้และคำสั่งรอของบอทเปิดอยู่ ระหว่างรอ หน้าควบคุมจะขึ้น "รอ: มีไม้เปิดอยู่"'),
      localChanges.length ? callout('info', `ต้องโหลด .set ที่เครื่อง (${localChanges.length} ค่า)`,
        h('p', null, 'ค่าเหล่านี้เว็บส่งไม่ได้ ส่งออก .set แล้วโหลดใน Inputs ของ EA ที่เครื่อง:'),
        h('p', { class: 'small mono-list' }, localChanges.map((p) => `${p.key} ${p.key in live.values ? formatValue(p, live.values[p.key]) : '(ค่าเริ่มต้น ' + formatValue(p, def[p.key]) + ')'} → ${formatValue(p, v[p.key])}`).join(', ')),
        h('button', { class: 'btn small', type: 'button', onclick: () => exportSet(nameIn.value.trim() || preset.name, v, notesIn.value) }, icon('download'), 'ส่งออก .set')) : null,
      v.InpAllowLive ? h('p', { class: 'muted small' }, 'InpAllowLive ไม่ถูกส่ง (เปิด/ปิดเทรดจริงใช้สวิตช์ในหน้าภาพรวม)') : null);
    openModal({
      title: `ส่งพรีเซ็ตไปที่ ${bot.name}`, body, wide: true,
      actions: [{ label: 'ยกเลิก' }, {
        label: 'ส่งค่าไปที่บอท', kind: 'primary', disabled: rErrors.length > 0, onClick: async (close) => {
          try {
            await patchDesired(bot.id, (d) => { d.params = remote; });
            close();
            toast('ส่งค่าพรีเซ็ตแล้ว รอเครื่องรับคำสั่ง ดูสถานะได้ที่หน้าควบคุม', 'good', 5000);
          } catch (e) { toast(errText(e), 'error', 6000); }
        },
      }],
    });
  }

  drawGroups(); drawSummary(); drawDiff();
  const warnLeave = (e) => { if (isDirty()) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', warnLeave);
  return () => window.removeEventListener('beforeunload', warnLeave);
}

// ------------------------------------------------------------------ lot calculator (SPEC 5.1)
export async function renderCalc(root, ctx) {
  root.append(pageHead('คำนวณล็อต', 'ประมาณผล 30 วันจากการจำลองย้อนหลัง ปรับตามทุนและล็อตของคุณ'), tabs('calc'));
  const { st } = await botStatus(ctx);
  const startBal = st && st.account && st.account.balance > 0 ? Math.round(st.account.balance) : 300;
  const startLot = st && st.params && st.params.lots_input > 0 ? st.params.lots_input : 0.03;
  const balIn = h('input', { class: 'input', type: 'number', inputmode: 'decimal', min: '10', step: '10', value: String(startBal) });
  const lotIn = h('input', { class: 'input', type: 'number', inputmode: 'decimal', min: '0.01', step: '0.01', value: String(startLot) });
  const out = h('div', { class: 'stack-lg', 'aria-live': 'polite' });
  root.append(
    callout('warn', 'ผลจำลองในอดีต ไม่ใช่การพยากรณ์',
      h('p', null, `ตัวเลขมาจากการจำลองแบบ live-scale ที่ล็อต ${BASE_LOT} บนทุน ${BASE_BALANCE} ช่วง ม.ค. 2025 ถึง ต.ค. 2026 (งานวิจัย r37) ตลาดแบบปี 2025 ให้ผลแย่กว่าปี 2026 มาก ผลจริงอาจแย่กว่านี้ได้`)),
    panel('ข้อมูลของคุณ', {}, h('div', { class: 'grid-2 tight' },
      field('ทุน (สกุลเงินบัญชี)', balIn, { hint: st ? 'ค่าเริ่มต้นจากยอดเงินบัญชีของบอทที่เลือก' : null }),
      field('ล็อตต่อสูตร', lotIn, { hint: 'ล็อตของแต่ละสูตร (InpLotsA / NY / C5G)' }))),
    out);
  const draw = () => {
    const bal = Number(balIn.value), lot = Number(lotIn.value);
    const c = calculate(bal, lot);
    if (!c) { out.replaceChildren(callout('info', 'ใส่ทุนและล็อตที่มากกว่า 0')); return; }
    const hz = c.horizon, d = c.daily;
    out.replaceChildren(
      panel('ผล 30 วัน', { sub: `เทียบเท่าล็อต ${fmtNum(c.eqLot, 3)} บนทุน ${BASE_BALANCE} (ช่วงที่ทดสอบ ${HORIZON30[0].lot} ถึง ${HORIZON30[HORIZON30.length - 1].lot})` },
        c.inRange ? [
          h('div', { class: 'calc-kpis' },
            ck('ค่ากลาง (median)', hz.median, hz.medianPct, bal),
            ck('กรณีแย่ (p10)', hz.p10, hz.p10Pct, bal),
            ck('กรณีดี (p90)', hz.p90, hz.p90Pct, bal),
            h('div', { class: 'kpi' }, h('p', { class: 'kpi-label' }, 'โอกาสทุนเหลือครึ่งเดียว'), h('p', { class: 'kpi-value' }, fmtPct(hz.halfPct, 1)), h('p', { class: 'kpi-sub' }, `ทุนลดลงถึง ${fmtNum(bal / 2, 0)} ภายใน 30 วัน`))),
          rangeStrip(hz, bal),
        ] : callout('warn', 'นอกช่วงที่ทดสอบ',
          h('p', null, `ล็อตเทียบเท่า ${fmtNum(c.eqLot, 3)} อยู่นอกช่วง ${HORIZON30[0].lot} ถึง ${HORIZON30[HORIZON30.length - 1].lot} ที่ทดสอบไว้ จึงไม่แสดงตัวเลข`),
          h('p', null, `สำหรับทุน ${fmtNum(bal, 0)} ล็อตที่อยู่ในช่วงทดสอบคือ ${fmtNum((HORIZON30[0].lot * bal) / BASE_BALANCE, 3)} ถึง ${fmtNum((HORIZON30[HORIZON30.length - 1].lot * bal) / BASE_BALANCE, 3)} ต่อสูตร (ดูตารางด้านล่าง)`))),
      panel('วันที่ขาดทุน', { sub: `ขนาดความเสียหายรายวันโตตามล็อต (ฐาน ${BASE_LOT} ล็อต ทุน ${BASE_BALANCE})` },
        h('p', null, `${d.losingDaysPct}% ของวันเป็นวันขาดทุน`),
        h('div', { class: 'table-wrap' }, h('table', { class: 'rtable compact' },
          h('thead', null, h('tr', null, ['', 'เงิน', '% ของทุน'].map((t) => h('th', { scope: 'col' }, t)))),
          h('tbody', null, [['เฉลี่ย', d.mean], ['ค่ากลาง', d.median], ['p10', d.p10], ['p5', d.p5], ['แย่ที่สุด', d.worst]].map(([k, x]) => h('tr', null,
            h('td', { 'data-label': '' }, k), h('td', { 'data-label': 'เงิน', class: 'num' }, fmtSigned(x)), h('td', { 'data-label': '% ของทุน', class: 'num' }, fmtPct(d.pct(x), 1, true))))))),
        h('p', { class: 'muted small' }, `จุดหยุดรายวัน 10% ของทุนนี้ = ${fmtNum(d.cap10)} ที่ ${BASE_LOT} ล็อตบนทุน ${BASE_BALANCE}: 1 ใน 3 ของวันที่ขาดทุนเสียเกินจุดหยุด 10% (EA หยุดเปิดไม้ใหม่ แต่ไม้ที่เปิดอยู่ยังวิ่งต่อ)`)),
      panel(`ตารางเต็มสำหรับทุน ${fmtNum(bal, 0)}`, { sub: 'แต่ละแถวคือจุดที่ทดสอบจริง แปลงเป็นล็อตและเงินของทุนนี้' },
        h('div', { class: 'table-wrap' }, h('table', { class: 'rtable' },
          h('thead', null, h('tr', null, ['ล็อตที่ทุนนี้', 'ล็อตที่ทุน 280', 'ค่ากลาง', 'p10', 'p90', 'โอกาสเหลือครึ่ง'].map((t) => h('th', { scope: 'col' }, t)))),
          h('tbody', null, tableForBalance(bal).map((r) => h('tr', { class: Math.abs(r.eqLot - c.eqLot) < 0.005 ? 'hl' : '' },
            h('td', { 'data-label': 'ล็อตที่ทุนนี้', class: 'num' }, fmtNum(r.lot, 3)),
            h('td', { 'data-label': 'ล็อตที่ทุน 280', class: 'num' }, fmtNum(r.eqLot)),
            h('td', { 'data-label': 'ค่ากลาง', class: 'num' }, fmtSigned(r.median)),
            h('td', { 'data-label': 'p10', class: 'num' }, fmtSigned(r.p10)),
            h('td', { 'data-label': 'p90', class: 'num' }, fmtSigned(r.p90)),
            h('td', { 'data-label': 'โอกาสเหลือครึ่ง', class: 'num' }, fmtPct(r.halfPct, 1))))))),
        h('p', { class: 'muted small' }, 'ล็อตจริงต้องปัดเป็น 0.01 ค่ากลางสูงสุดอยู่ที่ล็อตเล็ก ล็อตใหญ่ขึ้นทำให้กรณีแย่และโอกาสเหลือครึ่งสูงขึ้นเร็วกว่ากำไร')));
  };
  const ck = (label, money, pct, bal) => h('div', { class: 'kpi' }, h('p', { class: 'kpi-label' }, label),
    h('p', { class: `kpi-value num ${money > 0 ? 'pos' : money < 0 ? 'neg' : ''}` }, fmtSigned(money)),
    h('p', { class: 'kpi-sub' }, `${fmtPct(pct, 0, true)} ทุนจะเป็น ${fmtNum(bal + money, 0)}`));
  balIn.addEventListener('input', debounce(draw, 150));
  lotIn.addEventListener('input', debounce(draw, 150));
  draw();
}

// p10..p90 band with the median and zero marked (one axis, money).
function rangeStrip(hz, bal) {
  const lo = Math.min(hz.p10, 0), hi = Math.max(hz.p90, 0);
  const pos = (x) => `${((x - lo) / (hi - lo || 1)) * 100}%`;
  return h('figure', { class: 'range-strip' },
    h('div', { class: 'rs-track', role: 'img', 'aria-label': `ช่วง 80% ของผล 30 วัน ตั้งแต่ ${fmtSigned(hz.p10)} ถึง ${fmtSigned(hz.p90)} ค่ากลาง ${fmtSigned(hz.median)}` },
      h('span', { class: 'rs-band', style: { left: pos(hz.p10), width: `calc(${pos(hz.p90)} - ${pos(hz.p10)})` } }),
      h('span', { class: 'rs-zero', style: { left: pos(0) } }),
      h('span', { class: 'rs-med', style: { left: pos(hz.median) } })),
    h('div', { class: 'rs-labels' },
      h('span', null, `p10 ${fmtSigned(hz.p10, 0)}`), h('span', null, `ค่ากลาง ${fmtSigned(hz.median, 0)}`), h('span', null, `p90 ${fmtSigned(hz.p90, 0)}`)),
    h('figcaption', { class: 'muted small' }, `8 ใน 10 ของกรณีจำลองอยู่ในแถบนี้ เส้นตั้งคือ 0 (ทุน ${fmtNum(bal, 0)} เท่าเดิม)`));
}
