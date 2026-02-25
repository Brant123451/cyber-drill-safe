/**
 * User Manager - 文件驱动的用户管理 + 积分恢复系统
 *
 * 功能：
 * - 从 config/users.json 加载/保存用户
 * - 每用户独立 API Key（Bearer token）
 * - 积分配额系统：每 N 小时自动恢复指定积分
 * - 用户 CRUD（创建/读取/更新/删除）
 * - 支持热重载
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// ---- 默认配置 ----
const DEFAULTS = {
  creditLimit: 1000,           // 默认积分上限
  creditRecoveryAmount: 1000,  // 每次恢复的积分量
  creditRecoveryIntervalMs: 3 * 3600_000, // 3 小时恢复周期
  enabled: true,
};

/**
 * @typedef {Object} UserConfig
 * @property {string} id             - 用户唯一 ID
 * @property {string} token          - API Key（Bearer token）
 * @property {string} name           - 显示名称
 * @property {number} creditLimit    - 积分上限
 * @property {number} creditRecoveryAmount - 每次恢复量
 * @property {number} creditRecoveryIntervalMs - 恢复周期（毫秒）
 * @property {boolean} enabled       - 是否启用
 * @property {string} [createdAt]    - 创建时间
 * @property {string} [note]         - 备注
 */

/**
 * @typedef {Object} UserState
 * @property {number} usedCredits    - 已使用积分
 * @property {number} totalUsed      - 累计使用（不会重置）
 * @property {number} requestCount   - 请求次数
 * @property {string|null} lastRequestAt - 最后请求时间
 * @property {string|null} lastRecoveryAt - 最后恢复时间
 */

export class UserManager {
  /**
   * @param {Object} opts
   * @param {string} opts.projectRoot
   * @param {string} [opts.usersFile]
   */
  constructor(opts) {
    this.projectRoot = opts.projectRoot;
    this.usersFile = path.resolve(
      opts.projectRoot,
      opts.usersFile ?? "config/users.json",
    );

    /** @type {Map<string, UserConfig>} id → config */
    this.users = new Map();
    /** @type {Map<string, UserState>} id → runtime state */
    this.states = new Map();
    /** @type {Map<string, string>} token → user id (lookup index) */
    this.tokenIndex = new Map();

    this._recoveryTimer = null;
  }

  // ---- 加载/保存 ----

  load() {
    if (!fs.existsSync(this.usersFile)) {
      console.log(`[user-mgr] users file not found: ${this.usersFile}, creating default`);
      this._createDefault();
      return;
    }

    const raw = fs.readFileSync(this.usersFile, "utf8").replace(/^\uFEFF/, "");
    const data = JSON.parse(raw);
    const list = Array.isArray(data) ? data : data.users ?? [];

    this.users.clear();
    this.tokenIndex.clear();

    for (const raw of list) {
      const user = this._normalize(raw);
      this.users.set(user.id, user);
      this.tokenIndex.set(user.token, user.id);

      // 保留已有的运行时状态
      if (!this.states.has(user.id)) {
        this.states.set(user.id, this._newState());
      }
    }

    console.log(`[user-mgr] loaded ${this.users.size} users from ${this.usersFile}`);
  }

  save() {
    const dir = path.dirname(this.usersFile);
    fs.mkdirSync(dir, { recursive: true });

    const output = [];
    for (const [id, config] of this.users) {
      const state = this.states.get(id);
      output.push({
        ...config,
        _runtime: state ? {
          usedCredits: state.usedCredits,
          totalUsed: state.totalUsed,
          requestCount: state.requestCount,
          lastRequestAt: state.lastRequestAt,
          lastRecoveryAt: state.lastRecoveryAt,
        } : undefined,
      });
    }

    fs.writeFileSync(
      this.usersFile,
      JSON.stringify({ users: output }, null, 2),
      "utf8",
    );
  }

  reload() {
    const prevStates = new Map(this.states);
    this.load();
    // 恢复运行时状态
    for (const [id] of this.users) {
      if (prevStates.has(id)) {
        this.states.set(id, prevStates.get(id));
      }
    }
    console.log(`[user-mgr] reloaded. active: ${this.getEnabledCount()}/${this.users.size}`);
  }

  // ---- 用户认证 ----

