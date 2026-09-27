#Requires -Version 7.0
<#
.SYNOPSIS
  Prepare this Windows machine to run Lang Tutor with every capability:
  install what the readiness report finds missing, then print the report.

.DESCRIPTION
  Idempotent: safe to re-run. The readiness report (scripts/doctor.mjs, also
  .\lt.ps1 doctor) decides what is missing by running each tool, not by
  looking for it on PATH. Setup then runs one recipe per missing capability,
  re-runs the report and prints it. Every recipe fails soft: its error is
  printed with the rows it was meant to fix, and the final table is the truth.
  Uses winget with --scope user where the package supports it, so admin is
  not required.

  Recipes, in the order they run:
    node             winget OpenJS.NodeJS.LTS
    pnpm             corepack enable pnpm, else winget pnpm.pnpm
    pnpm-install     pnpm install (brings every npm language server)
    docker-desktop   winget Docker.DockerDesktop
    docker-engine    docker desktop start, then wait for the engine
    toolchain-image  scripts\build-toolchain-image.ps1
    dotnet-sdk       winget Microsoft.DotNet.SDK.8
    rustup           winget Rustlang.Rustup if rustup is missing, then
                     rustup component add rustfmt rust-analyzer
    python           winget Python.Python.3.13
    black            winget astral-sh.uv if uv is missing, then uv tool install
                     black, then uv's tool bin folder onto the user PATH
    llvm             winget LLVM.LLVM, then its bin folder onto the user PATH
    csdevkit         code --install-extension ms-dotnettools.csdevkit

  The exit code is the final report's: 0 when everything is ready, 1 when
  anything is still missing.

.EXAMPLE
  .\scripts\setup.ps1
  .\lt.ps1 setup
#>

[CmdletBinding()]
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '',
    Justification = 'Interactive setup script; colored status to console is the UX.')]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$doctorScript = Join-Path $PSScriptRoot 'doctor.mjs'
$toolchainScript = Join-Path $PSScriptRoot 'build-toolchain-image.ps1'

$RecipeOrder = @(
    'node', 'pnpm', 'pnpm-install', 'docker-desktop', 'docker-engine', 'toolchain-image',
    'dotnet-sdk', 'rustup', 'python', 'black', 'llvm', 'csdevkit'
)

function Write-Step {
    param([string]$Message)
    Write-Host ''
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Ok {
    param([string]$Message)
    Write-Host "    OK  $Message" -ForegroundColor Green
}

function Write-Warn {
    param([string]$Message)
    Write-Host "    !!  $Message" -ForegroundColor Yellow
}

function Update-SessionPath {
    [CmdletBinding()]
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '',
        Justification = 'Refreshes this session''s PATH after an install; setup is the user gesture.')]
    param()

    $machine = [System.Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [System.Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machine;$user"
}

function Test-Tool {
    param([string]$Name)
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Test-ExitOk {
    param([string]$What)
    if ($LASTEXITCODE -ne 0) {
        throw "$What failed (exit $LASTEXITCODE)"
    }
}

function Test-WingetExitOk {
    param([int]$ExitCode)
    # Winget exit codes that mean "the package is already at the desired state" - not a real failure.
    #   0x8A15002B  APPINSTALLER_CLI_ERROR_UPDATE_NOT_APPLICABLE   (already installed, no upgrade available)
    #   0x8A150109  APPINSTALLER_CLI_ERROR_PACKAGE_ALREADY_INSTALLED
    return $ExitCode -eq 0 -or $ExitCode -in @(-1978335189, -1978334967)
}

function Install-WingetPackage {
    param(
        [string]$Id,
        [string]$DisplayName
    )
    if (-not (Test-Tool 'winget')) {
        throw "winget not found. Install 'App Installer' from the Microsoft Store (https://apps.microsoft.com/detail/9NBLGGH4NNS1), then re-run setup."
    }
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
        '--accept-package-agreements'
    )
    & winget @wingetArgs --scope user
    if (-not (Test-WingetExitOk $LASTEXITCODE)) {
        # Some packages don't support --scope user - retry without it.
        Write-Warn 'user-scope install failed, retrying without --scope...'
        & winget @wingetArgs
        if (-not (Test-WingetExitOk $LASTEXITCODE)) {
            throw "winget install failed for $Id (exit $LASTEXITCODE)"
        }
    }
    $global:LASTEXITCODE = 0
    Update-SessionPath
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
        # Already on the persistent user PATH; make sure this session sees it too.
        if (";$env:Path;" -notlike "*;$Directory;*") {
            $env:Path = "$Directory;$env:Path"
        }
        return
    }
    $new = if ([string]::IsNullOrEmpty($current)) { $Directory } else { "$Directory;$current" }
    [System.Environment]::SetEnvironmentVariable('Path', $new, 'User')
    $env:Path = "$Directory;$env:Path"
}

