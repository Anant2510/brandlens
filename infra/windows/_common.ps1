# ============================================================================
# BrandLens - shared PowerShell helpers
#
# Dot-sourced by every script in this folder:
#     . (Join-Path $PSScriptRoot '_common.ps1')
#
# Nothing in here is destructive and nothing here prompts. It exists so the
# nine operational scripts share one notion of "where is the repo", "what does
# OK look like", and "how do we fail loudly".
# ============================================================================

Set-StrictMode -Version Latest

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

# infra/windows/_common.ps1  ->  repo root is two levels up.
$script:BrandLensRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

function Get-BrandLensRoot {
    <#
    .SYNOPSIS
        Absolute path to the repository root.
    #>
    return $script:BrandLensRoot
}

function Get-BrandLensPath {
    <#
    .SYNOPSIS
        Join one or more segments onto the repo root.
    #>
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Segments)
    $path = $script:BrandLensRoot
    foreach ($segment in $Segments) { $path = Join-Path $path $segment }
    return $path
}

# ---------------------------------------------------------------------------
# Output
#
# Colour is applied through Write-Host deliberately: these are interactive
# operator scripts, and the coloured status column is the entire point. Data
# that a caller might want to pipe is returned from the functions instead.
# ---------------------------------------------------------------------------

$script:BrandLensQuiet = $false

function Set-BrandLensQuiet { param([bool]$Value) $script:BrandLensQuiet = $Value }

function Write-Banner {
    param([string]$Title, [string]$Subtitle = '')
    if ($script:BrandLensQuiet) { return }
    Write-Host ''
    Write-Host ('  ' + $Title) -ForegroundColor Cyan
    if ($Subtitle) { Write-Host ('  ' + $Subtitle) -ForegroundColor DarkGray }
    Write-Host ('  ' + ('-' * [Math]::Max(28, $Title.Length))) -ForegroundColor DarkGray
}

function Write-Step {
    param([string]$Message)
    if ($script:BrandLensQuiet) { return }
    Write-Host ('  ' + $Message.PadRight(34)) -NoNewline
}

function Write-Ok {
    param([string]$Detail = 'OK')
    if ($script:BrandLensQuiet) { return }
    Write-Host ('[ OK ] ' + $Detail) -ForegroundColor Green
}

function Write-Warn {
    param([string]$Detail)
    if ($script:BrandLensQuiet) { return }
    Write-Host ('[WARN] ' + $Detail) -ForegroundColor Yellow
}

function Write-Fail {
    param([string]$Detail)
    Write-Host ('[FAIL] ' + $Detail) -ForegroundColor Red
}

function Write-Skip {
    param([string]$Detail)
    if ($script:BrandLensQuiet) { return }
    Write-Host ('[SKIP] ' + $Detail) -ForegroundColor DarkGray
}

function Write-Info {
    param([string]$Message)
    if ($script:BrandLensQuiet) { return }
    Write-Host ('  ' + $Message) -ForegroundColor Gray
}

function Write-Hint {
    <#
    .SYNOPSIS
        An indented, actionable next step. Used on every failure path -- an
        error the operator cannot act on is not an error message.
    #>
    param([string[]]$Lines)
    foreach ($line in $Lines) { Write-Host ('         ' + $line) -ForegroundColor DarkYellow }
}

function Write-TableBlock {
    <#
    .SYNOPSIS
        Renders objects as a table. Works when there is no console.
    .DESCRIPTION
        `Format-Table -AutoSize | Out-String` silently produces an EMPTY string
        when the host has no console width to measure -- which is exactly the
        case under a Windows scheduled task, a CI runner, or any redirected
        pipeline. Since healthcheck.ps1 and backup.ps1 are meant to be run from
        schtasks, that failure would make their most useful output vanish
        precisely where nobody is watching.

        Passing an explicit -Width to Out-String makes the rendering identical
        everywhere, so every table in these scripts goes through here.
    #>
    param(
        [Parameter(ValueFromPipeline = $true)] $InputObject,
        [int]$Width = 200
    )
    begin { $items = [System.Collections.Generic.List[object]]::new() }
    process { if ($null -ne $InputObject) { $items.Add($InputObject) } }
    end {
        if ($items.Count -eq 0) { return }
        $text = ($items | Format-Table -AutoSize -Wrap | Out-String -Width $Width)
        foreach ($line in ($text -split "`r?`n")) {
            if ($line.Trim().Length -gt 0) { Write-Host ('  ' + $line.TrimEnd()) }
        }
    }
}

# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------

function Test-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Test-CommandExists {
    param([Parameter(Mandatory)][string]$Name)
    return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Get-CommandVersion {
    <#
    .SYNOPSIS
        Runs `<cmd> <args>` and returns the first version-looking token, or $null.
    .DESCRIPTION
        Tolerates a missing command, a non-zero exit and stderr chatter -- this
        is used for *detection*, where "not installed" is a normal answer.
    #>
    param(
        [Parameter(Mandatory)][string]$Command,
        [string[]]$Arguments = @('--version')
    )
    if (-not (Test-CommandExists $Command)) { return $null }
    try {
        $raw = (& $Command @Arguments 2>&1 | Out-String)
        if ($LASTEXITCODE -ne 0 -and -not $raw) { return $null }
        $match = [regex]::Match($raw, '(\d+)\.(\d+)(\.(\d+))?')
        if ($match.Success) { return $match.Value }
        return ($raw.Trim() -split "`n")[0].Trim()
    } catch {
        return $null
    }
}

function Compare-Version {
    <#
    .SYNOPSIS
        Returns $true when $Actual >= $Minimum. Missing components count as 0.
    #>
    param([string]$Actual, [string]$Minimum)
    if (-not $Actual) { return $false }
    $normalise = {
        param($v)
        $parts = ($v -replace '[^0-9.]', '') -split '\.' | Where-Object { $_ -ne '' }
        while ($parts.Count -lt 3) { $parts += '0' }
        return @([int]$parts[0], [int]$parts[1], [int]$parts[2])
    }
    $a = & $normalise $Actual
    $b = & $normalise $Minimum
    for ($i = 0; $i -lt 3; $i++) {
        if ($a[$i] -gt $b[$i]) { return $true }
        if ($a[$i] -lt $b[$i]) { return $false }
    }
    return $true
}

function Update-SessionPath {
    <#
    .SYNOPSIS
        Re-reads PATH from the registry into the current process.
    .DESCRIPTION
        winget installs a tool and updates the machine PATH, but the running
        PowerShell process keeps its stale copy -- which is why "I just
        installed node and it says node is not recognised" is the single most
        common bootstrap complaint. Calling this after each install fixes it
        without asking the operator to open a new window.
    #>
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = (@($machine, $user) | Where-Object { $_ } ) -join ';'
}

# ---------------------------------------------------------------------------
# .env handling
# ---------------------------------------------------------------------------

function Read-DotEnv {
    <#
    .SYNOPSIS
        Parses a .env file into a hashtable. Comments and blanks are ignored;
        surrounding quotes are stripped; the first '=' wins so values may
        contain '=' (connection strings routinely do).
    #>
    param([string]$Path = (Get-BrandLensPath '.env'))
    $result = @{}
    if (-not (Test-Path $Path)) { return $result }
    foreach ($line in Get-Content -LiteralPath $Path) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
        $idx = $trimmed.IndexOf('=')
        if ($idx -lt 1) { continue }
        $key = $trimmed.Substring(0, $idx).Trim()
        $value = $trimmed.Substring($idx + 1).Trim()
        if ($value.Length -ge 2) {
            if (($value.StartsWith('"') -and $value.EndsWith('"')) -or
                ($value.StartsWith("'") -and $value.EndsWith("'"))) {
                $value = $value.Substring(1, $value.Length - 2)
            }
        }
        $result[$key] = $value
    }
    return $result
}

