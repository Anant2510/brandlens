#Requires -Version 5.1
<#
.SYNOPSIS
    Creates the BrandLens role and database, applies migrations, seeds the demo.

.DESCRIPTION
    Run once on a fresh install, and safely again after any upgrade — every
    step is idempotent:

      1. connect as the superuser and CREATE ROLE / CREATE DATABASE if absent
      2. always reset the role password to the one in DATABASE_URL, so the
         .env file is the single source of truth
      3. attempt CREATE EXTENSION vector and report, in plain language, whether
         ANN acceleration or the portable real[] fallback will be used
      4. verifies the committed migrations are present
      5. pnpm db:migrate   — extensions, DDL, RLS policies, vector acceleration
      6. pnpm db:seed      — the Northwind Coffee Co. demo tenant

    pgvector is OPTIONAL. BrandLens ships an in-SQL cosine similarity function
    over real[] columns and selects the driver at boot, so a database without
    pgvector is fully supported — it is slower on large precedent galleries,
    and nothing else changes.

.PARAMETER DbHost
    PostgreSQL host. Default: parsed from DATABASE_URL in .env.

.PARAMETER Port
    PostgreSQL port. Default: parsed from DATABASE_URL in .env.

.PARAMETER SuperUser
    Superuser used to create the role and database. Default: postgres.

.PARAMETER SuperUserPassword
    Superuser password. Prompted for if omitted and PGPASSWORD is unset.

.PARAMETER SkipSeed
    Migrate but do not seed. Use on an existing production database.

.PARAMETER SkipMigrate
    Create the role/database only.

.PARAMETER Force
    Drop and recreate the database first. DESTRUCTIVE — refuses without
    -Confirm and prints exactly what it is about to destroy.

.EXAMPLE
    .\setup-database.ps1
    Read DATABASE_URL from .env, create everything, migrate and seed.

.EXAMPLE
    .\setup-database.ps1 -DbHost db01.corp.local -Port 5432 -SuperUser postgres
    Point at a shared database server.

.EXAMPLE
    .\setup-database.ps1 -WhatIf
    Show every statement that would run, and change nothing.
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [string]$DbHost,
    [int]$Port = 0,
    [string]$SuperUser = 'postgres',
    [string]$SuperUserPassword,
    [switch]$SkipSeed,
    [switch]$SkipMigrate,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')

Write-Banner 'BrandLens · database setup'

# ---------------------------------------------------------------------------
# Resolve the target from .env — the file the running services will read.
# ---------------------------------------------------------------------------
$envFile = Get-BrandLensPath '.env'
if (-not (Test-Path $envFile)) {
    Write-Fail '.env not found.'
    Write-Hint @(
        "Create it first:  Copy-Item '$(Get-BrandLensPath '.env.example')' '$envFile'",
        'then set DATABASE_URL and the secrets, and re-run this script.'
    )
    exit 1
}

