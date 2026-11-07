# Dobby Web - database (Supabase)

Files:

| file | what |
|---|---|
| `schema.sql` | the whole database: tables, RLS, RPCs, triggers incl. the live gate, realtime, storage bucket, news seed, bootstrap admin invite. One file, safe to run again. |
| `seed_news.sql` | tier-1 US news (NFP, CPI, FOMC decision + press conference) from 2026-11-01, in UTC. Already included at the end of `schema.sql`. |
| `push.sql` | push notifications (SPEC 9.7): journal trigger + 5-minute offline job. Separate from `schema.sql` because it needs the pg_net and pg_cron extensions. Run once, after the Edge Function exists. |
| `functions/notify/index.ts` | the Edge Function `notify` (Deno, npm:web-push): sends the Web Push messages. Pasted once into the dashboard. |
| `tests/` | PGlite (Postgres in WebAssembly) tests with stubbed Supabase `auth` / `storage` / realtime (and stubbed pg_net / pg_cron for `push.sql`). `npm test`. |

---

## ภาษาไทย (สั้น ๆ)

### ติดตั้ง schema
1. เปิดโปรเจกต์ใน Supabase -> เมนู **SQL Editor** -> **New query**
2. เปิดไฟล์ `supabase/schema.sql` คัดลอก **ทั้งไฟล์** ไปวาง แล้วกด **Run**
   (ถ้า Supabase เตือนว่ามีคำสั่ง destructive เช่น `drop policy` ให้กด *Run this query* ได้ - ไฟล์นี้ไม่ลบตารางหรือข้อมูล)
3. ผลลัพธ์บรรทัดสุดท้ายคือ **bootstrap_admin_invite** = รหัสเชิญแอดมิน 10 ตัว (เช่น `7FKEKYJUVZ`) อายุ 7 วัน
4. ไปที่เว็บ https://tataprin.github.io/dobby-web/ -> สมัครด้วยอีเมล + รหัสผ่าน -> ใส่รหัสเชิญนี้ -> คุณจะเป็น **admin**
5. รันไฟล์ซ้ำได้ทุกเมื่อ (เช่นตอนอัปเดต) ข้อมูลเดิมอยู่ครบ ถ้ามีแอดมินแล้ว ผลลัพธ์จะบอก `admin already exists`

### อัปเดตชุด 2026-11-07 (ต้องรัน schema.sql ใหม่ 1 ครั้ง)
ชุดนี้เพิ่มตาราง `bars` (กราฟราคาย้อนหลัง), `cash_flows` (เงินฝาก-ถอน), `trade_notes` (โน้ตของแต่ละไม้),
`push_subscriptions` (เครื่องที่รับแจ้งเตือน) และคอลัมน์ `bots.offline_notified_at`
1. SQL Editor -> New query -> วาง `schema.sql` **ทั้งไฟล์** (ไฟล์ล่าสุด) -> Run (ยืนยัน destructive ได้ ไม่มีข้อมูลหาย)
2. ผลลัพธ์สุดท้ายจะเป็น `admin already exists - ...` = เรียบร้อย
3. ถ้ายังไม่รัน agent 1.2.0 / Dobby App 1.2.0 ก็ยังทำงานได้ปกติ แค่ยังไม่ส่งกราฟราคาและรายการเงินฝาก-ถอนขึ้นเว็บ
   (agent_state.warnings จะมี `bars_upload_failed` / `cash_flow_failed` และจะลองใหม่เองทุก 10 นาที)

### แจ้งเตือนบนมือถือ / คอม (Push) - ทำครั้งเดียว ผ่านหน้าเว็บ Supabase อย่างเดียว
ต้องรัน `schema.sql` ล่าสุดก่อน (หัวข้อด้านบน) มี 3 ขั้น + ทดสอบ