function Test-DockerEngine {
    & docker info *> $null
    $up = $LASTEXITCODE -eq 0
    $global:LASTEXITCODE = 0
    return $up
}

# -- Recipes -----------------------------------------------------------------

function Install-Node {
    Install-WingetPackage -Id 'OpenJS.NodeJS.LTS' -DisplayName 'Node.js LTS'
}

function Install-Pnpm {
    if (Test-Tool 'corepack') {
        Write-Host '    enabling pnpm via corepack...'
        & corepack enable pnpm | Out-Host
        $global:LASTEXITCODE = 0
        Update-SessionPath
    }
    if (-not (Test-Tool 'pnpm')) {
        Install-WingetPackage -Id 'pnpm.pnpm' -DisplayName 'pnpm'
    }
}

function Install-NodeModule {
    Push-Location $repoRoot
    try {
        & pnpm install | Out-Host
        Test-ExitOk 'pnpm install'
    } finally {
        Pop-Location
    }
}

function Install-DockerDesktop {
    Install-WingetPackage -Id 'Docker.DockerDesktop' -DisplayName 'Docker Desktop'
}

function Start-DockerEngine {
    [CmdletBinding()]
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '',
        Justification = 'Setup is the user gesture.')]
    param()

    if (-not (Test-Tool 'docker')) { throw 'docker is not on PATH; Docker Desktop must be installed first.' }
    if (Test-DockerEngine) { return }
    Write-Host '    starting Docker Desktop...'
    & docker desktop start
    $global:LASTEXITCODE = 0
    $deadline = (Get-Date).AddSeconds(120)
    while (-not (Test-DockerEngine)) {
        if ((Get-Date) -gt $deadline) {
            throw 'Docker engine did not come up within 120 s. Start Docker Desktop by hand and re-run setup.'
        }
        Start-Sleep -Seconds 2
    }
}

function Build-ToolchainImage {
    if (-not (Test-Tool 'docker') -or -not (Test-DockerEngine)) {
        throw 'the Docker engine is not running, so the toolchain image cannot be built.'
    }
    & $toolchainScript | Out-Host
    Test-ExitOk 'toolchain image build'
}

function Install-DotnetSdk {
    Install-WingetPackage -Id 'Microsoft.DotNet.SDK.8' -DisplayName '.NET SDK 8'
}

function Install-RustComponent {
    if (-not (Test-Tool 'rustup')) {
        Install-WingetPackage -Id 'Rustlang.Rustup' -DisplayName 'Rust (rustup)'
    }
    if (-not (Test-Tool 'rustup')) { throw 'rustup is still not on PATH after install. Open a new shell and re-run setup.' }
    # Only choose a default toolchain when none is configured; never replace the user's choice.
    & rustup default *> $null
    if ($LASTEXITCODE -ne 0) {
        & rustup default stable | Out-Host
        Test-ExitOk 'rustup default stable'
    }
    & rustup component add rustfmt rust-analyzer | Out-Host
    Test-ExitOk 'rustup component add rustfmt rust-analyzer'
    Update-SessionPath
}

function Install-Python {
    Install-WingetPackage -Id 'Python.Python.3.13' -DisplayName 'Python 3.13'
}

function Test-UvReady {
    if (-not (Test-Tool 'uv')) { return $false }
    & uv --version *> $null
    $ok = $LASTEXITCODE -eq 0
    $global:LASTEXITCODE = 0
    return $ok
}

function Install-Black {
    if (-not (Test-UvReady)) {
        Install-WingetPackage -Id 'astral-sh.uv' -DisplayName 'uv'
    }
    if (-not (Test-UvReady)) { throw 'uv is still not on PATH after install. Open a new shell and re-run setup.' }
    $installed = @(& uv tool list) -match '^black v'
    Test-ExitOk 'uv tool list'
    if ($installed.Count -eq 0) {
        & uv tool install black | Out-Host
        Test-ExitOk 'uv tool install black'
    }
    # uv links tool executables into its own bin folder (uv tool dir --bin),
    # which may not be on PATH. Add it here rather than via `uv tool
    # update-shell`, which only edits the persistent PATH: this also updates
    # the running session, so the final report sees black.
    $binDir = "$(& uv tool dir --bin)".Trim()
    Test-ExitOk 'uv tool dir --bin'
    if ([string]::IsNullOrEmpty($binDir)) { throw 'uv did not report its tool bin folder.' }
    Update-SessionPath
    Add-DirectoryToUserPath -Directory $binDir
}

