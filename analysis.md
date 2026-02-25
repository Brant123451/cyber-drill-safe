# MITM 代理 LLM 服务技术架构分析

> 本文档从纯技术角度分析中间人代理（MITM）架构在 LLM 服务转发场景中的应用机制。

---

## 一、总体架构

```
客户端（安装 MITM 证书 + 本地代理）
    │
    │  被代理的 HTTPS 流量
    ▼
中转服务器（如 windocker01.lgtc.top）
    │
    │  账号池轮换：从多个账号中选择一个
    ▼
目标平台官方后端（如 Windsurf/Codeium 服务器）
    │
    │  平台持有的企业级 API key
    ▼
上游 LLM 提供商（OpenAI / Anthropic / Google 等）
```

---

## 二、服务端架构

### 2.1 账号池系统

**目的**：维护一批目标平台的有效登录态（session），用于轮换分摊限额。

**账号来源途径**：
- 批量注册试用账号
- 企业子账号分配
- 共享账号模式
- 虚拟身份注册

**账号池维护机制**：
- 每个账号运行在独立环境中（Docker 容器 / 虚拟机），模拟独立客户端
- 维持心跳保活（定期模拟活动，防止 session 过期）
- 账号失效后自动替换新账号
- 监控每个账号的剩余限额，均衡分配请求

**服务器架构示例**：
```
windocker01.lgtc.top
├── nginx / caddy（反向代理，TLS 终端）
├── 调度服务（接收客户端请求 → 选号 → 转发 → 返回）
├── 账号池管理（账号健康检查、限额监控、自动替换）
├── 用户鉴权（验证 sk-ws-01-xxx 令牌 → 检查账户状态）
├── 用量记录（每个用户用量统计，防超额）
└── Docker 容器集群
    ├── container-001: 账号 A 的 session
    ├── container-002: 账号 B 的 session
    ├── container-003: 账号 C 的 session
    └── ... (几十到上百个)
```

### 2.2 协议逆向分析

服务提供者需要分析目标平台客户端与后端之间的通信协议：
- 抓包分析请求格式（URL、Headers、Body 结构）
- 分析认证机制（session token 格式、刷新逻辑、设备指纹）
- 分析响应格式（流式 SSE / WebSocket / 普通 JSON）
- 编写协议转换层（客户端请求格式 ↔ 目标平台私有格式）

### 2.3 用户令牌系统

自建用户管理体系：
- 用户注册后生成令牌（如 `sk-ws-01-0002o0L6OHZd...`）
- 令牌有时效性（按天/按周）
- 中转服务器验证令牌后才转发请求
- 令牌格式解读：`sk-ws-01-` 前缀可能表示 "secret key - windsurf - 服务器编号01"

---

## 三、客户端架构

### 3.1 客户端部署流程

1. **获取客户端程序**：下载 exe 或安装包
2. **运行客户端**（需管理员权限）：
   - 自动生成并安装自签名 Root CA 证书到系统信任库
   - 启动本地 MITM 代理（监听本地端口，如 127.0.0.1:8888）
   - 设置系统代理 或 修改目标应用的网络配置
3. **输入服务提供方分配的 API key**（如 `sk-ws-01-xxx`）
4. **正常使用目标应用**：所有请求被透明拦截和转发

### 3.2 MITM 代理工作原理

```
目标应用客户端发起 HTTPS 请求
    → 连接到 api.codeium.com:443
    → 实际被系统代理重定向到 127.0.0.1:8888（本地代理）

本地 MITM 代理：
    1. 用自签名 CA 动态生成 api.codeium.com 的证书
    2. 目标应用验证证书 → 因 CA 已在系统信任库中 → 验证通过
    3. 代理解密请求明文
    4. 提取 LLM 请求内容（模型名、messages、参数等）
    5. 附加用户令牌（sk-ws-01-xxx）
    6. 转发到中转服务器（windocker01.lgtc.top）
    7. 中转服务器用账号池向官方发起请求
    8. 官方返回 LLM 响应
    9. 中转服务器将响应原路返回给本地代理
   10. 本地代理将响应重新加密，返回给目标应用客户端
   11. 目标应用客户端正常显示结果（完全透明）
```

### 3.3 客户端安全影响

- **流量可被解密**：安装根证书后，所有经过代理的 HTTPS 流量可被中间解密
- **数据传输经过第三方服务器**：所有 LLM 请求和响应经过中转服务器
- **响应可被修改**：中转服务器理论上可在响应中注入内容
- **客户端程序风险**：exe 程序本身可能包含未声明的功能

---

## 四、OpenClaw 兼容方案

