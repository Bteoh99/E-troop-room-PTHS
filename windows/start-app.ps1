# e-Troop Store Room - start the app again now (after stop.bat or a restore). No internet needed.
. (Join-Path $PSScriptRoot '_common.ps1')
Assert-Admin $PSCommandPath

Write-Step 'Starting the e-Troop Store Room app'
try {
    Start-StoreRoomTask
} catch {
    Stop-WithError $_.Exception.Message
}
if (Wait-ForServer) {
    Write-Ok 'The app is running.'
    Show-Urls
} else {
    Write-Note 'The app did not answer. Look at backend\data\logs\server.log, or run install.bat again.'
}
Wait-ForEnter