**ขั้น 1: สร้าง Edge Function ชื่อ `notify`**
1. Supabase -> เมนูซ้าย **Edge Functions** -> ปุ่ม **Deploy a new function** -> เลือก **Via Editor**
2. ตั้งชื่อ function ว่า `notify` (ตัวเล็กทั้งหมด)
3. ลบโค้ดตัวอย่างในช่องแก้ไขให้หมด แล้วเปิดไฟล์ `supabase/functions/notify/index.ts` คัดลอก **ทั้งไฟล์** มาวาง
4. กด **Deploy function** รอจนขึ้นว่าสำเร็จ
5. เปิด function `notify` -> หน้า **Details** (หรือ Settings) -> **ปิด** สวิตช์ **Verify JWT** (Enforce JWT verification)
   -> Save
   เหตุผล: ฐานข้อมูลเรียก function นี้ด้วยรหัสลับ (NOTIFY_SECRET) ไม่ใช่ JWT ส่วนปุ่ม "ส่งทดสอบ" บนเว็บ function
   ตรวจ token ของผู้ใช้เองอยู่แล้ว ถ้าเปิดสวิตช์นี้ไว้ แจ้งเตือนจากฐานข้อมูลจะไม่ผ่าน

**ขั้น 2: ใส่ secrets 4 ค่า**
Edge Functions -> **Secrets** (Manage secrets) -> เพิ่มทีละค่า (Name ต้องพิมพ์ตรงตัว):

| Name | ค่าที่ใส่ |
|---|---|
| `VAPID_PUBLIC_KEY` | เปิดไฟล์ `D:\Dobby\secrets\vapid.json` ด้วย Notepad -> ค่า public key (ขึ้นต้นด้วย `BCTdZs2r...` ยาว 87 ตัว) |
| `VAPID_PRIVATE_KEY` | จากไฟล์เดียวกัน -> ค่า private key (อีกค่า ยาว 43 ตัว) **ห้ามส่งให้ใคร ห้ามใส่ใน GitHub** |
| `VAPID_SUBJECT` | `mailto:` ตามด้วยอีเมลของคุณ เช่น `mailto:me@example.com` |
| `NOTIFY_SECRET` | ข้อความสุ่มยาว ๆ ที่คุณสร้างเอง (วิธีด้านล่าง) อย่างน้อย 24 ตัว ไม่มีช่องว่าง |

วิธีสร้าง NOTIFY_SECRET: เปิด **PowerShell** บนคอม (กดปุ่ม Windows พิมพ์ PowerShell) แล้ววางคำสั่งนี้ กด Enter

```
[guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
```

จะได้ตัวอักษร 0-9 a-f ยาว 64 ตัว คัดลอกไปใส่เป็น NOTIFY_SECRET และเก็บไว้ใช้ในขั้น 3 (ใช้ค่าเดียวกันทั้งสองที่)
(หรือใช้ตัวสร้างรหัสผ่านของ password manager ก็ได้ ขอให้มีแค่ตัวอักษรกับตัวเลข)

**ขั้น 3: รัน push.sql**
1. SQL Editor -> New query -> เปิดไฟล์ `supabase/push.sql` คัดลอกทั้งไฟล์มาวางในช่อง SQL
2. ในช่อง SQL (ไม่ต้องแก้ไฟล์ในเครื่อง) หาบล็อกแรก แล้วแทน 2 ค่า โดย **เก็บเครื่องหมาย ' ไว้**
   - `<PROJECT_REF>` -> รหัสโปรเจกต์ = ส่วนหน้า `.supabase.co` ในที่อยู่โปรเจกต์ ของโปรเจกต์นี้คือ
     `rpzuzhefviydjmeggvvz` (ดูได้ที่ Settings -> General -> Project ID)
   - `<NOTIFY_SECRET>` -> ค่า NOTIFY_SECRET เดียวกับขั้น 2
   ตัวอย่างหลังแทน: `v_ref text := btrim('rpzuzhefviydjmeggvvz');`
3. กด **Run** ผลลัพธ์สุดท้ายควรเป็น `notify_url = https://rpzuzhefviydjmeggvvz.supabase.co/functions/v1/notify`,
   `offline_job = 1`, `journal_trigger = 1`
   - ถ้าขึ้น `push.sql: put your project id ...` หรือ `... NOTIFY_SECRET ...` = ยังแทนค่าไม่ครบ / ผิด แก้แล้ว Run ใหม่
   - ถ้าขึ้นว่า extension `pg_net` หรือ `pg_cron` ใช้ไม่ได้: ไปที่ **Database -> Extensions** เปิด `pg_net` และ
     `pg_cron` แล้ว Run ใหม่
