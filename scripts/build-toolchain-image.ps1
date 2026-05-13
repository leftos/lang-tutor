#Requires -Version 7.0
<#
.SYNOPSIS
    Build the local sandbox image used to run Rust, C++, Python, and C# snippets.

.DESCRIPTION
    Produces lang-tutor-toolchains:latest from docker/toolchains/. The image
    contains Clang/LLVM for C++, rustc/rustfmt/rust-analyzer, Python 3.13
    with black/basedpyright, and the .NET SDK for C# console snippets.
#>
[CmdletBinding()]
param(
    [string]$Tag = 'lang-tutor-toolchains:latest'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$dockerfile = Join-Path $repoRoot 'docker\toolchains\Dockerfile'
$context = Join-Path $repoRoot 'docker\toolchains'

function Test-Tool {
    param([string]$Name)
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

if (-not (Test-Tool 'docker')) {
    throw 'docker not found on PATH. Install Docker Desktop, start it, then re-run this script.'
}

& docker info *> $null
if ($LASTEXITCODE -ne 0) {
    throw 'Docker is installed but the engine is not reachable. Start Docker Desktop, then re-run this script.'
}

Write-Host "==> Building $Tag ..." -ForegroundColor Cyan
& docker build --pull -t $Tag -f $dockerfile $context
if ($LASTEXITCODE -ne 0) {
    throw "docker build failed (exit $LASTEXITCODE)"
}

Write-Host "==> Verifying toolchain image ..." -ForegroundColor Cyan
& docker run --rm --entrypoint clang++ $Tag --version *> $null
if ($LASTEXITCODE -ne 0) {
    throw 'clang++ verification failed inside the toolchain image.'
}
& docker run --rm --entrypoint rustc $Tag --version *> $null
if ($LASTEXITCODE -ne 0) {
    throw 'rustc verification failed inside the toolchain image.'
}
& docker run --rm --entrypoint python3 $Tag --version *> $null
if ($LASTEXITCODE -ne 0) {
    throw 'python3 verification failed inside the toolchain image.'
}
& docker run --rm --entrypoint dotnet $Tag --version *> $null
if ($LASTEXITCODE -ne 0) {
    throw 'dotnet verification failed inside the toolchain image.'
}

Write-Host "    OK  $Tag ready" -ForegroundColor Green
