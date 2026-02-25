/**
 * Session Manager - 平台会话生命周期管理
 *
 * 功能：
 * - 从 sessions.json 加载/保存会话池
 * - 会话心跳保活（定期模拟活动，防止 session 过期）
 * - 会话健康检查 + 自动摘除/恢复
 * - 最少使用量轮转选号
 * - 会话过期自动标记 + 告警
 * - 支持外部注入新会话（手动 or Puppeteer 自动登录后写入）
 */

import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import http from "node:http";

// ---- 默认配置 ----
const DEFAULTS = {
  sessionsFile: "config/sessions.json",
  keepaliveIntervalMs: 300_000,     // 5 分钟心跳
  healthCheckIntervalMs: 60_000,    // 1 分钟健康检查
  healthCheckTimeoutMs: 5_000,
  sessionMaxAgeMs: 3_600_000 * 24,  // 24 小时会话最大存活
  failureThreshold: 3,
  recoveryThreshold: 2,
};

/**
 * @typedef {Object} PlatformSession
 * @property {string} id              - 会话唯一 ID（如 account-email 或自动生成）
 * @property {string} platform        - 目标平台标识（如 "codeium", "windsurf", "cursor"）
 * @property {string} sessionToken    - 平台 session token / cookie / JWT
 * @property {string} [refreshToken]  - 刷新令牌（如果平台支持）
 * @property {string} [deviceId]      - 设备指纹
 * @property {string} [userAgent]     - 模拟的 User-Agent
 * @property {number} [dailyLimit]    - 每日请求配额
 * @property {boolean} [enabled]      - 是否启用
 * @property {string} [email]         - 账号邮箱
 * @property {string} [loginMethod]   - 登录方式（email/google/github）
 * @property {Object} [extra]         - 平台特定的额外字段
 * @property {string} [acquiredAt]    - 会话获取时间
 * @property {string} [expiresAt]     - 会话过期时间
 */

export class SessionManager {
  /**
   * @param {Object} opts
   * @param {string} opts.projectRoot
   * @param {string} [opts.sessionsFile]
   * @param {number} [opts.keepaliveIntervalMs]
   * @param {number} [opts.healthCheckIntervalMs]
   * @param {number} [opts.healthCheckTimeoutMs]
   * @param {number} [opts.sessionMaxAgeMs]
   * @param {number} [opts.failureThreshold]
   * @param {number} [opts.recoveryThreshold]
   * @param {Function} [opts.onSessionExpired]  - 会话过期回调
   * @param {Function} [opts.onSessionRecovered] - 会话恢复回调
   * @param {Function} [opts.keepaliveHandler]  - 自定义心跳函数 (session) => Promise<boolean>
   * @param {Function} [opts.healthCheckHandler] - 自定义健康检查 (session) => Promise<boolean>
   */
  constructor(opts) {
    this.projectRoot = opts.projectRoot;
    this.sessionsFile = path.resolve(
      opts.projectRoot,
      opts.sessionsFile ?? DEFAULTS.sessionsFile,
    );
    this.keepaliveIntervalMs = opts.keepaliveIntervalMs ?? DEFAULTS.keepaliveIntervalMs;
    this.healthCheckIntervalMs = opts.healthCheckIntervalMs ?? DEFAULTS.healthCheckIntervalMs;
    this.healthCheckTimeoutMs = opts.healthCheckTimeoutMs ?? DEFAULTS.healthCheckTimeoutMs;
    this.sessionMaxAgeMs = opts.sessionMaxAgeMs ?? DEFAULTS.sessionMaxAgeMs;
    this.failureThreshold = opts.failureThreshold ?? DEFAULTS.failureThreshold;
    this.recoveryThreshold = opts.recoveryThreshold ?? DEFAULTS.recoveryThreshold;

    this.onSessionExpired = opts.onSessionExpired ?? (() => {});
    this.onSessionRecovered = opts.onSessionRecovered ?? (() => {});
    this.keepaliveHandler = opts.keepaliveHandler ?? null;
    this.healthCheckHandler = opts.healthCheckHandler ?? null;

    /** @type {PlatformSession[]} */
    this.sessions = [];
    /** @type {Map<string, Object>} */
    this.sessionState = new Map();

    this._keepaliveTimer = null;
    this._healthCheckTimer = null;
  }

