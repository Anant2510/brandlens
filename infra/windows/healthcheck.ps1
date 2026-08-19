#Requires -Version 5.1
<#
.SYNOPSIS
    Probes all four BrandLens services plus the database and prints a status table.

.DESCRIPTION
    Functional, not cosmetic: every row is a real request, not a process check.
    A process can be "online" in PM2 and still be unable to serve traffic --
    that is exactly the failure this script exists to catch.

    Checks, in order of dependency:

      database   SELECT 1 over psql using DATABASE_URL from .env
      engine     GET  {ENGINE_URL}/health
      api        GET  {API_PUBLIC_URL}/health          (liveness)
      api-deep   GET  {API_PUBLIC_URL}/health/deep     (db, queue, storage,
                                                        engine, vector driver,
                                                        outbox, providers)
      web        GET  {WEB_PUBLIC_URL}/
      pm2        all four processes online

    Exit code is 0 only when every required check passes, so this is safe to
    drive from a Windows scheduled task or an external monitor:

        schtasks /create /tn "BrandLens health" /sc minute /mo 5 /ru SYSTEM ^
          /tr "powershell -NoProfile -ExecutionPolicy Bypass -File C:\brandlens\infra\windows\healthcheck.ps1 -Quiet"

.PARAMETER Quiet
    Suppress the table; only failures are printed. For scheduled tasks.

.PARAMETER Json
    Emit a machine-readable result object.

.PARAMETER TimeoutSeconds
    Per-request timeout. Default 8. The deep check touches every dependency,
    so it gets double.

.PARAMETER SkipWeb
    Do not probe the console (headless / API-only deployments).

.PARAMETER WarnOnly
    Always exit 0. Useful while a deployment is still settling.

.EXAMPLE
    .\healthcheck.ps1

.EXAMPLE
    .\healthcheck.ps1 -Json | ConvertFrom-Json

.EXAMPLE
    if (-not (.\healthcheck.ps1 -Quiet)) { Send-Alert }
