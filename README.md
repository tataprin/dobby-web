# Dobby Web

เว็บสำหรับดูและสั่งบอททอง Dobby จากมือถือหรือคอมเครื่องไหนก็ได้ และให้เพื่อนที่ได้รหัสเชิญใช้บอทของตัวเองได้

- เว็บ: https://tataprin.github.io/dobby-web/
- โหมดตัวอย่าง (ข้อมูลปลอม กดเล่นได้ทุกหน้า): https://tataprin.github.io/dobby-web/?demo=1

```
เว็บ (GitHub Pages)  <->  Supabase (ล็อกอิน + ฐานข้อมูล)  <->  ตัวเชื่อม agent (Python บนคอมแต่ละเครื่อง)  <->  MT5 + EA Dobby3
```
ตัวเชื่อมอ่านสถานะ/ประวัติของ EA ส่งขึ้นเว็บ และรับคำสั่งจากเว็บมาเขียนเป็นไฟล์ที่ EA อ่าน ตัวเชื่อมไม่ส่งคำสั่งซื้อขายเอง
รายละเอียดทั้งระบบอยู่ใน [SPEC.md](SPEC.md)

## ตั้งค่าครั้งแรก (เจ้าของ)
1. **ฐานข้อมูล:** Supabase → SQL Editor → วางไฟล์ [supabase/schema.sql](supabase/schema.sql) ทั้งไฟล์ → Run
   ช่องผลลัพธ์จะแสดง **รหัสเชิญ admin** (ใช้ได้ 7 วัน) รันซ้ำได้ ไม่ลบข้อมูล
2. **Authentication → URL Configuration:** Site URL = `https://tataprin.github.io/dobby-web/`
   และ Redirect URLs เพิ่ม `https://tataprin.github.io/dobby-web/**`
   (ถ้าอยากให้สมัครแล้วเข้าได้ทันที ปิด "Confirm email" ที่ Authentication → Sign In / Providers → Email)
3. **สมัครบนเว็บ:** แท็บ "สมัครด้วยรหัสเชิญ" ใส่อีเมล รหัสผ่าน และรหัสเชิญ admin → คุณเป็น admin
4. **เปิด 2FA:** หน้าตั้งค่า → ยืนยันตัวตน 2 ชั้น (แนะนำมาก เพราะเว็บเปิดเทรดเงินจริงได้)
5. **อัปโหลด EA ให้เพื่อน:** หน้าดาวน์โหลด (admin) → อัปโหลด `Dobby3_v304.ex5`
   (อยู่ใน MT5: File → Open Data Folder → MQL5\Experts\Dobby\) EA ไม่อยู่ใน repo สาธารณะนี้

## ต่อคอมเข้ากับเว็บ (ทำทุกเครื่องที่รันบอท)
ต้องมี Python 3.8 ขึ้นไป ([python.org](https://www.python.org/downloads/) ติ๊ก "Add python.exe to PATH" ตอนติดตั้ง)
```
cd agent
install.bat
python dobby_agent.py setup                      (ใส่ Project URL และ Publishable key จากหน้าดาวน์โหลดบนเว็บ)
python dobby_agent.py login                      (อีเมล + รหัสผ่านเว็บ พิมพ์เอง ตัวเชื่อมเก็บแค่ token)
python dobby_agent.py register --name "คอมหลัก"
python dobby_agent.py limits --max-lots 0.10 --max-cap 10
run_agent.bat                                    (เปิดค้างไว้ ปิดหน้าต่าง = หยุดรับคำสั่ง)
```
คู่มือเต็ม: [agent/README_TH.md](agent/README_TH.md) (รวมการตั้ง Telegram แจ้งเตือน)

## เปิด/ปิดเทรดเงินจริงจากเว็บ
- **EA v3.03 (ตัวที่ใช้อยู่):** ติ๊ก InpAllowLive ที่เครื่องครั้งเดียว ปุ่มเปิด/ปิดบนเว็บจะสั่งบอทหยุด/เริ่มเปิดไม้ใหม่
- **EA v3.04:** โหลดพรีเซ็ต `Dobby3_v304_..._remote_on.set` (InpRemoteLive / InpRemoteParams = true, InpAllowLive = false)
  แล้วที่เครื่องรัน `python dobby_agent.py limits --allow-live on --allow-params on`
  จากนั้นเว็บเปิด/ปิดเงินจริงและส่งพรีเซ็ตได้เอง (บอทเปลี่ยนค่าตอนไม่มีไม้ค้างเท่านั้น)
- ที่ยังต้องทำที่เครื่องครั้งเดียว: ลาก EA ใส่ชาร์ต XAUUSD M15 และกดปุ่ม Algo Trading ให้เป็นสีเขียว

## ความปลอดภัย
- เพดานล็อตและเพดานขาดทุนรายวันตั้งที่เครื่อง (`limits`) และใน EA (`InpRemoteMaxLots`, `InpRemoteMaxCapPct`) เว็บตั้งเกินไม่ได้
- เปิดเงินจริงจากเว็บต้องใส่รหัสผ่านซ้ำภายใน 5 นาที และรหัส 2FA ถ้าเปิดไว้ (ตรวจในฐานข้อมูล ไม่ใช่แค่หน้าเว็บ)
- ปิดเงินจริงได้ทันทีเสมอ ทุกการเปลี่ยนแปลงถูกบันทึก (หน้าบันทึกการเปลี่ยนแปลง)
- สงสัยว่ารหัสหลุด: ที่เครื่องรัน `python dobby_agent.py limits --allow-control off` แล้วเปลี่ยนรหัสผ่านเว็บ
- แต่ละคนเห็นแค่บอทของตัวเอง admin เห็นรายชื่อผู้ใช้ ไม่เห็นยอดเงินหรือพรีเซ็ตของเพื่อน
- Publishable key ใน `docs/js/config.js` เปิดเผยได้ ห้ามใส่ secret / service_role key ใน repo นี้

## เพื่อนจะใช้
1. หน้า "ผู้ใช้" → สร้างรหัสเชิญ → ส่งลิงก์เว็บ + รหัสให้เพื่อน
2. เพื่อนสมัคร แล้วทำตามหน้า "ดาวน์โหลด & ติดตั้ง" บนเว็บ (MT5, EA, พรีเซ็ต, ตัวเชื่อม)
3. บอทนี้มีความเสี่ยงจริง (ผลจำลองในอดีต: โอกาสทุนหายครึ่งใน 30 วันราว 29% ที่ขนาดล็อตมาตรฐาน) เพื่อนควรรู้ก่อนใช้

## สำหรับนักพัฒนา
| โฟลเดอร์ | คืออะไร | ทดสอบ |
|---|---|---|
| `docs/` | เว็บ (JS ล้วน ไม่ต้อง build) ดู [docs/README.md](docs/README.md) | เปิด `?demo=1` |
| `supabase/` | schema.sql + seed ข่าว ดู [supabase/README.md](supabase/README.md) | `cd supabase/tests && npm install && npm test` |
| `agent/` | ตัวเชื่อม Python | `cd agent && python -m pytest -q` |
