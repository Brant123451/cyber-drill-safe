/**
 * Wind API Server
 * REST API for user management, pool management, subscriptions, announcements, and logging.
 * Runs alongside the gateway proxy.
 */

import express from "express";
import cors from "cors";
import {
  getDb,
  createUser,
  loginUser,
  verifyToken,
  getUserById,
  updateUserPool,
  updateUserSubscription,
  deductCredits,
  addCredits,
  getAllUsers,
  getAllPools,
  getPoolById,
  createPool,
  updatePoolStatus,
  deletePool,
  getPoolAccounts,
  getAllPoolAccounts,
  addPoolAccount,
  removePoolAccount,
  updatePoolAccountStatus,
  pickBestAccount,
  getActiveAccountCount,
  getAllSubscriptions,
  getSubscription,
  getAllAnnouncements,
  createAnnouncement,
  deleteAnnouncement,
  logRequest,
  getUserLogs,
  getTodayUsage,
  generateActivationCodes,
  listActivationCodes,
  getActivationCodeStats,
  redeemActivationCode,
  getUserActiveSubscriptions,
  getUserAllSubscriptions,
  getEffectiveSubscription,
  setPreferredPlan,
} from "./database.js";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const SESSIONS_FILE = path.join(PROJECT_ROOT, "config", "sessions.json");

const app = express();
app.use(cors());
app.use(express.json());

/** Sync pool_accounts from DB → config/sessions.json so Gateway can read them */
function syncSessionsFile() {
  const accounts = getAllPoolAccounts();
  const sessions = accounts
    .filter((a) => a.status === "active")
    .map((a) => {
      // session_token may be JSON-wrapped (from bulk import) or a plain string
      let sessionToken = a.session_token;
      let extra = {};
      try {
        const parsed = JSON.parse(a.session_token);
        if (parsed && typeof parsed === "object" && parsed.apiKey) {
          sessionToken = parsed.apiKey;
          extra = {
            apiKey: parsed.apiKey,
            firebaseIdToken: parsed.firebaseIdToken || null,
            uid: parsed.uid || null,
          };
        }
      } catch {
        // plain string session token
      }

      return {
        id: `db-${a.id}`,
        platform: a.platform || "codeium",
        sessionToken,
        email: extra.email || a.label,
        label: a.label,
        poolName: a.pool_name,
        enabled: true,
        extra,
      };
    });

  const dir = path.dirname(SESSIONS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify({ sessions }, null, 2), "utf-8");
  console.log(`[api] synced ${sessions.length} sessions to ${SESSIONS_FILE}`);
}

// ============================================================
// Auth middleware
// ============================================================

function authRequired(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const payload = verifyToken(header.slice(7));
  if (!payload) {
    return res.status(401).json({ error: "invalid or expired token" });
  }
  req.user = payload;
  next();
}

function adminRequired(req, res, next) {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ error: "admin only" });
  }
  next();
}

// ============================================================
// Auth routes
// ============================================================

app.post("/api/auth/register", (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ error: "username, email, and password are required" });
    }
    if (password.length < 4) {
      return res.status(400).json({ error: "password must be at least 4 characters" });
    }
    const user = createUser(username.trim(), email.trim().toLowerCase(), password);
    const login = loginUser(username.trim(), password);
    res.json({ ok: true, ...login });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/auth/login", (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: "username and password are required" });
    }
    const result = loginUser(username.trim(), password);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

app.get("/api/auth/me", authRequired, (req, res) => {
  const user = getUserById(req.user.id);
  if (!user) return res.status(404).json({ error: "user not found" });

  const usage = getTodayUsage(user.id);
  const sub = getSubscription(user.subscription);
  const pool = user.pool_id ? getPoolById(user.pool_id) : null;
  const activeSubs = getUserActiveSubscriptions(user.id);
  const allSubs = getUserAllSubscriptions(user.id);
  const effectiveSub = getEffectiveSubscription(user.id);

  res.json({
    ...user,
    today_usage: usage,
    subscription_detail: sub,
    pool: pool ? { id: pool.id, name: pool.name, code: pool.code, region: pool.region, status: pool.status, latency_ms: pool.latency_ms } : null,
    active_subscriptions: activeSubs,
    subscription_history: allSubs,
    effective_subscription: effectiveSub || null,
  });
});

// ============================================================
// Pool routes
// ============================================================

