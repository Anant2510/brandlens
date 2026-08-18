#Requires -Version 5.1
#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Installs PM2 as a Windows service so BrandLens survives a reboot.

.DESCRIPTION
    `pm2 startup` does not support Windows. Something else has to own the
    daemon at boot, and there are exactly two sane options:

      pm2-installer  (default)  https://github.com/jessety/pm2-installer
          Community-maintained installer that registers PM2 as a service via
          node-windows, moves the npm/pm2 prefix to a machine-wide location so
          the service account can actually see the global install, and sets
          PM2_HOME to C:\ProgramData\pm2. This is the path most Windows PM2
          deployments use and the one to prefer.

      NSSM
          The Non-Sucking Service Manager runs `pm2-runtime start ecosystem`
          in the foreground under a service wrapper. Fewer moving parts, works
          offline, and because PM2_HOME is shared the ordinary `pm2` CLI still
          talks to the same daemon.

    Both configurations end up equivalent from the operator's point of view:

        PM2_HOME = C:\ProgramData\pm2      (machine-wide)
        pm2 list / pm2 logs / pm2 reload   work from an elevated shell
        the four BrandLens processes come back after a reboot

    The script is idempotent. If the service already exists it is left in
    place and only the saved process list is refreshed.

.PARAMETER Method
    auto | pm2-installer | nssm.  `auto` prefers pm2-installer and falls back
    to NSSM when it is unavailable.

.PARAMETER ServiceName
    Service name for the NSSM method. Default: BrandLens.

.PARAMETER Pm2Home
    Machine-wide PM2 home. Default: C:\ProgramData\pm2.

.PARAMETER NssmPath
    Path to nssm.exe. Default: whatever is on PATH.

.PARAMETER SkipStart
    Register the service but do not start it.

.EXAMPLE
    .\install-services.ps1

.EXAMPLE
    .\install-services.ps1 -Method nssm -NssmPath C:\tools\nssm.exe

.EXAMPLE
    .\install-services.ps1 -WhatIf
    Print every change without touching the machine.
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [ValidateSet('auto', 'pm2-installer', 'nssm')]
    [string]$Method = 'auto',
    [string]$ServiceName = 'BrandLens',
    [string]$Pm2Home = 'C:\ProgramData\pm2',
    [string]$NssmPath,
    [switch]$SkipStart
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')

Write-Banner 'BrandLens · install Windows service'

$root = Get-BrandLensRoot
$ecosystem = Get-EcosystemPath

if (-not (Test-Path $ecosystem)) {
    Write-Fail "ecosystem.config.cjs not found at $ecosystem"
    exit 1
}

# ---------------------------------------------------------------------------
# Preconditions
# ---------------------------------------------------------------------------
Write-Step 'pm2'
$pm2 = Get-Pm2Command
if (-not $pm2) {
    Write-Fail 'PM2 is not installed.'
    Write-Hint @('Install it:  npm install -g pm2', 'or run:      .\infra\windows\bootstrap.ps1')
    exit 1
}
Write-Ok (Get-CommandVersion -Command 'pm2' -Arguments @('--version'))

Write-Step 'node'
if (-not (Test-CommandExists 'node')) {
    Write-Fail 'node is not on PATH'
    exit 1
}
$nodeExe = (Get-Command 'node').Source
Write-Ok $nodeExe

Write-Step '.env'
if (-not (Test-Path (Join-Path $root '.env'))) {
    Write-Fail '.env is missing — the service would start with no configuration.'
    Write-Hint @('Copy .env.example to .env and set the secrets, then re-run.')
    exit 1
}
Write-Ok 'present'

Write-Step 'built artefacts'
$missing = @()
foreach ($entry in @(
        (Join-Path $root 'apps\api\dist\apps\api\src\main.js'),
        (Join-Path $root 'apps\worker\dist\apps\worker\src\main.js')
    )) {
    if (-not (Test-Path $entry)) { $missing += $entry }
}
if ($missing.Count -gt 0) {
    Write-Warn 'the API and/or worker have not been built'
    Write-Hint (@('Build them before starting the service:', '    pnpm build', '', 'Missing:') + $missing)
} else {
    Write-Ok 'api + worker compiled'
}

