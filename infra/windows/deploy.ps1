#Requires -Version 5.1
<#
.SYNOPSIS
    Deploys the current main branch to this Windows VM.

.DESCRIPTION
    The one command you run on the server after merging a pull request:

        git pull  ->  install  ->  build  ->  migrate  ->  reload  ->  verify

    Everything here is ordered around one principle: the deploy should fail
    BEFORE it touches anything that is hard to undo. So the working tree is
    validated, the database is backed up and the code is built while the old
    version is still serving traffic. PM2 only reloads once there is a
    complete, verified build on disk to reload into.

    If the health check fails afterwards, the script rolls the CODE back to the
    previous commit automatically and rebuilds. It does NOT roll the database
    back -- see the warning under -SkipMigrate.

    Safe to re-run. If the VM is already on the target commit, it says so and
    does nothing unless -Force is passed.

.PARAMETER Branch
    Branch to deploy. Defaults to main.

.PARAMETER SkipBackup
    Skip the pre-migration database dump. Only reasonable when you already
    took one, or on a machine with no data worth keeping.

.PARAMETER SkipMigrate
    Do not run database migrations.

    Worth understanding: migrations here are FORWARD-ONLY. There is no
    down-migration, by design -- an automated rollback of a column drop is a
    quiet way to lose data. If a migration turns out to be wrong, the recovery
    path is the backup this script takes, not an automatic reversal. That is
    why -SkipBackup and -SkipMigrate should rarely be used together.

.PARAMETER SkipPython
    Skip the engine virtualenv update. The script normally only touches it
    when requirements.txt actually changed, so this is rarely needed.

.PARAMETER NoRollback
    Leave the new code in place even if the health check fails. Use when you
    would rather debug the broken deploy than return to the old version.

.PARAMETER Force
    Deploy even when the VM is already on the target commit.

.EXAMPLE
    .\deploy.ps1

.EXAMPLE
    .\deploy.ps1 -WhatIf
    Shows what would happen, changes nothing.

.EXAMPLE
    .\deploy.ps1 -Branch hotfix/logo-clearspace -SkipBackup
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$Branch = 'main',
    [switch]$SkipBackup,
    [switch]$SkipMigrate,
    [switch]$SkipPython,
    [switch]$NoRollback,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')

$root = Get-BrandLensRoot
$startedAt = Get-Date
$rollbackSha = $null
$deployLog = Get-BrandLensPath 'logs' 'deploy.log'

function Write-DeployLog {
    param([string]$Message)
    $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    $dir = Split-Path $deployLog -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    Add-Content -LiteralPath $deployLog -Value $line -Encoding UTF8
}

function Invoke-CodeRollback {
    <#
    .SYNOPSIS
        Returns the working tree to a known-good commit and rebuilds it.
    .DESCRIPTION
        Code only. The database is deliberately left alone: migrations are
        forward-only, and silently reversing a schema change is a good way to
        lose a column's data while appearing to recover. If the failure was
        schema-related, restore the dump taken at the start of the deploy.

        A rollback that itself fails is reported loudly rather than swallowed --
        at that point the machine needs a person, and pretending otherwise
        wastes the minutes that matter.
    #>
    param(
        [Parameter(Mandatory)][string]$Git,
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$Sha,
        [Parameter(Mandatory)][string]$Pnpm
    )
    try {
        & $Git -C $Root reset --hard $Sha 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "git reset --hard $Sha failed" }

        & $Pnpm install --frozen-lockfile 2>&1 | Out-Null
        & $Pnpm build 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'rebuild of the previous version failed' }

        & pm2 reload all --update-env 2>&1 | Out-Null
        Write-Ok ('Rolled back to {0} and reloaded' -f $Sha.Substring(0, 12))
    } catch {
        Write-Fail ('ROLLBACK FAILED: {0}' -f $_.Exception.Message)
        Write-Hint 'This VM is now in an indeterminate state and needs manual attention:'
        Write-Hint ('  git -C {0} reset --hard {1}' -f $Root, $Sha)
        Write-Hint '  pnpm install --frozen-lockfile && pnpm build'
        Write-Hint '  .\infra\windows\start-all.ps1'
        Write-DeployLog 'CRITICAL  rollback failed'
    }
}

Write-Banner 'BrandLens - deploy'

# ---------------------------------------------------------------------------
# 1 -- Preflight.
#
# Every check here is one that, if skipped, produces a confusing failure
# halfway through rather than a clear refusal at the start.
# ---------------------------------------------------------------------------
Write-Step 'Preflight'

$git = if (Test-CommandExists 'git') { (Get-Command git).Source } else { $null }
if (-not $git) { Write-Fail 'git is not on PATH. Run bootstrap.ps1 first.'; exit 1 }

