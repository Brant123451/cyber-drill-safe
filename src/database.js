/**
 * SQLite Database Layer
 * Tables: users, pools, subscriptions, announcements, request_logs,
 *         activation_codes, user_subscriptions
 */

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "..", "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, "wind.db");
const JWT_SECRET = process.env.JWT_SECRET || "wind-server-jwt-secret-change-me";
const JWT_EXPIRES = "30d";

let db;

export function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    initSchema();
    migrateSchema();
    seedDefaults();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'user',
      credits INTEGER DEFAULT 0,
      subscription TEXT DEFAULT 'free',
      pool_id INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      last_login TEXT
    );

    CREATE TABLE IF NOT EXISTS pools (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      code TEXT UNIQUE NOT NULL,
      api_key TEXT NOT NULL,
      region TEXT DEFAULT '',
      host TEXT DEFAULT 'server.self-serve.windsurf.com',
      upstream_ip TEXT DEFAULT '',
      status TEXT DEFAULT 'online',
      max_users INTEGER DEFAULT 50,
      current_users INTEGER DEFAULT 0,
      latency_ms INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      daily_credits INTEGER DEFAULT 100,
      max_requests_per_min INTEGER DEFAULT 10,
      priority INTEGER DEFAULT 0,
      price TEXT DEFAULT 'free'
    );

    CREATE TABLE IF NOT EXISTS announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS request_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      pool_id INTEGER,
      endpoint TEXT,
      model TEXT,
      tokens_used INTEGER DEFAULT 0,
      latency_ms INTEGER DEFAULT 0,
      status_code INTEGER DEFAULT 200,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (pool_id) REFERENCES pools(id)
    );

    CREATE INDEX IF NOT EXISTS idx_logs_user ON request_logs(user_id);
    CREATE INDEX IF NOT EXISTS idx_logs_created ON request_logs(created_at);

    CREATE TABLE IF NOT EXISTS pool_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pool_id INTEGER NOT NULL,
      label TEXT NOT NULL,
      session_token TEXT NOT NULL,
      platform TEXT DEFAULT 'codeium',
      status TEXT DEFAULT 'active',
      daily_limit INTEGER DEFAULT 80000,
      used_tokens INTEGER DEFAULT 0,
      last_used TEXT,
      last_health_check TEXT,
      health_status TEXT DEFAULT 'unknown',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (pool_id) REFERENCES pools(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_pool_accounts_pool ON pool_accounts(pool_id);
    CREATE INDEX IF NOT EXISTS idx_pool_accounts_status ON pool_accounts(status);

    CREATE TABLE IF NOT EXISTS activation_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      plan TEXT NOT NULL,
      duration_hours INTEGER NOT NULL DEFAULT 24,
      status TEXT DEFAULT 'unused',
      batch_id TEXT,
      used_by INTEGER,
      used_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (used_by) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_activation_code ON activation_codes(code);
    CREATE INDEX IF NOT EXISTS idx_activation_status ON activation_codes(status);
    CREATE INDEX IF NOT EXISTS idx_activation_batch ON activation_codes(batch_id);

    CREATE TABLE IF NOT EXISTS user_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      plan TEXT NOT NULL,
      starts_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      activation_code_id INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (activation_code_id) REFERENCES activation_codes(id)
    );

    CREATE INDEX IF NOT EXISTS idx_user_subs_user ON user_subscriptions(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_subs_expires ON user_subscriptions(expires_at);
  `);
}

function migrateSchema() {
  // Add preferred_plan column if it doesn't exist
  const cols = db.prepare("PRAGMA table_info(users)").all();
  if (!cols.some((c) => c.name === "preferred_plan")) {
    db.exec("ALTER TABLE users ADD COLUMN preferred_plan TEXT DEFAULT NULL");
    console.log("[db] migrated: added users.preferred_plan");
  }
}

function seedDefaults() {
  const subCount = db.prepare("SELECT COUNT(*) as c FROM subscriptions").get();
  if (subCount.c === 0) {
    const ins = db.prepare("INSERT INTO subscriptions (name, daily_credits, max_requests_per_min, priority, price) VALUES (?, ?, ?, ?, ?)");
    ins.run("free", 1000, 5, 0, "free");
    ins.run("basic", 1000, 15, 1, "9.9/day");
    ins.run("pro", 1000, 60, 2, "15.88/day");
    ins.run("unlimited", 1000, 999, 3, "25/day");
  }
}

// ============================================================
// User operations
// ============================================================

export function createUser(username, email, password) {
  const existing = db.prepare("SELECT id FROM users WHERE username = ? OR email = ?").get(username, email);
  if (existing) {
    throw new Error("username or email already exists");
  }
  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare(
    "INSERT INTO users (username, email, password_hash, subscription) VALUES (?, ?, ?, 'free')"
  ).run(username, email, hash);
  return { id: result.lastInsertRowid, username, email };
}

export function loginUser(username, password) {
  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  if (!user) throw new Error("user not found");
  if (!bcrypt.compareSync(password, user.password_hash)) throw new Error("wrong password");

  db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(user.id);

  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );

  return {
    token,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      credits: user.credits,
      subscription: user.subscription,
      pool_id: user.pool_id,
    },
  };
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

export function getUserById(id) {
  return db.prepare(
    "SELECT id, username, email, role, credits, subscription, preferred_plan, pool_id, created_at, last_login FROM users WHERE id = ?"
  ).get(id);
}

export function updateUserPool(userId, poolId) {
  db.prepare("UPDATE users SET pool_id = ? WHERE id = ?").run(poolId, userId);
}

export function updateUserSubscription(userId, subName) {
  db.prepare("UPDATE users SET subscription = ? WHERE id = ?").run(subName, userId);
}

export function deductCredits(userId, amount) {
  db.prepare("UPDATE users SET credits = credits - ? WHERE id = ?").run(amount, userId);
}

export function addCredits(userId, amount) {
  db.prepare("UPDATE users SET credits = credits + ? WHERE id = ?").run(amount, userId);
}

export function getAllUsers() {
  return db.prepare(
    "SELECT id, username, email, role, credits, subscription, preferred_plan, pool_id, created_at, last_login FROM users"
  ).all();
}

/** Set user's preferred active plan (for manual priority switching) */
export function setPreferredPlan(userId, plan) {
  // Verify user has an active subscription of this plan
  if (plan) {
    const active = db.prepare(
      "SELECT id FROM user_subscriptions WHERE user_id = ? AND plan = ? AND expires_at > datetime('now') LIMIT 1"
    ).get(userId, plan);
    if (!active) throw new Error("没有该套餐的有效订阅");
  }
  db.prepare("UPDATE users SET preferred_plan = ? WHERE id = ?").run(plan || null, userId);
  // Also update the subscription field to match
  if (plan) {
    updateUserSubscription(userId, plan);
  }
}

// ============================================================
// Pool operations
// ============================================================

export function getAllPools() {
  return db.prepare("SELECT * FROM pools").all();
}

export function getPoolById(id) {
  return db.prepare("SELECT * FROM pools WHERE id = ?").get(id);
}

export function createPool(name, code, apiKey, region, upstreamIp) {
  const result = db.prepare(
    "INSERT INTO pools (name, code, api_key, region, upstream_ip) VALUES (?, ?, ?, ?, ?)"
  ).run(name, code, apiKey, region || "", upstreamIp || "");
  return { id: result.lastInsertRowid, name, code };
}

export function updatePoolStatus(id, status, latencyMs) {
  db.prepare("UPDATE pools SET status = ?, latency_ms = ? WHERE id = ?").run(status, latencyMs || 0, id);
}

export function deletePool(id) {
  db.prepare("DELETE FROM pools WHERE id = ?").run(id);
}

// ============================================================
// Subscription operations
// ============================================================

export function getAllSubscriptions() {
  return db.prepare("SELECT * FROM subscriptions").all();
}

export function getSubscription(name) {
  return db.prepare("SELECT * FROM subscriptions WHERE name = ?").get(name);
}

// ============================================================
// Announcement operations
// ============================================================

export function getAllAnnouncements(limit = 20) {
  return db.prepare("SELECT * FROM announcements ORDER BY created_at DESC LIMIT ?").all(limit);
}

export function createAnnouncement(title, content) {
  const result = db.prepare("INSERT INTO announcements (title, content) VALUES (?, ?)").run(title, content);
  return { id: result.lastInsertRowid, title, content };
}

export function deleteAnnouncement(id) {
  db.prepare("DELETE FROM announcements WHERE id = ?").run(id);
}

// ============================================================
// Pool account operations
// ============================================================

export function getPoolAccounts(poolId) {
  return db.prepare("SELECT * FROM pool_accounts WHERE pool_id = ? ORDER BY used_tokens ASC").all(poolId);
}

export function getAllPoolAccounts() {
  return db.prepare("SELECT pa.*, p.name as pool_name, p.code as pool_code FROM pool_accounts pa LEFT JOIN pools p ON pa.pool_id = p.id ORDER BY pa.pool_id, pa.used_tokens ASC").all();
}

export function addPoolAccount(poolId, label, sessionToken, platform, dailyLimit) {
  const result = db.prepare(
    "INSERT INTO pool_accounts (pool_id, label, session_token, platform, daily_limit) VALUES (?, ?, ?, ?, ?)"
  ).run(poolId, label, sessionToken, platform || "codeium", dailyLimit || 80000);
  return { id: result.lastInsertRowid, pool_id: poolId, label };
}

export function removePoolAccount(id) {
  db.prepare("DELETE FROM pool_accounts WHERE id = ?").run(id);
}

export function updatePoolAccountStatus(id, status, healthStatus) {
  db.prepare("UPDATE pool_accounts SET status = ?, health_status = ?, last_health_check = datetime('now') WHERE id = ?").run(status, healthStatus || "unknown", id);
}

export function markPoolAccountUsed(id, tokensUsed) {
  db.prepare("UPDATE pool_accounts SET used_tokens = used_tokens + ?, last_used = datetime('now') WHERE id = ?").run(tokensUsed, id);
}

export function resetPoolAccountUsage() {
  db.prepare("UPDATE pool_accounts SET used_tokens = 0").run();
}

export function pickBestAccount(poolId) {
  return db.prepare(
    "SELECT * FROM pool_accounts WHERE pool_id = ? AND status = 'active' AND used_tokens < daily_limit ORDER BY used_tokens ASC LIMIT 1"
  ).get(poolId);
}

export function getActiveAccountCount() {
  return db.prepare("SELECT COUNT(*) as c FROM pool_accounts WHERE status = 'active'").get().c;
}

// ============================================================
// Request log operations
// ============================================================

export function logRequest(userId, poolId, endpoint, model, tokensUsed, latencyMs, statusCode) {
  db.prepare(
    "INSERT INTO request_logs (user_id, pool_id, endpoint, model, tokens_used, latency_ms, status_code) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(userId, poolId, endpoint, model, tokensUsed || 0, latencyMs || 0, statusCode || 200);
}

export function getUserLogs(userId, limit = 50) {
  return db.prepare(
    "SELECT * FROM request_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?"
  ).all(userId, limit);
}

export function getTodayUsage(userId) {
  const row = db.prepare(
    "SELECT COUNT(*) as count, COALESCE(SUM(tokens_used), 0) as tokens FROM request_logs WHERE user_id = ? AND created_at >= date('now')"
  ).get(userId);
  return row;
}

// ============================================================
// Activation code operations
// ============================================================

/**
 * Generate a batch of activation codes.
 * @param {string} plan - basic | pro | unlimited
 * @param {number} durationHours - how many hours the code grants
 * @param {number} count - how many codes to generate
 * @returns {{ batchId: string, codes: string[] }}
 */
export function generateActivationCodes(plan, durationHours, count) {
  const batchId = `batch-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
  const prefix = `WIND-${plan.toUpperCase()}`;
  const insert = db.prepare(
    "INSERT INTO activation_codes (code, plan, duration_hours, batch_id) VALUES (?, ?, ?, ?)"
  );

  const codes = [];
  const txn = db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const rand = crypto.randomBytes(5).toString("hex").toUpperCase();
      const code = `${prefix}-${rand}`;
      insert.run(code, plan, durationHours, batchId);
      codes.push(code);
    }
  });
  txn();

  return { batchId, codes };
}

