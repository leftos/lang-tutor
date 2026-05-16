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
      toolchain  Build the local Docker sandbox image for Rust/C++/Python/C# snippets.
      install    Run pnpm install.
      deploy     Deploy an immutable release to projects.leftos.dev/lang-tutor/.
      setup      Run scripts/setup.ps1.
      clean      Remove generated build output.
      help       Print the subcommand summary.

.PARAMETER Command
    The subcommand to run. When omitted, defaults to dev.

.PARAMETER NoBrowser
    Applies to setup. Forwarded to scripts/setup.ps1.

.PARAMETER SkipInstall
    Applies to setup. Forwarded to scripts/setup.ps1.

.PARAMETER DeployHost
    SSH target for deploy. Defaults to the production droplet.

.PARAMETER DeployUrl
    HTTPS base URL for deploy smoke checks and base-path detection.

.PARAMETER SkipCheck
    With deploy, skip the local type-check and production build gate.

.PARAMETER SkipPush
    With deploy, do not push the current branch before archiving HEAD.

.PARAMETER Worktree
    With deploy, archive the current tracked and untracked working tree instead
    of HEAD. This is intended for staging uncommitted deployment work; it also
    skips git push.

.PARAMETER SkipSmoke
    With deploy, skip hosted smoke checks after service restart.

.EXAMPLE
    .\lt.ps1
    .\lt.ps1 dev --host 0.0.0.0
    .\lt.ps1 build
    .\lt.ps1 serve
    .\lt.ps1 preview --port 4173
    .\lt.ps1 typecheck
    .\lt.ps1 toolchain
    .\lt.ps1 deploy
    .\lt.ps1 deploy -Worktree
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
    [ValidateSet('', 'dev', 'serve', 'build', 'preview', 'typecheck', 'lint', 'format', 'toolchain', 'install', 'setup', 'clean', 'deploy', 'help')]
    [string]$Command = '',

    [switch]$NoBrowser,
    [switch]$SkipInstall,
    [string]$DeployHost = 'root@146.190.172.94',
    [string]$DeployUrl = 'https://projects.leftos.dev/lang-tutor',
    [switch]$SkipCheck,
    [switch]$SkipPush,
    [switch]$Worktree,
    [switch]$SkipSmoke,

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
$ToolchainScript = Join-Path $ScriptDir 'scripts\build-toolchain-image.ps1'

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

function Invoke-Native {
    param(
        [Parameter(Mandatory)]
        [string]$FilePath,

        [string[]]$Arguments = @()
    )

    Push-Location $ScriptDir
    try {
        & $FilePath @Arguments
        Test-ExitOk $FilePath
    } finally {
        Pop-Location
    }
}