OpenClaw 允许用户自定义 LLM API 地址，服务提供者可通过以下方式集成：

### 方式 A：提供 OpenAI-compatible API 端点

这种方式**不需要 MITM 证书**，因为 OpenClaw 支持自定义 API 地址。

**服务端实现**：
```
1. 在中转服务器上暴露 OpenAI-compatible API 端点：
   https://windocker01.lgtc.top/v1/chat/completions

2. 中转服务器内部流程：
   接收标准 OpenAI 格式请求
       → 协议转换为目标平台私有格式
       → 从账号池选一个可用 session
       → 向目标平台官方后端发起请求
       → 接收响应
       → 转换回 OpenAI 格式
       → 返回给 OpenClaw

3. 提供给用户 key（如 sk-ws-01-xxx）和 API 地址
```

**客户端配置（OpenClaw）**：
```json
{
  "providers": [
    {
      "name": "windsurf-proxy",
      "api": "openai-completions",
      "baseUrl": "https://windocker01.lgtc.top/v1",
      "apiKey": "sk-ws-01-0002o0L6OHZdCJuzgj8MaHUOAHOFz8OTOWxhjnf121wLprSxPlLQAz5M5OtEPWZ3KNeq1kOwQRjmVYXc7FRLF0XyqhQ",
      "models": [
        { "id": "gpt-4o", "name": "GPT-4o" },
        { "id": "claude-3-5-sonnet", "name": "Claude Sonnet" }
      ]
    }
  ]
}
```

**特点**：
- 无需安装证书或代理
- 无需管理员权限
- 配置过程与正常使用 API 相同
- 仅 LLM 请求经过中转服务器，不影响其他流量

### 方式 B：提供配置客户端（exe）

**服务端开发**：
```
1. 开发 Windows exe 客户端
2. 客户端功能：
   - 用户输入分配的 key（sk-ws-01-xxx）
   - 自动定位 OpenClaw 配置文件（~/.openclaw/openclaw.json）
   - 自动写入 API 端点和 key
   - 可能包含：自动安装 OpenClaw、自动启动 gateway
   - 可能包含：用量查询、续费入口
3. 本质上是"方式A"的自动化配置工具
```

**客户端使用**：
```
1. 下载运行 exe
2. 输入分配的 key
3. 点击"一键配置"
4. 打开 OpenClaw 即可使用
```

### 方式 A 和 B 对比

| 对比项 | 方式A（手动配置） | 方式B（exe 客户端） |
|--------|-------------------|---------------------|
| 技术门槛 | 需要修改配置文件 | 一键完成 |
| 安全影响 | 仅 LLM 流量经过 | exe 可能包含额外功能 |
| 是否需要证书 | 不需要 | 不一定需要 |
| 是否需要管理员权限 | 不需要 | 可能需要 |
| 开发成本 | 低（只需 API 服务器） | 中（需要开发客户端） |

### 方式 C：多用户分发（每用户本地部署 OpenClaw）

在方式 A 的基础上，将服务分发给多个终端用户。每个用户在自己电脑上运行独立的 OpenClaw 实例，共享同一个中转服务器。

**整体架构**：

```
用户A 电脑                用户B 电脑                用户C 电脑
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│ OpenClaw     │     │ OpenClaw     │     │ OpenClaw     │
│ Gateway      │     │ Gateway      │     │ Gateway      │
│ localhost:   │     │ localhost:   │     │ localhost:   │
│ 18789        │     │ 18789        │     │ 18789        │
│              │     │              │     │              │
│ apiKey:      │     │ apiKey:      │     │ apiKey:      │
│ sk-ws-01-AAA │     │ sk-ws-01-BBB │     │ sk-ws-01-CCC │
└──────┬───────┘     └──────┬───────┘     └──────┬───────┘
       │                    │                    │
       └────────────────────┼────────────────────┘
                            │
                            ▼
                   中转服务器（协议转换 + 用量计量）
                   windocker01.lgtc.top
                            │
                            │  按 apiKey 识别用户 → 扣减积分
                            │  从号池选账号 → 轮换转发
                            ▼
                   Windsurf 官方后端
```

**用户侧部署流程**：

1. 安装 Node.js + OpenClaw（或提供一键安装脚本）
2. 将服务商提供的配置写入 `~/.openclaw/openclaw.json`：

```json
{
  "providers": [
    {
      "name": "windsurf-relay",
      "api": "openai-completions",
      "baseUrl": "https://windocker01.lgtc.top/v1",
      "apiKey": "sk-ws-01-用户专属key",
      "models": [
        { "id": "gpt-4o", "name": "GPT-4o (via Windsurf)", "contextWindow": 128000, "maxTokens": 16384 },
        { "id": "claude-sonnet-4-20250514", "name": "Claude Sonnet 4 (via Windsurf)", "contextWindow": 200000, "maxTokens": 16384 }
      ]
    }
  ],
  "agents": {
    "defaults": {
      "model": { "primary": "gpt-4o" }
    }
  }
}
```

