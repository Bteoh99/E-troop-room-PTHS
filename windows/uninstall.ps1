# e-Troop Store Room - remove the start-up task and firewall rule. KEEPS all data
# (backend\data: database, PIN, backups, logs) and the folder itself.
. (Join-Path $PSScriptRoot '_common.ps1')
Assert-Admin $PSCommandPath

Write-Host 'e-Troop Store Room - uninstall (your data is kept)' -ForegroundColor Cyan
Write-Step 'Stopping the app'
Stop-StoreRoom

Write-Step 'Removing the start-up task'
if (Test-TaskExists) {
    Unregister-ScheduledTask -TaskName $script:TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Ok 'Removed.'
} else {
    Write-Ok 'There was no task.'
}

Write-Step 'Removing the firewall rule'
Get-NetFirewallRule -DisplayName $script:FirewallRuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
Write-Ok 'Removed.'

Write-Host ''
Write-Host ('Your data is still in: ' + (Join-Path $script:BackendDir 'data')) -ForegroundColor Green
Write-Host 'Power settings were not changed back. To undo them: Settings > System > Power & sleep.'
Write-Host 'To delete everything, delete the whole folder after copying backend\data somewhere safe.'
Wait-ForEnter
