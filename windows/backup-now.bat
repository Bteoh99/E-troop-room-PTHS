@echo off
rem Double-click (or right-click > Run as administrator). Runs backup-now.ps1; Windows will ask for Administrator rights.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0backup-now.ps1"