$pnpm = Get-PnpmCommand
if (-not $pnpm) { Write-Fail 'pnpm is not available. Run bootstrap.ps1 first.'; exit 1 }

if (-not (Test-Path (Join-Path $root '.git'))) {
    Write-Fail "$root is not a git clone."
    Write-Hint 'Deploying by unzipping means there is no commit to roll back to.'
    Write-Hint 'Re-provision with:  git clone <repo-url> C:\brandlens'
    exit 1
}

$envPath = Join-Path $root '.env'
if (-not (Test-Path $envPath)) {
    Write-Fail '.env is missing.'
    Write-Hint 'This file is intentionally NOT in git -- it holds this machine''s'
    Write-Hint 'secrets. Copy .env.example to .env and fill it in once; deploys'
    Write-Hint 'never overwrite it.'
    exit 1
}
Write-Ok '.env present (left untouched by deploy)'

# Uncommitted changes on a server are almost always an emergency edit somebody
# made and forgot. `git pull` would either clobber it or refuse with a less
# helpful message, so we stop and show exactly what it is.
$dirty = & $git -C $root status --porcelain
if ($dirty -and -not $Force) {
    Write-Fail 'The working tree on this server has uncommitted changes:'
    $dirty | ForEach-Object { Write-Host "    $_" -ForegroundColor Yellow }
    Write-Hint 'Someone edited files directly on the VM. Copy anything worth keeping,'
    Write-Hint ('then:  git -C {0} checkout -- .' -f $root)
    Write-Hint 'Or re-run with -Force to discard local edits and deploy anyway.'
    exit 1
}
if ($dirty -and $Force) {
    if ($PSCmdlet.ShouldProcess($root, 'Discard local changes')) {
        & $git -C $root checkout -- . 2>&1 | Out-Null
        Write-Warn 'Discarded local changes (-Force)'
    }
}

$currentSha = (& $git -C $root rev-parse HEAD).Trim()
$rollbackSha = $currentSha
Write-Info ('Currently deployed  {0}' -f $currentSha.Substring(0, 12))

# ---------------------------------------------------------------------------
# 2 -- Fetch and show what is about to change.
# ---------------------------------------------------------------------------
Write-Step 'Fetching from origin'
Invoke-Checked -FilePath $git -ArgumentList @('-C', $root, 'fetch', 'origin', '--prune') -Context 'git fetch'

$targetSha = (& $git -C $root rev-parse "origin/$Branch").Trim()
if ($LASTEXITCODE -ne 0 -or -not $targetSha) {
    Write-Fail "origin/$Branch does not exist."
    Write-Hint 'Check the branch name, or that this clone has the right remote:'
    Write-Hint ('  git -C {0} remote -v' -f $root)
    exit 1
}
# Write-Step leaves the line open (-NoNewline); every step needs exactly one
# terminator or the next message runs onto it.
Write-Ok ('origin/{0} is at {1}' -f $Branch, $targetSha.Substring(0, 12))

if ($targetSha -eq $currentSha -and -not $Force) {
    Write-Ok ('Already on origin/{0} ({1}). Nothing to deploy.' -f $Branch, $targetSha.Substring(0, 12))
    Write-Hint 'Use -Force to rebuild and reload anyway.'
    exit 0
}

$incoming = & $git -C $root log --oneline --no-decorate "$currentSha..$targetSha" 2>$null
if ($incoming) {
    Write-Info ('{0} commit(s) incoming:' -f ($incoming | Measure-Object).Count)
    $incoming | Select-Object -First 20 | ForEach-Object { Write-Host "    $_" -ForegroundColor Gray }
    if (($incoming | Measure-Object).Count -gt 20) { Write-Host '    ...' -ForegroundColor Gray }
}

# Knowing whether these changed decides whether we reinstall or rebuild the
# venv at all, which is most of the deploy time on a small VM.
$changedFiles = & $git -C $root diff --name-only $currentSha $targetSha 2>$null
$lockChanged = $changedFiles -match '^pnpm-lock\.yaml$|package\.json$'
$pyChanged = $changedFiles -match '^apps/engine/requirements\.txt$'
$migrationsChanged = $changedFiles -match '^packages/db/drizzle/'

