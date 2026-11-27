# e-Troop Store Room - set or change the leader PIN (also repairs a damaged settings file).
. (Join-Path $PSScriptRoot '_common.ps1')
Assert-Admin $PSCommandPath

$nodePath = Get-SystemNodePath
if ($null -eq $nodePath) { Stop-WithError 'Node.js was not found. Run install.bat first.' }
Write-Step 'Change the leader PIN'
Write-Host '    6 to 8 digits (numbers only). Every phone must unlock leader mode again afterwards.'
Push-Location -LiteralPath $script:BackendDir
& $nodePath 'scripts\set-pin.js' '--force'
$code = $LASTEXITCODE
Pop-Location
if ($code -ne 0) { Stop-WithError 'The PIN was not changed.' }
Write-Ok 'Done. The running app uses the new PIN straight away.'
Wait-ForEnter
