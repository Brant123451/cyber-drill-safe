# 部署手册

## 1. 前置条件

### 服务端（云服务器）

- Linux 服务器（Ubuntu 20.04+ / Debian 11+ / CentOS 8+）
- 2核4G 内存起步，带公网 IP
- 开放端口：80、81　18790（或全部由 Nginx 反代后只开 80/443）

### 客户端（你的 Windows 电脑）

- Windows 10/11 + PowerShell 5.1+
- Python 3.8+（用于 mitmproxy）

## 2. 服务端部署（云服务器）

### 方式 A（推荐）：Linux 一键部署

将项目文件上传到服务器后执行：

```bash
bash scripts/cloud-deploy.sh
```

自动完成：

1. 安装 Node.js 18+
2. 创建 `.env` 和 `config/accounts.json`
3. 语法检查
4. PM2 进程守护（自动重启 + 开机自启）
5. Nginx 反向代理（可选 TLS）
6. 防火墙规则
7. 健康检查验证

可配置环境变量：

```bash
# 带域名 + TLS（自动申请 Let's Encrypt 证书）
DOMAIN=your-domain.com bash scripts/cloud-deploy.sh

# 仅 IP 访问（无 TLS）
bash scripts/cloud-deploy.sh

# 自定义端口
GATEWAY_PORT=8080 bash scripts/cloud-deploy.sh
```

### 方式 B：Windows 本地部署

```powershell
npm run deploy:ps     # 后台启动
npm run restart:ps    # 重启
npm run start:ps      # 前台调试
```

## 3. 账号池配置

默认账号池配置文件：`config/accounts.json`

### 上游转发模式（生产推荐）

账号配置 `apiKey` + `baseUrl` 后，网关会将请求转发至真实 LLM API：

```json
{
  "accounts": [
    {
      "id": "deepseek-main",
      "dailyLimit": 100000,
      "enabled": true,
      "apiKey": "sk-your-deepseek-key",
      "baseUrl": "https://api.deepseek.com",
      "healthcheckUrl": "https://api.deepseek.com/v1/models"
    },
    {
      "id": "openai-backup",
      "dailyLimit": 50000,
      "enabled": true,
      "apiKey": "sk-proj-your-openai-key",
      "baseUrl": "https://api.openai.com",
      "healthcheckUrl": "https://api.openai.com/v1/models"
    }
  ]
}
```

工作原理：

- 请求抵达网关 → 令牌鉴权 + 超额检查 → 最少用量账号轮转 → 用该账号 `apiKey` 转发至 `baseUrl/v1/chat/completions`
- `stream: true` 时透传上游 SSE 流至客户端，支持实时流式输出
- 上游返回的 `usage.total_tokens` 用于配额计数
- 上游请求超时默认 120 秒，可通过 `UPSTREAM_TIMEOUT_MS` 环境变量调整

### 混合模式

同一池中可同时存在 upstream 和 simulate 账号：

```json
{
  "accounts": [
    {
      "id": "deepseek-prod",
      "dailyLimit": 100000,
      "enabled": true,
      "apiKey": "sk-xxx",
      "baseUrl": "https://api.deepseek.com"
    },
    {
      "id": "fallback-sim",
      "dailyLimit": 80000,
      "enabled": true
    }
  ]
}
```

- 未配置 `apiKey`/`baseUrl` 的账号自动进入模拟模式，返回本地生成的占位响应
- `npm run accounts:status` 会显示每个账号的 `mode`（`upstream` 或 `simulate`）

### 字段说明

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | 是 | 账号唯一标识 |
| `dailyLimit` | 否 | 每日 token 配额（默认 80000） |
| `enabled` | 否 | 是否启用（默认 true） |
| `apiKey` | 否 | 上游 API 密钥，配置后启用转发 |
| `baseUrl` | 否 | 上游 API 基址（如 `https://api.deepseek.com`） |
| `healthcheckUrl` | 否 | 健康检查地址，未配置则默认视为健康 |

- 修改账号池后执行 `npm run accounts:reload` 立即生效。

## 4. 健康检查

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:18790/health"
```

预期返回：

```json
{
  "ok": true,
  "service": "cyber-drill-safe-lab"
}
```

账号池健康状态：

```powershell
npm run accounts:status
```

## 5. 功能验证（最小请求）

你也可以直接执行自动化自检：

```powershell
npm run smoke:ps
```

手动验证方式如下：

```powershell
$body = @{
  model = 'gpt-4o'
  messages = @(
    @{ role = 'user'; content = 'hello' }
  )
} | ConvertTo-Json -Depth 6

