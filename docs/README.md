# Dobby Web: website (developer notes)

Static site served by GitHub Pages from `docs/`. Vanilla JS ES modules, no build step, no npm runtime dependencies.
External code (pinned): `@supabase/supabase-js@2.118.0` and `chart.js@4.4.1` from cdn.jsdelivr.net (both loaded only
when needed); Google Fonts Anuphan (Thai + UI) and a Chakra Petch glyph subset (numerals), both `display=swap` with
system Thai fallbacks. Visual design: `DESIGN.md` ("Hallmark").

## Run locally

Windows' registry often maps `.js` to `text/plain`, and plain `python -m http.server` then serves modules the browser
refuses. Use a tiny server that sends `text/javascript`, for example:

```python
# serve.py  (python serve.py docs 8765)
import functools, http.server, sys
class H(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.js': 'text/javascript', '.css': 'text/css'}
http.server.ThreadingHTTPServer(('127.0.0.1', int(sys.argv[2])), functools.partial(H, directory=sys.argv[1])).serve_forever()
```
Open http://localhost:8765/?demo=1 (demo) or http://localhost:8765/ (login with the real config in `js/config.js`).

## Before every commit that touches docs/

```
python tools/stamp_versions.py
```
It gives every module and the stylesheet an address with a hash of its content (an import map in `index.html`), so a
browser never mixes a new file with an old cached one after an update. `python tools/stamp_versions.py --check` exits 1
when `index.html` is out of date. Do not edit the block between the stamp markers by hand.

## Configure

`js/config.js` exports `SUPABASE_URL` and `SUPABASE_ANON_KEY` (Project URL + Publishable key `sb_publishable_...` or the
legacy anon key). Both empty -> setup screen with a "ดูโหมดตัวอย่าง" button. `?demo=1` always forces demo mode.

## Navigation (redesign 2026-11-07, restyled "Hallmark" the same day)

Main (sidebar top; mobile bottom bar = ภาพรวม, ตั้งค่าบอท, ประวัติ, เครื่อง, เมนู). The header carries a live XAUUSD
ticker for the selected bot (`status.market.bid`, change since the first M15 bar of the broker's day from
`agent_state.bars`, or the first priced journal row of that day while bars are missing), the bot picker and the theme.

| route | page | what it does |
|---|---|---|
| `#/dashboard` | ภาพรวม | hero sheet: hallmark stamp (gold = trading live, slate = paused / not connected, cinnabar = offline / needs attention) + one sentence why + today's P&L, then the last 24 h XAUUSD line from `agent_state.bars` (SPEC 8) with faint VWAP, the current price and Dobby's trades from the journal (OPEN ▲ jade buy / ▼ cinnabar sell, CLOSE ring coloured by P&L; hover / tap shows the trade; without bars: "กราฟราคาจะขึ้นเมื่อแอปเวอร์ชันใหม่ส่งข้อมูล"), the settings summary as one sentence, pause / 2 h blackout; four equal stat cells (balance, equity, today with cap meter, since start: label, value with smaller decimals, foot line); open trade (summary, SL - entry - price - TP gauge, then price, time open and distance to TP / SL in $ and % with the money at TP / SL) beside the last 6 closed trades + "ดูทั้งหมด", both panels one row height; details collapsed |
| `#/bot` | ตั้งค่าบอท | SPEC 7, as grouped rows (label left, control right) with section anchors (sticky chips on a phone, a side list on wide screens): "ค่าที่บอทใช้อยู่ตอนนี้" (label / value grid) + 3-step apply progress; live switch + pause rows; the simple editor (balance, auto-from-balance, same/per-strategy lots, strategies incl. ASIA16, lock 0/1/2 stages with a price-ladder diagram, daily loss cap, ขั้นสูง); sticky save bar; save / load preset; .set download; sides; blackouts (2 h, next news, any news, custom); control-file overrides (lots / spread / note) under a details |
| `#/history` | ประวัติ | view tabs (ภาพรวม / รายการเทรด / บันทึกทั้งหมด), one filter bar (dates, 7 วัน / 30 วัน / ทั้งหมด, สูตร; the event filter sits in the journal panel head), module stats, equity chart (gold line, right axis), calendar heatmap (jade / cinnabar intensity), trades, journal, CSV |
| `#/news` | ข่าว | unchanged |
| `#/machines` | เครื่องของฉัน | one identical panel per bot: name, status, last seen, six facts in one strip (EA, live, account, app, symbol, linked; the columns line up from one bot to the next), actions (ดูภาพรวม, ตั้งค่าบอท; เปลี่ยนชื่อ, ตั้งเป็นบอทหลัก, ลบออกจากเว็บ with the explained confirm + "I understand" tick), add-a-PC panel |
| `#/guide`, `#/guide/<section>` | วิธีใช้ | illustrated sections: start, dashboard, settings, live, news, lock, risk, history, machines, trouble (FAQ ids offline, pending, unchanged, windows, password) |

