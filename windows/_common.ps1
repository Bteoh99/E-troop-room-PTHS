# Shared helpers for the e-Troop Store Room Windows scripts.
# Windows PowerShell 5.1 compatible (built into Windows 10). Keep this file plain ASCII.

Set-StrictMode -Version 2.0
# Native programs (node, npm, git) are checked with $LASTEXITCODE; 'Continue' stops harmless
# npm warnings on stderr from being treated as fatal errors by PowerShell 5.1.
$ErrorActionPreference = 'Continue'

$script:TaskName = 'e-Troop Store Room'
$script:FirewallRuleName = 'e-Troop Store Room'
$script:RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$script:BackendDir = Join-Path $script:RepoRoot 'backend'
$script:FrontendDir = Join-Path $script:RepoRoot 'frontend'
$script:StartBat = Join-Path $PSScriptRoot 'start.bat'

function Write-Step([string]$Message) {
    Write-Host ''
    Write-Host ('==> ' + $Message) -ForegroundColor Cyan
}

function Write-Ok([string]$Message) {
    Write-Host ('    ' + $Message) -ForegroundColor Green
}

function Write-Note([string]$Message) {
    Write-Host ('    ' + $Message) -ForegroundColor Yellow
}

function Wait-ForEnter {
    Write-Host ''
    [void](Read-Host 'Press Enter to close this window')
}

function Stop-WithError([string]$Message) {
    Write-Host ''
    Write-Host ('PROBLEM: ' + $Message) -ForegroundColor Red
    Write-Host 'Nothing else was changed after this step. See docs\SETUP-WINDOWS.md (Troubleshooting).' -ForegroundColor Red
    Wait-ForEnter
    exit 1
}

function Test-IsAdmin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Re-open the calling script "as Administrator" (Windows asks for permission), then exit this copy.
function Assert-Admin([string]$ScriptPath) {
    if (Test-IsAdmin) { return }
    Write-Host 'This needs Administrator rights. Windows will now ask for permission...' -ForegroundColor Yellow
    $argList = '-NoProfile -ExecutionPolicy Bypass -File "' + $ScriptPath + '"'
    try {
        Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $argList | Out-Null
    } catch {
        Stop-WithError 'Administrator permission was not given. Right-click the file and choose "Run as administrator".'
    }
    exit 0
}

# Read PORT from backend\.env (default 3001).
function Get-AppPort {
    $port = 3001
    $envFile = Join-Path $script:BackendDir '.env'
    if (Test-Path -LiteralPath $envFile) {
        foreach ($line in (Get-Content -LiteralPath $envFile)) {
            if ($line -match '^\s*PORT\s*=\s*"?(\d+)"?\s*$') { $port = [int]$Matches[1] }
        }
    }
    return $port
}

# IPv4 addresses phones can use (skips loopback and 169.254.x.x "no network" addresses).
function Get-LanAddresses {
    $ips = @()
    try {
        $all = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop
        foreach ($a in $all) {
            $ip = [string]$a.IPAddress
            if ($ip -notlike '127.*' -and $ip -notlike '169.254.*') { $ips += $ip }
        }
    } catch {
        Write-Note 'Could not list network addresses.'
    }
    return $ips
}

function Show-Urls {
    $port = Get-AppPort
    Write-Host ''
    Write-Host 'Open the store room app:' -ForegroundColor Green
    Write-Host ('  On this laptop:  http://localhost:' + $port)
    $ips = @(Get-LanAddresses)
    if ($ips.Count -eq 0) {
        Write-Note 'No Wi-Fi address found. Connect the laptop to the troop Wi-Fi.'
    }
    foreach ($ip in $ips) { Write-Host ('  On phones:       http://' + $ip + ':' + $port) -ForegroundColor Green }
}

function Test-TaskExists {
    $task = Get-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue
    return ($null -ne $task)
}

# Stop the scheduled task, the start.bat loop and the node server (only ours).
function Stop-StoreRoom {
    if (Test-TaskExists) {
        Stop-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue
    }
    $serverJs = Join-Path $script:BackendDir 'src\server.js'
    $procs = Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue
    foreach ($p in $procs) {
        $cmd = [string]$p.CommandLine
        if ($cmd -eq '') { continue }
        $isLoop = ($p.Name -eq 'cmd.exe') -and ($cmd.IndexOf($script:StartBat, [StringComparison]::OrdinalIgnoreCase) -ge 0)
        if ($isLoop) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
    }
    foreach ($p in $procs) {
        $cmd = [string]$p.CommandLine
        if ($cmd -eq '') { continue }
        $isServer = ($p.Name -eq 'node.exe') -and ($cmd.IndexOf($serverJs, [StringComparison]::OrdinalIgnoreCase) -ge 0)
        if ($isServer) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
    }
    Start-Sleep -Seconds 2
}

# Wait until http://localhost:<port>/api/health answers (up to ~60 seconds).
function Wait-ForServer {
    $port = Get-AppPort
    $url = 'http://localhost:' + $port + '/api/health'
    for ($i = 0; $i -lt 30; $i++) {
        try {
            $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3
            if ($r.StatusCode -eq 200) { return $true }
        } catch {
            Start-Sleep -Seconds 2
        }
    }
    return $false
}

# Run "npm <args>" in a folder; stop with a clear message if it fails.
function Invoke-Npm([string]$Folder, [string[]]$NpmArgs, [string]$What) {
    Push-Location -LiteralPath $Folder
    try {
        & npm.cmd @NpmArgs
        $code = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    if ($code -ne 0) { Stop-WithError ($What + ' failed (npm exit code ' + $code + '). Check the internet connection and try again.') }
}

function Install-AppDependencies {
    Write-Step 'Installing the server (backend) packages - this can take a few minutes'
    Invoke-Npm $script:BackendDir @('ci', '--omit=dev', '--no-audit', '--no-fund') 'Installing backend packages'
    Write-Ok 'Backend packages installed.'

    Write-Step 'Installing and building the phone app (frontend) - this can take a few minutes'
    Invoke-Npm $script:FrontendDir @('ci', '--include=dev', '--no-audit', '--no-fund') 'Installing frontend packages'
    Invoke-Npm $script:FrontendDir @('run', 'build') 'Building the frontend'
    if (-not (Test-Path -LiteralPath (Join-Path $script:FrontendDir 'dist\index.html'))) {
        Stop-WithError 'The frontend build did not produce frontend\dist\index.html.'
    }
    Write-Ok 'Phone app built.'
}