app.get("/api/pools", authRequired, (req, res) => {
  const pools = getAllPools().map((p) => ({
    id: p.id,
    name: p.name,
    code: p.code,
    region: p.region,
    status: p.status,
    max_users: p.max_users,
    current_users: p.current_users,
    latency_ms: p.latency_ms,
  }));
  res.json(pools);
});

app.post("/api/pools/select", authRequired, (req, res) => {
  const { pool_id } = req.body;
  const pool = getPoolById(pool_id);
  if (!pool) return res.status(404).json({ error: "pool not found" });
  if (pool.status !== "online") return res.status(400).json({ error: "pool is offline" });

  updateUserPool(req.user.id, pool_id);
  res.json({ ok: true, pool: { id: pool.id, name: pool.name, code: pool.code } });
});

app.post("/api/pools/detect", authRequired, async (req, res) => {
  // Ping all pools and return latencies
  const pools = getAllPools().filter((p) => p.status === "online");
  const results = [];

  for (const pool of pools) {
    const start = Date.now();
    try {
      // Simple TCP connect test
      const net = await import("node:net");
      await new Promise((resolve, reject) => {
        const sock = net.connect({ host: pool.upstream_ip || "127.0.0.1", port: 443, timeout: 5000 }, () => {
          sock.destroy();
          resolve();
        });
        sock.on("error", reject);
        sock.on("timeout", () => { sock.destroy(); reject(new Error("timeout")); });
      });
      const latency = Date.now() - start;
      updatePoolStatus(pool.id, "online", latency);
      results.push({ id: pool.id, name: pool.name, code: pool.code, latency_ms: latency, status: "online" });
    } catch {
      const latency = Date.now() - start;
      updatePoolStatus(pool.id, "offline", latency);
      results.push({ id: pool.id, name: pool.name, code: pool.code, latency_ms: latency, status: "offline" });
    }
  }

  // Sort by latency, auto-select best
  results.sort((a, b) => {
    if (a.status !== b.status) return a.status === "online" ? -1 : 1;
    return a.latency_ms - b.latency_ms;
  });

  if (results.length > 0 && results[0].status === "online") {
    updateUserPool(req.user.id, results[0].id);
  }

  res.json({ ok: true, results, selected: results[0] || null });
});