$envMap = Read-DotEnv $envFile
$databaseUrl = Get-EnvValue -Key 'DATABASE_URL' -Env $envMap `
    -Default 'postgresql://brandlens:brandlens@localhost:5432/brandlens'

try {
    $target = ConvertFrom-DatabaseUrl $databaseUrl
} catch {
    Write-Fail $_.Exception.Message
    Write-Hint @('Expected shape:  postgresql://user:password@host:5432/database')
    exit 1
}

if ($DbHost) { $target.Host = $DbHost }
if ($Port -gt 0) { $target.Port = $Port }

Write-Info "target      $(Protect-ConnectionString $databaseUrl)"
Write-Info "server      $($target.Host):$($target.Port)"
Write-Info "role        $($target.User)"
Write-Info "database    $($target.Database)"
Write-Host ''

if (-not $target.Password) {
    Write-Fail 'DATABASE_URL has no password. The services cannot authenticate without one.'
    Write-Hint @('Set it in .env, e.g. postgresql://brandlens:<password>@localhost:5432/brandlens')
    exit 1
}

# ---------------------------------------------------------------------------
# Locate psql
# ---------------------------------------------------------------------------
Write-Step 'psql'
$psql = Get-PsqlPath
if (-not $psql) {
    Write-Fail 'psql.exe not found.'
    Write-Hint @(
        'Install PostgreSQL 16/17 (winget install PostgreSQL.PostgreSQL.16), or add',
        'C:\Program Files\PostgreSQL\16\bin to the machine PATH and open a new shell.'
    )
    exit 1
}
Write-Ok $psql

# ---------------------------------------------------------------------------
# Reachability — a clear message beats a psql connection dump.
# ---------------------------------------------------------------------------
Write-Step 'server reachable'
if (-not (Test-TcpPort -ComputerName $target.Host -Port $target.Port)) {
    Write-Fail "nothing is listening on $($target.Host):$($target.Port)"
    Write-Hint @(
        'Check the service:   Get-Service postgresql*',
        'Start it:            Start-Service postgresql-x64-16',
        'Confirm the port in postgresql.conf if it was changed from 5432.'
    )
    exit 1
}
Write-Ok "$($target.Host):$($target.Port)"

# ---------------------------------------------------------------------------
# Superuser credentials
# ---------------------------------------------------------------------------
if (-not $SuperUserPassword) { $SuperUserPassword = $env:PGPASSWORD }
if (-not $SuperUserPassword) {
    $secure = Read-Host -Prompt "  Password for PostgreSQL superuser '$SuperUser'" -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $SuperUserPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

function Invoke-Psql {
    <#
    .SYNOPSIS
        Runs SQL as the superuser against one database and returns stdout.
    .DESCRIPTION
        -v ON_ERROR_STOP=1 so a failing statement is a failing script;
        -tA for tuple-only unaligned output that is trivial to compare.
        The password is passed through the process environment, never argv,
        so it does not land in the command line of a running process.
    #>
    param(
        [Parameter(Mandatory)][string]$Sql,
        [string]$Database = 'postgres',
        [switch]$Tolerant
    )
    $previous = $env:PGPASSWORD
    $env:PGPASSWORD = $SuperUserPassword
    try {
        $output = & $psql -h $target.Host -p $target.Port -U $SuperUser -d $Database `
            -v ON_ERROR_STOP=1 -tA -c $Sql 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0 -and -not $Tolerant) {
            throw "psql failed:`n$($output.Trim())"
        }
        return $output.Trim()
    } finally {
        $env:PGPASSWORD = $previous
    }
}

Write-Step 'superuser login'
try {
    $serverVersion = Invoke-Psql -Sql 'SHOW server_version'
    Write-Ok "PostgreSQL $serverVersion"
} catch {
    Write-Fail 'could not authenticate as the superuser'
    Write-Hint @(
        'Check the password, and that pg_hba.conf allows md5/scram from this host.',
        "pg_hba.conf lives beside postgresql.conf in the data directory;",
        'after editing it run:  Restart-Service postgresql-x64-16'
    )
    exit 1
}

$sq = { param($v) "'" + ($v -replace "'", "''") + "'" }   # SQL string literal
$qi = { param($v) '"' + ($v -replace '"', '""') + '"' }   # SQL identifier

# ---------------------------------------------------------------------------
# Destructive path
# ---------------------------------------------------------------------------
if ($Force) {
    Write-Host ''
    Write-Warn "-Force will DROP DATABASE $($target.Database) on $($target.Host):$($target.Port)."
    Write-Warn 'Every brand, asset, check run and decision trace in it is destroyed.'
    if ($PSCmdlet.ShouldProcess("$($target.Host)/$($target.Database)", 'DROP DATABASE and recreate')) {
        Write-Step 'drop database'
        # Terminate stragglers first, or DROP fails with "is being accessed by
        # other users" — PM2 processes hold pooled connections open.
        Invoke-Psql -Tolerant -Sql @"
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
WHERE datname = $(& $sq $target.Database) AND pid <> pg_backend_pid();
"@ | Out-Null
        Invoke-Psql -Sql "DROP DATABASE IF EXISTS $(& $qi $target.Database)" | Out-Null
        Write-Ok 'dropped'
    } else {
        Write-Skip 'declined'
    }
}

# ---------------------------------------------------------------------------
# Role
# ---------------------------------------------------------------------------
Write-Step 'role'
$roleExists = (Invoke-Psql -Sql "SELECT 1 FROM pg_roles WHERE rolname = $(& $sq $target.User)") -eq '1'
if ($roleExists) {
    if ($PSCmdlet.ShouldProcess($target.User, 'ALTER ROLE ... PASSWORD')) {
        # .env is authoritative. Resetting the password here is what makes a
        # password change a one-file edit instead of a two-place ritual.
        Invoke-Psql -Sql "ALTER ROLE $(& $qi $target.User) WITH LOGIN PASSWORD $(& $sq $target.Password)" | Out-Null
        Write-Ok 'exists, password synchronised with .env'
    } else {
        Write-Skip 'exists (password not changed)'
    }
} elseif ($PSCmdlet.ShouldProcess($target.User, 'CREATE ROLE')) {
    Invoke-Psql -Sql "CREATE ROLE $(& $qi $target.User) WITH LOGIN PASSWORD $(& $sq $target.Password)" | Out-Null
    Write-Ok 'created'
} else {
    Write-Skip 'would create'
}

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------
Write-Step 'database'
$dbExists = (Invoke-Psql -Sql "SELECT 1 FROM pg_database WHERE datname = $(& $sq $target.Database)") -eq '1'
if ($dbExists) {
    Write-Ok 'exists'
} elseif ($PSCmdlet.ShouldProcess($target.Database, 'CREATE DATABASE')) {
    # CREATE DATABASE cannot run inside a transaction block, so it gets its own
    # invocation with no other statements attached.
    Invoke-Psql -Sql "CREATE DATABASE $(& $qi $target.Database) OWNER $(& $qi $target.User) ENCODING 'UTF8'" | Out-Null
    Write-Ok 'created'
} else {
    Write-Skip 'would create'
}

