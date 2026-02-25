$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error 'Node.js is not installed. Please install Node.js 18+.'
}

Write-Host '[gateway] syntax check...' -ForegroundColor Cyan
node --check "$projectRoot\src\lab-server.js"

if ($LASTEXITCODE -ne 0) {
  throw 'Syntax check failed, stopping startup.'
}

Write-Host '[gateway] starting service...' -ForegroundColor Green
node "$projectRoot\src\lab-server.js"
