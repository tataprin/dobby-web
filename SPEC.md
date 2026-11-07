# Dobby Web — system spec (contract between the 4 parts)

Written 2026-11-07. Every part (database, PC agent, website, EA v3.04) is built against THIS file. If a part needs
something that is not here, it adds it to its own folder and lists it under "Spec additions" in its README — it never
changes another part's contract silently.

## 0. What it is
A website (GitHub Pages, static) where the owner and invited friends log in, watch their own Dobby bot live, read its
history, start/stop live trading, pause, set news blackouts, edit presets and (with EA v3.04) push presets to the bot.

```
browser (docs/, GitHub Pages)  <->  Supabase (auth + Postgres + realtime + storage)  <->  agent (Python, each PC)  <->  MT5 + Dobby3 EA
```
- The agent is the ONLY thing on a PC that talks to Supabase. It reads the EA's files and writes the EA's control /
  remote files. It never trades, never imports MetaTrader5, never touches MT5 settings.
- Each user sees and controls only their own bots (Row Level Security). The admin manages invites and users.
- Safety rules that every part enforces (defence in depth):
  1. Local limits on each PC (agent config + EA inputs) cap lots and the daily cap; the web can never exceed them.
  2. Turning live trading ON from the web needs a fresh password sign-in (<= 5 min) and, if the user has 2FA, a 2FA
     code (aal2). Enforced in the database, again shown in the UI.
  3. Each PC must opt in locally to remote control, remote live switch and remote presets (all off by default except
     remote control).
  4. Every change is audited (who, when, before, after). The agent journals and (optionally) alerts on Telegram.

## 1. Repository layout (git repo D:\Dobby\dobby-web, published as github.com/tataprin/dobby-web, public)
```
README.md                 Thai setup guide for the owner (Supabase project, schema, Pages, first admin)
SPEC.md                   this file
docs/                     the website (GitHub Pages source = main /docs). No build step. ES modules.
  index.html
  css/app.css
  js/config.js            SUPABASE_URL / SUPABASE_ANON_KEY (empty -> setup screen + demo)
  js/*.js                 app code
tools/
  stamp_versions.py       writes the content-hash import map into docs/index.html (run after every docs/ change)
supabase/
  schema.sql              ONE file the owner pastes into the Supabase SQL editor (idempotent, re-runnable)
  seed_news.sql           news calendar seed (also included at the end of schema.sql)
  tests/                  PGlite-based tests (node) with stubbed auth/storage schemas
agent/
  dobby_agent.py          the PC agent (Python >= 3.8, stdlib + requests only)
  requirements.txt
  install.bat, run_agent.bat
  tests/
```
NOT in the repo (private): the EA source/ex5 (D:\Dobby\mt5), presets with account data, research, any key other than
the public anon key. The EA .ex5 is distributed through the private Storage bucket `downloads`.

## 2. Database (Supabase Postgres, schema `public`)
All tables have RLS enabled. Helper functions are `security definer`, `stable`, `set search_path = public`.

### 2.1 Tables
```
profiles   id uuid pk -> auth.users(id) on delete cascade
           display_name text, role text not null default 'member' check (role in ('admin','member')),
           approved boolean not null default false, disabled boolean not null default false,
           created_at timestamptz not null default now()
           (row created by trigger on auth.users insert; display_name = email prefix)
invites    code text pk (10 chars, A-Z2-9 without I/O/1/0), role text not null default 'member',
           note text, created_by uuid -> profiles, created_at timestamptz default now(),
           expires_at timestamptz not null, used_by uuid -> profiles, used_at timestamptz, revoked boolean default false
bots       id uuid pk default gen_random_uuid(), owner uuid not null -> profiles on delete cascade,
           name text not null, created_at timestamptz default now(), last_seen timestamptz,
           agent_version text, ea_version text, symbol text, server_utc_offset_min int,
           agent_state jsonb not null default '{}'     -- see 3.6
bot_status bot_id uuid pk -> bots on delete cascade, updated_at timestamptz not null default now(),
           status jsonb not null                        -- the EA's dobby2_status.json verbatim
journal    id bigserial pk, bot_id uuid not null -> bots on delete cascade,
           ts_server timestamp not null, event text not null, tag text, side text, lots numeric, price numeric,
           sl numeric, tp numeric, pnl numeric, v_balance numeric, step int, detail text,
           line_hash text not null, unique (bot_id, line_hash)
           index (bot_id, ts_server desc)
bot_control bot_id uuid pk -> bots on delete cascade, version int not null default 1,
           desired jsonb not null, updated_by uuid, updated_at timestamptz not null default now()
presets    id uuid pk default gen_random_uuid(), owner uuid not null -> profiles on delete cascade,
           name text not null, params jsonb not null, notes text, created_at, updated_at timestamptz default now()
audit      id bigserial pk, ts timestamptz not null default now(), actor uuid, bot_id uuid, action text not null,
           before jsonb, after jsonb
news_events id bigserial pk, ts_utc timestamptz not null, name text not null, tier int not null default 1, note text,
           unique (ts_utc, name)
```
Feature batch 2026-11-07 (definitions in 9.1 / 9.2 / 9.6): tables `bars`, `cash_flows`, `trade_notes`. (The push
objects of 9.7, `push_subscriptions`, `bots.offline_notified_at` and `register_push_subscription`, were removed on
2026-11-08; schema.sql drops them if an earlier run created them.)

