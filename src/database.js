/**
 * SQLite Database Layer
 * Tables: users, pools, subscriptions, announcements, request_logs
 */

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
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
  `);
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
    "SELECT id, username, email, role, credits, subscription, pool_id, created_at, last_login FROM users WHERE id = ?"
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
    "SELECT id, username, email, role, credits, subscription, pool_id, created_at, last_login FROM users"
  ).all();
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