  // ---- 加载/保存 ----

  load() {
    if (!fs.existsSync(this.sessionsFile)) {
      console.log(`[session-mgr] sessions file not found: ${this.sessionsFile}`);
      this.sessions = [];
      return;
    }

    const raw = fs.readFileSync(this.sessionsFile, "utf8").replace(/^\uFEFF/, "");
    const data = JSON.parse(raw);
    const list = Array.isArray(data) ? data : data.sessions ?? [];

    this.sessions = list.map((s, i) => this._normalize(s, i));

    // 初始化运行时状态
    for (const session of this.sessions) {
      if (!this.sessionState.has(session.id)) {
        this.sessionState.set(session.id, {
          usedTokens: 0,
          usedRequests: 0,
          enabled: session.enabled !== false,
          disabledReason: session.enabled === false ? "disabled_in_config" : null,
          consecutiveFailures: 0,
          consecutiveSuccesses: 0,
          lastKeepaliveAt: null,
          lastHealthCheckAt: null,
          lastHealthError: null,
          lastUsedAt: null,
        });
      }
    }

    console.log(`[session-mgr] loaded ${this.sessions.length} sessions from ${this.sessionsFile}`);
  }

  save() {
    const dir = path.dirname(this.sessionsFile);
    fs.mkdirSync(dir, { recursive: true });

    // 合并运行时状态到持久化
    const output = this.sessions.map((s) => {
      const state = this.sessionState.get(s.id);
      return {
        ...s,
        _runtime: state
          ? {
              usedTokens: state.usedTokens,
              usedRequests: state.usedRequests,
              lastUsedAt: state.lastUsedAt,
            }
          : undefined,
      };
    });

    fs.writeFileSync(
      this.sessionsFile,
      JSON.stringify({ sessions: output }, null, 2),
      "utf8",
    );
  }

  reload() {
    const prevStates = new Map(this.sessionState);
    this.load();

    // 恢复之前的运行时状态
    for (const session of this.sessions) {
      if (prevStates.has(session.id)) {
        this.sessionState.set(session.id, prevStates.get(session.id));
      }
    }

    console.log(`[session-mgr] reloaded. active: ${this.getEnabledSessions().length}/${this.sessions.length}`);
  }

  // ---- 会话选择 ----

  /**
   * 选择一个可用会话（最少使用量）
   * @param {string} [platform] - 可选，只选指定平台的会话
   * @returns {PlatformSession|null}
   */
  pickSession(platform) {
    const candidates = this.sessions.filter((s) => {
      const state = this.sessionState.get(s.id);
      if (!state || !state.enabled) return false;
      if (platform && s.platform !== platform) return false;
      if (this._isExpired(s)) return false;
      return true;
    });

    if (candidates.length === 0) return null;

    // 按使用量排序，选最少的
    candidates.sort((a, b) => {
      const sa = this.sessionState.get(a.id);
      const sb = this.sessionState.get(b.id);
      return (sa?.usedTokens ?? 0) - (sb?.usedTokens ?? 0);
    });

    return candidates[0];
  }

  /**
   * 记录会话使用
   */
  recordUsage(sessionId, tokens = 0) {
    const state = this.sessionState.get(sessionId);
    if (!state) return;

    state.usedTokens += tokens;
    state.usedRequests += 1;
    state.lastUsedAt = new Date().toISOString();

    // 检查配额
    const session = this.sessions.find((s) => s.id === sessionId);
    if (session && session.dailyLimit && state.usedTokens >= session.dailyLimit) {
      state.enabled = false;
      state.disabledReason = "quota_exhausted";
    }
  }

  // ---- 会话注入 ----

