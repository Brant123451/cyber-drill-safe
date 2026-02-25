# =============================================================================
# Cyber Drill Gateway - Windows Client Setup
# Installs mitmproxy, generates CA cert, configures system proxy
# =============================================================================
param(
  [string]$GatewayUrl = '',
  [string]$GatewayToken = 'sk-deploy-001',
  [string]$InterceptDomains = '',
  [int]$ProxyPort = 8080,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$scriptRoot = Split-Path -Parent $PSScriptRoot
$clientDir = Join-Path $scriptRoot 'client'

# ---- Uninstall mode ----
if ($Uninstall) {
  Write-Host '[client] removing system proxy settings...' -ForegroundColor Yellow

  $proxyKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
  Set-ItemProperty -Path $proxyKey -Name ProxyEnable -Value 0
  Remove-ItemProperty -Path $proxyKey -Name ProxyServer -ErrorAction SilentlyContinue
  Remove-ItemProperty -Path $proxyKey -Name ProxyOverride -ErrorAction SilentlyContinue

  Write-Host '[client] system proxy disabled.' -ForegroundColor Green
  Write-Host '[client] to remove mitmproxy CA cert, open certmgr.msc -> Trusted Root -> find mitmproxy' -ForegroundColor Yellow
  return
}

# ---- Validate params ----
if (-not $GatewayUrl) {
  Write-Host ''
  Write-Host '============================================' -ForegroundColor Red
  Write-Host '  ERROR: GatewayUrl is required!' -ForegroundColor Red
  Write-Host '' -ForegroundColor Red
  Write-Host '  Usage:' -ForegroundColor Yellow
  Write-Host '    .\client-setup.ps1 -GatewayUrl http://1.2.3.4:18790 -InterceptDomains "api.example.com"' -ForegroundColor Cyan
  Write-Host '' -ForegroundColor Yellow
  Write-Host '  Parameters:' -ForegroundColor Yellow
  Write-Host '    -GatewayUrl        Your gateway server URL (required)' -ForegroundColor White
  Write-Host '    -GatewayToken      Gateway auth token (default: sk-deploy-001)' -ForegroundColor White
  Write-Host '    -InterceptDomains  Comma-separated domains to intercept (required)' -ForegroundColor White
  Write-Host '    -ProxyPort         Local proxy port (default: 8080)' -ForegroundColor White
  Write-Host '    -Uninstall         Remove proxy settings' -ForegroundColor White
  Write-Host '============================================' -ForegroundColor Red
  Write-Host ''
  return
}

if (-not $InterceptDomains) {
  Write-Host '[client] WARNING: InterceptDomains is empty. No requests will be intercepted.' -ForegroundColor Yellow
  Write-Host '[client] Set -InterceptDomains "domain1.com,domain2.com" to enable interception.' -ForegroundColor Yellow
}

# ---- 1. Check/Install Python ----
Write-Host '[client] checking Python...' -ForegroundColor Cyan
$pythonCmd = $null
if (Get-Command python3 -ErrorAction SilentlyContinue) {
  $pythonCmd = 'python3'
} elseif (Get-Command python -ErrorAction SilentlyContinue) {
  $pyVer = & python --version 2>&1
  if ($pyVer -match 'Python 3') {
    $pythonCmd = 'python'
  }
}

if (-not $pythonCmd) {
  Write-Host '[client] Python 3 not found. Please install Python 3.8+ from https://python.org' -ForegroundColor Red
  Write-Host '[client] Make sure to check "Add Python to PATH" during installation.' -ForegroundColor Yellow
  return
}

Write-Host "[client] Python found: $(& $pythonCmd --version)" -ForegroundColor Green

# ---- 2. Install mitmproxy ----
Write-Host '[client] checking mitmproxy...' -ForegroundColor Cyan
$hasMitmproxy = Get-Command mitmproxy -ErrorAction SilentlyContinue

if (-not $hasMitmproxy) {
  Write-Host '[client] installing mitmproxy via pip...' -ForegroundColor Yellow
  & $pythonCmd -m pip install mitmproxy --quiet
  if ($LASTEXITCODE -ne 0) {
    Write-Host '[client] pip install failed. try: pip install mitmproxy' -ForegroundColor Red
    return
  }
}

$mitmVersion = & mitmproxy --version 2>&1 | Select-Object -First 1
Write-Host "[client] mitmproxy ready: $mitmVersion" -ForegroundColor Green

# ---- 3. Create client working directory ----
if (-not (Test-Path $clientDir)) {
  New-Item -ItemType Directory -Path $clientDir | Out-Null
}

# ---- 4. Generate CA certificate (first run of mitmdump creates it) ----
Write-Host '[client] generating CA certificate...' -ForegroundColor Cyan
$mitmproxyHome = Join-Path $env:USERPROFILE '.mitmproxy'
$caCertPem = Join-Path $mitmproxyHome 'mitmproxy-ca-cert.pem'
$caCertP12 = Join-Path $mitmproxyHome 'mitmproxy-ca-cert.p12'

if (-not (Test-Path $caCertPem)) {
  # Run mitmdump briefly to generate CA
  $tempProc = Start-Process mitmdump -ArgumentList '--listen-port', '0', '--set', 'connection_strategy=lazy' -PassThru -WindowStyle Hidden
  Start-Sleep -Seconds 3
  Stop-Process -Id $tempProc.Id -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
}

if (Test-Path $caCertPem) {
  Write-Host "[client] CA cert exists: $caCertPem" -ForegroundColor Green
} else {
  Write-Host '[client] WARNING: CA cert not found. mitmproxy may not have generated it.' -ForegroundColor Yellow
}

# ---- 5. Install CA certificate to Windows trust store ----
Write-Host '[client] installing CA cert to Windows trust store...' -ForegroundColor Cyan
Write-Host '[client] (this requires admin privileges - a UAC prompt may appear)' -ForegroundColor Yellow

$certInstallScript = @"
try {
  `$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2('$caCertPem')
  `$store = New-Object System.Security.Cryptography.X509Certificates.X509Store('Root', 'CurrentUser')
  `$store.Open('ReadWrite')

  `$existing = `$store.Certificates | Where-Object { `$_.Thumbprint -eq `$cert.Thumbprint }
  if (`$existing) {
    Write-Host '[client] CA cert already installed in trust store.' -ForegroundColor Green
  } else {
    `$store.Add(`$cert)
    Write-Host '[client] CA cert installed to CurrentUser\Root trust store.' -ForegroundColor Green
  }
  `$store.Close()
} catch {
  Write-Host "[client] WARNING: could not install cert automatically: `$_" -ForegroundColor Yellow
  Write-Host '[client] Manual install: double-click $caCertPem -> Install -> Current User -> Trusted Root' -ForegroundColor Yellow
}
"@

