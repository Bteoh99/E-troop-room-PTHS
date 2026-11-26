@echo off
rem Double-click (or right-click > Run as administrator). Runs uninstall.ps1; Windows will ask for Administrator rights.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1"