  /**
   * 添加新会话（从 Puppeteer 自动登录或手动输入）
   * @param {PlatformSession} sessionData
   */
  addSession(sessionData) {
    const normalized = this._normalize(sessionData, this.sessions.length);
    normalized.acquiredAt = normalized.acquiredAt || new Date().toISOString();

    // 去重
    const existingIndex = this.sessions.findIndex((s) => s.id === normalized.id);
    if (existingIndex >= 0) {
      // 更新现有会话的 token
      this.sessions[existingIndex] = { ...this.sessions[existingIndex], ...normalized };
      console.log(`[session-mgr] updated session: ${normalized.id}`);
    } else {
      this.sessions.push(normalized);
      console.log(`[session-mgr] added session: ${normalized.id}`);
    }

    this.sessionState.set(normalized.id, {
      usedTokens: 0,
      usedRequests: 0,
      enabled: normalized.enabled !== false,
      disabledReason: null,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      lastKeepaliveAt: null,
      lastHealthCheckAt: null,
      lastHealthError: null,
      lastUsedAt: null,
    });

    this.save();
    return normalized;
  }

  /**
   * 移除会话
   */
  removeSession(sessionId) {
    this.sessions = this.sessions.filter((s) => s.id !== sessionId);
    this.sessionState.delete(sessionId);
    this.save();
    console.log(`[session-mgr] removed session: ${sessionId}`);
  }

  // ---- 心跳保活 ----

  startKeepalive() {
    if (this._keepaliveTimer) return;

    this._keepaliveTimer = setInterval(async () => {
      await this._runKeepalive();
    }, this.keepaliveIntervalMs);

    console.log(`[session-mgr] keepalive started (interval: ${this.keepaliveIntervalMs}ms)`);
  }

  async _runKeepalive() {
    if (!this.keepaliveHandler) return;

    for (const session of this.sessions) {
      const state = this.sessionState.get(session.id);
      if (!state || !state.enabled) continue;

      try {
        const ok = await this.keepaliveHandler(session);
        state.lastKeepaliveAt = new Date().toISOString();
        if (!ok) {
          console.log(`[session-mgr] keepalive failed for ${session.id}`);
        }
      } catch (err) {
        console.log(`[session-mgr] keepalive error for ${session.id}: ${err.message}`);
      }
    }
  }

  // ---- 健康检查 ----

  startHealthCheck() {
    if (this._healthCheckTimer) return;

    this._healthCheckTimer = setInterval(async () => {
      await this.runHealthChecks();
    }, this.healthCheckIntervalMs);

    // 首次立即执行
    this.runHealthChecks();

    console.log(`[session-mgr] health check started (interval: ${this.healthCheckIntervalMs}ms)`);
  }

  async runHealthChecks() {
    for (const session of this.sessions) {
      const state = this.sessionState.get(session.id);
      if (!state) continue;

      // 检查会话是否过期
      if (this._isExpired(session)) {
        if (state.enabled) {
          state.enabled = false;
          state.disabledReason = "session_expired";
          console.log(`[session-mgr] session expired: ${session.id}`);
          this.onSessionExpired(session, "session_expired");
        }
        continue;
      }

      // 自定义健康检查
      if (this.healthCheckHandler) {
        try {
          const ok = await this.healthCheckHandler(session);
          state.lastHealthCheckAt = new Date().toISOString();

          if (ok) {
            state.consecutiveFailures = 0;
            state.consecutiveSuccesses += 1;
            state.lastHealthError = null;

            // 恢复
            if (
              !state.enabled &&
              state.disabledReason === "health_check_failed" &&
              state.consecutiveSuccesses >= this.recoveryThreshold
            ) {
              state.enabled = true;
              state.disabledReason = null;
              console.log(`[session-mgr] session recovered: ${session.id}`);
              this.onSessionRecovered(session);
            }
          } else {
            state.consecutiveSuccesses = 0;
            state.consecutiveFailures += 1;
            state.lastHealthError = "check returned false";

            if (state.enabled && state.consecutiveFailures >= this.failureThreshold) {
              state.enabled = false;
              state.disabledReason = "health_check_failed";
              console.log(`[session-mgr] session disabled (health): ${session.id}`);
              this.onSessionExpired(session, "health_check_failed");
            }
          }
        } catch (err) {
          state.consecutiveSuccesses = 0;
          state.consecutiveFailures += 1;
          state.lastHealthCheckAt = new Date().toISOString();
          state.lastHealthError = err.message;

          if (state.enabled && state.consecutiveFailures >= this.failureThreshold) {
            state.enabled = false;
            state.disabledReason = "health_check_failed";
            console.log(`[session-mgr] session disabled (error): ${session.id}: ${err.message}`);
            this.onSessionExpired(session, "health_check_failed");
          }
        }
      }
    }
  }