function Invoke-NativeOutput {
    param(
        [Parameter(Mandatory)]
        [string]$FilePath,

        [string[]]$Arguments = @()
    )

    Push-Location $ScriptDir
    try {
        $output = & $FilePath @Arguments
        Test-ExitOk $FilePath
        return $output
    } finally {
        Pop-Location
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

function Assert-CleanTrackedWorktree {
    Test-Tool 'git' 'Install Git and try again.'

    Push-Location $ScriptDir
    try {
        & git update-index --refresh
        Test-ExitOk 'git update-index'

        & git diff --quiet --exit-code
        if ($LASTEXITCODE -eq 1) {
            throw 'Tracked files have unstaged changes. Commit or stash them before deploying, or pass -Worktree.'
        }
        Test-ExitOk 'git diff'

        & git diff --cached --quiet --exit-code
        if ($LASTEXITCODE -eq 1) {
            throw 'Tracked files have staged but uncommitted changes. Commit or unstage them before deploying, or pass -Worktree.'
        }
        Test-ExitOk 'git diff --cached'

        $untracked = @(git ls-files --others --exclude-standard)
        if ($untracked.Count -gt 0) {
            Write-Warn "Untracked files are not included in the deploy archive: $($untracked -join ', ')"
        }
    } finally {
        Pop-Location
    }
}

function New-DeployArchive {
    param(
        [Parameter(Mandatory)]
        [string]$Archive,

        [Parameter(Mandatory)]
        [bool]$IncludeWorktree
    )

    Push-Location $ScriptDir
    try {
        if ($IncludeWorktree) {
            Test-Tool 'tar' 'Install tar or use Git for Windows PowerShell.'
            & git ls-files -z --cached --others --exclude-standard | & tar --null -T - -cf $Archive
            Test-ExitOk 'worktree archive'
            return
        }

        & git archive --format=tar "--output=$Archive" HEAD
        Test-ExitOk 'git archive'
    } finally {
        Pop-Location
    }
}

function New-DeployActivationScript {
    param([string]$Path)

    $scriptText = @'
#!/usr/bin/env bash
set -euo pipefail

release_name="$1"
case "$release_name" in
  ""|*[!a-zA-Z0-9._-]*)
    echo "invalid release name: $release_name" >&2
    exit 1
    ;;
esac

archive=/tmp/lang-tutor-release.tar
release="/opt/lang-tutor/releases/${release_name}"
if [ -e "$release" ]; then
  echo "release already exists: $release" >&2
  exit 1
fi

mkdir -p "$release"
tar -xf "$archive" -C "$release"
chown -R lang-tutor:lang-tutor "$release"
ln -sfnT "$release" /opt/lang-tutor/app
chown -h lang-tutor:lang-tutor /opt/lang-tutor/app
install -d -o lang-tutor -g lang-tutor /opt/lang-tutor/app/.local /opt/lang-tutor/app/projects /opt/lang-tutor/app/.tmp
install -d -o lang-tutor -g lang-tutor /var/lib/lang-tutor /var/lib/lang-tutor/runs /var/lib/lang-tutor/workspaces /var/lib/lang-tutor/cache
'@

    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText($Path, ($scriptText -replace "`r`n", "`n"), $utf8NoBom)
}

function New-HostedToolingScript {
    param([string]$Path)

    $scriptText = @'
#!/usr/bin/env bash
set -euo pipefail

required_commands=(
  rustc
  rustfmt
  rust-analyzer
  clang
  clang-format
  clangd
  python
  black
  basedpyright
  basedpyright-langserver
  typescript-language-server
  vscode-html-language-server
  vscode-css-language-server
  biome
)

missing=()
for cmd in "${required_commands[@]}"; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    missing+=("$cmd")
  fi
done

if [ "${#missing[@]}" -eq 0 ]; then
  echo "hosted checker/LSP tools already installed"
  exit 0
fi

echo "installing missing hosted checker/LSP tools: ${missing[*]}"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  build-essential \
  clang \
  clang-format \
  clangd \
  black \
  python-is-python3 \
  python3-pip

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required to install hosted TypeScript/Python/Web LSP binaries" >&2
  exit 1
fi
npm install -g basedpyright typescript typescript-language-server vscode-langservers-extracted @biomejs/biome

export RUSTUP_HOME=/opt/rustup
export CARGO_HOME=/opt/cargo
if [ ! -x /opt/cargo/bin/rustup ]; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --profile minimal --default-toolchain stable --component rustfmt,rust-analyzer
else
  /opt/cargo/bin/rustup toolchain install stable --profile minimal --component rustfmt --component rust-analyzer
  /opt/cargo/bin/rustup default stable
  /opt/cargo/bin/rustup component add rustfmt rust-analyzer
fi

rustc_path="$(/opt/cargo/bin/rustup which rustc)"
rustfmt_path="$(/opt/cargo/bin/rustup which rustfmt)"
cargo_path="$(/opt/cargo/bin/rustup which cargo)"
rust_analyzer_path="$(/opt/cargo/bin/rustup which rust-analyzer)"
ln -sf "$rustc_path" /usr/local/bin/rustc
ln -sf "$rustfmt_path" /usr/local/bin/rustfmt
ln -sf "$cargo_path" /usr/local/bin/cargo
ln -sf "$rust_analyzer_path" /usr/local/bin/rust-analyzer

for cmd in "${required_commands[@]}"; do
  command -v "$cmd" >/dev/null
done
echo "hosted checker/LSP tools ready"
'@

    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText($Path, ($scriptText -replace "`r`n", "`n"), $utf8NoBom)
}

function Test-HttpStatus {
    param(
        [Parameter(Mandatory)]
        [string]$Uri,

        [string]$Method = 'Get',

        [Parameter(Mandatory)]
        [int]$ExpectedStatus
    )

    $lastStatus = $null
    for ($attempt = 1; $attempt -le 10; $attempt++) {
        try {
            $response = Invoke-WebRequest -Uri $Uri -Method $Method -UseBasicParsing -SkipHttpErrorCheck -TimeoutSec 30
            $lastStatus = $response.StatusCode
            if ($response.StatusCode -eq $ExpectedStatus) {
                return
            }
        } catch {
            $lastStatus = $_.Exception.Message
        }
        Start-Sleep -Seconds 1
    }
    throw "Expected $ExpectedStatus from $Uri, got $lastStatus."
}

function Get-DeployBasePath {
    param([string]$BaseUrl)

    try {
        $path = ([System.Uri]$BaseUrl).AbsolutePath
    } catch {
        return '/'
    }
    if ([string]::IsNullOrWhiteSpace($path) -or $path -eq '/') {
        return '/'
    }
    return "$($path.TrimEnd('/'))/"
}

function Invoke-DeploySmokeChecks {
    param([string]$BaseUrl)

    $trimmedUrl = $BaseUrl.TrimEnd('/')
    Write-Step "Smoke: $trimmedUrl"
    Test-HttpStatus -Uri $trimmedUrl -Method Head -ExpectedStatus 200

    Write-Step "Smoke: $trimmedUrl/"
    Test-HttpStatus -Uri "$trimmedUrl/" -Method Head -ExpectedStatus 200

    Write-Step 'Smoke: auth session'
    $session = Invoke-RestMethod -Uri "$trimmedUrl/api/auth/session" -Method Get -TimeoutSec 30
    if (-not (Get-Member -InputObject $session -Name 'session' -MemberType NoteProperty)) {
        throw 'Auth session response did not include a session property.'
    }
    if (-not (Get-Member -InputObject $session -Name 'requireAuth' -MemberType NoteProperty) -or $session.requireAuth -ne $true) {
        throw 'Hosted Lang Tutor must report requireAuth: true.'
    }

    Write-Step 'Smoke: unauthenticated state is protected'
    Test-HttpStatus -Uri "$trimmedUrl/state/local-storage" -ExpectedStatus 401

    Write-Step 'Smoke: unauthenticated hosted tooling is protected'
    $body = @{ lang = 'rust'; code = 'fn main() {}' } | ConvertTo-Json -Compress
    $response = Invoke-WebRequest -Uri "$trimmedUrl/run" -Method Post -ContentType 'application/json' -Body $body -UseBasicParsing -SkipHttpErrorCheck -TimeoutSec 30
    if ($response.StatusCode -ne 401) {
        throw "Expected 401 from unauthenticated /run, got $($response.StatusCode)."
    }

    Write-Ok 'Hosted smoke checks passed.'
}

function Invoke-Deploy {
    Test-Tool 'git' 'Install Git and try again.'
    Test-Tool 'ssh' 'Install OpenSSH client and try again.'
    Test-Tool 'scp' 'Install OpenSSH client and try again.'

    if ($Worktree) {
        Write-Warn 'Deploying the current working tree, including uncommitted tracked files and untracked non-ignored files.'
    } else {
        Assert-CleanTrackedWorktree
    }

    if (-not $SkipCheck) {
        Invoke-Typecheck
    } else {
        Write-Warn 'Skipping local typecheck.'
    }

    if ($Worktree) {
        Write-Warn 'Skipping git push because -Worktree deploys local uncommitted content.'
    } elseif (-not $SkipPush) {
        Write-Step 'Pushing current branch'
        Invoke-Native -FilePath 'git' -Arguments @('push')
    } else {
        Write-Warn 'Skipping git push.'
    }

    $commit = ((Invoke-NativeOutput -FilePath 'git' -Arguments @('rev-parse', '--short', 'HEAD')) -join '').Trim()
    $stamp = Get-Date -Format 'yyyyMMddHHmmss'
    $releaseName = if ($Worktree) { "$commit-worktree-$stamp" } else { "$commit-$stamp" }
    $deployBasePath = Get-DeployBasePath -BaseUrl $DeployUrl
    $tmpDir = Join-Path $ScriptDir '.tmp'
    New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
    $archive = Join-Path $tmpDir "lang-tutor-$releaseName.tar"
    $activateScript = Join-Path $tmpDir "lang-tutor-activate-$releaseName.sh"
    $hostedToolingScript = Join-Path $tmpDir "lang-tutor-hosted-tooling-$releaseName.sh"

    Write-Step "Creating release archive $releaseName"
    New-DeployArchive -Archive $archive -IncludeWorktree:$Worktree
    New-DeployActivationScript -Path $activateScript
    New-HostedToolingScript -Path $hostedToolingScript

    Write-Step "Uploading release to $DeployHost"
    Invoke-Native -FilePath 'scp' -Arguments @($archive, "${DeployHost}:/tmp/lang-tutor-release.tar")
    Invoke-Native -FilePath 'scp' -Arguments @($activateScript, "${DeployHost}:/tmp/lang-tutor-activate.sh")
    Invoke-Native -FilePath 'scp' -Arguments @($hostedToolingScript, "${DeployHost}:/tmp/lang-tutor-hosted-tooling.sh")

    Write-Step 'Ensuring hosted checker/LSP tools on droplet'
    Invoke-Native -FilePath 'ssh' -Arguments @($DeployHost, 'bash /tmp/lang-tutor-hosted-tooling.sh')

    Write-Step 'Activating release on droplet'
    Invoke-Native -FilePath 'ssh' -Arguments @($DeployHost, "bash /tmp/lang-tutor-activate.sh '$releaseName'")

    Write-Step 'Installing dependencies and building production assets on droplet'
    Invoke-Native -FilePath 'ssh' -Arguments @(
        $DeployHost,
        "runuser -u lang-tutor -- env HOME=/opt/lang-tutor LANG_TUTOR_BASE_PATH='$deployBasePath' bash -lc 'cd /opt/lang-tutor/app && pnpm install --frozen-lockfile && pnpm build'"
    )

    Write-Step 'Building hosted toolchain Docker image on droplet'
    Invoke-Native -FilePath 'ssh' -Arguments @(
        $DeployHost,
        "cd /opt/lang-tutor/app && docker build -t lang-tutor-toolchains:latest -f docker/toolchains/Dockerfile docker/toolchains && docker run --rm --entrypoint python3 lang-tutor-toolchains:latest --version && docker run --rm --entrypoint rustc lang-tutor-toolchains:latest --version && docker run --rm --entrypoint clang++ lang-tutor-toolchains:latest --version >/dev/null && docker run --rm --entrypoint dotnet lang-tutor-toolchains:latest --version"
    )

    Write-Step 'Ensuring hosted workspace runtime config'
    Invoke-Native -FilePath 'ssh' -Arguments @(
        $DeployHost,
        "install -d -m 0755 /etc/lang-tutor && touch /etc/lang-tutor/lang-tutor-runtime.conf && if grep -q '^LANG_TUTOR_PROJECT_ROOT=' /etc/lang-tutor/lang-tutor-runtime.conf; then sed -i 's#^LANG_TUTOR_PROJECT_ROOT=.*#LANG_TUTOR_PROJECT_ROOT=/var/lib/lang-tutor/workspaces#' /etc/lang-tutor/lang-tutor-runtime.conf; else printf '\nLANG_TUTOR_PROJECT_ROOT=/var/lib/lang-tutor/workspaces\n' >> /etc/lang-tutor/lang-tutor-runtime.conf; fi && install -d -o lang-tutor -g lang-tutor /var/lib/lang-tutor/workspaces /var/lib/lang-tutor/cache"
    )

    Write-Step 'Restarting lang-tutor.service'
    Invoke-Native -FilePath 'ssh' -Arguments @(
        $DeployHost,
        'systemctl restart lang-tutor.service && systemctl is-active lang-tutor.service && readlink -f /opt/lang-tutor/app'
    )

    if (-not $SkipSmoke) {
        Invoke-DeploySmokeChecks -BaseUrl $DeployUrl
    } else {
        Write-Warn 'Skipping hosted smoke checks.'
    }

    Write-Ok "Deploy complete: $releaseName"
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
  toolchain  Build the local Docker sandbox image for Rust/C++/Python/C# snippets.
  install    Run pnpm install.
  deploy     Deploy to the droplet, restart lang-tutor.service, and smoke test.
  setup      Run scripts/setup.ps1.
  clean      Remove dist/ and generated public/lang-tutor-assets/.
  help       This message.

Deploy options:
  -DeployHost <ssh>  SSH target. Default: root@146.190.172.94
  -DeployUrl <url>   Hosted base URL. Default: https://projects.leftos.dev/lang-tutor
  -SkipCheck         Skip the local type-check/build gate before deploy.
  -SkipPush          Do not push before archiving HEAD.
  -Worktree          Deploy local tracked and untracked worktree files instead of HEAD; skips git push.
  -SkipSmoke         Skip hosted smoke checks after restart.

Examples:
  .\lt.ps1
  .\lt.ps1 dev --host 0.0.0.0
  .\lt.ps1 build
  .\lt.ps1 serve
  .\lt.ps1 preview --port 4173
  .\lt.ps1 typecheck
  .\lt.ps1 toolchain
  .\lt.ps1 deploy
  .\lt.ps1 deploy -Worktree
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
    'toolchain' { Invoke-Toolchain }
    'install'   { Invoke-Install }
    'setup'     { Invoke-Setup }
    'clean'     { Invoke-Clean }
    'deploy'    { Invoke-Deploy }
    'help'      { Show-Help }
    default     { throw "Unknown command: $effective" }
}
