# e-Troop Store Room - update to the newest version (git pull, reinstall packages, rebuild, restart).
# Run with update.bat. Your items, PIN, settings and backups (backend\data, backend\.env) are kept.
# Whatever happens, the script tries to start the app again at the end and says what failed.

. (Join-Path $PSScriptRoot '_common.ps1')
Assert-Admin $PSCommandPath

Write-Host 'e-Troop Store Room - update' -ForegroundColor Cyan
if ($null -eq (Get-Command git.exe -ErrorAction SilentlyContinue)) { Stop-WithError 'Git is not installed. Install Git from git-scm.com, then try again.' }
if (-not (Test-Path -LiteralPath (Join-Path $script:RepoRoot '.git'))) { Stop-WithError 'This folder was not downloaded with Git, so it cannot update itself. See docs\SETUP-WINDOWS.md.' }
$nodePath = Get-SystemNodePath
if ($null -eq $nodePath) { Stop-WithError 'Node.js was not found. Run install.bat first.' }

Write-Step 'Backing up the database first'
Push-Location -LiteralPath $script:BackendDir
& $nodePath 'scripts\backup.js'
Pop-Location

$failedStep = $null
try {
    Write-Step 'Stopping the app'
    Stop-StoreRoom
    Write-Ok 'Stopped.'

    Write-Step 'Downloading the newest version (git pull)'
    $safeDir = $script:RepoRoot -replace '\\', '/'
    & git.exe -c ('safe.directory=' + $safeDir) -C $script:RepoRoot pull --ff-only
    if ($LASTEXITCODE -ne 0) { throw 'Downloading the new version (git pull) failed: no internet, or files in the folder were changed by hand. Nothing was changed; the old version is started again.' }

    Install-AppDependencies
    [IO.File]::WriteAllText($script:NodePathFile, $nodePath)
    Protect-AppFolder
} catch {
    $failedStep = $_.Exception.Message
} finally {
    Write-Step 'Starting the app'
    try {
        Start-StoreRoomTask
    } catch {
        Write-Note $_.Exception.Message
    }
}

$running = Wait-ForServer
if ($running) { Write-Ok 'The app is running.' }
if ($null -ne $failedStep) {
    Write-Host ''
    Write-Host ('THE UPDATE DID NOT FINISH: ' + $failedStep) -ForegroundColor Red
    if ($running) {
        Write-Host 'The app is running again. Fix the problem (usually: connect to the internet) and run update.bat again.' -ForegroundColor Yellow
    } else {
        Write-Host 'The app is NOT running, because the update stopped halfway. Connect to the internet and run update.bat again.' -ForegroundColor Red
        Write-Host 'Your data is safe in backend\data (a backup was made just before the update).' -ForegroundColor Yellow
    }
    Wait-ForEnter
    exit 1
}
if (-not $running) { Write-Note 'The app did not answer yet. Look at backend\data\logs\server.log, or restart the laptop.' }
Show-Urls
Wait-ForEnter
