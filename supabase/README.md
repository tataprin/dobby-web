# Dobby Web - database (Supabase)

Files:

| file | what |
|---|---|
| `schema.sql` | the whole database: tables, RLS, RPCs, triggers incl. the live gate, realtime, storage bucket, news seed, bootstrap admin invite. One file, safe to run again. |
| `seed_news.sql` | tier-1 US news (NFP, CPI, FOMC decision + press conference) from 2026-11-01, in UTC. Already included at the end of `schema.sql`. |
| `tests/` | PGlite (Postgres in WebAssembly) tests with stubbed Supabase `auth` / `storage` / realtime. `npm test`. |

---

## ภาษาไทย (สั้น ๆ)

### ติดตั้ง schema
1. เปิดโปรเจกต์ใน Supabase -> เมนู **SQL Editor** -> **New query**
2. เปิดไฟล์ `supabase/schema.sql` คัดลอก **ทั้งไฟล์** ไปวาง แล้วกด **Run**
   (ถ้า Supabase เตือนว่ามีคำสั่ง destructive เช่น `drop policy` ให้กด *Run this query* ได้ - ไฟล์นี้ไม่ลบข้อมูลของคุณ
   สิ่งเดียวที่ลบคือตารางแจ้งเตือนที่เลิกใช้แล้ว ถ้าเคยมี)
3. ผลลัพธ์บรรทัดสุดท้ายคือ **bootstrap_admin_invite** = รหัสเชิญแอดมิน 10 ตัว (เช่น `7FKEKYJUVZ`) อายุ 7 วัน
4. ไปที่เว็บ https://tataprin.github.io/dobby-web/ -> สมัครด้วยอีเมล + รหัสผ่าน -> ใส่รหัสเชิญนี้ -> คุณจะเป็น **admin**
5. รันไฟล์ซ้ำได้ทุกเมื่อ (เช่นตอนอัปเดต) ข้อมูลเดิมอยู่ครบ ถ้ามีแอดมินแล้ว ผลลัพธ์จะบอก `admin already exists`

### อัปเดตชุด 2026-11-07 (ต้องรัน schema.sql ใหม่ 1 ครั้ง)
ชุดนี้เพิ่มตาราง `bars` (กราฟราคาย้อนหลัง), `cash_flows` (เงินฝาก-ถอน), `trade_notes` (โน้ตของแต่ละไม้)
(การแจ้งเตือนเข้ามือถือเลิกใช้แล้วเมื่อ 2026-11-08 ไม่ต้องตั้งค่าอะไรเพิ่ม)
1. SQL Editor -> New query -> วาง `schema.sql` **ทั้งไฟล์** (ไฟล์ล่าสุด) -> Run (ยืนยัน destructive ได้ ไม่มีข้อมูลหาย)
2. ผลลัพธ์สุดท้ายจะเป็น `admin already exists - ...` = เรียบร้อย
3. ถ้ายังไม่รัน agent 1.2.0 / Dobby App 1.2.0 ก็ยังทำงานได้ปกติ แค่ยังไม่ส่งกราฟราคาและรายการเงินฝาก-ถอนขึ้นเว็บ
   (agent_state.warnings จะมี `bars_upload_failed` / `cash_flow_failed` และจะลองใหม่เองทุก 10 นาที)

**รหัส bootstrap คืออะไร:** รหัสเชิญพิเศษที่สร้างอัตโนมัติเมื่อยังไม่มีแอดมินและยังไม่มีรหัสเชิญแอดมินที่ใช้ได้
ใครใช้รหัสนี้ก่อนจะได้สิทธิ์แอดมิน ดังนั้น **อย่าส่งให้ใคร** ใช้เองทันที ถ้าหมดอายุ (7 วัน) ให้รัน `schema.sql` ใหม่ จะได้รหัสใหม่
หลังจากนั้นแอดมินสร้างรหัสเชิญเพื่อนได้ที่หน้า Users

### ตั้งค่า Auth ที่ต้องเช็ก (Authentication)
- **Sign In / Providers -> Email**: เปิด Email provider
  - *Confirm email*: **เปิด** (แนะนำ: ต้องกดลิงก์ยืนยันในอีเมลก่อนล็อกอิน) หรือ **ปิด** (ง่ายกว่าสำหรับเพื่อน แต่ใครก็สมัครด้วยอีเมลมั่วได้ - ก็ยังไม่เห็นอะไรจนกว่าจะใส่รหัสเชิญ)
  - ไม่ต้องปิด "Allow new users to sign up" - คนที่สมัครแต่ไม่มีรหัสเชิญจะไม่เห็นข้อมูลใดเลย (RLS)
