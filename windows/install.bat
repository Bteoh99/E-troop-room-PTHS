@echo off
rem Double-click (or right-click > Run as administrator). Runs install.ps1; Windows will ask for Administrator rights.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
