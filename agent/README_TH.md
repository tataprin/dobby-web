# Dobby agent (โปรแกรมบนเครื่อง PC)

agent คือโปรแกรมเล็ก ๆ ที่รันบนเครื่องที่เปิด MT5 + EA Dobby3 อยู่ มันอ่านไฟล์สถานะและประวัติของ EA
แล้วส่งขึ้นเว็บ Dobby Web และรับคำสั่งจากเว็บ (หยุดชั่วคราว, lot, ช่วงงดเทรดข่าว, เปิด/ปิดเทรดจริง)
มาเขียนเป็นไฟล์ควบคุมให้ EA

- agent **ไม่เทรดเอง** ไม่แตะ MT5 ไม่เปลี่ยนค่าใน MT5 เขียนได้แค่ 2 ไฟล์: `dobby2_control.txt` และ `dobby3_remote.txt`
- ขีดจำกัดบนเครื่อง (lot สูงสุด, เพดานขาดทุนรายวัน, อนุญาตให้เว็บเปิดเทรดจริงไหม) ตั้งได้ **บนเครื่องนี้เท่านั้น**
  เว็บเปลี่ยนไม่ได้
- รหัสผ่านไม่ถูกเก็บ เก็บแค่ refresh token ใน `agent_config.json` (อย่าส่งไฟล์นี้ให้ใคร)

## แอป Dobby (ไม่ต้องลง Python)

สำหรับเพื่อนที่ไม่อยากใช้บรรทัดคำสั่ง: `DobbyApp.exe` คือ agent ตัวเดียวกันนี้ ในหน้าต่างภาษาไทย

1. ดาวน์โหลด `DobbyApp.exe` จากหน้า **ดาวน์โหลดและติดตั้ง** บนเว็บ (ไฟล์เดียว ไม่ต้องติดตั้ง)
2. ดับเบิลคลิก ถ้า Windows ขึ้น **"Windows protected your PC"** (แอปยังไม่ได้ลงลายเซ็นดิจิทัล) กด **More info** แล้ว
   **Run anyway**
3. ตัวช่วยตั้งค่า 5 ขั้น:
   1. **เข้าสู่ระบบ** ด้วยอีเมล/รหัสผ่านของเว็บ (บัญชีที่ยังไม่ได้ใส่รหัสเชิญจะไปต่อไม่ได้ แอปบอกให้ใส่บนเว็บก่อน)
   2. **เลือก MT5** ที่พบใน `%APPDATA%\MetaQuotes\Terminal\<id>` (ชื่อจาก `origin.txt` และเซิร์ฟเวอร์ของโบรก)
      หรือเลือกโฟลเดอร์เอง
   3. **ติดตั้ง EA**: ติ๊กไฟล์ `.ex5` / `.set` จาก bucket `downloads` แอปคัดลอก `.ex5` ไป `MQL5\Experts\Dobby\`
      และ `.set` ไป `MQL5\Presets\` (ถามก่อนทับไฟล์ชื่อเดียวกัน ไม่แตะไฟล์อื่น) หรือกด "ติดตั้งเองแล้ว"
   4. **ตั้งชื่อเครื่อง** แล้วสร้างบอทใหม่ หรือเลือกบอทเดิมในบัญชี (ถ้า EA ยังไม่ทำงาน แอปจะสร้างบอทให้เองตอนกด
      เริ่มทำงานและ EA เริ่มส่งสถานะ โดยตั้งต้นจากสถานะของ EA เหมือน `register`)
   5. **ความปลอดภัย**: ขีดจำกัดเดียวกับ `limits` (เก็บในเครื่องนี้เท่านั้น)
4. ใน MT5 ทำเองครั้งเดียว: Navigator > Refresh > ลาก **Dobby3_v304** ใส่กราฟ XAUUSD M15 > Inputs: Load พรีเซ็ต >
   Common: ติ๊ก Allow Algo Trading > กดปุ่ม Algo Trading ให้เขียว (แอปไม่เปิด MT5 และไม่แตะค่าใน MT5)
5. กด **เริ่มทำงาน Dobby** รายการ "ความพร้อม" ต้องเป็นสีเขียวครบ: เข้าสู่ระบบ, เชื่อมเครื่อง, EA ทำงาน (สัญญาณ
   ไม่เกิน 120 วินาที), Algo Trading, เทรดได้, รับคำสั่งจากเว็บแล้ว

- ก่อนกดเริ่ม แอปไม่เขียนไฟล์ใดให้ EA เลย กดหยุดแล้วหยุดเขียนทันที (EA ทำงานต่อตามไฟล์ล่าสุด)
- ปิดหน้าต่างตอนทำงานอยู่: แอปถามว่าจะ "ย่อหน้าต่างไว้" หรือ "หยุดและปิดแอป"
- **ตั้งค่า**: ขีดจำกัด, Telegram (+ ส่งข้อความทดสอบ), เปิดพร้อม Windows (สร้างไฟล์ `DobbyApp-autostart.cmd`
  ในโฟลเดอร์ Startup ของผู้ใช้นี้ เปิดแอปด้วย `--autostart` = ย่อไว้และกดเริ่มให้ถ้าตั้งค่าครบ), เริ่มอัตโนมัติเมื่อเปิดแอป,
  ออกจากระบบ (ลืม refresh token), ยกเลิกการเชื่อมเครื่องนี้, ขั้นสูง (Supabase URL/คีย์, โฟลเดอร์ EA)
- ข้อมูลของแอปอยู่ที่ `%APPDATA%\DobbyApp\` (`agent_config.json`, `agent_state.json`, `agent.log`,
  `agent_decisions.log`) ไม่ใช่ข้างไฟล์ exe รูปแบบไฟล์เหมือน CLI ทุกอย่าง
- **หนึ่ง MT5 ใช้ได้กับ Dobby ตัวเดียว**: ทั้งแอปและ `run` จับไฟล์ล็อก `Common\Files\Dobby\dobby_agent.lock`
  ถ้าเปิดซ้อน ตัวที่สองจะบอกว่าใครทำงานอยู่ (โปรแกรม, PID, เวลาเริ่ม) ให้ปิดตัวนั้นก่อน

สำหรับนักพัฒนา:
```
python dobby_app.py                     เปิดแอปจากซอร์ส (ต้องมี requests)
python dobby_app.py --demo              ลองทุกหน้าจอกับข้อมูลปลอม (ไม่ต่อเน็ต ใช้โฟลเดอร์ชั่วคราว)
python dobby_app.py --selftest out.png --data-dir %TEMP%\dobby_selftest
                                        สร้างทุกหน้าจอด้วยข้อมูลปลอม บันทึกภาพ out_NN_*.png + out_selftest.txt แล้วออก (0 = ผ่าน)
