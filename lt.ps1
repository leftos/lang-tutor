#Requires -Version 7.0
<#
.SYNOPSIS
    Lang tutor dev helper: install, launch dev, build, serve, preview,
    type-check, lint, format, clean, and run first-time setup. One entry
    point replaces the older dev.ps1 and serve.ps1 scripts.

.DESCRIPTION
    Subcommands:

      dev        Prepare generated assets, then run Vite via Node directly.
                 This is the default when no subcommand is given. Extra
                 arguments are forwarded to Vite.
      serve      Run the production Node proxy via Node directly with
                 --env-file=.env. Extra arguments are forwarded to server.mjs.
      build      Prepare generated assets, run tsc --noEmit, then Vite build.
      preview    Run vite preview via Node directly.
      typecheck  Run tsc --noEmit.
      lint       Run biome check --write .
      format     Run biome format --write .
      install    Run pnpm install.
      setup      Run scripts/setup.ps1.
      clean      Remove generated build output.
      help       Print the subcommand summary.

.PARAMETER Command
    The subcommand to run. When omitted, defaults to dev.

.PARAMETER NoBrowser
    Applies to setup. Forwarded to scripts/setup.ps1.

.PARAMETER SkipInstall
    Applies to setup. Forwarded to scripts/setup.ps1.

.EXAMPLE
    .\lt.ps1
    .\lt.ps1 dev --host 0.0.0.0
    .\lt.ps1 build
    .\lt.ps1 serve
    .\lt.ps1 preview --port 4173
    .\lt.ps1 typecheck
    .\lt.ps1 lint
    .\lt.ps1 setup -NoBrowser
#>
[CmdletBinding()]
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '',
    Justification = 'Interactive dev script; colored status to console is the UX.')]
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSReviewUnusedParameter', '',
    Justification = 'Top-level params consumed by subcommands via script scope.')]
param(
    [Parameter(Position = 0)]
    [ValidateSet('', 'dev', 'serve', 'build', 'preview', 'typecheck', 'lint', 'format', 'install', 'setup', 'clean', 'help')]
    [string]$Command = '',

    [switch]$NoBrowser,
    [switch]$SkipInstall,

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
    if (-not (Test-Path -LiteralPath $EnvFile)) {
        throw '.env not found. Copy .env.example to .env and set ANTHROPIC_API_KEY.'
    }
    Push-Location $ScriptDir
    try {
        Write-Host '==> Starting production proxy server...' -ForegroundColor Cyan
        & node "--env-file=$EnvFile" $ServerPath @Rest
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
    $setupArgs = @()
    if ($NoBrowser) { $setupArgs += '-NoBrowser' }
    if ($SkipInstall) { $setupArgs += '-SkipInstall' }
    $setupArgs += $Rest
    & $SetupScript @setupArgs
    Test-ExitOk 'setup'
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
  install    Run pnpm install.
  setup      Run scripts/setup.ps1.
  clean      Remove dist/ and generated public/lang-tutor-assets/.
  help       This message.

Examples:
  .\lt.ps1
  .\lt.ps1 dev --host 0.0.0.0
  .\lt.ps1 build
  .\lt.ps1 serve
  .\lt.ps1 preview --port 4173
  .\lt.ps1 typecheck
  .\lt.ps1 lint
  .\lt.ps1 setup -NoBrowser
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
    'install'   { Invoke-Install }
    'setup'     { Invoke-Setup }
    'clean'     { Invoke-Clean }
    'help'      { Show-Help }
    default     { throw "Unknown command: $effective" }
}
