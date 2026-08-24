#Requires -Version 5.1
<#
.SYNOPSIS
    Tails or searches the BrandLens logs.

.DESCRIPTION
    Two sources, one command:

      * PM2's live stream (`pm2 logs`) when following, which interleaves every
        process with a name prefix;
      * the files under logs\ when reading history or grepping, because PM2's
        stream only starts from now.

    All four services log JSON lines (pino for Node, structlog for Python), so
    -Grep is a plain substring match over the raw line -- good enough for a
    correlation id, a rule key or a check-run uuid, which is what you are
    usually looking for.

.PARAMETER Process
    api | worker | web | engine | all.  Default: all.

.PARAMETER Lines
    How many lines of history to show. Default: 100.

.PARAMETER Follow
    Stream new output (Ctrl-C to stop).

.PARAMETER Errors
    Only the *-error.log files / PM2's error stream.

.PARAMETER Grep
    Case-insensitive substring filter. Implies file mode.

.PARAMETER Since
    Only lines whose file was modified after this time, e.g. '-2h', '09:00'.
    Coarse by design: it filters files, not lines.

.PARAMETER Path
    Print the log directory and exit.

.EXAMPLE
    .\logs.ps1 -Follow

.EXAMPLE
    .\logs.ps1 -Process worker -Lines 400 -Errors

.EXAMPLE
    .\logs.ps1 -Grep 3f2b9c1e-0a44-4d2f-9a7e-1b6c5d8e2f01
    Find every line mentioning a check run id across all four services.
#>
[CmdletBinding()]
param(
    [ValidateSet('api', 'worker', 'web', 'engine', 'all')]
    [string]$Process = 'all',
    [int]$Lines = 100,
    [switch]$Follow,
    [switch]$Errors,
    [string]$Grep,
    [string]$Since,
    [switch]$Path
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')

$logDir = Get-BrandLensPath 'logs'

if ($Path) {
    Write-Host $logDir
    exit 0
}

Write-Banner 'BrandLens - logs' $logDir

if (-not (Test-Path $logDir)) {
    Write-Warn "no log directory at $logDir"
    Write-Hint @('Logs appear once the processes have started:  .\infra\windows\start-all.ps1')
    exit 1
}

# ---------------------------------------------------------------------------
# Live stream via PM2
# ---------------------------------------------------------------------------
if ($Follow -and -not $Grep) {
    $pm2 = Get-Pm2Command
    if ($pm2) {
        $args = @('logs', '--lines', [string]$Lines)
        if ($Process -ne 'all') { $args = @('logs', "brandlens-$Process", '--lines', [string]$Lines) }
        if ($Errors) { $args += '--err' }
        Write-Info 'streaming via pm2 -- Ctrl-C to stop'
        Write-Host ''
        & $pm2 @args
        exit 0
    }
    Write-Warn 'pm2 not found -- falling back to file tailing'
}

# ---------------------------------------------------------------------------
# Files
# ---------------------------------------------------------------------------
$names = if ($Process -eq 'all') { @('api', 'worker', 'web', 'engine') } else { @($Process) }
$suffixes = if ($Errors) { @('error') } else { @('out', 'error') }

$files = @()
foreach ($name in $names) {
    foreach ($suffix in $suffixes) {
        $file = Join-Path $logDir "$name-$suffix.log"
        if (Test-Path $file) { $files += Get-Item $file }
    }
}

if ($Since) {
    $cutoff = $null
    if ($Since -match '^-(\d+)([hmd])$') {
        $n = [int]$Matches[1]
        $cutoff = switch ($Matches[2]) {
            'm' { (Get-Date).AddMinutes(-$n) }
            'h' { (Get-Date).AddHours(-$n) }
            'd' { (Get-Date).AddDays(-$n) }
        }
    } else {
        try { $cutoff = [datetime]::Parse($Since) } catch {
            Write-Warn "could not parse -Since '$Since'; ignoring"
        }
    }
    if ($cutoff) { $files = @($files | Where-Object { $_.LastWriteTime -ge $cutoff }) }
}

if ($files.Count -eq 0) {
    Write-Warn 'no matching log files'
    Write-Info "looked in $logDir for: $(($names | ForEach-Object { "$_-*.log" }) -join ', ')"
    exit 1
}

foreach ($file in $files) {
    Write-Host ''
    Write-Host "  === $($file.Name)  ($([math]::Round($file.Length / 1KB, 1)) KB, modified $($file.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'))) ===" -ForegroundColor Cyan

    if ($Follow) {
        Get-Content -LiteralPath $file.FullName -Tail $Lines -Wait
        continue
    }

    $content = Get-Content -LiteralPath $file.FullName -Tail $Lines
    if ($Grep) {
        $content = $content | Where-Object { $_ -like "*$Grep*" }
        if (-not $content) {
            Write-Info "(no match for '$Grep')"
            continue
        }
    }
    foreach ($line in $content) {
        # Colour the obvious severities so a wall of JSON is still scannable.
        if ($line -match '"level":\s*(50|60)|"level":\s*"(error|critical)"|ERROR|CRITICAL') {
            Write-Host $line -ForegroundColor Red
        } elseif ($line -match '"level":\s*40|"level":\s*"warning"|WARN') {
            Write-Host $line -ForegroundColor Yellow
        } else {
            Write-Host $line
        }
    }
}

Write-Host ''
Write-Host '  Tips' -ForegroundColor Cyan
Write-Host '    .\logs.ps1 -Follow                     live stream, all processes'
Write-Host '    .\logs.ps1 -Process engine -Errors     engine stack traces only'
Write-Host '    .\logs.ps1 -Grep <correlation-id>      trace one request end to end'
Write-Host '    pm2 flush                              truncate every log file'
Write-Host ''
exit 0
