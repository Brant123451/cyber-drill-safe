# =============================================================================
# Launch Windsurf with MITM proxy environment variables
# Forces Node.js backend to route through mitmproxy
# =============================================================================
param(
  [int]$ProxyPort = 8080,
  [switch]$SkipMitmproxy
)

$ErrorActionPreference = 'Stop'
$scriptRoot = Split-Path -Parent $PSScriptRoot
$addonPath  = Join-Path (Join-Path $scriptRoot 'scripts') 'mitmproxy-addon.py'
$caCertPem  = Join-Path (Join-Path $env:USERPROFILE '.mitmproxy') 'mitmproxy-ca-cert.pem'
$captureFile = Join-Path (Join-Path $env:USERPROFILE '.mitmproxy') 'windsurf-capture.bin'

# ---- 1. Validate CA cert exists ----
if (-not (Test-Path $caCertPem)) {
  Write-Host '[mitm] ERROR: CA cert not found. Run client-setup.ps1 first.' -ForegroundColor Red
  return
}

# ---- 2. Start mitmproxy (unless skipped) ----
if (-not $SkipMitmproxy) {
  Write-Host "[mitm] starting mitmproxy on port $ProxyPort (logging mode)..." -ForegroundColor Cyan

  $mitmJob = Start-Process mitmdump -ArgumentList @(
    '--listen-port', $ProxyPort,
    '--set', 'connection_strategy=lazy',
    '--showhost',
    '-w', $captureFile
  ) -PassThru -WindowStyle Normal

  Start-Sleep -Seconds 2

  if ($mitmJob.HasExited) {
    Write-Host '[mitm] ERROR: mitmproxy failed to start.' -ForegroundColor Red
    return
  }

  Write-Host "[mitm] mitmproxy running (PID $($mitmJob.Id))" -ForegroundColor Green
} else {
  Write-Host '[mitm] skipping mitmproxy startup (assumed already running)' -ForegroundColor Yellow
}

# ---- 3. Set proxy env vars for Node.js ----
$proxyUrl = "http://127.0.0.1:$ProxyPort"

$env:HTTP_PROXY  = $proxyUrl
$env:HTTPS_PROXY = $proxyUrl
$env:http_proxy  = $proxyUrl
$env:https_proxy = $proxyUrl

# Trust mitmproxy CA in Node.js (better than disabling TLS verification)
$env:NODE_EXTRA_CA_CERTS = $caCertPem

# Electron/Chromium proxy flag
$env:ELECTRON_PROXY = $proxyUrl

Write-Host "[mitm] proxy env vars set -> $proxyUrl" -ForegroundColor Green
Write-Host "[mitm] NODE_EXTRA_CA_CERTS -> $caCertPem" -ForegroundColor Green

# ---- 4. Enable system proxy (for Chromium renderer) ----
$proxyKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
Set-ItemProperty -Path $proxyKey -Name ProxyEnable -Value 1
Set-ItemProperty -Path $proxyKey -Name ProxyServer -Value "127.0.0.1:$ProxyPort"
Set-ItemProperty -Path $proxyKey -Name ProxyOverride -Value '<local>;localhost;127.0.0.1'
Write-Host "[mitm] system proxy enabled -> 127.0.0.1:$ProxyPort" -ForegroundColor Green

# ---- 5. Launch Windsurf ----
$windsurfCmd = 'E:\Useless\windsurf\Windsurf\bin\windsurf.cmd'

Write-Host ''
Write-Host '============================================' -ForegroundColor Cyan
Write-Host '  Launching Windsurf with MITM proxy...' -ForegroundColor Cyan
Write-Host '============================================' -ForegroundColor Cyan
Write-Host "  Proxy:    $proxyUrl" -ForegroundColor White
Write-Host "  CA Cert:  $caCertPem" -ForegroundColor White
Write-Host "  Capture:  $captureFile" -ForegroundColor White
Write-Host ''
Write-Host '  Watch mitmproxy window for intercepted traffic.' -ForegroundColor Yellow
Write-Host '  Press Ctrl+C here to stop and clean up.' -ForegroundColor Yellow
Write-Host '============================================' -ForegroundColor Cyan

# Launch Windsurf with proxy args (Start-Process so it doesn't block)
Start-Process $windsurfCmd -ArgumentList "--proxy-server=127.0.0.1:$ProxyPort"

Start-Sleep -Seconds 2
Write-Host ''
Write-Host '[mitm] Windsurf launched. mitmproxy is capturing traffic.' -ForegroundColor Green
Write-Host '[mitm] Press ENTER to stop and clean up when you are done.' -ForegroundColor Yellow
Write-Host ''
Read-Host 'Press ENTER to stop'

# ---- 6. Cleanup on exit ----
Write-Host ''
Write-Host '[mitm] Cleaning up...' -ForegroundColor Yellow

# Disable system proxy
Set-ItemProperty -Path $proxyKey -Name ProxyEnable -Value 0
Write-Host '[mitm] system proxy disabled' -ForegroundColor Green

# Clear proxy env vars
Remove-Item Env:\HTTP_PROXY -ErrorAction SilentlyContinue
Remove-Item Env:\HTTPS_PROXY -ErrorAction SilentlyContinue
Remove-Item Env:\http_proxy -ErrorAction SilentlyContinue
Remove-Item Env:\https_proxy -ErrorAction SilentlyContinue
Remove-Item Env:\NODE_EXTRA_CA_CERTS -ErrorAction SilentlyContinue

# Stop mitmproxy if we started it
if (-not $SkipMitmproxy -and $mitmJob -and -not $mitmJob.HasExited) {
  Stop-Process -Id $mitmJob.Id -Force -ErrorAction SilentlyContinue
  Write-Host '[mitm] mitmproxy stopped' -ForegroundColor Green
}

Write-Host '[mitm] cleanup complete.' -ForegroundColor Green