### 2.2 Functions (RPC, callable by `authenticated`)
- `is_approved() returns boolean` — caller has a profile with approved and not disabled.
- `is_admin() returns boolean` — approved, not disabled, role = 'admin'.
- `redeem_invite(p_code text) returns text` — trims/uppercases; valid if exists, not used, not revoked, not expired;
  marks used (used_by = auth.uid(), used_at = now()), sets the caller's profile approved = true and role = invite role.
  Returns 'ok' or raises 'invite_invalid'. An already approved caller gets 'already_approved' and the code stays unused.
- `create_invite(p_role text default 'member', p_days int default 7, p_note text default null) returns text` — admin
  only; generates a unique code; returns it.
- `revoke_invite(p_code text)` — admin only.
- `admin_set_user(p_user uuid, p_role text, p_approved boolean, p_disabled boolean)` — admin only; an admin cannot
  remove their own admin role or disable themselves.
- `set_display_name(p_name text)` — own profile.
- `admin_overview() returns table(user_id, display_name, role, approved, disabled, created_at, bots int, last_seen timestamptz)`
  — admin only (friends' bot details come from the admin select policies, see 2.3).
- `register_bot(p_name text, p_desired jsonb) returns uuid` — approved caller; inserts bots + bot_control
  (version 1, desired = p_desired). Used by the agent on first setup.

### 2.3 Row Level Security
- profiles: select own row; admin selects all. No direct insert/update/delete (RPCs only).
- invites: admin select. Writes through RPCs only.
- bots: owner (approved) select/insert/update/delete own; admin select all.
- bot_status, journal: owner of the bot (approved) select/insert/update; admin select all. No delete except cascade.
- bot_control: owner (approved) select/update (insert only through register_bot); admin select all. No delete.
- presets: owner (approved) all; admin select all.
- audit: select where the caller owns the bot (or actor = caller); admin select all. Insert only by triggers.
- The admin reads every friend's bot but writes only their own (2026-11-07, site owner's request): the website shows
  friends' bots to the admin as view-only. The website shows members no notice about it (site owner's decision).
- news_events: approved select; admin insert/update/delete.
- bars: approved owner of the bot select / insert / update (update only for PostgREST upserts); admin select. No
  client delete (cascade only).
- cash_flows, trade_notes: approved owner of the bot select / insert / update / delete; admin select.
- Unapproved and disabled users see nothing in any of the three batch tables (not even their own rows).
- Storage bucket `downloads` (private): approved users read; admin insert/update/delete.

### 2.4 Triggers
- `auth.users` after insert -> create profile.
- `bot_control` before update: `version = old.version + 1`, `updated_by = auth.uid()`, `updated_at = now()`.
  **Live gate:** if `coalesce((old.desired->>'live')::boolean,false) = false` and `(new.desired->>'live')::boolean = true`
  then require (a) a password (or otp/totp) sign-in within the last 300 s, read from the JWT claim `amr`
  (array of {method, timestamp}); and (b) if the caller has a verified MFA factor (`auth.mfa_factors.status='verified'`)
  the JWT claim `aal` must be 'aal2'. Otherwise raise exception 'reauth_required' or 'mfa_required'.
  Same gate on insert with live = true EXCEPT when called from `register_bot` (first registration copies the bot's
  current state; the agent was just logged in with a password locally).
- `bot_control` after insert/update -> audit row (action 'control', before = old.desired, after = new.desired).
- `presets` after insert/update/delete -> audit row (action 'preset_*', bot_id null).
- `invites` / `profiles` changes through admin RPCs -> audit row (action 'admin_*').
- `cash_flows` before insert/update: created_at = now() on insert and kept on update, updated_at = now(); after
  insert/update/delete -> audit row (action 'cash_flow_insert|update|delete', bot_id = the row's bot, before/after =
  the row). The owner and the admin read these rows through the existing audit policy (bot_id of an owned bot).
- `trade_notes` before insert/update: updated_at = now(), updated_by = auth.uid() (client values are ignored).

### 2.5 Realtime
`alter publication supabase_realtime add table bot_status, bot_control, bots, journal;` (guarded, idempotent).

### 2.6 Bootstrap
At the end of schema.sql: if no admin exists and no unused admin invite exists, insert one admin invite valid 7 days
and `select` it so the SQL editor shows the code. The owner signs up on the website and redeems it.

## 3. Agent (agent/dobby_agent.py)

### 3.1 Files on the PC
- Agent folder (where the script lives): `agent_config.json` (0600-ish, never uploaded), `agent_state.json`
  (seen journal hashes, last applied version, alert state; since 1.2.0 also `bars_upload` {pos, last_t}, `cash`
  {balance, pnl, pending} and `control.auto_lines`), `agent.log` (rotating), `agent_decisions.log`, and (1.2.0, only
  while auto_news is on) `news_cache.json` = the last good ForexFactory week {fetched_at, source, events}.
- EA common folder: default `%APPDATA%\MetaQuotes\Terminal\Common\Files\Dobby` (override in config / env `DOBBY_COMMON`).
  Reads `dobby2_status.json`, `dobby2_journal.csv`, `dobby2_bars.csv`. Writes ONLY `dobby2_control.txt` and
  `dobby3_remote.txt`.
- Network (1.2.0): Supabase, Telegram (when configured) and, only while desired.auto_news.enabled is true,
  `https://nfs.faireconomy.media/ff_calendar_thisweek.json` (GET, nothing is sent).

