@echo off
rem Build dist\DobbyApp.exe (one file, no console window). Only the person who BUILDS needs Python;
rem friends just download DobbyApp.exe. Re-run any time: the venv in .venv-build is reused.
setlocal
cd /d "%~dp0"
set "HERE=%~dp0"
set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY where python >nul 2>nul && set "PY=python"
if not defined PY goto nopython

if exist ".venv-build\Scripts\python.exe" goto havevenv
echo [1/5] creating the build venv .venv-build
%PY% -m venv .venv-build
if errorlevel 1 goto fail
:havevenv
set "VPY=%HERE%.venv-build\Scripts\python.exe"

echo [2/5] installing pyinstaller + requests into .venv-build
"%VPY%" -m pip install --disable-pip-version-check -q --upgrade pip
"%VPY%" -m pip install --disable-pip-version-check -q "pyinstaller>=6.3,<7" "requests>=2.25,<3"
if errorlevel 1 goto fail

echo [3/5] app icon (drawn by dobby_app.py, no Pillow needed)
if not exist build mkdir build
"%VPY%" "%HERE%dobby_app.py" --make-icon "%HERE%build\dobby.ico"
if errorlevel 1 goto fail

echo [4/5] PyInstaller --onefile --windowed --name DobbyApp
"%VPY%" -m PyInstaller --noconfirm --clean --onefile --windowed --name DobbyApp ^
  --icon "%HERE%build\dobby.ico" --distpath "%HERE%dist" --workpath "%HERE%build\pyinstaller" ^
  --specpath "%HERE%build" --exclude-module PIL --exclude-module pytest --exclude-module numpy ^
  "%HERE%dobby_app.py"
if errorlevel 1 goto fail

echo [5/5] done
for %%F in ("%HERE%dist\DobbyApp.exe") do echo   %%~fF  (%%~zF bytes)
echo Check it:  dist\DobbyApp.exe --selftest %%TEMP%%\dobby_selftest.png --data-dir %%TEMP%%\dobby_selftest
exit /b 0

:nopython
echo Python 3.8+ is needed to build the exe. Install it from https://www.python.org/downloads/
exit /b 1

:fail
echo BUILD FAILED (see the messages above)
exit /b 1
