import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "./session-manager.js";
import https from "node:https";
import { getAdapter, sendAdapterRequest, sendAdapterStreamRequest } from "./protocol-adapter.js";
import { replaceConnectCredentials } from "./connect-proto.js";
import { UserManager } from "./user-manager.js";
import { getUserByApiKey, deductCredit, getActiveSubscription } from "./database.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const ENV_FILE = path.join(PROJECT_ROOT, ".env");

loadEnvFile(ENV_FILE);

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith("#")) {
      continue;
    }

    const index = text.indexOf("=");
    if (index <= 0) {
      continue;
    }

    const key = text.slice(0, index).trim();
    let value = text.slice(index + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!Object.prototype.hasOwnProperty.call(process.env, key)) {
      process.env[key] = value;
    }
  }
}

const PORT = Number(process.env.PORT ?? 18790);
const HOST = process.env.HOST ?? "0.0.0.0";
const MAX_RPM_PER_TOKEN = Number(process.env.MAX_RPM_PER_TOKEN ?? 30);
const INVALID_TOKEN_ALERT_THRESHOLD = Number(
  process.env.INVALID_TOKEN_ALERT_THRESHOLD ?? 3,
);
const EVENT_RETENTION = Number(process.env.EVENT_RETENTION ?? 5000);
const ACCOUNT_POOL_FILE = path.resolve(
  PROJECT_ROOT,
  process.env.ACCOUNT_POOL_FILE ?? "config/accounts.json",
);
const ACCOUNT_HEALTHCHECK_INTERVAL_MS = Number(
  process.env.ACCOUNT_HEALTHCHECK_INTERVAL_MS ?? 30_000,
);
const ACCOUNT_HEALTHCHECK_TIMEOUT_MS = Number(
  process.env.ACCOUNT_HEALTHCHECK_TIMEOUT_MS ?? 2_500,
);
const ACCOUNT_HEALTHCHECK_FAILURE_THRESHOLD = Number(
  process.env.ACCOUNT_HEALTHCHECK_FAILURE_THRESHOLD ?? 3,
);
const ACCOUNT_HEALTHCHECK_RECOVERY_THRESHOLD = Number(
  process.env.ACCOUNT_HEALTHCHECK_RECOVERY_THRESHOLD ?? 2,
);
const DEFAULT_ACCOUNT_DAILY_LIMIT = Number(process.env.DEFAULT_ACCOUNT_DAILY_LIMIT ?? 80_000);
const SESSIONS_FILE = process.env.SESSIONS_FILE ?? "config/sessions.json";
const USERS_FILE = process.env.USERS_FILE ?? "config/users.json";

// ---- Windsurf Credits 模型消耗映射（对标 Windsurf 官方积分体系） ----
const MODEL_CREDITS = {
  // 免费模型
  "swe-1": 0, "swe-1-lite": 0,
  // 0.5 credits
  "gpt-5-low": 0.5, "kimi-k2": 0.5, "qwen3-coder": 0.5,
  "gpt-4o-mini": 0.5, "deepseek-chat": 0.5,
  // 1 credit
  "gemini-2.5-pro": 1, "gpt-4o": 1, "gpt-4": 1,
  "claude-3-5-sonnet-20241022": 1, "deepseek-reasoner": 1,
  // 1.5 credits
  "gpt-5-high": 1.5, "gpt-5": 1.5,
  // 按 token（用平均估算）
  "claude-sonnet-4-20250514": 5, "claude-sonnet-4": 5,
  // 高消耗模型
  "claude-opus-4.1-thinking": 20, "claude-opus-4": 20, "claude-opus": 20,
};
const DEFAULT_MODEL_CREDITS = 1;

function getModelCredits(model) {
  if (!model) return DEFAULT_MODEL_CREDITS;
  const lower = model.toLowerCase();
  if (MODEL_CREDITS[lower] !== undefined) return MODEL_CREDITS[lower];
  for (const [key, cost] of Object.entries(MODEL_CREDITS)) {
    if (lower.includes(key) || key.includes(lower)) return cost;
  }
  return DEFAULT_MODEL_CREDITS;
}

// ---- User Manager (文件驱动用户管理 + 积分恢复) ----
const userManager = new UserManager({
  projectRoot: PROJECT_ROOT,
  usersFile: USERS_FILE,
});

try { userManager.load(); } catch (e) {
  console.log(`[lab] user manager init error: ${e.message}`);
}

let ACCOUNT_POOL = [];
try {
  ACCOUNT_POOL = loadAccountPoolFromFile(ACCOUNT_POOL_FILE);
} catch (e) {
  console.log(`[lab] account pool not loaded: ${e.message} (using session manager only)`);
}

// ---- Session Manager (平台会话池) ----
const sessionManager = new SessionManager({
  projectRoot: PROJECT_ROOT,
  sessionsFile: SESSIONS_FILE,
  keepaliveIntervalMs: Number(process.env.SESSION_KEEPALIVE_INTERVAL_MS ?? 300_000),
  healthCheckIntervalMs: Number(process.env.SESSION_HEALTHCHECK_INTERVAL_MS ?? 60_000),
  healthCheckTimeoutMs: Number(process.env.SESSION_HEALTHCHECK_TIMEOUT_MS ?? 5_000),
  sessionMaxAgeMs: Number(process.env.SESSION_MAX_AGE_MS ?? 86_400_000),
  failureThreshold: Number(process.env.SESSION_FAILURE_THRESHOLD ?? 3),
  recoveryThreshold: Number(process.env.SESSION_RECOVERY_THRESHOLD ?? 2),
  onSessionExpired: (session, reason) => {
    console.log(`[lab] session expired: ${session.id} (${reason})`);
  },
  onSessionRecovered: (session) => {
    console.log(`[lab] session recovered: ${session.id}`);
  },
  keepaliveHandler: async (session) => {
    try {
      const adapter = getAdapter(session.platform);
      const reqSpec = adapter.buildKeepaliveRequest(session);
      if (!reqSpec) return true;
      const resp = await sendAdapterRequest(reqSpec, 10_000);
      return resp.status >= 200 && resp.status < 400;
    } catch { return false; }
  },
  healthCheckHandler: async (session) => {
    try {
      const adapter = getAdapter(session.platform);
      const reqSpec = adapter.buildHealthCheckRequest(session);
      if (!reqSpec) return true;
      const resp = await sendAdapterRequest(reqSpec, 5_000);
      return resp.status >= 200 && resp.status < 400;
    } catch { return false; }
  },
});

// 尝试加载会话池（文件可能不存在）
try { sessionManager.load(); } catch (e) {
  console.log(`[lab] session pool not loaded: ${e.message}`);
}

// ---- Firebase Token 自动刷新 ----
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY || "AIzaSyDsOl-1XpT5err0Tcnx8FFod1H8gVGIycY";
const TOKEN_REFRESH_INTERVAL_MS = Number(process.env.TOKEN_REFRESH_INTERVAL_MS ?? 45 * 60_000); // 45 min