- **URL Configuration**:
  - *Site URL* = `https://tataprin.github.io/dobby-web/`
  - *Redirect URLs* เพิ่ม `https://tataprin.github.io/dobby-web/**` (ใช้กับลิงก์ยืนยันอีเมลและลืมรหัสผ่าน)
- **Multi-Factor**: ให้ TOTP เปิดอยู่ (ค่าเริ่มต้น) เพื่อใช้ 2FA ในหน้า Settings
- คีย์ที่ใส่ในเว็บและ agent คือ **anon / publishable key เท่านั้น** ห้ามใช้ `service_role` key ที่ไหนเลย

### ความปลอดภัยของการเปิด Live
การเปลี่ยน `desired.live` จาก false เป็น true ต้องล็อกอินด้วยรหัสผ่านใหม่ภายใน 5 นาที และถ้าเปิด 2FA ต้องยืนยัน 2FA (aal2)
ตรวจในฐานข้อมูลเอง (trigger) ไม่ใช่แค่ในหน้าเว็บ การปิด Live (true -> false) ทำได้เสมอ

---

## English (short)

### Apply
SQL Editor -> New query -> paste the whole `schema.sql` -> Run (confirm the "destructive operations" prompt; nothing
is dropped except policies/triggers that are re-created). The last result row is the **bootstrap admin invite**.
Sign up on the website, enter the code, you are admin. Re-run any time; data is kept.

### Bootstrap code
Created only when there is no active admin and no usable admin invite. 10 chars (A-Z, 2-9, no I/O/0/1), admin role,
valid 7 days. Whoever redeems it first becomes admin: use it yourself right away. Expired? Run `schema.sql` again.

### Auth settings to check
- Email provider on. *Confirm email* on (recommended) or off (simpler; unapproved accounts still see nothing).
- Site URL `https://tataprin.github.io/dobby-web/`; Redirect URLs `https://tataprin.github.io/dobby-web/**`.
- MFA: TOTP enabled (default).
- Only the anon/publishable key goes into `docs/js/config.js` and the agent. Never the service_role key.

### Feature batch 2026-11-07
Re-run the whole `schema.sql` once (new tables `bars`, `cash_flows`, `trade_notes`). Push notifications were removed on
2026-11-08: the file drops `push_subscriptions`, `register_push_subscription` and `bots.offline_notified_at` if a run
of the 2026-11-07 version created them. Agent 1.2.0 keeps working before that; it only warns and retries its bars / cash-flow
uploads every 10 minutes.

### Run the tests
```
cd supabase/tests
npm install
npm test
```

---

## Design notes (for the agent and website builders)

**Live gate (SPEC 2.4) - how it is enforced.** `bot_control_before` is a BEFORE INSERT/UPDATE trigger, declared
SECURITY INVOKER so `current_user` is the role that runs the statement. Every request from the website or the agent
comes through the Supabase API as role `authenticated` (or `anon`). For those roles the trigger requires, on a
`false -> true` change of `desired.live` (missing/null counts as false):
(a) an `amr` entry with method `password`, `otp` or `totp` and a numeric `timestamp` >= now() - 300 s, else
`reauth_required`; (b) if the user has a row in `auth.mfa_factors` with status `verified`, JWT `aal` = `aal2`, else
`mfa_required`. `true -> false` and edits while live stays true are never gated. The same check is the RPC
`live_gate_status()` so the UI can ask first.

**register_bot insert path - why it is safe.**
1. Clients have **no INSERT privilege and no INSERT policy** on `bot_control`. The only way to create a row is
   `register_bot()`. (Upsert is an INSERT too, so it is refused as well.)
2. `register_bot()` is SECURITY DEFINER: inside it `current_user` is the function owner (`postgres`), not a client
   role, so the trigger does not gate that one insert. There is no session flag, setting or nonce a client could
   set to imitate it (`set_config(...)` changes nothing).
3. Defence in depth: if someone later grants INSERT by mistake, the trigger still gates any client insert with
   `live = true` (tested).
4. `register_bot()` always creates a NEW bot id. It cannot touch an existing bot's control row, and the PC agent is
   bound to the bot id stored in its local config, so a stolen web session cannot use it to switch a real PC live.
5. `postgres` (SQL editor) and `service_role` are not gated: they bypass RLS and could drop the trigger anyway; the
   website and agent never use them.

**Contract notes**
- `bot_control`: website and agent must **UPDATE (PATCH)** only, never insert/upsert. `version`, `updated_by`,
  `updated_at` are set by the trigger (client values are ignored); `bot_id` is immutable.