Invoke-RestMethod -Uri "http://127.0.0.1:18790/v1/chat/completions" `
  -Method Post `
  -Headers @{ Authorization = 'Bearer sk-deploy-001' } `
  -ContentType 'application/json' `
  -Body $body
```

## 6. 日志与运维接口

- 事件日志：`logs/events.jsonl`
- 告警查看：`GET /soc/alerts`
- 事件查看：`GET /soc/events?limit=200`
- 环境重置：`POST /admin/reset`
- 号池状态：`GET /admin/accounts/status`
- 号池重载：`POST /admin/accounts/reload`
- 号池健康检查：`POST /admin/accounts/health-check`

常用运维命令：

```powershell
npm run accounts:status
npm run accounts:reload
npm run accounts:check
```

## 7. 客户端部署（HTTPS 拦截代理）

### 一键配置

在你的 Windows 电脑上执行：

```powershell
.\scripts\client-setup.ps1 `
  -GatewayUrl http://你的服务器IP:18790 `
  -GatewayToken sk-deploy-001 `
  -InterceptDomains "api.target-platform.com" `
  -ProxyPort 8080
```

自动完成：

1. 检查/安装 Python + mitmproxy
2. 生成 CA 证书并安装到 Windows 信任库
3. 生成代理启动脚本 `client/start-proxy.ps1`
4. 生成代理开关脚本 `client/enable-proxy.ps1` / `client/disable-proxy.ps1`
5. 测试网关连通性

### 使用方法

```powershell
# 终端 1：启动本地代理
powershell -File client\start-proxy.ps1

# 终端 2：开启系统代理
powershell -File client\enable-proxy.ps1

# 停止时：Ctrl+C 停止代理，然后关闭系统代理
powershell -File client\disable-proxy.ps1
```

### 工作原理

```
你的应用 (Windsurf 等)
    │ HTTPS 请求
    ▼
mitmproxy (本地 127.0.0.1:8080)
    │ 匹配 InterceptDomains 的请求 → 重写到网关
    │ 不匹配的请求 → 原样放行
    ▼
