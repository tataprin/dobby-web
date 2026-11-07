@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY where python >nul 2>nul && set "PY=python"
if not defined PY goto nopython
%PY% -c "import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)"
if errorlevel 1 goto oldpython
echo กำลังติดตั้งไลบรารี requests ...
%PY% -m pip install -r requirements.txt
if errorlevel 1 goto pipfail
echo.
echo ติดตั้งเสร็จแล้ว ขั้นต่อไป พิมพ์ทีละคำสั่งในหน้าต่าง Command Prompt ที่เปิดในโฟลเดอร์นี้:
echo   1. %PY% dobby_agent.py setup
echo      ใส่ Supabase URL และ Publishable key ที่หน้า Downloads และ setup บนเว็บ
echo   2. %PY% dobby_agent.py login
echo      ใส่อีเมลและรหัสผ่านของเว็บ agent เก็บไว้แค่ refresh token
echo   3. %PY% dobby_agent.py register --name "Main PC"
echo   4. %PY% dobby_agent.py limits
echo      ตรวจขีดจำกัด เช่น lot สูงสุด และอนุญาตให้เว็บเปิดเทรดจริงหรือไม่
echo   5. ดับเบิลคลิก run_agent.bat ให้ agent ทำงานตลอดเวลา ปิดหน้าต่างนั้นเมื่อต้องการหยุด
echo.
echo หยุดรับคำสั่งจากเว็บทันที:  %PY% dobby_agent.py limits --allow-control off
echo คู่มือฉบับเต็ม: README_TH.md
pause
exit /b 0

:nopython
echo ไม่พบ Python: ติดตั้ง Python 3.8 ขึ้นไปจาก https://www.python.org/downloads/
echo ตอนติดตั้งให้ติ๊ก "Add python.exe to PATH" แล้วเปิด install.bat อีกครั้ง
pause
exit /b 1

:oldpython
echo Python เก่าเกินไป ต้องใช้ 3.8 ขึ้นไป
pause
exit /b 1

:pipfail
echo ติดตั้งไม่สำเร็จ: ตรวจการเชื่อมต่ออินเทอร์เน็ต แล้วเปิด install.bat อีกครั้ง
pause
exit /b 1