if (-not $PSCmdlet.ShouldProcess("origin/$Branch ($($targetSha.Substring(0,12)))", 'Deploy to this VM')) {
    Write-Info 'WhatIf -- planned actions:'
    Write-Host ('    git pull --ff-only origin {0}' -f $Branch) -ForegroundColor Gray
    if ($lockChanged) { Write-Host '    pnpm install --frozen-lockfile   (dependencies changed)' -ForegroundColor Gray }
    else { Write-Host '    pnpm install --frozen-lockfile   (skipped -- no dependency change)' -ForegroundColor Gray }
    Write-Host '    pnpm build' -ForegroundColor Gray
    if ($pyChanged) { Write-Host '    pip install -r requirements.txt  (requirements changed)' -ForegroundColor Gray }
    if (-not $SkipBackup) { Write-Host '    backup.ps1' -ForegroundColor Gray }
    if (-not $SkipMigrate) {
        $note = if ($migrationsChanged) { '(new migrations present)' } else { '(no new migrations)' }
        Write-Host ('    pnpm db:migrate                  {0}' -f $note) -ForegroundColor Gray
    }
    Write-Host '    pm2 reload + healthcheck.ps1' -ForegroundColor Gray
    exit 0
}

Write-DeployLog ("START  {0} -> {1}  branch={2}" -f $currentSha.Substring(0,12), $targetSha.Substring(0,12), $Branch)

# ---------------------------------------------------------------------------
# 3 -- Back up BEFORE migrating.
#
# Deliberately before the pull as well: if the deploy fails at any later step,
# the dump on disk matches the schema that is still running.
# ---------------------------------------------------------------------------
if (-not $SkipBackup -and -not $SkipMigrate) {
    Write-Step 'Backing up the database'
    try {
        # No -Quiet here: backup.ps1 does not take one, and its output is worth
        # seeing in the deploy log anyway -- it reports whether the RLS bypass
        # was confirmed, which decides whether the dump is complete.
        & (Join-Path $PSScriptRoot 'backup.ps1')
        Write-Ok 'Backup written'
    } catch {
        Write-Fail ('Backup failed: {0}' -f $_.Exception.Message)
        Write-Hint 'Refusing to migrate without a backup. Fix the backup, or pass'
        Write-Hint '-SkipBackup if you accept the risk on this machine.'
        Write-DeployLog "ABORT  backup failed"
        exit 1
    }
} elseif (-not $SkipMigrate) {
    Write-Skip 'Database backup (-SkipBackup)'
}

# ---------------------------------------------------------------------------
# 4 -- Pull.
#
# --ff-only, never a merge. If the server's history has diverged from origin,
# something is wrong that a merge commit would only hide.
# ---------------------------------------------------------------------------
Write-Step ('Pulling origin/{0}' -f $Branch)
try {
    Invoke-Checked -FilePath $git -ArgumentList @('-C', $root, 'checkout', $Branch) -Context 'git checkout'
    Invoke-Checked -FilePath $git -ArgumentList @('-C', $root, 'merge', '--ff-only', "origin/$Branch") -Context 'git merge --ff-only'
    Write-Ok ('Now at {0}' -f $targetSha.Substring(0, 12))
} catch {
    Write-Fail ('Pull failed: {0}' -f $_.Exception.Message)
    Write-Hint 'The server''s history has diverged from origin. Inspect with:'
    Write-Hint ('  git -C {0} log --oneline -5' -f $root)
    Write-DeployLog 'ABORT  pull failed'
    exit 1
}

# ---------------------------------------------------------------------------
# 5 -- Build the new version while the old one is still serving.
# ---------------------------------------------------------------------------
try {
    if ($lockChanged -or $Force) {
        Write-Step 'Installing dependencies'
        Invoke-Checked -FilePath $pnpm -ArgumentList @('install', '--frozen-lockfile') `
            -WorkingDirectory $root -Context 'pnpm install'
        Write-Ok 'Dependencies installed'
    } else {
        Write-Skip 'pnpm install -- no dependency change in this deploy'
    }

    if ($pyChanged -and -not $SkipPython) {
        Write-Step 'Updating the engine virtualenv'
        $python = Get-PythonExe
        if (-not (Test-Path $python)) {
            & (Join-Path $PSScriptRoot 'setup-python.ps1')
        } else {
            Invoke-Checked -FilePath $python `
                -ArgumentList @('-m', 'pip', 'install', '-r', 'requirements.txt', '--quiet') `
                -WorkingDirectory (Join-Path $root 'apps\engine') -Context 'pip install'
        }
        Write-Ok 'Engine dependencies updated'
    } elseif (-not $SkipPython) {
        Write-Skip 'Engine virtualenv -- requirements.txt unchanged'
    }

    Write-Step 'Building'
    Invoke-Checked -FilePath $pnpm -ArgumentList @('build') -WorkingDirectory $root -Context 'pnpm build'
    Write-Ok 'Build complete'
} catch {
    Write-Fail ('Build failed: {0}' -f $_.Exception.Message)
    Write-Hint 'The previous version is still running -- nothing was reloaded.'
    Write-Hint 'This should have been caught by CI. Check the Actions tab.'
    Write-DeployLog 'ABORT  build failed (old version still serving)'
    if (-not $NoRollback) { Invoke-CodeRollback -Git $git -Root $root -Sha $rollbackSha -Pnpm $pnpm }
    exit 1
}

# ---------------------------------------------------------------------------
# 6 -- Migrate.
#
# Only ever `db:migrate`. Never `db:generate` -- the SQL that runs here is the
# SQL that was reviewed in the pull request, not something invented on the
# server against production data.
# ---------------------------------------------------------------------------
if (-not $SkipMigrate) {
    if ($migrationsChanged -or $Force) {
        Write-Step 'Applying database migrations'
        try {
            Invoke-Checked -FilePath $pnpm -ArgumentList @('db:migrate') `
                -WorkingDirectory $root -Context 'pnpm db:migrate'
            Write-Ok 'Migrations applied'
        } catch {
            Write-Fail ('Migration failed: {0}' -f $_.Exception.Message)
            Write-Hint 'The database may be partially migrated. The backup taken at the'
            Write-Hint 'start of this deploy is in the backups\ folder -- restore from it'
            Write-Hint 'before retrying. See docs/operations.md.'
            Write-DeployLog 'ABORT  migration failed'
            exit 1
        }
    } else {
        Write-Skip 'Migrations -- none new in this deploy'
    }
} else {
    Write-Skip 'Migrations (-SkipMigrate)'
}

