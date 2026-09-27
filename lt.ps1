#Requires -Version 7.0
<#
.SYNOPSIS
    Lang tutor helper: install, dev server, build, on-demand launch/stop of the
    app, preview, type-check, lint, format, clean, and first-time setup.

.DESCRIPTION
    Subcommands:

      dev        Prepare generated assets, then run Vite via Node directly.
                 This is the default when no subcommand is given. Extra
                 arguments are forwarded to Vite.
      launch     Start the app in the background for everyday use: pnpm install
                 if node_modules is missing, build if dist/ is older than its
                 sources, start Docker Desktop and build the toolchain image if
                 needed, run server.mjs hidden (logs in .tmp/serve*.log), wait
                 until it answers, then open the browser. Prints one line when
                 the readiness report finds capabilities missing.
      stop       Stop what launch started, including every process it spawned
                 (project dev servers, LSPs). With -Docker, also quit Docker Desktop.
      status     Show whether the launched app and the Docker engine are running.
      serve      Run the production Node server in the foreground with
                 --env-file=.env. Extra arguments are forwarded to server.mjs.
      build      Prepare generated assets, run tsc --noEmit, then Vite build.
      preview    Run vite preview via Node directly.
      typecheck  Run tsc --noEmit.
      lint       Run biome check --write .
      format     Run biome format --write .
      toolchain  Build the local Docker sandbox image for Rust/C++/DASM/Python/C# snippets.
      install    Run pnpm install.
      doctor     Print the readiness report: every runtime, host checker and
                 language server, what it enables, and the fix for what is
                 missing. Installs nothing; exits 1 when anything is missing.
                 --json prints the report as JSON.
      setup      Run scripts/setup.ps1: install what the readiness report finds
                 missing, then print the report again.
      clean      Remove generated build output.
      help       Print the subcommand summary.

.PARAMETER Command
    The subcommand to run. When omitted, defaults to dev.

.PARAMETER Port
    Applies to launch. The port server.mjs listens on; overrides PORT in .env.

.PARAMETER NoBrowser
    Applies to launch. Do not open the browser.

.PARAMETER Docker
    Applies to stop. Also quit Docker Desktop after stopping the app.

.EXAMPLE
    .\lt.ps1
    .\lt.ps1 dev --host 0.0.0.0
    .\lt.ps1 launch
    .\lt.ps1 launch -Port 3100 -NoBrowser
    .\lt.ps1 stop -Docker
    .\lt.ps1 status
    .\lt.ps1 build
    .\lt.ps1 serve
    .\lt.ps1 preview --port 4173
    .\lt.ps1 typecheck
    .\lt.ps1 toolchain
    .\lt.ps1 lint
    .\lt.ps1 doctor
    .\lt.ps1 setup
#>
[CmdletBinding()]
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '',
    Justification = 'Interactive dev script; colored status to console is the UX.')]
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSReviewUnusedParameter', '',
    Justification = 'Top-level params consumed by subcommands via script scope.')]
param(
    [Parameter(Position = 0)]
    [ValidateSet('', 'dev', 'launch', 'stop', 'status', 'serve', 'build', 'preview', 'typecheck', 'lint', 'format', 'toolchain',
        'install', 'doctor', 'setup', 'clean', 'help')]
    [string]$Command = '',

    [ValidateRange(1, 65535)]
    [int]$Port = 3000,
    [switch]$NoBrowser,
    [switch]$Docker,

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Rest
)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ViteBin = Join-Path $ScriptDir 'node_modules\vite\bin\vite.js'
$TscBin = Join-Path $ScriptDir 'node_modules\typescript\bin\tsc'
$ServerPath = Join-Path $ScriptDir 'server.mjs'
$EnvFile = Join-Path $ScriptDir '.env'
$AssetScript = Join-Path $ScriptDir 'scripts\copy-html-to-image.mjs'
$SetupScript = Join-Path $ScriptDir 'scripts\setup.ps1'
$DoctorScript = Join-Path $ScriptDir 'scripts\doctor.mjs'
$ToolchainScript = Join-Path $ScriptDir 'scripts\build-toolchain-image.ps1'
$ServePidFile = Join-Path $ScriptDir '.tmp\serve.pid.json'
$ServeLog = Join-Path $ScriptDir '.tmp\serve.log'
$ServeErrLog = Join-Path $ScriptDir '.tmp\serve.err.log'

