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
    Docker       (Docker.DockerDesktop) — local sandbox runner
    .NET 8 SDK   (Microsoft.DotNet.SDK.8) — C# / WPF project runner
    Rust         (Rustlang.Rustup) — gives rustc, cargo, rustfmt
    Python 3.13  (Python.Python.3.13)
    LLVM         (LLVM.LLVM) — gives clang, clang-format, clangd
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

function Test-DockerReady {
    if (-not (Test-Tool 'docker')) {
        return $false
    }
    & docker info *> $null
    return $LASTEXITCODE -eq 0
}

function Test-DotnetSdkAtLeast {
    param([int]$Major)
    if (-not (Test-Tool 'dotnet')) {
        return $false
    }
    $sdks = & dotnet --list-sdks 2>$null
    foreach ($sdk in $sdks) {
        if ($sdk -match '^(\d+)\.') {
            if ([int]$Matches[1] -ge $Major) {
                return $true
            }
        }
    }
    return $false
}

function Find-LlvmBin {
    $candidates = @(
        "$env:ProgramFiles\LLVM\bin",
        "${env:ProgramFiles(x86)}\LLVM\bin",
        "$env:LOCALAPPDATA\Programs\LLVM\bin"
    )
    foreach ($c in $candidates) {
        if ($c -and (Test-Path (Join-Path $c 'clang.exe'))) {
            return $c
        }
    }
    return $null
}

function Add-DirectoryToUserPath {
    param([string]$Directory)
    if (-not (Test-Path $Directory)) { return }
    $current = [System.Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not [string]::IsNullOrEmpty($current) -and ";$current;" -like "*;$Directory;*") {
        # Already on persistent user PATH; just make sure session sees it too.
        if (";$env:Path;" -notlike "*;$Directory;*") {
            $env:Path = "$Directory;$env:Path"
        }
        return
    }
    $new = if ([string]::IsNullOrEmpty($current)) { $Directory } else { "$Directory;$current" }
    [System.Environment]::SetEnvironmentVariable('Path', $new, 'User')
    $env:Path = "$Directory;$env:Path"
}

function Test-WingetExitOk {
    param([int]$ExitCode)
    # Winget exit codes that mean "the package is already at the desired state" — not a real failure.
    #   0x8A15002B  APPINSTALLER_CLI_ERROR_UPDATE_NOT_APPLICABLE   (already installed, no upgrade available)
    #   0x8A150109  APPINSTALLER_CLI_ERROR_PACKAGE_ALREADY_INSTALLED
    return $ExitCode -eq 0 -or $ExitCode -in @(-1978335189, -1978334967)
}

