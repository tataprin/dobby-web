# Dobby agent (โปรแกรมบนเครื่อง PC)

agent คือโปรแกรมเล็ก ๆ ที่รันบนเครื่องที่เปิด MT5 + EA Dobby3 อยู่ มันอ่านไฟล์สถานะและประวัติของ EA
แล้วส่งขึ้นเว็บ Dobby Web และรับคำสั่งจากเว็บ (หยุดชั่วคราว, lot, ช่วงงดเทรดข่าว, เปิด/ปิดเทรดจริง)
มาเขียนเป็นไฟล์ควบคุมให้ EA

- agent **ไม่เทรดเอง** ไม่แตะ MT5 ไม่เปลี่ยนค่าใน MT5 เขียนได้แค่ 2 ไฟล์: `dobby2_control.txt` และ `dobby3_remote.txt`
- ขีดจำกัดบนเครื่อง (lot สูงสุด, เพดานขาดทุนรายวัน, อนุญาตให้เว็บเปิดเทรดจริงไหม) ตั้งได้ **บนเครื่องนี้เท่านั้น**
  เว็บเปลี่ยนไม่ได้
- รหัสผ่านไม่ถูกเก็บ เก็บแค่ refresh token ใน `agent_config.json` (อย่าส่งไฟล์นี้ให้ใคร)

## ติดตั้ง (ครั้งเดียว)
1. ติดตั้ง Python 3.8 ขึ้นไปจาก https://www.python.org/downloads/ (ติ๊ก **Add python.exe to PATH**)
2. ดับเบิลคลิก `install.bat` (ติดตั้งไลบรารี `requests`)

## ตั้งค่า (เปิด Command Prompt ในโฟลเดอร์นี้)
1. **setup** - ใส่ Supabase URL และ **Publishable key** (`sb_publishable_...`, หรือ anon key แบบเก่า) จากหน้า
   *Downloads & setup* บนเว็บ แล้วตรวจโฟลเดอร์ไฟล์ EA (ปกติคือ
   `%APPDATA%\MetaQuotes\Terminal\Common\Files\Dobby`) และตั้งค่า Telegram ได้ถ้าต้องการ
   ```
   python dobby_agent.py setup
   ```
2. **login** - อีเมลและรหัสผ่านเดียวกับที่ใช้บนเว็บ (บัญชีต้องได้รับอนุมัติด้วยรหัสเชิญก่อน)
   ```
   python dobby_agent.py login
   ```
3. **register** - สร้างบอทบนเว็บจากสถานะปัจจุบันของ EA (เปิด MT5 + EA ไว้ก่อน)
   ```
   python dobby_agent.py register --name "Main PC"
   ```
4. **limits** - ตรวจและตั้งขีดจำกัดบนเครื่องนี้
   ```
   python dobby_agent.py limits
   python dobby_agent.py limits --max-lots 0.05 --max-cap 10
   python dobby_agent.py limits --allow-live on        (ให้เว็บเปิดเทรดจริงได้; ค่าเริ่มต้น off)
   python dobby_agent.py limits --allow-params on      (ให้เว็บส่งพารามิเตอร์ให้ EA v3.04; ค่าเริ่มต้น off)
   ```
   | ค่า | ค่าเริ่มต้น | ความหมาย |
   |---|---|---|
   | `allow_remote_control` | on | รับคำสั่งจากเว็บ (หยุด/เริ่ม, lot, ฝั่ง, spread, ช่วงงดเทรด) |
   | `allow_remote_live` | off | เว็บ **เปิด** เทรดจริงได้ (การ **ปิด** จากเว็บทำได้เสมอ) |
   | `allow_remote_params` | off | เว็บส่งพารามิเตอร์ให้ EA v3.04 ได้ |
   | `max_lots` | 0.10 | lot จากเว็บที่เกินจะถูกลดลงมาเท่านี้ (พารามิเตอร์ lot ที่เกินจะถูกปฏิเสธทั้งชุด) |
   | `max_daily_cap_pct` | 10 | `InpDailyCapPct` จากเว็บที่เกินจะถูกปฏิเสธทั้งชุด |
5. **run** - ดับเบิลคลิก `run_agent.bat` (ถ้า agent ล้มจะเริ่มใหม่เองใน 10 วินาที ปิดหน้าต่าง = หยุด)
   ```
   python dobby_agent.py run --dry-run      ลองดูก่อน: ไม่เขียนไฟล์ EA ไม่ส่งข้อมูลขึ้นเว็บ (ดูผลใน agent.log)
   python dobby_agent.py status             ดูสถานะ agent, ขีดจำกัด, เวอร์ชันคำสั่งล่าสุด, EA ยังทำงานไหม
   ```

## หยุดรับคำสั่งจากเว็บทันที
```
python dobby_agent.py limits --allow-control off
```
agent ที่กำลังรันจะหยุดเขียนไฟล์ควบคุมภายในไม่กี่วินาที (ไฟล์ล่าสุดยังอยู่ EA ทำงานตามไฟล์นั้น) เปิดกลับด้วย
`--allow-control on` ถ้าต้องการให้บอทหยุดเข้าออเดอร์จริง ๆ ให้กดปุ่ม Algo Trading ใน MT5

## แจ้งเตือน Telegram (ไม่บังคับ)
1. ใน Telegram คุยกับ **@BotFather** -> `/newbot` -> ตั้งชื่อ -> ได้ **token** (เช่น `123456:ABC...`)
2. ส่งข้อความอะไรก็ได้หาบอทของคุณ 1 ครั้ง แล้วเปิด `https://api.telegram.org/bot<token>/getUpdates`
   ในเบราว์เซอร์ หา `"chat":{"id": ...}` ตัวเลขนั้นคือ **chat id** (หรือถาม @userinfobot)
