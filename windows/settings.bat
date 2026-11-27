@echo off
rem Double-click (or right-click > Run as administrator). Runs settings.ps1; Windows will ask for Administrator rights.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0settings.ps1"
