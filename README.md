# Cyber Drill Gateway（部署交付版）

> 完整的 HTTPS 拦截 + 网关转发 + 号池轮转 + 平台会话池方案。服务端一键部署，客户端一键代理，支持 Docker 容器集群。

## 1) 交付内容

已交付的运行核心：

- API 网关服务：`src/lab-server.js`
- 环境模板：`.env.example`
- 部署说明：`README.md`（本文件） + `docs/DEPLOYMENT.md`

## 2) 目录结构

```text
cyber-drill-safe-lab/
├─ .env.example
├─ package.json
├─ ecosystem.config.js              # PM2 进程守护配置
├─ README.md
├─ config/
│  ├─ accounts.json                  # API Key 号池配置
│  ├─ sessions.json                  # 平台会话池配置（运行时生成）
│  └─ accounts-input.example.json    # 批量登录账号模板
├─ docs/
│  ├─ accounts.example.json
│  ├─ sessions.example.json          # 会话池配置示例
│  ├─ DEPLOYMENT.md
│  └─ openclaw-provider.example.json
├─ docker/
│  ├─ docker-compose.yml             # Docker 集群编排
│  ├─ Dockerfile.gateway             # 网关镜像
│  ├─ Dockerfile.session             # 会话容器镜像（Puppeteer）
│  ├─ session-entrypoint.sh          # 容器启动脚本
│  └─ nginx.conf                     # Nginx 反代配置
├─ scripts/
│  ├─ cloud-deploy.sh                # ⚡ Linux 云服务器一键部署
│  ├─ setup-docker-cluster.sh        # ⚡ Docker 集群一键部署
│  ├─ client-setup.ps1               # ⚡ Windows 客户端一键配置
│  ├─ mitmproxy-addon.py             # ⚡ HTTPS 拦截转发插件
│  ├─ account-pool.ps1
│  ├─ deploy-gateway.ps1
│  ├─ restart-gateway.ps1
│  ├─ setup-gateway.ps1
│  ├─ smoke-test.ps1
│  └─ start-gateway.ps1
└─ src/
   ├─ lab-server.js                  # 网关核心（鉴权/轮转/转发/审计）
   ├─ session-manager.js             # 平台会话生命周期管理
   ├─ protocol-adapter.js            # 协议转换层（OpenAI ↔ 平台私有格式）
   └─ account-automation.js          # Puppeteer 自动登录 + Session 提取
```

## 3) 完整部署流程

```
你的 Windows 电脑（客户端）            云服务器（服务端）
┌──────────────────────────┐   ┌───────────────────────────┐
│ Windsurf / 其他客户端      │   │ Nginx (TLS) + PM2          │
│       │                    │   │       │                     │
│       ▼                    │   │       ▼                     │
│ mitmproxy (本地代理)    │──▶│ Gateway (网关核心)         │
│  拦截 HTTPS + 转发       │   │  ┌─────────┐ ┌──────────┐ │
└──────────────────────────┘   │  │API Key  │ │Session   │ │
                               │  │号池     │ │会话池    │ │
                               │  └────┬────┘ └────┬─────┘ │
                               │       │           │       │
                               │       ▼           ▼       │
                               │  DeepSeek/   Codeium/     │
                               │  OpenAI API  Windsurf后端  │
                               └───────────────────────────┘
```

### Step 1：服务端部署（云服务器）

```bash
# 在阿里云/腾讯云 Linux 服务器上执行
bash scripts/cloud-deploy.sh
```

自动完成：安装 Node.js → 部署网关 → PM2 进程守护 → Nginx 反代 → 防火墙 → 健康检查

然后编辑 `config/accounts.json`，填入你的 API Key：

```bash
vim config/accounts.json   # 填入 apiKey + baseUrl
curl -X POST http://127.0.0.1:18790/admin/accounts/reload
```

### Step 2：客户端配置（你的 Windows 电脑）

```powershell
.\scripts\client-setup.ps1 -GatewayUrl http://你的服务器IP:18790 -InterceptDomains "api.example.com"
```

自动完成：安装 mitmproxy → 生成 CA 证书 → 安装到信任库 → 生成启动脚本

### Step 3：启动拦截

```powershell
# 终端 1：启动本地代理
powershell -File client\start-proxy.ps1

# 终端 2：开启系统代理
powershell -File client\enable-proxy.ps1
```

