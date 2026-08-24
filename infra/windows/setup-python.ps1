#Requires -Version 5.1
<#
.SYNOPSIS
    Creates the analysis engine's virtualenv and installs its dependencies.

.DESCRIPTION
    apps\engine is a Python FastAPI service. It runs from a virtualenv at
    apps\engine\.venv so that PM2 can be handed an absolute interpreter path
    and never has to care about the machine's PATH or about which Python
    happens to be first on it.

    Every dependency in requirements.txt resolves to a prebuilt win_amd64
    wheel -- nothing compiles, so no Visual C++ Build Tools are needed. If pip
    ever starts building from source on this machine, that is a bug in the
    pin, not something to fix by installing a compiler.

    Idempotent: an existing healthy venv is reused, and pip is re-run so a
    changed requirements.txt is picked up.

.PARAMETER Recreate
    Delete and rebuild the virtualenv. Use after a Python upgrade -- a venv
    keeps a hard reference to the interpreter that created it and silently
    breaks when that interpreter is replaced.

.PARAMETER Python
    Explicit interpreter to build the venv from (e.g. C:\Python311\python.exe).
    Default: the first `python` on PATH that is 3.11 or newer.

.PARAMETER IncludeDev
    Also install requirements-dev.txt (pytest, ruff, mypy).

.PARAMETER Offline
    Install from a local wheelhouse instead of PyPI. Combine with -WheelDir.

.PARAMETER WheelDir
    Directory of pre-downloaded wheels for -Offline. Default: infra\wheels.

.EXAMPLE
    .\setup-python.ps1

.EXAMPLE
    .\setup-python.ps1 -Recreate -IncludeDev

.EXAMPLE
    .\setup-python.ps1 -Offline -WheelDir D:\wheels
    Air-gapped install from a wheelhouse built with:
      pip download -r apps\engine\requirements.txt -d D:\wheels
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [switch]$Recreate,
    [string]$Python,
    [switch]$IncludeDev,
    [switch]$Offline,
    [string]$WheelDir
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')

Write-Banner 'BrandLens - python engine setup'

$engineDir = Get-BrandLensPath 'apps' 'engine'
$venvDir = Join-Path $engineDir '.venv'
$venvPython = Join-Path $venvDir 'Scripts\python.exe'
$requirements = Join-Path $engineDir 'requirements.txt'
$requirementsDev = Join-Path $engineDir 'requirements-dev.txt'

if (-not (Test-Path $requirements)) {
    Write-Fail "requirements.txt not found at $requirements"
    Write-Hint @('Are you running this from a complete checkout of the repository?')
    exit 1
}

# ---------------------------------------------------------------------------
# Base interpreter
# ---------------------------------------------------------------------------
Write-Step 'python'
if ($Python) {
    if (-not (Test-Path $Python)) {
        Write-Fail "no interpreter at $Python"
        exit 1
    }
    $basePython = $Python
} else {
    $candidates = @('python', 'python3', 'py')
    $basePython = $null
    foreach ($candidate in $candidates) {
        if (-not (Test-CommandExists $candidate)) { continue }
        $version = Get-CommandVersion -Command $candidate -Arguments @('--version')
        if ($version -and (Compare-Version $version '3.11.0')) {
            $basePython = (Get-Command $candidate).Source
            break
        }
    }
    if (-not $basePython) {
        Write-Fail 'no Python 3.11+ found on PATH'
        Write-Hint @(
            'Install it:  winget install Python.Python.3.11',
            'or download from https://www.python.org/downloads/windows/',
            'and tick "Add python.exe to PATH".',
            'Then open a NEW PowerShell window and re-run this script.'
        )
        exit 1
    }
}

$baseVersion = Get-CommandVersion -Command $basePython -Arguments @('--version')
Write-Ok "$baseVersion  ($basePython)"

