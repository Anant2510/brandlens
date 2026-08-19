#Requires -Version 5.1
#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Installs and verifies every prerequisite BrandLens needs on a Windows host.

.DESCRIPTION
    The supported production target for BrandLens is a single Windows Server
    2022 / Windows 11 VM with NO Docker. Everything installs natively:

        Node.js 20+      control plane, worker, console
        pnpm             workspace package manager (via corepack)
        Python 3.11+     analysis engine
        PostgreSQL 16/17 database AND job queue (pg-boss) -- no Redis
        PM2              process manager, later installed as a Windows service
        Caddy            optional reverse proxy with automatic HTTPS

    The script is idempotent: anything already present and new enough is left
    strictly alone. It never partially configures the machine -- each component
    is installed and then re-verified before the next one is attempted, and a
    failure reports exactly what to do by hand.

.PARAMETER SkipInstall
    Verify only. Installs nothing, and exits non-zero if anything is missing.
    This is the mode to use from a scheduled task or a CI smoke check.

.PARAMETER IncludeCaddy
    Also install Caddy. Off by default -- the reverse proxy is optional and many
    installs sit behind an existing IIS/ARR or a corporate load balancer.

.PARAMETER SkipPostgres
    Do not install PostgreSQL (use when the database lives on another host).

.PARAMETER InstallDependencies
    After the toolchain is verified, run `pnpm install` at the repo root.

.EXAMPLE
    .\bootstrap.ps1
    Install anything missing, then verify.

.EXAMPLE
    .\bootstrap.ps1 -SkipInstall
    Verify only; exit code 1 if a prerequisite is missing.

.EXAMPLE
    .\bootstrap.ps1 -IncludeCaddy -InstallDependencies
    Full first-run bootstrap of a brand new VM.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [switch]$SkipInstall,
    [switch]$IncludeCaddy,
    [switch]$SkipPostgres,
    [switch]$InstallDependencies
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')

# ---------------------------------------------------------------------------
# Requirements table. One row per component; everything below is generic.
# ---------------------------------------------------------------------------
$Requirements = @(
    @{
        Name       = 'Node.js'
        Command    = 'node'
        Args       = @('--version')
        Minimum    = '20.11.0'
        WingetId   = 'OpenJS.NodeJS.LTS'
        Manual     = @(
            'Download the Windows x64 LTS MSI from https://nodejs.org/en/download',
            'Install it, then re-open PowerShell as Administrator.'
        )
        Required   = $true
    },
    @{
        Name       = 'Python'
        Command    = 'python'
        Args       = @('--version')
        Minimum    = '3.11.0'
        WingetId   = 'Python.Python.3.11'
        Manual     = @(
            'Download Python 3.11 or 3.12 (64-bit) from https://www.python.org/downloads/windows/',
            'Tick "Add python.exe to PATH" in the installer.'
        )
        Required   = $true
    },
    @{
        Name       = 'PostgreSQL'
        Command    = 'psql'
        Args       = @('--version')
        Minimum    = '16.0'
        WingetId   = 'PostgreSQL.PostgreSQL.16'
        Manual     = @(
            'Download the EnterpriseDB installer from',
            '  https://www.enterprisedb.com/downloads/postgres-postgresql-downloads',
            'Install PostgreSQL 16 or 17, note the postgres superuser password,',
            'and add C:\Program Files\PostgreSQL\16\bin to the machine PATH.'
        )
        Required   = -not $SkipPostgres
    }
)

$Summary = [System.Collections.Generic.List[object]]::new()

function Add-Result {
    param([string]$Component, [string]$State, [string]$Detail)
    $Summary.Add([pscustomobject]@{ Component = $Component; State = $State; Detail = $Detail })
}

function Test-WingetAvailable {
    if (-not (Test-CommandExists 'winget')) { return $false }
    try {
        & winget --version 2>&1 | Out-Null
        return $LASTEXITCODE -eq 0
    } catch { return $false }
}

