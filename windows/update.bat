@echo off
rem Double-click (or right-click > Run as administrator). Runs update.ps1; Windows will ask for Administrator rights.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0update.ps1"