3. `python dobby_agent.py setup` -> ตอบ `y` ตอนถาม Telegram -> ใส่ token และ chat id
4. `python dobby_agent.py test-telegram`

แจ้งเตือน: เปิด/ปิดออเดอร์ (พร้อมกำไร/ขาดทุน), ล็อกกำไร, ข้อผิดพลาดของ EA, ถึงเพดานขาดทุนรายวัน, EA ออฟไลน์/กลับมา,
เปิด/ปิดเทรดจริงจากเว็บ, สรุปรายวัน 23:30 เวลาเซิร์ฟเวอร์ เลือกเฉพาะบางอย่างได้ที่ `telegram.events` ใน
`agent_config.json` (`open close lock cap offline live error daily`)

## ไฟล์ในโฟลเดอร์นี้
`agent_config.json` (ตั้งค่า + refresh token, ห้ามแชร์), `agent_state.json` (สถานะภายใน), `agent.log` (บันทึก,
หมุนไฟล์เอง), `agent_decisions.log` (ทุกคำสั่งที่นำไปใช้/ปฏิเสธ), `agent.lock`

## ทดสอบโค้ด (สำหรับนักพัฒนา)
```
pip install pytest
python -m pytest tests
```
ทุกเทสต์ทำงานแบบออฟไลน์ ใช้โฟลเดอร์ชั่วคราว ไม่แตะโฟลเดอร์ Common จริงของ EA

---

## Spec additions (SPEC.md section 3 - what this part added or had to interpret)
1. **Server UTC offset is trusted only while the server clock runs.** The SPEC formula is used, but `TimeCurrent()`
   freezes on weekends and in the daily break (the real status of 2026-11-07 gives -345 instead of 120). The value is
   *confirmed* when two status samples show the server clock moving with the GMT clock; until then it is used for the
   files but reported as `offset_unconfirmed` and NOT uploaded to `bots.server_utc_offset_min`. New config key
   `server_utc_offset_min` (int, null = automatic) overrides it.
2. **`desired` shape** (same as docs/js/demo.js): `{live, control:{mode,lots,allow_long,allow_short,max_spread,note},
   blackouts:[{from_utc,to_utc,label}], params}`. The note is read from `control.note` (fallback `desired.note`).
3. **agent_state extra keys:** `reject_details` (text), `warnings` (`offset_unconfirmed`, `offset_unknown`,
   `bad_blackout`), `offset_source` (`config|confirmed|unconfirmed|unknown`). Extra reject codes:
   `params_out_of_bounds` (type / SPEC 4.2 bounds / lock cross-checks / EA ceilings from status schema 5),
   `params_invalid` (not an object).
4. **Live with v3.03:** the applied live value is the control file `mode`. `allow_remote_live=off` refuses only a
   switch ON (last applied value kept, `live_not_allowed_locally` reported when it changed the outcome); OFF is always
   applied. When the agent has never applied a live value it starts from the EA's current state.
5. **Control file is re-rendered every successful cycle** and rewritten only when its non-comment lines change, so past
   blackouts drop out, an offset correction or a local `limits` change takes effect without a new web version. Any
   version different from the applied one is applied (not only greater: survives a database restore).
6. **Rounding:** blackout start floored / end ceiled to the minute (never narrower); `lots` and `max_spread` floored to
   0.01, minimum 0.01 (never rounded up).
7. **EA reload guarantee:** if a rewrite lands in the same modify-second as the old file, its mtime is set to old + 1 s
   (the EA compares `FILE_MODIFY_DATE`, 1 s resolution).
8. **Remote file:** rewritten only when its `live` / params lines change (a new version alone does not), so
   `remote_file_version` can be lower than `applied_version`. A rejected params block keeps the last accepted params in
   the file. When both remote switches are turned off, an existing remote file is neutralised once (only `version=`:
   EA falls back to `InpAllowLive`, no params).
9. **Local change adoption** runs before the control step (otherwise the local change would be overwritten), PATCHes
   `bot_control?bot_id=eq.<id>&version=eq.<seen>` (if the web changed meanwhile the web wins), skips files whose
   content already equals the web state, never touches `live`/`params`, does not copy a `mode=pause` that only exists
   because live is off, sets `control.note = "local change: <note>"` and labels adopted blackouts `"local"`.
10. **bots** row is updated at most every 30 s, but at once after a control apply (so the web sees the ack quickly).
11. **Journal:** byte-offset tracking plus a bounded set of the last 5000 hashes; the first read is a silent backfill
    (no Telegram flood). Identical raw lines share one hash, so exact duplicates collapse into one row (SPEC unique).
12. **`--dry-run`** reads (GET) but never writes EA files, state, decisions or uploads, and sends no Telegram; it still
    saves a rotated refresh token to `agent_config.json` (Supabase rotates them; skipping that would log you out).
13. **CLI additions:** global `--dir` / `--verbose`; `setup --url --anon-key --common-dir --telegram-token
    --telegram-chat-id --poll-seconds --non-interactive` (setup also asks Telegram); `login --email`; `register`
    takes two status samples 6 s apart and refuses without a status file. Exit codes: 0 stopped, 1 crash (restart),
    2 config/login missing, 3 already running (`agent.lock`). EA folder: env `DOBBY_COMMON` > config `common_dir` >
    default.
14. **Telegram:** at most 3 messages per cycle and 20 per minute, queue of 30 (oldest dropped with a note), 429
    `retry_after` honoured, a message is dropped after 3 failed sends; agent errors are de-duplicated for 30 min, a
    login failure is sent once, network failures are not sent. Daily summary on server weekdays only.