function Test-Tool {
    param([string]$Name, [string]$InstallHint)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "$Name not found on PATH. $InstallHint"
    }
}

function Test-ExitOk {
    param([string]$What)
    if ($LASTEXITCODE -ne 0) {
        throw "$What failed (exit $LASTEXITCODE)"
    }
}

function Write-Step {
    param([string]$Message)
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Ok {
    param([string]$Message)
    Write-Host $Message -ForegroundColor Green
}

function Write-Warn {
    param([string]$Message)
    Write-Host $Message -ForegroundColor Yellow
}

function Assert-File {
    param([string]$Path, [string]$InstallHint)
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "$Path not found. $InstallHint"
    }
}

function Assert-Node {
    Test-Tool 'node' 'Install Node 20.6+ or run .\scripts\setup.ps1.'
}

function Assert-Pnpm {
    Test-Tool 'pnpm' 'Install pnpm or run .\scripts\setup.ps1.'
}

function Assert-NodeModule {
    param([string]$Path, [string]$PackageName)
    Assert-File $Path "Run .\lt.ps1 install to install $PackageName."
}

function Invoke-AssetPrep {
    Assert-Node
    Assert-File $AssetScript 'The asset-prep script is missing from scripts\.'
    Write-Host '==> Preparing generated assets...' -ForegroundColor Cyan
    & node $AssetScript
    Test-ExitOk 'asset preparation'
}