function Get-EnvValue {
    <#
    .SYNOPSIS
        Reads one key from .env, falling back to the process environment and
        then to a default.
    #>
    param(
        [Parameter(Mandatory)][string]$Key,
        [string]$Default = $null,
        [hashtable]$Env = $null
    )
    if (-not $Env) { $Env = Read-DotEnv }
    if ($Env.ContainsKey($Key) -and $Env[$Key]) { return $Env[$Key] }
    $fromProcess = [Environment]::GetEnvironmentVariable($Key)
    if ($fromProcess) { return $fromProcess }
    return $Default
}

function ConvertFrom-DatabaseUrl {
    <#
    .SYNOPSIS
        Splits postgresql://user:pass@host:port/db into its parts.
    .OUTPUTS
        Hashtable with User, Password, Host, Port, Database.
    #>
    param([Parameter(Mandatory)][string]$Url)
    $pattern = '^postgres(?:ql)?://(?<user>[^:@/]+)(?::(?<pass>[^@]*))?@(?<host>[^:/?]+)(?::(?<port>\d+))?/(?<db>[^?]+)'
    $m = [regex]::Match($Url, $pattern)
    if (-not $m.Success) { throw "DATABASE_URL is not a valid Postgres URL: $Url" }
    return @{
        User     = [Uri]::UnescapeDataString($m.Groups['user'].Value)
        Password = [Uri]::UnescapeDataString($m.Groups['pass'].Value)
        Host     = $m.Groups['host'].Value
        Port     = if ($m.Groups['port'].Success) { [int]$m.Groups['port'].Value } else { 5432 }
        Database = $m.Groups['db'].Value
    }
}

function Protect-ConnectionString {
    <#
    .SYNOPSIS
        Masks the password so a connection string can be safely logged.
    #>
    param([string]$Value)
    if (-not $Value) { return '' }
    return ($Value -replace '(?<=//[^:@/]+:)[^@]+(?=@)', '****')
}

# ---------------------------------------------------------------------------
# HTTP probing
# ---------------------------------------------------------------------------

function Test-HttpEndpoint {
    <#
    .SYNOPSIS
        GETs a URL and returns @{ Ok; Status; DurationMs; Error; Body }.
    #>
    param(
        [Parameter(Mandatory)][string]$Url,
        [int]$TimeoutSeconds = 5
    )
    $sw = [Diagnostics.Stopwatch]::StartNew()
    try {
        $response = Invoke-WebRequest -Uri $Url -TimeoutSec $TimeoutSeconds -UseBasicParsing -ErrorAction Stop
        $sw.Stop()
        return @{
            Ok         = ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400)
            Status     = [int]$response.StatusCode
            DurationMs = [int]$sw.ElapsedMilliseconds
            Error      = $null
            Body       = $response.Content
        }
    } catch {
        $sw.Stop()
        $status = 0
        if ($_.Exception.PSObject.Properties.Name -contains 'Response' -and $_.Exception.Response) {
            try { $status = [int]$_.Exception.Response.StatusCode } catch { $status = 0 }
        }
        return @{
            Ok         = $false
            Status     = $status
            DurationMs = [int]$sw.ElapsedMilliseconds
            Error      = $_.Exception.Message
            Body       = $null
        }
    }
}

function Test-TcpPort {
    param([string]$ComputerName = '127.0.0.1', [Parameter(Mandatory)][int]$Port, [int]$TimeoutMs = 1500)
    $client = New-Object Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect($ComputerName, $Port, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMs)) { return $false }
        $client.EndConnect($async)
        return $true
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

# ---------------------------------------------------------------------------
# External processes
# ---------------------------------------------------------------------------

