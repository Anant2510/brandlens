#Requires -Version 5.1
<#
.SYNOPSIS
    Stops the BrandLens processes.

.DESCRIPTION
    `pm2 stop` by default, which leaves the processes in PM2's list so that
    start-all.ps1 (and the boot-time resurrect) bring them back unchanged.

    Stopping is graceful: PM2 sends SIGINT and waits for `kill_timeout` before
    escalating. That matters — the API finishes in-flight synchronous checks
    on shutdown, and the worker lets a running job complete rather than
    abandoning a paid VLM call halfway through.

.PARAMETER Only
    Comma-separated subset, e.g. -Only brandlens-worker.

.PARAMETER Delete
    Remove the processes from PM2's list as well as stopping them. The next
    start must then come from the ecosystem file. Also runs `pm2 save`, so a
    reboot will not resurrect them.

.PARAMETER Kill
    Also stop the PM2 daemon itself (`pm2 kill`). Implies -Delete.

.EXAMPLE
    .\stop-all.ps1

.EXAMPLE
    .\stop-all.ps1 -Only brandlens-worker

.EXAMPLE
    .\stop-all.ps1 -Delete -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [string[]]$Only,
    [switch]$Delete,
    [switch]$Kill
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')

Write-Banner 'BrandLens · stop'

$pm2 = Assert-Pm2
$root = Get-BrandLensRoot

$targets = if ($Only) { $Only } else { $BrandLensProcesses }
$action = if ($Delete -or $Kill) { 'delete' } else { 'stop' }

foreach ($name in $targets) {
    Write-Step $name
    if (-not $PSCmdlet.ShouldProcess($name, "pm2 $action")) {
        Write-Skip "would $action"
        continue
    }
    # `pm2 stop` on an unknown process exits non-zero; that is not an error
    # here, it just means the process was already gone.
    $output = & $pm2 $action $name 2>&1 | Out-String
    if ($LASTEXITCODE -eq 0) {
        Write-Ok $action
    } elseif ($output -match 'not found|doesn.t exist') {
        Write-Skip 'not running'
    } else {
        Write-Warn $output.Trim()
    }
}

if ($Delete -or $Kill) {
    Write-Step 'pm2 save'
    if ($PSCmdlet.ShouldProcess('process list', 'pm2 save --force')) {
        & $pm2 save --force 2>&1 | Out-Null
        Write-Ok 'saved (an empty list will be resurrected at boot)'
    }
}

if ($Kill) {
    Write-Step 'pm2 kill'
    if ($PSCmdlet.ShouldProcess('pm2 daemon', 'pm2 kill')) {
        & $pm2 kill 2>&1 | Out-Null
        Write-Ok 'daemon stopped'
        Write-Info 'The Windows service will restart the daemon; use'
        Write-Info 'Stop-Service PM2 (or Stop-Service BrandLens) to keep it down.'
    }
}

Write-Host ''
if (-not $Kill) { & $pm2 list }
Write-Host ''
exit 0