### 3.2 Config (agent_config.json)
```json
{
  "supabase_url": "https://xxxx.supabase.co", "anon_key": "...",
  "email": "me@example.com", "refresh_token": "...",          // written by `login`, never printed
  "bot_id": "uuid", "bot_name": "Main PC",
  "common_dir": null,
  "limits": {"allow_remote_control": true, "allow_remote_live": false, "allow_remote_params": false,
             "max_lots": 0.10, "max_daily_cap_pct": 10.0},
  "telegram": {"token": "", "chat_id": "", "events": ["open","close","lock","cap","offline","live","error","daily"]},
  "poll_seconds": 5
}
```
### 3.3 Commands
- `setup` — asks URL + anon key (+ common dir check), writes config.
- `login` — asks email and password (getpass; the user types them), stores only the refresh token.
- `register --name "Main PC"` — reads the current status/control file, builds `desired` from it (live =
  not status.flags.live_locked and control mode run), calls `register_bot`, stores bot_id. Refuses if already registered
  unless `--force`.
- `run` — the loop (3.4). `--once` does one cycle (for tests). `--dry-run` never writes the EA files and never uploads.
- `status` — prints config (redacted), limits, last applied version, EA heartbeat age.
- `limits --allow-live on|off --allow-params on|off --allow-control on|off --max-lots X --max-cap Y` — local only.
- `test-telegram` — sends a test message.

### 3.4 Loop (every poll_seconds; network errors back off to 60 s and never touch the EA files)
1. Refresh the access token when < 60 s left.
2. Status: read `dobby2_status.json`; if `heartbeat_gmt_unix` changed, upsert `bot_status` (at most every 10 s).
   Update `bots` (last_seen, agent_version, ea_version, symbol, server_utc_offset_min, agent_state) at most every 30 s.
   server_utc_offset_min = round((parse(status.server_time) as UTC epoch - heartbeat_gmt_unix) / 900) * 15.
3. Journal: parse `dobby2_journal.csv` (header `time_server,event,tag,side,lots,price,sl,tp,pnl,v_balance,step,detail`,
   detail may be quoted with commas); line_hash = sha1 of the raw line; insert unseen rows in batches of 500 with
   `Prefer: resolution=ignore-duplicates`; remember hashes locally.
4. Control: GET `bot_control?bot_id=eq.<id>&select=version,desired,updated_at`. If version > last applied:
   validate against limits (3.5), write files (3.6/3.7) only if the content changed, set last applied, log a line in
   agent_decisions.log, alert. If remote control is disabled locally, do not write and report `remote_control_disabled`.