### Windows 本地部署（备用）

```powershell
npm run deploy:ps     # 一键启动
npm run restart:ps    # 重启
```

## 4) 已内置能力

1. Bearer Token 鉴权
2. 每用户配额限制
3. 账号池最小使用量轮转（来自 `config/accounts.json`）
4. **上游转发模式**：账号配置 `apiKey` + `baseUrl` 后自动转发至真实 LLM API
5. **SSE 流式支持**：`stream: true` 时透传上游 SSE 流至客户端
6. **混合模式**：同一池中可同时存在 upstream / platform / simulate 账号
7. 账号健康检查自动摘除与恢复
8. **每日零点自动重置**用量计数器
9. 事件日志落盘（`logs/events.jsonl`）
10. **平台会话池**：直接复用目标平台登录态（session token），通过协议适配器转发
11. **协议适配器**：插件式架构，支持 OpenAI 直通 + Codeium/Windsurf 格式转换
12. **Puppeteer 自动登录**：批量自动登录目标平台并提取 session
13. **Docker 容器集群**：每个账号独立容器，自动保活
14. **文件驱动用户管理**：`config/users.json`，支持热重载
15. **积分配额系统**：每用户独立积分上限 + 定时自动恢复（默认 1000 积分 / 3 小时恢复）
16. **用户自助接口**：`GET /v1/credits` 查询剩余积分、`GET /v1/models` 查询可用模型
17. **OpenClaw 直连模式**：用户本地部署 OpenClaw，配置网关为 provider，零 MITM
18. 号池运维命令：
    - `npm run accounts:status` / `accounts:reload` / `accounts:check`
    - `npm run sessions:status` / `sessions:reload` / `sessions:health`
    - `npm run users:status` / `users:reload` / `users:create`
    - `npm run automation:login` / `automation:batch` / `automation:platforms`
19. 运维 API：
    - `GET /admin/accounts/status` · `POST /admin/accounts/reload`
    - `GET /admin/sessions/status` · `POST /admin/sessions/register`
    - `POST /admin/sessions/reload` · `POST /admin/sessions/remove`
    - `GET /admin/users/status` · `POST /admin/users/create` · `POST /admin/users/update`
    - `POST /admin/users/delete` · `POST /admin/users/reset-credits` · `POST /admin/users/reload`
    - `GET /v1/models` · `GET /v1/credits`
    - `GET /health` · `GET /soc/events` · `GET /soc/alerts`

## 5) API 接入示例

```http
POST /v1/chat/completions
Authorization: Bearer sk-deploy-001
Content-Type: application/json

{
  "model": "gpt-4o",
  "messages": [
    {"role": "user", "content": "hello"}
  ]
}
```

## 6) 交付验收（部署方）

1. `npm run setup:ps` 一次通过
2. `npm run deploy:ps` 成功并生成 `run/gateway.pid`
3. `npm run smoke:ps` 通过
4. `npm run accounts:status` 返回账号池状态
5. `/health` 返回 200
6. `/v1/chat/completions` 用有效 token 返回 200
7. `logs/events.jsonl` 持续写入

## 7) 三种运行模式

| 模式 | 号池来源 | 客户端 | 适用场景 |
|------|----------|--------|----------|
| **API Key 模式** | `config/accounts.json`（apiKey + baseUrl） | MITM 代理 / OpenClaw | 你有 DeepSeek/OpenAI 等 API Key |
| **平台会话模式** | `config/sessions.json`（session token） | MITM 代理 | 复用 Codeium/Windsurf 等平台登录态 |
| **OpenClaw 直连** | 同 API Key 模式 | OpenClaw 本地部署 | 多用户分发，零 MITM |

后端号池可混合使用，网关优先 API Key 号池，耗尽后切换到平台会话池。

## 8) OpenClaw 多用户分发（模式 1）

**最推荐的接入方式**：每个用户在自己电脑上运行 OpenClaw，配置网关作为 LLM provider。

```
用户A (OpenClaw)  用户B (OpenClaw)  用户C (OpenClaw)
      │                │                │
      └────────────────┼────────────────┘
                       │
                       ▼
              本网关 (协议转发 + 积分计量)
                       │
                       ▼
              上游 LLM API / 平台会话池
```

