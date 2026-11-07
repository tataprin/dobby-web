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
3. ตัวช่วยตั้งค่า 7 ขั้น (หนึ่งเรื่องต่อหนึ่งหน้า มีแถบความคืบหน้าด้านบน):
   1. **ยินดีต้อนรับ** - แอปทำอะไร และต้องมีอะไร (MT5 ที่ล็อกอินแล้ว, บัญชีเว็บ) แอปบอกว่าพบ MT5 กี่ตัว
   2. **เข้าสู่ระบบ** ด้วยอีเมล/รหัสผ่านของเว็บ (บัญชีที่ยังไม่ได้ใส่รหัสเชิญจะไปต่อไม่ได้)
   3. **เลือกบอท** - ถ้ามีบอทบนเว็บแล้ว: "ใช้บอทนี้" = เชื่อมเครื่องนี้กับบอทเดิม (ไม่สร้างบอทใหม่ ไม่แก้การตั้งค่าของบอท
      ข้ามขั้น 4; ถ้าบอทนั้นออนไลน์อยู่ที่เครื่องอื่น แอปเตือนก่อน) หรือ "เพิ่มบอทใหม่" -> รายการบอท (ตอนนี้มี Dobby) ->
      "ใช้ Dobby"
   4. **ตั้งค่าบอท** (SPEC 7) - ใส่เงินในบัญชี กด **ตั้งให้อัตโนมัติ**: ล็อต = floor(เงิน/100)/100 (ต่ำสุด 0.01 สูงสุด 0.50),
      3 สูตรเปิด, เอเชียปิด, ล็อก 2 ชั้น 85->83 / 95->93, หยุดเมื่อขาดทุน 10%/วัน พร้อมประมาณความเสี่ยง (SPEC 5.1)
      หรือเปิด **ปรับเอง**: เปิด/ปิดสูตร, ล็อตเท่ากัน/แยกสูตร, ไม่ล็อก/1 ชั้น/2 ชั้น, ขาดทุนต่อวัน, ขั้นสูง
   5. **เชื่อม MT5** - เลือก MT5, แอปดาวน์โหลด `Dobby3_v3*.ex5` ตัวใหม่สุดจาก bucket `downloads` ไป
      `MQL5\Experts\Dobby\` และ **สร้าง** พรีเซ็ต `Dobby3_v304_web.set` (ค่าเริ่มต้นของ EA + ค่าอัตโนมัติของทุน 300 +
      remote เปิด, InpAllowLive=false) ไป `MQL5\Presets\` แล้วเลือก
      - **เปิด MT5 พร้อม Dobby ให้อัตโนมัติ** (แนะนำ): ใช้ได้เมื่อ MT5 ตัวนั้น**ปิดอยู่** และ**ไม่มีกราฟไหน** (ทุกโปรไฟล์ใน
        `MQL5\Profiles\Charts`) ที่มี Dobby อยู่แล้ว และไม่มี Dobby ตัวอื่นส่งสัญญาณอยู่ แอปเขียน
        `%APPDATA%\DobbyApp\mt5_startup.ini` (Expert=Dobby\<ชื่อ ex5>, ExpertParameters=Dobby3_v304_web.set,
        Symbol=XAUUSD หรือชื่อตามโบรก, Period=M15, [Experts] Enabled=1, AllowLiveTrading=1) บอกว่าจะทำอะไรแล้ว**ถามก่อน**
        จึงเปิด `"<ที่ติดตั้ง>	erminal64.exe" /config:"<ini>"`
      - **ทำเองใน MT5**: 6 ขั้นตอนพร้อมภาพประกอบ (Navigator > Refresh, ลากใส่กราฟ XAUUSD M15, Load พรีเซ็ต,
        Allow Algo Trading, ปุ่ม Algo Trading สีเขียว)
   6. **ความปลอดภัย** - ค่าแนะนำ "ให้เว็บควบคุมได้ทุกอย่าง" (allow_remote_control/live/params = เปิด,
      ล็อตสูงสุด = min(0.50, max(0.02, 2 x ล็อต)), ขาดทุนต่อวันสูงสุด 10) ปรับทีละข้อได้
   7. **เสร็จแล้ว** - สรุป + ชื่อบอท แล้วกดบันทึก: บอทใหม่ = `register_bot` ด้วย desired = {live: true, control: run,
      blackouts: [], params: การตั้งค่าครบทุกค่า} / บอทเดิม = เชื่อมเฉย ๆ จากนั้นกด **เริ่มทำงาน Dobby**
4. หน้าหลัก: สถานะใหญ่ ("Dobby กำลังเทรดจริง" / "หยุดอยู่" / "รอ MT5" พร้อมเหตุผลและปุ่มแก้หนึ่งปุ่ม), ปุ่ม เริ่ม/หยุด,
   ความพร้อม 6 ข้อ, การ์ด ยอดเงิน / กำไรวันนี้ / ไม้ที่เปิดอยู่ / การตั้งค่าที่ใช้อยู่ (ปุ่ม แก้ไขบนเว็บ), ความเคลื่อนไหวล่าสุด
   เป็นภาษาไทย (บันทึกละเอียดอยู่หลัง "ดูบันทึกละเอียด"), ปุ่ม วิธีใช้ (เปิดหน้า #/guide ของเว็บ)

- ก่อนกดเริ่ม แอปไม่เขียนไฟล์ใดให้ EA เลย กดหยุดแล้วหยุดเขียนทันที (EA ทำงานต่อตามไฟล์ล่าสุด)
- ปิดหน้าต่างตอนทำงานอยู่: แอปถามว่าจะ "ย่อหน้าต่างไว้" หรือ "หยุดและปิดแอป"
- **ตั้งค่า**: ความปลอดภัย, บอท (เปลี่ยน/เชื่อมบอทอื่น, เชื่อม MT5, ยกเลิกการเชื่อม), Telegram (+ ส่งข้อความทดสอบ),
  เปิดพร้อม Windows (สร้างไฟล์ `DobbyApp-autostart.cmd` ในโฟลเดอร์ Startup ของผู้ใช้นี้ เปิดแอปด้วย `--autostart` =
  ย่อไว้และกดเริ่มให้ถ้าตั้งค่าครบ) + เริ่มอัตโนมัติเมื่อเปิดแอป, บัญชี (ออกจากระบบ), ขั้นสูง (Supabase URL/คีย์, โฟลเดอร์ EA)
- ข้อมูลของแอปอยู่ที่ `%APPDATA%\DobbyApp\` (`agent_config.json`, `agent_state.json`, `agent.log`,
  `agent_decisions.log`) ไม่ใช่ข้างไฟล์ exe รูปแบบไฟล์เหมือน CLI ทุกอย่าง
- **หนึ่ง MT5 ใช้ได้กับ Dobby ตัวเดียว**: ทั้งแอปและ `run` จับไฟล์ล็อก `Common\Files\Dobby\dobby_agent.lock`
  ถ้าเปิดซ้อน ตัวที่สองจะบอกว่าใครทำงานอยู่ (โปรแกรม, PID, เวลาเริ่ม) ให้ปิดตัวนั้นก่อน

สำหรับนักพัฒนา:
```
python dobby_app.py                     เปิดแอปจากซอร์ส (ต้องมี requests)
python dobby_app.py --demo              ลองทุกหน้าจอกับข้อมูลปลอม (ไม่ต่อเน็ต ใช้โฟลเดอร์ชั่วคราว, MT5 ปลอม)
                                        อีเมลใดก็ได้ = เจ้าของที่มีบอท คอมหลัก + DESKTOP-NPNL85P, อีเมลที่มี new = ผู้ใช้ใหม่