# ---------------------------------------------------------------------------
# Grants
#
# On PostgreSQL 15+ the PUBLIC role lost CREATE on the public schema, so a
# non-owner role cannot create tables without this. Getting it wrong produces
# "permission denied for schema public" halfway through the first migration.
# ---------------------------------------------------------------------------
if ($dbExists -or $PSCmdlet.ShouldProcess($target.Database, 'GRANT schema privileges')) {
    Write-Step 'grants'
    try {
        Invoke-Psql -Database $target.Database -Sql @"
GRANT ALL ON DATABASE $(& $qi $target.Database) TO $(& $qi $target.User);
GRANT ALL ON SCHEMA public TO $(& $qi $target.User);
ALTER SCHEMA public OWNER TO $(& $qi $target.User);
"@ | Out-Null
        Write-Ok 'schema public owned by the app role'
    } catch {
        Write-Warn 'could not adjust ownership of schema public'
        Write-Hint @('Continuing — this only matters if migrations later fail with a permission error.')
    }
}

# ---------------------------------------------------------------------------
# pgvector — attempted, never required.
# ---------------------------------------------------------------------------
Write-Step 'pgvector'
$vectorAvailable = (Invoke-Psql -Database $target.Database -Tolerant `
        -Sql "SELECT 1 FROM pg_available_extensions WHERE name = 'vector'") -eq '1'

$vectorInstalled = $false
if ($vectorAvailable) {
    if ($PSCmdlet.ShouldProcess($target.Database, 'CREATE EXTENSION vector')) {
        try {
            Invoke-Psql -Database $target.Database -Sql 'CREATE EXTENSION IF NOT EXISTS vector' | Out-Null
            $vectorInstalled = (Invoke-Psql -Database $target.Database -Tolerant `
                    -Sql "SELECT 1 FROM pg_extension WHERE extname = 'vector'") -eq '1'
        } catch {
            $vectorInstalled = $false
        }
    }
}

Write-Host ''
if ($vectorInstalled) {
    Write-Host '  Vector search: pgvector ENABLED' -ForegroundColor Green
    Write-Info 'Embeddings get a shadow vector(N) column plus an HNSW index.'
    Write-Info 'Precedent retrieval uses approximate nearest-neighbour search.'
} else {
    Write-Host '  Vector search: real[] FALLBACK (pgvector not installed)' -ForegroundColor Yellow
    Write-Info 'This is a fully supported configuration. BrandLens stores every'
    Write-Info 'embedding in a portable real[] column and ranks with an in-SQL'
    Write-Info 'cosine function, so nothing is disabled — precedent retrieval'
    Write-Info 'does a sequential scan instead of an index scan.'
    Write-Info ''
    Write-Info 'Practical impact: negligible below ~50k embeddings per tenant;'
    Write-Info 'noticeable above ~250k. Add pgvector later and re-run'
    Write-Info 'pnpm db:migrate — the vector column is backfilled by trigger.'
    Write-Info ''
    Write-Info 'To add it on Windows without a compiler:'
    Write-Info '  1. Download the prebuilt binaries matching your major version'
    Write-Info '     from https://github.com/pgvector/pgvector/releases'
    Write-Info '     (or the community build at github.com/andreiramani/pgvector_pgsql_windows)'
    Write-Info '  2. Copy vector.dll        -> C:\Program Files\PostgreSQL\16\lib\'
    Write-Info '  3. Copy vector*.sql and vector.control'
    Write-Info '                            -> C:\Program Files\PostgreSQL\16\share\extension\'
    Write-Info '  4. Restart-Service postgresql-x64-16'
    Write-Info '  5. Re-run this script (it is idempotent).'
}
Write-Host ''