function ConvertFrom-JsonSafe {
    <#
    .SYNOPSIS
        Parses JSON without the two ways ConvertFrom-Json fails on Windows.
    .DESCRIPTION
        Windows PowerShell 5.1's ConvertFrom-Json breaks on payloads this
        project produces every day:

          * DUPLICATE KEYS DIFFERING ONLY IN CASE. The cmdlet folds keys
            case-insensitively, so a Windows environment block containing both
            'username' and 'USERNAME' -- which is exactly what `pm2 jlist`
            embeds under pm2_env -- throws
            "contains the duplicated keys 'username' and 'USERNAME'".

          * LARGE PAYLOADS. It inherits JavaScriptSerializer's default
            MaxJsonLength, and /health/deep carries 40 analyzer descriptors.

        JavaScriptSerializer.DeserializeObject compares keys ordinally and
        takes a configurable length limit, so it survives both. It returns
        Dictionary<string,object> and object[] rather than PSCustomObject, so
        callers index with ['key'] instead of .key -- a deliberate trade:
        dictionary lookups are case-sensitive, which is the whole point.

        Returns $null on unparseable input rather than throwing, so a health
        check reports a bad payload instead of dying on it.
    #>
    param([Parameter(Mandatory)][AllowEmptyString()][AllowNull()][string]$Json)

    if ([string]::IsNullOrWhiteSpace($Json)) { return $null }

    # Path 1 -- Windows PowerShell 5.1, which is what the VM runs.
    # System.Web.Extensions ships with .NET Framework only; it is absent on
    # .NET Core, so this silently declines on pwsh 7 and Linux.
    try {
        Add-Type -AssemblyName System.Web.Extensions -ErrorAction Stop
        $serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
        $serializer.MaxJsonLength = [int]::MaxValue
        $serializer.RecursionLimit = 256
        return $serializer.DeserializeObject($Json)
    } catch { }

    # Path 2 -- PowerShell 6+. -AsHashtable is precisely what the built-in
    # error message recommends for case-clashing keys, and it returns
    # IDictionary, so Get-JsonValue indexes it the same way.
    try {
        return $Json | ConvertFrom-Json -AsHashtable -ErrorAction Stop
    } catch { }

    # Path 3 -- last resort. Fails on case-clashing keys, which is why it is
    # last, but it is better than returning nothing for ordinary payloads.
    try {
        return $Json | ConvertFrom-Json -ErrorAction Stop
    } catch {
        return $null
    }
}

function Get-JsonValue {
    <#
    .SYNOPSIS
        Safe nested lookup into a ConvertFrom-JsonSafe result.
    .EXAMPLE
        Get-JsonValue $parsed 'components' 'engine' 'ok'
    #>
    param(
        [Parameter(Mandatory, Position = 0)][AllowNull()]$Object,
        [Parameter(ValueFromRemainingArguments)][string[]]$Path
    )
    $current = $Object
    foreach ($key in $Path) {
        if ($null -eq $current) { return $null }
        if ($current -is [System.Collections.IDictionary]) {
            if (-not $current.Contains($key)) { return $null }
            $current = $current[$key]
        } else {
            return $null
        }
    }
    return $current
}

function Invoke-Checked {
    <#
    .SYNOPSIS
        Runs a native command and throws with the captured output on failure.
    .DESCRIPTION
        `$ErrorActionPreference = 'Stop'` does not stop a native executable that
        returns a non-zero EXIT CODE -- a failing pnpm returns 1 and the script
        sails on. Every external call goes through here so that cannot happen.

        The opposite trap is worse, and it bit us on a real VM. With
        `$ErrorActionPreference = 'Stop'` in force, `2>&1` turns anything a
        native command writes to STDERR into a terminating NativeCommandError,
        regardless of its exit code. npm writes `npm notice` to stderr on a
        perfectly successful install; Node writes DeprecationWarnings there too.
        Both were reported as fatal, so bootstrap.ps1 declared PM2 and
        `pnpm install` failed when both had in fact succeeded -- and the "error"
        shown to the operator was a harmless notice, which is about as
        misleading as a failure message can be.

        Success is therefore judged by EXIT CODE ONLY. stderr is captured for
        the message and is never, by itself, treated as failure.
    #>
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [string[]]$ArgumentList = @(),
        [string]$WorkingDirectory = $null,
        [string]$Context = $null,
        [switch]$PassThru
    )
    $previous = $null
    if ($WorkingDirectory) {
        $previous = (Get-Location).Path
        Set-Location -LiteralPath $WorkingDirectory
    }
    $previousEap = $ErrorActionPreference
    try {
        # Continue, not Stop: see the note above. A native command writing to
        # stderr must not abort the pipeline before we can read its exit code.
        $ErrorActionPreference = 'Continue'
        $output = & $FilePath @ArgumentList 2>&1 | Out-String
        $code = $LASTEXITCODE
        $ErrorActionPreference = $previousEap

        if ($code -ne 0) {
            $label = if ($Context) { $Context } else { "$FilePath $($ArgumentList -join ' ')" }
            # Show the TAIL of the output. The real error is at the end; the head
            # is npm's banner and assorted notices, which is exactly what made
            # the original failure message useless.
            # @() is load-bearing: Where-Object returns a SCALAR when exactly one
            # line survives, and a scalar string has no .Count -- so the error
            # path would itself throw, replacing a useful message with
            # "The property 'Count' cannot be found on this object."
            $lines = @(($output -split "`r?`n") | Where-Object { $_.Trim() })
            $tail = if ($lines.Count -gt 20) { $lines[-20..-1] -join "`n" } else { $lines -join "`n" }
            throw "$label failed with exit code $code`n$tail"
        }
        if ($PassThru) { return $output }
    } finally {
        $ErrorActionPreference = $previousEap
        if ($previous) { Set-Location -LiteralPath $previous }
    }
}