python dobby_app.py --selftest out.png --data-dir %TEMP%\dobby_selftest
                                        สร้างทุกหน้าจอด้วยข้อมูลปลอม บันทึกภาพ out_NN_*.png + out_selftest.txt แล้วออก (0 = ผ่าน)
build_exe.bat                           สร้าง dist\DobbyApp.exe (venv ใน .venv-build, PyInstaller --onefile --windowed)
dist\DobbyApp.exe --selftest out.png --data-dir %TEMP%\dobby_selftest      ตรวจ exe ที่สร้างแล้ว
```
ไฟล์: `dobby_app.py` (หน้าจอ Tkinter + selftest), `dobby_app_ui.py` (ธีมและวิดเจ็ต), `dobby_app_gfx.py` (วาดมุมโค้ง/ไอคอน
เป็น PNG ไม่ต้องใช้ Pillow), `dobby_app_core.py` (ส่วนที่ไม่ใช่หน้าจอ: โฟลเดอร์ MT5, Storage, ติดตั้ง EA, พรีเซ็ต,
เปิด MT5 พร้อม Dobby, การตั้งค่าแบบง่าย, agent ใน thread, ข้อมูลปลอมสำหรับ demo/selftest), `build_exe.bat`

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

## ชื่อบอทในเครื่องเพี้ยน (เช่น "คอมหลัก" กลายเป็น "คอมหลก")
หน้าต่างคำสั่งบางแบบทำสระ/วรรณยุกต์ภาษาไทยหายตอนพิมพ์ แก้ชื่อที่เก็บในเครื่องนี้ (ชื่อบนเว็บไม่เปลี่ยน):
```
python dobby_agent.py rename --from-web           ใช้ชื่อของบอทนี้บนเว็บ (แนะนำ: ไม่ต้องพิมพ์ภาษาไทย)
python dobby_agent.py rename --name-file name.txt พิมพ์ชื่อใน Notepad บันทึกเป็นไฟล์ แล้วอ่านจากไฟล์
python dobby_agent.py rename --name "คอมหลัก"
```
แอปแสดงรหัสตัวอักษร (`ค...`) ให้ตรวจ และไม่ยอมบันทึกชื่อที่มี `?` (ภาษาไทยถูกแปลงผิดระหว่างทาง)

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
