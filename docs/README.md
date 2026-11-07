# Dobby Web: website (developer notes)

Static site served by GitHub Pages from `docs/`. Vanilla JS ES modules, no build step, no npm runtime dependencies.
External code (pinned): `@supabase/supabase-js@2.118.0` and `chart.js@4.4.1` from cdn.jsdelivr.net (both loaded only
when needed), IBM Plex Sans Thai Looped from Google Fonts (optional; falls back to IBM Plex Sans Thai / system Thai fonts).

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

## Configure

`js/config.js` exports `SUPABASE_URL` and `SUPABASE_ANON_KEY` (Project URL + Publishable key `sb_publishable_...` or the
legacy anon key). Both empty -> setup screen with a "ดูโหมดตัวอย่าง" button. `?demo=1` always forces demo mode.

## Navigation (redesign 2026-11-07)

Main (sidebar top; mobile bottom bar = ภาพรวม, ตั้งค่าบอท, ประวัติ, เครื่อง, เมนู):

| route | page | what it does |
|---|---|---|
| `#/dashboard` | ภาพรวม | hero "บอทกำลังเทรดจริง / หยุดอยู่ / ออฟไลน์" + one sentence why, pause / 2 h blackout, the settings summary; balance, today (cap meter), profit since start, trades; open trade with an SL - entry - TP bar; last 8 closed trades; details (modules, NY, locks, last event) collapsed |
| `#/bot` | ตั้งค่าบอท | SPEC 7: "ค่าที่บอทใช้อยู่ตอนนี้" in plain Thai + 3-step apply progress; live switch + pause cards; the simple editor (balance, auto-from-balance, same/per-strategy lots, strategies incl. ASIA16, lock 0/1/2 stages with bars, daily loss cap, ขั้นสูง); sticky save bar; save / load preset; .set download; sides; blackouts (2 h, next news, any news, custom); control-file overrides (lots / spread / note) under a details |
| `#/history` | ประวัติ | unchanged features (journal, trades, equity chart, calendar, module stats, CSV), new head + filter card |
| `#/news` | ข่าว | unchanged |
| `#/machines` | เครื่องของฉัน | one card per bot: status, last seen, EA / app version, account, rename, set as default (บอทหลัก), delete from the website (explained confirm + "I understand" tick), add-a-PC card |
| `#/guide`, `#/guide/<section>` | วิธีใช้ | illustrated sections: start, dashboard, settings, live, news, lock, risk, history, machines, trouble (FAQ ids offline, pending, unchanged, windows, password) |

"เพิ่มเติม": `#/presets` (+ `#/presets/<id>`, `#/calc?balance=&lot=`) พรีเซ็ตที่บันทึกไว้, `#/downloads` ดาวน์โหลดแอป,
`#/users` ผู้ใช้ (admin), `#/audit` บันทึกการเปลี่ยนแปลง, `#/settings` ตั้งค่าบัญชี.
Old / alternative addresses redirect: `control`, `botsettings`, `params` -> `bot`; `bots`, `devices` -> `machines`;
`help`, `howto` -> `guide`; `account` -> `settings`; `download`, `setup` -> `downloads`; `home` -> `dashboard`.
Gate pages: `#/login`, `#/invite`, `#/mfa`, `#/reset`, `#/disabled`.

Every page head has a "? วิธีใช้" button to the matching guide section. A 4-step welcome tour opens once after the first
sign-in (`localStorage` `dobby-tour-done`, read/written through `prefs` with try/catch; "ดูทัวร์แนะนำอีกครั้ง" on the guide).

## Structure

```
index.html            shell; applies the saved theme before paint, loads js/app.js
css/app.css           all styles; tokens on :root, dark via prefers-color-scheme or [data-theme]
js/config.js          SUPABASE_URL / SUPABASE_ANON_KEY
js/app.js             boot, theme, hash router (#/name/part?query) + aliases, shell (grouped sidebar / bottom tabs), tour hook
js/api.js             the API interface + SupabaseApi + DemoApi, Thai error mapping (DB error codes)
js/demo.js            synthetic deterministic demo data (2 bots, ~3 weeks of journal, live status, invites, news...)
js/state.js           app state + event bus (bots, selected bot, default bot, profile)
js/botctl.js          desired-state JSON, patchDesired (optimistic version check), online/pending, rejections, heroState,
                      applyProgress (SPEC 7.4 three steps)
js/simple.js          SPEC 7 simple settings: strategy catalog, lock modes, auto-from-balance (7.3), plain-Thai summary,
                      change list, validation with "what to do", risk hint (lot calculator), toDesiredParams
js/liveswitch.js      live switch + ON flow (live_gate_status -> password -> TOTP -> desired.live = true)
js/params.js          every EA input (v3.03 + v3.04), groups, remote allow-list, validation, templates, live mapping
js/setfile.js         .set parse (UTF-16LE/BE/UTF-8) and build (UTF-16LE + BOM, CRLF)
js/lotcalc.js         SPEC 5.1 lot calculator data + interpolation/scaling
js/journal.js         journal rows -> paired trades, module stats, daily P&L, equity series, CSV
js/util.js            DOM helper h() / mount(), formatting (Intl, Asia/Bangkok), server-time conversion, dialogs, toasts, icons
js/views.js           shared pieces: page head + help button, teaching empty state, stepper, big toggle, segmented, progress
js/tour.js            first-login welcome tour
js/guide-art.js       inline SVG illustrations (theme tokens, 360-wide canvas so text stays readable on phones)
js/pages/*.js         one module per page, `render(root, ctx)` returns an optional cleanup function
```

## Demo mode

`DemoApi` implements the same interface as `SupabaseApi` in memory (lost on reload):
- Signed in as the admin "เจ้าของบอท" with a verified TOTP factor; the last password sign-in is 2 h old, so turning live
  ON goes through the full re-auth + 2FA flow (any password; any 6 digits except `000000`). Sign out and sign in with
  `ploy@example.com` to see an unapproved account (invite `DEMKH7K3QP` works), any other email = the admin.
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