Invoke-Expression $certInstallScript

# ---- 6. Create startup script ----
$addonPath = Join-Path $scriptRoot 'scripts' 'mitmproxy-addon.py'
$startScript = Join-Path $clientDir 'start-proxy.ps1'

$startContent = @"
# Auto-generated proxy startup script
`$env:GATEWAY_URL = '$GatewayUrl'
`$env:GATEWAY_TOKEN = '$GatewayToken'
`$env:INTERCEPT_DOMAINS = '$InterceptDomains'

Write-Host '[proxy] starting mitmproxy on port $ProxyPort...' -ForegroundColor Cyan
Write-Host "[proxy] gateway: $GatewayUrl" -ForegroundColor Cyan
Write-Host "[proxy] intercept: $InterceptDomains" -ForegroundColor Cyan
Write-Host '[proxy] press Ctrl+C to stop' -ForegroundColor Yellow
Write-Host ''

mitmdump --listen-port $ProxyPort -s '$addonPath' --set connection_strategy=lazy
"@

Set-Content -LiteralPath $startScript -Value $startContent -Encoding utf8
Write-Host "[client] created: $startScript" -ForegroundColor Green

# ---- 7. Create system proxy toggle scripts ----
$enableProxyScript = Join-Path $clientDir 'enable-proxy.ps1'
$enableContent = @"
# Enable system proxy pointing to local mitmproxy
`$proxyKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
Set-ItemProperty -Path `$proxyKey -Name ProxyEnable -Value 1
Set-ItemProperty -Path `$proxyKey -Name ProxyServer -Value '127.0.0.1:$ProxyPort'
Set-ItemProperty -Path `$proxyKey -Name ProxyOverride -Value '<local>;localhost;127.0.0.1'
Write-Host '[proxy] system proxy enabled -> 127.0.0.1:$ProxyPort' -ForegroundColor Green
"@
Set-Content -LiteralPath $enableProxyScript -Value $enableContent -Encoding utf8

$disableProxyScript = Join-Path $clientDir 'disable-proxy.ps1'
$disableContent = @"
# Disable system proxy
`$proxyKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
Set-ItemProperty -Path `$proxyKey -Name ProxyEnable -Value 0
Write-Host '[proxy] system proxy disabled' -ForegroundColor Green
"@
Set-Content -LiteralPath $disableProxyScript -Value $disableContent -Encoding utf8

Write-Host "[client] created: $enableProxyScript" -ForegroundColor Green
Write-Host "[client] created: $disableProxyScript" -ForegroundColor Green

# ---- 8. Test gateway connectivity ----
Write-Host '[client] testing gateway connectivity...' -ForegroundColor Cyan
try {
  $healthResult = Invoke-RestMethod -Uri "$GatewayUrl/health" -TimeoutSec 5
  if ($healthResult.ok -eq $true) {
    Write-Host "[client] gateway reachable: $GatewayUrl" -ForegroundColor Green
  } else {
    Write-Host "[client] gateway responded but unexpected format." -ForegroundColor Yellow
  }
} catch {
  Write-Host "[client] WARNING: cannot reach gateway at $GatewayUrl" -ForegroundColor Yellow
  Write-Host "[client] make sure the gateway is running and the URL is correct." -ForegroundColor Yellow
}

# ---- 9. Summary ----
Write-Host ''
Write-Host '============================================' -ForegroundColor Green
Write-Host '  Client setup complete!' -ForegroundColor Green
Write-Host '============================================' -ForegroundColor Green
Write-Host ''
Write-Host '  Step 1: Start the local proxy' -ForegroundColor White
Write-Host "    powershell -File $startScript" -ForegroundColor Cyan
Write-Host ''
Write-Host '  Step 2: Enable system proxy (in another terminal)' -ForegroundColor White
Write-Host "    powershell -File $enableProxyScript" -ForegroundColor Cyan
Write-Host ''
Write-Host '  Step 3: Use your app normally - intercepted traffic goes through gateway' -ForegroundColor White
Write-Host ''
Write-Host '  To stop: Ctrl+C the proxy, then run:' -ForegroundColor White
Write-Host "    powershell -File $disableProxyScript" -ForegroundColor Cyan
Write-Host ''
Write-Host '  Or uninstall everything:' -ForegroundColor White
Write-Host '    .\client-setup.ps1 -Uninstall' -ForegroundColor Cyan
Write-Host '============================================' -ForegroundColor Green
