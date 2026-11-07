@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set "PYTHONIOENCODING=utf-8"
set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY set "PY=python"
title Dobby agent

:loop
%PY% dobby_agent.py run
set "CODE=%ERRORLEVEL%"
if "%CODE%"=="0" goto stopped
if "%CODE%"=="2" goto config
if "%CODE%"=="3" goto running
echo [%date% %time%] agent หยุดทำงานผิดปกติ code %CODE% จะเริ่มใหม่ใน 10 วินาที กด Ctrl+C เพื่อหยุด
ping -n 11 127.0.0.1 >nul
goto loop

:config
echo การตั้งค่ายังไม่ครบ: ทำตามข้อความด้านบน setup / login / register แล้วเปิด run_agent.bat อีกครั้ง
pause
exit /b 2

:running
echo มี agent อีกหน้าต่างหนึ่งกำลังทำงานอยู่แล้ว
pause
exit /b 3

:stopped
echo agent หยุดแล้ว
pause
exit /b 0