# ---------------------------------------------------------------------------
# Connectivity as the application role — catches pg_hba problems before the
# services do, where the failure looks like a mysterious boot loop.
# ---------------------------------------------------------------------------
Write-Step 'app role login'
$previousPassword = $env:PGPASSWORD
$env:PGPASSWORD = $target.Password
try {
    $who = & $psql -h $target.Host -p $target.Port -U $target.User -d $target.Database `
        -v ON_ERROR_STOP=1 -tA -c 'SELECT current_user' 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { throw $who.Trim() }
    Write-Ok $who.Trim()
} catch {
    Write-Fail "the '$($target.User)' role cannot log in"
    Write-Hint @(
        'Add a pg_hba.conf line above the default host rules:',
        "  host    $($target.Database)    $($target.User)    127.0.0.1/32    scram-sha-256",
        'then:  Restart-Service postgresql-x64-16'
    )
    exit 1
} finally {
    $env:PGPASSWORD = $previousPassword
}

if ($SkipMigrate) {
    Write-Host ''
    Write-Host '  Role and database ready. Migrations skipped (-SkipMigrate).' -ForegroundColor Green
    exit 0
}

# ---------------------------------------------------------------------------
# Migrate + seed through the workspace scripts, so there is exactly one
# implementation of "apply the schema" and it is the one CI runs.
# ---------------------------------------------------------------------------
$pnpm = Get-PnpmCommand
if (-not $pnpm) {
    Write-Fail 'pnpm not found — cannot run migrations.'
    Write-Hint @('Run infra\windows\bootstrap.ps1 first, or:  corepack enable pnpm')
    exit 1
}

$root = Get-BrandLensRoot

function Invoke-PnpmScript {
    param([string]$Script, [string]$Label)
    Write-Host ''
    Write-Host "  > pnpm $Script" -ForegroundColor Cyan
    if (-not $PSCmdlet.ShouldProcess($Label, "pnpm $Script")) {
        Write-Skip 'would run'
        return $true
    }
    try {
        Invoke-Checked -FilePath $pnpm -ArgumentList @($Script.Split(' ')) `
            -WorkingDirectory $root -Context "pnpm $Script"
        Write-Ok $Label
        return $true
    } catch {
        Write-Fail $_.Exception.Message
        return $false
    }
}

# Migrations are committed to the repository and applied verbatim here. This
# server deliberately does NOT run `pnpm db:generate`: production must execute
# the exact SQL that was reviewed in a pull request, not SQL invented on the
# machine that holds the live data. See .gitignore and docs/github-workflow.md.
Write-Step 'Checking committed migrations'
$migrationDir = Get-BrandLensPath 'packages' 'db' 'drizzle'
$migrationFiles = @(Get-ChildItem -LiteralPath $migrationDir -Filter '*.sql' -ErrorAction SilentlyContinue)
if ($migrationFiles.Count -eq 0) {
    Write-Fail 'No migrations found in packages\db\drizzle.'
    Write-Hint @(
        'Migrations are committed to git, so a correct clone always has them.',
        'An empty folder means this VM was set up by copying files rather than',
        'by `git clone`, or the clone is on a branch that predates them.',
        '',
        'Generate them on a DEVELOPER machine and commit the result:',
        '  pnpm db:generate && git add packages/db/drizzle && git commit'
    )
    exit 1
}
Write-Ok ('{0} migration file(s) present' -f $migrationFiles.Count)

if (-not (Invoke-PnpmScript -Script 'db:migrate' -Label 'schema, RLS policies and vector layer applied')) {
    Write-Hint @(
        'Common causes:',
        '  - DATABASE_URL in .env points somewhere else than this script did',
        '  - the app role does not own schema public (see the grants step above)',
        '  - a previous partial migration; on a dev box:  pnpm db:reset'
    )
    exit 1
}

if ($SkipSeed) {
    Write-Host ''
    Write-Host '  Database ready. Seed skipped (-SkipSeed).' -ForegroundColor Green
    exit 0
}

if (-not (Invoke-PnpmScript -Script 'db:seed' -Label 'demo tenant seeded')) {
    Write-Hint @(
        'The seed is idempotent, so it is safe to re-run once the cause is fixed.',
        'If it failed on file writes, check that seed\assets is writable.'
    )
    exit 1
}

Write-Host ''
Write-Host '  Database setup complete.' -ForegroundColor Green
Write-Host '  Next:  .\infra\windows\setup-python.ps1' -ForegroundColor Cyan
Write-Host ''
exit 0