3. 启动 OpenClaw Gateway：`node dist/entry.js gateway run --port 18789`
4. 浏览器打开 `http://localhost:18789` 即可使用

**服务商侧需要做的**：

1. ✅ 为每个付费用户生成独立 apiKey（`sk-gw-xxx`） → `POST /admin/users/create`
2. ✅ 中转服务器按 apiKey 隔离计量每个用户的用量 → `src/user-manager.js`
3. ✅ 实现积分/配额系统（1000 积分 / 3 小时恢复） → `creditLimit` + `creditRecoveryAmount` + `creditRecoveryIntervalMs`
4. ✅ 提供用户自助查询用量的接口 → `GET /v1/credits`
5. ✅ 提供可用模型列表接口 → `GET /v1/models`
6. ✅ 一键配置脚本 → `scripts/openclaw-setup.ps1`

> **实现状态**：以上功能已全部在 `cyber-drill-safe-lab` 项目中实现。详见 `docs/DEPLOYMENT.md` §11-12。

**优势**：

- **零 MITM**：不需要安装证书、不需要改 HOSTS、不需要管理员权限
- **完全隔离**：每个用户的文件操作、终端命令都在自己电脑上执行，服务商看不到
- **工具调用本地化**：OpenClaw 的 read/write/bash 等工具在用户本地运行，只有 LLM 推理请求经过中转
- **用户体验好**：和直接使用 OpenClaw + 官方 API 完全一致

**技术风险点**：

1. **协议转换精度**：Windsurf 私有协议与 OpenAI 标准格式的映射必须完整，特别是 function calling / tool_use 的格式差异
2. **流式响应兼容**：OpenClaw agent 依赖 SSE 流式输出，中转服务器必须支持流式透传
3. **模型名映射**：OpenClaw 配置的 model id 需要和中转服务器支持的映射对应
4. **账号池容量**：N 个并发用户需要足够多的 Windsurf 账号来支撑

---

## 五、账号池服务器技术细节

### 5.1 技术栈示例

```
操作系统：Linux（Ubuntu/CentOS）
容器化：Docker + Docker Compose
反向代理：Nginx / Caddy（TLS + 负载均衡）
调度服务：Node.js / Python / Go
数据库：Redis（session 缓存）+ SQLite/MySQL（用户管理、用量记录）
自动化：Puppeteer / Playwright（模拟客户端登录、维持 session）
```

### 5.2 账号池调度逻辑（伪代码）

```python
class AccountPool:
    accounts = [...]  # 所有可用账号

    def handle_request(self, user_token, llm_request):
        # 1. 验证用户令牌
        user = verify_token(user_token)
        if not user or user.expired:
            return 401, "unauthorized"

        # 2. 检查用户用量
        if user.daily_usage >= user.daily_limit:
            return 429, "daily limit exceeded"

        # 3. 从账号池选一个可用账号（最少使用 / 轮询 / 随机）
        account = self.select_available_account()
        if not account:
            return 503, "no available accounts"

        # 4. 用该账号的 session 向官方发起请求
        response = forward_to_official(account.session, llm_request)

        # 5. 记录用量
        user.daily_usage += count_tokens(response)
        account.daily_usage += count_tokens(response)

        # 6. 如果账号限额快满了，标记为不可用
        if account.daily_usage >= account.limit:
            account.available = False

        return 200, response

    def select_available_account(self):
        # 选用量最少的可用账号
        available = [a for a in self.accounts if a.available]
        return min(available, key=lambda a: a.daily_usage)

    def health_check(self):
        # 定期检查所有账号是否还有效
        for account in self.accounts:
            if not test_session(account.session):
                account.available = False
                alert_admin(f"Account {account.id} session expired")
```

### 5.3 协议转换层示例（目标平台 → OpenAI-compatible）

```javascript
// 将 OpenAI 格式请求转换为目标平台内部格式
function convertToPlatformFormat(openaiRequest) {
    return {
        prompt: openaiRequest.messages,
        model_hint: mapModelName(openaiRequest.model),
        stream: openaiRequest.stream,
        editor_context: generateEditorContext(),
        workspace_id: generateWorkspaceId(),
        session_token: selectedAccount.sessionToken
    };
}

// 将目标平台响应转换回 OpenAI 格式
function convertToOpenAIFormat(platformResponse) {
    return {
        id: "chatcmpl-" + generateId(),
        object: "chat.completion",
        model: requestedModel,
        choices: [{
            message: {
                role: "assistant",
                content: platformResponse.generated_text
            },
            finish_reason: "stop"
        }],
        usage: {
            prompt_tokens: platformResponse.input_tokens,
            completion_tokens: platformResponse.output_tokens,
            total_tokens: platformResponse.total_tokens
        }
    };
}
```