# ---------------------------------------------------------------------------
# Architecture check -- a 32-bit interpreter cannot install the CV wheels.
# ---------------------------------------------------------------------------
Write-Step 'architecture'
$arch = (& $basePython -c "import struct,sys; print(struct.calcsize('P')*8)" 2>&1 | Out-String).Trim()
if ($arch -ne '64') {
    Write-Fail "this Python reports a $arch-bit build"
    Write-Hint @(
        'numpy, scipy, scikit-image and opencv publish no 32-bit Windows wheels,',
        'so pip would try to build them from source and fail.',
        'Install the 64-bit ("Windows installer (64-bit)") Python and re-run.'
    )
    exit 1
}
Write-Ok '64-bit'

# ---------------------------------------------------------------------------
# Virtualenv
# ---------------------------------------------------------------------------
if ($Recreate -and (Test-Path $venvDir)) {
    if ($PSCmdlet.ShouldProcess($venvDir, 'remove virtualenv')) {
        Write-Step 'remove venv'
        Remove-Item -LiteralPath $venvDir -Recurse -Force
        Write-Ok 'deleted'
    }
}

Write-Step 'virtualenv'
if (Test-Path $venvPython) {
    Write-Ok 'reusing apps\engine\.venv'
} elseif ($PSCmdlet.ShouldProcess($venvDir, 'python -m venv')) {
    try {
        Invoke-Checked -FilePath $basePython -ArgumentList @('-m', 'venv', $venvDir) -Context 'python -m venv'
    } catch {
        Write-Fail $_.Exception.Message
        Write-Hint @(
            'If venv is missing, the Python install was partial -- repair it via',
            'Settings > Apps > Python > Modify, and tick "pip" and "tcl/tk".',
            'If the path is very long, move the checkout nearer the drive root:',
            'the .venv adds ~120 characters and can trip MAX_PATH.'
        )
        exit 1
    }
    if (-not (Test-Path $venvPython)) {
        Write-Fail "venv created but $venvPython is missing"
        exit 1
    }
    Write-Ok 'created'
} else {
    Write-Skip 'would create'
    exit 0
}

# ---------------------------------------------------------------------------
# pip
# ---------------------------------------------------------------------------
Write-Step 'pip upgrade'
if ($PSCmdlet.ShouldProcess('pip', 'upgrade pip/setuptools/wheel')) {
    try {
        $pipArgs = @('-m', 'pip', 'install', '--upgrade', '--disable-pip-version-check', 'pip', 'setuptools', 'wheel')
        if ($Offline) { $pipArgs = @('-m', 'pip', 'install', '--upgrade', '--no-index', '--find-links', $WheelDir, 'pip') }
        Invoke-Checked -FilePath $venvPython -ArgumentList $pipArgs -Context 'pip upgrade'
        Write-Ok (Get-CommandVersion -Command $venvPython -Arguments @('-m', 'pip', '--version'))
    } catch {
        Write-Warn 'pip upgrade failed; continuing with the bundled pip'
    }
} else {
    Write-Skip 'would upgrade'
}

# ---------------------------------------------------------------------------
# Dependencies
# ---------------------------------------------------------------------------
if (-not $WheelDir) { $WheelDir = Get-BrandLensPath 'infra' 'wheels' }

function Install-Requirements {
    param([string]$File, [string]$Label)
    Write-Host ''
    Write-Host "  > pip install -r $Label" -ForegroundColor Cyan
    if (-not $PSCmdlet.ShouldProcess($Label, 'pip install -r')) {
        Write-Skip 'would install'
        return $true
    }
    $args = @('-m', 'pip', 'install', '--disable-pip-version-check', '-r', $File)
    if ($Offline) {
        if (-not (Test-Path $WheelDir)) {
            Write-Fail "-Offline was requested but $WheelDir does not exist"
            Write-Hint @(
                'Build a wheelhouse on a connected machine with the same Python version:',
                "  pip download -r $File -d $WheelDir"
            )
            return $false
        }
        $args += @('--no-index', '--find-links', $WheelDir)
    }
    try {
        Invoke-Checked -FilePath $venvPython -ArgumentList $args -Context "pip install -r $Label"
        Write-Ok "$Label installed"
        return $true
    } catch {
        Write-Fail $_.Exception.Message
        Write-Hint @(
            'If pip tried to BUILD a package rather than download a wheel, the pin no',
            'longer resolves to a win_amd64 wheel. Do not install a compiler -- pin the',
            'previous version instead and open an issue.',
            'Behind a corporate proxy, set:  $env:HTTPS_PROXY / $env:HTTP_PROXY',
            'or configure pip:  pip config set global.index-url <internal mirror>'
        )
        return $false
    }
}

