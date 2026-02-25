/**
 * Protocol Adapter - 协议转换层
 *
 * 将 OpenAI 标准格式 ↔ 目标平台私有格式 互相转换
 * 采用插件式架构，每个平台一个 adapter
 *
 * 已内置：
 * - openai   : 直通（不需要转换，用于 DeepSeek/OpenAI 等兼容 API）
 * - codeium  : Codeium/Windsurf 平台适配器（需要逆向填充）
 *
 * 用法：
 *   const adapter = getAdapter("codeium");
 *   const platformReq = adapter.toplatform(openaiRequest, session);
 *   const openaiResp = adapter.fromPlatform(platformResponse);
 */

import https from "node:https";
import http from "node:http";
import crypto from "node:crypto";

// ============================================================
// 基类
// ============================================================

class BaseAdapter {
  constructor(name) {
    this.name = name;
  }

  /**
   * 将 OpenAI 格式请求转换为平台格式
   * @param {Object} openaiRequest - { model, messages, stream, ... }
   * @param {Object} session - PlatformSession
   * @returns {Object} { url, method, headers, body }
   */
  toPlatform(openaiRequest, session) {
    throw new Error(`${this.name}: toPlatform() not implemented`);
  }

  /**
   * 将平台响应转换为 OpenAI 格式
   * @param {Object} platformResponse - 平台原始响应
   * @param {Object} meta - { model, requestId }
   * @returns {Object} OpenAI chat.completion 格式
   */
  fromPlatform(platformResponse, meta) {
    throw new Error(`${this.name}: fromPlatform() not implemented`);
  }

  /**
   * 将平台 SSE 事件转换为 OpenAI SSE chunk 格式
   * @param {string} eventData - 单个 SSE data 行的内容
   * @param {Object} meta
   * @returns {string|null} OpenAI 格式的 SSE data，或 null 表示跳过
   */
  fromPlatformStreamChunk(eventData, meta) {
    throw new Error(`${this.name}: fromPlatformStreamChunk() not implemented`);
  }

  /**
   * 生成心跳/保活请求
   * @param {Object} session
   * @returns {Object|null} { url, method, headers, body } 或 null 表示不需要
   */
  buildKeepaliveRequest(session) {
    return null;
  }

  /**
   * 生成健康检查请求
   * @param {Object} session
   * @returns {Object|null} { url, method, headers }
   */
  buildHealthCheckRequest(session) {
    return null;
  }
}

// ============================================================
// OpenAI 直通适配器（DeepSeek / OpenAI / 兼容 API）
// ============================================================

class OpenAIAdapter extends BaseAdapter {
  constructor() {
    super("openai");
  }

  toPlatform(openaiRequest, session) {
    const baseUrl = (session.extra?.baseUrl || session.baseUrl || "https://api.openai.com").replace(/\/+$/, "");
    const apiKey = session.extra?.apiKey || session.apiKey || session.sessionToken;

    return {
      url: `${baseUrl}/v1/chat/completions`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(openaiRequest),
    };
  }

  fromPlatform(platformResponse, meta) {
    // 直通，不需要转换
    return platformResponse;
  }

  fromPlatformStreamChunk(eventData, meta) {
    // 直通 SSE
    return eventData;
  }

  buildHealthCheckRequest(session) {
    const baseUrl = (session.extra?.baseUrl || session.baseUrl || "https://api.openai.com").replace(/\/+$/, "");
    const apiKey = session.extra?.apiKey || session.apiKey || session.sessionToken;

    return {
      url: `${baseUrl}/v1/models`,
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    };
  }
}

// ============================================================
// Codeium/Windsurf 适配器
// ============================================================
// ⚠️ 以下是框架代码。实际协议细节需要通过抓包逆向获取。
// 标记 [REVERSE-REQUIRED] 的地方需要你根据实际抓包数据填充。

class CodeiumAdapter extends BaseAdapter {
  constructor() {
    super("codeium");
    // [REVERSE-REQUIRED] 目标平台 API 基址
    this.apiBase = "https://api.codeium.com";
    // [REVERSE-REQUIRED] 补全/聊天端点路径
    this.chatEndpoint = "/exa.language_server_pb.LanguageServerService/GetChatCompletion";
    // [REVERSE-REQUIRED] 保活端点
    this.heartbeatEndpoint = "/exa.seat_management_pb.SeatManagementService/Heartbeat";
  }

