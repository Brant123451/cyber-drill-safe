#!/bin/bash
# =============================================================================
# Session Container Entrypoint
# 1. 用 Puppeteer 登录目标平台，提取 session token
# 2. 将 session 注册到网关
# 3. 进入保活循环，定期发心跳
# =============================================================================
set -euo pipefail

PLATFORM="${PLATFORM:-codeium}"
ACCOUNT_EMAIL="${ACCOUNT_EMAIL:-}"
ACCOUNT_PASSWORD="${ACCOUNT_PASSWORD:-}"
GATEWAY_URL="${GATEWAY_URL:-http://gateway:18790}"
KEEPALIVE_INTERVAL_MS="${KEEPALIVE_INTERVAL_MS:-300000}"

if [ -z "$ACCOUNT_EMAIL" ] || [ -z "$ACCOUNT_PASSWORD" ]; then
  echo "[session] ERROR: ACCOUNT_EMAIL and ACCOUNT_PASSWORD are required"
  exit 1
fi

echo "[session] platform=$PLATFORM email=$ACCOUNT_EMAIL gateway=$GATEWAY_URL"

# Step 1: 登录并提取 session
echo "[session] logging in..."
node src/account-automation.js login \
  --platform "$PLATFORM" \
  --email "$ACCOUNT_EMAIL" \
  --password "$ACCOUNT_PASSWORD" \
  --headless true

# Step 2: 读取提取的 session 并注册到网关
SESSION_FILE="config/sessions.json"
if [ -f "$SESSION_FILE" ]; then
  echo "[session] session extracted, registering with gateway..."

  # 通过网关 API 注册 session
  curl -sf -X POST "$GATEWAY_URL/admin/sessions/register" \
    -H "Content-Type: application/json" \
    -d @"$SESSION_FILE" \
    || echo "[session] WARNING: could not register with gateway (may not be running yet)"
fi

# Step 3: 保活循环
INTERVAL_SEC=$((KEEPALIVE_INTERVAL_MS / 1000))
echo "[session] entering keepalive loop (interval: ${INTERVAL_SEC}s)"

while true; do
  sleep "$INTERVAL_SEC"

  echo "[session] keepalive ping..."

  # 重新登录刷新 session（如果快过期）
  node src/account-automation.js login \
    --platform "$PLATFORM" \
    --email "$ACCOUNT_EMAIL" \
    --password "$ACCOUNT_PASSWORD" \
    --headless true \
    2>/dev/null || echo "[session] WARNING: keepalive login failed"

  # 通知网关更新 session
  curl -sf -X POST "$GATEWAY_URL/admin/sessions/register" \
    -H "Content-Type: application/json" \
    -d @"$SESSION_FILE" \
    2>/dev/null || echo "[session] WARNING: could not update gateway"

  echo "[session] keepalive done at $(date -Iseconds)"
done
