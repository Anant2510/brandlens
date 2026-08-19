#Requires -Version 5.1
<#
.SYNOPSIS
    Backs up the BrandLens database and object storage, with retention.

.DESCRIPTION
    A BrandLens install has exactly two pieces of durable state:

      1. PostgreSQL -- the ontology, every check run, every decision trace and
         the audit log. Dumped with pg_dump in the custom format (-Fc), which
         is compressed, parallel-restorable and selectively restorable.

      2. STORAGE_LOCAL_ROOT -- the original asset bytes and derivatives. Because
         storage is content-addressed (originals/<org>/<ab>/<sha256>.<ext>),
         files are immutable once written, so a copy that skips existing
         destination files is both correct and fast.

    Everything lands in a timestamped folder:

        backups\2026-08-17T0230\
            brandlens-2026-08-17T0230.dump
            storage\...
            manifest.json

    The manifest records the schema version, the pgvector state and file
    counts, so a restore can be verified rather than assumed.

    Retention deletes whole timestamped folders older than -RetentionDays,
    and always keeps at least -MinimumKeep of the newest, so a burst of
    failures can never leave you with zero backups.

.PARAMETER Destination
    Backup root. Default: <repo>\backups.

.PARAMETER RetentionDays
    Delete backups older than this. Default 14. Set 0 to disable pruning.

.PARAMETER MinimumKeep
    Never prune below this many backups, whatever their age. Default 3.

.PARAMETER SkipStorage
    Database only.

.PARAMETER SkipDatabase
    Storage only.

.PARAMETER Compress
    Also produce a single .zip of the whole folder (for off-box copy).

.PARAMETER DumpUser
    Dump as this role instead of the application role. Use a SUPERUSER (e.g.
    `postgres`) when you would rather not rely on the app.bypass_rls escape
    hatch -- a superuser bypasses row-level security natively.

.PARAMETER DumpPassword
    Password for -DumpUser. Prompted for if omitted.

.EXAMPLE
    .\backup.ps1

.EXAMPLE
    .\backup.ps1 -Destination D:\backups\brandlens -RetentionDays 30 -Compress

.EXAMPLE
    .\backup.ps1 -DumpUser postgres
    Dump as a superuser rather than relying on the app.bypass_rls escape hatch.

.EXAMPLE
    .\backup.ps1 -WhatIf
    Show what would be dumped, copied and pruned.

.NOTES
    Schedule nightly as SYSTEM:
      schtasks /create /tn "BrandLens backup" /sc daily /st 02:30 /ru SYSTEM ^
        /tr "powershell -NoProfile -ExecutionPolicy Bypass -File C:\brandlens\infra\windows\backup.ps1"

    Restore (see docs\operations.md for the full drill):
      pg_restore --clean --if-exists --no-owner -d brandlens <dump>

    NOTE: every tenant table uses FORCE ROW LEVEL SECURITY, so a plain
    `pg_dump -U brandlens` ABORTS rather than dumping a subset. This script
    verifies the app.bypass_rls escape hatch and then dumps with
    --enable-row-security; -DumpUser <superuser> is the alternative.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$Destination,
    [int]$RetentionDays = 14,
    [int]$MinimumKeep = 3,
    [switch]$SkipStorage,
    [switch]$SkipDatabase,
    [switch]$Compress,
    [string]$DumpUser,
    [string]$DumpPassword
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')

Write-Banner 'BrandLens - backup'

$root = Get-BrandLensRoot
if (-not $Destination) { $Destination = Join-Path $root 'backups' }

$stamp = Get-Date -Format 'yyyy-MM-ddTHHmm'
$backupDir = Join-Path $Destination $stamp

$envMap = Read-DotEnv
$databaseUrl = Get-EnvValue -Key 'DATABASE_URL' -Env $envMap -Default 'postgresql://brandlens:brandlens@localhost:5432/brandlens'
$storageRoot = Get-EnvValue -Key 'STORAGE_LOCAL_ROOT' -Env $envMap -Default './.storage'
$storageDriver = Get-EnvValue -Key 'STORAGE_DRIVER' -Env $envMap -Default 'local'

if (-not [IO.Path]::IsPathRooted($storageRoot)) {
    $storageRoot = [IO.Path]::GetFullPath((Join-Path $root $storageRoot))
}

Write-Info "destination  $backupDir"
Write-Info "database     $(Protect-ConnectionString $databaseUrl)"
Write-Info "storage      $storageRoot ($storageDriver driver)"
if ($DumpUser) { Write-Info "dump role    $DumpUser (superuser path)" }
Write-Host ''