4. **อย่าเซฟ** ไฟล์ push.sql ที่ใส่รหัสลับแล้วลงในโฟลเดอร์ GitHub (ทำในช่อง SQL Editor อย่างเดียวพอ)
5. รันซ้ำได้ (เช่นตอนเปลี่ยน NOTIFY_SECRET: เปลี่ยนใน Secrets แล้วรัน push.sql ใหม่ด้วยค่าใหม่)

**ทดสอบ**: บนเว็บ -> ตั้งค่าบัญชี -> การแจ้งเตือน -> เปิดการแจ้งเตือนบนเครื่องนี้ -> ส่งทดสอบ
ควรเด้งข้อความ "ทดสอบการแจ้งเตือนจาก Dobby" (iPhone ต้อง "เพิ่มไปยังหน้าจอโฮม" ก่อน และ iOS 16.4 ขึ้นไป)

**แจ้งเตือนอะไรบ้าง**: เปิดไม้ / ปิดไม้ (พร้อมกำไรขาดทุน) / ชนจุดหยุดรายวัน (ไม่เกิน 30 นาทีหลังเกิดจริง ข้อมูลเก่าไม่แจ้ง)
และ "บอทขาดการติดต่อ" เมื่อ agent เงียบไป 5-60 นาที (แจ้งครั้งเดียวต่อครั้งที่หลุด) แต่ละเครื่องเลือกเรื่องที่จะรับได้บนเว็บ

**ถ้าไม่เด้ง**:
- Edge Functions -> notify -> **Logs** ดูข้อความผิดพลาด
- SQL Editor: `select status_code, content::text, created from net._http_response order by created desc limit 5;`
  - 401 `bad_secret` = NOTIFY_SECRET ใน Secrets ไม่ตรงกับที่ใส่ใน push.sql -> รัน push.sql ใหม่ด้วยค่าเดียวกัน
  - 500 `vapid_secrets_missing` = ใส่ VAPID ไม่ครบ (ขั้น 2)
  - 401 จาก Supabase เอง (ไม่มี `bad_secret`) = ยังไม่ได้ปิด Verify JWT (ขั้น 1 ข้อ 5)
- ปิดระบบ push ทั้งหมด: `drop trigger if exists dobby_journal_push on public.journal; select cron.unschedule('dobby-push-offline');`

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
Re-run the whole `schema.sql` once (new tables `bars`, `cash_flows`, `trade_notes`, `push_subscriptions`, column
`bots.offline_notified_at`). Agent 1.2.0 keeps working before that; it only warns and retries its bars / cash-flow
uploads every 10 minutes.