function Install-WithWinget {
    <#
    .SYNOPSIS
        Installs one winget package. Returns $true on success.
    .DESCRIPTION
        `--accept-*-agreements` is required or winget blocks on a prompt in a
        non-interactive session, which is how these scripts get run from a
        deployment pipeline. Exit code 0x8A15002B ("no applicable upgrade")
        means the package is already current and is treated as success.
    #>
    param([Parameter(Mandatory)][string]$Id, [Parameter(Mandatory)][string]$Name)

    if ($PSCmdlet.ShouldProcess($Name, "winget install $Id")) {
        Write-Info "installing $Name via winget ($Id) -- this can take several minutes"
        $args = @(
            'install', '--id', $Id, '--exact', '--silent',
            '--accept-package-agreements', '--accept-source-agreements',
            '--disable-interactivity'
        )
        & winget @args 2>&1 | ForEach-Object { Write-Verbose $_ }
        $code = $LASTEXITCODE
        Update-SessionPath
        # -1978335189 == 0x8A15002B, "no applicable update found" (already installed).
        if ($code -eq 0 -or $code -eq -1978335189) { return $true }
        Write-Warn "winget exited with code $code while installing $Name"
        return $false
    }
    return $false
}

function Resolve-Component {
    <#
    .SYNOPSIS
        Verifies one requirement, installing it first when permitted.
    #>
    param([hashtable]$Req, [bool]$WingetAvailable)

    Write-Step $Req.Name

    if (-not $Req.Required) {
        Write-Skip 'not required by this configuration'
        Add-Result $Req.Name 'skipped' 'not required'
        return $true
    }

    $version = Get-CommandVersion -Command $Req.Command -Arguments $Req.Args
    if ($version -and (Compare-Version $version $Req.Minimum)) {
        Write-Ok "$version (>= $($Req.Minimum))"
        Add-Result $Req.Name 'ok' $version
        return $true
    }

    if ($version) {
        Write-Warn "$version is older than the required $($Req.Minimum)"
    } else {
        Write-Warn 'not found'
    }

    if ($SkipInstall) {
        Write-Hint $Req.Manual
        $detail = if ($version) { "$version < $($Req.Minimum)" } else { 'not installed' }
        Add-Result $Req.Name 'missing' $detail
        return $false
    }

    if (-not $WingetAvailable) {
        Write-Fail "winget is unavailable, so $($Req.Name) cannot be installed automatically."
        Write-Hint (@('Install it by hand:') + $Req.Manual)
        Add-Result $Req.Name 'missing' 'winget unavailable'
        return $false
    }

    $installed = Install-WithWinget -Id $Req.WingetId -Name $Req.Name
    if (-not $installed) {
        Write-Fail "automatic install of $($Req.Name) did not succeed."
        Write-Hint (@('Install it by hand:') + $Req.Manual)
        Add-Result $Req.Name 'failed' 'winget install failed'
        return $false
    }

    Write-Step "$($Req.Name) (verify)"
    $version = Get-CommandVersion -Command $Req.Command -Arguments $Req.Args
    if ($version -and (Compare-Version $version $Req.Minimum)) {
        Write-Ok "$version"
        Add-Result $Req.Name 'installed' $version
        return $true
    }

    # Installed but not visible: almost always a PATH refresh that needs a new
    # shell. Say so explicitly rather than reporting a bare failure.
    Write-Fail "$($Req.Name) installed but is not on PATH in this session."
    Write-Hint @(
        'Close this window, open a NEW elevated PowerShell, and re-run:',
        '    .\infra\windows\bootstrap.ps1 -SkipInstall'
    )
    Add-Result $Req.Name 'needs-restart' 'installed, PATH not refreshed'
    return $false
}

# ===========================================================================
# Run
# ===========================================================================

Write-Banner 'BrandLens - bootstrap' "repo: $(Get-BrandLensRoot)"

if ($SkipInstall) { Write-Info 'verify-only mode: nothing will be installed' }

Write-Step 'Administrator'
Write-Ok 'elevated'

Write-Step 'winget'
$wingetAvailable = Test-WingetAvailable
if ($wingetAvailable) {
    Write-Ok (Get-CommandVersion -Command 'winget' -Arguments @('--version'))
} else {
    Write-Warn 'not available -- automatic installs are disabled'
    Write-Hint @(
        'winget ships with App Installer. On Windows Server it is usually absent.',
        'Either install App Installer from the Microsoft Store, or install each',
        'prerequisite by hand using the instructions printed below.'
    )
}

$allOk = $true
foreach ($req in $Requirements) {
    if (-not (Resolve-Component -Req $req -WingetAvailable $wingetAvailable)) { $allOk = $false }
}