build_exe.bat                           สร้าง dist\DobbyApp.exe (venv ใน .venv-build, PyInstaller --onefile --windowed)
dist\DobbyApp.exe --selftest out.png --data-dir %TEMP%\dobby_selftest      ตรวจ exe ที่สร้างแล้ว
```
ไฟล์: `dobby_app.py` (หน้าจอ Tkinter), `dobby_app_core.py` (ส่วนที่ไม่ใช่หน้าจอ: โฟลเดอร์ MT5, Storage, ติดตั้ง EA,
ไฟล์ Startup, agent ใน thread, ข้อมูลปลอมสำหรับ demo/selftest), `build_exe.bat`

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
ในโฟลเดอร์ EA (`Common\Files\Dobby`) ตอนทำงาน: `dobby_agent.lock` (ใครกำลังเป็น agent ของ MT5 นี้)

## ทดสอบโค้ด (สำหรับนักพัฒนา)
```
pip install pytest
python -m pytest -q
```
ทุกเทสต์ทำงานแบบออฟไลน์ ใช้โฟลเดอร์ชั่วคราว ไม่แตะโฟลเดอร์ Common จริงของ EA (95 เทสต์: agent 74 + แอป 21)

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
15. **One agent per MT5 (EA-folder lock).** `run` (not `--dry-run`) and the Dobby App take
    `<EA folder>\dobby_agent.lock` (folder created if missing) in addition to the per-folder `agent.lock`. The OS
    locks byte 1 MiB of the file (Windows `msvcrt.locking`, POSIX `flock`) and the body is JSON
    `{pid, host, program, started, started_unix, agent_version}`, readable while locked, so a refused agent can say
    who holds it (exit code 3). The OS drops the lock when a process dies: a body left by a crashed agent is *stale* and
    taken over (logged). Where the file system cannot lock, the body alone decides: same host and the pid is alive
    and was not created after `started_unix` (pid reuse) = held. Release empties the body (Windows also deletes the
    file). The EA never reads this file.
16. **Dobby App** (`dobby_app.py` + `dobby_app_core.py`) reuses `Agent` unchanged except: no EA-file write once Stop
    is pressed (`_write_file` / `_apply_control` / local-change adoption check a stop event), one shared, serialised
    Supabase client for the GUI and the agent thread (a rotated refresh token is never used twice), config writes
    under one lock. Data folder `%APPDATA%\DobbyApp`. Config = the CLI format + an `app` section
    (`wizard_done, auto_start, start_with_windows, mt5_data_dir, pending_bot_name`); the website URL and publishable
    key are filled in as defaults.
17. **Registering from the app** = `register` (`seed_from_ea()` + `first_state()`, shared with the CLI). Without an
    EA status file the bot is registered at the first Start, as soon as the EA heartbeat is fresh (`pending_bot_name`).
    **Linking an existing bot** writes a state with `applied_version = 0` (the web state is applied at the first
    cycle after Start) and `adopted_mtime` = the current control file (a local file is not pushed to the web).
18. **Storage (app only):** `POST /storage/v1/object/list/downloads` `{prefix:"", limit:200, offset:0,
    sortBy:{column:name, order:asc}}`, `GET /storage/v1/object/authenticated/downloads/<url-encoded name>`, both with
    `apikey` + the user's Bearer token. `HttpResponse` gained `content` (bytes) for binary downloads.