### Push notifications (one time, dashboard only; Thai steps above)
1. Edge Functions -> Deploy a new function -> Via Editor, name `notify`, paste `functions/notify/index.ts`, deploy,
   then turn **Verify JWT off** (the function checks the shared secret or the user's token itself).
2. Edge Function secrets: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` (both from `D:\Dobby\secrets\vapid.json`, never in
   the repo), `VAPID_SUBJECT` (`mailto:you@example.com`), `NOTIFY_SECRET` (random, >= 24 characters, letters and
   digits only, e.g. PowerShell `[guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')`).
3. SQL editor: paste `push.sql`, replace `<PROJECT_REF>` (here `rpzuzhefviydjmeggvvz`) and `<NOTIFY_SECRET>` in the
   first block, Run. If pg_net / pg_cron are refused, enable them under Database -> Extensions and run again. Do not
   save the filled-in file into the repo.

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
- `push_subscriptions` (SPEC 9.7): a plain upsert `?on_conflict=endpoint` works for the caller's own row. For a browser
  that another account subscribed before, that upsert is refused by RLS: call `rpc/register_push_subscription` instead
  (moves the row to the caller). Delete = unsubscribe this browser.
- `bots.offline_notified_at`: owned by the push job; client writes to it are ignored.
- Errors added: `subscription_invalid`, `events_invalid` (register_push_subscription).
- Audit actions added: `cash_flow_insert`, `cash_flow_update`, `cash_flow_delete`.

**Push (push.sql + functions/notify) - how it fits together.** `push.sql` stores the function URL and the shared
secret in `dobby_private.push_settings`; the schema has no grants for `anon` / `authenticated`, so neither PostgREST nor
a client SQL role can read it, and the secret is not in any function source. Both push functions are SECURITY DEFINER
in `dobby_private`, not executable by clients. The journal trigger (`dobby_journal_push`, AFTER INSERT, only OPEN /
CLOSE / DAYCAP) runs as the agent's insert: it looks up the bot's server offset and pushes only rows at most 30 minutes
old (an agent's first upload of the whole journal never floods a phone; nothing while the offset is unknown), only for
an approved, not disabled owner with a matching subscription, through `net.http_post` (asynchronous: the insert never
waits for the push). Any error inside becomes a WARNING, so a push problem can never make the agent's journal upload
fail. The cron job `dobby-push-offline` (every 5 min) pushes "offline" for bots whose `last_seen` is 5-60 min old and
`offline_notified_at` is null, then sets the flag; `schema.sql`'s `bots_before` clears it when `last_seen` moves (the
agent is back). The Edge Function trusts a DB call only with the right `x-notify-secret` (constant-time compare, at
least 24 characters configured) and a website call only with a user token that `auth.getUser` accepts (test pushes go
to the caller's own subscriptions only). It re-checks that the owner is approved and not disabled, and deletes
subscriptions that answer 404 / 410.

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
20. **Feature batch tables (2026-11-07, SPEC 9):** `bars`, `cash_flows`, `trade_notes`, `push_subscriptions` follow
    the same pattern: the approved owner of the bot writes, the admin reads `bars` / `cash_flows` / `trade_notes`,
    `push_subscriptions` is own rows only (no admin read). Unapproved / disabled users see nothing in them. `bars` has
    no client DELETE (cascade only); the other three allow the owner to delete.
21. **Not null / checks beyond SPEC 9:** `bot_id` is not null in every batch table; `cash_flows.note` <= 1000
    characters; `trade_notes.trade_key` 1..200, `note` <= 5000, at most 30 tags; `push_subscriptions.endpoint` must be
    https and <= 2048 characters, `p256dh` / `auth` 1..300, `ua` <= 500, `events` a subset of
    {open, close, daycap, offline}. Indexes `cash_flows (bot_id, ts desc)` and `push_subscriptions (user_id)`.
22. **Server-side stamps:** `cash_flows.created_at` (kept on update) / `updated_at`; `trade_notes.updated_at` /
    `updated_by` (= auth.uid(), client values ignored).
23. **`cash_flows` audit:** actions `cash_flow_insert|update|delete`, `bot_id` = the row's bot, before / after = the
    whole row (like presets).
24. **`bots.offline_notified_at`:** cleared by `bots_before` whenever `last_seen` moves; client roles cannot set or clear
    it otherwise (their value is replaced by the old one; null on insert). Only `postgres` (the cron job) sets it.
25. **New RPC `register_push_subscription(p_endpoint, p_p256dh, p_auth, p_ua, p_events)`** (security definer,
    authenticated only): upsert by endpoint for the approved caller, taking over a browser another account subscribed
    before; `p_events` null keeps the caller's earlier choice.
26. **Push:** `push.sql` is separate (pg_net + pg_cron) and uses its own names (`dobby_private` schema,
    `dobby_journal_push` trigger, `dobby-push-offline` job), so re-running `schema.sql` never removes it. Only rows at
    most 30 minutes old are pushed (see "Push ... how it fits together" above).

---

## Tests (`tests/`) and known limits

`npm test` runs 91 tests in 7 files (schema, invites, rls, control, batch, push, notify) on PGlite 0.5 (Postgres 18
in WebAssembly). `batch.test.js` covers the SPEC 9 tables (owner / other member / admin / unapproved / disabled, the
agent's `on conflict do nothing` upload, the cash-flow audit, the offline flag, a third schema run with data).
`push.test.js` runs the real `push.sql` with stubbed `net.http_post` / `cron.*` (the two `create extension` lines are
stripped). `notify.test.js` runs the pure part of the Edge Function (the block between `BEGIN messages` and
`END messages`) in node: Thai texts, CORS, secret compare.
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
- The Edge Function itself (Deno, npm:web-push, real push services, `auth.getUser`) is not run by the tests; only its
  pure message / CORS block is. pg_net / pg_cron are stubs: the exact `net.http_post` signature and `cron.job` columns
  follow the Supabase docs (pg_net 0.x, pg_cron 1.6) but are not proven here.
