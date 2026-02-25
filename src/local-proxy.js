/**
 * 本地 HTTPS 反向代理
 *
 * 功能：监听 127.0.0.1:443，接收 Windsurf 发往 server.self-serve.windsurf.com 的请求，
 *       原样转发到你指定的网关服务器（或直接转发到 Windsurf 官方后端）。
 *
 * 前置条件：
 *   1. hosts 文件已添加：127.0.0.1 server.self-serve.windsurf.com
 *   2. certs/ 目录有 server.key + server.crt（用受信任的 CA 签发）
 *   3. CA 证书已安装到 Windows 信任库
 *
 * 用法：
 *   node src/local-proxy.js                          # 透传到官方后端（抓包模式）
 *   node src/local-proxy.js --gateway http://IP:18790  # 转发到自建网关
 */

import https from "node:https";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tls from "node:tls";
import { Buffer } from "node:buffer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");

// ---- 配置 ----
const LISTEN_HOST = "127.0.0.1";
const LISTEN_PORT = 443;

// 原始目标（Windsurf 官方）
const ORIGINAL_HOST = "server.self-serve.windsurf.com";
const ORIGINAL_PORT = 443;

// 解析命令行参数
const args = process.argv.slice(2);
let GATEWAY_URL = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--gateway" && args[i + 1]) {
    GATEWAY_URL = args[i + 1];
    break;
  }
}

// TLS 证书
const tlsOptions = {
  key: fs.readFileSync(path.join(PROJECT_ROOT, "certs", "server.key")),
  cert: fs.readFileSync(path.join(PROJECT_ROOT, "certs", "server.crt")),
};

// 解析官方域名的真实 IP（因为 hosts 被改了，不能用域名连）
let resolvedOriginalIP = null;

async function resolveOriginalIP() {
  const dns = await import("node:dns");
  return new Promise((resolve, reject) => {
    // 用公共 DNS 解析，绕过本地 hosts
    const resolver = new dns.Resolver();
    resolver.setServers(["8.8.8.8", "1.1.1.1"]);
    resolver.resolve4(ORIGINAL_HOST, (err, addresses) => {
      if (err) {
        console.error(`[proxy] DNS resolve failed for ${ORIGINAL_HOST}:`, err.message);
        reject(err);
      } else {
        resolvedOriginalIP = addresses[0];
        console.log(`[proxy] ${ORIGINAL_HOST} resolved to ${resolvedOriginalIP}`);
        resolve(resolvedOriginalIP);
      }
    });
  });
}

// ---- Captures directory ----
const CAPTURES_DIR = path.join(PROJECT_ROOT, "captures");
if (!fs.existsSync(CAPTURES_DIR)) fs.mkdirSync(CAPTURES_DIR, { recursive: true });

// Key endpoints we want full body dumps for
const KEY_ENDPOINTS = [
  "GetChatMessage",
  "GetCommandModelConfigs",
  "GetModelStatuses",
  "CheckUserMessageRateLimit",
  "GetUserStatus",
  "GetUserJwt",
  "Ping",
  "GetStatus",
  "GetDefaultWorkflowTemplates",
  "GetProfileData",
];

function isKeyEndpoint(urlPath) {
  return KEY_ENDPOINTS.some((ep) => urlPath.includes(ep));
}

function endpointName(urlPath) {
  // /exa.api_server_pb.ApiServerService/GetChatMessage -> GetChatMessage
  const parts = urlPath.split("/");
  return parts[parts.length - 1] || urlPath;
}

// ---- Protobuf wire format decoder (no .proto needed) ----
function decodeProtobuf(buf, depth = 0) {
  const fields = [];
  let offset = 0;
  const maxDepth = 4;

  while (offset < buf.length) {
    try {
      const { value: tag, bytesRead: tagBytes } = readVarint(buf, offset);
      offset += tagBytes;
      const fieldNumber = Number(tag >> 3n);
      const wireType = Number(tag & 7n);

      let fieldValue;
      switch (wireType) {
        case 0: { // varint
          const { value, bytesRead } = readVarint(buf, offset);
          offset += bytesRead;
          fieldValue = { type: "varint", value: Number(value) };
          break;
        }
        case 1: { // 64-bit
          if (offset + 8 > buf.length) return fields;
          fieldValue = { type: "fixed64", value: buf.readBigUInt64LE(offset) };
          offset += 8;
          break;
        }
        case 2: { // length-delimited (string, bytes, or embedded message)
          const { value: len, bytesRead } = readVarint(buf, offset);
          offset += bytesRead;
          const dataLen = Number(len);
          if (offset + dataLen > buf.length) return fields;
          const data = buf.subarray(offset, offset + dataLen);
          offset += dataLen;

          // Try to detect if it's a UTF-8 string
          const strVal = data.toString("utf8");
          const isPrintable = /^[\x20-\x7E\n\r\t]+$/.test(strVal) && strVal.length > 0;

          if (isPrintable && strVal.length < 2000) {
            fieldValue = { type: "string", value: strVal };
          } else if (depth < maxDepth) {
            // Try to decode as nested protobuf
            try {
              const nested = decodeProtobuf(data, depth + 1);
              if (nested.length > 0 && nested.length < 100) {
                fieldValue = { type: "message", value: nested };
              } else {
                fieldValue = { type: "bytes", length: dataLen, preview: data.subarray(0, 32).toString("hex") };
              }
            } catch {
              fieldValue = { type: "bytes", length: dataLen, preview: data.subarray(0, 32).toString("hex") };
            }
          } else {
            fieldValue = { type: "bytes", length: dataLen, preview: data.subarray(0, 32).toString("hex") };
          }
          break;
        }
        case 5: { // 32-bit
          if (offset + 4 > buf.length) return fields;
          fieldValue = { type: "fixed32", value: buf.readUInt32LE(offset) };
          offset += 4;
          break;
        }
        default:
          return fields; // unknown wire type, stop
      }

      fields.push({ field: fieldNumber, ...fieldValue });
    } catch {
      break;
    }
  }
  return fields;
}

