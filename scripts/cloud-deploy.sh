#!/usr/bin/env bash
# =============================================================================
# Cyber Drill Gateway - Linux Cloud One-Click Deploy
# 适用于: Ubuntu 20.04+ / Debian 11+ / CentOS 8+ (阿里云/腾讯云/华为云)
# 用法:   curl -fsSL <your-url>/cloud-deploy.sh | bash
#   或:   bash scripts/cloud-deploy.sh
# =============================================================================
set -euo pipefail

# ---- 配置区 ----
GATEWAY_PORT="${GATEWAY_PORT:-18790}"
DOMAIN="${DOMAIN:-}"                 # 留空则仅用 IP 访问，填写域名则自动申请 Let's Encrypt 证书
ENABLE_NGINX="${ENABLE_NGINX:-true}" # 是否安装 Nginx 反向代理
ENABLE_PM2="${ENABLE_PM2:-true}"     # 是否用 PM2 守护进程
PROJECT_DIR="${PROJECT_DIR:-/opt/cyber-drill-gateway}"

COLOR_GREEN='\033[0;32m'
COLOR_YELLOW='\033[1;33m'
COLOR_RED='\033[0;31m'
COLOR_RESET='\033[0m'

log_info()  { echo -e "${COLOR_GREEN}[deploy]${COLOR_RESET} $*"; }
log_warn()  { echo -e "${COLOR_YELLOW}[deploy]${COLOR_RESET} $*"; }
log_error() { echo -e "${COLOR_RED}[deploy]${COLOR_RESET} $*"; }

# ---- 1. 检测包管理器 ----
if command -v apt-get &>/dev/null; then
  PKG_MGR="apt"
elif command -v yum &>/dev/null; then
  PKG_MGR="yum"
elif command -v dnf &>/dev/null; then
  PKG_MGR="dnf"
else
  log_error "unsupported package manager. please install Node.js 18+ manually."
  exit 1
fi

install_pkg() {
  case "$PKG_MGR" in
    apt) sudo apt-get install -y "$@" ;;
    yum) sudo yum install -y "$@" ;;
    dnf) sudo dnf install -y "$@" ;;
  esac
}

# ---- 2. 安装 Node.js 18+ ----
if command -v node &>/dev/null; then
  NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VER" -ge 18 ]; then
    log_info "Node.js $(node -v) already installed."
  else
    log_warn "Node.js version too old ($(node -v)), installing 18.x..."
    curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
    install_pkg nodejs
  fi
else
  log_info "installing Node.js 18.x..."
  if [ "$PKG_MGR" = "apt" ]; then
    curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
    install_pkg nodejs
  else
    curl -fsSL https://rpm.nodesource.com/setup_18.x | sudo -E bash -
    install_pkg nodejs
  fi
fi

log_info "Node.js $(node -v) ready."

# ---- 3. 部署项目文件 ----
if [ ! -d "$PROJECT_DIR" ]; then
  log_info "creating project directory: $PROJECT_DIR"
  sudo mkdir -p "$PROJECT_DIR"
  sudo chown "$(whoami):$(whoami)" "$PROJECT_DIR"
fi

# 如果脚本在项目目录内执行，复制文件
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PARENT_DIR="$(dirname "$SCRIPT_DIR")"

if [ -f "$PARENT_DIR/src/lab-server.js" ] && [ "$PARENT_DIR" != "$PROJECT_DIR" ]; then
  log_info "copying project files to $PROJECT_DIR..."
  cp -r "$PARENT_DIR"/{src,config,scripts,docs,.env.example,package.json,README.md} "$PROJECT_DIR/" 2>/dev/null || true
fi

cd "$PROJECT_DIR"

# 创建 .env
if [ ! -f .env ]; then
  cp .env.example .env
  log_info "created .env from template."
fi

# 创建必要目录
mkdir -p logs run config

# 创建默认 accounts.json
if [ ! -f config/accounts.json ]; then
  cat > config/accounts.json << 'ACCOUNTS_EOF'
{
  "accounts": [
    {
      "id": "session-A",
      "dailyLimit": 80000,
      "enabled": true
    },
    {
      "id": "session-B",
      "dailyLimit": 80000,
      "enabled": true
    },
    {
      "id": "session-C",
      "dailyLimit": 80000,
      "enabled": true
    }
  ]
}
ACCOUNTS_EOF
  log_info "created default config/accounts.json"
fi

# 语法检查
node --check src/lab-server.js
log_info "syntax check passed."

# ---- 4. PM2 进程守护 ----
if [ "$ENABLE_PM2" = "true" ]; then
  if ! command -v pm2 &>/dev/null; then
    log_info "installing PM2..."
    sudo npm install -g pm2
  fi

  # 创建 PM2 ecosystem 配置
  cat > ecosystem.config.js << PM2_EOF
module.exports = {
  apps: [{
    name: 'cyber-drill-gateway',
    script: 'src/lab-server.js',
    cwd: '$PROJECT_DIR',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '512M',
    env: {
      NODE_ENV: 'production'
    },
    error_file: '$PROJECT_DIR/logs/pm2-error.log',
    out_file: '$PROJECT_DIR/logs/pm2-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
  }]
};
PM2_EOF

  pm2 delete cyber-drill-gateway 2>/dev/null || true
  pm2 start ecosystem.config.js
  pm2 save

  # 设置开机自启
  sudo env PATH="$PATH:/usr/bin" pm2 startup systemd -u "$(whoami)" --hp "$HOME" 2>/dev/null || true
  pm2 save

  log_info "PM2 process started and configured for auto-restart."