"เพิ่มเติม": `#/presets` (+ `#/presets/<id>`, `#/calc?balance=&lot=`) พรีเซ็ตที่บันทึกไว้, `#/downloads` ดาวน์โหลดแอป,
`#/users` ผู้ใช้ (admin; see "Admin: friends' bots, view only"), `#/audit` บันทึกการเปลี่ยนแปลง (the admin sees every
user's rows, with who did it, which bot and its owner, and a filter by user), `#/settings` ตั้งค่าบัญชี (grouped rows like
ตั้งค่าบอท: display name, password change in a dialog, 2FA, theme, the members' privacy notice, account facts, sign out).
Old / alternative addresses redirect: `control`, `botsettings`, `params` -> `bot`; `bots`, `devices` -> `machines`;
`help`, `howto` -> `guide`; `account` -> `settings`; `download`, `setup` -> `downloads`; `home` -> `dashboard`.
Gate pages: `#/login`, `#/invite`, `#/mfa`, `#/reset`, `#/disabled`.

Every page head has a "? วิธีใช้" button to the matching guide section. A 4-step welcome tour opens once per browser, demo
mode included: "seen" is written when it opens (so a reload half-way does not bring it back) to `localStorage`
`dobby-tour-done` (through `prefs`, try/catch), `sessionStorage` and a `dobby_tour` cookie scoped to the site path; any
one of them keeps it closed. "ดูทัวร์แนะนำอีกครั้ง" on วิธีใช้ replays it.

## Admin: friends' bots, view only (2026-11-07)

The database lets the admin SELECT every row of bots, bot_status, journal, bot_control, presets and audit; every insert,
update and delete stays owner-only. The site mirrors that:
- `api.listBots()` stays owner-filtered. `api.adminBots()` / `api.adminPresets()` return everyone else's rows (admin only),
  `api.journalTail(botId, n)` the newest journal rows. `state.loadBots()` keeps them apart: `app.bots` (mine) and
  `app.friendBots` (others, each with `owner_name` from `admin_overview`); `app.people` maps user ids to names.
- Ownership decides writes, never the role: `ownsBot(bot)` = `bot.owner === uid`. `patchDesired()` refuses a bot that is
  not in `app.bots`, and `SupabaseApi.updateDesired / renameBot / deleteBot` check ownership again before sending
  (`ApiError('read_only')`: "บอทนี้เป็นของสมาชิกคนอื่น ผู้ดูแลดูได้อย่างเดียว สั่งงานไม่ได้"). `DemoApi` refuses the same way.
- ผู้ใช้ → "บอทของสมาชิก": four counts (members, bots online, trading live, today's P&L of all members), then each
  member (name, email, role, approval) with each bot as one panel: online / last seen, trading state (เทรดจริง /
  หยุดชั่วคราว / ปิดเทรดจริง), alerts (daily cap, MT5 not answering, active or next blackout, agent rejections, command not
  received), balance / today / since start, strategies with lots, lock stages, daily cap, EA and app version, open trades,
  the last trade (`journalTail`), the "ค่าที่ใช้อยู่" sentence, saved presets, and "ดูบอทนี้" / ประวัติ / ค่าทั้งหมด. One bot =
  a full-width card (facts in two columns), more = two equal-height cards per row. Members without a bot, waiting for
  approval or disabled get one state line. "ผู้ใช้และรหัสเชิญ" is the earlier invites / users page.
- The header bot picker lists friends' bots under "ของ <name> (ดูอย่างเดียว)". Choosing one opens ภาพรวม, ประวัติ and
  ตั้งค่าบอท for it in view-only mode: an inverse banner "กำลังดูบอทของ <name> ดูอย่างเดียว สั่งงานไม่ได้" with
  "กลับไปบอทของฉัน", an owner chip in the page head, no pause / blackout buttons, the live and pause rows as state chips,
  the editor disabled with no save bar, no preset load / save / apply (only ".set ของค่านี้"), sides disabled, blackouts
  listed without delete. A friend's bot is never remembered as the selected or default bot (the next visit opens my own).
  ข่าว and พรีเซ็ต always send to my own bot (`state.myBot()`).
- พรีเซ็ต: "พรีเซ็ตของสมาชิก" lists friends' presets (owner chip): open read only (`#/presets/<id>`: summary + every
  value by group), download the .set, or "คัดลอกเป็นของฉัน" (creates my own row).
- Members are not shown a notice about the admin's access (the site owner's decision, 2026-11-07).

