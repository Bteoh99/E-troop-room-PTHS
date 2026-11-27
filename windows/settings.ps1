# e-Troop Store Room - edit backend\.env (port, backup folder, backup time) and restart the app.
. (Join-Path $PSScriptRoot '_common.ps1')
Assert-Admin $PSCommandPath

$envFile = Join-Path $script:BackendDir '.env'
if (-not (Test-Path -LiteralPath $envFile)) {
    Copy-Item -LiteralPath (Join-Path $script:BackendDir '.env.example') -Destination $envFile
}
$oldPort = Get-AppPort
Write-Step 'Opening the settings in Notepad. Save (Ctrl+S) and close Notepad when you are done.'
Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\notepad.exe') -ArgumentList ('"' + $envFile + '"') -Wait
$newPort = Get-AppPort
if ($newPort -ne $oldPort) {
    Write-Step ('The port changed from ' + $oldPort + ' to ' + $newPort + ': updating the firewall rule')
    try {
        Set-AppFirewallRule $newPort
        Write-Ok ('Phones can now reach port ' + $newPort + ' (Private networks, local subnet only). Update their bookmarks.')
    } catch {
        Write-Note ('Could not update the firewall rule: ' + $_.Exception.Message + ' - run install.bat to fix it.')
    }
}
$answer = Read-Host '    Restart the app now so the changes take effect? (Y/N)'
if ($answer -match '^[Yy]') {
    Stop-StoreRoom
    try { Start-StoreRoomTask } catch { Stop-WithError $_.Exception.Message }
    if (Wait-ForServer) { Write-Ok 'The app is running with the new settings.'; Show-Urls } else { Write-Note 'The app did not answer. Look at backend\data\logs\server.log.' }
}
Wait-ForEnter