function Invoke-Dev {
    Assert-Node
    Assert-NodeModule $ViteBin 'vite'
    Invoke-AssetPrep
    Push-Location $ScriptDir
    try {
        Write-Host '==> Starting Vite dev server...' -ForegroundColor Cyan
        & node $ViteBin @Rest
        $exit = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    exit $exit
}

function Invoke-Serve {
    Assert-Node
    Assert-File $ServerPath 'server.mjs is required for production serving.'
    Push-Location $ScriptDir
    try {
        Write-Host '==> Starting production proxy server...' -ForegroundColor Cyan
        if (Test-Path -LiteralPath $EnvFile) {
            & node "--env-file=$EnvFile" $ServerPath @Rest
        } else {
            & node $ServerPath @Rest
        }
        $exit = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    exit $exit
}

function Invoke-Build {
    Assert-Node
    Assert-NodeModule $ViteBin 'vite'
    Assert-NodeModule $TscBin 'typescript'
    Invoke-AssetPrep
    Push-Location $ScriptDir
    try {
        Write-Host '==> Type-checking...' -ForegroundColor Cyan
        & node $TscBin --noEmit
        Test-ExitOk 'tsc --noEmit'
        Write-Host '==> Building Vite bundle...' -ForegroundColor Cyan
        & node $ViteBin build @Rest
        Test-ExitOk 'vite build'
    } finally {
        Pop-Location
    }
}

function Invoke-Preview {
    Assert-Node
    Assert-NodeModule $ViteBin 'vite'
    Push-Location $ScriptDir
    try {
        Write-Host '==> Starting Vite preview...' -ForegroundColor Cyan
        & node $ViteBin preview @Rest
        $exit = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    exit $exit
}

function Invoke-Typecheck {
    Assert-Node
    Assert-NodeModule $TscBin 'typescript'
    Push-Location $ScriptDir
    try {
        Write-Host '==> tsc --noEmit...' -ForegroundColor Cyan
        & node $TscBin --noEmit @Rest
        Test-ExitOk 'tsc --noEmit'
    } finally {
        Pop-Location
    }
}

function Invoke-Lint {
    Assert-Pnpm
    Push-Location $ScriptDir
    try {
        Write-Host '==> biome check --write ...' -ForegroundColor Cyan
        & pnpm exec biome check --write . @Rest
        Test-ExitOk 'biome check'
    } finally {
        Pop-Location
    }
}

function Invoke-Format {
    Assert-Pnpm
    Push-Location $ScriptDir
    try {
        Write-Host '==> biome format --write ...' -ForegroundColor Cyan
        & pnpm exec biome format --write . @Rest
        Test-ExitOk 'biome format'
    } finally {
        Pop-Location
    }
}

function Invoke-Toolchain {
    Assert-File $ToolchainScript 'scripts\build-toolchain-image.ps1 is missing.'
    if ($Rest.Count -gt 0) {
        & $ToolchainScript @Rest
    } else {
        & $ToolchainScript
    }
    Test-ExitOk 'toolchain image build'
}

function Invoke-Install {
    Assert-Pnpm
    Push-Location $ScriptDir
    try {
        Write-Host '==> pnpm install...' -ForegroundColor Cyan
        & pnpm install @Rest
        Test-ExitOk 'pnpm install'
    } finally {
        Pop-Location
    }
}

function Invoke-Setup {
    Assert-File $SetupScript 'scripts\setup.ps1 is missing.'
    if ($Rest.Count -gt 0) { throw "setup takes no arguments (got: $($Rest -join ' ')). Use .\lt.ps1 doctor for a report only." }
    & $SetupScript
    # setup ends with the readiness report; its exit code is the report's (1 when anything is still missing).
    exit $LASTEXITCODE
}

function Assert-DoctorReady {
    Assert-Node
    Assert-File $DoctorScript 'scripts\doctor.mjs is missing.'
    Assert-File (Join-Path $ScriptDir 'node_modules') 'Run .\lt.ps1 setup (or .\lt.ps1 install) first.'
}

# Runs doctor with the saved PATH merged in, so tools installed since this terminal opened are seen.
function Invoke-DoctorScript {
    param([string[]]$Arguments)

    $previousPath = $env:Path
    $env:Path = Get-CurrentPath
    try {
        & node $DoctorScript @Arguments
    } finally {
        $env:Path = $previousPath
    }
}

function Invoke-Doctor {
    Assert-DoctorReady
    Invoke-DoctorScript -Arguments @($Rest | Where-Object { $_ })
    exit $LASTEXITCODE
}

function Show-MissingCapability {
    $lines = Invoke-DoctorScript -Arguments @('--json') 2>$null
    # Missing capabilities are an answer, not an error: keep them out of the script's own exit code.
    $global:LASTEXITCODE = 0
    try {
        $report = ($lines -join "`n") | ConvertFrom-Json
    } catch {
        Write-Warn "Readiness check did not run ($($_.Exception.Message)); .\lt.ps1 doctor shows why."
        return
    }
    $missing = @($report.rows | Where-Object { $_.status -eq 'missing' }).Count
    if ($missing -eq 1) {
        Write-Warn '1 capability missing - run .\lt.ps1 doctor'
    } elseif ($missing -gt 1) {
        Write-Warn "$missing capabilities missing - run .\lt.ps1 doctor"
    }
}

function Remove-RepoChildDirectory {
    [CmdletBinding()]
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '',
        Justification = 'Dev helper clean command is the user gesture.')]
    param([string]$RelativePath)

    $root = [System.IO.Path]::GetFullPath($ScriptDir).TrimEnd('\')
    $target = [System.IO.Path]::GetFullPath((Join-Path $ScriptDir $RelativePath)).TrimEnd('\')
    if (-not $target.StartsWith("$root\", [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to clean path outside repo: $target"
    }
    if (Test-Path -LiteralPath $target) {
        Write-Host "    removing $RelativePath" -ForegroundColor DarkGray
        Remove-Item -LiteralPath $target -Recurse -Force
    }
}

function Invoke-Clean {
    Write-Host '==> Removing generated output...' -ForegroundColor Cyan
    Remove-RepoChildDirectory 'dist'
    Remove-RepoChildDirectory 'public\lang-tutor-assets'
}

function Get-NewestWriteTime {
    param([string[]]$RelativePaths)

    $newest = [datetime]::MinValue
    $generated = Join-Path $ScriptDir 'public\lang-tutor-assets'
    foreach ($relative in $RelativePaths) {
        $path = Join-Path $ScriptDir $relative
        if (-not (Test-Path -LiteralPath $path)) { continue }
        $files = Get-ChildItem -LiteralPath $path -File -Recurse |
            Where-Object { -not $_.FullName.StartsWith($generated, [System.StringComparison]::OrdinalIgnoreCase) }
        foreach ($file in $files) {
            if ($file.LastWriteTime -gt $newest) { $newest = $file.LastWriteTime }
        }
    }
    return $newest
}

function Test-DistStale {
    $distIndex = Join-Path $ScriptDir 'dist\index.html'
    if (-not (Test-Path -LiteralPath $distIndex)) { return $true }
    $inputs = @('src', 'public', 'index.html', 'vite.config.ts', 'package.json', 'pnpm-lock.yaml')
    return (Get-NewestWriteTime $inputs) -gt (Get-Item -LiteralPath $distIndex).LastWriteTime
}

function Test-DockerEngine {
    & docker info *> $null
    $up = $LASTEXITCODE -eq 0
    # A probe's failure is an answer, not an error: keep it out of the script's own exit code.
    $global:LASTEXITCODE = 0
    return $up
}

function Start-DockerEngine {
    [CmdletBinding()]
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '',
        Justification = 'Dev helper launch command is the user gesture.')]
    param()

    Test-Tool 'docker' 'Install Docker Desktop, or run .\scripts\setup.ps1.'
    if (Test-DockerEngine) { return }
    Write-Step 'Starting Docker Desktop...'
    & docker desktop start
    $deadline = (Get-Date).AddSeconds(120)
    while (-not (Test-DockerEngine)) {
        if ((Get-Date) -gt $deadline) {
            throw 'Docker engine did not come up within 120 s. Start Docker Desktop by hand and retry.'
        }
        Start-Sleep -Seconds 2
    }
    Write-Ok 'Docker engine is up.'
}

function Initialize-ToolchainImage {
    & docker image inspect lang-tutor-toolchains:latest *> $null
    if ($LASTEXITCODE -eq 0) { return }
    $global:LASTEXITCODE = 0
    Write-Step 'Toolchain image missing; building it (one-time, several minutes)...'
    Invoke-Toolchain
}

function Read-ServeRecord {
    if (-not (Test-Path -LiteralPath $ServePidFile)) { return $null }
    return Get-Content -LiteralPath $ServePidFile -Raw | ConvertFrom-Json
}

function Get-ServeProcess {
    param($Record)

    if ($null -eq $Record) { return $null }
    $process = Get-Process -Id $Record.pid -ErrorAction SilentlyContinue
    # A pid the OS has since handed to another process must never be stopped as ours.
    if ($null -eq $process -or $process.StartTime.Ticks -ne [long]$Record.startTicks) { return $null }
    return $process
}

function Show-LogTail {
    foreach ($log in @($ServeLog, $ServeErrLog)) {
        if (Test-Path -LiteralPath $log) {
            Write-Host "--- $log (last 20 lines) ---" -ForegroundColor DarkGray
            Get-Content -LiteralPath $log -Tail 20 | Write-Host
        }
    }
}

function Wait-ServerReady {
    param([System.Diagnostics.Process]$Process, [string]$Url)

    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline) {
        if ($Process.HasExited) {
            Show-LogTail
            throw "server.mjs exited with code $($Process.ExitCode) before answering on $Url."
        }
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -SkipHttpErrorCheck -TimeoutSec 5
            if ($response.StatusCode -eq 200) { return }
        } catch {
            Write-Verbose "not ready yet: $($_.Exception.Message)"
        }
        Start-Sleep -Milliseconds 500
    }
    Show-LogTail
    throw "server.mjs did not answer on $Url within 30 s. It is still running; .\lt.ps1 stop to end it."
}