5. Local change adoption: if `dobby2_control.txt` was modified by someone else (its `id=` does not start with `W` and the
   file mtime is newer than the agent's last write), the agent PATCHes bot_control.desired.control/blackouts to match the
   file (keeps live/params), note "local change", so the web shows the truth. It never adopts a change that would turn
   live on.
6. Alerts (Telegram, if configured): new journal rows OPEN / CLOSE (with pnl) / LOCK / LOCK1 / ERROR, cap hit
   (virtual.day_cap_hit false->true), EA offline (heartbeat older than 120 s while the agent runs) and back online,
   live switched on/off (applied), daily summary at server 23:30. Thai text. One message per event, rate-limited.

Agent 1.2.0 additions (SPEC 9), in this order inside the online part of the cycle: step 4 also builds the automatic
blackouts (9.3) and writes them into the control file with the manual ones; step 5 never adopts the agent's own
automatic lines; then 7. bars upload (9.1); 8. deposit / withdrawal suggestion (9.2); then the bots row. Steps 7 and 8
come after the control step, so they can never delay or block it: a 4xx answer (e.g. the table does not exist because
schema.sql was not re-run yet) only adds a warning (`bars_upload_failed` / `cash_flow_failed`) and that upload is
retried after 10 minutes; a network error backs off like every other network error.

### 3.5 Validation against local limits
- `allow_remote_control=false` -> nothing is written.
- live: if desired.live is true and `allow_remote_live=false` -> treat as live=false? NO: keep the last applied live value
  and report `live_not_allowed_locally` (the web shows it). live=false is ALWAYS honoured (safe direction).
- control.lots > max_lots -> clamp to max_lots and report. params lots (InpLots*, InpMaxLots, InpLotsAsia) > max_lots ->
  reject the params block, report. InpDailyCapPct > max_daily_cap_pct -> reject the params block, report.
- params only when `allow_remote_params=true`; otherwise reported `params_not_allowed_locally`.
- Unknown params keys (not in the allow-list of 4.2) -> reject the params block.

### 3.6 Control file (works with EA v3.03 and v3.04) — same format as monitor/dobby2_control.py
UTF-8, CRLF, written to `<file>.tmp` then `os.replace`:
```
# Dobby control file, written 2026-11-07 10:00:00 by dobby_agent (web v17)
mode=pause
lots=0.08
allow_long=1
allow_short=0
max_spread=0.60
blackout=2026.11.10 15:00-16:30
blackout=2026.11.10 23:00-2026.11.11 01:00
id=W017
note=web: <note>
```
- `mode=pause` when desired.live is false OR desired.control.mode == 'pause'; else `mode=run`. (With v3.03 this is how
  the web "live switch" works: InpAllowLive is ticked once locally and the bot is paused/resumed.)
- `lots`, `max_spread` only when set (not null). `allow_long/allow_short` as 1/0.
- Blackouts: desired.blackouts[].from_utc/to_utc converted to server time with server_utc_offset_min; past windows
  (to < now) dropped; end on another server day written as a full datetime.
- `id=W<version zero-padded 3>`.
- agent_state reported to `bots.agent_state`: {agent_version, applied_version, applied_at, limits, rejected: [codes],
  last_error, ea_heartbeat_age_s, control_file_id, remote_file_version}. Also present: reject_details, warnings
  (codes: offset_unconfirmed, offset_unknown, bad_blackout; 1.2.0: auto_news_invalid, schedule_invalid,
  bars_upload_failed, cash_flow_failed), offset_source, bars (SPEC 8), and the 9.3 keys (auto_blackouts, news,
  news_fetched_at, news_error).
- Since 1.2.0 the blackout lines are the manual desired.blackouts plus the automatic windows of 9.3 (sorted by start,
  at most 100 lines, manual lines first when the limit is reached).

### 3.7 Remote file `dobby3_remote.txt` (read only by EA v3.04)
Written when `allow_remote_live` or `allow_remote_params` is true. UTF-8, CRLF, atomic:
```
# Dobby3 remote parameters, written 2026-11-07 10:00:00 by dobby_agent (web v17)
version=17
live=1                 (only if allow_remote_live; 1/0)
InpLotsA=0.10          (only if allow_remote_params and desired.params is not null; allow-listed keys only)
...
```
Bools written as true/false, numbers with `.`.

## 4. EA v3.04 (D:\Dobby\mt5\Dobby3_v304.mq5, private; = v3.03 + remote)

### 4.1 New inputs (group "v3.04 remote (web)") — local only, never remotely changeable
```
input bool   InpRemoteParams    = false;   // Accept parameter changes from Common\Files\Dobby\dobby3_remote.txt
input bool   InpRemoteLive      = false;   // Let the remote file switch live trading on/off (replaces the InpAllowLive tick)
input double InpRemoteMaxLots   = 0.10;    // Ceiling for every lot the remote file may set
input double InpRemoteMaxCapPct = 10.0;    // Ceiling for InpDailyCapPct from the remote file
```
With both bools false (default) v3.04 behaves exactly like v3.03 (tester parity required).

### 4.2 Remote allow-list (keys = EA input names) and EA-side bounds
```
InpUseA InpUseNY InpUseC5G InpUseAsia                         bool
InpLotsA InpLotsNY InpLotsC5G InpMaxLots InpLotsAsia           0.01 .. InpRemoteMaxLots (NormLots)
InpRecoveryMult                                               1.0 .. 2.0
InpMaxAttempts                                                1 .. 4
InpConfluenceMult                                             1.0 .. 2.0
InpConfluenceMin                                              0 .. 240
InpDailyCapPct                                                1 .. InpRemoteMaxCapPct
InpKillBalance                                                >= 0
InpVirtualStart                                               > 0   (history recomputed)
InpMaxSpread                                                  0.05 .. 2.0
InpVolGate                                                    bool
InpVolGatePct                                                 0.5 .. 5.0
InpLockEnable InpLock_A InpLock_NY InpLock_C5G InpLockShadow InpLock1Enable   bool
InpLockAtPct                                                  50 .. 99.5
InpLockToPct                                                  1 .. InpLockAtPct - 0.5
InpLock1AtPct                                                 0 or 10 .. InpLockAtPct - 0.5
InpLock1ToPct                                                 1 .. min(InpLock1AtPct, InpLockToPct) - 0.5
```
Strategy geometry (SL caps, TP ratios, pivots, NY times, C5G touch, magics, start date, AllowLive, UseControl) is NOT
remote: the website edits them only in presets exported as .set for a manual load.

### 4.3 Behaviour
- Read the file when its modify date changes (like ReadControl), every timer tick.
- Parse all lines; if any key is unknown or out of bounds (after the cross-checks above) -> reject the WHOLE version:
  journal `REMOTE REJECT v<n>: <reasons>`, keep the current values.
- `live` (only if InpRemoteLive) applies immediately: allowLive = live==1. Without a `live` line, allowLive = InpAllowLive.
  UpdateGate uses allowLive instead of InpAllowLive. Journal `REMOTE LIVE on/off`.
- Params (only if InpRemoteParams) apply only when the bot is flat: no open position and no pending order with any of
  the bot's magics. Until then status shows pending=true, waiting="open position"/"pending order"; journal
  `REMOTE WAIT v<n>` once. On apply: journal `REMOTE APPLY v<n>: key old->new, ...`; recompute history if
  InpVirtualStart changed; refresh module enables.
- Implementation: every allow-listed input gets a runtime global (e.g. `P_LotsA`) initialised from the input in OnInit;
  all code uses the global. Inputs not on the list stay as they are.
- Status JSON: schema_version 5, add block
  `"remote":{"params_enabled":b,"live_enabled":b,"file_exists":b,"version":n,"applied_version":n,"pending":b,
  "waiting":"...","live":b|null,"rejects":"...","ceilings":{"max_lots":x,"max_cap_pct":y},"effective":{<every allow-listed key: value>}}`.
  Existing fields unchanged (the agent and web must keep working with schema 4).

## 5. Website (docs/)
Project: https://rpzuzhefviydjmeggvvz.supabase.co with a publishable key (`sb_publishable_...`, public by design; send
it in the `apikey` header only, never as `Authorization: Bearer`; user calls carry the user's access token as Bearer).
Vanilla JS ES modules, no build. Pinned CDN: `https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/+esm`,
`https://cdn.jsdelivr.net/npm/chart.js@4.4.1/+esm`. Thai UI (English labels for EA keys). Mobile-first, dark/light.
Times shown in Thai time (Asia/Bangkok) with server time on hover where relevant.

Caching (added 2026-11-07): GitHub Pages lets browsers keep each file for 10 minutes, so a new page module could meet an
old cached `util.js` ("does not provide an export named ..."). `docs/index.html` therefore carries an import map that
sends every `js/**/*.js` to `?v=<sha256 of its content>`, the stylesheet link has the same, and the app starts from an
inline module so `app.js` also goes through the map. `tools/stamp_versions.py` writes that block (`--check` fails when it
is stale); run it before every commit that touches docs/. Safety net: when a page's files fail to load, the page reloads
once from a fresh address (`?_r=<time>`, removed again on load), at most once a minute; otherwise it shows "เว็บเพิ่ง
อัปเดต" with a reload button.

`js/api.js` exports one interface implemented twice: `SupabaseApi` (real) and `DemoApi` (in-memory synthetic data,
generated in js/demo.js; NO real account data in the repo). Demo mode when config is empty or `?demo=1`.

Pages (hash router):
1. **Login / Sign up** (email+password; sign-up asks the invite code; after sign-in an unapproved user sees "enter
   invite code"). Forgot password (Supabase reset email).
2. **Dashboard** — bot selector; online badge (bots.last_seen < 60 s and EA heartbeat < 120 s); balance, equity,
   virtual, day P&L vs daily cap (progress bar), open positions (side, lots, entry, SL, TP, live P&L, % to TP / SL from
   status.market), module table, NY range/state, lock settings, last event/error; **Live switch** (on/off with the
   re-auth + 2FA modal for ON; shows agent rejections such as live_not_allowed_locally); Pause/Resume; quick
   "blackout next 2 h". Realtime updates.
3. **History** — journal table (filters: date range, module, event), paired trades (OPEN -> CLOSE per module in time
   order), equity curve (v_balance of CLOSE rows), daily P&L calendar heatmap, per-module stats (trades, win rate, net,
   avg win/loss, profit factor, best/worst), CSV export.
4. **Control** — mode, sides, lots (lower only), max spread, blackouts list (add with Thai-time pickers, presets "NFP /
   CPI / FOMC −30/+90 min", delete), note; shows desired vs applied (agent_state.applied_version) and rejects.
5. **Presets** — list/create/duplicate/delete; create from template, from .set import (UTF-16LE parse), or from the bot's
   live values; grouped form of ALL EA inputs (js/params.js: key, group, type, default, min, max, step, remote,
   advanced, Thai label, help) with validation; diff vs live; export .set (UTF-16LE BOM, `key=value||value||0||value||N`,
   bools `key=true||false||0||true||N`); "Apply to bot" = write desired.params with the remote keys (non-remote keys
   listed as "load the .set locally"); **lot calculator** (balance + lot -> scaled r37 numbers, see 5.1).
6. **News** — upcoming news_events in Thai time; one-click blackout per bot (default −30/+90 min); admin can add/edit.
7. **Users** (admin) — admin_overview, create invite (role, days, note) with copy button, list/revoke invites, set
   role/approve/disable.
8. **Downloads & setup** — files from the `downloads` bucket (admin upload), Thai step-by-step guide for a friend's PC
   (MT5, EA, preset, Python, agent setup/login/register/run, Algo Trading button), shows SUPABASE_URL/anon key to copy.
9. **Audit** — audit rows for the user's bots and presets.
10. **Settings** — display name, change password, 2FA (TOTP enroll with QR, unenroll), theme.

### 5.1 Lot calculator data (from research r37, live-scale 0.03 lot on a 280 balance, 2025-01 .. 2026-10)
30-day horizon from 280: lot -> median, p10, p90, P(balance <= 140):
0.03 +151.79 / -151.36 / +487.86 / 28.7 %; 0.04 +135.40 / -229.53 / +663.16 / 40.2 %; 0.05 +132.42 / -292.65 / +776.21 /
41.4 %; 0.06 +90.37 / -299.85 / +899.49 / 50.6 %; 0.08 +31.98 / -301.55 / +1012.44 / 60.9 %.
Daily P&L at 0.03 lot on 280: losing days 41 % of days; losing-day mean -30.6, median -26.2, p10 -56.4, p5 -65.3,
worst -96.9; 1 in 3 losing days exceeds the 10 % cap. Scaling: equivalent lot at 280 = lot x 280 / balance; money x
balance / 280; interpolate the table on the equivalent lot; outside 0.03 .. 0.08 show "outside the tested range".
Always show the disclaimer: past simulation, not a forecast; 2025-like market much worse than 2026.

## 6. Ownership of the EA control file
With the agent running, the website is the main way to change the bot. `monitor/dobby2_control.py` keeps working
(its changes are adopted by the agent, 3.4 step 5).

## 7. Simple bot settings (shared by the website and the app; added 2026-11-07 after user feedback)
Goal: a friend never sees EA input names unless they open "ขั้นสูง". Both UIs show the SAME model and the same Thai labels.

### 7.1 Bot catalog
One entry today: **Dobby** — "บอททอง XAUUSD กราฟ 15 นาที 3 สูตร (A_new, NY, C5G) + ASIA16 เสริม". The UI shows it as a
card the user picks ("ใช้ Dobby"); the list is ready for more bots later (no DB change: the kind is implied).

### 7.2 Simple settings -> EA keys (all keys are on the SPEC 4.2 remote allow-list)
| simple field (Thai label) | EA keys |
|---|---|
| ทุนในบัญชี (USD) | InpVirtualStart |
| สูตร A_new / NY / C5G เปิด-ปิด | InpUseA / InpUseNY / InpUseC5G |
| ล็อตรวม (ทุกสูตรเท่ากัน) **or** แยกล็อตแต่ละสูตร | InpLotsA / InpLotsNY / InpLotsC5G; InpMaxLots = the largest module lot |
| สูตรเอเชีย (ASIA16) เปิด-ปิด, ล็อต | InpUseAsia, InpLotsAsia |
| ล็อกกำไร: ไม่ล็อก / 1 ชั้น (ใกล้ TP) / 2 ชั้น | 0: InpLockEnable=false, InpLock1Enable=false; 1: InpLockEnable=true (At/To), InpLock1Enable=false; 2: both on |
| ชั้นใกล้ TP: ถึง X% ของ TP → เลื่อน SL ไป Y% | InpLockAtPct / InpLockToPct |
| ชั้นแรก: ถึง X% ของ TP → เลื่อน SL ไป Y% | InpLock1AtPct / InpLock1ToPct (must be below the near-TP stage) |
| ขาดทุนสูงสุดต่อวัน (% ของทุน) | InpDailyCapPct |
| ขั้นสูง: recovery ×, จำนวนครั้งต่อวัน, confluence ×/นาที, spread สูงสุด, vol gate | InpRecoveryMult, InpMaxAttempts, InpConfluenceMult/Min, InpMaxSpread, InpVolGate/Pct |
Strategy geometry (SL/TP caps and ratios, NY times, ...) is not shown in the simple editor at all.

### 7.3 "ตั้งให้อัตโนมัติจากทุน" (auto from balance B)
- module lot L = max(0.01, floor(B / 100) / 100), capped at 0.50 (300 -> 0.03, 1000 -> 0.10, 150 -> 0.01)
- A_new, NY, C5G on with lot L; ASIA16 off (lot 0.01); InpMaxLots = L; InpVirtualStart = B
- locks: 2 stages — first 85 -> 83, near TP 95 -> 93 (the owner's live choice on 2026-11-07)
- recovery 1.5, attempts 4, confluence 1.5 / 60 min, daily cap 10 %, max spread 1.00, vol gate off
- shown next to it: the lot-calculator estimate (SPEC 5.1) for B and L, in one plain sentence + "ดูรายละเอียด"
- the PC's local max lots default = min(0.50, max(0.02, 2 x L)); local max daily cap = 10

### 7.4 Applying
- Website "ตั้งค่าบอท": shows what the bot uses NOW (status.remote.effective for EA v3.04; for v3.03 the fields it can
  read from status.params/options, marked "อ่านอย่างเดียว — บอทนี้เป็น v3.03"), lets the user edit with toggles/steppers,
  and "บันทึกและส่งให้บอท" PATCHes bot_control.desired.params with the full set of remote keys. Progress shown in 3 steps:
  ส่งแล้ว -> เครื่องรับแล้ว (agent_state.applied_version) -> EA ใช้ค่าใหม่แล้ว (status.remote.applied_version /
  effective matches; "รอให้ไม่มีไม้ค้าง" while status.remote.pending).
- App wizard: creates the bot with desired = {live: true, control: {mode: "run"}, params: <the chosen settings>} and turns
  on the local limits allow_remote_control/live/params (explained in one sentence; the user can untick).
- The generic MT5 preset for EA v3.04 that every friend loads: "Dobby3_v304_web.set" = EA defaults + the 7.3 values for
  B = 300 + InpRemoteParams=true, InpRemoteLive=true, InpRemoteMaxLots=0.50, InpRemoteMaxCapPct=10, InpAllowLive=false.
  The web settings replace its lots/balance/locks as soon as the EA is flat.

## 8. Price bars for the dashboard chart (added 2026-11-07)
The agent adds the EA's recent M15 bars to `bots.agent_state.bars` (no DB change):
`{"tf": "M15", "t": [utc_epoch_seconds...], "c": [close...], "vwap": [vwap or null...]}` — the last 96 bars (24 h) from
`dobby2_bars.csv` (columns bar_time (server time), decision_time, close, ..., vwap at index 14 when present). Bar times
are converted with the confirmed server offset; while the offset is unknown, `bars` is omitted. The website draws the
price line and places the journal's OPEN / CLOSE rows on it. Demo mode generates synthetic bars.

## 9. Feature batch 2026-11-07 (trade detail, cash flows, auto blackouts, health, summary, risk, notes)
No EA change. Agent 1.2.0 + DobbyApp rebuild, new tables in schema.sql (idempotent, same RLS pattern: the approved owner
writes, the admin reads everything, members read only their own), website pages. Push notifications (9.7) were built
and then removed on 2026-11-08.

### 9.1 Price history: table `bars`
```
bars  bot_id uuid -> bots on delete cascade, t timestamptz not null (bar open time, UTC), close numeric not null,
      vwap numeric, primary key (bot_id, t)
```
RLS: select = approved owner of the bot or admin; insert (and update, for upsert) = approved owner of the bot. No
client delete (cascade only). Not in realtime.
Agent: uploads `dobby2_bars.csv` rows (column 0 bar_time server time -> UTC with the confirmed / configured server
offset; column 2 close; column 14 vwap when present and > 0) incrementally, like the journal: remembers the newest
uploaded t in agent state; first run backfills at most the last 45 days; batches of <= 500 rows, `on conflict do
nothing` (Prefer: resolution=ignore-duplicates). Skipped entirely while the offset is unknown (same rule as SPEC 8).
`agent_state.bars` (SPEC 8) stays as it is.
Implementation (agent 1.2.0): incremental by byte position in the file (agent_state.json `bars_upload.pos`, like the
journal: a half-written last line waits, a file that shrank is read again from the start) plus the newest uploaded t
(only rows with last_t < t <= now + 1 h are sent). Rows: `{bot_id, t: "YYYY-MM-DDTHH:MM:SSZ", close, vwap | null}`.
Each row is converted with the offset in force when it is uploaded, so live uploads are exact; the first 45-day
backfill converts every row with the current offset (rows from before a server DST switch can be 1 h off).
Website: the trade page reads `bars` for [open - 3 h, close + 1 h] (fallback: agent_state.bars when the window is in
the last 24 h).

### 9.2 Deposits and withdrawals: table `cash_flows`
```
cash_flows  id bigserial pk, bot_id uuid -> bots on delete cascade, ts timestamptz not null,
            amount numeric not null check (amount <> 0)            -- + deposit, - withdrawal (account currency)
            source text not null check (source in ('auto','manual')),
            status text not null default 'confirmed' check (status in ('suggested','confirmed','dismissed')),
            balance_after numeric, note text, created_at timestamptz default now(), updated_at timestamptz default now()
```
RLS: approved owner of the bot select / insert / update / delete; admin select. Audited like presets
(`cash_flow_insert/update/delete`).
Agent detection (suggestions only; the owner confirms on the website): it keeps the last account balance from the
status file and the sum of Dobby CLOSE pnl ingested since. On a balance change, unexplained = new - old - sum(pnl). If
|unexplained| >= max(10, 0.5 % of old) AND it is still unexplained one cycle later (the CLOSE row can arrive a cycle
after the balance), insert {ts: now, amount: round(unexplained, 2), source: 'auto', status: 'suggested',
balance_after: new, note: 'balance change not explained by Dobby trades'}. Then reset the baseline. Manual trades by
the owner also produce suggestions; the website lets the owner dismiss them ("เทรดมือ / ไม่ใช่เงินฝาก").
Implementation (agent 1.2.0): only a fresh (heartbeat <= 120 s), connected status counts; the baseline is the first
such balance; CLOSE pnl is summed for journal rows read after the baseline (never the first-run history). "One cycle
later" = the next cycle AND at least 15 s after the change was first seen; the amount inserted is the unexplained value
at that moment. A change below the threshold just moves the baseline. A refused insert keeps the suggestion and is
retried after 10 minutes (warning `cash_flow_failed`); `--dry-run` inserts nothing. DB: note <= 1000 characters;
created_at / updated_at are set by the server.
Website: "เงินฝาก-ถอน" list (confirm / dismiss suggestions, add / edit / delete manual rows). Since-start P&L and
monthly return exclude confirmed flows (trading P&L = equity change - net flows; monthly % by modified Dietz). After a
confirmed flow it offers, owner only: "ปรับทุนตั้งต้นของบอท" = PATCH desired.params.InpVirtualStart += amount (EA
v3.04 remote params, normal version check), and shows the SPEC 7.3 lot for the new balance as a suggestion.

### 9.3 Automatic blackouts: `desired.auto_news` and `desired.schedule`
New optional keys of bot_control.desired (owner PATCH with the version check; they never touch `live`, so no live gate):
```
"auto_news": {"enabled": true, "before_min": 30, "after_min": 60, "currencies": ["USD"], "impact": ["High"]}
"schedule":  {"enabled": true, "us_holidays": true,
              "weekly": [{"dow": 5, "from": "21:00", "to": "24:00"}]}   -- Thai time (UTC+7), dow 1 = Monday .. 7 = Sunday,
                                                                          -- "24:00" = end of day; no new entries inside
```
Bounds: before/after 0..240 min; weekly <= 14 windows, from < to. Missing / enabled=false = off (default off).
Agent: fetches `https://nfs.faireconomy.media/ff_calendar_thisweek.json` at most every 4 h (cached in the agent folder;
keep the last good copy on errors; User-Agent "DobbyAgent/1.2"), keeps events whose country is in `currencies` and
impact in `impact`, makes windows [t - before, t + after]; adds schedule windows for the next 7 days and whole US
market holidays (NYSE closed days, 00:00-24:00 New York time; table for 2026-2027 in the agent); merges overlaps; drops
past windows. These AUTO windows are written to the control file together with the manual desired.blackouts, but the
agent remembers which lines it generated and NEVER syncs them back into desired.blackouts (SPEC 3.4 back-sync applies to
manual lines only). Reports in agent_state:
- `news`: this week's matching events `[{"title", "ts_utc", "currency", "impact", "forecast", "previous"}]`
- `auto_blackouts`: next 7 days `[{"from_utc", "to_utc", "reason"}]` (reason = event title(s), "ตารางเวลา", or the
  holiday name)
- `news_fetched_at` (UTC ISO) or `news_error`

Implementation (agent 1.2.0):
- The calendar is fetched only while auto_news is enabled (no third-party request otherwise). After a failed fetch the
  next try is 30 min later; when every event of the cached week is over, every 2 h (the new week appears on Sunday).
  Timeout 15 s, at most 2 MB, it must be a JSON list of events (ForexFactory's HTML "Request Denied" page is an error).
- Validation: `enabled` must be JSON true; before_min / after_min integers 0..240; currencies a list of 1..20 three-
  letter codes; impact a list of High / Medium / Low / Holiday (any case). An invalid field is ignored (the value of
  the example above is used) with the warning `auto_news_invalid`. An invalid weekly window (dow 1..7, "HH:MM",
  from < to, "24:00" only as `to`) is skipped, windows after the 14th are dropped, a non-boolean `us_holidays` counts as
  false -> warning `schedule_invalid`. A non-object value or a non-boolean `enabled` = off + the warning.
- News windows are [t - before, t + after] (zero-length ones skipped). Schedule windows are built for the Thai dates
  today .. today + 8 and kept when they overlap [now, now + 7 days]; holiday windows come from the NYSE 2026-2027 table
  (New York EDT from the day after the second Sunday of March through the first Sunday of November). Overlapping or
  touching windows are merged, reasons joined with ", ". Whole windows are written (never trimmed to the horizon), so
  the file only changes when a window appears or ends.
- auto_blackouts items also carry `kinds`: a list of "news" | "schedule" | "holiday". `news` = this week's matching
  events, past ones included, at most 60. `news_fetched_at` = the time of the copy in use; `news_error` is present when
  the last fetch failed or there is no copy yet (both keys can be present). While auto_news is off, news /
  news_fetched_at / news_error are absent; while both features are off, auto_blackouts is absent too.
- The agent keeps its own automatic lines in agent_state.json (`control.auto_lines`, until a day after they end). When a
  local tool edits the control file, those windows (compared as time windows, not as text) are removed before the
  adoption of SPEC 3.4 step 5, except one that equals a manual desired.blackouts window. `register` and the app's
  new-bot registration never seed them either.
- While the server offset is unknown no blackout line is written (warning `offset_unknown`); auto_blackouts is still
  reported (UTC).
- Dobby App 1.2.0 (same agent code): the main screen shows the running or next automatic window ("งดเข้าไม้อัตโนมัติ
  ครั้งถัดไป พรุ่งนี้ 20:00–21:30 (CPI m/m)") and the activity list notes when the windows change.

Website: in ตั้งค่าบอท > งดเข้าไม้: the two switches with their settings (steppers for before/after; presets "ไม่เทรด
คืนวันศุกร์" = Fri 21:00-24:00, custom weekly rows, US holidays), and the list of upcoming auto windows from
agent_state.auto_blackouts. ข่าว shows agent_state.news when present (merged with news_events, de-duplicated).

### 9.4 Strategy health (website only)
Baseline = EA tester run 2026-07-15 .. 2026-10-22 (v3.04, 209 closed trades), per 0.01 lot:
| strategy | trades | win rate | avg win | avg loss | profit factor | trades / week | expectancy |
|---|---|---|---|---|---|---|---|
| A_new | 37 | 51.4 % | +8.78 | -6.00 | 1.54 | 2.64 | +1.59 |
| NY | 76 | 60.5 % | +7.88 | -8.00 | 1.51 | 5.43 | +1.61 |
| C5G | 96 | 47.9 % | +10.68 | -7.23 | 1.36 | 6.86 | +1.35 |
Live, per strategy, from the journal's CLOSE rows (pnl / lots x 0.01): the last 20 trades (or all if fewer; nothing
judged below 8). Status:
- "ปกติ" when the live win count is plausible (binomial P(X <= wins | n, baseline) >= 0.10) and live PF >= 1.0
- "จับตา" when P < 0.10 or PF < 1.0
- "ผิดปกติ" when P < 0.02 or PF < 0.7 (the website suggests pausing that strategy; it never changes anything itself)
Shown with plain sentences, the baseline next to the live numbers and the "past simulation, not a forecast" note.

### 9.5 Summary, risk, schedule view (website only)
- สรุป (week / month): trading P&L (flows excluded), trades, win rate, best / worst trade, per strategy, vs the previous
  period; printable (print stylesheet -> the browser's "Save as PDF"). No e-mail (needs a mail service; not built).
- Risk panel: drawdown from the peak of v_balance (current and max in the period), current losing streak and the
  longest, today's loss budget used = -day_pnl / (cap % x day_start) from status.virtual.

### 9.6 Trade notes: table `trade_notes`
```
trade_notes  bot_id uuid -> bots on delete cascade, trade_key text not null, note text,
             tags text[] not null default '{}', updated_at timestamptz default now(), updated_by uuid default auth.uid(),
             primary key (bot_id, trade_key)
```
trade_key = `<tag>|<open ts_server as YYYY-MM-DD HH:MM:SS>` of the trade's OPEN journal row. RLS: approved owner of the
bot all; admin select. Website: note + tags on the trade page, tag filter in ประวัติ > รายการเทรด. Suggested tags:
ช่วงข่าว, ปิดเอง, เลื่อน SL เอง, ตลาดผันผวน.
DB (2026-11-07): trade_key 1..200 characters, note <= 5000, at most 30 tags; updated_at / updated_by are set by the
server on every insert / update (upsert with on_conflict=bot_id,trade_key works). Not audited.

### 9.7 Push notifications: removed (2026-11-08)
Built on 2026-11-07 (service worker, `push_subscriptions`, Edge Function `notify`, push.sql with pg_net + pg_cron) and
removed the next day: the site owner chose not to do the one-time Supabase setup. Nothing of it remains: the website
unregisters the old service worker, and schema.sql drops `push_subscriptions`, `register_push_subscription` and
`bots.offline_notified_at` if an earlier run created them. The web manifest and icons stay (home-screen name and icon).
Telegram alerts from the agent (agent/README_TH.md) are unchanged.
