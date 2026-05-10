<#
.SYNOPSIS
  One-shot setup for the Lang tutor app on Windows: installs all runtimes,
  fetches dependencies, and opens the dev server in your browser.

.DESCRIPTION
  Idempotent — safe to re-run. Each runtime is detected first; only missing
  ones get installed. Uses winget with --scope user so admin isn't required.

  Tools installed if missing:
    Node 20 LTS  (OpenJS.NodeJS.LTS)
    pnpm         (pnpm.pnpm)
    Rust         (Rustlang.Rustup) — gives rustc, cargo, rustfmt
    Python 3.12  (Python.Python.3.12)
    LLVM         (LLVM.LLVM) — gives clang, clang-format
    black        (pip install --user)

.PARAMETER NoBrowser
  Skip the browser launch at the end. Useful for headless / CI runs.

.PARAMETER SkipInstall
  Skip the runtime install phase entirely. Goes straight to pnpm install + dev server.

.EXAMPLE
  .\scripts\setup.ps1
  .\scripts\setup.ps1 -NoBrowser
#>

[CmdletBinding()]
param(
    [switch]$NoBrowser,
    [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Ok {
    param([string]$Message)
    Write-Host "    OK  $Message" -ForegroundColor Green
}

function Write-Skip {
    param([string]$Message)
    Write-Host "    --  $Message" -ForegroundColor DarkGray
}

function Write-Warn-Local {
    param([string]$Message)
    Write-Host "    !!  $Message" -ForegroundColor Yellow
}

function Refresh-Path {
    $machine = [System.Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user    = [System.Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machine;$user"
}

function Test-Tool {
    param([string]$Name)
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Install-WingetPackage {
    param(
        [string]$Id,
        [string]$DisplayName
    )
    Write-Host "    installing $DisplayName via winget..."
    $args = @(
        'install',
        '--id', $Id,
        '--silent',
        '--accept-source-agreements',
        '--accept-package-agreements',
        '--scope', 'user'
    )
    & winget @args | Out-Host
    if ($LASTEXITCODE -ne 0) {
        # Some packages don't support --scope user — retry without it.
        Write-Warn-Local "user-scope install failed, retrying without --scope..."
        $args = @(
            'install',
            '--id', $Id,
            '--silent',
            '--accept-source-agreements',
            '--accept-package-agreements'
        )
        & winget @args | Out-Host
        if ($LASTEXITCODE -ne 0) {
            throw "winget install failed for $Id (exit $LASTEXITCODE)"
        }
    }
    Refresh-Path
}

# ── Banner ──────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "Lang tutor setup" -ForegroundColor White
Write-Host "----------------" -ForegroundColor White

# ── Phase 1: install runtimes ───────────────────────────────────────────────
if (-not $SkipInstall) {
    Write-Step "Checking winget"
    if (-not (Test-Tool 'winget')) {
        Write-Error "winget not found. Install 'App Installer' from the Microsoft Store, then re-run this script."
        Write-Host  "https://apps.microsoft.com/detail/9NBLGGH4NNS1"
        exit 1
    }
    Write-Ok "winget available"

    Write-Step "Node.js (>= 20 LTS)"
    if (Test-Tool 'node') {
        $nodeVer = (& node --version) -replace '^v', ''
        $major = [int]($nodeVer.Split('.')[0])
        if ($major -ge 20) {
            Write-Skip "node $nodeVer already installed"
        } else {
            Write-Warn-Local "node $nodeVer is too old, upgrading..."
            Install-WingetPackage -Id 'OpenJS.NodeJS.LTS' -DisplayName 'Node.js LTS'
        }
    } else {
        Install-WingetPackage -Id 'OpenJS.NodeJS.LTS' -DisplayName 'Node.js LTS'
    }
    if (-not (Test-Tool 'node')) {
        Write-Error "node still not on PATH after install. Open a new shell and re-run."
        exit 1
    }
    Write-Ok "node $((& node --version))"

    Write-Step "pnpm"
    if (Test-Tool 'pnpm') {
        Write-Skip "pnpm $((& pnpm --version)) already installed"
    } elseif (Test-Tool 'corepack') {
        Write-Host "    enabling pnpm via corepack..."
        & corepack enable pnpm | Out-Host
        Refresh-Path
        if (-not (Test-Tool 'pnpm')) {
            Install-WingetPackage -Id 'pnpm.pnpm' -DisplayName 'pnpm'
        }
    } else {
        Install-WingetPackage -Id 'pnpm.pnpm' -DisplayName 'pnpm'
    }
    Write-Ok "pnpm $((& pnpm --version))"

    Write-Step "Rust (rustc + cargo + rustfmt)"
    if ((Test-Tool 'rustc') -and (Test-Tool 'rustfmt')) {
        Write-Skip "rustc $((& rustc --version)) already installed"
    } else {
        Install-WingetPackage -Id 'Rustlang.Rustup' -DisplayName 'Rust (rustup)'
        # rustup ships rustc/cargo/rustfmt in the default toolchain
        if (Test-Tool 'rustup') {
            & rustup default stable | Out-Host
            & rustup component add rustfmt | Out-Host
            Refresh-Path
        }
    }
    if (Test-Tool 'rustc') {
        Write-Ok "rustc $((& rustc --version))"
    } else {
        Write-Warn-Local "rustc still not on PATH — live Rust checking will be disabled."
    }

    Write-Step "Python 3.12"
    if (Test-Tool 'python') {
        $pyVer = (& python --version) 2>&1
        Write-Skip "$pyVer already installed"
    } elseif (Test-Tool 'py') {
        Write-Skip "py launcher already installed: $((& py --version) 2>&1)"
    } else {
        Install-WingetPackage -Id 'Python.Python.3.12' -DisplayName 'Python 3.12'
    }

    Write-Step "LLVM (clang + clang-format)"
    if ((Test-Tool 'clang') -and (Test-Tool 'clang-format')) {
        Write-Skip "clang $((& clang --version | Select-Object -First 1)) already installed"
    } else {
        Install-WingetPackage -Id 'LLVM.LLVM' -DisplayName 'LLVM'
    }
    if (-not (Test-Tool 'clang')) {
        Write-Warn-Local "clang still not on PATH — live C++ checking will be disabled."
    }

    Write-Step "black (Python formatter)"
    $py = if (Test-Tool 'python') { 'python' } elseif (Test-Tool 'py') { 'py' } else { $null }
    if ($null -eq $py) {
        Write-Warn-Local "Python not found, skipping black."
    } elseif (Test-Tool 'black') {
        Write-Skip "black already installed"
    } else {
        Write-Host "    pip install --user black ..."
        & $py -m pip install --user --quiet black | Out-Host
        Refresh-Path
        if (Test-Tool 'black') { Write-Ok "black installed" } else { Write-Warn-Local "black not on PATH after install — Python formatting will be disabled." }
    }
} else {
    Write-Step "Skipping runtime install (--SkipInstall)"
}

# ── Phase 2: pnpm install ───────────────────────────────────────────────────
Write-Step "Installing npm dependencies"
Push-Location $repoRoot
try {
    & pnpm install | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "pnpm install failed (exit $LASTEXITCODE)" }
} finally {
    Pop-Location
}
Write-Ok "dependencies installed"

# ── Phase 3: .env check ─────────────────────────────────────────────────────
Write-Step "Checking .env"
$envPath = Join-Path $repoRoot '.env'
$envExamplePath = Join-Path $repoRoot '.env.example'
if (-not (Test-Path $envPath)) {
    if (Test-Path $envExamplePath) {
        Copy-Item $envExamplePath $envPath
        Write-Host ""
        Write-Host "    Created .env from .env.example." -ForegroundColor Yellow
        Write-Host "    Open .env and set ANTHROPIC_API_KEY=sk-ant-... before re-running." -ForegroundColor Yellow
        Write-Host ""
        Start-Process notepad.exe $envPath
        exit 0
    } else {
        Write-Error ".env.example missing — can't bootstrap .env"
        exit 1
    }
}

# Crude check for an unset key.
$envContent = Get-Content $envPath -Raw
if ($envContent -match '(?m)^\s*ANTHROPIC_API_KEY\s*=\s*$' -or
    $envContent -match '(?m)^\s*ANTHROPIC_API_KEY\s*=\s*sk-ant-\.\.\.\s*$' -or
    $envContent -notmatch '(?m)^\s*ANTHROPIC_API_KEY\s*=\s*\S+') {
    Write-Warn-Local ".env has no ANTHROPIC_API_KEY set. Open .env, paste your key, and re-run."
    Start-Process notepad.exe $envPath
    exit 0
}
Write-Ok ".env has ANTHROPIC_API_KEY"

# ── Phase 4: launch dev server ──────────────────────────────────────────────
Write-Step "Starting Vite dev server"
$viteBin = Join-Path $repoRoot 'node_modules/vite/bin/vite.js'
if (-not (Test-Path $viteBin)) {
    Write-Error "Vite not found at $viteBin. Did pnpm install succeed?"
    exit 1
}

# Spawn node directly (no pnpm.cmd wrapper → clean Ctrl+C, no batch prompt).
$logFile = Join-Path $repoRoot '.tmp\vite-startup.log'
New-Item -ItemType Directory -Force -Path (Split-Path $logFile) | Out-Null
'' | Set-Content $logFile

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'node'
$psi.Arguments = "`"$viteBin`""
$psi.WorkingDirectory = $repoRoot
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.CreateNoWindow = $false

$proc = New-Object System.Diagnostics.Process
$proc.StartInfo = $psi

# Forward output to console AND capture to a buffer until we see "Local:".
$ready = $false
$serverUrl = $null
$mutex = New-Object System.Object

$outHandler = {
    param($sender, $eventArgs)
    if ($null -eq $eventArgs.Data) { return }
    $line = $eventArgs.Data
    Write-Host $line
    Add-Content -Path $using:logFile -Value $line
    if (-not $using:ready -and $line -match 'Local:\s+(https?://\S+)') {
        $script:serverUrl = $Matches[1].TrimEnd('/')
        $script:ready = $true
    }
}

# We can't share state into Register-ObjectEvent's scriptblock easily; poll the log instead.
$null = $proc.Start()
$proc.BeginOutputReadLine()
$proc.BeginErrorReadLine()

Register-ObjectEvent -InputObject $proc -EventName OutputDataReceived -Action {
    $line = $EventArgs.Data
    if ($null -ne $line) { Write-Host $line }
} | Out-Null
Register-ObjectEvent -InputObject $proc -EventName ErrorDataReceived -Action {
    $line = $EventArgs.Data
    if ($null -ne $line) { Write-Host $line -ForegroundColor DarkGray }
} | Out-Null

Write-Host ""
Write-Host "    waiting for dev server to come up..." -ForegroundColor DarkGray
$deadline = (Get-Date).AddSeconds(30)
$serverUrl = $null
while ((Get-Date) -lt $deadline -and -not $proc.HasExited) {
    Start-Sleep -Milliseconds 200
    if (Test-Path $logFile) {
        $log = Get-Content $logFile -Raw -ErrorAction SilentlyContinue
        if ($log -match 'Local:\s+(https?://\S+)') {
            $serverUrl = $Matches[1].TrimEnd('/')
            break
        }
    }
}

if ($proc.HasExited) {
    Write-Error "Vite exited before becoming ready (exit $($proc.ExitCode))."
    exit $proc.ExitCode
}

if ($null -eq $serverUrl) {
    Write-Warn-Local "Couldn't detect dev-server URL within 30s. Defaulting to http://localhost:5173"
    $serverUrl = 'http://localhost:5173'
}

Write-Host ""
Write-Ok "dev server ready at $serverUrl"

if (-not $NoBrowser) {
    Write-Host "    opening browser..."
    Start-Process $serverUrl
}

Write-Host ""
Write-Host "Ctrl+C to stop the dev server." -ForegroundColor White

try {
    $proc.WaitForExit()
} finally {
    if (-not $proc.HasExited) {
        $proc.Kill()
    }
    Get-EventSubscriber | Unregister-Event -ErrorAction SilentlyContinue
}
