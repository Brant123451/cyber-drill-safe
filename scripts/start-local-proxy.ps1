# =============================================================================
# Local HTTPS proxy launcher (replaces wind-client)
#
# Usage:
#   .\scripts\start-local-proxy.ps1                            # capture mode
#   .\scripts\start-local-proxy.ps1 -Gateway http://IP:18790   # gateway mode
# =============================================================================
param(
  [string]$Gateway = ''
)

$ErrorActionPreference = 'Stop'
$scriptRoot = Split-Path -Parent $PSScriptRoot

# ---- 1. Check admin privileges (port 443 requires admin) ----
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host '[proxy] Requesting admin privileges for port 443...' -ForegroundColor Yellow
  $argList = "-ExecutionPolicy Bypass -File `"$PSCommandPath`""
  if ($Gateway) { $argList += " -Gateway `"$Gateway`"" }
  Start-Process powershell -ArgumentList $argList -Verb RunAs
  return
}

# ---- 2. Stop existing wind-client ----
$existing = Get-Process -Name "windsurf-LG*" -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "[proxy] Found wind-client (PID $($existing.Id)), stopping..." -ForegroundColor Yellow
  Stop-Process -Id $existing.Id -Force
  Start-Sleep -Seconds 1
  Write-Host '[proxy] wind-client stopped' -ForegroundColor Green
}

# ---- 3. Check port 443 is free ----
$port443 = netstat -ano | findstr "127.0.0.1:443" | findstr "LISTENING"
if ($port443) {
  Write-Host '[proxy] WARNING: 127.0.0.1:443 is still in use:' -ForegroundColor Red
  Write-Host $port443 -ForegroundColor Red
  Write-Host '[proxy] Kill the process manually and retry' -ForegroundColor Yellow
  Read-Host 'Press ENTER to exit'
  return
}

# ---- 4. Ensure hosts file has hijack entry ----
$hostsFile = "C:\Windows\System32\drivers\etc\hosts"
$hostsContent = Get-Content $hostsFile -Raw
$targetLine = "127.0.0.1 server.self-serve.windsurf.com"

if ($hostsContent -notmatch "server\.self-serve\.windsurf\.com") {
  Write-Host '[proxy] Adding hosts entry...' -ForegroundColor Cyan
  Add-Content -Path $hostsFile -Value "`n$targetLine  # cyber-drill-proxy"
  Write-Host '[proxy] hosts updated' -ForegroundColor Green
} else {
  Write-Host '[proxy] hosts entry exists' -ForegroundColor Green
}

# ---- 5. Check certificate ----
$certFile = Join-Path $scriptRoot 'certs\server.crt'
if (-not (Test-Path $certFile)) {
  Write-Host '[proxy] ERROR: certs/server.crt not found. Generate certs first.' -ForegroundColor Red
  return
}

# ---- 6. Start proxy ----
Write-Host ''
Write-Host '============================================' -ForegroundColor Cyan
if ($Gateway) {
  Write-Host "  Starting local proxy -> gateway $Gateway" -ForegroundColor Cyan
} else {
  Write-Host '  Starting local proxy -> capture mode (passthrough)' -ForegroundColor Cyan
}
Write-Host '============================================' -ForegroundColor Cyan
Write-Host '  Press Ctrl+C to stop' -ForegroundColor Yellow
Write-Host ''

$proxyScript = Join-Path $scriptRoot 'src\local-proxy.js'
if ($Gateway) {
  node $proxyScript --gateway $Gateway
} else {
  node $proxyScript
}

# ---- 7. Cleanup ----
Write-Host ''
Write-Host '[proxy] Proxy stopped' -ForegroundColor Yellow
