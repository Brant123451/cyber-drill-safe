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

*文档生成时间：2025-02-23*
*用途：技术架构研究*