/** Get activation code by code string */
export function getActivationCode(code) {
  return db.prepare("SELECT * FROM activation_codes WHERE code = ?").get(code);
}

/** Mark an activation code as used */
export function markCodeUsed(codeId, userId) {
  db.prepare(
    "UPDATE activation_codes SET status = 'used', used_by = ?, used_at = datetime('now') WHERE id = ?"
  ).run(userId, codeId);
}

/** List activation codes with optional filters */
export function listActivationCodes({ status, batchId, limit = 100, offset = 0 } = {}) {
  let sql = "SELECT id, code, plan, duration_hours, status, batch_id, used_by, used_at, created_at FROM activation_codes WHERE 1=1";
  const params = [];
  if (status) { sql += " AND status = ?"; params.push(status); }
  if (batchId) { sql += " AND batch_id = ?"; params.push(batchId); }
  sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
  params.push(limit, offset);
  return db.prepare(sql).all(...params);
}

/** Get stats for activation codes */
export function getActivationCodeStats() {
  return db.prepare(
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN status = 'unused' THEN 1 ELSE 0 END) as unused,
       SUM(CASE WHEN status = 'used' THEN 1 ELSE 0 END) as used
     FROM activation_codes`
  ).get();
}

// ============================================================
// User subscription operations
// ============================================================

/** Get all active subscriptions for a user (not expired) */
export function getUserActiveSubscriptions(userId) {
  return db.prepare(
    "SELECT * FROM user_subscriptions WHERE user_id = ? AND expires_at > datetime('now') ORDER BY plan, expires_at DESC"
  ).all(userId);
}

/** Get all subscriptions for a user (including expired), recent first */
export function getUserAllSubscriptions(userId, limit = 20) {
  return db.prepare(
    "SELECT us.*, ac.code as activation_code FROM user_subscriptions us LEFT JOIN activation_codes ac ON us.activation_code_id = ac.id WHERE us.user_id = ? ORDER BY us.created_at DESC LIMIT ?"
  ).all(userId, limit);
}

/**
 * Redeem an activation code for a user.
 * Same plan type → extend the latest expiry. Different plan → create new entry.
 * @returns {{ subscription: object, extended: boolean }}
 */
export function redeemActivationCode(userId, codeStr) {
  const codeRow = getActivationCode(codeStr);
  if (!codeRow) throw new Error("激活码不存在");
  if (codeRow.status !== "unused") throw new Error("激活码已被使用");

  const plan = codeRow.plan;
  const durationMs = codeRow.duration_hours * 3600_000;

  const result = db.transaction(() => {
    // Mark code as used
    markCodeUsed(codeRow.id, userId);

    // Check if user has an active subscription of the same plan
    const existing = db.prepare(
      "SELECT * FROM user_subscriptions WHERE user_id = ? AND plan = ? AND expires_at > datetime('now') ORDER BY expires_at DESC LIMIT 1"
    ).get(userId, plan);

    let sub;
    let extended = false;

    if (existing) {
      // Extend the existing subscription
      const currentExpiry = new Date(existing.expires_at + "Z");
      const newExpiry = new Date(currentExpiry.getTime() + durationMs);
      db.prepare("UPDATE user_subscriptions SET expires_at = ? WHERE id = ?").run(
        newExpiry.toISOString().replace("Z", "").replace("T", " "),
        existing.id
      );
      sub = { ...existing, expires_at: newExpiry.toISOString() };
      extended = true;
    } else {
      // Create new subscription
      const now = new Date();
      const expiresAt = new Date(now.getTime() + durationMs);
      const startsAtStr = now.toISOString().replace("Z", "").replace("T", " ");
      const expiresAtStr = expiresAt.toISOString().replace("Z", "").replace("T", " ");

      const r = db.prepare(
        "INSERT INTO user_subscriptions (user_id, plan, starts_at, expires_at, activation_code_id) VALUES (?, ?, ?, ?, ?)"
      ).run(userId, plan, startsAtStr, expiresAtStr, codeRow.id);
      sub = { id: r.lastInsertRowid, user_id: userId, plan, starts_at: startsAtStr, expires_at: expiresAtStr };
    }

    // Update user's current subscription
    // If user has a preferred_plan and it's still active, keep it; otherwise pick highest priority
    const userRow = getUserById(userId);
    const preferred = userRow?.preferred_plan;
    let effectivePlan = null;

    if (preferred) {
      const prefActive = db.prepare(
        "SELECT id FROM user_subscriptions WHERE user_id = ? AND plan = ? AND expires_at > datetime('now') LIMIT 1"
      ).get(userId, preferred);
      if (prefActive) effectivePlan = preferred;
    }

    if (!effectivePlan) {
      const best = db.prepare(
        `SELECT us.plan FROM user_subscriptions us
         JOIN subscriptions s ON us.plan = s.name
         WHERE us.user_id = ? AND us.expires_at > datetime('now')
         ORDER BY s.priority DESC LIMIT 1`
      ).get(userId);
      if (best) effectivePlan = best.plan;
    }

    if (effectivePlan) {
      updateUserSubscription(userId, effectivePlan);
    }

    // Grant credits based on the subscription plan
    const subDef = getSubscription(plan);
    if (subDef) {
      addCredits(userId, subDef.daily_credits);
    }

    return { subscription: sub, extended };
  })();

  return result;
}

/**
 * Get the effective subscription for a user.
 * Respects user's preferred_plan if set and still active; otherwise highest priority.
 */
export function getEffectiveSubscription(userId) {
  const userRow = db.prepare("SELECT preferred_plan FROM users WHERE id = ?").get(userId);
  const preferred = userRow?.preferred_plan;

  // If user has a preferred plan, try that first
  if (preferred) {
    const prefSub = db.prepare(
      `SELECT us.*, s.daily_credits, s.max_requests_per_min, s.priority, s.price
       FROM user_subscriptions us
       JOIN subscriptions s ON us.plan = s.name
       WHERE us.user_id = ? AND us.plan = ? AND us.expires_at > datetime('now')
       ORDER BY us.expires_at DESC LIMIT 1`
    ).get(userId, preferred);
    if (prefSub) return prefSub;
  }

  // Fallback: highest priority active plan
  return db.prepare(
    `SELECT us.*, s.daily_credits, s.max_requests_per_min, s.priority, s.price
     FROM user_subscriptions us
     JOIN subscriptions s ON us.plan = s.name
     WHERE us.user_id = ? AND us.expires_at > datetime('now')
     ORDER BY s.priority DESC LIMIT 1`
  ).get(userId);
}