async function refreshFirebaseToken(session) {
  const refreshToken = session.extra?.refreshToken;
  if (!refreshToken) return false;

  return new Promise((resolve) => {
    const postData = JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });

    const req = https.request({
      hostname: "securetoken.googleapis.com",
      port: 443,
      path: `/v1/token?key=${FIREBASE_API_KEY}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData),
      },
      timeout: 10_000,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (body.id_token) {
            session.extra.firebaseIdToken = body.id_token;
            if (body.refresh_token) session.extra.refreshToken = body.refresh_token;
            console.log(`[token-refresh] ✓ ${session.id} token refreshed`);
            resolve(true);
          } else {
            console.log(`[token-refresh] ✗ ${session.id} no id_token in response`);
            resolve(false);
          }
        } catch (err) {
          console.log(`[token-refresh] ✗ ${session.id} parse error: ${err.message}`);
          resolve(false);
        }
      });
    });
    req.on("error", (err) => {
      console.log(`[token-refresh] ✗ ${session.id} request error: ${err.message}`);
      resolve(false);
    });
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.write(postData);
    req.end();
  });
}

async function refreshAllTokens() {
  let refreshed = 0;
  for (const session of sessionManager.sessions) {
    if (!session.extra?.refreshToken) continue;
    const ok = await refreshFirebaseToken(session);
    if (ok) refreshed++;
    await new Promise((r) => setTimeout(r, 1000)); // 1s delay between refreshes
  }
  if (refreshed > 0) {
    sessionManager.save();
    console.log(`[token-refresh] saved ${refreshed} refreshed tokens`);
  }
}

// Initial refresh on startup + periodic refresh
setTimeout(() => refreshAllTokens(), 5_000);
setInterval(() => refreshAllTokens(), TOKEN_REFRESH_INTERVAL_MS);

const requestTimeline = new Map();
const events = [];

// ---- Session Credit Tracking (Trial 账号 credits 追踪) ----
const TRIAL_INITIAL_CREDITS = Number(process.env.TRIAL_INITIAL_CREDITS ?? 100);
const TRIAL_LOW_CREDITS_THRESHOLD = Number(process.env.TRIAL_LOW_CREDITS_THRESHOLD ?? 5);
const sessionCreditsMap = new Map(); // sessionId → { remaining, total, requests, lastModel, updatedAt }

// Windsurf 内部模型名 → credits 消耗映射
const WINDSURF_MODEL_CREDITS = {
  // Free (0 credits)
  "swe-1": 0, "swe_1": 0, "swe-1-lite": 0, "swe_1_lite": 0,
  "swe-1.5": 0, "swe_1_5": 0, "swe-1-5": 0,
  // Value (0.5 credits)
  "gpt-5-low": 0.5, "gpt_5_low": 0.5,
  "kimi-k2": 0.5, "kimi_k2": 0.5,
  "qwen3-coder": 0.5, "qwen3_coder": 0.5,
  "gemini-2.5-flash": 0.5, "gemini_2_5_flash": 0.5,
  // Premium (1 credit)
  "gemini-2.5-pro": 1, "gemini_2_5_pro": 1,
  "gpt-4o": 1, "gpt_4o": 1,
  // Premium (1.5 credits)
  "gpt-5": 1.5, "gpt-5-high": 1.5, "gpt_5_high": 1.5,
  // By token (~5 credits average)
  "claude-sonnet-4": 5, "claude_sonnet_4": 5,
  // High consumption (~20 credits)
  "claude-opus-4.1-thinking": 20, "claude_opus_4_1_thinking": 20,
  "claude-opus-4": 20, "claude_opus_4": 20,
};

function getWindsurfModelCredits(modelName) {
  if (!modelName) return 1; // default
  const lower = modelName.toLowerCase().replace(/model_/g, "").replace(/google_|anthropic_|openai_/g, "");
  // Exact match
  if (WINDSURF_MODEL_CREDITS[lower] !== undefined) return WINDSURF_MODEL_CREDITS[lower];
  // Fuzzy match
  for (const [key, cost] of Object.entries(WINDSURF_MODEL_CREDITS)) {
    if (lower.includes(key) || key.includes(lower)) return cost;
  }
  return 1; // default 1 credit for unknown models
}

function getSessionCredits(sessionId) {
  let entry = sessionCreditsMap.get(sessionId);
  if (!entry) {
    entry = { remaining: TRIAL_INITIAL_CREDITS, total: TRIAL_INITIAL_CREDITS, requests: 0, lastModel: null, updatedAt: Date.now() };
    sessionCreditsMap.set(sessionId, entry);
  }
  return entry;
}

function deductSessionCredits(sessionId, model) {
  const entry = getSessionCredits(sessionId);
  const cost = getWindsurfModelCredits(model);
  const before = entry.remaining;
  entry.remaining = Math.max(0, entry.remaining - cost);
  entry.requests++;
  entry.lastModel = model;
  entry.updatedAt = Date.now();
  return { before, after: entry.remaining, cost, model };
}

// 当 session credits 耗尽，清除绑定该 session 的所有 affinity
function evictSessionAffinity(sessionId) {
  let evicted = 0;
  for (const [ip, aff] of sessionAffinityMap) {
    if (aff.sessionId === sessionId) {
      sessionAffinityMap.delete(ip);
      evicted++;
    }
  }
  return evicted;
}

// 从 protobuf 响应中提取 model 名称（兼容 Windsurf 内部格式）
function extractModelFromWindsurfResponse(resBody) {
  try {
    const str = resBody.toString("utf8");
    // Windsurf 内部格式: MODEL_CLAUDE_SONNET_4, MODEL_SWE_1_5_SLOW 等
    const internalMatch = str.match(/MODEL_([A-Z0-9_]+)/i);
    if (internalMatch) return internalMatch[0].toLowerCase();
    // 标准格式: claude-sonnet-4, gpt-5 等
    const stdMatch = str.match(/(claude-[a-z0-9._-]+|gpt-[a-z0-9._-]+|gemini-[a-z0-9._-]+|swe-[a-z0-9._-]+|kimi-[a-z0-9._-]+|qwen[a-z0-9._-]+|deepseek-[a-z0-9._-]+)/i);
    if (stdMatch) return stdMatch[1].toLowerCase();
    return null;
  } catch { return null; }
}

// ---- Session Affinity (用户/IP → 固定注册号绑定) ----
const SESSION_AFFINITY_TTL_MS = Number(process.env.SESSION_AFFINITY_TTL_MS ?? 30 * 60_000); // 30 min
const MAX_USERS_PER_SESSION = Number(process.env.MAX_USERS_PER_SESSION ?? 4);
const sessionAffinityMap = new Map(); // clientIp → { sessionId, expiresAt }

function getAffinitySession(clientIp) {
  const entry = sessionAffinityMap.get(clientIp);
  if (entry && entry.expiresAt > Date.now()) {
    // Check the session is still alive
    const sessions = sessionManager.getEnabledSessions();
    const bound = sessions.find(s => s.id === entry.sessionId);
    if (bound) {
      // Check if bound session still has credits
      const credits = getSessionCredits(bound.id);
      if (credits.remaining > 0) {
        // Extend TTL on use
        entry.expiresAt = Date.now() + SESSION_AFFINITY_TTL_MS;
        return bound;
      }
      // Credits exhausted → force re-bind
      console.log(`[affinity] ${clientIp}: session ${bound.id} credits exhausted (${credits.requests} reqs), re-binding...`);
      sessionAffinityMap.delete(clientIp);
    } else {
      // Session died, clear affinity
      sessionAffinityMap.delete(clientIp);
    }
  }

  // Pick a new session with affinity-aware + credit-aware load balancing
  const sessions = sessionManager.getEnabledSessions();
  if (sessions.length === 0) return null;

  // Count current bindings per session
  const bindCount = new Map();
  const now = Date.now();
  for (const [, aff] of sessionAffinityMap) {
    if (aff.expiresAt > now) {
      bindCount.set(aff.sessionId, (bindCount.get(aff.sessionId) ?? 0) + 1);
    }
  }

  // Filter: must have credits > 0 AND not at max bindings
  const candidates = sessions
    .filter(s => {
      const credits = getSessionCredits(s.id);
      return credits.remaining > 0 && (bindCount.get(s.id) ?? 0) < MAX_USERS_PER_SESSION;
    })
    .sort((a, b) => {
      const ba = bindCount.get(a.id) ?? 0;
      const bb = bindCount.get(b.id) ?? 0;
      if (ba !== bb) return ba - bb; // fewer bindings first
      // Then prefer more remaining credits
      const ca = getSessionCredits(a.id).remaining;
      const cb = getSessionCredits(b.id).remaining;
      return cb - ca; // more credits first
    });

  if (candidates.length === 0) {
    // All sessions depleted or at max capacity → fallback to session with most credits
    const fallback = sessions
      .filter(s => getSessionCredits(s.id).remaining > 0)
      .sort((a, b) => getSessionCredits(b.id).remaining - getSessionCredits(a.id).remaining)[0];
    if (!fallback) {
      // All sessions have 0 credits — pick least-used as last resort
      const lastResort = sessions.sort((a, b) => {
        const sa = sessionManager.sessionState.get(a.id);
        const sb = sessionManager.sessionState.get(b.id);
        return (sa?.usedTokens ?? 0) - (sb?.usedTokens ?? 0);
      })[0];
      console.log(`[affinity] ${clientIp} -> ${lastResort.id} (ALL sessions depleted, last resort)`);
      sessionAffinityMap.set(clientIp, { sessionId: lastResort.id, expiresAt: Date.now() + SESSION_AFFINITY_TTL_MS });
      return lastResort;
    }
    sessionAffinityMap.set(clientIp, { sessionId: fallback.id, expiresAt: Date.now() + SESSION_AFFINITY_TTL_MS });
    console.log(`[affinity] ${clientIp} -> ${fallback.id} (overflow, credits=${Math.round(getSessionCredits(fallback.id).remaining)})`);
    return fallback;
  }

  const picked = candidates[0];
  sessionAffinityMap.set(clientIp, { sessionId: picked.id, expiresAt: Date.now() + SESSION_AFFINITY_TTL_MS });
  console.log(`[affinity] ${clientIp} -> ${picked.id} (${(bindCount.get(picked.id) ?? 0) + 1} users, credits=${Math.round(getSessionCredits(picked.id).remaining)})`);
  return picked;
}

// Cleanup expired affinity entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of sessionAffinityMap) {
    if (entry.expiresAt <= now) sessionAffinityMap.delete(ip);
  }
}, 300_000).unref?.();

// ---- Bandwidth / smoothness tracking ----
const bandwidthStats = {
  concurrentRequests: 0,
  peakConcurrent: 0,
  // Rolling window of recent request metrics (last 200)
  recentRequests: [],
  maxRecent: 200,
  // Totals since startup
  totalRequests: 0,
  totalBytesIn: 0,
  totalBytesOut: 0,
  totalErrors: 0,
  startedAt: Date.now(),
};

function bwTrackStart() {
  bandwidthStats.concurrentRequests++;
  if (bandwidthStats.concurrentRequests > bandwidthStats.peakConcurrent) {
    bandwidthStats.peakConcurrent = bandwidthStats.concurrentRequests;
  }
  return { startTime: Date.now(), bytesIn: 0, bytesOut: 0 };
}

function bwTrackEnd(tracker, statusCode) {
  bandwidthStats.concurrentRequests = Math.max(0, bandwidthStats.concurrentRequests - 1);
  const durationMs = Date.now() - tracker.startTime;
  const entry = {
    ts: Date.now(),
    durationMs,
    bytesIn: tracker.bytesIn,
    bytesOut: tracker.bytesOut,
    status: statusCode,
    ok: statusCode >= 200 && statusCode < 400,
  };
  bandwidthStats.recentRequests.push(entry);
  if (bandwidthStats.recentRequests.length > bandwidthStats.maxRecent) {
    bandwidthStats.recentRequests.shift();
  }
  bandwidthStats.totalRequests++;
  bandwidthStats.totalBytesIn += tracker.bytesIn;
  bandwidthStats.totalBytesOut += tracker.bytesOut;
  if (!entry.ok) bandwidthStats.totalErrors++;
}

function getBandwidthMetrics() {
  const now = Date.now();
  const recent = bandwidthStats.recentRequests;
  const last60s = recent.filter(r => now - r.ts < 60_000);
  const last5m = recent.filter(r => now - r.ts < 300_000);

  // Latency stats
  const latencies = last60s.map(r => r.durationMs);
  const avgLatency = latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
  const p95Latency = latencies.length > 0 ? latencies.sort((a, b) => a - b)[Math.floor(latencies.length * 0.95)] : 0;
  const maxLatency = latencies.length > 0 ? Math.max(...latencies) : 0;

  // Throughput
  const rpm = last60s.length;
  const bytesInPerSec = last60s.length > 0 ? Math.round(last60s.reduce((a, r) => a + r.bytesIn, 0) / 60) : 0;
  const bytesOutPerSec = last60s.length > 0 ? Math.round(last60s.reduce((a, r) => a + r.bytesOut, 0) / 60) : 0;

  // Error rate
  const errors60s = last60s.filter(r => !r.ok).length;
  const errorRate = last60s.length > 0 ? +(errors60s / last60s.length * 100).toFixed(1) : 0;

  // Smoothness score (0-100, higher = smoother)
  // Based on: latency (40%), error rate (30%), concurrency headroom (30%)
  const maxAcceptableLatency = 5000; // 5s
  const latencyScore = Math.max(0, 100 - (avgLatency / maxAcceptableLatency) * 100);
  const errorScore = Math.max(0, 100 - errorRate * 5); // each 1% error = -5 points
  const maxConcurrent = 50; // assume server can handle ~50 concurrent
  const concurrencyScore = Math.max(0, 100 - (bandwidthStats.concurrentRequests / maxConcurrent) * 100);
  const smoothness = Math.round(latencyScore * 0.4 + errorScore * 0.3 + concurrencyScore * 0.3);
  const clampedSmoothness = Math.max(0, Math.min(100, smoothness));

  let level, label;
  if (clampedSmoothness >= 70) { level = "smooth"; label = "流畅"; }
  else if (clampedSmoothness >= 40) { level = "moderate"; label = "适中"; }
  else { level = "congested"; label = "拥堵"; }

  return {
    smoothness: clampedSmoothness,
    level,
    label,
    concurrent: {
      current: bandwidthStats.concurrentRequests,
      peak: bandwidthStats.peakConcurrent,
    },
    latency: {
      avg: avgLatency,
      p95: p95Latency,
      max: maxLatency,
    },
    throughput: {
      rpm,
      bytesInPerSec,
      bytesOutPerSec,
      mbInPerSec: +(bytesInPerSec / 1048576).toFixed(3),
      mbOutPerSec: +(bytesOutPerSec / 1048576).toFixed(3),
    },
    errorRate,
    totals: {
      requests: bandwidthStats.totalRequests,
      bytesIn: bandwidthStats.totalBytesIn,
      bytesOut: bandwidthStats.totalBytesOut,
      errors: bandwidthStats.totalErrors,
      uptimeMin: Math.round((now - bandwidthStats.startedAt) / 60_000),
    },
    factors: {
      latency: Math.round(latencyScore),
      errorRate: Math.round(errorScore),
      concurrency: Math.round(concurrencyScore),
    },
    recentTimeline: last5m.map(r => ({ ts: r.ts, ms: r.durationMs, ok: r.ok })),
  };
}

const logsDir = path.join(PROJECT_ROOT, "logs");
const logFile = path.join(logsDir, "events.jsonl");
fs.mkdirSync(logsDir, { recursive: true });

function toPositiveNumber(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseAccountConfigPayload(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (payload && typeof payload === "object" && Array.isArray(payload.accounts)) {
    return payload.accounts;
  }

  throw new Error("invalid account config: expected an array or { accounts: [] }");
}

function normalizeAccountConfig(rawAccount, index) {
  const idValue = typeof rawAccount?.id === "string" ? rawAccount.id.trim() : "";
  const id = idValue || `session-${index + 1}`;

  return {
    id,
    dailyLimit: toPositiveNumber(rawAccount?.dailyLimit, DEFAULT_ACCOUNT_DAILY_LIMIT),
    configuredEnabled: rawAccount?.enabled !== false,
    healthcheckUrl:
      typeof rawAccount?.healthcheckUrl === "string" && rawAccount.healthcheckUrl.trim()
        ? rawAccount.healthcheckUrl.trim()
        : null,
    apiKey:
      typeof rawAccount?.apiKey === "string" && rawAccount.apiKey.trim()
        ? rawAccount.apiKey.trim()
        : null,
    baseUrl:
      typeof rawAccount?.baseUrl === "string" && rawAccount.baseUrl.trim()
        ? rawAccount.baseUrl.trim().replace(/\/+$/, "")
        : null,
  };
}

function toRuntimeAccount(configAccount, previousAccount) {
  const usedTokens = previousAccount?.usedTokens ?? 0;
  let enabled = configAccount.configuredEnabled;
  let disabledReason = configAccount.configuredEnabled ? null : "disabled_in_config";

  if (usedTokens >= configAccount.dailyLimit) {
    enabled = false;
    disabledReason = "quota_exhausted";
  }

  if (
    previousAccount &&
    previousAccount.disabledReason === "health_check_failed" &&
    configAccount.configuredEnabled &&
    usedTokens < configAccount.dailyLimit
  ) {
    enabled = false;
    disabledReason = "health_check_failed";
  }

  return {
    id: configAccount.id,
    dailyLimit: configAccount.dailyLimit,
    usedTokens,
    enabled,
    configuredEnabled: configAccount.configuredEnabled,
    disabledReason,
    healthcheckUrl: configAccount.healthcheckUrl,
    apiKey: configAccount.apiKey,
    baseUrl: configAccount.baseUrl,
    consecutiveHealthFailures: previousAccount?.consecutiveHealthFailures ?? 0,
    consecutiveHealthSuccesses: previousAccount?.consecutiveHealthSuccesses ?? 0,
    lastHealthCheckAt: previousAccount?.lastHealthCheckAt ?? null,
    lastHealthError: previousAccount?.lastHealthError ?? null,
  };
}

function loadAccountPoolFromFile(filePath, previousPool = []) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`account pool config file not found: ${filePath}`);
  }

  const rawConfig = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  const parsedConfig = JSON.parse(rawConfig);
  const configAccounts = parseAccountConfigPayload(parsedConfig);

  if (!Array.isArray(configAccounts) || configAccounts.length === 0) {
    throw new Error("account pool config is empty");
  }

  const previousById = new Map(previousPool.map((account) => [account.id, account]));

  return configAccounts.map((rawAccount, index) => {
    const configAccount = normalizeAccountConfig(rawAccount, index);
    const previousAccount = previousById.get(configAccount.id);
    return toRuntimeAccount(configAccount, previousAccount);
  });
}

function reloadAccountPoolFromDisk() {
  ACCOUNT_POOL = loadAccountPoolFromFile(ACCOUNT_POOL_FILE, ACCOUNT_POOL);
  return ACCOUNT_POOL;
}

function maskApiKey(key) {
  if (!key) return null;
  if (key.length <= 8) return "****";
  return key.slice(0, 4) + "****" + key.slice(-4);
}

function getAccountPoolStatus() {
  return ACCOUNT_POOL.map((account) => ({
    id: account.id,
    enabled: account.enabled,
    configuredEnabled: account.configuredEnabled,
    disabledReason: account.disabledReason,
    usedTokens: account.usedTokens,
    dailyLimit: account.dailyLimit,
    usagePercent: Number(((account.usedTokens / account.dailyLimit) * 100).toFixed(2)),
    healthcheckUrl: account.healthcheckUrl,
    baseUrl: account.baseUrl,
    apiKey: maskApiKey(account.apiKey),
    mode: account.apiKey && account.baseUrl ? "upstream" : "simulate",
    consecutiveHealthFailures: account.consecutiveHealthFailures,
    consecutiveHealthSuccesses: account.consecutiveHealthSuccesses,
    lastHealthCheckAt: account.lastHealthCheckAt,
    lastHealthError: account.lastHealthError,
  }));
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload, null, 2));
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error("payload_too_large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

function hashToken(token = "") {
  return crypto.createHash("sha256").update(token).digest("hex").slice(0, 12);
}

function estimateTokens(text) {
  if (!text) {
    return 1;
  }
  return Math.max(1, Math.ceil(String(text).length / 3));
}

function collectMessageText(messages) {
  if (!Array.isArray(messages)) {
    return "";
  }
  return messages
    .map((m) => {
      if (typeof m?.content === "string") {
        return m.content;
      }
      return JSON.stringify(m?.content ?? "");
    })
    .join("\n");
}

function detectTags(text) {
  const tags = [];
  if (/ignore\s+previous\s+instructions|jailbreak|越狱|绕过/i.test(text)) {
    tags.push("prompt_injection");
  }
  if (/api[_-]?key|secret|密码|token\s*=|private\s*key/i.test(text)) {
    tags.push("sensitive_probe");
  }
  if (text.length > 6000) {
    tags.push("oversized_payload");
  }
  return tags;
}

function pickAccount() {
  const available = ACCOUNT_POOL.filter(
    (item) => item.enabled && item.usedTokens < item.dailyLimit,
  );
  if (available.length === 0) {
    return null;
  }
  return available.reduce((prev, curr) =>
    prev.usedTokens <= curr.usedTokens ? prev : curr,
  );
}

function recordEvent(event) {
  const data = { ...event, eventId: crypto.randomUUID() };
  events.push(data);
  if (events.length > EVENT_RETENTION) {
    events.shift();
  }
  fs.appendFileSync(logFile, `${JSON.stringify(data)}\n`, "utf8");
  return data;
}

function currentMinuteCount(token) {
  const now = Date.now();
  const recent = (requestTimeline.get(token) ?? []).filter((ts) => now - ts < 60_000);
  requestTimeline.set(token, recent);
  return recent.length;
}

function markRequest(token) {
  const list = requestTimeline.get(token) ?? [];
  list.push(Date.now());
  requestTimeline.set(token, list);
}

async function probeAccountHealth(account) {
  if (!account.healthcheckUrl) {
    return { ok: true, reason: null };
  }

  try {
    const response = await fetch(account.healthcheckUrl, {
      method: "GET",
      signal: AbortSignal.timeout(ACCOUNT_HEALTHCHECK_TIMEOUT_MS),
    });

    if (response.ok) {
      return { ok: true, reason: null };
    }

    return { ok: false, reason: `status_${response.status}` };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? "healthcheck_failed") };
  }
}

async function checkAccountHealth(account) {
  if (!account.configuredEnabled) {
    account.enabled = false;
    account.disabledReason = "disabled_in_config";
    account.consecutiveHealthFailures = 0;
    account.consecutiveHealthSuccesses = 0;
    account.lastHealthCheckAt = new Date().toISOString();
    account.lastHealthError = null;
    return;
  }

  const result = await probeAccountHealth(account);
  account.lastHealthCheckAt = new Date().toISOString();

  if (result.ok) {
    account.lastHealthError = null;
    account.consecutiveHealthFailures = 0;
    account.consecutiveHealthSuccesses += 1;

    if (
      account.disabledReason === "health_check_failed" &&
      account.consecutiveHealthSuccesses >= ACCOUNT_HEALTHCHECK_RECOVERY_THRESHOLD &&
      account.usedTokens < account.dailyLimit
    ) {
      account.enabled = true;
      account.disabledReason = null;
    }
    return;
  }

  account.lastHealthError = result.reason;
  account.consecutiveHealthSuccesses = 0;
  account.consecutiveHealthFailures += 1;

  if (
    account.consecutiveHealthFailures >= ACCOUNT_HEALTHCHECK_FAILURE_THRESHOLD &&
    account.disabledReason !== "quota_exhausted"
  ) {
    account.enabled = false;
    account.disabledReason = "health_check_failed";
  }
}

async function runAccountHealthChecks() {
  await Promise.all(ACCOUNT_POOL.map((account) => checkAccountHealth(account)));
}

function startAccountHealthMonitor() {
  runAccountHealthChecks().catch((error) => {
    console.error("[lab] initial account health check failed:", error);
  });

  const timer = setInterval(() => {
    runAccountHealthChecks().catch((error) => {
      console.error("[lab] account health check failed:", error);
    });
  }, ACCOUNT_HEALTHCHECK_INTERVAL_MS);

  if (typeof timer.unref === "function") {
    timer.unref();
  }
}

function getAlerts() {
  const now = Date.now();
  const inLast10Min = events.filter((event) => now - Date.parse(event.timestamp) < 10 * 60_000);

  const invalidByIp = new Map();
  for (const event of inLast10Min) {
    if (event.status === 401) {
      const key = event.ip ?? "unknown";
      invalidByIp.set(key, (invalidByIp.get(key) ?? 0) + 1);
    }
  }

  const alerts = [];

  for (const [ip, count] of invalidByIp.entries()) {
    if (count >= INVALID_TOKEN_ALERT_THRESHOLD) {
      alerts.push({
        level: "high",
        type: "invalid_token_burst",
        ip,
        count,
        message: `IP ${ip} 在 10 分钟内出现 ${count} 次无效令牌请求`,
      });
    }
  }

  const successEvents = events.filter(
    (event) =>
      (event.status === 200 || event.status === 429) &&
      event.path === "/v1/chat/completions" &&
      now - Date.parse(event.timestamp) < 60_000,
  );
  const tokenRate = new Map();
  for (const event of successEvents) {
    const key = event.tokenHash;
    tokenRate.set(key, (tokenRate.get(key) ?? 0) + 1);
  }
  for (const [tokenHash, rpm] of tokenRate.entries()) {
    if (rpm >= MAX_RPM_PER_TOKEN) {
      alerts.push({
        level: "medium",
        type: "rate_limit_anomaly",
        tokenHash,
        rpm,
        message: `令牌 ${tokenHash} 当前分钟请求数 ${rpm} 达到或超过阈值 ${MAX_RPM_PER_TOKEN}`,
      });
    }
  }

  const injectionEvents = inLast10Min.filter((event) =>
    Array.isArray(event.tags) && event.tags.includes("prompt_injection"),
  );
  if (injectionEvents.length > 0) {
    alerts.push({
      level: "medium",
      type: "prompt_injection_detected",
      count: injectionEvents.length,
      message: `最近 10 分钟检测到 ${injectionEvents.length} 次疑似提示词注入`,
    });
  }

  for (const account of ACCOUNT_POOL) {
    const usage = account.usedTokens / account.dailyLimit;
    if (usage >= 0.8) {
      alerts.push({
        level: "low",
        type: "account_near_quota",
        accountId: account.id,
        usage: Number((usage * 100).toFixed(2)),
        message: `账号 ${account.id} 已使用 ${Number((usage * 100).toFixed(2))}% 配额`,
      });
    }
  }

  return alerts;
}

function resetLab() {
  events.length = 0;
  requestTimeline.clear();
  for (const [id] of userManager.users) {
    userManager.resetCredits(id);
  }
  for (const account of ACCOUNT_POOL) {
    account.usedTokens = 0;
    account.enabled = account.configuredEnabled;
    account.disabledReason = account.configuredEnabled ? null : "disabled_in_config";
    account.consecutiveHealthFailures = 0;
    account.consecutiveHealthSuccesses = 0;
    account.lastHealthCheckAt = null;
    account.lastHealthError = null;
  }
  if (fs.existsSync(logFile)) {
    fs.unlinkSync(logFile);
  }
}

function buildCompletionText(text) {
  const snippet = text.slice(0, 100);
  return `【Lab-Official-Sim】请求已处理。样本内容摘要：${snippet}${text.length > 100 ? "..." : ""}`;
}

const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS ?? 120_000);

async function forwardToUpstream(account, requestBody) {
  const url = `${account.baseUrl}/v1/chat/completions`;
  const upstreamBody = { ...requestBody, stream: false };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${account.apiKey}`,
    },
    body: JSON.stringify(upstreamBody),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`upstream_error_${response.status}: ${errorText.slice(0, 200)}`);
  }

  return response.json();
}

