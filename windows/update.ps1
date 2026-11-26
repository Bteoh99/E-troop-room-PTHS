# e-Troop Store Room - update to the newest version (git pull, reinstall packages, rebuild, restart).
# Run with update.bat. Your items, PIN, settings and backups (backend\data, backend\.env) are kept.

. (Join-Path $PSScriptRoot '_common.ps1')
Assert-Admin $PSCommandPath

Write-Host 'e-Troop Store Room - update' -ForegroundColor Cyan
if ($null -eq (Get-Command git.exe -ErrorAction SilentlyContinue)) { Stop-WithError 'Git is not installed. Install Git from git-scm.com, then try again.' }
if (-not (Test-Path -LiteralPath (Join-Path $script:RepoRoot '.git'))) { Stop-WithError 'This folder was not downloaded with Git, so it cannot update itself. See docs\SETUP-WINDOWS.md.' }

Write-Step 'Backing up the database first'
Push-Location -LiteralPath $script:BackendDir
& node.exe 'scripts\backup.js'
Pop-Location

Write-Step 'Stopping the app'
Stop-StoreRoom
Write-Ok 'Stopped.'

Write-Step 'Downloading the newest version (git pull)'
& git.exe -C $script:RepoRoot pull --ff-only
if ($LASTEXITCODE -ne 0) {
    Start-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue
    Stop-WithError 'git pull failed (no internet, or files in the folder were changed by hand). The old version was started again.'
}

Install-AppDependencies

Write-Step 'Starting the app'
Start-ScheduledTask -TaskName $script:TaskName
if (Wait-ForServer) { Write-Ok 'The app is running.' } else { Write-Note 'The app did not answer yet. Look at backend\data\logs\server.log.' }
Show-Urls
Wait-ForEnter