# --- pnpm via corepack -----------------------------------------------------
Write-Step 'pnpm'
$pnpmVersion = Get-CommandVersion -Command 'pnpm' -Arguments @('--version')
if ($pnpmVersion) {
    Write-Ok $pnpmVersion
    Add-Result 'pnpm' 'ok' $pnpmVersion
} elseif ($SkipInstall) {
    Write-Warn 'not found'
    Write-Hint @('Enable it with:  corepack enable pnpm')
    Add-Result 'pnpm' 'missing' 'not installed'
    $allOk = $false
} elseif (Test-CommandExists 'corepack') {
    if ($PSCmdlet.ShouldProcess('pnpm', 'corepack enable pnpm')) {
        try {
            & corepack enable pnpm 2>&1 | Out-Null
            # `prepare --activate` pins the exact version from packageManager
            # in package.json, so every machine uses the same pnpm.
            & corepack prepare pnpm@9.12.3 --activate 2>&1 | Out-Null
            Update-SessionPath
            $pnpmVersion = Get-CommandVersion -Command 'pnpm' -Arguments @('--version')
        } catch { $pnpmVersion = $null }
    }
    if ($pnpmVersion) {
        Write-Ok $pnpmVersion
        Add-Result 'pnpm' 'installed' $pnpmVersion
    } else {
        Write-Fail 'corepack could not activate pnpm'
        Write-Hint @('Fall back to:  npm install -g pnpm@9.12.3')
        Add-Result 'pnpm' 'failed' 'corepack failed'
        $allOk = $false
    }
} else {
    Write-Fail 'corepack is unavailable (Node.js missing or too old)'
    Write-Hint @('Install Node.js 20+ first, then re-run this script.')
    Add-Result 'pnpm' 'failed' 'no corepack'
    $allOk = $false
}

# --- PM2 -------------------------------------------------------------------
Write-Step 'PM2'
$pm2Version = Get-CommandVersion -Command 'pm2' -Arguments @('--version')
if ($pm2Version) {
    Write-Ok $pm2Version
    Add-Result 'PM2' 'ok' $pm2Version
} elseif ($SkipInstall) {
    Write-Warn 'not found'
    Write-Hint @('Install with:  npm install -g pm2')
    Add-Result 'PM2' 'missing' 'not installed'
    $allOk = $false
} elseif (Test-CommandExists 'npm') {
    if ($PSCmdlet.ShouldProcess('pm2', 'npm install -g pm2')) {
        try {
            Invoke-Checked -FilePath 'npm' -ArgumentList @('install', '-g', 'pm2') -Context 'npm install -g pm2'
            Update-SessionPath
            $pm2Version = Get-CommandVersion -Command 'pm2' -Arguments @('--version')
        } catch {
            Write-Fail $_.Exception.Message
            $pm2Version = $null
        }
    }
    if ($pm2Version) {
        Write-Ok $pm2Version
        Add-Result 'PM2' 'installed' $pm2Version
    } else {
        Write-Fail 'PM2 install failed'
        Write-Hint @('Run manually:  npm install -g pm2')
        Add-Result 'PM2' 'failed' 'npm install failed'
        $allOk = $false
    }
} else {
    Write-Fail 'npm is unavailable -- install Node.js first'
    Add-Result 'PM2' 'failed' 'no npm'
    $allOk = $false
}

# --- Caddy (optional) ------------------------------------------------------
Write-Step 'Caddy'
$caddyVersion = Get-CommandVersion -Command 'caddy' -Arguments @('version')
if ($caddyVersion) {
    Write-Ok $caddyVersion
    Add-Result 'Caddy' 'ok' $caddyVersion
} elseif (-not $IncludeCaddy) {
    Write-Skip 'optional -- pass -IncludeCaddy to install'
    Add-Result 'Caddy' 'skipped' 'optional'
} elseif ($SkipInstall) {
    Write-Warn 'not found'
    Add-Result 'Caddy' 'missing' 'not installed'
} elseif ($wingetAvailable) {
    if (Install-WithWinget -Id 'CaddyServer.Caddy' -Name 'Caddy') {
        $caddyVersion = Get-CommandVersion -Command 'caddy' -Arguments @('version')
    }
    if ($caddyVersion) {
        Write-Ok $caddyVersion
        Add-Result 'Caddy' 'installed' $caddyVersion
    } else {
        Write-Warn 'Caddy not installed automatically'
        Write-Hint @(
            'Caddy is a single .exe. Download caddy_windows_amd64.zip from',
            '  https://github.com/caddyserver/caddy/releases',
            'and drop caddy.exe into C:\brandlens\bin (add that folder to PATH).'
        )
        Add-Result 'Caddy' 'manual' 'download the .exe'
    }
} else {
    Write-Warn 'winget unavailable'
    Write-Hint @(
        'Caddy is a single .exe -- download caddy_windows_amd64.zip from',
        '  https://github.com/caddyserver/caddy/releases'
    )
    Add-Result 'Caddy' 'manual' 'download the .exe'
}