else
  log_info "PM2 disabled. starting gateway directly..."
  nohup node src/lab-server.js > logs/gateway.log 2>&1 &
  echo $! > run/gateway.pid
  log_info "gateway started, pid=$(cat run/gateway.pid)"
fi

# ---- 5. Nginx 反向代理 ----
if [ "$ENABLE_NGINX" = "true" ]; then
  if ! command -v nginx &>/dev/null; then
    log_info "installing Nginx..."
    install_pkg nginx
  fi

  # 生成 Nginx 配置
  NGINX_CONF="/etc/nginx/sites-available/cyber-drill-gateway"
  NGINX_ENABLED="/etc/nginx/sites-enabled/cyber-drill-gateway"

  # 如果没有 sites-available 目录 (CentOS)，用 conf.d
  if [ ! -d /etc/nginx/sites-available ]; then
    NGINX_CONF="/etc/nginx/conf.d/cyber-drill-gateway.conf"
    NGINX_ENABLED=""
  fi

  if [ -n "$DOMAIN" ]; then
    # 带域名 + TLS
    sudo tee "$NGINX_CONF" > /dev/null << NGINX_TLS_EOF
server {
    listen 80;
    server_name $DOMAIN;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
    listen 443 ssl http2;
    server_name $DOMAIN;

    ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

    location / {
        proxy_pass http://127.0.0.1:$GATEWAY_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        proxy_buffering off;
    }
}
NGINX_TLS_EOF
    log_info "Nginx TLS config written for domain: $DOMAIN"

    # 申请 Let's Encrypt 证书
    if ! command -v certbot &>/dev/null; then
      log_info "installing certbot..."
      install_pkg certbot
      if [ "$PKG_MGR" = "apt" ]; then
        install_pkg python3-certbot-nginx
      fi
    fi

    sudo mkdir -p /var/www/certbot
    sudo certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --email "admin@$DOMAIN" || {
      log_warn "certbot failed. you may need to run: sudo certbot --nginx -d $DOMAIN"
    }
  else
    # 无域名，仅 HTTP 反代
    sudo tee "$NGINX_CONF" > /dev/null << NGINX_HTTP_EOF
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://127.0.0.1:$GATEWAY_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        proxy_buffering off;
    }
}
NGINX_HTTP_EOF
    log_info "Nginx HTTP-only config written (no domain)."
  fi

  # 启用站点配置 (Debian/Ubuntu)
  if [ -n "$NGINX_ENABLED" ] && [ -d /etc/nginx/sites-enabled ]; then
    sudo rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true
    sudo ln -sf "$NGINX_CONF" "$NGINX_ENABLED"
  fi

  sudo nginx -t && sudo systemctl reload nginx
  log_info "Nginx configured and reloaded."
fi

# ---- 6. 防火墙 ----
if command -v ufw &>/dev/null; then
  sudo ufw allow 80/tcp  2>/dev/null || true
  sudo ufw allow 443/tcp 2>/dev/null || true
  sudo ufw allow 22/tcp  2>/dev/null || true
  log_info "UFW firewall rules added (80, 443, 22)."
elif command -v firewall-cmd &>/dev/null; then
  sudo firewall-cmd --permanent --add-service=http  2>/dev/null || true
  sudo firewall-cmd --permanent --add-service=https 2>/dev/null || true
  sudo firewall-cmd --reload 2>/dev/null || true
  log_info "firewalld rules added."
fi

# ---- 7. 健康检查 ----
sleep 2
HEALTH_URL="http://127.0.0.1:$GATEWAY_PORT/health"
HEALTH_OK=false
for i in $(seq 1 10); do
  if curl -sf "$HEALTH_URL" > /dev/null 2>&1; then
    HEALTH_OK=true
    break
  fi
  sleep 1
done

if [ "$HEALTH_OK" = "true" ]; then
  log_info "health check passed!"
else
  log_warn "health check failed. check logs: $PROJECT_DIR/logs/"
fi

# ---- 8. 输出摘要 ----
PUBLIC_IP=$(curl -sf http://whatismyip.akamai.com 2>/dev/null || curl -sf https://ipinfo.io/ip 2>/dev/null || echo "<your-server-ip>")

echo ""
echo "============================================"
log_info "deployment complete!"
echo "============================================"
echo ""
echo "  Gateway URL:   http://$PUBLIC_IP:$GATEWAY_PORT"
if [ "$ENABLE_NGINX" = "true" ]; then
  if [ -n "$DOMAIN" ]; then
    echo "  Public URL:    https://$DOMAIN"
  else
    echo "  Public URL:    http://$PUBLIC_IP"
  fi
fi
echo ""
echo "  Test command:"
echo "    curl -X POST http://127.0.0.1:$GATEWAY_PORT/v1/chat/completions \\"
echo "      -H 'Authorization: Bearer sk-deploy-001' \\"
echo "      -H 'Content-Type: application/json' \\"
echo "      -d '{\"model\":\"gpt-4o\",\"messages\":[{\"role\":\"user\",\"content\":\"hello\"}]}'"
echo ""
echo "  Account pool:  $PROJECT_DIR/config/accounts.json"
echo "  Logs:          $PROJECT_DIR/logs/"
echo ""
echo "  Next steps:"
echo "    1. Edit config/accounts.json - fill in apiKey + baseUrl"
echo "    2. curl -X POST http://127.0.0.1:$GATEWAY_PORT/admin/accounts/reload"
echo "    3. Run client-setup on your Windows PC"
echo "============================================"