# ---------------------------------------------------------------------------
# PM2_HOME
#
# Without a machine-wide PM2_HOME the service account keeps its own daemon in
# C:\Windows\system32\config\systemprofile\.pm2, which is invisible to the
# operator's `pm2 list`. That single mismatch is the source of most "the
# service is running but pm2 shows nothing" reports.
# ---------------------------------------------------------------------------
Write-Step 'PM2_HOME'
if ($PSCmdlet.ShouldProcess($Pm2Home, 'set machine-wide PM2_HOME')) {
    if (-not (Test-Path $Pm2Home)) { New-Item -ItemType Directory -Path $Pm2Home -Force | Out-Null }
    [Environment]::SetEnvironmentVariable('PM2_HOME', $Pm2Home, 'Machine')
    $env:PM2_HOME = $Pm2Home
    Write-Ok $Pm2Home
} else {
    Write-Skip "would set PM2_HOME=$Pm2Home"
}

# ---------------------------------------------------------------------------
# Already installed?
# ---------------------------------------------------------------------------
$existing = @(Get-Service -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -in @('PM2', 'pm2.exe', $ServiceName) })

if ($existing.Count -gt 0) {
    Write-Host ''
    foreach ($svc in $existing) {
        Write-Info "service '$($svc.Name)' already exists (status: $($svc.Status))"
    }
    Write-Info 'Refreshing the saved process list instead of reinstalling.'
    Write-Host ''

    if ($PSCmdlet.ShouldProcess('PM2 process list', 'start ecosystem + pm2 save')) {
        try {
            Invoke-Checked -FilePath $pm2 -ArgumentList @('start', $ecosystem) `
                -WorkingDirectory $root -Context 'pm2 start'
        } catch {
            Write-Warn 'pm2 start reported an error; continuing to save what is running'
            Write-Info $_.Exception.Message
        }
        Invoke-Checked -FilePath $pm2 -ArgumentList @('save') -WorkingDirectory $root -Context 'pm2 save'
        Write-Ok 'process list saved — it will be resurrected at boot'
    }

    Write-Host ''
    Write-Host '  Already installed. Nothing else to do.' -ForegroundColor Green
    Write-Host '  Verify with:  .\infra\windows\status.ps1' -ForegroundColor Cyan
    Write-Host ''
    exit 0
}

# ---------------------------------------------------------------------------
# Method selection
# ---------------------------------------------------------------------------
if (-not $NssmPath) {
    if (Test-CommandExists 'nssm') { $NssmPath = (Get-Command 'nssm').Source }
}

$chosen = $Method
if ($chosen -eq 'auto') {
    # pm2-installer needs npm and network access. Prefer it, because it is the
    # configuration the PM2 community actually tests on Windows.
    $chosen = if (Test-CommandExists 'npm') { 'pm2-installer' } elseif ($NssmPath) { 'nssm' } else { 'none' }
}

Write-Info "method: $chosen"
Write-Host ''

# ===========================================================================
# pm2-installer
# ===========================================================================
function Install-ViaPm2Installer {
    $workDir = Join-Path ([IO.Path]::GetTempPath()) 'brandlens-pm2-installer'
    $zipUrl = 'https://github.com/jessety/pm2-installer/archive/refs/heads/main.zip'
    $zipPath = Join-Path ([IO.Path]::GetTempPath()) 'pm2-installer.zip'

    Write-Step 'download pm2-installer'
    if (-not $PSCmdlet.ShouldProcess($zipUrl, 'download and extract')) {
        Write-Skip 'would download'
        return $false
    }
    try {
        if (Test-Path $workDir) { Remove-Item -LiteralPath $workDir -Recurse -Force }
        # TLS 1.2 is not the default on Windows Server 2016/2019 PowerShell 5.1.
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing -ErrorAction Stop
        Expand-Archive -LiteralPath $zipPath -DestinationPath $workDir -Force
        Write-Ok 'downloaded'
    } catch {
        Write-Fail "could not download pm2-installer: $($_.Exception.Message)"
        Write-Hint @(
            'No internet access on this VM? Use the NSSM method instead:',
            '    .\install-services.ps1 -Method nssm -NssmPath C:\tools\nssm.exe',
            'Or fetch pm2-installer on another machine, copy it across, and run',
            '`npm run setup` inside it from an elevated prompt.'
        )
        return $false
    }

    $installerDir = Get-ChildItem -LiteralPath $workDir -Directory | Select-Object -First 1
    if (-not $installerDir) {
        Write-Fail 'the pm2-installer archive did not contain the expected folder'
        return $false
    }

    Write-Step 'configure npm prefix'
    try {
        # Moves the global npm prefix and cache under C:\ProgramData so the
        # LocalSystem service account can resolve the global pm2 install.
        Invoke-Checked -FilePath 'npm' -ArgumentList @('run', 'configure') `
            -WorkingDirectory $installerDir.FullName -Context 'npm run configure'
        Invoke-Checked -FilePath 'npm' -ArgumentList @('run', 'configure-policy') `
            -WorkingDirectory $installerDir.FullName -Context 'npm run configure-policy'
        Write-Ok 'npm prefix + execution policy configured'
    } catch {
        Write-Warn 'npm run configure failed; continuing to setup'
        Write-Info $_.Exception.Message
    }

    Write-Step 'install service'
    try {
        Invoke-Checked -FilePath 'npm' -ArgumentList @('run', 'setup') `
            -WorkingDirectory $installerDir.FullName -Context 'npm run setup'
        Write-Ok 'pm2 service registered'
    } catch {
        Write-Fail "pm2-installer setup failed: $($_.Exception.Message)"
        Write-Hint @(
            'Try the NSSM method:',
            '    .\install-services.ps1 -Method nssm -NssmPath C:\tools\nssm.exe'
        )
        return $false
    }

    Update-SessionPath
    Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
    return $true
}

# ===========================================================================
# NSSM
# ===========================================================================
function Install-ViaNssm {
    if (-not $NssmPath -or -not (Test-Path $NssmPath)) {
        Write-Fail 'nssm.exe was not found'
        Write-Hint @(
            'Download NSSM from https://nssm.cc/download, extract',
            'win64\nssm.exe to C:\tools\nssm.exe, and re-run:',
            '    .\install-services.ps1 -Method nssm -NssmPath C:\tools\nssm.exe'
        )
        return $false
    }

    # pm2-runtime keeps the daemon in the foreground, which is exactly what a
    # service wrapper needs. Because PM2_HOME is shared, the ordinary pm2 CLI
    # attaches to this same daemon.
    $pm2Runtime = Join-Path (Split-Path (Split-Path $pm2 -Parent) -Parent) 'pm2\bin\pm2-runtime'
    if (-not (Test-Path $pm2Runtime)) {
        $npmRoot = (& npm root -g 2>&1 | Out-String).Trim()
        $pm2Runtime = Join-Path $npmRoot 'pm2\bin\pm2-runtime'
    }
    if (-not (Test-Path $pm2Runtime)) {
        Write-Fail 'could not locate pm2-runtime'
        Write-Hint @('Reinstall PM2:  npm install -g pm2')
        return $false
    }

    Write-Step "service $ServiceName"
    if (-not $PSCmdlet.ShouldProcess($ServiceName, 'nssm install')) {
        Write-Skip 'would install'
        return $false
    }

    $logOut = Get-BrandLensPath 'logs' 'pm2-service-out.log'
    $logErr = Get-BrandLensPath 'logs' 'pm2-service-error.log'

    & $NssmPath install $ServiceName $nodeExe "`"$pm2Runtime`" start `"$ecosystem`"" | Out-Null
    & $NssmPath set $ServiceName AppDirectory $root | Out-Null
    & $NssmPath set $ServiceName DisplayName 'BrandLens (PM2)' | Out-Null
    & $NssmPath set $ServiceName Description 'BrandLens API, worker, console and analysis engine, supervised by PM2.' | Out-Null
    & $NssmPath set $ServiceName Start SERVICE_AUTO_START | Out-Null
    & $NssmPath set $ServiceName AppEnvironmentExtra "PM2_HOME=$Pm2Home" 'NODE_ENV=production' | Out-Null
    & $NssmPath set $ServiceName AppStdout $logOut | Out-Null
    & $NssmPath set $ServiceName AppStderr $logErr | Out-Null
    & $NssmPath set $ServiceName AppRotateFiles 1 | Out-Null
    & $NssmPath set $ServiceName AppRotateBytes 10485760 | Out-Null
    # PM2 needs time to stop four children cleanly before the SCM gives up.
    & $NssmPath set $ServiceName AppStopMethodConsole 20000 | Out-Null
    & $NssmPath set $ServiceName AppStopMethodWindow 20000 | Out-Null
    # Postgres must be up first, or every process crash-loops on boot.
    & $NssmPath set $ServiceName DependOnService 'postgresql-x64-16' | Out-Null

    Write-Ok 'registered'
    return $true
}

# ===========================================================================
# Run
# ===========================================================================
$installed = $false
switch ($chosen) {
    'pm2-installer' { $installed = Install-ViaPm2Installer }
    'nssm' { $installed = Install-ViaNssm }
    default {
        Write-Fail 'neither npm nor nssm is available, so no service can be installed.'
        Write-Hint @(
            'Install one of:',
            '  npm (comes with Node.js)   -> .\install-services.ps1 -Method pm2-installer',
            '  NSSM from https://nssm.cc  -> .\install-services.ps1 -Method nssm -NssmPath C:\tools\nssm.exe',
            '',
            'Until then, start BrandLens manually after each reboot:',
            '  .\infra\windows\start-all.ps1'
        )
        exit 1
    }
}

if (-not $installed) { exit 1 }

# ---------------------------------------------------------------------------
# Start the processes and persist the list
# ---------------------------------------------------------------------------
if ($SkipStart) {
    Write-Host ''
    Write-Host '  Service installed. Not started (-SkipStart).' -ForegroundColor Green
    exit 0
}

Write-Host ''
Write-Step 'start processes'
if ($PSCmdlet.ShouldProcess('BrandLens processes', 'pm2 start ecosystem.config.cjs')) {
    try {
        Invoke-Checked -FilePath $pm2 -ArgumentList @('start', $ecosystem) `
            -WorkingDirectory $root -Context 'pm2 start'
        Write-Ok 'started'
    } catch {
        Write-Warn 'one or more processes failed to start'
        Write-Info $_.Exception.Message
        Write-Hint @('Inspect with:  pm2 logs --lines 100')
    }

    # `pm2 save` writes the dump the service resurrects from at boot. Without
    # it the service starts an empty PM2 and nothing comes back.
    Invoke-Checked -FilePath $pm2 -ArgumentList @('save') -WorkingDirectory $root -Context 'pm2 save'
    Write-Ok 'process list saved'
}

Write-Host ''
Write-Host '  Service installed.' -ForegroundColor Green
Write-Host ''
Write-Host '  Verify:' -ForegroundColor Cyan
Write-Host '    .\infra\windows\status.ps1'
Write-Host '    .\infra\windows\healthcheck.ps1'
Write-Host ''
Write-Host '  Reboot test (do this before you call the install done):' -ForegroundColor Cyan
Write-Host '    Restart-Computer ; then re-run healthcheck.ps1'
Write-Host ''
Write-Host '  Remember: after every deploy run `pm2 save` (or start-all.ps1),' -ForegroundColor DarkGray
Write-Host '  or the boot-time resurrect will restore the previous process list.' -ForegroundColor DarkGray
Write-Host ''
exit 0
