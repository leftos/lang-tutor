# Run Vite via Node directly, bypassing the pnpm.cmd wrapper.
# Avoids the "Terminate batch job (Y/N)?" prompt on Ctrl+C.
# Forwards any extra args to Vite (e.g. .\dev.ps1 --port 8080).

$ErrorActionPreference = 'Stop'
$vite = Join-Path $PSScriptRoot 'node_modules/vite/bin/vite.js'
if (-not (Test-Path $vite)) {
    Write-Error 'node_modules/vite not found — run "pnpm install" first.'
    exit 1
}
node $vite @args
