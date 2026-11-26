@echo off
rem e-Troop Store Room - runs the server and restarts it if it stops.
rem Started by the Task Scheduler task "e-Troop Store Room" (see install.ps1). Plain ASCII, CRLF.
setlocal
for %%I in ("%~dp0..") do set "ROOT=%%~fI"
set "BACKEND=%ROOT%\backend"
cd /d "%BACKEND%" || exit /b 1
if not exist "%BACKEND%\data\logs" mkdir "%BACKEND%\data\logs"
set "LOG=%BACKEND%\data\logs\server.log"
set "NODE_ENV=production"

set "NODE=node.exe"
where node.exe >nul 2>&1
if errorlevel 1 set "NODE=%ProgramFiles%\nodejs\node.exe"

:loop
call :rotate
echo [%date% %time%] starting server>>"%LOG%"
"%NODE%" "%BACKEND%\src\server.js" >>"%LOG%" 2>&1
echo [%date% %time%] server stopped with exit code %errorlevel% - restarting in 10 seconds>>"%LOG%"
rem "timeout" needs a console; ping works everywhere (also as a background task).
ping -n 11 127.0.0.1 >nul
goto loop

:rotate
if not exist "%LOG%" exit /b 0
for %%A in ("%LOG%") do set "SIZE=%%~zA"
if %SIZE% GTR 5242880 (
  if exist "%LOG%.1" del /q "%LOG%.1"
  move /y "%LOG%" "%LOG%.1" >nul
)
exit /b 0