  /**
   * 通过 Bearer token 查找用户
   * @param {string} token
   * @returns {{ config: UserConfig, state: UserState } | null}
   */
  authenticate(token) {
    const userId = this.tokenIndex.get(token);
    if (!userId) return null;

    const config = this.users.get(userId);
    if (!config || !config.enabled) return null;

    const state = this.states.get(userId);
    return { config, state };
  }

  // ---- 积分管理 ----

  /**
   * 消费积分
   * @param {string} userId
   * @param {number} amount - 消费的积分（token 估算值）
   * @returns {boolean} true 如果扣减成功
   */
  consumeCredits(userId, amount) {
    const config = this.users.get(userId);
    const state = this.states.get(userId);
    if (!config || !state) return false;

    const available = config.creditLimit - state.usedCredits;
    if (amount > available) return false;

    state.usedCredits += amount;
    state.totalUsed += amount;
    state.requestCount += 1;
    state.lastRequestAt = new Date().toISOString();

    return true;
  }

  /**
   * 检查用户剩余积分
   */
  getAvailableCredits(userId) {
    const config = this.users.get(userId);
    const state = this.states.get(userId);
    if (!config || !state) return 0;
    return Math.max(0, config.creditLimit - state.usedCredits);
  }

  /**
   * 运行积分恢复
   */
  recoverCredits() {
    const now = new Date();
    let recovered = 0;

    for (const [id, config] of this.users) {
      const state = this.states.get(id);
      if (!state) continue;

      const lastRecovery = state.lastRecoveryAt
        ? new Date(state.lastRecoveryAt).getTime()
        : 0;
      const elapsed = now.getTime() - lastRecovery;

      if (elapsed >= config.creditRecoveryIntervalMs) {
        const prevUsed = state.usedCredits;
        state.usedCredits = Math.max(0, state.usedCredits - config.creditRecoveryAmount);
        state.lastRecoveryAt = now.toISOString();

        if (prevUsed > 0) {
          recovered++;
          console.log(
            `[user-mgr] credit recovery: ${config.name} (${config.id}): ${prevUsed} → ${state.usedCredits}`,
          );
        }
      }
    }

    if (recovered > 0) {
      console.log(`[user-mgr] credit recovery complete: ${recovered} users recovered`);
    }
  }

  /**
   * 启动定期积分恢复
   */
  startCreditRecovery() {
    if (this._recoveryTimer) return;

    // 找最短的恢复周期作为检查频率
    let minInterval = DEFAULTS.creditRecoveryIntervalMs;
    for (const config of this.users.values()) {
      if (config.creditRecoveryIntervalMs < minInterval) {
        minInterval = config.creditRecoveryIntervalMs;
      }
    }

    // 检查频率为最短恢复周期的 1/6（至少每 10 分钟）
    const checkInterval = Math.max(10 * 60_000, Math.floor(minInterval / 6));

    this._recoveryTimer = setInterval(() => {
      this.recoverCredits();
    }, checkInterval);

    if (typeof this._recoveryTimer.unref === "function") {
      this._recoveryTimer.unref();
    }

    console.log(`[user-mgr] credit recovery started (check every ${Math.round(checkInterval / 60_000)}min)`);
  }

  stop() {
    if (this._recoveryTimer) {
      clearInterval(this._recoveryTimer);
      this._recoveryTimer = null;
    }
    this.save();
    console.log("[user-mgr] stopped.");
  }

  // ---- CRUD ----

  /**
   * 创建新用户
   * @param {Partial<UserConfig>} data
   * @returns {UserConfig}
   */
  createUser(data) {
    const id = data.id || `user-${Date.now().toString(36)}`;
    const token = data.token || this._generateToken();

    if (this.users.has(id)) {
      throw new Error(`user already exists: ${id}`);
    }
    if (this.tokenIndex.has(token)) {
      throw new Error(`token already in use`);
    }

    const config = this._normalize({ ...data, id, token, createdAt: new Date().toISOString() });
    this.users.set(config.id, config);
    this.tokenIndex.set(config.token, config.id);
    this.states.set(config.id, this._newState());

    this.save();
    console.log(`[user-mgr] created user: ${config.id} (${config.name})`);
    return config;
  }

  /**
   * 更新用户配置
   */
  updateUser(id, updates) {
    const existing = this.users.get(id);
    if (!existing) throw new Error(`user not found: ${id}`);

    // 如果更换了 token，更新索引
    if (updates.token && updates.token !== existing.token) {
      if (this.tokenIndex.has(updates.token)) {
        throw new Error("token already in use");
      }
      this.tokenIndex.delete(existing.token);
      this.tokenIndex.set(updates.token, id);
    }

    const updated = this._normalize({ ...existing, ...updates, id });
    this.users.set(id, updated);

    this.save();
    return updated;
  }

