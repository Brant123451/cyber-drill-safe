# =============================================================================
# OpenClaw Gateway Integration - One-Click Setup
# Configures OpenClaw to use this gateway as its LLM provider
# =============================================================================
param(
  [string]$GatewayUrl = 'http://127.0.0.1:18790',
  [string]$ApiKey = '',
  [string]$PrimaryModel = 'deepseek-chat',
  [string]$OpenClawConfigDir = '',
  [switch]$CreateUser,
  [string]$UserName = ''
)

$ErrorActionPreference = 'Stop'

Write-Host ''
Write-Host '============================================' -ForegroundColor Cyan
Write-Host '  OpenClaw Gateway Integration Setup' -ForegroundColor Cyan
Write-Host '============================================' -ForegroundColor Cyan
Write-Host ''

# ---- 1. Determine OpenClaw config path ----
if (-not $OpenClawConfigDir) {
  $OpenClawConfigDir = Join-Path $env:USERPROFILE '.openclaw'
}

$configFile = Join-Path $OpenClawConfigDir 'openclaw.json'
Write-Host "[setup] OpenClaw config: $configFile" -ForegroundColor White

# ---- 2. Test gateway connectivity ----
Write-Host '[setup] testing gateway connectivity...' -ForegroundColor Cyan
try {
  $health = Invoke-RestMethod -Uri "$GatewayUrl/health" -TimeoutSec 5
  if ($health.ok -eq $true) {
    Write-Host "[setup] gateway reachable: $GatewayUrl" -ForegroundColor Green
  } else {
    Write-Host "[setup] gateway responded but unexpected format" -ForegroundColor Yellow
  }
} catch {
  Write-Host "[setup] WARNING: cannot reach gateway at $GatewayUrl" -ForegroundColor Red
  Write-Host "[setup] make sure the gateway is running first" -ForegroundColor Yellow
  Write-Host "[setup] continuing anyway (you can fix the URL later)..." -ForegroundColor Yellow
}