---

## 六、技术检测与溯源方法

### 6.1 关键检测点

| 检测类型 | 内容 | 分析方向 |
|----------|------|----------|
| 客户端程序 | MITM 代理程序、自签名 CA 证书、硬编码服务器地址 | 逆向分析 |
| SSL 证书 | Subject、Issuer、序列号、指纹、有效期 | 证书管理器导出 → 关联身份 |
| API key | `sk-ws-01-xxx` | 关联用户数据库 |
| 域名 | `windocker01.lgtc.top` | WHOIS → 注册信息；DNS → IP |
| 服务器 IP | 中转服务器 IP | 托管商查询 |
| 流量日志 | 代理日志、网络连接记录 | 通信路径分析 |

### 6.2 域名溯源路径

```
windocker01.lgtc.top
    │
    ├── WHOIS 查询 lgtc.top → 注册商、注册人、注册邮箱、注册时间
    │
    ├── DNS 解析 → A 记录 → IP 地址
    │       │
    │       └── IP → 托管商（阿里云/腾讯云/AWS/Vultr 等）
    │
    ├── 历史 DNS 记录 → IP 变更历史
    │
    └── 子域名枚举 → windocker02/03/... → 更多服务器
```

### 6.3 技术取证方法

1. **保全客户端程序**：计算哈希值（MD5/SHA256），保存原始文件
2. **导出已安装证书**：证书管理器 → 受信任的根证书颁发机构 → 导出 .cer 文件
3. **抓包分析**：在受控环境中运行客户端，用 Wireshark 记录通信
4. **逆向分析**：提取硬编码的服务器地址、通信协议、加密方式
5. **服务器分析**：如获得授权，对中转服务器做全盘镜像
6. **关联分析**：域名注册信息 ↔ 服务器购买记录 ↔ 收款账号

---

## 七、性能优化机制

大规模用户场景下维持响应速度的技术手段：

1. **并发控制**：注册用户数中，同一时刻真正发请求的占比较小
2. **账号池规模**：如有 100 个 Pro 账号，每个账号 RPM 限制假设 60，理论并发 6000 RPM
3. **请求间隔**：用户操作间隔（打字、阅读、思考）远大于响应等待时间
4. **模型降级策略**：部分请求可路由到更快更便宜的模型
5. **CDN/多节点部署**：中转服务器可部署多个节点，就近服务

---

## 八、自建实现方案（cyber-drill-safe 项目）

### 8.1 已实现的完整技术栈

基于上述架构分析，本项目已完整实现了一套 MITM 代理 + 账号池 + 用户管理系统。

**协议层**：
- Connect Protocol v1 + Protobuf + gzip 编解码（`src/connect-proto.js`）
- Windsurf/Codeium 专用协议适配器（`src/protocol-adapter.js` → `CodeiumAdapter`）
- 目标域名：`server.self-serve.windsurf.com`，核心端点：`GetChatMessage`
- TLS 证书伪造：用 mitmproxy CA 签发 `server.self-serve.windsurf.com` 证书（`certs/`）

**本地代理**（用户电脑上运行）：
- `src/local-proxy.js`：监听 `127.0.0.1:443`
- 通过修改 hosts 文件劫持 Windsurf 流量
- 支持透传模式（抓包）和网关模式（`--gateway http://IP:18790`）
- DNS 解析绕过本机 hosts（使用 8.8.8.8 / 1.1.1.1）

**网关服务器**（`src/lab-server.js`，端口 18790）：
- 账号池管理：从 `config/accounts.json` 加载，支持热重载
- Session 管理：`src/session-manager.js`，支持心跳保活、健康检查、自动禁用/恢复
- 用户管理：`src/user-manager.js`，积分系统（积分恢复、限额）
- 请求调度：最少使用优先（Least-Used）策略选号
- 安全审计：令牌速率限制、提示词注入检测、敏感信息探测
- 流式转发：支持 SSE 流式透传和非流式响应

**API 服务器**（`src/api-server.js`，端口 18800）：
- 用户注册/登录（JWT 认证，bcryptjs 密码哈希）
- 号池管理（创建/删除号池，号池账号 CRUD）
- 订阅系统（free/basic/pro/unlimited 四档）
- 公告系统
- 请求日志记录