## Structure

```
index.html            shell; applies the saved theme before paint, loads js/app.js
css/app.css           all styles; DESIGN.md tokens on :root (porcelain / vault), dark via prefers-color-scheme or [data-theme]
js/config.js          SUPABASE_URL / SUPABASE_ANON_KEY
js/app.js             boot, theme, hash router (#/name/part?query) + aliases, shell (grouped sidebar / bottom tabs), tour hook
js/hallmark.js        the hallmark stamp (rounded octagon, double engraved outline, "Dobby" + state) and the brand mark
js/pricechart.js      readBars (agent_state.bars) + the hero's SVG price line with trade marks, tooltip, first-load motion
js/ticker.js          header XAUUSD ticker (bid + change since the broker day's first bar)
js/api.js             the API interface + SupabaseApi + DemoApi, Thai error mapping (DB error codes)
js/demo.js            synthetic deterministic demo data (my 2 bots + friends' bots, ~3 weeks of journal, invites, news...)
js/state.js           app state + event bus (my bots, friends' bots for the admin, selected bot, default bot, ownership)
js/botctl.js          desired-state JSON, patchDesired (optimistic version check), online/pending, rejections, heroState,
                      applyProgress (SPEC 7.4 three steps)
js/simple.js          SPEC 7 simple settings: strategy catalog, lock modes, auto-from-balance (7.3), plain-Thai summary,
                      change list, validation with "what to do", risk hint (lot calculator), toDesiredParams
js/liveswitch.js      live switch + ON flow (live_gate_status -> password -> TOTP -> desired.live = true)
js/params.js          every EA input (v3.03 + v3.04), groups, remote allow-list, validation, templates, live mapping
js/setfile.js         .set parse (UTF-16LE/BE/UTF-8) and build (UTF-16LE + BOM, CRLF)
js/lotcalc.js         SPEC 5.1 lot calculator data + interpolation/scaling
js/journal.js         journal rows -> paired trades, module stats, daily P&L, equity series, CSV
js/util.js            DOM helper h() / mount() (glues Thai loanwords for line breaking), formatting (Intl, Asia/Bangkok),
                      server-time conversion, dialogs, toasts, icons
js/views.js           shared pieces: page head + help button, teaching empty state, stepper, big toggle, segmented, progress
js/tour.js            first-login welcome tour
js/guide-art.js       inline SVG illustrations (theme tokens, 360-wide canvas so text stays readable on phones)
js/pages/*.js         one module per page, `render(root, ctx)` returns an optional cleanup function
dev/layout-audit.js   dev only (never loaded by the app): layout audit run in the page, see dev/audit-report.md
```

## Layout audit (dev)

`DESIGN.md` "Layout system" is checked by `dev/layout-audit.js`. In demo mode open DevTools (or any tool that runs JS in
the page) and run `await import('./dev/layout-audit.js'); (await window.__layoutAudit()).summary` at each width (1440,
1280, 1024, 768, 390, 360). It visits every route (plus the ผู้ใช้ overview, a friend's bot in view-only mode, a friend's
preset, the no-bot state, dialogs, a toast and the sign-in page) in light and dark and reports unequal heights in a row, edges off the content column / 12-column grid, text below 13 px,
non-standard control heights, horizontal overflow, contrast below 4.5:1 and clipped text. Last results:
`dev/audit-report.md`.