你的网关 (http://服务器IP:18790)
    │ 鉴权 → 号池轮转 → 上游转发
    ▼
DeepSeek / OpenAI API
```

### 卸载

```powershell
.\scripts\client-setup.ps1 -Uninstall
```

这会关闭系统代理。CA 证书需手动删除（`certmgr.msc` → 受信任的根证书颁发机构 → 找 mitmproxy）。

## 8. 平台会话池（Session Pool）

除了传统的 API Key 号池，系统还支持**平台会话池**——直接复用目标平台（如 Codeium/Windsurf）的登录态。

### 8.1 架构

```
用户请求 → 网关鉴权 → 路由决策：
  ├── 有 API Key 账号？ → 直接上游转发（OpenAI/DeepSeek API）
  ├── 有平台会话？    → 协议适配器转换 → 平台后端（Codeium 等）
  └── 都没有？        → 模拟响应（simulate mode）
```

### 8.2 会话配置

会话池文件：`config/sessions.json`（参考 `docs/sessions.example.json`）

```json
{
  "sessions": [
    {
      "id": "codeium-user1",
      "platform": "codeium",
      "email": "user1@example.com",
      "sessionToken": "eyJhbG...",
      "dailyLimit": 100000,
      "enabled": true,
      "expiresAt": "2025-01-02T00:00:00Z"
    }
  ]
}
```

### 8.3 会话管理命令

```bash
# 查看会话池状态
npm run sessions:status

# 重新加载 sessions.json
npm run sessions:reload

# 手动触发健康检查
npm run sessions:health

# 注册新会话（API）
curl -X POST http://127.0.0.1:18790/admin/sessions/register \
  -H "Content-Type: application/json" \
  -d '{"id":"new-session","platform":"codeium","sessionToken":"xxx"}'

# 移除会话
curl -X POST http://127.0.0.1:18790/admin/sessions/remove \
  -H "Content-Type: application/json" \
  -d '{"id":"codeium-user1"}'
```

### 8.4 自动获取会话（Puppeteer）

用 Puppeteer 自动登录目标平台并提取 session token：

```bash
# 单个账号登录
npm run automation:login -- --platform codeium --email user@example.com --password xxx

# 批量登录（从文件）
# 1. 编辑 config/accounts-input.json（参考 config/accounts-input.example.json）
# 2. 执行批量登录
npm run automation:batch -- --file config/accounts-input.json

# 查看支持的平台
npm run automation:platforms
```

⚠️ **需要安装 puppeteer**：`npm install puppeteer`

### 8.5 协议适配器

系统内置两种适配器：

| 适配器 | 平台 | 状态 |
|--------|------|------|
| `openai` | OpenAI / DeepSeek 等标准 API | ✅ 可用 |
| `codeium` | Codeium / Windsurf | 🔧 框架就绪，需填充协议细节 |

Codeium 适配器中标记 `[REVERSE-REQUIRED]` 的位置需要根据实际抓包数据填充：
- API 端点路径
- 请求/响应格式（可能是 protobuf）
- 认证 header 格式
- 心跳请求格式

文件位置：`src/protocol-adapter.js`

## 9. Docker 容器集群部署

适用于大规模会话池场景（几十到上百个账号）。

### 9.1 一键部署

```bash
bash scripts/setup-docker-cluster.sh
```

自动完成：
1. 检查/安装 Docker + Docker Compose
2. 构建网关镜像
3. 启动网关 + Nginx 容器
4. 健康检查验证

### 9.2 添加会话容器

每个平台账号运行在独立容器中，维持登录态：

```bash
# 单个账号
PLATFORM=codeium ACCOUNT_EMAIL=user@example.com ACCOUNT_PASSWORD=xxx \
  docker compose -f docker/docker-compose.yml run -d --name session-user1 session-worker

# 容器自动完成：
# 1. Puppeteer 登录 → 提取 session token
# 2. 注册到网关
# 3. 进入保活循环（定期刷新 session）
```

### 9.3 容器管理

```bash
# 查看所有容器
docker compose -f docker/docker-compose.yml ps

# 查看网关日志
docker compose -f docker/docker-compose.yml logs -f gateway

# 停止全部
docker compose -f docker/docker-compose.yml down

# 重建
docker compose -f docker/docker-compose.yml up -d --build
```

## 10. 完整部署路径

```
┌──────────────────────────────────────────────────────────────────┐
│                        云服务器                                   │
│                                                                  │
│  ┌──────────┐   ┌──────────────────────────────────────────┐    │
│  │  Nginx   │   │          Gateway (Node.js)                │    │
│  │ TLS终端  │──▶│  ┌────────────┐  ┌───────────────────┐   │    │
│  │ :80/443  │   │  │ Account    │  │ Session Manager   │   │    │
│  └──────────┘   │  │ Pool       │  │ (平台会话池)       │   │    │
│                 │  │ (API Key)  │  │                   │   │    │
│                 │  └─────┬──────┘  └────────┬──────────┘   │    │
│                 │        │                  │              │    │
│                 │        ▼                  ▼              │    │
│                 │  ┌──────────┐   ┌──────────────────┐    │    │
│                 │  │ OpenAI   │   │ Protocol Adapter │    │    │
│                 │  │ DeepSeek │   │ (协议转换层)      │    │    │
│                 │  │ API      │   │ Codeium/Windsurf │    │    │
│                 │  └──────────┘   └──────────────────┘    │    │
│                 └──────────────────────────────────────────┘    │
│                                                                  │
│  ┌──────────────────────────────────────────┐                   │
│  │ Docker Session Containers (可选)          │                   │
│  │ ┌─────────┐ ┌─────────┐ ┌─────────┐     │                   │
│  │ │ acct-1  │ │ acct-2  │ │ acct-N  │     │                   │
│  │ │Puppeteer│ │Puppeteer│ │Puppeteer│     │                   │
│  │ └─────────┘ └─────────┘ └─────────┘     │                   │
│  └──────────────────────────────────────────┘                   │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│                      你的 Windows 电脑                            │
│                                                                  │
│  Windsurf / IDE                                                  │
│       │ HTTPS                                                    │
│       ▼                                                          │
│  mitmproxy (127.0.0.1:8080)                                     │
│       │ 拦截 → 重写到网关                                         │
│       ▼                                                          │
│  ──────── 网络 ────────▶ 云服务器网关                              │
└──────────────────────────────────────────────────────────────────┘
```

## 11. 用户管理 + 积分系统

用户数据文件：`config/users.json`（首次启动自动创建，含两个默认测试用户）。

### 11.1 积分配额

每个用户拥有独立的积分上限和自动恢复周期：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `creditLimit` | 1000 | 积分上限 |
| `creditRecoveryAmount` | 1000 | 每次恢复量 |
| `creditRecoveryIntervalMs` | 10800000 (3h) | 恢复周期 |

- 每次 LLM 请求按 token 估算值扣减积分
- 积分耗尽返回 HTTP 429 + 恢复时间提示
- 定时检查 + 自动恢复（检查频率 = 最短恢复周期 / 6，至少 10 分钟）
- 每日零点额外重置所有用户积分

### 11.2 用户管理 API

```bash
# 查看所有用户
npm run users:status
# 或: GET /admin/users/status

# 创建新用户（返回完整 token，仅此一次明文可见）
curl -X POST http://127.0.0.1:18790/admin/users/create \
  -H "Content-Type: application/json" \
  -d '{"name": "用户A", "creditLimit": 2000, "note": "VIP用户"}'

# 更新用户
curl -X POST http://127.0.0.1:18790/admin/users/update \
  -H "Content-Type: application/json" \
  -d '{"id": "user-xxx", "creditLimit": 5000}'

# 删除用户
curl -X POST http://127.0.0.1:18790/admin/users/delete \
  -H "Content-Type: application/json" \
  -d '{"id": "user-xxx"}'

# 重置用户积分
curl -X POST http://127.0.0.1:18790/admin/users/reset-credits \
  -H "Content-Type: application/json" \
  -d '{"id": "user-xxx"}'

# 热重载用户配置文件
npm run users:reload
# 或: POST /admin/users/reload
```

### 11.3 用户自助接口

用户使用自己的 API Key 调用：

```bash
# 查询剩余积分
curl http://127.0.0.1:18790/v1/credits \
  -H "Authorization: Bearer sk-gw-xxx"

# 查询可用模型
curl http://127.0.0.1:18790/v1/models \
  -H "Authorization: Bearer sk-gw-xxx"
```

## 12. OpenClaw 多用户分发（模式 1）

每个用户在自己电脑上运行 OpenClaw，配置本网关作为 LLM provider。**不需要 MITM、不需要证书、不需要管理员权限。**

### 12.1 服务端（管理员操作）

1. 部署网关 + 配置上游 API Key（`config/accounts.json`）
2. 为每个用户创建账号：`POST /admin/users/create`
3. 将生成的 `sk-gw-xxx` key 和网关地址发给用户

### 12.2 用户端（一键配置）

```powershell
# 管理员在用户电脑上执行（或远程指导用户执行）
.\scripts\openclaw-setup.ps1 -GatewayUrl http://网关IP:18790 -ApiKey "sk-gw-xxx"

# 或一步到位：创建用户 + 配置 OpenClaw
.\scripts\openclaw-setup.ps1 -GatewayUrl http://网关IP:18790 -CreateUser -UserName "张三"
```

### 12.3 用户端（手动配置）

将以下内容写入 `~/.openclaw/openclaw.json`：

```json
{
  "providers": [{
    "name": "gateway-relay",
    "api": "openai-completions",
    "baseUrl": "http://网关IP:18790/v1",
    "apiKey": "sk-gw-管理员分配的key",
    "models": [
      { "id": "deepseek-chat", "name": "DeepSeek Chat", "contextWindow": 65536, "maxTokens": 8192 },
      { "id": "gpt-4o", "name": "GPT-4o", "contextWindow": 128000, "maxTokens": 16384 },
      { "id": "claude-sonnet-4-20250514", "name": "Claude Sonnet 4", "contextWindow": 200000, "maxTokens": 16384 }
    ]
  }],
  "agents": {
    "defaults": {
      "model": { "primary": "deepseek-chat" }
    }
  }
}
```

然后启动：`node dist/entry.js gateway run --port 18789`

参考配置示例：`docs/openclaw-provider.example.json`

## 13. 生产建议

1. 为每个账号配置 `apiKey` + `baseUrl` 启用真实上游转发。
2. 配置防火墙，仅允许授权来源访问网关。
3. 带域名部署时使用 `DOMAIN=xxx bash scripts/cloud-deploy.sh` 自动申请 TLS 证书。
4. 用量计数器每日零点自动重置，无需手动干预。
5. 平台会话有过期时间，使用 Docker 容器自动保活。
6. OpenClaw 直连模式下，建议为网关启用 HTTPS（Nginx 反代 + Let's Encrypt）。

## 14. 仅需手动处理项

1. 买云服务器 + 开端口。
2. 获取 LLM API Key 或平台账号。
3. 填入 `config/accounts.json`（API Key 模式）或 `config/sessions.json`（平台会话模式）。
4. 如果走 MITM 代理路线：确定拦截域名 + 客户端安装 Python 3.8+。
5. 如果走 OpenClaw 直连：为每个用户 `POST /admin/users/create`，分发 key。
6. 如果走 Puppeteer 自动登录：`npm install puppeteer` + 填写 `config/accounts-input.json`。
7. Codeium 适配器中 `[REVERSE-REQUIRED]` 部分需要根据抓包数据填充。
