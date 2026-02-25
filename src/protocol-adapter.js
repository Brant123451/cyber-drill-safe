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
import {
  ProtoWriter,
  decodeProto,
  getStringField,
  getIntField,
  getMessageField,
  encodeConnectFrame,
  decodeConnectFrames,
  extractStreamDelta,
} from "./connect-proto.js";
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
// Codeium/Windsurf 适配器 (reverse-engineered 2026-02-25)
// ============================================================
// Protocol: Connect Protocol v1 + Protobuf + gzip
// Domain:   server.self-serve.windsurf.com
// Agent:    connect-go/1.18.1 (go1.25.5)

class CodeiumAdapter extends BaseAdapter {
  constructor() {
    super("codeium");
    this.apiBase = "https://server.self-serve.windsurf.com";
    this.chatEndpoint = "/exa.api_server_pb.ApiServerService/GetChatMessage";
    this.pingEndpoint = "/exa.api_server_pb.ApiServerService/Ping";
    this.userStatusEndpoint = "/exa.seat_management_pb.SeatManagementService/GetUserStatus";
    this.rateLimitEndpoint = "/exa.api_server_pb.ApiServerService/CheckUserMessageRateLimit";

    this._requestCounter = 0;
  }

  // Build the ClientMetadata protobuf (field 1 in most requests)
  _buildClientMetadata(session) {
    this._requestCounter++;
    const meta = new ProtoWriter();
    meta.writeStringField(1, "windsurf");
    meta.writeStringField(2, session.editorVersion || "1.48.2");
    meta.writeStringField(3, session.sessionToken); // api_key (sk-ws-01-...)
    meta.writeStringField(4, session.locale || "en");
    meta.writeStringField(5, session.osInfo || "windows");
    meta.writeStringField(7, session.lsVersion || "1.9544.28");
    meta.writeVarintField(9, this._requestCounter);
    meta.writeStringField(10, session.machineId || crypto.randomUUID());
    meta.writeStringField(12, "windsurf");
    if (session.jwtToken) {
      meta.writeStringField(21, session.jwtToken);
    }
    return meta;
  }

  toPlatform(openaiRequest, session) {
    const req = new ProtoWriter();

    // field 1: ClientMetadata
    req.writeMessageField(1, this._buildClientMetadata(session));

    // field 3: Messages (repeated)
    for (const msg of openaiRequest.messages || []) {
      const m = new ProtoWriter();
      m.writeVarintField(2, this._roleToInt(msg.role));
      m.writeStringField(3, msg.content || "");
      req.writeMessageField(3, m);
    }

    // field 8: ModelConfig
    const cfg = new ProtoWriter();
    cfg.writeVarintField(1, 1);
    cfg.writeVarintField(2, openaiRequest.max_tokens || 8192);
    cfg.writeVarintField(3, 200);
    cfg.writeDoubleField(5, openaiRequest.temperature ?? 0.7);
    cfg.writeDoubleField(6, openaiRequest.top_p ?? 0.9);
    cfg.writeVarintField(7, 50);
    // stop sequences (from capture: special tokens)
    const STOP_SEQS = ["\x3c|user|\x3e", "\x3c|bot|\x3e", "\x3c|context_request|\x3e", "\x3c|endoftext|\x3e", "\x3c|end_of_turn|\x3e"];
    for (const s of (openaiRequest.stop || STOP_SEQS)) {
      cfg.writeStringField(9, s);
    }
    req.writeMessageField(8, cfg);

    // field 21: model name
    req.writeStringField(21, this._mapModel(openaiRequest.model));

    // field 16: trajectory_id
    req.writeStringField(16, session.trajectoryId || crypto.randomUUID());

    // field 22: session_id
    req.writeStringField(22, session.sessionId || crypto.randomUUID());

    // field 20: streaming flag
    req.writeVarintField(20, 1);

    // Encode protobuf -> Connect envelope with gzip
    const protobufData = req.finish();
    const body = encodeConnectFrame(protobufData, true);

    return {
      url: `${this.apiBase}${this.chatEndpoint}`,
      method: "POST",
      headers: {
        "Content-Type": "application/connect+proto",
        "Connect-Protocol-Version": "1",
        "Connect-Content-Encoding": "gzip",
        "Connect-Accept-Encoding": "gzip",
        "Accept-Encoding": "identity",
        "User-Agent": "connect-go/1.18.1 (go1.25.5)",
      },
      body,
    };
  }