if (-not (Install-Requirements -File $requirements -Label 'requirements.txt')) { exit 1 }

if ($IncludeDev -and (Test-Path $requirementsDev)) {
    if (-not (Install-Requirements -File $requirementsDev -Label 'requirements-dev.txt')) { exit 1 }
}

# ---------------------------------------------------------------------------
# Import verification -- the thing that actually proves the install works.
# A wheel can install cleanly and still fail to import (opencv missing a
# runtime DLL is the classic), and finding that out at the first check request
# is far worse than finding it out here.
# ---------------------------------------------------------------------------
Write-Host ''
Write-Step 'verify imports'

$probe = @'
import sys, importlib
mods = [
    "fastapi", "uvicorn", "pydantic", "pydantic_settings", "orjson", "httpx",
    "tenacity", "structlog", "numpy", "scipy", "skimage", "sklearn",
    "cv2", "PIL", "fitz", "pptx", "rapidfuzz", "textstat", "imagehash",
]
failed = []
for m in mods:
    try:
        importlib.import_module(m)
    except Exception as exc:
        failed.append(f"{m}: {type(exc).__name__}: {exc}")
if failed:
    print("FAILED")
    for f in failed:
        print("  " + f)
    sys.exit(1)
print("OK " + ".".join(str(x) for x in sys.version_info[:3]))
'@

if ($PSCmdlet.ShouldProcess('engine dependencies', 'import probe')) {
    $probeFile = Join-Path ([IO.Path]::GetTempPath()) ("brandlens-probe-{0}.py" -f ([guid]::NewGuid().ToString('N')))
    Set-Content -LiteralPath $probeFile -Value $probe -Encoding UTF8
    try {
        $result = & $venvPython $probeFile 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) {
            Write-Fail 'one or more dependencies failed to import'
            Write-Host $result.TrimEnd() -ForegroundColor Red
            Write-Hint @(
                'cv2 failing with an ImportError about a DLL usually means the',
                'Microsoft Visual C++ 2015-2022 Redistributable (x64) is missing:',
                '  winget install Microsoft.VCRedist.2015+.x64'
            )
            exit 1
        }
        Write-Ok $result.Trim()
    } finally {
        Remove-Item -LiteralPath $probeFile -Force -ErrorAction SilentlyContinue
    }
}

# ---------------------------------------------------------------------------
# App import -- catches a broken engine package, not just broken dependencies.
# ---------------------------------------------------------------------------
Write-Step 'verify engine'
if ($PSCmdlet.ShouldProcess('brandlens_engine', 'import probe')) {
    $previous = (Get-Location).Path
    Set-Location -LiteralPath $engineDir
    try {
        $out = & $venvPython -c "from brandlens_engine import ENGINE_VERSION, PIPELINE_VERSION; print(f'engine {ENGINE_VERSION}, pipeline {PIPELINE_VERSION}')" 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) {
            Write-Fail 'brandlens_engine could not be imported'
            Write-Host $out.TrimEnd() -ForegroundColor Red
            exit 1
        }
        Write-Ok $out.Trim()
    } finally {
        Set-Location -LiteralPath $previous
    }
}

# ---------------------------------------------------------------------------
# Report the interpreter path PM2 needs.
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host '  Python engine ready.' -ForegroundColor Green
Write-Host ''
Write-Host '  Interpreter (this is what ecosystem.config.cjs resolves):' -ForegroundColor Cyan
Write-Host "    $venvPython"
Write-Host ''
Write-Host '  Run it directly for a smoke test:' -ForegroundColor Cyan
Write-Host "    cd `"$engineDir`""
Write-Host "    .\.venv\Scripts\python.exe -m uvicorn brandlens_engine.main:app --port 8000"
Write-Host ''
Write-Host '  Next:  .\infra\windows\install-services.ps1' -ForegroundColor Cyan
Write-Host ''
exit 0
