@echo off
rem e-Troop Store Room - make a database backup right now (safe while the app is running).
setlocal
for %%I in ("%~dp0..") do set "ROOT=%%~fI"
cd /d "%ROOT%\backend" || goto :fail
node.exe scripts\backup.js
if errorlevel 1 goto :fail
echo.
echo Backup done.
pause
exit /b 0
:fail
echo.
echo The backup did not work. Read the message above.
pause
exit /b 1
