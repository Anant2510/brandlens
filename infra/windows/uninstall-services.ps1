#Requires -Version 5.1
#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Removes the PM2 Windows service and stops every BrandLens process.

.DESCRIPTION
    The exact inverse of install-services.ps1. Order matters:

      1. stop and delete the BrandLens processes from PM2
      2. kill the PM2 daemon
      3. stop and remove the service (pm2-installer's, or the NSSM one)
      4. optionally clear PM2_HOME and its dump file

    Nothing under the repository is touched: no logs are deleted, no database
    is dropped, no storage is removed. Uninstalling the supervisor must never
    be able to destroy data.

.PARAMETER ServiceName
    NSSM service name used at install time. Default: BrandLens.

.PARAMETER NssmPath
    Path to nssm.exe. Default: whatever is on PATH.

.PARAMETER RemovePm2Home
    Also delete PM2_HOME (the dump file and PM2's own logs) and unset the
    machine environment variable. Off by default.

.PARAMETER KeepProcesses
    Remove the service but leave the processes running under the current
    PM2 daemon. Useful when swapping supervisors on a live box.

.EXAMPLE
    .\uninstall-services.ps1

.EXAMPLE
    .\uninstall-services.ps1 -WhatIf
    Show what would be removed.

.EXAMPLE
    .\uninstall-services.ps1 -RemovePm2Home -Confirm:$false
    Full teardown, unattended.
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [string]$ServiceName = 'BrandLens',
    [string]$NssmPath,
    [switch]$RemovePm2Home,
    [switch]$KeepProcesses
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')

Write-Banner 'BrandLens - uninstall Windows service'

$pm2Home = [Environment]::GetEnvironmentVariable('PM2_HOME', 'Machine')
if (-not $pm2Home) { $pm2Home = 'C:\ProgramData\pm2' }
if ($env:PM2_HOME) { $pm2Home = $env:PM2_HOME }

Write-Info "PM2_HOME    $pm2Home"
Write-Info "service     $ServiceName (NSSM) / PM2 (pm2-installer)"
Write-Host ''

# ---------------------------------------------------------------------------
# 1 -- processes
# ---------------------------------------------------------------------------
$pm2 = Get-Pm2Command
if ($pm2 -and -not $KeepProcesses) {
    Write-Step 'stop processes'
    if ($PSCmdlet.ShouldProcess('BrandLens processes', 'pm2 delete')) {
        $env:PM2_HOME = $pm2Home
        foreach ($name in $BrandLensProcesses) {
            # A process that is not there is a successful delete, so failures
            # here are informational only.
            & $pm2 delete $name 2>&1 | Out-Null
        }
        & $pm2 save --force 2>&1 | Out-Null
        Write-Ok 'deleted from PM2'
    } else {
        Write-Skip 'would delete'
    }

    Write-Step 'kill daemon'
    if ($PSCmdlet.ShouldProcess('pm2 daemon', 'pm2 kill')) {
        & $pm2 kill 2>&1 | Out-Null
        Write-Ok 'stopped'
    } else {
        Write-Skip 'would kill'
    }
} elseif ($KeepProcesses) {
    Write-Step 'processes'
    Write-Skip 'left running (-KeepProcesses)'
} else {
    Write-Step 'processes'
    Write-Warn 'pm2 not found -- skipping process teardown'
}

# ---------------------------------------------------------------------------
# 2 -- services
# ---------------------------------------------------------------------------
if (-not $NssmPath -and (Test-CommandExists 'nssm')) { $NssmPath = (Get-Command 'nssm').Source }

$candidates = @('PM2', 'pm2.exe', $ServiceName) | Select-Object -Unique
$removedAny = $false

foreach ($candidate in $candidates) {
    $svc = Get-Service -Name $candidate -ErrorAction SilentlyContinue
    if (-not $svc) { continue }

    Write-Step "service $candidate"
    if (-not $PSCmdlet.ShouldProcess($candidate, 'stop and remove service')) {
        Write-Skip 'would remove'
        continue
    }

    try {
        if ($svc.Status -ne 'Stopped') {
            Stop-Service -Name $candidate -Force -ErrorAction Stop
            # The SCM reports Stopped before the process has fully exited;
            # deleting too early leaves the service marked for deletion until
            # the next reboot, which then blocks a reinstall.
            $svc.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(45))
        }
    } catch {
        Write-Warn "could not stop cleanly: $($_.Exception.Message)"
    }

    $removed = $false
    if ($NssmPath -and $candidate -eq $ServiceName) {
        & $NssmPath remove $candidate confirm 2>&1 | Out-Null
        $removed = $LASTEXITCODE -eq 0
    }
    if (-not $removed) {
        # sc.exe deletes anything the SCM knows about, whoever created it.
        & sc.exe delete $candidate 2>&1 | Out-Null
        $removed = $LASTEXITCODE -eq 0
    }

    if ($removed) {
        Write-Ok 'removed'
        $removedAny = $true
    } else {
        Write-Fail 'could not remove the service'
        Write-Hint @(
            "Try manually:  sc.exe delete $candidate",
            'If it reports "marked for deletion", reboot and re-run this script.'
        )
    }
}

if (-not $removedAny) {
    Write-Step 'services'
    Write-Skip 'none found -- nothing to remove'
}

# ---------------------------------------------------------------------------
# 3 -- PM2_HOME
# ---------------------------------------------------------------------------
if ($RemovePm2Home) {
    Write-Step 'PM2_HOME'
    if ($PSCmdlet.ShouldProcess($pm2Home, 'delete PM2_HOME and unset the machine variable')) {
        if (Test-Path $pm2Home) {
            Remove-Item -LiteralPath $pm2Home -Recurse -Force -ErrorAction SilentlyContinue
        }
        [Environment]::SetEnvironmentVariable('PM2_HOME', $null, 'Machine')
        Write-Ok 'removed'
    } else {
        Write-Skip 'would remove'
    }
} else {
    Write-Step 'PM2_HOME'
    Write-Skip "kept at $pm2Home (pass -RemovePm2Home to delete)"
}

Write-Host ''
Write-Host '  Uninstall complete.' -ForegroundColor Green
Write-Info 'Untouched: the database, .storage\, logs\ and backups\.'
Write-Info 'Reinstall at any time with:  .\infra\windows\install-services.ps1'
Write-Host ''
exit 0