// Admin pool management
app.post("/api/admin/pools", authRequired, adminRequired, (req, res) => {
  try {
    const { name, code, api_key, region, upstream_ip } = req.body;
    if (!name || !code || !api_key) {
      return res.status(400).json({ error: "name, code, and api_key are required" });
    }
    const pool = createPool(name, code, api_key, region, upstream_ip);
    res.json({ ok: true, pool });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/admin/pools/:id", authRequired, adminRequired, (req, res) => {
  deletePool(parseInt(req.params.id));
  res.json({ ok: true });
});

// ============================================================
// Pool account routes (admin)
// ============================================================

app.get("/api/admin/pool-accounts", authRequired, adminRequired, (req, res) => {
  res.json(getAllPoolAccounts().map((a) => ({ ...a, session_token: a.session_token.slice(0, 8) + "****" })));
});

app.get("/api/admin/pool-accounts/:poolId", authRequired, adminRequired, (req, res) => {
  const accounts = getPoolAccounts(parseInt(req.params.poolId));
  res.json(accounts.map((a) => ({ ...a, session_token: a.session_token.slice(0, 8) + "****" })));
});

app.post("/api/admin/pool-accounts", authRequired, adminRequired, (req, res) => {
  try {
    const { pool_id, label, session_token, platform, daily_limit } = req.body;
    if (!pool_id || !label || !session_token) {
      return res.status(400).json({ error: "pool_id, label, and session_token are required" });
    }
    const pool = getPoolById(pool_id);
    if (!pool) return res.status(404).json({ error: "pool not found" });
    const account = addPoolAccount(pool_id, label, session_token, platform, daily_limit);
    syncSessionsFile();
    res.json({ ok: true, account });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/admin/pool-accounts/:id", authRequired, adminRequired, (req, res) => {
  removePoolAccount(parseInt(req.params.id));
  syncSessionsFile();
  res.json({ ok: true });
});

app.post("/api/admin/pool-accounts/:id/status", authRequired, adminRequired, (req, res) => {
  const { status } = req.body;
  updatePoolAccountStatus(parseInt(req.params.id), status || "active", "manual");
  syncSessionsFile();
  res.json({ ok: true });
});

app.get("/api/admin/pool-accounts/stats", authRequired, adminRequired, (req, res) => {
  const all = getAllPoolAccounts();
  res.json({
    total: all.length,
    active: all.filter((a) => a.status === "active").length,
    disabled: all.filter((a) => a.status !== "active").length,
  });
});

// ============================================================
// Subscription routes
// ============================================================

app.get("/api/subscriptions", authRequired, (req, res) => {
  res.json(getAllSubscriptions());
});

app.post("/api/subscriptions/activate", authRequired, (req, res) => {
  const { name } = req.body;
  const sub = getSubscription(name);
  if (!sub) return res.status(404).json({ error: "subscription not found" });

  updateUserSubscription(req.user.id, name);
  // Grant daily credits
  addCredits(req.user.id, sub.daily_credits);
  res.json({ ok: true, subscription: sub });
});

// ============================================================
// Activation code routes
// ============================================================

// User redeems an activation code
app.post("/api/activation/redeem", authRequired, (req, res) => {
  try {
    const { code } = req.body;
    if (!code || !code.trim()) {
      return res.status(400).json({ error: "请输入激活码" });
    }
    const result = redeemActivationCode(req.user.id, code.trim().toUpperCase());
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// User sets preferred plan (manual priority switching)
app.post("/api/subscriptions/prefer", authRequired, (req, res) => {
  try {
    const { plan } = req.body;
    setPreferredPlan(req.user.id, plan || null);
    const effective = getEffectiveSubscription(req.user.id);
    res.json({ ok: true, effective: effective || null });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// User views their subscription history
app.get("/api/subscriptions/history", authRequired, (req, res) => {
  const allSubs = getUserAllSubscriptions(req.user.id);
  const activeSubs = getUserActiveSubscriptions(req.user.id);
  const effective = getEffectiveSubscription(req.user.id);
  res.json({ subscriptions: allSubs, active: activeSubs, effective: effective || null });
});

// Admin: generate activation codes
app.post("/api/admin/activation/generate", authRequired, adminRequired, (req, res) => {
  try {
    const { plan, duration_hours, count } = req.body;
    if (!plan || !duration_hours || !count) {
      return res.status(400).json({ error: "plan, duration_hours, and count are required" });
    }
    const validPlans = ["basic", "pro", "unlimited"];
    if (!validPlans.includes(plan)) {
      return res.status(400).json({ error: `plan must be one of: ${validPlans.join(", ")}` });
    }
    if (count < 1 || count > 500) {
      return res.status(400).json({ error: "count must be between 1 and 500" });
    }
    const result = generateActivationCodes(plan, parseInt(duration_hours), parseInt(count));
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Admin: list activation codes
app.get("/api/admin/activation/list", authRequired, adminRequired, (req, res) => {
  const { status, batch_id, limit, offset } = req.query;
  const codes = listActivationCodes({
    status: status || undefined,
    batchId: batch_id || undefined,
    limit: parseInt(limit) || 100,
    offset: parseInt(offset) || 0,
  });
  const stats = getActivationCodeStats();
  res.json({ codes, stats });
});

// Admin: export unused codes as plain text (one per line, for pasting into ldxp.cn)
app.get("/api/admin/activation/export", authRequired, adminRequired, (req, res) => {
  const { plan, batch_id } = req.query;
  let sql = "SELECT code FROM activation_codes WHERE status = 'unused'";
  const params = [];
  if (plan) { sql += " AND plan = ?"; params.push(plan); }
  if (batch_id) { sql += " AND batch_id = ?"; params.push(batch_id); }
  sql += " ORDER BY created_at ASC";

  const d = getDb();
  const rows = d.prepare(sql).all(...params);
  const text = rows.map((r) => r.code).join("\n");
  res.type("text/plain").send(text);
});

// Admin: get activation code stats
app.get("/api/admin/activation/stats", authRequired, adminRequired, (req, res) => {
  res.json(getActivationCodeStats());
});

// ============================================================
// Announcement routes
// ============================================================

app.get("/api/announcements", authRequired, (req, res) => {
  res.json(getAllAnnouncements());
});

app.post("/api/admin/announcements", authRequired, adminRequired, (req, res) => {
  const { title, content } = req.body;
  if (!title || !content) return res.status(400).json({ error: "title and content required" });
  const ann = createAnnouncement(title, content);
  res.json({ ok: true, announcement: ann });
});

app.delete("/api/admin/announcements/:id", authRequired, adminRequired, (req, res) => {
  deleteAnnouncement(parseInt(req.params.id));
  res.json({ ok: true });
});

// ============================================================
// Request log routes
// ============================================================

app.get("/api/logs", authRequired, (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const logs = getUserLogs(req.user.id, limit);
  res.json(logs);
});

// ============================================================
// Proxy config route (client uses this to configure local proxy)
// ============================================================

app.get("/api/proxy/config", authRequired, (req, res) => {
  const user = getUserById(req.user.id);
  if (!user) return res.status(404).json({ error: "user not found" });

  const pool = user.pool_id ? getPoolById(user.pool_id) : null;
  if (!pool) return res.json({ error: "no pool selected", pool: null });

  res.json({
    pool: {
      id: pool.id,
      name: pool.name,
      code: pool.code,
      api_key: pool.api_key,
      host: pool.host,
      upstream_ip: pool.upstream_ip,
    },
    hosts_entry: `127.0.0.1 ${pool.host}`,
  });
});

// ============================================================
// Admin routes
// ============================================================

app.get("/api/admin/users", authRequired, adminRequired, (req, res) => {
  res.json(getAllUsers());
});

app.post("/api/admin/users/:id/credits", authRequired, adminRequired, (req, res) => {
  const { amount } = req.body;
  addCredits(parseInt(req.params.id), amount || 0);
  res.json({ ok: true });
});

app.post("/api/admin/users/:id/role", authRequired, adminRequired, (req, res) => {
  const { role } = req.body;
  const db = getDb();
  db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, parseInt(req.params.id));
  res.json({ ok: true });
});

// ============================================================
// Bulk import Windsurf accounts
// ============================================================

app.post("/api/admin/import-windsurf-accounts", authRequired, adminRequired, (req, res) => {
  try {
    const { accounts, pool_id, file } = req.body;

    // Determine target pool
    let targetPoolId = pool_id;
    if (!targetPoolId) {
      // Auto-create or find default pool
      const pools = getAllPools();
      const defaultPool = pools.find((p) => p.code === "default") || pools[0];
      if (defaultPool) {
        targetPoolId = defaultPool.id;
      } else {
        const newPool = createPool("Default Pool", "default", "internal", "auto", "");
        targetPoolId = newPool.id;
      }
    }

    // Load accounts from file or request body
    let accountList = accounts;
    if (!accountList && file) {
      const filePath = path.resolve(PROJECT_ROOT, file);
      if (!fs.existsSync(filePath)) {
        return res.status(400).json({ error: `file not found: ${file}` });
      }
      const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      accountList = raw.accounts || raw;
    }

    if (!Array.isArray(accountList) || accountList.length === 0) {
      return res.status(400).json({ error: "no accounts provided" });
    }

    const imported = [];
    const skipped = [];
    const d = getDb();

    for (const acc of accountList) {
      const apiKey = acc.apiKey || acc.api_key || acc.sessionToken || acc.session_token;
      if (!apiKey) {
        skipped.push({ email: acc.email, reason: "no apiKey" });
        continue;
      }

      // Check for duplicate (same session_token in same pool)
      const existing = d.prepare(
        "SELECT id FROM pool_accounts WHERE pool_id = ? AND session_token = ?"
      ).get(targetPoolId, apiKey);
      if (existing) {
        skipped.push({ email: acc.email, reason: "duplicate" });
        continue;
      }

      const label = acc.email || acc.label || `account-${Date.now()}`;
      const platform = acc.platform || "codeium";

      // Store extra fields (firebaseIdToken, uid, etc.) in session_token as JSON-wrapped
      const sessionData = JSON.stringify({
        apiKey,
        firebaseIdToken: acc.firebaseIdToken || acc.firebase_id_token || null,
        uid: acc.uid || null,
        email: acc.email || null,
        expiresAt: acc.expiresAt || acc.expires_at || null,
      });

      addPoolAccount(targetPoolId, label, sessionData, platform, 80000);
      imported.push({ email: acc.email, label });
    }

    syncSessionsFile();

    res.json({
      ok: true,
      pool_id: targetPoolId,
      imported: imported.length,
      skipped: skipped.length,
      details: { imported, skipped },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Health check
// ============================================================

app.get("/api/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ============================================================
// Start server
// ============================================================

const API_PORT = parseInt(process.env.API_PORT) || 18800;
const API_HOST = process.env.API_HOST || "0.0.0.0";

export function startApiServer() {
  // Initialize database
  getDb();

  app.listen(API_PORT, API_HOST, () => {
    console.log(`[api] Wind API server running on http://${API_HOST}:${API_PORT}`);
  });

  return app;
}

// Run directly
if (process.argv[1] && process.argv[1].includes("api-server")) {
  startApiServer();
}

export default app;