  /**
   * 删除用户
   */
  deleteUser(id) {
    const config = this.users.get(id);
    if (!config) throw new Error(`user not found: ${id}`);

    this.tokenIndex.delete(config.token);
    this.users.delete(id);
    this.states.delete(id);

    this.save();
    console.log(`[user-mgr] deleted user: ${id}`);
  }

  /**
   * 重置用户积分
   */
  resetCredits(id) {
    const state = this.states.get(id);
    if (!state) throw new Error(`user not found: ${id}`);

    state.usedCredits = 0;
    state.lastRecoveryAt = new Date().toISOString();
  }

  // ---- 状态查询 ----

  getEnabledCount() {
    let count = 0;
    for (const config of this.users.values()) {
      if (config.enabled) count++;
    }
    return count;
  }

  getStatus() {
    const result = [];
    for (const [id, config] of this.users) {
      const state = this.states.get(id) ?? {};
      result.push({
        id: config.id,
        name: config.name,
        token: this._maskToken(config.token),
        enabled: config.enabled,
        creditLimit: config.creditLimit,
        usedCredits: state.usedCredits ?? 0,
        availableCredits: Math.max(0, config.creditLimit - (state.usedCredits ?? 0)),
        usagePercent: Number((((state.usedCredits ?? 0) / config.creditLimit) * 100).toFixed(1)),
        totalUsed: state.totalUsed ?? 0,
        requestCount: state.requestCount ?? 0,
        creditRecoveryAmount: config.creditRecoveryAmount,
        creditRecoveryIntervalHours: Number((config.creditRecoveryIntervalMs / 3_600_000).toFixed(1)),
        lastRequestAt: state.lastRequestAt ?? null,
        lastRecoveryAt: state.lastRecoveryAt ?? null,
        createdAt: config.createdAt ?? null,
        note: config.note ?? null,
      });
    }
    return result;
  }

  // ---- 内部工具 ----

  _normalize(raw) {
    return {
      id: raw?.id || `user-${Date.now().toString(36)}`,
      token: raw?.token || this._generateToken(),
      name: raw?.name || raw?.id || "unnamed",
      creditLimit: Number(raw?.creditLimit) || DEFAULTS.creditLimit,
      creditRecoveryAmount: Number(raw?.creditRecoveryAmount) || DEFAULTS.creditRecoveryAmount,
      creditRecoveryIntervalMs: Number(raw?.creditRecoveryIntervalMs) || DEFAULTS.creditRecoveryIntervalMs,
      enabled: raw?.enabled !== false,
      createdAt: raw?.createdAt || null,
      note: raw?.note || null,
    };
  }

  _newState() {
    return {
      usedCredits: 0,
      totalUsed: 0,
      requestCount: 0,
      lastRequestAt: null,
      lastRecoveryAt: new Date().toISOString(),
    };
  }

  _generateToken() {
    const prefix = "sk-gw-";
    const random = crypto.randomBytes(32).toString("base64url");
    return prefix + random;
  }

  _maskToken(token) {
    if (!token) return null;
    if (token.length <= 12) return "****";
    return token.slice(0, 6) + "****" + token.slice(-4);
  }

  _createDefault() {
    const defaultUsers = [
      {
        id: "operator-1",
        token: "sk-deploy-001",
        name: "operator-1",
        creditLimit: 1000,
        creditRecoveryAmount: 1000,
        creditRecoveryIntervalMs: 3 * 3_600_000,
        enabled: true,
        createdAt: new Date().toISOString(),
        note: "default test user",
      },
      {
        id: "operator-2",
        token: "sk-deploy-002",
        name: "operator-2",
        creditLimit: 1000,
        creditRecoveryAmount: 1000,
        creditRecoveryIntervalMs: 3 * 3_600_000,
        enabled: true,
        createdAt: new Date().toISOString(),
        note: "default test user",
      },
    ];

    const dir = path.dirname(this.usersFile);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      this.usersFile,
      JSON.stringify({ users: defaultUsers }, null, 2),
      "utf8",
    );
    console.log(`[user-mgr] created default users file: ${this.usersFile}`);

    // 重新加载
    this.load();
  }
}

export default UserManager;