function Install-Llvm {
    # The LLVM.LLVM winget package installs to C:\Program Files\LLVM but does not
    # update PATH, so look on disk first and only install when nothing is there.
    $llvmBin = Find-LlvmBin
    if ($null -eq $llvmBin) {
        Install-WingetPackage -Id 'LLVM.LLVM' -DisplayName 'LLVM'
        $llvmBin = Find-LlvmBin
    }
    if ($null -eq $llvmBin) {
        # Almost always a stale uninstall registry entry from a prior manual
        # install making winget treat the package as already installed.
        throw ("winget reported LLVM installed but no clang.exe is at a known path. A stale registry entry " +
            "usually causes this: remove HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\LLVM and re-run setup.")
    }
    Add-DirectoryToUserPath -Directory $llvmBin
}

function Install-CsharpDevKit {
    if (-not (Test-Tool 'code')) {
        throw ('VS Code is not on PATH. Install VS Code and re-run setup for the Roslyn language server, ' +
            'or install OmniSharp: scoop install omnisharp.')
    }
    & code --install-extension ms-dotnettools.csdevkit | Out-Host
    Test-ExitOk 'code --install-extension ms-dotnettools.csdevkit'
}

$Recipes = @{
    'node'            = { Install-Node }
    'pnpm'            = { Install-Pnpm }
    'pnpm-install'    = { Install-NodeModule }
    'docker-desktop'  = { Install-DockerDesktop }
    'docker-engine'   = { Start-DockerEngine }
    'toolchain-image' = { Build-ToolchainImage }
    'dotnet-sdk'      = { Install-DotnetSdk }
    'rustup'          = { Install-RustComponent }
    'python'          = { Install-Python }
    'black'           = { Install-Black }
    'llvm'            = { Install-Llvm }
    'csdevkit'        = { Install-CsharpDevKit }
}

# -- Report ------------------------------------------------------------------

function Get-ReadinessReport {
    $lines = & node $doctorScript --json
    # doctor exits 1 when anything is missing; that is the report, not a failure.
    $global:LASTEXITCODE = 0
    return ($lines -join "`n") | ConvertFrom-Json
}

function Initialize-Bootstrap {
    # doctor.mjs needs Node and the project's node_modules (it imports the
    # server's own probe tables), so those come first.
    if (-not (Test-Tool 'node')) {
        Write-Step 'Node.js is missing; installing it so the readiness report can run'
        Install-Node
        if (-not (Test-Tool 'node')) { throw 'node is still not on PATH after install. Open a new shell and re-run setup.' }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'node_modules'))) {
        Write-Step 'Installing npm dependencies'
        if (-not (Test-Tool 'pnpm')) { Install-Pnpm }
        Install-NodeModule
    }
}

function Initialize-DotEnv {
    $envPath = Join-Path $repoRoot '.env'
    $envExamplePath = Join-Path $repoRoot '.env.example'
    if (Test-Path -LiteralPath $envPath) { return }
    if (Test-Path -LiteralPath $envExamplePath) {
        Copy-Item -LiteralPath $envExamplePath -Destination $envPath
        Write-Ok 'Created .env from .env.example. Provider API keys are configured in the browser UI.'
    } else {
        Write-Warn '.env.example missing; continuing without .env.'
    }
}

function Invoke-Recipe {
    param([string]$Name, [string[]]$Rows)

    Write-Step "$Name  (for: $($Rows -join ', '))"
    try {
        & $Recipes[$Name]
        Write-Ok "$Name done"
    } catch {
        Write-Warn "$Name failed (rows: $($Rows -join ', ')): $($_.Exception.Message)"
    }
}

# -- Main --------------------------------------------------------------------

Write-Host ''
Write-Host 'Lang Tutor setup' -ForegroundColor White
Write-Host '----------------' -ForegroundColor White

try {
    Initialize-Bootstrap
} catch {
    Write-Warn "Cannot run the readiness report: $($_.Exception.Message)"
    exit 1
}
Initialize-DotEnv

Write-Step 'Checking what is missing'
$missingRows = @((Get-ReadinessReport).rows | Where-Object { $_.status -eq 'missing' })
if ($missingRows.Count -eq 0) {
    Write-Ok 'Nothing to install.'
}
foreach ($recipe in $RecipeOrder) {
    $rowsForRecipe = @($missingRows | Where-Object { $_.recipe -eq $recipe } | ForEach-Object { $_.name })
    if ($rowsForRecipe.Count -gt 0) {
        Invoke-Recipe -Name $recipe -Rows $rowsForRecipe
    }
}
foreach ($row in @($missingRows | Where-Object { $null -eq $_.recipe })) {
    Write-Warn "$($row.name) has no automatic install: $($row.fix)"
}

Write-Step 'Readiness report'
& node $doctorScript
exit $LASTEXITCODE