function readVarint(buf, offset) {
  let value = 0n;
  let shift = 0n;
  let bytesRead = 0;
  while (offset < buf.length) {
    const byte = buf[offset++];
    bytesRead++;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
    if (shift > 63n) throw new Error("varint too long");
  }
  return { value, bytesRead };
}

function formatProtoFields(fields, indent = "  ") {
  const lines = [];
  for (const f of fields) {
    if (f.type === "message") {
      lines.push(`${indent}field ${f.field} (message):`);
      lines.push(formatProtoFields(f.value, indent + "  "));
    } else if (f.type === "string") {
      const display = f.value.length > 200 ? f.value.substring(0, 200) + "..." : f.value;
      lines.push(`${indent}field ${f.field} (string): ${JSON.stringify(display)}`);
    } else if (f.type === "bytes") {
      lines.push(`${indent}field ${f.field} (bytes[${f.length}]): ${f.preview}`);
    } else if (f.type === "varint") {
      lines.push(`${indent}field ${f.field} (varint): ${f.value}`);
    } else if (f.type === "fixed64") {
      lines.push(`${indent}field ${f.field} (fixed64): ${f.value}`);
    } else if (f.type === "fixed32") {
      lines.push(`${indent}field ${f.field} (fixed32): ${f.value}`);
    }
  }
  return lines.join("\n");
}

// ---- 请求计数 & 日志 ----
let requestCount = 0;

function logRequest(method, url, targetDesc, statusCode, durationMs) {
  requestCount++;
  const ts = new Date().toLocaleTimeString();
  const status = statusCode ? `\u2190 ${statusCode}` : "\u2192";
  console.log(`[${ts}] #${requestCount} ${method} ${url} ${status} (${targetDesc}, ${durationMs}ms)`);
}

// ---- 创建 HTTPS 服务器 ----
const server = https.createServer(tlsOptions, (clientReq, clientRes) => {
  const startTime = Date.now();
  const fullUrl = `https://${ORIGINAL_HOST}${clientReq.url}`;

  // 收集请求体
  const bodyChunks = [];
  clientReq.on("data", (chunk) => bodyChunks.push(chunk));
  clientReq.on("end", () => {
    const body = Buffer.concat(bodyChunks);

    if (GATEWAY_URL) {
      // ---- 模式 A：转发到自建网关 ----
      forwardToGateway(clientReq, clientRes, body, fullUrl, startTime);
    } else {
      // ---- 模式 B：透传到官方后端（抓包模式） ----
      forwardToOriginal(clientReq, clientRes, body, fullUrl, startTime);
    }
  });
});

// ---- 模式 A：转发到自建网关 ----
function forwardToGateway(clientReq, clientRes, body, fullUrl, startTime) {
  const gwUrl = new URL(GATEWAY_URL);
  const transport = gwUrl.protocol === "https:" ? https : http;

  const options = {
    hostname: gwUrl.hostname,
    port: gwUrl.port || (gwUrl.protocol === "https:" ? 443 : 80),
    path: clientReq.url,
    method: clientReq.method,
    headers: {
      ...clientReq.headers,
      host: gwUrl.host,
      "x-original-host": ORIGINAL_HOST,
      "x-intercepted-by": "cyber-drill-local-proxy",
    },
  };

  const proxyReq = transport.request(options, (proxyRes) => {
    logRequest(clientReq.method, fullUrl, `→ gateway ${gwUrl.host}`, proxyRes.statusCode, Date.now() - startTime);

    clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(clientRes);
  });

  proxyReq.on("error", (err) => {
    console.error(`[proxy] gateway error: ${err.message}`);
    clientRes.writeHead(502, { "Content-Type": "application/json" });
    clientRes.end(JSON.stringify({ error: "gateway unreachable", detail: err.message }));
  });

  if (body.length > 0) proxyReq.write(body);
  proxyReq.end();
}

