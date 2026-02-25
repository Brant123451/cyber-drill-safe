$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

$runDir = Join-Path $projectRoot 'run'
$pidFile = Join-Path $runDir 'gateway.pid'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js is not installed. Please install Node.js 18+.'
}

if (-not (Test-Path $runDir)) {
  New-Item -ItemType Directory -Path $runDir | Out-Null
}

& "$projectRoot\scripts\setup-gateway.ps1"

$envMap = @{}
$envPath = Join-Path $projectRoot '.env'
if (Test-Path $envPath) {
  Get-Content -LiteralPath $envPath | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith('#')) {
      return
    }

    $idx = $line.IndexOf('=')
    if ($idx -le 0) {
      return
    }

    $key = $line.Substring(0, $idx).Trim()
    $value = $line.Substring($idx + 1).Trim().Trim("'", '"')
    $envMap[$key] = $value
  }
}

$port = if ($envMap.ContainsKey('PORT')) { $envMap['PORT'] } else { '18790' }
$baseUrl = "http://127.0.0.1:$port"

if (Test-Path $pidFile) {
  $existingPidRaw = Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
  $existingPid = if ($null -ne $existingPidRaw) { $existingPidRaw.ToString().Trim() } else { '' }
  if ($existingPid -match '^\d+$') {
    $existingProcess = Get-Process -Id ([int]$existingPid) -ErrorAction SilentlyContinue
    if ($existingProcess) {
      Write-Host "[deploy] gateway already running. pid=$existingPid" -ForegroundColor Yellow
      return
    }
  }
}

try {
  Invoke-RestMethod -Uri "$baseUrl/health" -TimeoutSec 2 | Out-Null
  Write-Host "[deploy] gateway already reachable at $baseUrl (unmanaged PID)." -ForegroundColor Yellow
  return
}
catch {
}

Write-Host '[deploy] starting gateway process...' -ForegroundColor Cyan
$process = Start-Process node -ArgumentList 'src/lab-server.js' -WorkingDirectory $projectRoot -PassThru
Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding ascii

$ready = $false
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    Invoke-RestMethod -Uri "$baseUrl/health" -TimeoutSec 2 | Out-Null
    $ready = $true
    break
  }
  catch {
  }
}

if (-not $ready) {
  Stop-Process -Id $process.Id -ErrorAction SilentlyContinue
  throw "Gateway failed to start: $baseUrl/health is unavailable"
}

Write-Host "[deploy] gateway started. pid=$($process.Id) url=$baseUrl" -ForegroundColor Green
Write-Host '[deploy] run npm run accounts:status to inspect account pool.' -ForegroundColor Green