**数据库**（`src/database.js`，SQLite）：
```
users           — 用户表（用户名、邮箱、密码哈希、订阅、积分）
pools           — 号池表（名称、编号、区域、上游IP、延迟）
pool_accounts   — 号池账号表（session_token、平台、状态、用量）
subscriptions   — 订阅套餐表（积分上限、恢复间隔、价格）
announcements   — 系统公告表
request_logs    — 请求日志表
```

### 8.2 客户端实现

**技术栈**：React + TailwindCSS + React Router，Electron 桌面封装

**页面**：
| 页面 | 功能 |
|------|------|
| 登录/注册 | JWT 认证，支持注册和登录 |
| 仪表盘 | 当前号池、配置状态、系统公告、操作按钮 |
| 我的订阅 | 积分用量、动态倒计时恢复、多订阅优先切换 |
| 获取订阅 | 按时/激活码两种方式，基础/专业/旗舰三档 |

**核心操作按钮**：
| 按钮 | 实际操作 |
|------|---------|
| 一键探测选路 | 并发 TCP ping 所有号池，自动选延迟最低的，右上角 toast 提示 |
| 初始化 | 修改 `C:\Windows\System32\drivers\etc\hosts`，加入 `127.0.0.1 server.self-serve.windsurf.com` |
| 运行切号 | 初始化 hosts + 启动 `local-proxy.js` 子进程，从 API 获取号池配置转发到网关 |
| 停止运行 | 杀掉本地代理进程 |
| 还原初始化 | 停止代理 + 删除 hosts 条目 |

**Electron IPC 架构**：
```
React 渲染进程
    │ window.electronAPI.proxyRun()
    ▼
preload.js（contextBridge）
    │ ipcRenderer.invoke('proxy:run')
    ▼
main.js（Electron 主进程）
    │ proxy-manager.js
    ▼
操作系统（hosts 文件 + 子进程管理）
```

**订阅系统**：
- 所有套餐积分上限均为 1000
- 区别在于恢复间隔：免费 24h、基础 5h、专业 3h、旗舰 1h
- 支持多个订阅同时生效，用户可切换"已优先/设为优先"
- 积分已满时显示"积分已满"标签
- 动态倒计时（每秒刷新）显示恢复剩余时间

### 8.3 部署架构

```
用户电脑 (Wind Client EXE)              阿里云 ECS (39.97.51.119)
┌─────────────────────────┐           ┌─────────────────────────┐
│ Electron 桌面应用        │   HTTP    │                         │
│   ├─ React UI           │ ────────► │  API Server :18800      │
│   └─ proxy-manager.js   │           │  (Express + SQLite)     │
│                         │           │  用户/订阅/号池/公告     │
│ local-proxy.js          │   HTTPS   │                         │
│ (127.0.0.1:443)         │ ────────► │  Gateway :18790         │
│   ├─ hosts 劫持         │           │  (lab-server.js)        │
│   └─ TLS 伪造证书       │           │  账号池调度/转发/审计    │
└─────────────────────────┘           └───────────┬─────────────┘
                                                  │
                                                  │ HTTPS (真实证书)
                                                  ▼
                                      Windsurf 官方后端
                                      server.self-serve.windsurf.com
```

**统一启动**：`node src/start-server.js` 同时启动 API + Gateway

**部署方式**：
- `scripts/deploy-server.sh`：rsync 上传 + systemd 服务注册
- 安全组需开放：18800/TCP（API）、18790/TCP（Gateway）

**号池账号管理**（管理员 API）：
```bash
# 添加 Windsurf 账号到号池
POST /api/admin/pool-accounts
{ "pool_id": 1, "label": "ws-01", "session_token": "<token>" }

# 查看所有账号（token 脱敏）
GET /api/admin/pool-accounts

# 禁用/启用账号
POST /api/admin/pool-accounts/:id/status
{ "status": "disabled" }
```

数据库 `pool_accounts` 表的账号会自动同步到 `config/sessions.json`，Gateway 热加载使用。

### 8.4 服务器选址建议

| | 国内服务器 | 国外服务器（香港/日本） |
|---|---|---|
| 到 Windsurf 官方延迟 | 高（200-500ms），可能被墙 | 低（10-50ms） |
| 国内用户访问延迟 | 低 | 中等（50-100ms） |
| 备案要求 | 需要 | 不需要 |
| 推荐程度 | ⚠️ 需测试连通性 | ✅ 推荐 |

### 8.5 关键文件索引

