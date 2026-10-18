$ErrorActionPreference = 'Continue'
Set-Location (Join-Path $PSScriptRoot '../../..')
$nodeDir = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin'
if (-not (Test-Path (Join-Path $nodeDir 'node.exe'))) { throw 'Node 24 runtime missing' }
$env:PATH = $nodeDir + ';' + $env:PATH
$npmCli = 'C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js'
$env:NODE_ENV = 'test'
$env:TEST_DB_HOST = '127.0.0.1'
$env:TEST_DB_PORT = '5432'
$env:TEST_DB_NAME = 'ustal_blind_test'
$env:TEST_DB_USER = 'ustal_blind_test'
$env:TEST_DB_ADMIN_USER = (& docker exec ustal-foundation-db-1 printenv POSTGRES_USER).Trim()
$env:TEST_DB_ADMIN_PASSWORD = (& docker exec ustal-foundation-db-1 printenv POSTGRES_PASSWORD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Local Docker credentials unavailable' }
$logDir = 'docs/evaluations/blind-prerequisites-20260918'
$failedSteps = 0
$steps = @('blind:verify-isolation','blind:setup-db','blind:load-data','blind:evaluate')
try {
  foreach ($step in $steps) {
    $arguments = @($npmCli, 'run', $step)
    if ($step -eq 'blind:evaluate') { $arguments += @('--','--dry-run') }
    & (Join-Path $nodeDir 'node.exe') @arguments 2>&1 | Tee-Object -FilePath (Join-Path $logDir ($step.Replace(':','-')+'.log'))
    if ($LASTEXITCODE -ne 0) { $failedSteps++ }
    Write-Output ($step + ' EXIT=' + $LASTEXITCODE)
  }
} finally {
  Remove-Item Env:TEST_DB_ADMIN_PASSWORD -ErrorAction SilentlyContinue
}

if ($failedSteps -gt 0) { exit 1 }