- `desired` must be a JSON object; `desired.live` must be a JSON boolean or null (CHECK constraint).
- `journal`: duplicates of `(bot_id, line_hash)` are skipped silently by a trigger, so a plain insert batch is fine.
  If you use PostgREST upsert, pass `?on_conflict=bot_id,line_hash` with `Prefer: resolution=ignore-duplicates`.
- `bot_status`: upsert with `?on_conflict=bot_id` and `Prefer: resolution=merge-duplicates`. `updated_at` is set
  to the server time on every write.
- `bots.last_seen`: when a client writes any value, the server stores `now()` (PC clocks drift). Do not put balances
  in `bots.agent_state` - the admin can read `bots`.
- Errors are raised with a short code as the message: `not_authenticated`, `not_approved`, `admin_only`,
  `invite_invalid`, `account_disabled`, `invite_not_found`, `role_invalid`, `days_invalid`, `user_not_found`,
  `cannot_demote_self`, `cannot_disable_self`, `name_invalid`, `desired_invalid`, `reauth_required`,
  `mfa_required`, `bot_id_immutable`.
- Audit actions: `control`, `preset_insert|update|delete`, `bot_delete`, `invite_redeem`, `profile_display_name`,
  `admin_create_invite`, `admin_revoke_invite`, `admin_set_user`, `admin_bootstrap_invite`. The admin's Audit page
  shows other users' `admin_*` / `invite_*` rows only (Spec addition 19); everyone sees their own bots and presets.
- News rows: `name` is one of `US NFP (Non-Farm Payrolls)`, `US CPI`, `FOMC rate decision`,
  `FOMC press conference`; `note` = `YYYY-MM-DD HH:MM ET (US Eastern); <code>; source: ...`.
- `bars` (SPEC 9.1): insert with `?on_conflict=bot_id,t` and `Prefer: resolution=ignore-duplicates` (the agent does);
  the first row for a bar wins. Read with a time range (`t=gte...&t=lte...`). No client delete.
- `cash_flows` (SPEC 9.2): `created_at` / `updated_at` are the server's. Every insert / update / delete writes an audit
  row `cash_flow_insert|update|delete` with the cash flow's `bot_id`, so the owner and the admin see it on the Audit
  page. The agent inserts `source='auto', status='suggested'`; the website confirms / dismisses by UPDATE.
- `trade_notes` (SPEC 9.6): upsert with `?on_conflict=bot_id,trade_key`; `updated_at` / `updated_by` are set by the
  server.
- Audit actions added: `cash_flow_insert`, `cash_flow_update`, `cash_flow_delete`.

---

## Spec additions