```
cyber-drill-safe/
├── src/
│   ├── api-server.js          # API 服务（用户管理、订阅、号池）
│   ├── lab-server.js          # Gateway 网关（账号池调度、转发）
│   ├── start-server.js        # 统一启动入口
│   ├── database.js            # SQLite 数据层
│   ├── local-proxy.js         # 本地 HTTPS 代理
│   ├── connect-proto.js       # Connect Protocol 编解码
│   ├── protocol-adapter.js    # 平台协议适配器
│   ├── session-manager.js     # Session 池管理（保活/健康检查）
│   └── user-manager.js        # 用户积分/配额管理
├── client/
│   ├── electron/
│   │   ├── main.js            # Electron 主进程
│   │   ├── preload.js         # IPC 桥接
│   │   └── proxy-manager.js   # hosts/代理进程管理
│   └── src/
│       ├── api.js             # API 客户端
│       ├── App.jsx            # 路由
│       └── pages/
│           ├── Login.jsx      # 登录/注册
│           ├── Dashboard.jsx  # 仪表盘
│           ├── Subscription.jsx  # 我的订阅
│           └── GetSubscription.jsx  # 获取订阅
├── certs/                     # TLS 伪造证书
├── config/                    # 运行时配置（accounts.json, sessions.json）
├── scripts/
│   ├── deploy-server.sh       # 服务器部署脚本
│   └── seed-db.mjs            # 数据库种子数据
└── data/
    └── wind.db                # SQLite 数据库
```

---

---

## 九、实际抓包情报分析（2026-02-25）

> 以下内容来自使用 `local-proxy.js` 透传模式抓取的真实流量数据（`captures/` 目录），
> 对当前使用的第三方代理团队进行逆向分析。

### 9.1 账号完整画像

通过解码 `GetUserJwt` 响应中的 JWT token，获得以下账号信息：

| 字段 | 值 | 来源 |
|------|------|------|
| **用户名** | Charlotte Allen | JWT `name` |
| **邮箱** | `zYNPDekEPcKuELFiqF@qq.com` | JWT `email` |
| **API Key** | `2b809a22-15e4-4e25-9049-dfde9f16f4b7` | JWT `api_key` |
| **Auth UID** | `HgCva2Y1bOYS5s3tBYVbw7MhTye2` | JWT `auth_uid`（Firebase Auth 格式） |
| **Team ID** | `a29a18c4-044b-4c63-9532-581cc0c390f5` | JWT `team_id` |
| **Pro 状态** | `false` | JWT `pro` |
| **Teams Tier** | `TEAMS_TIER_UNSPECIFIED` | JWT `teams_tier` |
| **Team Status** | `USER_TEAM_STATUS_APPROVED` | JWT `team_status` |
| **Pro 试用到期** | `2026-02-17T17:10:09.637375Z`（**已过期**） | JWT `windsurf_pro_trial_end_time` |
| **Premium Chat 消息数** | `0` | JWT `max_num_premium_chat_messages` |
| **GetUserStatus 订阅层级** | `Free` | protobuf 响应 @offset 96 |

**结论：这是一个已过期的 14 天免费试用号，不是付费 Pro 账号。**

### 9.2 账号注册模式分析

| 特征 | 值 | 推断 |
|------|------|------|
| **邮箱格式** | `zYNPDekEPcKuELFiqF@qq.com` — 18位随机字母 | 批量随机生成，不是人工注册 |
| **用户名** | "Charlotte Allen" — 标准英文名 | 使用 fake name generator 批量生成 |
| **Auth UID 格式** | `HgCva2Y1bOYS5s3tBYVbw7MhTye2` | Firebase Authentication UID |
| **注册时间推算** | 试用到期 2月17日 - 14天 = 约 **2月3日** 注册 | 每 14 天需要补充新号 |

**推断注册自动化流程：**

```
1. 生成随机 QQ 邮箱地址（18位随机字母@qq.com）
   → 可能使用 QQ 邮箱别名功能，或者有大量 QQ 邮箱资源
   → 也可能使用 catch-all 域名邮箱伪装成 @qq.com

2. 访问 Windsurf 注册页面（Firebase Auth）
   → Puppeteer/Playwright 自动化填写
   → 或者直接调用 Firebase Auth REST API 注册

3. 邮箱验证
   → 如果是真实 QQ 邮箱：通过 QQ 邮箱 IMAP/POP3 协议自动读取验证邮件
   → 如果是 catch-all：自建邮件服务器接收验证邮件
   → 可能 Windsurf 对部分邮箱不强制验证

4. 注册完成，获得 14 天 Pro 试用
   → 保存 API key (gsk-xxx) 和 auth credentials
   → 加入账号池

5. 14 天后试用过期，标记为废弃，切换到下一个新号
```

### 9.3 认证机制详解

