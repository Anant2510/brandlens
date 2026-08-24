#Requires -Version 5.1
<#
.SYNOPSIS
    Shows what is running: PM2 processes, Windows services, and listening ports.

.DESCRIPTION
    Read-only. Answers the three questions an operator actually has at 3am:

      * is PM2 supervising all four processes, and how often have they restarted
      * is the boot-time service registered and running
      * is anything actually listening on 3000 / 4000 / 8000 / 5432

    For a functional probe of each service (HTTP + database), use
    healthcheck.ps1 instead -- this script deliberately does no I/O against the
    services, so it still works when they are wedged.

.PARAMETER Detailed
    Also show `pm2 describe` for each process (env, script path, exec mode).

.PARAMETER Json
    Emit a machine-readable object instead of the formatted tables.

.EXAMPLE
    .\status.ps1

.EXAMPLE
    .\status.ps1 -Json | ConvertTo-Json -Depth 6
#>
[CmdletBinding()]
param(
    [switch]$Detailed,
    [switch]$Json
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')

if ($Json) { Set-BrandLensQuiet $true }

Write-Banner 'BrandLens - status' (Get-BrandLensRoot)

# ---------------------------------------------------------------------------
# PM2
# ---------------------------------------------------------------------------
$pm2 = Get-Pm2Command
$processes = @()

if ($pm2) {
    # `pm2 jlist` is the stable machine interface; the pretty table is not.
    $raw = & $pm2 jlist 2>&1 | Out-String
    try {
        # Case-sensitive parser: pm2_env carries the Windows environment block,
        # where 'username' and 'USERNAME' both appear and ConvertFrom-Json
        # rejects them as duplicates.
        $parsed = ConvertFrom-JsonSafe $raw
        if ($null -eq $parsed) { throw 'pm2 jlist returned no parseable JSON' }
        # Dictionary indexing, not dot-access: ConvertFrom-JsonSafe returns
        # Dictionary<string,object> so that key comparison stays case-sensitive.
        foreach ($proc in $parsed) {
            $procStatus = Get-JsonValue $proc 'pm2_env' 'status'
            $uptimeMs   = Get-JsonValue $proc 'pm2_env' 'pm_uptime'
            $memBytes   = Get-JsonValue $proc 'monit' 'memory'
            $processes += [pscustomobject]@{
                Name      = Get-JsonValue $proc 'name'
                Status    = $procStatus
                PID       = Get-JsonValue $proc 'pid'
                Restarts  = Get-JsonValue $proc 'pm2_env' 'restart_time'
                Uptime    = if ($procStatus -eq 'online' -and $uptimeMs) {
                    $span = (Get-Date) - ([DateTimeOffset]::FromUnixTimeMilliseconds([int64]$uptimeMs)).LocalDateTime
                    '{0}d {1:00}h {2:00}m' -f [int]$span.TotalDays, $span.Hours, $span.Minutes
                } else { '-' }
                MemoryMB  = if ($memBytes) { [math]::Round([double]$memBytes / 1MB, 1) } else { 0 }
                CPU       = Get-JsonValue $proc 'monit' 'cpu'
                Instances = Get-JsonValue $proc 'pm2_env' 'instances'
            }
        }
    } catch {
        if (-not $Json) {
            Write-Warn 'could not parse `pm2 jlist` output'
            Write-Info $raw.Trim()
        }
    }
} elseif (-not $Json) {
    Write-Warn 'pm2 is not installed or not on PATH'
}

# Report processes PM2 does not know about at all -- "0 restarts, missing" is a
# very different situation from "errored, 47 restarts".
$known = $processes.Name
$missing = @($BrandLensProcesses | Where-Object { $_ -notin $known })

# ---------------------------------------------------------------------------
# Services
# ---------------------------------------------------------------------------
$services = @()
foreach ($name in @('PM2', 'pm2.exe', 'BrandLens', 'postgresql-x64-16', 'postgresql-x64-17')) {
    $svc = Get-Service -Name $name -ErrorAction SilentlyContinue
    if ($svc) {
        $services += [pscustomobject]@{
            Name      = $svc.Name
            Display   = $svc.DisplayName
            Status    = $svc.Status
            StartType = $svc.StartType
        }
    }
}

# ---------------------------------------------------------------------------
# Ports
# ---------------------------------------------------------------------------
$envMap = Read-DotEnv
$portMap = [ordered]@{
    'web'        = [int](Get-EnvValue -Key 'WEB_PORT' -Env $envMap -Default '3000')
    'api'        = [int](Get-EnvValue -Key 'API_PORT' -Env $envMap -Default '4000')
    'engine'     = [int](Get-EnvValue -Key 'ENGINE_PORT' -Env $envMap -Default '8000')
    'postgresql' = 5432
}
try {
    $dbUrl = Get-EnvValue -Key 'DATABASE_URL' -Env $envMap
    if ($dbUrl) { $portMap['postgresql'] = (ConvertFrom-DatabaseUrl $dbUrl).Port }
} catch { }

$ports = @()
foreach ($entry in $portMap.GetEnumerator()) {
    $listening = Test-TcpPort -Port $entry.Value -TimeoutMs 800
    $owner = ''
    try {
        $conn = Get-NetTCPConnection -LocalPort $entry.Value -State Listen -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($conn) {
            $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
            $owner = if ($proc) { "$($proc.ProcessName) ($($conn.OwningProcess))" } else { "pid $($conn.OwningProcess)" }
        }
    } catch {
        # Get-NetTCPConnection is absent on some Server Core SKUs; the TCP
        # probe above is enough to answer the question.
    }
    $ports += [pscustomobject]@{
        Service   = $entry.Key
        Port      = $entry.Value
        Listening = $listening
        Owner     = $owner
    }
}

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------
if ($Json) {
    [pscustomobject]@{
        processes = $processes
        missing   = $missing
        services  = $services
        ports     = $ports
        root      = Get-BrandLensRoot
    }
    exit 0
}

Write-Host ''
Write-Host '  PM2 processes' -ForegroundColor Cyan
if ($processes.Count -gt 0) {
    $processes | Write-TableBlock
} else {
    Write-Info '(none)'
}

if ($missing.Count -gt 0) {
    Write-Host ''
    Write-Warn ('not registered with PM2: ' + ($missing -join ', '))
    Write-Hint @('Start them with:  .\infra\windows\start-all.ps1')
}

$errored = @($processes | Where-Object { $_.Status -ne 'online' })
if ($errored.Count -gt 0) {
    Write-Host ''
    foreach ($proc in $errored) {
        Write-Warn "$($proc.Name) is '$($proc.Status)' after $($proc.Restarts) restart(s)"
    }
    Write-Hint @('Read the reason:  pm2 logs <name> --lines 80 --err')
}

Write-Host ''
Write-Host '  Windows services' -ForegroundColor Cyan
if ($services.Count -gt 0) {
    $services | Write-TableBlock
} else {
    Write-Info '(none found -- BrandLens will not start automatically after a reboot)'
    Write-Hint @('Install it:  .\infra\windows\install-services.ps1')
}

Write-Host ''
Write-Host '  Ports' -ForegroundColor Cyan
$ports | Write-TableBlock

if ($Detailed -and $pm2) {
    foreach ($proc in $processes) {
        Write-Host ''
        Write-Host "  --- $($proc.Name) ---" -ForegroundColor DarkGray
        & $pm2 describe $proc.Name
    }
}

Write-Host ''
Write-Host '  Functional probe:  .\infra\windows\healthcheck.ps1' -ForegroundColor Cyan
Write-Host ''
exit 0