function Install-WingetPackage {
    param(
        [string]$Id,
        [string]$DisplayName
    )
    Write-Host "    installing $DisplayName via winget..."
    # --disable-interactivity stops winget from drawing the spinner, which gets
    # mangled into a column of stray characters when its output is piped through
    # PowerShell.
    $wingetArgs = @(
        'install',
        '--id', $Id,
        '--silent',
        '--disable-interactivity',
        '--accept-source-agreements',
        '--accept-package-agreements',
        '--scope', 'user'
    )
    & winget @wingetArgs
    if (-not (Test-WingetExitOk $LASTEXITCODE)) {
        # Some packages don't support --scope user — retry without it.
        Write-Warn-Local "user-scope install failed, retrying without --scope..."
        $wingetArgs = @(
            'install',
            '--id', $Id,
            '--silent',
            '--disable-interactivity',
            '--accept-source-agreements',
            '--accept-package-agreements'
        )
        & winget @wingetArgs
        if (-not (Test-WingetExitOk $LASTEXITCODE)) {
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

    Write-Step "Docker Desktop (local sandbox)"
    if (Test-Tool 'docker') {
        Write-Skip "$((& docker --version)) already installed"
    } else {
        Install-WingetPackage -Id 'Docker.DockerDesktop' -DisplayName 'Docker Desktop'
    }
    if (Test-Tool 'docker') {
        Write-Ok "$((& docker --version))"
    } else {
        Write-Warn-Local "docker still not on PATH — local code Run will be disabled until Docker Desktop is installed."
    }
    if (-not (Test-DockerReady)) {
        Write-Warn-Local "Docker engine is not reachable. Start Docker Desktop after setup, then run .\lt.ps1 toolchain."
    }

    Write-Step ".NET SDK 8+ (C# / WPF project runner)"
    if (Test-DotnetSdkAtLeast -Major 8) {
        Write-Skip "dotnet SDK already installed: $((& dotnet --list-sdks | Select-Object -First 1))"
    } else {
        Install-WingetPackage -Id 'Microsoft.DotNet.SDK.8' -DisplayName '.NET SDK 8'
    }
    if (Test-DotnetSdkAtLeast -Major 8) {
        Write-Ok "dotnet SDK available: $((& dotnet --list-sdks | Select-Object -First 1))"
    } else {
        Write-Warn-Local "dotnet SDK 8+ still not on PATH — C# WPF Run will be disabled until the SDK is installed."
    }

    Write-Step "Rust (rustc + cargo + rustfmt + rust-analyzer)"
    if ((Test-Tool 'rustc') -and (Test-Tool 'rustfmt') -and (Test-Tool 'rust-analyzer')) {
        Write-Skip "rustc $((& rustc --version)) already installed"
    } else {
        if (-not ((Test-Tool 'rustc') -and (Test-Tool 'rustfmt'))) {
            Install-WingetPackage -Id 'Rustlang.Rustup' -DisplayName 'Rust (rustup)'
        }
        # rustup ships rustc/cargo/rustfmt in the default toolchain.
        # rust-analyzer is a separate component — install it idempotently for LSP-driven tutoring.
        if (Test-Tool 'rustup') {
            & rustup default stable | Out-Host
            & rustup component add rustfmt | Out-Host
            & rustup component add rust-analyzer | Out-Host
            Refresh-Path
        }
    }
    if (Test-Tool 'rustc') {
        Write-Ok "rustc $((& rustc --version))"
    } else {
        Write-Warn-Local "rustc still not on PATH — live Rust checking will be disabled."
    }
    if (Test-Tool 'rust-analyzer') {
        Write-Ok "rust-analyzer $((& rust-analyzer --version))"
    } else {
        Write-Warn-Local "rust-analyzer still not on PATH — LSP-based Rust tutoring will be disabled (fall-soft to rustc --error-format=json)."
    }

    Write-Step "Python 3.13"
    if (Test-Tool 'python') {
        $pyVer = (& python --version) 2>&1
        Write-Skip "$pyVer already installed"
    } elseif (Test-Tool 'py') {
        Write-Skip "py launcher already installed: $((& py --version) 2>&1)"
    } else {
        Install-WingetPackage -Id 'Python.Python.3.13' -DisplayName 'Python 3.13'
    }

    Write-Step "LLVM (clang + clang-format)"
    # Probe disk first — if a prior install left LLVM at any known path, just
    # ensure it's on user PATH (idempotent) and skip the winget install. The
    # LLVM.LLVM winget package installs to C:\Program Files\LLVM by default
    # but doesn't update PATH, so the disk probe must run regardless of PATH.
    $llvmBin = Find-LlvmBin
    if ($null -eq $llvmBin -and -not (Test-Tool 'clang')) {
        Install-WingetPackage -Id 'LLVM.LLVM' -DisplayName 'LLVM'
        $llvmBin = Find-LlvmBin
        if ($null -eq $llvmBin) {
            # winget reported success but no clang.exe at known paths — almost
            # always a stale uninstall registry entry from a prior manual install
            # making winget treat the package as already installed.
            Write-Warn-Local "winget reported LLVM installed but no clang.exe found at known paths."
            Write-Warn-Local "This usually means a stale registry entry is shadowing the install. To clean:"
            Write-Warn-Local "  Remove-Item 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\LLVM' -Recurse -Force"
            Write-Warn-Local "Then re-run this script."
        }
    }
    if ($null -ne $llvmBin) {
        Add-DirectoryToUserPath -Directory $llvmBin
    }
    if (Test-Tool 'clang') {
        Write-Ok "clang $((& clang --version | Select-Object -First 1))"
    } else {
        Write-Warn-Local "clang still not on PATH — live C++ checking will be disabled."
    }
    if (Test-Tool 'clangd') {
        Write-Ok "clangd $((& clangd --version | Select-Object -First 1))"
    } else {
        Write-Warn-Local "clangd still not on PATH — LSP-based C++ tutoring will be disabled (fall-soft to clang -fsyntax-only)."
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

    Write-Step "typescript-language-server (Web LSP — primary)"
    if (Test-Tool 'typescript-language-server') {
        Write-Skip "typescript-language-server already installed"
    } else {
        Write-Host "    npm install -g typescript-language-server typescript ..."
        & npm install -g typescript-language-server typescript --silent | Out-Host
        Refresh-Path
        if (Test-Tool 'typescript-language-server') {
            Write-Ok "typescript-language-server installed"
        } else {
            Write-Warn-Local "typescript-language-server not on PATH after install — LSP-based Web tutoring will be disabled."
        }
    }

    Write-Step "vscode-langservers-extracted (Web LSP — HTML + CSS)"
    # Bundles vscode-html-language-server, vscode-css-language-server, and a
    # few others; the bridge spawns the HTML and CSS shims for .html / .css
    # files in projects/web/. Falls soft per-server when not on PATH.
    if ((Test-Tool 'vscode-html-language-server') -and (Test-Tool 'vscode-css-language-server')) {
        Write-Skip "vscode-html-language-server + vscode-css-language-server already installed"
    } else {
        Write-Host "    npm install -g vscode-langservers-extracted ..."
        & npm install -g vscode-langservers-extracted --silent | Out-Host
        Refresh-Path
        if ((Test-Tool 'vscode-html-language-server') -and (Test-Tool 'vscode-css-language-server')) {
            Write-Ok "vscode-langservers-extracted installed"
        } else {
            Write-Warn-Local "html / css language servers not on PATH after install — HTML / CSS LSP for web will be disabled."
        }
    }

    Write-Step "biome (Web LSP — fast lint via lsp-proxy)"
    # Biome's LSP runs alongside tsserver to provide faster lint diagnostics
    # than vite-plugin-checker can give us (which runs in a worker on the dev
    # server). The CLI is `biome` from @biomejs/biome.
    if (Test-Tool 'biome') {
        Write-Skip "biome already installed"
    } else {
        Write-Host "    npm install -g @biomejs/biome ..."
        & npm install -g @biomejs/biome --silent | Out-Host
        Refresh-Path
        if (Test-Tool 'biome') {
            Write-Ok "biome installed"
        } else {
            Write-Warn-Local "biome not on PATH after install — Biome LSP fan-out for web will be disabled (vite-plugin-checker still covers it from [SERVER])."
        }
    }

    Write-Step "OmniSharp (C# LSP) — optional"
    if (Test-Tool 'omnisharp') {
        Write-Skip "omnisharp already installed"
    } else {
        # OmniSharp doesn't have a stable winget id and the official install is
        # a binary download from GitHub releases. We don't auto-install — log a
        # hint instead so the user can grab it deliberately. Without it the C#
        # tutor falls back to dotnet build feedback in [OUTPUT].
        Write-Warn-Local "omnisharp not on PATH — LSP-based C# tutoring will be disabled."
        Write-Warn-Local "  Install: scoop install omnisharp  OR  choco install omnisharp"
        Write-Warn-Local "  Or download a release from https://github.com/OmniSharp/omnisharp-roslyn/releases"
    }

    Write-Step "basedpyright (Python LSP)"
    if ($null -eq $py) {
        Write-Warn-Local "Python not found, skipping basedpyright."
    } elseif (Test-Tool 'basedpyright-langserver') {
        Write-Skip "basedpyright already installed"
    } else {
        Write-Host "    pip install --user basedpyright ..."
        & $py -m pip install --user --quiet basedpyright | Out-Host
        Refresh-Path
        if (Test-Tool 'basedpyright-langserver') {
            Write-Ok "basedpyright installed"
        } else {
            Write-Warn-Local "basedpyright-langserver not on PATH after install — LSP-based Python tutoring will be disabled (fall-soft to ast.parse)."
        }
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

# ── Phase 2.5: local sandbox image ─────────────────────────────────────────
Write-Step "Building local sandbox image"
$toolchainScript = Join-Path $repoRoot 'scripts\build-toolchain-image.ps1'
if (Test-DockerReady) {
    & $toolchainScript | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "toolchain image build failed (exit $LASTEXITCODE)" }
} else {
    Write-Warn-Local "Skipping image build because Docker Desktop is not running."
    Write-Warn-Local "Start Docker Desktop, then run .\lt.ps1 toolchain before using Run for Rust/C++/Python or C# console snippets."
}

# ── Phase 3: optional .env bootstrap ────────────────────────────────────────
Write-Step "Checking optional .env"
$envPath = Join-Path $repoRoot '.env'
$envExamplePath = Join-Path $repoRoot '.env.example'
if (-not (Test-Path $envPath)) {
    if (Test-Path $envExamplePath) {
        Copy-Item $envExamplePath $envPath
        Write-Host "    Created .env from .env.example. Provider API keys are configured in the browser UI." -ForegroundColor Yellow
    } else {
        Write-Warn-Local ".env.example missing — continuing without .env."
    }
}
Write-Ok ".env check complete"

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

$null = $proc.Start()

# Forward stdout/stderr to console AND tee into the log file so the polling
# loop below can detect the "Local: <url>" line Vite prints when ready.
# Pass the log path via -MessageData; Register-ObjectEvent scriptblocks run
# in their own scope and can't capture parent variables ($using: doesn't apply).
Register-ObjectEvent -InputObject $proc -EventName OutputDataReceived `
    -SourceIdentifier 'ViteStdout' -MessageData $logFile -Action {
    $line = $EventArgs.Data
    if ($null -ne $line) {
        Write-Host $line
        try { Add-Content -Path $Event.MessageData -Value $line -ErrorAction Stop } catch { }
    }
} | Out-Null
Register-ObjectEvent -InputObject $proc -EventName ErrorDataReceived `
    -SourceIdentifier 'ViteStderr' -MessageData $logFile -Action {
    $line = $EventArgs.Data
    if ($null -ne $line) {
        Write-Host $line -ForegroundColor DarkGray
        try { Add-Content -Path $Event.MessageData -Value $line -ErrorAction Stop } catch { }
    }
} | Out-Null

$proc.BeginOutputReadLine()
$proc.BeginErrorReadLine()

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