#>
[CmdletBinding()]
param(
    [switch]$Quiet,
    [switch]$Json,
    [int]$TimeoutSeconds = 8,
    [switch]$SkipWeb,
    [switch]$WarnOnly
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')

if ($Quiet -or $Json) { Set-BrandLensQuiet $true }

$envMap = Read-DotEnv
$apiUrl = (Get-EnvValue -Key 'API_PUBLIC_URL' -Env $envMap -Default 'http://localhost:4000').TrimEnd('/')
$webUrl = (Get-EnvValue -Key 'WEB_PUBLIC_URL' -Env $envMap -Default 'http://localhost:3000').TrimEnd('/')
$engineUrl = (Get-EnvValue -Key 'ENGINE_URL' -Env $envMap -Default 'http://127.0.0.1:8000').TrimEnd('/')
$databaseUrl = Get-EnvValue -Key 'DATABASE_URL' -Env $envMap -Default 'postgresql://brandlens:brandlens@localhost:5432/brandlens'

Write-Banner 'BrandLens - healthcheck' (Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')

$results = [System.Collections.Generic.List[object]]::new()

function Format-ProbeError {
    <#
    .SYNOPSIS
        Human-readable reason from a Test-HttpEndpoint result.
    #>
    param($Probe)
    if ($Probe.Error) { return $Probe.Error }
    return "HTTP $($Probe.Status)"
}

function Add-Check {
    param(
        [string]$Component,
        [bool]$Ok,
        [int]$LatencyMs = 0,
        [string]$Detail = '',
        [bool]$Required = $true
    )
    $results.Add([pscustomobject]@{
            Component = $Component
            Status    = if ($Ok) { 'OK' } elseif ($Required) { 'FAIL' } else { 'WARN' }
            LatencyMs = $LatencyMs
            Detail    = $Detail
            Ok        = $Ok
            Required  = $Required
        })
}

# ---------------------------------------------------------------------------
# 1 -- database
# ---------------------------------------------------------------------------
$psql = Get-PsqlPath
if ($psql) {
    try {
        $target = ConvertFrom-DatabaseUrl $databaseUrl
        $sw = [Diagnostics.Stopwatch]::StartNew()
        $previous = $env:PGPASSWORD
        $env:PGPASSWORD = $target.Password
        try {
            # count(*) over a real table, not SELECT 1: it proves the schema
            # was migrated, not merely that the socket accepted a connection.
            $out = & $psql -h $target.Host -p $target.Port -U $target.User -d $target.Database `
                -v ON_ERROR_STOP=1 -tA -c 'SELECT count(*) FROM organizations' 2>&1 | Out-String
            $code = $LASTEXITCODE
        } finally {
            $env:PGPASSWORD = $previous
        }
        $sw.Stop()
        if ($code -eq 0) {
            Add-Check -Component 'database' -Ok $true -LatencyMs $sw.ElapsedMilliseconds `
                -Detail "$($target.Host):$($target.Port)/$($target.Database), $($out.Trim()) org(s)"
        } else {
            Add-Check -Component 'database' -Ok $false -LatencyMs $sw.ElapsedMilliseconds -Detail $out.Trim()
        }
    } catch {
        Add-Check -Component 'database' -Ok $false -Detail $_.Exception.Message
    }
} else {
    # No psql on this host is not a health failure -- the API's deep check
    # covers the database anyway, from the process that actually needs it.
    Add-Check -Component 'database' -Ok $true -Detail 'psql not installed; covered by api-deep' -Required $false
}

# ---------------------------------------------------------------------------
# 2 -- engine
# ---------------------------------------------------------------------------
$engine = Test-HttpEndpoint -Url "$engineUrl/health" -TimeoutSeconds $TimeoutSeconds
if ($engine.Ok) {
    $detail = "$engineUrl"
    try {
        $body = $engine.Body | ConvertFrom-Json
        if ($body.version) { $detail = "v$($body.version)" }
        if ($body.status) { $detail += " status=$($body.status)" }
    } catch { }
    Add-Check -Component 'engine' -Ok $true -LatencyMs $engine.DurationMs -Detail $detail
} else {
    Add-Check -Component 'engine' -Ok $false -LatencyMs $engine.DurationMs `
        -Detail ("$engineUrl/health -> " + (Format-ProbeError $engine))
}

# ---------------------------------------------------------------------------
# 3 -- api liveness
# ---------------------------------------------------------------------------
$api = Test-HttpEndpoint -Url "$apiUrl/health" -TimeoutSeconds $TimeoutSeconds
if ($api.Ok) {
    $detail = $apiUrl
    try {
        $body = $api.Body | ConvertFrom-Json
        $detail = "v$($body.version), up $([int]$body.uptimeSeconds)s"
    } catch { }
    Add-Check -Component 'api' -Ok $true -LatencyMs $api.DurationMs -Detail $detail
} else {
    Add-Check -Component 'api' -Ok $false -LatencyMs $api.DurationMs `
        -Detail ("$apiUrl/health -> " + (Format-ProbeError $api))
}

# ---------------------------------------------------------------------------
# 4 -- api readiness (every dependency, from inside the process)
# ---------------------------------------------------------------------------
$deepDetails = @()
if ($api.Ok) {
    $deep = Test-HttpEndpoint -Url "$apiUrl/health/deep" -TimeoutSeconds ($TimeoutSeconds * 2)
    if ($deep.Ok) {
        try {
            $body = $deep.Body | ConvertFrom-Json
            $bad = @()
            foreach ($prop in $body.components.PSObject.Properties) {
                if (-not $prop.Value.ok) { $bad += $prop.Name }
                $deepDetails += [pscustomobject]@{
                    Component = "  - $($prop.Name)"
                    Status    = if ($prop.Value.ok) { 'OK' } else { 'FAIL' }
                    LatencyMs = [int]($prop.Value.latencyMs)
                    Detail    = ($prop.Value.detail | ConvertTo-Json -Compress -Depth 3)
                    Ok        = [bool]$prop.Value.ok
                    Required  = $true
                }
            }
            $vector = $body.components.vector.detail.driver
            $summary = "status=$($body.status)"
            if ($vector) { $summary += ", vector=$vector" }
            if ($bad.Count -gt 0) { $summary += ", degraded: $($bad -join ', ')" }
            # A degraded readiness result is a genuine failure: it means some
            # dependency the API needs is unavailable right now.
            Add-Check -Component 'api-deep' -Ok ($body.status -eq 'ok') -LatencyMs $deep.DurationMs -Detail $summary
        } catch {
            Add-Check -Component 'api-deep' -Ok $false -LatencyMs $deep.DurationMs -Detail 'unparseable response'
        }
    } else {
        Add-Check -Component 'api-deep' -Ok $false -LatencyMs $deep.DurationMs `
            -Detail (Format-ProbeError $deep)
    }
} else {
    Add-Check -Component 'api-deep' -Ok $false -Detail 'skipped -- api liveness failed'
}

# ---------------------------------------------------------------------------
# 5 -- web console
# ---------------------------------------------------------------------------
if (-not $SkipWeb) {
    $web = Test-HttpEndpoint -Url "$webUrl/" -TimeoutSeconds $TimeoutSeconds
    if ($web.Ok) {
        Add-Check -Component 'web' -Ok $true -LatencyMs $web.DurationMs -Detail "$webUrl (HTTP $($web.Status))"
    } else {
        Add-Check -Component 'web' -Ok $false -LatencyMs $web.DurationMs `
            -Detail ("$webUrl -> " + (Format-ProbeError $web))
    }
}

# ---------------------------------------------------------------------------
# 6 -- PM2 supervision
# ---------------------------------------------------------------------------
$pm2 = Get-Pm2Command
if ($pm2) {
    try {
        $list = (& $pm2 jlist 2>&1 | Out-String) | ConvertFrom-Json
        $expected = if ($SkipWeb) { $BrandLensProcesses | Where-Object { $_ -ne 'brandlens-web' } } else { $BrandLensProcesses }
        $offline = @()
        foreach ($name in $expected) {
            $proc = $list | Where-Object { $_.name -eq $name } | Select-Object -First 1
            if (-not $proc) { $offline += "$name (absent)" }
            elseif ($proc.pm2_env.status -ne 'online') { $offline += "$name ($($proc.pm2_env.status))" }
        }
        $flapping = @($list | Where-Object { $_.pm2_env.restart_time -ge 5 } |
                ForEach-Object { "$($_.name) x$($_.pm2_env.restart_time)" })
        $detail = if ($offline.Count) { $offline -join ', ' } else { "$($expected.Count) online" }
        if ($flapping.Count) { $detail += "; restarts: $($flapping -join ', ')" }
        Add-Check -Component 'pm2' -Ok ($offline.Count -eq 0) -Detail $detail
    } catch {
        Add-Check -Component 'pm2' -Ok $false -Detail "could not read pm2 jlist: $($_.Exception.Message)"
    }
} else {
    Add-Check -Component 'pm2' -Ok $true -Detail 'pm2 not on PATH (services may be managed elsewhere)' -Required $false
}

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
$failed = @($results | Where-Object { -not $_.Ok -and $_.Required })
$allOk = $failed.Count -eq 0

if ($Json) {
    [pscustomobject]@{
        ok        = $allOk
        checkedAt = (Get-Date).ToString('o')
        checks    = $results
        details   = $deepDetails
    } | ConvertTo-Json -Depth 6
    if ($allOk -or $WarnOnly) { exit 0 } else { exit 1 }
}

if (-not $Quiet) {
    Write-Host ''
    $table = @($results) + @($deepDetails)
    $table |
        Select-Object Component, Status, @{ N = 'ms'; E = { $_.LatencyMs } }, Detail |
        Write-TableBlock
    Write-Host ''
}

if ($allOk) {
    if (-not $Quiet) {
        Write-Host '  All checks passed.' -ForegroundColor Green
        Write-Host ''
        Write-Host "  console  $webUrl" -ForegroundColor Cyan
        Write-Host "  api      $apiUrl/docs" -ForegroundColor Cyan
        Write-Host ''
    }
    exit 0
}

Write-Host ''
Write-Fail ("Failing checks: " + (($failed | ForEach-Object { $_.Component }) -join ', '))
foreach ($check in $failed) {
    Write-Host "    $($check.Component): $($check.Detail)" -ForegroundColor Red
}
Write-Host ''
Write-Hint @(
    'Triage order -- each layer depends on the ones above it:',
    '  1. database   Get-Service postgresql* ; .\setup-database.ps1 -SkipSeed',
    '  2. engine     .\logs.ps1 -Process engine -Errors ; check apps\engine\.venv',
    '  3. api        .\logs.ps1 -Process api -Errors ; confirm DATABASE_URL in .env',
    '  4. web        .\logs.ps1 -Process web -Errors ; confirm NEXT_PUBLIC_API_URL',
    '  5. pm2        .\status.ps1 -Detailed'
)
Write-Host ''

if ($WarnOnly) { exit 0 }
exit 1
