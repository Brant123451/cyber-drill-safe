param(
  [ValidateSet('status', 'reload', 'check')]
  [string]$Action = 'status',
  [string]$BaseUrl = ''
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

if (-not $BaseUrl) {
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
  $BaseUrl = "http://127.0.0.1:$port"
}

switch ($Action) {
  'status' {
    $response = Invoke-RestMethod -Uri "$BaseUrl/admin/accounts/status"
  }
  'reload' {
    $response = Invoke-RestMethod -Method Post -Uri "$BaseUrl/admin/accounts/reload"
  }
  'check' {
    $response = Invoke-RestMethod -Method Post -Uri "$BaseUrl/admin/accounts/health-check"
  }
  default {
    throw "Unsupported action: $Action"
  }
}

$response | ConvertTo-Json -Depth 8
