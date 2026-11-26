@echo off
rem Double-click (or right-click > Run as administrator). Runs stop.ps1; Windows will ask for Administrator rights.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1"