async function forwardStreamToClient(account, requestBody, res) {
  const url = `${account.baseUrl}/v1/chat/completions`;
  const upstreamBody = { ...requestBody, stream: true };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${account.apiKey}`,
    },
    body: JSON.stringify(upstreamBody),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`upstream_error_${response.status}: ${errorText.slice(0, 200)}`);
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  let totalChunks = 0;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      res.write(chunk);
      totalChunks++;
    }
  } finally {
    reader.releaseLock();
  }

  res.end();
  return totalChunks;
}

function scheduleDailyReset() {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  const msUntilMidnight = tomorrow.getTime() - now.getTime();

  const timer = setTimeout(() => {
    console.log("[lab] daily reset: clearing usage counters");
    for (const [id] of userManager.users) {
      userManager.resetCredits(id);
    }
    for (const account of ACCOUNT_POOL) {
      account.usedTokens = 0;
      if (account.disabledReason === "quota_exhausted") {
        account.enabled = account.configuredEnabled;
        account.disabledReason = account.configuredEnabled ? null : "disabled_in_config";
      }
    }
    scheduleDailyReset();
  }, msUntilMidnight);

  if (typeof timer.unref === "function") {
    timer.unref();
  }
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  const clientIp = req.socket.remoteAddress ?? "unknown";

  if (req.method === "GET" && reqUrl.pathname === "/health") {
    return sendJson(res, 200, { ok: true, service: "cyber-drill-safe-lab" });
  }

  if (req.method === "GET" && reqUrl.pathname === "/admin/accounts/status") {
    return sendJson(res, 200, {
      count: ACCOUNT_POOL.length,
      enabledCount: ACCOUNT_POOL.filter((account) => account.enabled).length,
      accounts: getAccountPoolStatus(),
    });
  }

  if (req.method === "POST" && reqUrl.pathname === "/admin/accounts/reload") {
    try {
      reloadAccountPoolFromDisk();
      await runAccountHealthChecks();
      return sendJson(res, 200, {
        ok: true,
        count: ACCOUNT_POOL.length,
        enabledCount: ACCOUNT_POOL.filter((account) => account.enabled).length,
        accounts: getAccountPoolStatus(),
      });
    } catch (error) {
      return sendJson(res, 500, {
        error: {
          message: String(error?.message ?? "account_pool_reload_failed"),
        },
      });
    }
  }

  if (req.method === "POST" && reqUrl.pathname === "/admin/accounts/health-check") {
    await runAccountHealthChecks();
    return sendJson(res, 200, {
      ok: true,
      count: ACCOUNT_POOL.length,
      enabledCount: ACCOUNT_POOL.filter((account) => account.enabled).length,
      accounts: getAccountPoolStatus(),
    });
  }

  if (req.method === "POST" && reqUrl.pathname === "/admin/reset") {
    resetLab();
    return sendJson(res, 200, { ok: true, message: "lab state reset complete" });
  }

  // ---- Session Manager 管理端点 ----

  if (req.method === "GET" && reqUrl.pathname === "/admin/sessions/status") {
    return sendJson(res, 200, {
      count: sessionManager.sessions.length,
      enabledCount: sessionManager.getEnabledSessions().length,
      sessions: sessionManager.getStatus(),
    });
  }

  if (req.method === "POST" && reqUrl.pathname === "/admin/sessions/register") {
    try {
      const body = await parseJsonBody(req);
      const list = Array.isArray(body) ? body : body.sessions ? body.sessions : [body];
      const added = [];
      for (const s of list) {
        if (s.sessionToken) {
          added.push(sessionManager.addSession(s));
        }
      }
      return sendJson(res, 200, { ok: true, added: added.length, sessions: sessionManager.getStatus() });
    } catch (error) {
      return sendJson(res, 400, { error: { message: String(error?.message ?? "bad_request") } });
    }
  }

  if (req.method === "POST" && reqUrl.pathname === "/admin/sessions/reload") {
    try {
      sessionManager.reload();
      return sendJson(res, 200, {
        ok: true,
        count: sessionManager.sessions.length,
        enabledCount: sessionManager.getEnabledSessions().length,
        sessions: sessionManager.getStatus(),
      });
    } catch (error) {
      return sendJson(res, 500, { error: { message: String(error?.message ?? "reload_failed") } });
    }
  }

  if (req.method === "POST" && reqUrl.pathname === "/admin/sessions/remove") {
    try {
      const body = await parseJsonBody(req);
      const id = body?.id;
      if (!id) return sendJson(res, 400, { error: { message: "id is required" } });
      sessionManager.removeSession(id);
      return sendJson(res, 200, { ok: true, removed: id });
    } catch (error) {
      return sendJson(res, 400, { error: { message: String(error?.message ?? "bad_request") } });
    }
  }

  if (req.method === "POST" && reqUrl.pathname === "/admin/sessions/health-check") {
    await sessionManager.runHealthChecks();
    return sendJson(res, 200, {
      ok: true,
      count: sessionManager.sessions.length,
      enabledCount: sessionManager.getEnabledSessions().length,
      sessions: sessionManager.getStatus(),
    });
  }

  if (req.method === "GET" && reqUrl.pathname === "/admin/bandwidth") {
    const bw = getBandwidthMetrics();
    // Attach affinity stats
    const now = Date.now();
    const activeBindings = [];
    for (const [ip, entry] of sessionAffinityMap) {
      if (entry.expiresAt > now) {
        activeBindings.push({ ip, sessionId: entry.sessionId, expiresIn: Math.round((entry.expiresAt - now) / 1000) });
      }
    }
    bw.affinity = {
      activeBindings: activeBindings.length,
      maxPerSession: MAX_USERS_PER_SESSION,
      ttlMinutes: Math.round(SESSION_AFFINITY_TTL_MS / 60_000),
      bindings: activeBindings,
    };
    return sendJson(res, 200, bw);
  }

  if (req.method === "GET" && reqUrl.pathname === "/soc/events") {
    const limit = Math.min(Number(reqUrl.searchParams.get("limit") ?? 200), 1000);
    return sendJson(res, 200, { total: events.length, events: events.slice(-limit) });
  }

  if (req.method === "GET" && reqUrl.pathname === "/soc/alerts") {
    return sendJson(res, 200, { generatedAt: new Date().toISOString(), alerts: getAlerts() });
  }

  // ---- User Manager 管理端点 ----

  if (req.method === "GET" && reqUrl.pathname === "/admin/users/status") {
    return sendJson(res, 200, {
      count: userManager.users.size,
      enabledCount: userManager.getEnabledCount(),
      users: userManager.getStatus(),
    });
  }

  if (req.method === "POST" && reqUrl.pathname === "/admin/users/create") {
    try {
      const body = await parseJsonBody(req);
      const created = userManager.createUser(body);
      return sendJson(res, 200, { ok: true, user: { ...created, token: created.token } });
    } catch (error) {
      return sendJson(res, 400, { error: { message: String(error?.message ?? "bad_request") } });
    }
  }

  if (req.method === "POST" && reqUrl.pathname === "/admin/users/update") {
    try {
      const body = await parseJsonBody(req);
      if (!body?.id) return sendJson(res, 400, { error: { message: "id is required" } });
      const updated = userManager.updateUser(body.id, body);
      return sendJson(res, 200, { ok: true, user: updated });
    } catch (error) {
      return sendJson(res, 400, { error: { message: String(error?.message ?? "bad_request") } });
    }
  }

  if (req.method === "POST" && reqUrl.pathname === "/admin/users/delete") {
    try {
      const body = await parseJsonBody(req);
      if (!body?.id) return sendJson(res, 400, { error: { message: "id is required" } });
      userManager.deleteUser(body.id);
      return sendJson(res, 200, { ok: true, deleted: body.id });
    } catch (error) {
      return sendJson(res, 400, { error: { message: String(error?.message ?? "bad_request") } });
    }
  }

  if (req.method === "POST" && reqUrl.pathname === "/admin/users/reset-credits") {
    try {
      const body = await parseJsonBody(req);
      if (!body?.id) return sendJson(res, 400, { error: { message: "id is required" } });
      userManager.resetCredits(body.id);
      return sendJson(res, 200, { ok: true, reset: body.id });
    } catch (error) {
      return sendJson(res, 400, { error: { message: String(error?.message ?? "bad_request") } });
    }
  }

  if (req.method === "POST" && reqUrl.pathname === "/admin/users/reload") {
    try {
      userManager.reload();
      return sendJson(res, 200, {
        ok: true,
        count: userManager.users.size,
        enabledCount: userManager.getEnabledCount(),
        users: userManager.getStatus(),
      });
    } catch (error) {
      return sendJson(res, 500, { error: { message: String(error?.message ?? "reload_failed") } });
    }
  }

  // ---- /v1/models 端点（OpenClaw 需要） ----

  if (req.method === "GET" && reqUrl.pathname === "/v1/models") {
    // 认证（可选：如果有 token 就验证，没有也返回模型列表）
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";

    if (token) {
      const authResult = userManager.authenticate(token);
      if (!authResult) {
        return sendJson(res, 401, { error: { message: "unauthorized" } });
      }
    }

    // 聚合所有可用模型（从 upstream 账号的 baseUrl 推断 + 可配置列表）
    const availableModels = [
      { id: "gpt-4o", object: "model", owned_by: "gateway", created: Math.floor(Date.now() / 1000) },
      { id: "gpt-4o-mini", object: "model", owned_by: "gateway", created: Math.floor(Date.now() / 1000) },
      { id: "gpt-4", object: "model", owned_by: "gateway", created: Math.floor(Date.now() / 1000) },
      { id: "claude-sonnet-4-20250514", object: "model", owned_by: "gateway", created: Math.floor(Date.now() / 1000) },
      { id: "claude-3-5-sonnet-20241022", object: "model", owned_by: "gateway", created: Math.floor(Date.now() / 1000) },
      { id: "deepseek-chat", object: "model", owned_by: "gateway", created: Math.floor(Date.now() / 1000) },
      { id: "deepseek-reasoner", object: "model", owned_by: "gateway", created: Math.floor(Date.now() / 1000) },
    ];

    return sendJson(res, 200, { object: "list", data: availableModels });
  }

  // ---- /v1/credits 端点（用户自助查询积分） ----

  if (req.method === "GET" && reqUrl.pathname === "/v1/credits") {
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";

    // Try database auth first
    const dbUser = getUserByApiKey(token);
    if (dbUser) {
      const sub = getActiveSubscription(dbUser.id);
      return sendJson(res, 200, {
        userId: dbUser.id,
        name: dbUser.username,
        credits: {
          available: sub?.quota_remaining ?? 0,
          limit: sub?.quota_total ?? 0,
          plan: sub?.plan || "free",
        },
        recovery: {
          amount: sub?.recovery_amount ?? 0,
          intervalSeconds: sub?.recovery_interval ?? 0,
        },
      });
    }

    // Fallback to file-based userManager
    const authResult = userManager.authenticate(token);
    if (!authResult) {
      return sendJson(res, 401, { error: { message: "unauthorized" } });
    }

    const { config, state } = authResult;
    const available = userManager.getAvailableCredits(config.id);

    return sendJson(res, 200, {
      userId: config.id,
      name: config.name,
      credits: {
        available,
        limit: config.creditLimit,
        used: state.usedCredits,
        usagePercent: Number(((state.usedCredits / config.creditLimit) * 100).toFixed(1)),
      },
      recovery: {
        amount: config.creditRecoveryAmount,
        intervalHours: Number((config.creditRecoveryIntervalMs / 3_600_000).toFixed(1)),
        lastRecoveryAt: state.lastRecoveryAt,
      },
      stats: {
        totalUsed: state.totalUsed,
        requestCount: state.requestCount,
        lastRequestAt: state.lastRequestAt,
      },
    });
  }

  // ---- /v1/session-credits 端点（管理员查询 Trial 账号池 credits 状态） ----
  if (req.method === "GET" && reqUrl.pathname === "/v1/session-credits") {
    const sessions = sessionManager.getEnabledSessions();
    const summary = sessions.map(s => {
      const c = getSessionCredits(s.id);
      return {
        sessionId: s.id,
        email: s.email || s.id,
        credits: { remaining: Math.round(c.remaining * 100) / 100, total: c.total },
        requests: c.requests,
        lastModel: c.lastModel,
        updatedAt: c.updatedAt ? new Date(c.updatedAt).toISOString() : null,
        status: c.remaining <= 0 ? "depleted" : c.remaining <= TRIAL_LOW_CREDITS_THRESHOLD ? "low" : "ok",
      };
    });
    const totalRemaining = summary.reduce((sum, s) => sum + s.credits.remaining, 0);
    const depleted = summary.filter(s => s.status === "depleted").length;
    return sendJson(res, 200, {
      pool: { total: sessions.length, active: sessions.length - depleted, depleted },
      totalCreditsRemaining: Math.round(totalRemaining),
      sessions: summary,
    });
  }

  if (req.method === "POST" && reqUrl.pathname === "/v1/chat/completions") {
    const bwTracker = bwTrackStart();
    // Track response bytes
    const origWrite = res.write.bind(res);
    const origEnd = res.end.bind(res);
    res.write = (chunk, ...args) => { if (chunk) bwTracker.bytesOut += Buffer.byteLength(chunk); return origWrite(chunk, ...args); };
    res.end = (chunk, ...args) => { if (chunk) bwTracker.bytesOut += Buffer.byteLength(chunk); const r = origEnd(chunk, ...args); bwTrackEnd(bwTracker, res.statusCode); return r; };

    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    const tokenHash = hashToken(token);

    const baseEvent = {
      timestamp: new Date().toISOString(),
      method: req.method,
      path: reqUrl.pathname,
      ip: clientIp,
      tokenHash,
    };

    // Try database auth first, fallback to file-based userManager
    const dbUser = getUserByApiKey(token);
    let user, userState, authResult, useDbAuth = false;

    if (dbUser) {
      useDbAuth = true;
      user = { id: dbUser.id, name: dbUser.username };
      userState = {};
    } else {
      authResult = userManager.authenticate(token);
      if (!authResult) {
        recordEvent({ ...baseEvent, status: 401, reason: "invalid_token" });
        return sendJson(res, 401, { error: { message: "unauthorized" } });
      }
      user = authResult.config;
      userState = authResult.state;
    }

    if (currentMinuteCount(token) >= MAX_RPM_PER_TOKEN) {
      recordEvent({ ...baseEvent, status: 429, reason: "rate_limited", user: user.name });
      return sendJson(res, 429, { error: { message: "rate limit exceeded" } });
    }

    // 先解析 body 确定模型，再按模型积分扣减
    let body;
    try {
      body = await parseJsonBody(req);
    } catch (error) {
      recordEvent({ ...baseEvent, status: 400, reason: String(error?.message ?? "bad_request") });
      return sendJson(res, 400, { error: { message: "invalid request body" } });
    }

    const model = typeof body?.model === "string" ? body.model : "lab-model";
    const creditCost = getModelCredits(model);

    // 检查积分余额 & 扣减（按模型 Windsurf credits 扣）
    if (creditCost > 0) {
      if (useDbAuth) {
        const creditResult = deductCredit(dbUser.id, creditCost);
        if (!creditResult.ok) {
          recordEvent({ ...baseEvent, status: 429, reason: creditResult.reason, user: user.name, model, creditCost });
          return sendJson(res, 429, {
            error: { message: creditResult.reason === "no_subscription" ? "no active subscription" : "credits exhausted, will recover automatically" },
            credits: { available: 0, remaining: 0 },
          });
        }
      } else {
        const availableCredits = userManager.getAvailableCredits(user.id);
        if (availableCredits < creditCost) {
          recordEvent({ ...baseEvent, status: 429, reason: "credits_exhausted", user: user.name, model, creditCost });
          return sendJson(res, 429, {
            error: { message: "credits exhausted, will recover automatically" },
            credits: { available: availableCredits, limit: user.creditLimit, nextRecoveryIn: "~" + Math.round(user.creditRecoveryIntervalMs / 60_000) + "min" },
          });
        }
        userManager.consumeCredits(user.id, creditCost);
      }
    }
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    if (messages.length === 0) {
      recordEvent({ ...baseEvent, status: 400, reason: "messages_required", user: user.name });
      return sendJson(res, 400, { error: { message: "messages is required" } });
    }

    const text = collectMessageText(messages);
    const tags = detectTags(text);
    const wantsStream = body?.stream === true;

    const promptTokens = estimateTokens(text);

    const account = pickAccount();

    // ---- 平台会话路由：如果没有可用的 account pool 账号，尝试 session manager ----
    const platformSession = !account ? sessionManager.pickSession() : null;

    if (!account && !platformSession) {
      recordEvent({ ...baseEvent, status: 503, reason: "no_available_account", user: user.name });
      return sendJson(res, 503, { error: { message: "no available account" } });
    }

    markRequest(token);

    // ---- 平台会话转发（通过协议适配器） ----
    if (platformSession) {
      try {
        const adapter = getAdapter(platformSession.platform);
        const requestId = crypto.randomUUID();

        if (wantsStream) {
          const reqSpec = adapter.toPlatform({ ...body, stream: true }, platformSession);
          const upstreamRes = await sendAdapterStreamRequest(reqSpec, UPSTREAM_TIMEOUT_MS);

          if (upstreamRes.statusCode >= 400) {
            const errChunks = [];
            for await (const c of upstreamRes) errChunks.push(c);
            throw new Error(`platform_error_${upstreamRes.statusCode}: ${Buffer.concat(errChunks).toString().slice(0, 200)}`);
          }

          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });

          for await (const chunk of upstreamRes) {
            const text = chunk.toString();
            const lines = text.split("\n");
            for (const line of lines) {
              if (line.startsWith("data: ")) {
                const data = line.slice(6).trim();
                if (data === "[DONE]") {
                  res.write("data: [DONE]\n\n");
                } else {
                  const converted = adapter.fromPlatformStreamChunk(data, { model, requestId });
                  if (converted) {
                    res.write(`data: ${converted}\n\n`);
                  }
                }
              } else if (line.trim()) {
                res.write(line + "\n");
              }
            }
          }

          res.end();

          const streamTokenEstimate = promptTokens + 50;
          sessionManager.recordUsage(platformSession.id, streamTokenEstimate);

          recordEvent({
            ...baseEvent,
            status: 200,
            user: user.name,
            model,
            sessionId: platformSession.id,
            platform: platformSession.platform,
            mode: "platform_stream",
            creditCost,
            promptTokens,
            totalTokens: streamTokenEstimate,
            tags,
          });
          return;
        }

        // 非流式平台转发
        const reqSpec = adapter.toPlatform({ ...body, stream: false }, platformSession);
        const rawResp = await sendAdapterRequest(reqSpec, UPSTREAM_TIMEOUT_MS);

        if (rawResp.status >= 400) {
          throw new Error(`platform_error_${rawResp.status}: ${rawResp.body.slice(0, 200)}`);
        }

        const platformData = JSON.parse(rawResp.body);
        const result = adapter.fromPlatform(platformData, { model, requestId });
        const totalTokens = result?.usage?.total_tokens ?? promptTokens + 50;

        sessionManager.recordUsage(platformSession.id, totalTokens);

        result.lab_meta = {
          routed_session: platformSession.id,
          platform: platformSession.platform,
          mode: "platform",
          tags,
        };

        recordEvent({
          ...baseEvent,
          status: 200,
          user: user.name,
          model,
          sessionId: platformSession.id,
          platform: platformSession.platform,
          mode: "platform",
          creditCost,
          promptTokens,
          totalTokens,
          tags,
        });

        return sendJson(res, 200, result);
      } catch (error) {
        const reason = String(error?.message ?? "platform_failed");
        recordEvent({
          ...baseEvent,
          status: 502,
          reason,
          user: user.name,
          model,
          sessionId: platformSession.id,
          platform: platformSession.platform,
          mode: "platform",
          creditCost,
          tags,
        });
        return sendJson(res, 502, {
          error: { message: `platform error: ${reason}` },
        });
      }
    }

    const isUpstream = !!(account.apiKey && account.baseUrl);

    if (isUpstream) {
      try {
        if (wantsStream) {
          await forwardStreamToClient(account, body, res);
          const streamTokenEstimate = promptTokens + 50;
          account.usedTokens += streamTokenEstimate;
          if (account.usedTokens >= account.dailyLimit) {
            account.enabled = false;
            account.disabledReason = "quota_exhausted";
          }
          recordEvent({
            ...baseEvent,
            status: 200,
            user: user.name,
            model,
            accountId: account.id,
            mode: "upstream_stream",
            creditCost,
            promptTokens,
            totalTokens: streamTokenEstimate,
            tags,
          });
          return;
        }

        const upstreamResult = await forwardToUpstream(account, body);
        const totalTokens = upstreamResult?.usage?.total_tokens ?? promptTokens + 50;
        account.usedTokens += totalTokens;
        if (account.usedTokens >= account.dailyLimit) {
          account.enabled = false;
          account.disabledReason = "quota_exhausted";
        }

        upstreamResult.lab_meta = {
          routed_account: account.id,
          mode: "upstream",
          tags,
        };

        recordEvent({
          ...baseEvent,
          status: 200,
          user: user.name,
          model,
          accountId: account.id,
          mode: "upstream",
          creditCost,
          promptTokens,
          completionTokens: upstreamResult?.usage?.completion_tokens ?? 0,
          totalTokens,
          tags,
        });

        return sendJson(res, 200, upstreamResult);
      } catch (error) {
        const reason = String(error?.message ?? "upstream_failed");
        recordEvent({
          ...baseEvent,
          status: 502,
          reason,
          user: user.name,
          model,
          accountId: account.id,
          mode: "upstream",
          tags,
        });
        return sendJson(res, 502, {
          error: { message: `upstream error: ${reason}` },
        });
      }
    }

    const completionText = buildCompletionText(text);
    const completionTokens = estimateTokens(completionText);
    const totalTokens = promptTokens + completionTokens;

    // 积分已在请求入口按模型扣减，此处不再重复扣
    account.usedTokens += totalTokens;
    if (account.usedTokens >= account.dailyLimit) {
      account.enabled = false;
      account.disabledReason = "quota_exhausted";
    }

    const payload = {
      id: `chatcmpl-${crypto.randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: completionText,
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
      },
      lab_meta: {
        routed_account: account.id,
        mode: "simulate",
        tags,
      },
    };

    recordEvent({
      ...baseEvent,
      status: 200,
      user: user.name,
      model,
      accountId: account.id,
      mode: "simulate",
      creditCost,
      promptTokens,
      completionTokens,
      totalTokens,
      tags,
    });

    return sendJson(res, 200, payload);
  }

  // ---- Client Diagnostic Report (Go EXE 远程回报) ----
  if (req.method === "POST" && reqUrl.pathname === "/api/client/report") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const report = JSON.parse(Buffer.concat(chunks).toString());
        console.log(`[client-report] ip=${clientIp} version=${report.version} proxy=${report.proxy_running} port443=${report.port_443} hosts=${report.hosts_ok} cert=${report.cert_ok} gateway=${report.gateway_ok} error=${report.error || "none"}`);
        recordEvent({
          timestamp: new Date().toISOString(),
          ip: clientIp,
          type: "client_diagnostic",
          ...report,
        });
        sendJson(res, 200, { ok: true, message: "report received" });
      } catch (e) {
        sendJson(res, 400, { error: { message: "invalid report" } });
      }
    });
    return;
  }

  // ---- Raw Connect Protocol Proxy (Windsurf MITM) ----
  // Catches all /exa.* paths forwarded by local-proxy in gateway mode.
  // Picks a session, replaces credentials, forwards to real Windsurf.
  if (req.method === "POST" && reqUrl.pathname.startsWith("/exa.")) {
    const bwTracker = bwTrackStart();
    const origWrite2 = res.write.bind(res);
    const origEnd2 = res.end.bind(res);
    res.write = (chunk, ...args) => { if (chunk) bwTracker.bytesOut += Buffer.byteLength(chunk); return origWrite2(chunk, ...args); };
    res.end = (chunk, ...args) => { if (chunk) bwTracker.bytesOut += Buffer.byteLength(chunk); const r = origEnd2(chunk, ...args); bwTrackEnd(bwTracker, res.statusCode); return r; };

    const bodyChunks = [];
    req.on("data", (c) => bodyChunks.push(c));
    req.on("end", async () => {
      const body = Buffer.concat(bodyChunks);
      bwTracker.bytesIn = body.length;
      const startTime = Date.now();

      // Pick a session with affinity (same IP → same session)
      const session = getAffinitySession(clientIp);
      if (!session) {
        recordEvent({
          timestamp: new Date().toISOString(),
          method: req.method,
          path: reqUrl.pathname,
          ip: clientIp,
          status: 503,
          reason: "no_available_session",
          mode: "windsurf_proxy",
        });
        return sendJson(res, 503, { error: { message: "no available session in pool" } });
      }

      try {
        // Replace credentials in the Connect frame
        const apiKey = session.sessionToken || session.extra?.apiKey;
        const jwtToken = session.extra?.jwtToken || session.extra?.firebaseIdToken || null;
        const modifiedBody = replaceConnectCredentials(body, apiKey, jwtToken);

        // Build upstream headers (forward most headers, swap auth)
        const upstreamHeaders = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (k === "host" || k === "x-original-host" || k === "x-intercepted-by" || k === "connection") continue;
          upstreamHeaders[k] = v;
        }
        upstreamHeaders["host"] = "server.self-serve.windsurf.com";
        // Windsurf requires application/grpc (rejects connect+proto with 415)
        if (upstreamHeaders["content-type"]) {
          upstreamHeaders["content-type"] = upstreamHeaders["content-type"].replace("application/connect+proto", "application/grpc");
        }
        if (jwtToken) {
          upstreamHeaders["authorization"] = `Bearer ${jwtToken}`;
        } else if (apiKey) {
          upstreamHeaders["authorization"] = `Bearer ${apiKey}`;
        }

        // Forward to real Windsurf
        const upstreamReq = https.request({
          hostname: "server.self-serve.windsurf.com",
          port: 443,
          path: reqUrl.pathname,
          method: "POST",
          headers: upstreamHeaders,
          timeout: UPSTREAM_TIMEOUT_MS,
        }, (upstreamRes) => {
          const resChunks = [];
          upstreamRes.on("data", (c) => resChunks.push(c));
          upstreamRes.on("end", () => {
            const resBody = Buffer.concat(resChunks);
            const durationMs = Date.now() - startTime;

            console.log(`[windsurf-proxy] ${reqUrl.pathname} -> ${upstreamRes.statusCode} (${durationMs}ms, session=${session.id})`);

            // DEBUG: log response content for status/profile calls to check account tier
            if (reqUrl.pathname.includes("GetUserStatus") || reqUrl.pathname.includes("GetProfileData")) {
              try {
                const zlib = require("zlib");
                let readable = "";
                if (resBody.length > 5) {
                  const flags = resBody[0];
                  const frameLen = resBody.readUInt32BE(1);
                  const payload = resBody.slice(5, 5 + frameLen);
                  const raw = (flags & 0x01) ? zlib.gunzipSync(payload) : payload;
                  readable = raw.toString("utf8").replace(/[^\x20-\x7E]/g, "|");
                }
                console.log(`[DEBUG-TIER] ${reqUrl.pathname} session=${session.id}: ${readable.substring(0, 500)}`);
              } catch (e) { console.log(`[DEBUG-TIER] parse error: ${e.message}`); }
            }

            // Estimate token usage for accounting
            const tokenEstimate = Math.max(1, Math.ceil(body.length / 50));
            sessionManager.recordUsage(session.id, tokenEstimate);

            // ---- Credit tracking: deduct Trial credits on GetChatMessage ----
            const epName = reqUrl.pathname.split("/").pop();
            let creditInfo = null;
            if (epName === "GetChatMessage" && upstreamRes.statusCode === 200) {
              const model = extractModelFromWindsurfResponse(resBody);
              creditInfo = deductSessionCredits(session.id, model);
              console.log(`[credit-track] session=${session.id} model=${creditInfo.model || "?"} cost=${creditInfo.cost} credits=${Math.round(creditInfo.after)}/${TRIAL_INITIAL_CREDITS}`);

              if (creditInfo.after <= 0) {
                const evicted = evictSessionAffinity(session.id);
                console.log(`[credit-track] session=${session.id} DEPLETED after ${creditInfo.before > 0 ? "this request" : "previous"}, evicted ${evicted} affinity bindings`);
              } else if (creditInfo.after <= TRIAL_LOW_CREDITS_THRESHOLD) {
                console.log(`[credit-track] session=${session.id} LOW credits warning: ${Math.round(creditInfo.after)} remaining`);
              }
            }

            recordEvent({
              timestamp: new Date().toISOString(),
              method: req.method,
              path: reqUrl.pathname,
              ip: clientIp,
              status: upstreamRes.statusCode,
              sessionId: session.id,
              mode: "windsurf_proxy",
              durationMs,
              ...(creditInfo ? { creditCost: creditInfo.cost, creditsRemaining: Math.round(creditInfo.after), model: creditInfo.model } : {}),
            });

            // Forward response headers and body
            const resHeaders = {};
            for (const [k, v] of Object.entries(upstreamRes.headers)) {
              if (k === "transfer-encoding") continue; // we send full body
              resHeaders[k] = v;
            }
            res.writeHead(upstreamRes.statusCode, resHeaders);
            res.end(resBody);
          });
        });

        upstreamReq.on("error", (err) => {
          const durationMs = Date.now() - startTime;
          console.error(`[windsurf-proxy] ${reqUrl.pathname} error: ${err.message} (${durationMs}ms)`);
          recordEvent({
            timestamp: new Date().toISOString(),
            method: req.method,
            path: reqUrl.pathname,
            ip: clientIp,
            status: 502,
            reason: err.message,
            sessionId: session.id,
            mode: "windsurf_proxy",
          });
          sendJson(res, 502, { error: { message: `upstream error: ${err.message}` } });
        });

        upstreamReq.on("timeout", () => {
          upstreamReq.destroy();
          sendJson(res, 504, { error: { message: "upstream timeout" } });
        });

        upstreamReq.write(modifiedBody);
        upstreamReq.end();
      } catch (err) {
        console.error(`[windsurf-proxy] ${reqUrl.pathname} processing error:`, err.message);
        sendJson(res, 500, { error: { message: `proxy processing error: ${err.message}` } });
      }
    });
    return;
  }

  return sendJson(res, 404, { error: { message: "not found" } });
});