**API Key 格式**：`gsk-ws-01-tIMFYH3AZgeQ-76jK9DXK0qEUbViGRYPoH46UIC5iykcWL7Hs4SrhKmHKGLTmTChR2mcJbyNmcANSohNXDnyYOdI0Odjpw`

- 前缀 `gsk-` = Codeium/Windsurf 的标准 API key 前缀
- `ws-01` 可能是服务器分区标识
- 尾部是 base62 编码的密钥

**认证方式**：不是通过 HTTP `Authorization` header，而是**嵌入在 Protobuf 请求体内部**。每个 API 调用的 protobuf body 都包含：
- API key（`gsk-xxx`）
- JWT token（包含完整用户身份信息）

这意味着代理团队在中间层做的是：**替换 protobuf body 内部的 API key 字段**，而不是替换 HTTP header。

### 9.4 你被暴露的信息

通过分析所有请求体，你的 Windsurf 客户端在每次 API 调用中都会发送以下设备信息：

| 信息类型 | 具体值 | 风险等级 |
|----------|--------|----------|
| **操作系统** | Windows 10 Pro, Build 26100 | 低 |
| **CPU 型号** | AMD Ryzen 5 7500F 6-Core Processor | 中 |
| **CPU 详情** | 1 Socket, 6 Cores, 12 Threads, AuthenticAMD | 中 |
| **系统架构** | amd64 | 低 |
| **Windsurf 版本** | 1.48.2 | 低 |
| **Language Server 版本** | 1.9544.28 | 低 |
| **设备 ID** | `d9a3c0a1-41ed-42f3-82b9-9eba3e393990` | **高** |
| **设备指纹** | `44fbc5a0671c985ab737...` (64字节 SHA) | **高** |
| **安装路径** | `e:\Useless\windsurf\Windsurf\resources\app\extensions\windsurf` | 中 |

### 9.5 对话内容泄露

`GetChatMessage` 请求体（25,924 字节）中包含你发给 Cascade 的**完整对话上下文**，包括：

1. **你的所有 Windsurf Memory 数据**（SYSTEM-RETRIEVED-MEMORY）：
   - 阿里云 ECS IP 地址：`39.97.51.119`
   - Neon 数据库配置：`DATABASE_URL`、`DATABASE_URL_UNPOOLED`
   - 项目代码细节：Prisma schema、Creator Studio、PNG 导入流程等
   - 浏览器 viewport 配置：1843x1308, devicePixelRatio=1.5
   - character-tavern.com 复制计划

2. **你的 IDE 元数据**：
   - 当前打开的文件路径
   - 光标位置
   - 所有打开的工作区

3. **对话历史**：
   - 之前的用户消息和 AI 回复
   - 系统 prompt 和特殊 token

**⚠️ 这意味着代理团队可以看到你通过 Cascade 处理的所有代码、对话和项目信息。**

### 9.6 额度/限流系统

`CheckUserMessageRateLimit` 响应解码：

| Protobuf 字段 | 值 | 推测含义 |
|---------------|------|----------|
| field 1 (varint) | `1` | 是否允许发送（1=允许） |
| field 3 (varint) | `29` | 剩余 credits |
| field 4 (varint) | `30` | 总 credits 上限 |
| field 5 (varint) | `3195` | 可能是重置倒计时（秒）或累计用量 |

**关键发现**：该试用号总共只有 **30 credits**，抓包时剩余 **29 credits**（刚用了1个）。

### 9.7 Windsurf 后端基础设施

从响应 headers 中可以判断：

| 信息 | 值 | 说明 |
|------|------|------|
| **CDN/代理** | `via: 1.1 google` | 后端在 Google Cloud 上 |
| **协议** | HTTP/3 支持（`alt-svc: h3=":443"`) | 现代基础设施 |
| **后端框架** | Connect Protocol (Go) | `user-agent: connect-go/1.18.1 (go1.25.5)` |
| **序列化** | Protobuf (`application/proto`) | 非 JSON |
| **压缩** | gzip | 所有请求/响应都压缩 |
| **监控** | Sentry | `sentry-release=language-server-windsurf@1.9544.28` |
| **Sentry DSN** | `b813f73488da69eedec534dba1029111` | Sentry public key |

### 9.8 模型状态情报

`GetModelStatuses` 响应显示 `MODEL_CLAUDE_3_5_HAIKU_20241022` 正在经历高错误率：

> "Model is currently experiencing elevated error rate, responses may be unreliable."

`GetCommandModelConfigs` 显示默认 Cascade 模型为 `Windsurf Fast`（`MODEL_CHAT_11121`）。