if ($DumpUser -and -not $DumpPassword) {
    $DumpPassword = $env:PGPASSWORD
    if (-not $DumpPassword) {
        $secure = Read-Host -Prompt "  Password for '$DumpUser'" -AsSecureString
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try { $DumpPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    }
}

$manifest = [ordered]@{
    createdAt     = (Get-Date).ToString('o')
    host          = $env:COMPUTERNAME
    repoRoot      = $root
    storageDriver = $storageDriver
}

if ($PSCmdlet.ShouldProcess($backupDir, 'create backup directory')) {
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
}

$failed = $false

# ===========================================================================
# 1 -- database
# ===========================================================================
if (-not $SkipDatabase) {
    Write-Step 'pg_dump'
    $pgDump = Get-PgToolPath -Tool 'pg_dump'
    if (-not $pgDump) {
        Write-Fail 'pg_dump not found'
        Write-Hint @(
            'Add C:\Program Files\PostgreSQL\16\bin to PATH, or install the',
            'PostgreSQL client tools on this host.'
        )
        $failed = $true
    } else {
        try {
            $target = ConvertFrom-DatabaseUrl $databaseUrl
            $dumpFile = Join-Path $backupDir "brandlens-$stamp.dump"

            # ---------------------------------------------------------------
            # RLS and pg_dump
            #
            # Every tenant table carries FORCE ROW LEVEL SECURITY, which
            # applies policies even to the table owner. pg_dump runs with
            # `row_security = off` and, rather than silently dumping a subset,
            # ABORTS with:
            #
            #   ERROR: query would be affected by row-level security policy
            #
            # So a plain `pg_dump -U brandlens` cannot back this database up at
            # all. Two ways out:
            #
            #   1. dump as a SUPERUSER, which has BYPASSRLS natively;
            #   2. dump as the app role with --enable-row-security, having set
            #      app.bypass_rls=on so every policy's USING clause is true.
            #
            # (2) is the default because it needs no extra credentials, but it
            # is only safe if the bypass genuinely works: with
            # --enable-row-security and NO bypass, pg_dump succeeds and writes
            # a silently incomplete backup, which is the worst possible
            # outcome. So the bypass is VERIFIED before the dump runs, and the
            # script refuses to continue if it cannot be confirmed.
            # ---------------------------------------------------------------
            $useSuperUser = [bool]$DumpUser
            $dumpRole = if ($useSuperUser) { $DumpUser } else { $target.User }
            $dumpPassword = if ($useSuperUser) { $DumpPassword } else { $target.Password }
            $bypassVerified = $false

            if (-not $useSuperUser) {
                $psqlPre = Get-PsqlPath
                if (-not $psqlPre) {
                    throw 'psql is required to verify the RLS bypass before dumping. ' +
                          'Install the PostgreSQL client tools, or pass -DumpUser postgres.'
                }
                $prevPass = $env:PGPASSWORD
                $prevOpts = $env:PGOPTIONS
                $env:PGPASSWORD = $target.Password
                $env:PGOPTIONS = '-c app.bypass_rls=on'
                try {
                    $check = & $psqlPre -h $target.Host -p $target.Port -U $target.User `
                        -d $target.Database -tA -c 'SELECT brandlens_rls_bypassed()' 2>&1 | Out-String
                    $bypassVerified = ($LASTEXITCODE -eq 0 -and $check.Trim() -eq 't')
                } finally {
                    $env:PGPASSWORD = $prevPass
                    $env:PGOPTIONS = $prevOpts
                }

                if (-not $bypassVerified) {
                    throw @'
Cannot guarantee a complete dump.

Every tenant table uses FORCE ROW LEVEL SECURITY, so pg_dump running as the
application role would either abort or (with --enable-row-security) write a
silently incomplete backup. The app.bypass_rls escape hatch could not be
verified on this database.

Fix one of these and re-run:
  * dump as a superuser:   .\backup.ps1 -DumpUser postgres
  * or re-apply the RLS layer, which defines brandlens_rls_bypassed():
        pnpm db:migrate
'@
                }
            }

            if ($PSCmdlet.ShouldProcess($target.Database, 'pg_dump -Fc')) {
                $previous = $env:PGPASSWORD
                $previousOpts = $env:PGOPTIONS
                $env:PGPASSWORD = $dumpPassword
                try {
                    # -Fc  custom format: compressed and selectively restorable
                    # -Z6  a sane CPU/size trade for a nightly job
                    # --no-owner / --no-privileges keep the dump portable across
                    #   installs whose role names differ.
                    $args = @(
                        '-h', $target.Host, '-p', [string]$target.Port,
                        '-U', $dumpRole, '-d', $target.Database,
                        '-Fc', '-Z', '6', '--no-owner', '--no-privileges',
                        '-f', $dumpFile
                    )
                    if (-not $useSuperUser) {
                        # Verified above: with app.bypass_rls=on every policy
                        # admits every row, so this dump is complete.
                        $env:PGOPTIONS = '-c app.bypass_rls=on'
                        $args += '--enable-row-security'
                    }
                    $output = & $pgDump @args 2>&1 | Out-String
                    if ($LASTEXITCODE -ne 0) { throw "pg_dump exited $LASTEXITCODE`n$($output.Trim())" }
                } finally {
                    $env:PGPASSWORD = $previous
                    $env:PGOPTIONS = $previousOpts
                }

                $size = (Get-Item $dumpFile).Length
                Write-Ok ("{0} ({1:N1} MB)" -f (Split-Path $dumpFile -Leaf), ($size / 1MB))

                $manifest.database = [ordered]@{
                    file     = Split-Path $dumpFile -Leaf
                    bytes    = $size
                    format   = 'custom'
                    database = $target.Database
                    server   = "$($target.Host):$($target.Port)"
                    dumpRole = $dumpRole
                    # 'superuser' bypasses RLS natively; 'app.bypass_rls'
                    # means the escape hatch was verified before the dump ran.
                    rlsMode  = if ($useSuperUser) { 'superuser' } else { 'app.bypass_rls' }
                }

                # Record schema facts so a restore is verifiable. Failure here
                # must not fail the backup -- the dump is already on disk.
                $psql = Get-PsqlPath
                if ($psql) {
                    $previous = $env:PGPASSWORD
                    $previousOpts = $env:PGOPTIONS
                    $env:PGPASSWORD = $target.Password
                    # Without the bypass these counts read as 0: no tenant is
                    # bound, so every RLS policy filters everything out.
                    $env:PGOPTIONS = '-c app.bypass_rls=on'
                    try {
                        $probe = & $psql -h $target.Host -p $target.Port -U $target.User -d $target.Database -tA -c @"
SELECT
  (SELECT count(*) FROM organizations),
  (SELECT count(*) FROM assets),
  (SELECT count(*) FROM check_runs),
  (SELECT count(*) FROM decision_traces),
  (SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname='vector')),
  (SELECT current_setting('server_version'))
"@ 2>&1 | Out-String
                        if ($LASTEXITCODE -eq 0) {
                            $parts = $probe.Trim() -split '\|'
                            $manifest.counts = [ordered]@{
                                organizations  = [int]$parts[0]
                                assets         = [int]$parts[1]
                                checkRuns      = [int]$parts[2]
                                decisionTraces = [int]$parts[3]
                            }
                            $manifest.pgvector = ($parts[4] -eq 't')
                            $manifest.serverVersion = $parts[5]
                            Write-Info ("rows: {0} orgs, {1} assets, {2} runs, {3} traces" -f `
                                    $manifest.counts.organizations, $manifest.counts.assets,
                                $manifest.counts.checkRuns, $manifest.counts.decisionTraces)
                        }
                    } finally {
                        $env:PGPASSWORD = $previous
                        $env:PGOPTIONS = $previousOpts
                    }
                }
            } else {
                Write-Skip 'would dump'
            }
        } catch {
            Write-Fail $_.Exception.Message
            Write-Hint @(
                'Check that the role in DATABASE_URL can read every table, and that',
                'pg_dump matches the server major version (a 15 client cannot dump a 17).'
            )
            $failed = $true
        }
    }
}

# ===========================================================================
# 2 -- storage
# ===========================================================================
if (-not $SkipStorage) {
    Write-Step 'storage'
    if ($storageDriver -ne 'local') {
        Write-Skip "driver is '$storageDriver' -- back it up with the provider's own tooling"
        $manifest.storage = @{ skipped = "driver=$storageDriver" }
    } elseif (-not (Test-Path $storageRoot)) {
        Write-Warn "no storage directory at $storageRoot (nothing uploaded yet)"
        $manifest.storage = @{ skipped = 'directory absent' }
    } elseif ($PSCmdlet.ShouldProcess($storageRoot, 'copy storage tree')) {
        $storageDest = Join-Path $backupDir 'storage'
        New-Item -ItemType Directory -Path $storageDest -Force | Out-Null

        $copied = 0
        $bytes = 0
        $skipped = 0

        # Content-addressed files never change, so an existing destination file
        # of the same size is byte-identical by construction. Skipping it turns
        # an incremental backup into an O(new files) operation.
        Get-ChildItem -LiteralPath $storageRoot -Recurse -File | ForEach-Object {
            $relative = $_.FullName.Substring($storageRoot.Length).TrimStart('\', '/')
            $destination = Join-Path $storageDest $relative
            $destDir = Split-Path $destination -Parent
            if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
            if ((Test-Path $destination) -and ((Get-Item $destination).Length -eq $_.Length)) {
                $skipped++
                return
            }
            Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
            $copied++
            $bytes += $_.Length
        }

        Write-Ok ("{0} files ({1:N1} MB), {2} unchanged" -f $copied, ($bytes / 1MB), $skipped)
        $manifest.storage = [ordered]@{
            source  = $storageRoot
            files   = $copied
            bytes   = $bytes
            skipped = $skipped
        }
    } else {
        Write-Skip 'would copy'
    }
}

# ===========================================================================
# 3 -- manifest
# ===========================================================================
if ($PSCmdlet.ShouldProcess('manifest.json', 'write')) {
    $manifestPath = Join-Path $backupDir 'manifest.json'
    $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
    Write-Step 'manifest'
    Write-Ok 'manifest.json'
}

# ===========================================================================
# 4 -- optional zip
# ===========================================================================
if ($Compress -and $PSCmdlet.ShouldProcess($backupDir, 'compress to .zip')) {
    Write-Step 'compress'
    $zipPath = Join-Path $Destination "brandlens-$stamp.zip"
    try {
        Compress-Archive -Path (Join-Path $backupDir '*') -DestinationPath $zipPath -Force
        Write-Ok ("{0} ({1:N1} MB)" -f (Split-Path $zipPath -Leaf), ((Get-Item $zipPath).Length / 1MB))
    } catch {
        Write-Warn "compression failed: $($_.Exception.Message)"
        Write-Hint @('Compress-Archive has a 2 GB limit; use 7-Zip or robocopy for larger sets.')
    }
}

# ===========================================================================
# 5 -- retention
#
# Prune only AFTER a successful backup, and never below MinimumKeep. Deleting
# yesterday's good backup because today's failed is the classic way to have no
# backups at all.
# ===========================================================================
if ($RetentionDays -gt 0 -and -not $failed) {
    Write-Step 'retention'
    $cutoff = (Get-Date).AddDays(-$RetentionDays)

    $all = @(Get-ChildItem -LiteralPath $Destination -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match '^\d{4}-\d{2}-\d{2}T\d{4}$' } |
            Sort-Object Name -Descending)

    $keep = @($all | Select-Object -First ([Math]::Max(1, $MinimumKeep)))
    $prunable = @($all | Where-Object { $_.Name -notin $keep.Name -and $_.CreationTime -lt $cutoff })

    if ($prunable.Count -eq 0) {
        Write-Ok "$($all.Count) kept, nothing older than $RetentionDays days"
    } else {
        foreach ($dir in $prunable) {
            if ($PSCmdlet.ShouldProcess($dir.FullName, 'delete expired backup')) {
                Remove-Item -LiteralPath $dir.FullName -Recurse -Force
                $zip = Join-Path $Destination ("brandlens-{0}.zip" -f $dir.Name)
                if (Test-Path $zip) { Remove-Item -LiteralPath $zip -Force }
            }
        }
        Write-Ok "pruned $($prunable.Count), kept $($all.Count - $prunable.Count)"
    }
} elseif ($failed) {
    Write-Step 'retention'
    Write-Skip 'skipped -- this backup did not complete cleanly'
}

# ===========================================================================
Write-Host ''
if ($failed) {
    Write-Fail 'Backup completed with errors. Do NOT rely on this run.'
    Write-Host ''
    exit 1
}

$totalSize = 0
if (Test-Path $backupDir) {
    $totalSize = (Get-ChildItem -LiteralPath $backupDir -Recurse -File |
            Measure-Object -Property Length -Sum).Sum
}
Write-Host ("  Backup complete -- {0} ({1:N1} MB)" -f $backupDir, ($totalSize / 1MB)) -ForegroundColor Green
Write-Host ''
Write-Host '  Restore (drill this quarterly -- see docs\operations.md):' -ForegroundColor Cyan
Write-Host "    pg_restore --clean --if-exists --no-owner -d brandlens `"$backupDir\brandlens-$stamp.dump`""
Write-Host "    Copy-Item `"$backupDir\storage\*`" `"$storageRoot`" -Recurse -Force"
Write-Host ''
exit 0