# Saved Machine + User PATH first, then entries only this session has, so tools setup just installed
# (e.g. LLVM's bin) are found without opening a new terminal.
function Get-CurrentPath {
    $saved = @(
        [System.Environment]::GetEnvironmentVariable('Path', 'Machine'),
        [System.Environment]::GetEnvironmentVariable('Path', 'User')
    ) -join ';'
    $entries = [System.Collections.Generic.List[string]]::new()
    foreach ($entry in (($saved, $env:Path) -join ';') -split ';') {
        $trimmed = $entry.Trim()
        if ($trimmed -and -not $entries.Contains($trimmed)) { $entries.Add($trimmed) }
    }
    return $entries -join ';'
}

function Start-ServeProcess {
    [CmdletBinding()]
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '',
        Justification = 'Dev helper launch command is the user gesture.')]
    param()

    $nodeArgs = @()
    if (Test-Path -LiteralPath $EnvFile) { $nodeArgs += "--env-file=$EnvFile" }
    $nodeArgs += $ServerPath
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ServePidFile) | Out-Null
    # Node's --env-file never overrides a variable already set, so -Port wins over PORT in .env.
    $previousPort = $env:PORT
    $previousPath = $env:Path
    $env:PORT = "$Port"
    $env:Path = Get-CurrentPath
    try {
        return Start-Process -FilePath 'node' -ArgumentList $nodeArgs -WorkingDirectory $ScriptDir -WindowStyle Hidden `
            -RedirectStandardOutput $ServeLog -RedirectStandardError $ServeErrLog -PassThru
    } finally {
        $env:PORT = $previousPort
        $env:Path = $previousPath
    }
}

function Invoke-Launch {
    $running = Get-ServeProcess (Read-ServeRecord)
    if ($null -ne $running) {
        $record = Read-ServeRecord
        throw "Already running at http://localhost:$($record.port)/ (pid $($record.pid)). Run .\lt.ps1 stop first."
    }
    Assert-Node
    if (-not (Test-Path -LiteralPath (Join-Path $ScriptDir 'node_modules'))) { Invoke-Install }
    if (Test-DistStale) { Invoke-Build } else { Write-Ok 'dist/ is up to date.' }
    Start-DockerEngine
    Initialize-ToolchainImage
    Show-MissingCapability

    Write-Step "Starting server.mjs on port $Port..."
    $process = Start-ServeProcess
    $record = [ordered]@{ pid = $process.Id; port = $Port; startTicks = $process.StartTime.Ticks }
    $record | ConvertTo-Json | Set-Content -LiteralPath $ServePidFile -Encoding utf8
    $url = "http://localhost:$Port/"
    Wait-ServerReady -Process $process -Url $url

    Write-Ok "Lang Tutor is running at $url (pid $($process.Id))."
    Write-Host "Logs: $ServeLog, $ServeErrLog" -ForegroundColor Gray
    Write-Host 'Stop it with .\lt.ps1 stop (add -Docker to also quit Docker Desktop).' -ForegroundColor Gray
    if (-not $NoBrowser) { Start-Process $url }
}

function Invoke-Stop {
    $record = Read-ServeRecord
    $process = Get-ServeProcess $record
    if ($null -ne $process) {
        Write-Step "Stopping server.mjs (pid $($process.Id)) and everything it started..."
        # /T takes the supervised dotnet/vite/LSP children too; a forced kill skips server.mjs's own cleanup handlers.
        $output = & taskkill /T /F /PID $process.Id 2>&1
        $killExit = $LASTEXITCODE
        $global:LASTEXITCODE = 0
        # taskkill reports 128 when a process in the tree exits mid-kill; success is the server being gone.
        if (-not $process.WaitForExit(5000)) {
            throw "taskkill failed (exit $killExit): $($output -join ' ')"
        }
        Write-Ok 'Stopped.'
    } elseif ($null -ne $record) {
        Write-Warn "pid $($record.pid) from the last launch is no longer running; clearing the stale record."
    } else {
        Write-Host 'Nothing launched by lt.ps1 is running.' -ForegroundColor Gray
    }
    if ($null -ne $record) { Remove-Item -LiteralPath $ServePidFile -Force }
    if ($Docker) {
        Write-Step 'Stopping Docker Desktop...'
        & docker desktop stop
        Test-ExitOk 'docker desktop stop'
    }
}

function Invoke-Status {
    $record = Read-ServeRecord
    if ($null -ne (Get-ServeProcess $record)) {
        Write-Ok "Lang Tutor: running at http://localhost:$($record.port)/ (pid $($record.pid))"
    } else {
        Write-Host 'Lang Tutor: not running' -ForegroundColor Gray
    }
    $engine = if ((Get-Command docker -ErrorAction SilentlyContinue) -and (Test-DockerEngine)) { 'running' } else { 'not running' }
    Write-Host "Docker engine: $engine" -ForegroundColor Gray
}

function Show-Help {
    $help = @'
lt.ps1 -- Lang tutor dev helper

Usage:
  .\lt.ps1 [<command>] [<extra args>]

Commands:
  dev        Prepare generated assets, then run Vite dev. Default command.
  serve      Run the production proxy with --env-file=.env.
  build      Prepare generated assets, type-check, then Vite build.
  preview    Run vite preview.
  typecheck  Run tsc --noEmit.
  lint       Run biome check --write .
  format     Run biome format --write .
  toolchain  Build the local Docker sandbox image for Rust/C++/DASM/Python/C# snippets.
  install    Run pnpm install.
  launch     Start the app in the background: install and build if needed, start Docker Desktop
             and the toolchain image if needed, run server.mjs, open the browser.
  stop       Stop what launch started, with every process it spawned.
  status     Show whether the app and the Docker engine are running.
  doctor     Readiness report: what is installed, what it enables, how to fix what is missing.
             Installs nothing; exits 1 when anything is missing. --json for JSON.
  setup      Install what doctor finds missing (winget, rustup, pip, pnpm, Docker image,
             C# Dev Kit), then print the readiness report.
  clean      Remove dist/ and generated public/lang-tutor-assets/.
  help       This message.

Options:
  -Port <n>    launch: port for server.mjs. Default: 3000.
  -NoBrowser   launch: do not open the browser.
  -Docker      stop: also quit Docker Desktop.

Examples:
  .\lt.ps1
  .\lt.ps1 dev --host 0.0.0.0
  .\lt.ps1 launch
  .\lt.ps1 stop -Docker
  .\lt.ps1 build
  .\lt.ps1 serve
  .\lt.ps1 preview --port 4173
  .\lt.ps1 typecheck
  .\lt.ps1 toolchain
  .\lt.ps1 lint
  .\lt.ps1 doctor
  .\lt.ps1 setup
'@
    Write-Host $help
}

$effective = if ([string]::IsNullOrEmpty($Command)) { 'dev' } else { $Command }

switch ($effective) {
    'dev'       { Invoke-Dev }
    'serve'     { Invoke-Serve }
    'build'     { Invoke-Build }
    'preview'   { Invoke-Preview }
    'typecheck' { Invoke-Typecheck }
    'lint'      { Invoke-Lint }
    'format'    { Invoke-Format }
    'toolchain' { Invoke-Toolchain }
    'install'   { Invoke-Install }
    'doctor'    { Invoke-Doctor }
    'setup'     { Invoke-Setup }
    'clean'     { Invoke-Clean }
    'launch'    { Invoke-Launch }
    'stop'      { Invoke-Stop }
    'status'    { Invoke-Status }
    'help'      { Show-Help }
    default     { throw "Unknown command: $effective" }
}
