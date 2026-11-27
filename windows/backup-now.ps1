# e-Troop Store Room - make a database backup right now (safe while the app is running).
. (Join-Path $PSScriptRoot '_common.ps1')
Assert-Admin $PSCommandPath

$nodePath = Get-SystemNodePath
if ($null -eq $nodePath) { Stop-WithError 'Node.js was not found. Run install.bat first.' }
Write-Step 'Backing up the database'
Push-Location -LiteralPath $script:BackendDir
& $nodePath 'scripts\backup.js'
$code = $LASTEXITCODE
Pop-Location
if ($code -ne 0) { Stop-WithError 'The backup did not work. Read the message above (is the backup folder in backend\.env correct?).' }
Write-Ok 'Backup done.'
Wait-ForEnter