# ---------------------------------------------------------------------------
# 7 -- Reload.
#
# `pm2 reload` rather than `restart`: reload waits for the new process to come
# up before retiring the old one, so an in-flight check is not dropped.
# ---------------------------------------------------------------------------
Write-Step 'Reloading services'
try {
    & (Join-Path $PSScriptRoot 'start-all.ps1') -NoWait | Out-Null
    Invoke-Checked -FilePath 'pm2' -ArgumentList @('reload', 'all', '--update-env') -Context 'pm2 reload'
    Invoke-Checked -FilePath 'pm2' -ArgumentList @('save') -Context 'pm2 save'
    Write-Ok 'Services reloaded'
} catch {
    Write-Fail ('Reload failed: {0}' -f $_.Exception.Message)
    Write-DeployLog 'ABORT  pm2 reload failed'
    exit 1
}

# ---------------------------------------------------------------------------
# 8 -- Verify, and roll the code back if it did not come up.
# ---------------------------------------------------------------------------
Write-Step 'Verifying'
Start-Sleep -Seconds 6

$healthy = $false
for ($attempt = 1; $attempt -le 6; $attempt++) {
    try {
        & (Join-Path $PSScriptRoot 'healthcheck.ps1') -Quiet
        if ($LASTEXITCODE -eq 0) { $healthy = $true; break }
    } catch { }
    # A dot per attempt, appended to the open step line, so a slow start looks
    # like progress rather than a hang. Write-Info here would collide with the
    # -NoNewline step text.
    Write-Host '.' -NoNewline -ForegroundColor DarkGray
    Start-Sleep -Seconds 5
}

if ($healthy) {
    Write-Ok 'All services healthy'
} else {
    Write-Fail 'Health check did not pass after the reload.'
    & (Join-Path $PSScriptRoot 'healthcheck.ps1')

    if ($NoRollback) {
        Write-Warn 'Leaving the new version in place (-NoRollback).'
        Write-Hint 'Logs:  .\infra\windows\logs.ps1 -Lines 100'
        Write-DeployLog 'FAIL   unhealthy, rollback suppressed'
        exit 1
    }

    Write-Step 'Rolling code back'
    Invoke-CodeRollback -Git $git -Root $root -Sha $rollbackSha -Pnpm $pnpm
    Write-Warn ('Rolled back to {0}.' -f $rollbackSha.Substring(0, 12))
    Write-Hint 'NOTE: any migration applied in this deploy is still applied.'
    Write-Hint 'Migrations are forward-only. If the failure was schema-related,'
    Write-Hint 'restore the backup taken at the start of this run.'
    Write-DeployLog ('ROLLBACK  to {0}' -f $rollbackSha.Substring(0,12))
    exit 1
}

$elapsed = [int]((Get-Date) - $startedAt).TotalSeconds
Write-Host ''
Write-Step 'Deploy complete'
Write-Ok ('{0} in {1}s' -f $targetSha.Substring(0, 12), $elapsed)
Write-DeployLog ("OK     {0}  {1}s" -f $targetSha.Substring(0,12), $elapsed)

Write-Host ''
Write-Info 'Deployed commit'
& $git -C $root log -1 --pretty=format:'    %h  %an  %ar%n    %s' | Write-Host
Write-Host ''
Write-Hint 'Status:  .\infra\windows\status.ps1'
Write-Hint 'Logs:    .\infra\windows\logs.ps1'
exit 0