  fromPlatform(platformResponseBuf, meta) {
    // Parse all Connect frames from the response buffer
    let fullText = "";
    let usage = null;
    let requestId = meta?.requestId || crypto.randomUUID();
    let modelUsed = meta?.model || "windsurf-model";

    for (const frame of decodeConnectFrames(platformResponseBuf)) {
      if (frame.isEndOfStream) continue;
      const delta = extractStreamDelta(frame.data);
      if (delta.textDelta) fullText += delta.textDelta;
      if (delta.usage) {
        usage = delta.usage;
        if (delta.usage.requestId) requestId = delta.usage.requestId;
        if (delta.usage.model) modelUsed = delta.usage.model;
      }
    }

    return {
      id: requestId,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: modelUsed,
      choices: [{
        index: 0,
        message: { role: "assistant", content: fullText },
        finish_reason: "stop",
      }],
      usage: {
        prompt_tokens: usage?.promptTokens || 0,
        completion_tokens: usage?.completionTokens || 0,
        total_tokens: (usage?.promptTokens || 0) + (usage?.completionTokens || 0),
      },
    };
  }

  fromPlatformStreamChunk(frameData, meta) {
    // Parse a single Connect frame and convert to OpenAI SSE chunk
    const delta = extractStreamDelta(frameData);
    if (!delta.textDelta) return null;

    const chunk = {
      id: meta?.requestId || `chatcmpl-${crypto.randomUUID()}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: delta.usage?.model || meta?.model || "windsurf-model",
      choices: [{
        index: 0,
        delta: { content: delta.textDelta },
        finish_reason: null,
      }],
    };
    return JSON.stringify(chunk);
  }

  buildKeepaliveRequest(session) {
    const req = new ProtoWriter();
    req.writeMessageField(1, this._buildClientMetadata(session));
    const body = encodeConnectFrame(req.finish(), false);

    return {
      url: `${this.apiBase}${this.pingEndpoint}`,
      method: "POST",
      headers: {
        "Content-Type": "application/proto",
        "User-Agent": "connect-go/1.18.1 (go1.25.5)",
      },
      body,
    };
  }

  buildHealthCheckRequest(session) {
    return this.buildKeepaliveRequest(session);
  }

  _roleToInt(role) {
    switch (role) {
      case "system": return 1;
      case "user": return 2;
      case "assistant": return 3;
      default: return 2;
    }
  }

  _mapModel(openaiModel) {
    const MAP = {
      "gpt-4o": "MODEL_CHAT_GPT_4_O",
      "gpt-4": "MODEL_CHAT_GPT_4",
      "gpt-4.1": "MODEL_CHAT_GPT_4_1_2025_04_14",
      "claude-3-5-sonnet": "MODEL_CLAUDE_3_5_SONNET",
      "deepseek-chat": "MODEL_DEEPSEEK_V3",
      "cascade": "MODEL_SWE_1_5_SLOW",
      "cascade-fast": "MODEL_SWE_1_5_FAST",
    };
    return MAP[openaiModel] || openaiModel;
  }
}

// ============================================================
// Adapter Registry
// ============================================================

const ADAPTERS = {
  openai: new OpenAIAdapter(),
  codeium: new CodeiumAdapter(),
  windsurf: new CodeiumAdapter(),
};

export function getAdapter(platform) {
  const adapter = ADAPTERS[platform?.toLowerCase()];
  if (!adapter) {
    throw new Error(`unknown platform adapter: ${platform}. available: ${Object.keys(ADAPTERS).join(", ")}`);
  }
  return adapter;
}

export function registerAdapter(name, adapter) {
  ADAPTERS[name.toLowerCase()] = adapter;
}

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
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("request timeout")); });
    if (reqSpec.body) req.write(reqSpec.body);
    req.end();
  });
}

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
    const req = transport.request(options, (res) => resolve(res));
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("stream request timeout")); });
    if (reqSpec.body) req.write(reqSpec.body);
    req.end();
  });
}

export { BaseAdapter, OpenAIAdapter, CodeiumAdapter };
export default { getAdapter, registerAdapter, sendAdapterRequest, sendAdapterStreamRequest };