server.listen(PORT, HOST, () => {
  const displayHost = HOST === "0.0.0.0" ? "127.0.0.1" : HOST;
  const upstreamCount = ACCOUNT_POOL.filter((a) => a.apiKey && a.baseUrl).length;
  const simulateCount = ACCOUNT_POOL.length - upstreamCount;
  const sessionCount = sessionManager.sessions.length;
  const sessionEnabled = sessionManager.getEnabledSessions().length;
  console.log(`[lab] server listening on http://${displayHost}:${PORT}`);
  console.log(`[lab] users: ${userManager.users.size} (enabled: ${userManager.getEnabledCount()})`);
  console.log(`[lab] account pool: ${ACCOUNT_POOL.length} (upstream: ${upstreamCount}, simulate: ${simulateCount})`);
  console.log(`[lab] session pool: ${sessionCount} (enabled: ${sessionEnabled})`);
  console.log(`[lab] health check interval: ${ACCOUNT_HEALTHCHECK_INTERVAL_MS}ms`);

  // 列出用户令牌（脱敏）
  for (const [id, config] of userManager.users) {
    const masked = config.token.length > 12
      ? config.token.slice(0, 10) + "****" + config.token.slice(-4)
      : config.token;
    console.log(`[lab] user: ${config.name} (${masked}) credits: ${config.creditLimit}`);
  }

  startAccountHealthMonitor();
  scheduleDailyReset();

  // 启动积分恢复
  userManager.startCreditRecovery();

  // 启动会话管理器（如果有会话）
  if (sessionCount > 0) {
    sessionManager.startKeepalive();
    sessionManager.startHealthCheck();
    console.log("[lab] session manager started (keepalive + health check)");
  }
});