### 一键配置（管理员为用户开户 + 配置 OpenClaw）

```powershell
# 方式 A：一键创建用户 + 配置 OpenClaw
.\scripts\openclaw-setup.ps1 -GatewayUrl http://网关IP:18790 -CreateUser -UserName "张三"

# 方式 B：已有 key，只配置 OpenClaw
.\scripts\openclaw-setup.ps1 -GatewayUrl http://网关IP:18790 -ApiKey "sk-gw-xxx"
```

### 手动配置

1. 管理员创建用户并获取 key：

```bash
curl -X POST http://网关IP:18790/admin/users/create \
  -H "Content-Type: application/json" \
  -d '{"name": "张三", "creditLimit": 1000}'
# 返回 { "ok": true, "user": { "token": "sk-gw-xxx...", ... } }
```

2. 用户将以下内容写入 `~/.openclaw/openclaw.json`：

```json
{
  "providers": [{
    "name": "gateway-relay",
    "api": "openai-completions",
    "baseUrl": "http://网关IP:18790/v1",
    "apiKey": "sk-gw-xxx（管理员分配的key）",
    "models": [
      { "id": "deepseek-chat", "name": "DeepSeek Chat", "contextWindow": 65536, "maxTokens": 8192 },
      { "id": "gpt-4o", "name": "GPT-4o", "contextWindow": 128000, "maxTokens": 16384 }
    ]
  }],
  "agents": { "defaults": { "model": { "primary": "deepseek-chat" } } }
}
```

3. 启动 OpenClaw：`node dist/entry.js gateway run --port 18789`

### 用户自助查询积分

```bash
curl http://网关IP:18790/v1/credits -H "Authorization: Bearer sk-gw-xxx"
```

### 优势

- **零 MITM**：不装证书、不改 HOSTS、不需管理员权限
- **完全隔离**：文件/终端操作在用户本地，网关只看到 LLM 请求
- **用户体验**：和直接用 OpenClaw + 官方 API 完全一致

## 9) 用户管理 + 积分系统

用户配置文件：`config/users.json`（首次启动自动创建）

### 积分恢复机制

- 每个用户有独立积分上限（默认 1000）
- 每次 LLM 请求扣减 token 估算值
- 定时自动恢复积分（默认每 3 小时恢复 1000 积分）
- 积分耗尽返回 429 + 恢复时间提示

### 用户管理命令

```bash
# 查看所有用户状态
npm run users:status

# 创建新用户（API）
curl -X POST http://127.0.0.1:18790/admin/users/create \
  -H "Content-Type: application/json" \
  -d '{"name": "新用户", "creditLimit": 2000}'

# 重置用户积分
curl -X POST http://127.0.0.1:18790/admin/users/reset-credits \
  -H "Content-Type: application/json" \
  -d '{"id": "user-xxx"}'

# 热重载用户配置
npm run users:reload
```

### 用户配置字段

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `name` | — | 显示名称 |
| `token` | 自动生成 `sk-gw-xxx` | API Key |
| `creditLimit` | 1000 | 积分上限 |
| `creditRecoveryAmount` | 1000 | 每次恢复量 |
| `creditRecoveryIntervalMs` | 10800000 (3h) | 恢复周期 |
| `enabled` | true | 是否启用 |

## 10) 仅需你手动操作的部分

1. 买一台云服务器（阿里云/腾讯云，2核4G 即可）。
2. 获取号源：API Key 或平台账号。
3. 填入配置：`config/accounts.json` 或 `config/sessions.json`。
4. 如果走 MITM 代理：确定拦截域名，安装 Python 3.8+。
5. 如果走 OpenClaw 直连：为每个用户创建账号（`/admin/users/create`），分发 key。
6. 如果走 Puppeteer 自动登录：`npm install puppeteer`。
7. Codeium 适配器需根据抓包数据填充 `[REVERSE-REQUIRED]` 部分（`src/protocol-adapter.js`）。

## 11) 注意事项

1. 本项目用于授权测试与内网部署。
2. 客户端拦截依赖 mitmproxy，需要 Python 3.8+ 和 CA 证书信任。
3. 生产上线前建议将内置测试 token 换为你方签发体系。
4. 平台会话有过期时间，需使用 Docker 容器或定时任务自动保活。