  // ---- 每日重置 ----

  resetDailyUsage() {
    for (const [id, state] of this.sessionState) {
      state.usedTokens = 0;
      state.usedRequests = 0;

      if (state.disabledReason === "quota_exhausted") {
        const session = this.sessions.find((s) => s.id === id);
        if (session && session.enabled !== false) {
          state.enabled = true;
          state.disabledReason = null;
        }
      }
    }
    console.log(`[session-mgr] daily usage reset for ${this.sessionState.size} sessions`);
  }

  // ---- 状态查询 ----

  getEnabledSessions() {
    return this.sessions.filter((s) => {
      const state = this.sessionState.get(s.id);
      return state && state.enabled;
    });
  }

  getStatus() {
    return this.sessions.map((s) => {
      const state = this.sessionState.get(s.id) ?? {};
      return {
        id: s.id,
        platform: s.platform,
        email: s.email ?? null,
        enabled: state.enabled ?? false,
        disabledReason: state.disabledReason ?? null,
        usedTokens: state.usedTokens ?? 0,
        usedRequests: state.usedRequests ?? 0,
        dailyLimit: s.dailyLimit ?? null,
        sessionToken: s.sessionToken ? `${s.sessionToken.slice(0, 8)}...` : null,
        acquiredAt: s.acquiredAt ?? null,
        expiresAt: s.expiresAt ?? null,
        expired: this._isExpired(s),
        lastUsedAt: state.lastUsedAt ?? null,
        lastKeepaliveAt: state.lastKeepaliveAt ?? null,
        lastHealthCheckAt: state.lastHealthCheckAt ?? null,
        lastHealthError: state.lastHealthError ?? null,
        consecutiveFailures: state.consecutiveFailures ?? 0,
      };
    });
  }

  // ---- 停止 ----

  stop() {
    if (this._keepaliveTimer) {
      clearInterval(this._keepaliveTimer);
      this._keepaliveTimer = null;
    }
    if (this._healthCheckTimer) {
      clearInterval(this._healthCheckTimer);
      this._healthCheckTimer = null;
    }
    this.save();
    console.log("[session-mgr] stopped.");
  }

  // ---- 内部工具 ----

  _normalize(raw, index) {
    return {
      id: raw?.id || `session-${index + 1}`,
      platform: raw?.platform || "unknown",
      sessionToken: raw?.sessionToken || "",
      refreshToken: raw?.refreshToken || null,
      deviceId: raw?.deviceId || null,
      userAgent: raw?.userAgent || null,
      dailyLimit: raw?.dailyLimit ?? null,
      enabled: raw?.enabled !== false,
      email: raw?.email || null,
      loginMethod: raw?.loginMethod || null,
      extra: raw?.extra || {},
      acquiredAt: raw?.acquiredAt || null,
      expiresAt: raw?.expiresAt || null,
    };
  }

  _isExpired(session) {
    if (session.expiresAt) {
      return new Date(session.expiresAt).getTime() < Date.now();
    }
    if (session.acquiredAt && this.sessionMaxAgeMs) {
      return new Date(session.acquiredAt).getTime() + this.sessionMaxAgeMs < Date.now();
    }
    return false;
  }
}

export default SessionManager;