# --- .env ------------------------------------------------------------------
Write-Step '.env'
$envPath = Get-BrandLensPath '.env'
$envExample = Get-BrandLensPath '.env.example'
if (Test-Path $envPath) {
    Write-Ok 'present'
    Add-Result '.env' 'ok' $envPath
} elseif (-not (Test-Path $envExample)) {
    Write-Fail '.env.example is missing from the repository'
    Add-Result '.env' 'failed' 'no template'
    $allOk = $false
} elseif ($SkipInstall) {
    Write-Warn 'missing'
    Write-Hint @("Copy the template:  Copy-Item '$envExample' '$envPath'")
    Add-Result '.env' 'missing' 'not created'
    $allOk = $false
} elseif ($PSCmdlet.ShouldProcess($envPath, 'create from .env.example')) {
    Copy-Item -LiteralPath $envExample -Destination $envPath
    Write-Ok 'created from .env.example'
    Write-Hint @(
        'Edit .env before starting anything. At minimum change:',
        '  DATABASE_URL, JWT_ACCESS_SECRET, JWT_REFRESH_SECRET,',
        '  API_KEY_PEPPER, ENGINE_SHARED_SECRET, STORAGE_SIGNING_SECRET'
    )
    Add-Result '.env' 'created' 'review the secrets'
}

# --- directories -----------------------------------------------------------
Write-Step 'directories'
$dirs = @(
    (Get-BrandLensPath 'logs'),
    (Get-BrandLensPath '.storage'),
    (Get-BrandLensPath 'backups')
)
$created = @()
foreach ($dir in $dirs) {
    if (-not (Test-Path $dir)) {
        if ($PSCmdlet.ShouldProcess($dir, 'create directory')) {
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
            $created += (Split-Path $dir -Leaf)
        }
    }
}
if ($created.Count -gt 0) { Write-Ok ('created ' + ($created -join ', ')) } else { Write-Ok 'already present' }
Add-Result 'directories' 'ok' 'logs, .storage, backups'

# --- workspace dependencies ------------------------------------------------
if ($InstallDependencies -and -not $SkipInstall) {
    Write-Step 'pnpm install'
    $pnpm = Get-PnpmCommand
    if (-not $pnpm) {
        Write-Fail 'pnpm is unavailable'
        Add-Result 'pnpm install' 'failed' 'pnpm missing'
        $allOk = $false
    } elseif ($PSCmdlet.ShouldProcess('workspace', 'pnpm install')) {
        try {
            Invoke-Checked -FilePath $pnpm -ArgumentList @('install') `
                -WorkingDirectory (Get-BrandLensRoot) -Context 'pnpm install'
            Write-Ok 'dependencies installed'
            Add-Result 'pnpm install' 'ok' 'workspace resolved'
        } catch {
            Write-Fail $_.Exception.Message
            Write-Hint @(
                'If this failed on a long path, enable long paths and retry:',
                '  New-ItemProperty -Path HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem \',
                '    -Name LongPathsEnabled -Value 1 -PropertyType DWORD -Force',
                '  git config --system core.longpaths true'
            )
            Add-Result 'pnpm install' 'failed' 'see output above'
            $allOk = $false
        }
    }
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host '  Summary' -ForegroundColor Cyan
Write-Host '  -------' -ForegroundColor DarkGray
$Summary | Write-TableBlock

if ($allOk) {
    Write-Host ''
    Write-Host '  Bootstrap complete.' -ForegroundColor Green
    Write-Host '  Next:' -ForegroundColor Cyan
    Write-Host '    1.  notepad .env                                  # set secrets and DATABASE_URL'
    Write-Host '    2.  .\infra\windows\setup-database.ps1            # role, database, migrate, seed'
    Write-Host '    3.  .\infra\windows\setup-python.ps1              # engine virtualenv'
    Write-Host '    4.  .\infra\windows\install-services.ps1          # PM2 as a Windows service'
    Write-Host '    5.  .\infra\windows\healthcheck.ps1               # verify all four services'
    Write-Host ''
    exit 0
}

Write-Host ''
Write-Fail 'One or more prerequisites are missing. Nothing was left half-configured;'
Write-Fail 'fix the items marked missing/failed above and re-run this script.'
Write-Host ''
exit 1