`GetChatMessage` 响应显示实际使用的模型：
- 第一次对话：`MODEL_SWE_1_5_SLOW`（SWE-1.5）
- 第二次对话：`MODEL_GOOGLE_GEMINI_2_5_FLASH`（Gemini 2.5 Flash）

**关键发现**：`GetUserStatus` 中的 Premium / Value / Free 标签不是访问限制，而是**积分消耗等级**。免费试用号可以使用**全部模型**（包括 Claude Opus 4.6、GPT-5.2 等），区别在于：
- **Free 模型**（SWE-1.5、GPT-5.1-Codex）：不消耗 credits，可无限调用
- **Value 模型**（GPT-5 Low、Kimi K2）：消耗少量 credits
- **Premium 模型**（Claude Opus 4.6、GPT-5.2）：消耗较多 credits

代理团队提供的是**全模型访问**服务，用户主要使用 Premium 模型（Claude Opus、GPT-5 等），因此每个试用号的 30 credits 消耗很快（约 10-30 次 Premium 对话）。这意味着账号池需要**高频补充**——10 个活跃用户每天可能消耗 10-50 个试用号，团队的核心竞争力在于**批量注册自动化的速度和规模**。

### 9.9 Team 配置详情

JWT 中的 `team_config` 字段（JSON 字符串）：

```json
{
  "allowMcpServers": true,
  "allowAutoRunCommands": true,
  "allowCustomRecipes": true,
  "maxUnclaimedSites": 1,
  "allowAppDeployments": true,
  "allowSandboxAppDeployments": true,
  "maxNewSitesPerDay": 1,
  "allowBrowserExperimentalFeatures": true,
  "allowCodemapSharing": "enabled",
  "disableLifeguard": true,
  "maxCascadeAutoExecutionLevel": "CASCADE_COMMANDS_AUTO_EXECUTION_EAGER",
  "allowArenaMode": true
}
```

注意 `disableLifeguard: true` — Lifeguard 是 Windsurf 的安全审查系统，这里被禁用了，说明注册时可能通过某种方式绕过了安全限制。

### 9.10 完整通信时序

```
时间戳(ms)        端点                          方向    大小
───────────────────────────────────────────────────────────
204948            Ping                          → ←     0 / 23B
204951            GetDefaultWorkflowTemplates   → ←     568 / 23B
205004            GetUserStatus                 → ←     405 / 5532B
205288            GetUserJwt                    → ←     405 / 924B    ← JWT含完整身份
205550            GetStatus                     → ←     1489 / 26B
205560            GetUserJwt                    → ←     405 / 922B
205821            GetCommandModelConfigs        → ←     1487 / 80B
206091            GetProfileData                → ←     105 / 23B
206115            GetUserStatus                 → ←     404 / 5532B
206434            GetUserJwt                    → ←     156 / 918B    ← 不同请求体大小
206444            GetUserStatus                 → ←     156 / 5800B   ← 不同响应大小
206694            GetModelStatuses              → ←     1307 / 148B
210618            GetUserStatus                 → ←     404 / 5532B
218966            CheckUserMessageRateLimit     → ←     1327 / 33B    ← 额度检查
219776            GetUserStatus                 → ←     404 / 5532B
221781            GetChatMessage                → ←     25924 / 5262B ← 你的对话(大)
222134            GetUserStatus                 → ←     404 / 5532B
223765            GetChatMessage                → ←     6022 / 1952B  ← 标题生成(小)
232787            GetUserStatus                 → ←     156 / 5800B
233224            GetUserStatus                 → ←     156 / 5800B
235207            Ping                          → ←     0 / 23B
```

**观察**：
- 启动时密集调用（身份验证 → 配置加载 → 模型列表）
- `GetUserStatus` 被频繁轮询（11次/30秒）— 用于刷新订阅状态
- 请求体有两种大小（405B vs 156B）：较大的包含完整设备信息，较小的是精简版
- 第二次 `GetChatMessage`（6KB）是 AI 自动生成的对话标题请求

### 9.11 信用卡问题结论

**这个团队根本不需要信用卡。** 他们的完整运营模式是：

1. **批量注册 QQ 邮箱**（或使用 catch-all 域名邮箱）
2. **通过 Firebase Auth API 自动注册 Windsurf 账号**（不需要信用卡，免费注册即可）
3. **获得 14 天 Pro 试用**（每个新号自动赠送）
4. **14 天内通过 MITM 代理将试用额度分发给付费用户**
5. **试用到期后丢弃该号，补充新的试用号**
6. **成本 ≈ 0**（只需要服务器费用和邮箱资源）

这是一个**零边际成本**的运营模式——不需要购买任何订阅，纯靠薅免费试用。
