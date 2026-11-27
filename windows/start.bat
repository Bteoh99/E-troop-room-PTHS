@echo off
rem e-Troop Store Room - runs the server and restarts it if it stops.
rem Started by the Task Scheduler task "e-Troop Store Room" (see install.ps1). Plain ASCII, CRLF.
rem Uses only absolute paths: the node.exe recorded by install.ps1, and Windows' own ping.exe.
setlocal
for %%I in ("%~dp0..") do set "ROOT=%%~fI"
set "BACKEND=%ROOT%\backend"
cd /d "%BACKEND%" || exit /b 1
if not exist "%BACKEND%\data\logs" mkdir "%BACKEND%\data\logs"
set "LOG=%BACKEND%\data\logs\server.log"
set "NODE_ENV=production"
set "PING=%SystemRoot%\System32\PING.EXE"

set "NODE="
if exist "%BACKEND%\data\node-path.txt" set /p NODE=<"%BACKEND%\data\node-path.txt"
if not defined NODE (
  echo [%date% %time%] node.exe path not recorded - run windows\install.bat>>"%LOG%"
  exit /b 1
)
if not exist "%NODE%" (
  echo [%date% %time%] node.exe not found at "%NODE%" - reinstall Node.js 22 for all users, then run windows\install.bat>>"%LOG%"
  exit /b 1
)

:loop
call :rotate
echo [%date% %time%] starting server>>"%LOG%"
"%NODE%" "%BACKEND%\src\server.js" >>"%LOG%" 2>&1
echo [%date% %time%] server stopped with exit code %errorlevel% - restarting in 10 seconds>>"%LOG%"
rem "timeout" needs a console; ping works everywhere (also as a background task).
"%PING%" -n 11 127.0.0.1 >nul
goto loop

:rotate
if not exist "%LOG%" exit /b 0
for %%A in ("%LOG%") do set "SIZE=%%~zA"
if %SIZE% GTR 5242880 (
  if exist "%LOG%.1" del /q "%LOG%.1"
  move /y "%LOG%" "%LOG%.1" >nul
)
exit /b 0
