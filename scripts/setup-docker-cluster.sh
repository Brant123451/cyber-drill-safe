#!/bin/bash
# =============================================================================
# Docker 集群一键部署脚本
# 用法: bash scripts/setup-docker-cluster.sh
#
# 功能：
#   1. 检查/安装 Docker + Docker Compose
#   2. 构建镜像
#   3. 启动网关 + Nginx
#   4. 健康检查
#   5. 提供添加会话容器的命令
# =============================================================================
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

log()  { echo -e "${GREEN}[setup]${NC} $*"; }
warn() { echo -e "${YELLOW}[setup]${NC} $*"; }
err()  { echo -e "${RED}[setup]${NC} $*"; }

# ---- Step 1: Docker 检查 ----
log "checking Docker..."
if ! command -v docker &>/dev/null; then
  warn "Docker not found. Installing..."
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker "$USER"
  log "Docker installed. You may need to log out and back in."
fi

if ! docker compose version &>/dev/null && ! docker-compose version &>/dev/null; then
  warn "Docker Compose not found. Installing plugin..."
  sudo apt-get update && sudo apt-get install -y docker-compose-plugin 2>/dev/null \
    || sudo pip3 install docker-compose 2>/dev/null \
    || { err "Could not install Docker Compose. Please install manually."; exit 1; }
fi

COMPOSE_CMD="docker compose"
if ! $COMPOSE_CMD version &>/dev/null; then
  COMPOSE_CMD="docker-compose"
fi

log "Docker: $(docker --version)"
log "Compose: $($COMPOSE_CMD version 2>/dev/null || echo 'available')"

# ---- Step 2: 配置文件 ----
log "checking config files..."

if [ ! -f ".env" ]; then
  cp .env.example .env
  log "created .env from .env.example"
fi

if [ ! -f "config/accounts.json" ]; then
  mkdir -p config
  cp docs/accounts.example.json config/accounts.json 2>/dev/null || \
  echo '{"accounts":[{"id":"session-A","dailyLimit":80000,"enabled":true}]}' > config/accounts.json
  log "created config/accounts.json"
fi

mkdir -p logs run config

# ---- Step 3: 构建并启动 ----
log "building and starting containers..."
cd docker
$COMPOSE_CMD build gateway
$COMPOSE_CMD up -d gateway nginx
cd ..

# ---- Step 4: 健康检查 ----
log "waiting for gateway to start..."
GATEWAY_PORT="${GATEWAY_PORT:-18790}"
for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:${GATEWAY_PORT}/health" >/dev/null 2>&1; then
    log "gateway is healthy!"
    break
  fi
  if [ "$i" -eq 30 ]; then
    err "gateway did not start within 30 seconds"
    $COMPOSE_CMD -f docker/docker-compose.yml logs gateway
    exit 1
  fi
  sleep 1
done

# ---- Step 5: 显示状态 ----
echo ""
log "======================================"
log "  Docker Cluster Deployed!"
log "======================================"
echo ""
log "Gateway:  http://127.0.0.1:${GATEWAY_PORT}"
log "Nginx:    http://127.0.0.1:80"
echo ""
log "管理命令："
echo "  查看状态:     $COMPOSE_CMD -f docker/docker-compose.yml ps"
echo "  查看日志:     $COMPOSE_CMD -f docker/docker-compose.yml logs -f gateway"
echo "  账号池状态:   curl http://127.0.0.1:${GATEWAY_PORT}/admin/accounts/status"
echo "  会话池状态:   curl http://127.0.0.1:${GATEWAY_PORT}/admin/sessions/status"
echo ""
log "添加会话容器（每个账号一个）："
echo "  PLATFORM=codeium ACCOUNT_EMAIL=user@example.com ACCOUNT_PASSWORD=xxx \\"
echo "    $COMPOSE_CMD -f docker/docker-compose.yml run -d --name session-user1 session-worker"
echo ""
log "批量添加会话："
echo "  1. 编辑 config/accounts-input.json（参考 config/accounts-input.example.json）"
echo "  2. node src/account-automation.js batch --file config/accounts-input.json"
echo ""