Things SPEC.md section 2 did not say, added here (nothing in the other parts' contracts was removed):

1. **bot_control has no client INSERT** (SPEC 2.3 said owner insert). `register_bot()` is the only insert path; this
   is what makes the register exemption of the live gate safe (see above). Website/agent only UPDATE it.
2. **Gate scope:** the live gate applies to client roles (`authenticated`, `anon`); `postgres` / `service_role` are
   trusted. On insert the trigger also forces `version = 1`, `updated_by = auth.uid()`, `updated_at = now()`.
   `bot_id` cannot be changed by an update (`bot_id_immutable`).
3. **CHECK on `bot_control.desired`:** JSON object; `live` absent, null or a JSON boolean.
4. **New RPCs:** `live_gate_status() returns text` ('ok' | 'reauth_required' | 'mfa_required') and
   `owns_bot(p_bot uuid) returns boolean`. Both security definer, stable, authenticated only.
5. **`admin_overview()` has an extra last column `email text`** (display names can collide). Still no balances.
6. **`admin_set_user`:** a null argument keeps the current value. Self-protection also blocks setting your own
   `approved = false`. Errors `cannot_demote_self`, `cannot_disable_self`, `user_not_found`, `role_invalid`.
7. **`redeem_invite`:** also removes inner spaces and dashes; a disabled caller gets `account_disabled` (code stays
   unused); creates the caller's profile if it is missing.
8. **`create_invite`:** `p_role` must be admin/member (`role_invalid`), `p_days` 1..365 (`days_invalid`).
9. **Validation:** `register_bot` name 1..100 chars, desired object (`name_invalid`, `desired_invalid`);
   `set_display_name` 1..60 chars (`name_invalid`).
10. **Extra audit rows:** `invite_redeem`, `profile_display_name`, `bot_delete`, `admin_bootstrap_invite` (actor null).
11. **Server-side stamps:** `bot_status.updated_at` on every write; `bots.last_seen` = server `now()` whenever a
    client writes it; `presets.updated_at` on update (`created_at` cannot be changed).
12. **Journal duplicate trigger:** an insert whose `(bot_id, line_hash)` already exists is skipped without error,
    whatever conflict target the client uses.
13. **Defaults:** `bots.owner` and `presets.owner` default to `auth.uid()`.
14. **Foreign keys:** `invites.created_by` / `invites.used_by` are `on delete set null` (deleting a user does not fail
    on old invites; `used_at` keeps the invite marked used).
15. **Backfill:** profiles are created for `auth.users` rows that existed before the schema was applied.
16. **auth.users trigger** is named `dobby_on_auth_user_created` and created only if missing (no drop on `auth.users`).
17. **Storage policy names** are prefixed `dobby_downloads_*` (storage.objects is shared with any other app).
18. **Privileges:** anon has none on tables, sequences or functions; authenticated has no TRUNCATE anywhere and only
    the commands each table's policies allow; internal and trigger functions are not executable by clients.
19. **Admin reads everything, writes only their own** (changed 2026-11-07 at the site owner's request; it replaces
    the earlier rule that hid friends' balances). The admin can SELECT every row of `bot_status`, `journal`,
    `bot_control`, `presets` and `audit`, so the website can show what each friend's bot is doing. Every
    insert / update / delete policy is still owner-only, so the admin can never change another user's bot, settings or
    presets. An approved member sees: rows where `actor` = themselves, rows of bots they own, `preset_*` rows of presets
    they own (`owner` in the row's before/after), and the `bot_delete` row of their own bot.
20. **Feature batch tables (2026-11-07, SPEC 9):** `bars`, `cash_flows`, `trade_notes` follow the same pattern: the
    approved owner of the bot writes, the admin reads them. Unapproved / disabled users see nothing in them. `bars` has
    no client DELETE (cascade only); the other two allow the owner to delete.
21. **Not null / checks beyond SPEC 9:** `bot_id` is not null in every batch table; `cash_flows.note` <= 1000
    characters; `trade_notes.trade_key` 1..200, `note` <= 5000, at most 30 tags. Index `cash_flows (bot_id, ts desc)`.
22. **Server-side stamps:** `cash_flows.created_at` (kept on update) / `updated_at`; `trade_notes.updated_at` /
    `updated_by` (= auth.uid(), client values ignored).
23. **`cash_flows` audit:** actions `cash_flow_insert|update|delete`, `bot_id` = the row's bot, before / after = the
    whole row (like presets).
24. **Push notifications removed (2026-11-08):** `push_subscriptions`, `register_push_subscription(...)` and
    `bots.offline_notified_at` (added 2026-11-07) are dropped with `if exists`; `push.sql` and the `notify` Edge
    Function are gone from the repo (never deployed).

---

## Tests (`tests/`) and known limits

`npm test` runs 72 tests in 5 files (schema, invites, rls, control, batch) on PGlite 0.5 (Postgres 18 in
WebAssembly). `batch.test.js` covers the SPEC 9 tables (owner / other member / admin / unapproved / disabled, the
agent's `on conflict do nothing` upload, the cash-flow audit, the drop of the removed push objects, a third schema run
with data).
`supabase_stub.sql` creates the Supabase pieces schema.sql relies on: roles `anon` / `authenticated` /
`service_role` with Supabase-like default privileges (ALL on new public objects, so the revokes are really tested),
`auth.users`, `auth.mfa_factors` (status enum), `auth.uid()` / `auth.jwt()` with the same definitions as Supabase,
`storage.buckets` / `storage.objects` with RLS on, and the `supabase_realtime` publication. `schema.sql` is run twice
(and a third time with data) to prove it is re-runnable. A client is simulated exactly like PostgREST does it:
`set role authenticated` + `set_config('request.jwt.claims', '<json>', false)`.

Limits:
- No real GoTrue / PostgREST / Realtime / Storage API: JWT claims are written by hand, storage policies are tested on
  `storage.objects` directly, realtime is checked only for publication membership.
- One connection only: no concurrency test (two people redeeming the same code at once relies on `select ... for
  update` in `redeem_invite`).
- In PGlite `postgres` is a superuser; in Supabase it is the (non-superuser) owner of the tables. Both bypass RLS as
  owner, so security definer functions behave the same. Supabase runs Postgres 15/17: no Postgres 18-only syntax is
  used.
- `create or replace function` cannot change a function's return columns; a future change to `admin_overview`'s
  columns needs `drop function public.admin_overview();` first.