// ---- 模式 B：透传到官方后端 ----
function forwardToOriginal(clientReq, clientRes, body, fullUrl, startTime) {
  if (!resolvedOriginalIP) {
    clientRes.writeHead(503, { "Content-Type": "application/json" });
    clientRes.end(JSON.stringify({ error: "original IP not resolved yet" }));
    return;
  }

  const options = {
    hostname: resolvedOriginalIP,
    port: ORIGINAL_PORT,
    path: clientReq.url,
    method: clientReq.method,
    headers: {
      ...clientReq.headers,
      host: ORIGINAL_HOST, // 保持原始 Host header
    },
    servername: ORIGINAL_HOST, // SNI
    rejectUnauthorized: true,
  };

  const proxyReq = https.request(options, (proxyRes) => {
    // Collect response body
    const resChunks = [];
    proxyRes.on("data", (chunk) => resChunks.push(chunk));
    proxyRes.on("end", () => {
      const resBody = Buffer.concat(resChunks);
      const epName = endpointName(clientReq.url);
      const isKey = isKeyEndpoint(clientReq.url);

      logRequest(clientReq.method, fullUrl, `-> official ${resolvedOriginalIP}`, proxyRes.statusCode, Date.now() - startTime);

      if (isKey) {
        // Log headers
        console.log(`  [headers] content-type: ${clientReq.headers["content-type"] || "n/a"}`);
        console.log(`  [headers] authorization: ${(clientReq.headers["authorization"] || "n/a").substring(0, 60)}...`);
        console.log(`  [req body] ${body.length} bytes`);
        console.log(`  [res body] ${resBody.length} bytes, content-type: ${proxyRes.headers["content-type"] || "n/a"}`);

        // Decode request protobuf (skip gRPC-Web 5-byte frame header if present)
        let reqPayload = body;
        if (body.length > 5 && body[0] === 0x00) {
          const frameLen = body.readUInt32BE(1);
          reqPayload = body.subarray(5, 5 + frameLen);
        }
        if (reqPayload.length > 0) {
          const reqFields = decodeProtobuf(reqPayload);
          if (reqFields.length > 0) {
            console.log(`  [req proto] ${reqFields.length} fields:`);
            console.log(formatProtoFields(reqFields, "    "));
          }
        }

        // Decode response protobuf
        let resPayload = resBody;
        if (resBody.length > 5 && resBody[0] === 0x00) {
          const frameLen = resBody.readUInt32BE(1);
          resPayload = resBody.subarray(5, 5 + frameLen);
        }
        if (resPayload.length > 0) {
          const resFields = decodeProtobuf(resPayload);
          if (resFields.length > 0) {
            console.log(`  [res proto] ${resFields.length} fields:`);
            console.log(formatProtoFields(resFields, "    "));
          }
        }

        // Save to files
        const ts = Date.now();
        const prefix = path.join(CAPTURES_DIR, `${ts}_${epName}`);
        fs.writeFileSync(`${prefix}_req_headers.json`, JSON.stringify({
          method: clientReq.method,
          url: clientReq.url,
          headers: clientReq.headers,
        }, null, 2));
        fs.writeFileSync(`${prefix}_req_body.bin`, body);
        fs.writeFileSync(`${prefix}_res_headers.json`, JSON.stringify({
          statusCode: proxyRes.statusCode,
          headers: proxyRes.headers,
        }, null, 2));
        fs.writeFileSync(`${prefix}_res_body.bin`, resBody);
        console.log(`  [saved] ${prefix}_*.{json,bin}`);
      }

      // Forward response to client
      clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
      clientRes.end(resBody);
    });
  });

  proxyReq.on("error", (err) => {
    console.error(`[proxy] upstream error: ${err.message}`);
    clientRes.writeHead(502, { "Content-Type": "application/json" });
    clientRes.end(JSON.stringify({ error: "upstream unreachable", detail: err.message }));
  });

  if (body.length > 0) proxyReq.write(body);
  proxyReq.end();
}

// ---- 启动 ----
async function start() {
  if (!GATEWAY_URL) {
    console.log("[proxy] 模式：透传到官方后端（抓包模式）");
    console.log("[proxy] 正在解析官方域名的真实 IP...");
    await resolveOriginalIP();
  } else {
    console.log(`[proxy] 模式：转发到网关 ${GATEWAY_URL}`);
  }

  server.listen(LISTEN_PORT, LISTEN_HOST, () => {
    console.log("");
    console.log("============================================");
    console.log(`  本地代理已启动：https://${LISTEN_HOST}:${LISTEN_PORT}`);
    console.log(`  拦截域名：${ORIGINAL_HOST}`);
    if (GATEWAY_URL) {
      console.log(`  转发到：${GATEWAY_URL}`);
    } else {
      console.log(`  转发到：官方后端 (${resolvedOriginalIP}:${ORIGINAL_PORT})`);
    }
    console.log("============================================");
    console.log("");
  });
}

start().catch((err) => {
  console.error("[proxy] 启动失败:", err.message);
  process.exit(1);
});
