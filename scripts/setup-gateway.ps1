$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js is not installed. Please install Node.js 18+.'
}

$envExample = Join-Path $projectRoot '.env.example'
$envFile = Join-Path $projectRoot '.env'
$configDir = Join-Path $projectRoot 'config'
$accountsFile = Join-Path $configDir 'accounts.json'
$runDir = Join-Path $projectRoot 'run'

if ((Test-Path $envExample) -and (-not (Test-Path $envFile))) {
  Copy-Item -LiteralPath $envExample -Destination $envFile
  Write-Host '[setup] created .env from .env.example' -ForegroundColor Green
}

if (-not (Test-Path $configDir)) {
  New-Item -ItemType Directory -Path $configDir | Out-Null
}

if (-not (Test-Path $accountsFile)) {
  $defaultAccountsJson = @'
{
  "accounts": [
    {
      "id": "session-A",
      "dailyLimit": 80000,
      "enabled": true
    },
    {
      "id": "session-B",
      "dailyLimit": 80000,
      "enabled": true
    },
    {
      "id": "session-C",
      "dailyLimit": 80000,
      "enabled": true
    }
  ]
}
'@
  Set-Content -LiteralPath $accountsFile -Value $defaultAccountsJson -Encoding utf8
  Write-Host '[setup] created config/accounts.json' -ForegroundColor Green
}

Write-Host '[setup] syntax check...' -ForegroundColor Cyan
node --check "$projectRoot\src\user-manager.js"
if ($LASTEXITCODE -ne 0) {
  throw 'Syntax check failed: user-manager.js'
}
node --check "$projectRoot\src\lab-server.js"
if ($LASTEXITCODE -ne 0) {
  throw 'Syntax check failed: lab-server.js'
}

$logsDir = Join-Path $projectRoot 'logs'
if (-not (Test-Path $logsDir)) {
  New-Item -ItemType Directory -Path $logsDir | Out-Null
}

if (-not (Test-Path $runDir)) {
  New-Item -ItemType Directory -Path $runDir | Out-Null
}

Write-Host '[setup] running smoke test...' -ForegroundColor Cyan
& "$projectRoot\scripts\smoke-test.ps1"

Write-Host '[setup] done. You can now run npm run deploy:ps' -ForegroundColor Green