# ---- 3. Create user if requested ----
if ($CreateUser -or (-not $ApiKey)) {
  if (-not $UserName) {
    $UserName = $env:USERNAME
    if (-not $UserName) { $UserName = "user-$(Get-Random -Maximum 9999)" }
  }

  Write-Host "[setup] creating gateway user: $UserName ..." -ForegroundColor Cyan

  try {
    $createBody = @{
      name = $UserName
      creditLimit = 1000
      creditRecoveryAmount = 1000
      creditRecoveryIntervalMs = 10800000
    } | ConvertTo-Json

    $createResult = Invoke-RestMethod -Uri "$GatewayUrl/admin/users/create" `
      -Method Post -ContentType 'application/json' -Body $createBody -TimeoutSec 10

    if ($createResult.ok -eq $true) {
      $ApiKey = $createResult.user.token
      Write-Host "[setup] user created: $UserName" -ForegroundColor Green
      Write-Host "[setup] API Key: $ApiKey" -ForegroundColor Yellow
      Write-Host "[setup] SAVE THIS KEY - it won't be shown in full again!" -ForegroundColor Red
    } else {
      Write-Host "[setup] user creation returned unexpected result" -ForegroundColor Yellow
    }
  } catch {
    Write-Host "[setup] could not create user via API: $_" -ForegroundColor Yellow
    Write-Host "[setup] using default test key: sk-deploy-001" -ForegroundColor Yellow
    $ApiKey = 'sk-deploy-001'
  }
}

if (-not $ApiKey) {
  Write-Host "[setup] ERROR: no API key provided. Use -ApiKey or -CreateUser" -ForegroundColor Red
  return
}

# ---- 4. Fetch available models ----
Write-Host '[setup] fetching available models...' -ForegroundColor Cyan
$models = @()
try {
  $modelList = Invoke-RestMethod -Uri "$GatewayUrl/v1/models" `
    -Headers @{ Authorization = "Bearer $ApiKey" } -TimeoutSec 5

  if ($modelList.data) {
    $models = $modelList.data | ForEach-Object {
      @{
        id = $_.id
        name = $_.id
        contextWindow = 128000
        maxTokens = 16384
      }
    }
    Write-Host "[setup] found $($models.Count) models" -ForegroundColor Green
  }
} catch {
  Write-Host "[setup] could not fetch models, using defaults" -ForegroundColor Yellow
}

if ($models.Count -eq 0) {
  $models = @(
    @{ id = 'deepseek-chat'; name = 'DeepSeek Chat'; contextWindow = 65536; maxTokens = 8192 },
    @{ id = 'gpt-4o'; name = 'GPT-4o'; contextWindow = 128000; maxTokens = 16384 },
    @{ id = 'claude-sonnet-4-20250514'; name = 'Claude Sonnet 4'; contextWindow = 200000; maxTokens = 16384 }
  )
}

# ---- 5. Build OpenClaw config ----
Write-Host '[setup] generating OpenClaw config...' -ForegroundColor Cyan

# Extract base URL (without /v1)
$baseUrl = $GatewayUrl.TrimEnd('/')

$config = @{
  providers = @(
    @{
      name = 'gateway-relay'
      api = 'openai-completions'
      baseUrl = "$baseUrl/v1"
      apiKey = $ApiKey
      models = $models
    }
  )
  agents = @{
    defaults = @{
      model = @{
        primary = $PrimaryModel
      }
    }
  }
}

# ---- 6. Write config ----
if (-not (Test-Path $OpenClawConfigDir)) {
  New-Item -ItemType Directory -Path $OpenClawConfigDir -Force | Out-Null
  Write-Host "[setup] created directory: $OpenClawConfigDir" -ForegroundColor Green
}

# Backup existing config
if (Test-Path $configFile) {
  $backupFile = "$configFile.backup.$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  Copy-Item $configFile $backupFile
  Write-Host "[setup] backed up existing config to: $backupFile" -ForegroundColor Yellow

  # Merge: keep existing config, only update providers and agents.defaults.model
  try {
    $existing = Get-Content $configFile -Raw | ConvertFrom-Json
    # Replace providers
    $existing.providers = $config.providers
    # Ensure agents.defaults.model exists
    if (-not $existing.agents) { $existing | Add-Member -NotePropertyName agents -NotePropertyValue @{} }
    if (-not $existing.agents.defaults) { $existing.agents | Add-Member -NotePropertyName defaults -NotePropertyValue @{} }
    $existing.agents.defaults.model = $config.agents.defaults.model
    $config = $existing
  } catch {
    Write-Host "[setup] could not merge existing config, overwriting" -ForegroundColor Yellow
  }
}

$configJson = $config | ConvertTo-Json -Depth 10
Set-Content -LiteralPath $configFile -Value $configJson -Encoding utf8
Write-Host "[setup] written: $configFile" -ForegroundColor Green

# ---- 7. Summary ----
Write-Host ''
Write-Host '============================================' -ForegroundColor Green
Write-Host '  Setup Complete!' -ForegroundColor Green
Write-Host '============================================' -ForegroundColor Green
Write-Host ''
Write-Host "  Gateway URL:   $GatewayUrl" -ForegroundColor White
Write-Host "  API Key:       $($ApiKey.Substring(0, [Math]::Min(10, $ApiKey.Length)))****" -ForegroundColor White
Write-Host "  Primary Model: $PrimaryModel" -ForegroundColor White
Write-Host "  Config File:   $configFile" -ForegroundColor White
Write-Host ''
Write-Host '  Next steps:' -ForegroundColor Yellow
Write-Host '    1. Start OpenClaw gateway:' -ForegroundColor White
Write-Host '       node dist/entry.js gateway run --port 18789' -ForegroundColor Cyan
Write-Host '    2. Open browser: http://localhost:18789' -ForegroundColor White
Write-Host ''
Write-Host '  Check your credits:' -ForegroundColor Yellow
Write-Host "    curl $GatewayUrl/v1/credits -H `"Authorization: Bearer $($ApiKey.Substring(0, [Math]::Min(10, $ApiKey.Length)))...`"" -ForegroundColor Cyan
Write-Host ''
Write-Host '  Architecture:' -ForegroundColor Yellow
Write-Host '    OpenClaw (localhost:18789)' -ForegroundColor White
Write-Host '        |' -ForegroundColor White
Write-Host '        v  LLM requests only' -ForegroundColor White
Write-Host "    Gateway ($GatewayUrl)" -ForegroundColor White
Write-Host '        |' -ForegroundColor White
Write-Host '        v  account pool rotation' -ForegroundColor White
Write-Host '    Upstream LLM API' -ForegroundColor White
Write-Host ''
Write-Host '============================================' -ForegroundColor Green
