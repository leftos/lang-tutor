# Run the production proxy server via Node directly, bypassing the pnpm.cmd wrapper.
# Avoids the "Terminate batch job (Y/N)?" prompt on Ctrl+C.

$ErrorActionPreference = 'Stop'
$envFile = Join-Path $PSScriptRoot '.env'
$server  = Join-Path $PSScriptRoot 'server.mjs'
if (-not (Test-Path $envFile)) {
    Write-Error '.env not found — copy .env.example to .env and set ANTHROPIC_API_KEY.'
    exit 1
}
node "--env-file=$envFile" $server @args