function Get-PnpmCommand {
    <#
    .SYNOPSIS
        Resolves pnpm, preferring the corepack shim, and returns its path.
    #>
    if (Test-CommandExists 'pnpm') { return (Get-Command 'pnpm').Source }
    if (Test-CommandExists 'corepack') {
        try {
            & corepack enable pnpm 2>&1 | Out-Null
            Update-SessionPath
            if (Test-CommandExists 'pnpm') { return (Get-Command 'pnpm').Source }
        } catch { }
    }
    return $null
}

function Get-PythonExe {
    <#
    .SYNOPSIS
        Absolute path to the engine virtualenv interpreter (may not exist yet).
    #>
    return (Get-BrandLensPath 'apps' 'engine' '.venv' 'Scripts' 'python.exe')
}

function Get-PsqlPath {
    <#
    .SYNOPSIS
        Finds psql.exe on PATH, or under the standard EnterpriseDB layout.
    #>
    if (Test-CommandExists 'psql') { return (Get-Command 'psql').Source }
    $candidates = Get-ChildItem 'C:\Program Files\PostgreSQL' -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending
    foreach ($dir in $candidates) {
        $candidate = Join-Path $dir.FullName 'bin\psql.exe'
        if (Test-Path $candidate) { return $candidate }
    }
    return $null
}

function Get-PgToolPath {
    <#
    .SYNOPSIS
        Finds any PostgreSQL bin tool (pg_dump, pg_restore, createdb, ...).
    #>
    param([Parameter(Mandatory)][string]$Tool)
    if (Test-CommandExists $Tool) { return (Get-Command $Tool).Source }
    $candidates = Get-ChildItem 'C:\Program Files\PostgreSQL' -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending
    foreach ($dir in $candidates) {
        $candidate = Join-Path $dir.FullName ("bin\{0}.exe" -f $Tool)
        if (Test-Path $candidate) { return $candidate }
    }
    return $null
}

function Get-Pm2Command {
    if (Test-CommandExists 'pm2') { return (Get-Command 'pm2').Source }
    return $null
}

function Assert-Pm2 {
    <#
    .SYNOPSIS
        Throws with an actionable message when PM2 is not installed.
    #>
    $pm2 = Get-Pm2Command
    if (-not $pm2) {
        Write-Fail 'PM2 is not installed or not on PATH.'
        Write-Hint @(
            'Install it with:  npm install -g pm2',
            'Then re-open PowerShell, or run infra\windows\bootstrap.ps1.'
        )
        throw 'pm2 not found'
    }
    return $pm2
}

function Get-EcosystemPath {
    return (Join-Path $PSScriptRoot 'ecosystem.config.cjs')
}

$BrandLensProcesses = @('brandlens-api', 'brandlens-worker', 'brandlens-web', 'brandlens-engine')
