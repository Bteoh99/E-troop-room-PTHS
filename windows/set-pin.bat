@echo off
rem Double-click (or right-click > Run as administrator). Runs set-pin.ps1; Windows will ask for Administrator rights.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0set-pin.ps1"