## Demo mode

`DemoApi` implements the same interface as `SupabaseApi` in memory (lost on reload):
- Signed in as the admin "เจ้าของบอท" with a verified TOTP factor; the last password sign-in is 2 h old, so turning live
  ON goes through the full re-auth + 2FA flow (any password; any 6 digits except `000000`). Sign out and sign in with
  `ploy@example.com` to see an unapproved account (invite `DEMKH7K3QP` works), `nok@example.com` or `beam@example.com` to
  see a member (their own bot, the privacy notice), any other email = the admin.
- Friends (synthetic): นก ("คอมนก", EA v3.04, 500 balance, live with an open C5G trade, 2 presets), บีม ("โน้ตบุ๊กบีม",
  paused from the web, the PC offline for 3 h with its status frozen, a news blackout, a `lots_clamped` rejection, one
  preset), มิ้นท์ (approved, no bot), พลอย (waiting for approval) and a disabled old account; audit rows for all of them.
  The admin reads everything (`DemoApi.readBot`), writes to a friend's bot throw `read_only` like the real API.
- Bot "คอมหลัก" (EA v3.04, remote on, SPEC 7.3 values for a 300 balance: 0.03 lots, locks 85->83 / 95->93, local max lots
  0.06, open C5G position, live ON) ticks every 4 s through the realtime handlers. Lots above 0.06 show the "เกินเพดานของ
  เครื่อง" error; "ตั้งให้อัตโนมัติจากทุน" with 1000 gives 0.10 and shows it too.
- Bot "DESKTOP-NPNL85P" (EA v3.03, paused, `allow_remote_live=false`, `allow_remote_params=false`) shows the read-only
  settings with the "อัปเดตเป็น 3.04 ใน 3 ขั้น" box and the .set download, and agent rejections when switched live.
- Both bots can be renamed, set as default and deleted on เครื่องของฉัน. วิธีใช้ → เริ่มต้นใช้งาน → "ดูตอนยังไม่มีบอท"
  shows the no-bot state (`DemoApi.setDemoNoBots(true)`); the demo banner brings the bots back.
- A simulated agent applies each new `bot_control.version` about 2.5 s later (updates `agent_state.applied_version`,
  `status.control`, writes a CONTROL journal row). Settings sent to คอมหลัก wait for the open position ("รอให้ไม่มีไม้ค้าง"),
  the demo closes it after about 12 s and applies them (`REMOTE APPLY` row), so all three progress steps can be watched.
- Data is generated by `createDemoDb(now)` with fixed seeds: dates are relative to today, "today" is always a trading day.
- Each demo bot has `agent_state.bars` (SPEC 8): the last 96 closed M15 bars on the same price path as the demo trades
  (so the marks sit on the line) with a small deterministic jitter and a VWAP anchored to each server day; the window
  rolls forward when a new bar closes.

## Contract notes (what the site relies on)

- `bot_control` is UPDATE only (rows come from `register_bot`). Writes use `.eq('version', v)`; a lost race retries once.
- `desired` written by the site:
  `{live: bool, control: {mode: 'run'|'pause', lots: number|null, allow_long, allow_short, max_spread: number|null, note},
  blackouts: [{from_utc, to_utc, label}], params: null | {<SPEC 4.2 keys>}}`. Unknown fields are preserved.
- Live ON: `rpc('live_gate_status')` first; `reauth_required` -> `signInWithPassword` with the user's email; then
  `mfa_required` -> `mfa.challengeAndVerify`; then the update. DB errors `reauth_required` / `mfa_required` send the
  user back to the matching step.
- "Pending" = `bots.agent_state.applied_version < bot_control.version`. Rejections are read from
  `bots.agent_state.rejected` (strings or `{code, detail}`), `status.remote.rejects` and `status.control.warn`.
- Online = `bots.last_seen` < 60 s and EA heartbeat (`status.heartbeat_gmt_unix`) < 120 s. Dashboard and ตั้งค่าบอท
  re-read `bots` on load (the list in memory can be minutes old).
