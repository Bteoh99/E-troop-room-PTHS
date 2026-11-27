# e-Troop Store Room - stop the app (it starts again at the next restart, or run install.bat).
. (Join-Path $PSScriptRoot '_common.ps1')
Assert-Admin $PSCommandPath

Write-Step 'Stopping the e-Troop Store Room app'
Stop-StoreRoom
Write-Ok 'Stopped. It starts again automatically when the laptop restarts.'
Write-Host '    To start it again now: double-click start-app.bat.'
Wait-ForEnter
