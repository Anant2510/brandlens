#Requires -Version 5.1
<#
.SYNOPSIS
    Starts the BrandLens processes under PM2.

.DESCRIPTION
    A thin wrapper over `pm2 start infra\windows\ecosystem.config.cjs`, plus
    the three things that are easy to forget and expensive to miss:

      * checking that .env and the compiled artefacts exist BEFORE starting,
        so a crash loop is prevented rather than diagnosed;
      * `pm2 save`, without which nothing comes back after a reboot;
      * a short wait and a health probe, so the exit code means something.

    Safe to run repeatedly: PM2 restarts a process that is already running.

.PARAMETER Only
    Comma-separated subset, e.g. -Only brandlens-api,brandlens-engine.

.PARAMETER NoSave
    Skip `pm2 save`. Use for a temporary start you do not want resurrected.

.PARAMETER NoWait
    Return as soon as PM2 accepts the start, without probing health.

.EXAMPLE
    .\start-all.ps1

.EXAMPLE
    .\start-all.ps1 -Only brandlens-engine
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string[]]$Only,
    [switch]$NoSave,
    [switch]$NoWait
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')

Write-Banner 'BrandLens - start'

$pm2 = Assert-Pm2
$root = Get-BrandLensRoot
$ecosystem = Get-EcosystemPath

# ---------------------------------------------------------------------------
# Preflight. Each of these produces a crash loop rather than a clean error if
# it is left to PM2 to discover.
# ---------------------------------------------------------------------------
$blocking = @()

Write-Step '.env'
if (Test-Path (Join-Path $root '.env')) {
    Write-Ok 'present'
} else {
    Write-Fail 'missing'
    $blocking += 'Copy .env.example to .env and set DATABASE_URL plus the secrets.'
}

Write-Step 'api build'
if (Test-Path (Join-Path $root 'apps\api\dist\apps\api\src\main.js')) {
    Write-Ok 'compiled'
} else {
    Write-Fail 'not built'
    $blocking += 'Run: pnpm build'
}

Write-Step 'worker build'
if (Test-Path (Join-Path $root 'apps\worker\dist\apps\worker\src\main.js')) {
    Write-Ok 'compiled'
} else {
    Write-Fail 'not built'
    $blocking += 'Run: pnpm build'
}

Write-Step 'engine venv'
$python = Get-PythonExe
if (Test-Path $python) {
    Write-Ok '.venv present'
} else {
    Write-Fail 'missing'
    $blocking += 'Run: .\infra\windows\setup-python.ps1'
}

Write-Step 'web build'
$webBuild = Join-Path $root 'apps\web\.next'
if (Test-Path $webBuild) {
    Write-Ok '.next present'
} else {
    Write-Warn 'not built -- brandlens-web will fail to start'
    $blocking += 'Run: pnpm build   (Next.js needs a production build before `next start`)'
}

if ($blocking.Count -gt 0) {
    Write-Host ''
    Write-Fail 'Refusing to start with an incomplete install.'
    Write-Hint ($blocking | Select-Object -Unique)
    Write-Host ''
    exit 1
}

# ---------------------------------------------------------------------------
# Start
# ---------------------------------------------------------------------------
Write-Host ''
$args = @('start', $ecosystem)
if ($Only) { $args += @('--only', ($Only -join ',')) }

Write-Step 'pm2 start'
$targetLabel = if ($Only) { $Only -join ', ' } else { 'all processes' }
if ($PSCmdlet.ShouldProcess($targetLabel, 'pm2 start')) {
    try {
        Invoke-Checked -FilePath $pm2 -ArgumentList $args -WorkingDirectory $root -Context 'pm2 start'
        Write-Ok 'accepted'
    } catch {
        Write-Fail $_.Exception.Message
        Write-Hint @('Inspect with:  pm2 logs --lines 100')
        exit 1
    }
} else {
    Write-Skip 'would start'
    exit 0
}

if (-not $NoSave) {
    Write-Step 'pm2 save'
    Invoke-Checked -FilePath $pm2 -ArgumentList @('save') -WorkingDirectory $root -Context 'pm2 save'
    Write-Ok 'process list persisted for reboot'
}

# ---------------------------------------------------------------------------
# Settle, then report
# ---------------------------------------------------------------------------
if (-not $NoWait) {
    Write-Step 'settling'
    Start-Sleep -Seconds 6
    Write-Ok 'done'
}

Write-Host ''
& $pm2 list
Write-Host ''

if (-not $NoWait) {
    $envMap = Read-DotEnv
    $apiUrl = Get-EnvValue -Key 'API_PUBLIC_URL' -Env $envMap -Default 'http://localhost:4000'
    $webUrl = Get-EnvValue -Key 'WEB_PUBLIC_URL' -Env $envMap -Default 'http://localhost:3000'

    Write-Host '  URLs' -ForegroundColor Cyan
    Write-Host "    console   $webUrl"
    Write-Host "    api       $apiUrl"
    Write-Host "    api docs  $apiUrl/docs"
    Write-Host "    health    $apiUrl/health/deep"
    Write-Host ''
    Write-Host '  Full probe:  .\infra\windows\healthcheck.ps1' -ForegroundColor Cyan
    Write-Host ''
}

exit 0
