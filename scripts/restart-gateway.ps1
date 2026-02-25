$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

$runDir = Join-Path $projectRoot 'run'
$pidFile = Join-Path $runDir 'gateway.pid'

if (Test-Path $pidFile) {
  $pidValue = (Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1).Trim()
  if ($pidValue -match '^\d+$') {
    $process = Get-Process -Id ([int]$pidValue) -ErrorAction SilentlyContinue
    if ($process) {
      Write-Host "[restart] stopping existing process pid=$pidValue" -ForegroundColor Yellow
      Stop-Process -Id $process.Id -Force
      Start-Sleep -Milliseconds 500
    }
  }
}

if (Test-Path $pidFile) {
  Remove-Item -LiteralPath $pidFile -Force
}

Write-Host '[restart] deploying fresh gateway process...' -ForegroundColor Cyan
& "$projectRoot\scripts\deploy-gateway.ps1"
