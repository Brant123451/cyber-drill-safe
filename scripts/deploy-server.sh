#!/bin/bash
# Deploy Wind server to Aliyun ECS
# Usage: bash scripts/deploy-server.sh [user@host]

set -e

HOST="${1:-root@47.84.31.126}"
REMOTE_DIR="/opt/wind-server"

echo "=== Deploying to $HOST:$REMOTE_DIR ==="

# 1. Create remote directory
ssh "$HOST" "mkdir -p $REMOTE_DIR/config $REMOTE_DIR/data $REMOTE_DIR/logs"

# 2. Upload source files (exclude node_modules, client, .git, captures)
rsync -avz --progress \
  --exclude 'node_modules' \
  --exclude 'client' \
  --exclude '.git' \
  --exclude 'captures' \
  --exclude 'data/*.db' \
  --exclude 'logs/' \
  ./ "$HOST:$REMOTE_DIR/"

# 3. Install dependencies on server
ssh "$HOST" "cd $REMOTE_DIR && npm install --omit=dev"

# 4. Initialize database + seed
ssh "$HOST" "cd $REMOTE_DIR && node scripts/seed-db.mjs || true"

# 5. Create systemd service
ssh "$HOST" "cat > /etc/systemd/system/wind-server.service << 'EOF'
[Unit]
Description=Wind API + Gateway Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/wind-server
ExecStart=/usr/bin/node src/start-server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=API_HOST=0.0.0.0
Environment=HOST=0.0.0.0

[Install]
WantedBy=multi-user.target
EOF"

# 6. Enable and start service
ssh "$HOST" "systemctl daemon-reload && systemctl enable wind-server && systemctl restart wind-server"

# 7. Check status
sleep 2
ssh "$HOST" "systemctl status wind-server --no-pager -l"

echo ""
echo "=== Deploy complete ==="
echo "API:     http://$HOST:18800"
echo "Gateway: http://$HOST:18790"
echo ""
echo "Check health:"
echo "  curl http://${HOST##*@}:18800/api/health"
echo "  curl http://${HOST##*@}:18790/health"
