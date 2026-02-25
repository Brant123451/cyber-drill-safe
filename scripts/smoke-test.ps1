$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

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
$token = 'sk-deploy-001'

$startedProcess = $null
$usingExisting = $false

try {
  try {
    Invoke-RestMethod -Uri "$baseUrl/health" -TimeoutSec 2 | Out-Null
    $usingExisting = $true
    Write-Host '[smoke] existing gateway detected, reusing current service.' -ForegroundColor Yellow
  }
  catch {
    Write-Host '[smoke] starting temporary gateway for smoke test...' -ForegroundColor Cyan
    $startedProcess = Start-Process node -ArgumentList 'src/lab-server.js' -WorkingDirectory $projectRoot -PassThru

    $ready = $false
    for ($i = 0; $i -lt 15; $i++) {
      Start-Sleep -Milliseconds 400
      try {
        Invoke-RestMethod -Uri "$baseUrl/health" -TimeoutSec 2 | Out-Null
        $ready = $true
        break
      }
      catch {
      }
    }

    if (-not $ready) {
      throw "Gateway health check failed: $baseUrl/health"
    }
  }

  $payload = @{
    model = 'gpt-4o'
    messages = @(
      @{ role = 'user'; content = 'smoke-test' }
    )
  } | ConvertTo-Json -Depth 6

  $response = Invoke-RestMethod -Uri "$baseUrl/v1/chat/completions" `
    -Method Post `
    -Headers @{ Authorization = "Bearer $token" } `
    -ContentType 'application/json' `
    -Body $payload

  if (-not $response.id -or -not $response.usage.total_tokens) {
    throw 'Gateway response structure invalid, smoke test failed.'
  }

  Write-Host "[smoke] pass: chat/completions  request_id=$($response.id) total_tokens=$($response.usage.total_tokens)" -ForegroundColor Green

  # ---- Test /admin/users/status ----
  $usersStatus = Invoke-RestMethod -Uri "$baseUrl/admin/users/status" -TimeoutSec 5
  if (-not $usersStatus.count -and $usersStatus.count -ne 0) {
    throw 'GET /admin/users/status returned invalid structure.'
  }
  Write-Host "[smoke] pass: users/status      count=$($usersStatus.count) enabled=$($usersStatus.enabledCount)" -ForegroundColor Green

  # ---- Test /v1/models ----
  $models = Invoke-RestMethod -Uri "$baseUrl/v1/models" `
    -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 5
  if ($models.object -ne 'list' -or -not $models.data) {
    throw 'GET /v1/models returned invalid structure.'
  }
  Write-Host "[smoke] pass: v1/models         models=$($models.data.Count)" -ForegroundColor Green

  # ---- Test /v1/credits ----
  $credits = Invoke-RestMethod -Uri "$baseUrl/v1/credits" `
    -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 5
  if (-not $credits.userId) {
    throw 'GET /v1/credits returned invalid structure.'
  }
  Write-Host "[smoke] pass: v1/credits        user=$($credits.userId) available=$($credits.credits.available)" -ForegroundColor Green
}
finally {
  if ($startedProcess) {
    Stop-Process -Id $startedProcess.Id -ErrorAction SilentlyContinue
    Write-Host '[smoke] temporary gateway process stopped.' -ForegroundColor DarkGray
  }
  elseif ($usingExisting) {
    Write-Host '[smoke] existing gateway process left running.' -ForegroundColor DarkGray
  }
}