- Realtime subscriptions are opened only for signed-in users; pages also poll every 30 s while realtime is not joined.
- Times are shown in Thai time (Intl, `Asia/Bangkok`, Gregorian calendar); server time (EA clock) is shown on hover or
  next to it. Blackouts are entered in Thai time and stored as UTC ISO strings.
- The daily calendar groups by server day (same day as the EA daily cap).

## Spec additions / interpretations (website)

1. `desired.control.note` holds the note (SPEC 3.6 `note=web: <note>`); `desired.note` is read as a fallback.
2. Sign-in also asks for the TOTP code when the account has a verified factor (aal1 -> aal2); the live switch still
   re-asks password + code because a fresh password sign-in drops the session back to aal1.
3. If email confirmation is on, the invite code typed at sign-up is kept in `localStorage` (`dobby-pending-invite`)
   and redeemed automatically after the first sign-in.
4. เครื่องของฉัน renames (`bots.name`) or deletes a bot (RLS allows both; delete is audited as `bot_delete`). The
   confirm explains it only removes the bot from the website and the PC's app must be re-linked. "บอทหลัก" (default
   bot) is a per-browser choice in `localStorage` `dobby-default-bot` (no DB field).
5. Agent rejection codes with a known fix: `live_not_allowed_locally`, `params_not_allowed_locally`,
   `remote_control_disabled`, `lots_clamped`, `params_lots_over_limit`, `params_cap_over_limit`, `params_unknown_key`,
   `params_need_ea_v304`; other codes are matched by keyword (live / param / lot / cap / control) or shown raw.
6. Control-file overrides (ตั้งค่าบอท → "คำสั่งชั่วคราวขั้นสูง") cap lots at the lowest of `status.params.max_lots`,
   `agent_state.limits.max_lots` and `status.remote.effective.InpMaxLots` ("lower only"); max spread at
   `status.params.max_spread_input` (the EA only tightens it).
7. "บันทึกและส่งให้บอท" (and the presets page "ส่งไปที่บอท") sends all 29 remote keys, never `InpAllowLive`. The simple
   editor blocks sending while a value breaks the SPEC 4.2 bounds or the lower of `status.remote.ceilings` / agent
   limits; hidden lock stages are kept inside their bounds (the EA checks them even when off).
8. What the editor starts from: `status.remote.effective` (v3.04); while a sent `desired.params` is not yet effective,
   the sent values. Step 3 "EA ใช้ค่าใหม่แล้ว" = every sent key equals `status.remote.effective` (then step 2 counts as
   done too, even if a later pause/blackout bumped the version); "รอให้ไม่มีไม้ค้าง" while `status.remote.pending`.
9. EA v3.03 (no `status.remote`): settings read from `status.params/options`, shown read-only; "ลองปรับค่าแล้วโหลดเป็น
   ไฟล์ .set" unlocks the editor for a .set download only. That .set = live values + edits + the SPEC 7.4 generic remote
   inputs (`InpRemoteParams/Live = true`, `InpRemoteMaxLots = 0.50`, `InpRemoteMaxCapPct = 10`), `InpAllowLive = false`
   (the comment says to tick it for a REAL account on v3.03).
10. Unsent editor changes are kept per bot in `sessionStorage` (`dobby-settings-draft`) and restored when the page is
    opened again (no "Leave site?" prompt).
11. Risk hint: SPEC 5.1 numbers for the balance and the largest enabled strategy lot. A lot below the tested range (e.g.
    300 / 0.03 = 0.028 equivalent) shows the smallest tested lot's numbers as an upper bound; above the range no numbers.
12. Lot calculator: daily figures scale linearly with the equivalent lot; outside 0.03 .. 0.08 (equivalent) no numbers
    are shown, only the lot range that is inside the tested range for the entered balance. `#/calc?balance=&lot=` prefills.
13. Templates in `params.js`: "มาตรฐาน 0.03 / ทุน ~300", "0.10 / ทุน ~1,000", "ระวัง 0.06 / ทุน ~1,000" and the plain
    EA defaults; all with `InpAllowLive = false`.