  toPlatform(openaiRequest, session) {
    // [REVERSE-REQUIRED] 根据抓包数据填充实际请求格式
    // 以下是推测性的框架结构
    const requestBody = {
      // Codeium 使用 protobuf，这里用 JSON 占位
      // 实际可能需要用 protobuf 编码
      metadata: {
        ide_name: "windsurf",
        ide_version: "1.0.0",
        extension_version: "1.0.0",
        api_key: session.sessionToken,
        session_id: session.deviceId || crypto.randomUUID(),
        request_id: BigInt(Date.now()).toString(),
      },
      chat_messages: this._convertMessages(openaiRequest.messages),
      model: this._mapModel(openaiRequest.model),
      stream: openaiRequest.stream ?? false,
      // [REVERSE-REQUIRED] 编辑器上下文
      editor_state: {
        workspace_id: session.extra?.workspaceId || "default",
        file_path: "",
        language: "",
        cursor_offset: 0,
      },
    };

    return {
      url: `${this.apiBase}${this.chatEndpoint}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // [REVERSE-REQUIRED] 认证 header 格式
        Authorization: `Bearer ${session.sessionToken}`,
        "User-Agent": session.userAgent || "windsurf/1.0.0",
        // [REVERSE-REQUIRED] 可能需要的额外 header
        "X-Device-Id": session.deviceId || "",
      },
      body: JSON.stringify(requestBody),
    };
  }

  fromPlatform(platformResponse, meta) {
    // [REVERSE-REQUIRED] 根据实际响应格式转换
    const content = platformResponse?.completion?.text
      || platformResponse?.generated_text
      || platformResponse?.choices?.[0]?.message?.content
      || JSON.stringify(platformResponse);

    return {
      id: `chatcmpl-${meta?.requestId || crypto.randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: meta?.model || "windsurf-model",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content,
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: platformResponse?.usage?.input_tokens || 0,
        completion_tokens: platformResponse?.usage?.output_tokens || 0,
        total_tokens: platformResponse?.usage?.total_tokens || 0,
      },
    };
  }

  fromPlatformStreamChunk(eventData, meta) {
    // [REVERSE-REQUIRED] 解析平台流式事件并转换为 OpenAI SSE chunk
    try {
      const parsed = JSON.parse(eventData);
      const text = parsed?.completion?.text || parsed?.delta?.content || "";

      if (!text) return null;

      const chunk = {
        id: `chatcmpl-${meta?.requestId || crypto.randomUUID()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: meta?.model || "windsurf-model",
        choices: [
          {
            index: 0,
            delta: { content: text },
            finish_reason: null,
          },
        ],
      };

      return JSON.stringify(chunk);
    } catch {
      return null;
    }
  }

  buildKeepaliveRequest(session) {
    // [REVERSE-REQUIRED] 心跳请求格式
    return {
      url: `${this.apiBase}${this.heartbeatEndpoint}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.sessionToken}`,
      },
      body: JSON.stringify({
        metadata: {
          api_key: session.sessionToken,
          ide_name: "windsurf",
        },
      }),
    };
  }

  buildHealthCheckRequest(session) {
    // [REVERSE-REQUIRED] 健康检查
    return this.buildKeepaliveRequest(session);
  }

  // ---- 内部工具 ----

  _convertMessages(messages) {
    return (messages || []).map((m) => ({
      role: m.role === "assistant" ? "ASSISTANT" : m.role === "system" ? "SYSTEM" : "USER",
      content: m.content || "",
    }));
  }

  _mapModel(openaiModel) {
    // [REVERSE-REQUIRED] 模型名映射
    const MAP = {
      "gpt-4o": "gpt-4o",
      "gpt-4": "gpt-4",
      "claude-3-5-sonnet": "claude-3-5-sonnet-20241022",
      "claude-3-5-sonnet-20241022": "claude-3-5-sonnet-20241022",
      "deepseek-chat": "deepseek-chat",
    };
    return MAP[openaiModel] || openaiModel;
  }
}

// ============================================================
// 适配器注册表
// ============================================================

const ADAPTERS = {
  openai: new OpenAIAdapter(),
  codeium: new CodeiumAdapter(),
  windsurf: new CodeiumAdapter(), // windsurf 使用 codeium 后端
};

/**
 * 获取指定平台的协议适配器
 * @param {string} platform
 * @returns {BaseAdapter}
 */
export function getAdapter(platform) {
  const adapter = ADAPTERS[platform?.toLowerCase()];
  if (!adapter) {
    throw new Error(`unknown platform adapter: ${platform}. available: ${Object.keys(ADAPTERS).join(", ")}`);
  }
  return adapter;
}

/**
 * 注册自定义适配器
 */
export function registerAdapter(name, adapter) {
  ADAPTERS[name.toLowerCase()] = adapter;
}

/**
 * 通用的 HTTP 请求发送函数
 * 使用适配器生成的 { url, method, headers, body } 发送请求
 * @param {Object} reqSpec - { url, method, headers, body }
 * @param {number} [timeoutMs=30000]
 * @returns {Promise<{status: number, headers: Object, body: string}>}
 */
export function sendAdapterRequest(reqSpec, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(reqSpec.url);
    const transport = parsed.protocol === "https:" ? https : http;

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: reqSpec.method || "POST",
      headers: reqSpec.headers || {},
      timeout: timeoutMs,
    };

    const req = transport.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("request timeout"));
    });

    if (reqSpec.body) {
      req.write(reqSpec.body);
    }
    req.end();
  });
}

/**
 * 流式请求 - 返回原始响应流用于 SSE 转发
 */
export function sendAdapterStreamRequest(reqSpec, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(reqSpec.url);
    const transport = parsed.protocol === "https:" ? https : http;

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: reqSpec.method || "POST",
      headers: reqSpec.headers || {},
      timeout: timeoutMs,
    };

    const req = transport.request(options, (res) => {
      resolve(res);
    });

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("stream request timeout"));
    });

    if (reqSpec.body) {
      req.write(reqSpec.body);
    }
    req.end();
  });
}

export { BaseAdapter, OpenAIAdapter, CodeiumAdapter };
export default { getAdapter, registerAdapter, sendAdapterRequest, sendAdapterStreamRequest };
