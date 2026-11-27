# e-Troop Store Room - install / repair (safe to run again).
# Run with install.bat (it asks for Administrator rights). Windows PowerShell 5.1, plain ASCII.

. (Join-Path $PSScriptRoot '_common.ps1')
Assert-Admin $PSCommandPath

Write-Host 'e-Troop Store Room - installation' -ForegroundColor Cyan
Write-Host ('Folder: ' + $script:RepoRoot)

# 1. Checks
Write-Step 'Checking Windows, Node.js and Git'
if (-not [Environment]::Is64BitOperatingSystem) { Stop-WithError 'This laptop runs 32-bit Windows. A 64-bit Windows 10 is needed.' }
$nodePath = Get-SystemNodePath
if ($null -eq $nodePath) {
    Stop-WithError 'Node.js is not installed (or the laptop needs a restart after installing it). Install Node.js 22 LTS (Windows Installer, 64-bit) from nodejs.org, restart the laptop, then run install.bat again.'
}
$nodeVersion = [string](& $nodePath -v)
$nodeArch = [string](& $nodePath -p 'process.arch')
$major = 0
if ($nodeVersion -match '^v(\d+)\.') { $major = [int]$Matches[1] }
if ($major -lt 22) { Stop-WithError ('Node.js ' + $nodeVersion + ' is too old. Install Node.js 22 LTS (64-bit) from nodejs.org.') }
if ($nodeArch.Trim() -ne 'x64') { Stop-WithError ('Node.js is the ' + $nodeArch + ' version. Uninstall it and install the 64-bit (x64) Node.js 22 LTS.') }
if ($null -eq (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { Stop-WithError 'npm was not found. Reinstall Node.js 22 LTS from nodejs.org.' }
Write-Ok ('Node.js ' + $nodeVersion + ' (' + $nodeArch.Trim() + ') found: ' + $nodePath)
if ($null -eq (Get-Command git.exe -ErrorAction SilentlyContinue)) {
    Write-Note 'Git is not installed. The app will work, but update.bat needs Git. Install it from git-scm.com.'
} else {
    Write-Ok 'Git found.'
}

# 2. Stop a running copy so its files can be replaced
if (Test-TaskExists) {
    Write-Step 'Stopping the running app'
    Stop-StoreRoom
    Write-Ok 'Stopped.'
}

# 3. Packages + build
try {
    Install-AppDependencies
} catch {
    Stop-WithError $_.Exception.Message
}

# 4. Settings file and folders
Write-Step 'Settings'
$envFile = Join-Path $script:BackendDir '.env'
if (-not (Test-Path -LiteralPath $envFile)) {
    Copy-Item -LiteralPath (Join-Path $script:BackendDir '.env.example') -Destination $envFile
    Write-Ok 'Created backend\.env from .env.example (use settings.bat to change the backup folder).'
} else {
    Write-Ok 'backend\.env already exists - kept as it is.'
}
New-Item -ItemType Directory -Force -Path (Join-Path $script:BackendDir 'data\logs') | Out-Null
# start.bat uses exactly this node.exe (never whatever "node" happens to be found first).
[IO.File]::WriteAllText($script:NodePathFile, $nodePath)
$port = Get-AppPort
Write-Ok ('Port: ' + $port)

# 5. Protect the folder: the app runs as SYSTEM, so only Administrators may change its files,
#    and only Administrators/SYSTEM may read the database and PIN settings.
Write-Step 'Protecting the app folder (only Administrators can change it)'
try {
    Protect-AppFolder
    Write-Ok 'Done. Other Windows users can no longer change the app or read its data.'
} catch {
    Stop-WithError $_.Exception.Message
}

# 6. Leader PIN
Write-Step 'Leader PIN'
Push-Location -LiteralPath $script:BackendDir
& $nodePath 'scripts\set-pin.js' '--check' | Out-Null
$pinState = $LASTEXITCODE
if ($pinState -eq 0) {
    Write-Ok 'A leader PIN is already set. (To change it later: double-click windows\set-pin.bat.)'
} else {
    if ($pinState -eq 2) { Write-Note 'The PIN settings file is damaged; it will be replaced (a copy of the damaged file is kept).' }
    Write-Host '    Choose the leader PIN now: 4 to 8 digits, 6 digits recommended.'
    Write-Host '    You will type it twice; the digits are shown as *.'
    & $nodePath 'scripts\set-pin.js' '--force'
    if ($LASTEXITCODE -ne 0) {
        Pop-Location
        Stop-WithError 'The leader PIN was not set. Run install.bat again (or windows\set-pin.bat).'
    }
}
Pop-Location

# 7. Firewall: allow phones on PRIVATE networks, from the local Wi-Fi subnet only
Write-Step ('Allowing phones on the private Wi-Fi to reach port ' + $port)
Get-NetFirewallRule -DisplayName $script:FirewallRuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
try {
    New-NetFirewallRule -DisplayName $script:FirewallRuleName -Description 'Phones on the troop Wi-Fi open the e-Troop Store Room app' `
        -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port -Profile Private -RemoteAddress LocalSubnet -ErrorAction Stop | Out-Null
    Write-Ok 'Firewall rule added (Private networks, local subnet only).'
} catch {
    Stop-WithError ('Could not add the firewall rule: ' + $_.Exception.Message)
}
$blockRules = @(Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue | Where-Object { $_.Program -like '*\node.exe' } |
    Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.Action -eq 'Block' -and $_.Direction -eq 'Inbound' -and $_.Enabled -eq 'True' })
if ($blockRules.Count -gt 0) {
    Write-Note ('Windows has ' + $blockRules.Count + ' firewall rule(s) that BLOCK Node.js (from an earlier "Cancel" on a security popup). They stop phones from connecting.')
    $answer = Read-Host '    Remove those Node.js block rules? (Y/N)'
    if ($answer -match '^[Yy]') {
        $blockRules | Remove-NetFirewallRule -ErrorAction SilentlyContinue
        Write-Ok 'Removed.'
    }
}

$publicNets = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue | Where-Object { $_.NetworkCategory -eq 'Public' })
foreach ($net in $publicNets) {
    Write-Note ('The network "' + $net.Name + '" is set to Public, so phones cannot connect through it.')
    $answer = Read-Host '    Is this the troop Wi-Fi and do you trust it? Make it Private? (Y/N)'
    if ($answer -match '^[Yy]') {
        try {
            Set-NetConnectionProfile -InterfaceIndex $net.InterfaceIndex -NetworkCategory Private -ErrorAction Stop
            Write-Ok ('"' + $net.Name + '" is now Private.')
        } catch {
            Write-Note ('Could not change it: ' + $_.Exception.Message + ' (see the guide: Wi-Fi -> Private).')
        }
    }
}

# 8. Start automatically with Windows (even when nobody logs in)
Write-Step 'Making the app start automatically when the laptop starts'
if (Test-TaskExists) { Unregister-ScheduledTask -TaskName $script:TaskName -Confirm:$false -ErrorAction SilentlyContinue }
try {
    $action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\cmd.exe') -Argument ('/c ""' + $script:StartBat + '""') -WorkingDirectory $script:BackendDir
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $trigger.Delay = 'PT30S'
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
        -DontStopOnIdleEnd -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1) `
        -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $script:TaskName -Description 'e-Troop Store Room web app for the troop Wi-Fi' `
        -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force -ErrorAction Stop | Out-Null
    Write-Ok ('Task "' + $script:TaskName + '" registered.')
} catch {
    Stop-WithError ('Could not create the start-up task: ' + $_.Exception.Message)
}

# 9. Keep the laptop awake while plugged in
Write-Step 'Power settings'
$answer = Read-Host '    Keep the laptop awake when plugged in (no sleep, keep running with the lid closed)? (Y/N)'
if ($answer -match '^[Yy]') {
    & powercfg.exe /change standby-timeout-ac 0 | Out-Null
    & powercfg.exe /change hibernate-timeout-ac 0 | Out-Null
    & powercfg.exe /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0 | Out-Null
    & powercfg.exe /setactive SCHEME_CURRENT | Out-Null
    Write-Ok 'Done: no sleep on mains power; closing the lid does nothing on mains power.'
} else {
    Write-Note 'Skipped. If the laptop sleeps, phones cannot reach the app.'
}

# 10. Start now
Write-Step 'Starting the app'
Start-ScheduledTask -TaskName $script:TaskName
if (Wait-ForServer) {
    Write-Ok 'The app is running.'
} else {
    Write-Note 'The app did not answer yet. Look at backend\data\logs\server.log (open it with an administrator Notepad), or restart the laptop.'
}
Show-Urls
Write-Host ''
Write-Host 'Tip: give the laptop a fixed address in the router (DHCP reservation) so this link never changes.'
Wait-ForEnter
