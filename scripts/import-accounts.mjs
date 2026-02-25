#!/usr/bin/env node
/**
 * Import Windsurf accounts from registrar output into the database.
 *
 * Usage:
 *   node scripts/import-accounts.mjs [accounts-file]
 *
 * Default file: config/windsurf-accounts.json
 *
 * The accounts file should be the output from windsurf-registrar.js,
 * containing accounts with apiKey and firebaseIdToken fields.
 * Only accounts with a valid apiKey (not null) are imported.
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");

const accountsFile = process.argv[2] || path.join(PROJECT_ROOT, "config", "windsurf-accounts.json");

if (!fs.existsSync(accountsFile)) {
  console.error(`File not found: ${accountsFile}`);
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(accountsFile, "utf-8"));
const accounts = raw.accounts || raw;

if (!Array.isArray(accounts) || accounts.length === 0) {
  console.error("No accounts found in file");
  process.exit(1);
}

// Open database
const dbPath = path.join(PROJECT_ROOT, "data", "wind.db");
if (!fs.existsSync(path.dirname(dbPath))) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

// Ensure default pool exists
let pool = db.prepare("SELECT id FROM pools WHERE code = 'default'").get();
if (!pool) {
  pool = db.prepare("SELECT id FROM pools LIMIT 1").get();
}
if (!pool) {
  const r = db.prepare(
    "INSERT INTO pools (name, code, api_key, region, status) VALUES (?, ?, ?, ?, ?)"
  ).run("Default Pool", "default", "internal", "auto", "online");
  pool = { id: r.lastInsertRowid };
  console.log(`Created default pool (id=${pool.id})`);
}

const poolId = pool.id;
console.log(`Importing to pool ${poolId}`);
console.log(`Found ${accounts.length} accounts in ${accountsFile}`);
console.log("");

let imported = 0;
let skipped = 0;

for (const acc of accounts) {
  const apiKey = acc.apiKey || acc.api_key;

  if (!apiKey) {
    console.log(`  SKIP ${acc.email || "unknown"}: no apiKey (status: ${acc.status || "?"})`);
    skipped++;
    continue;
  }

  // Build session data JSON
  const sessionData = JSON.stringify({
    apiKey,
    firebaseIdToken: acc.firebaseIdToken || null,
    uid: acc.uid || null,
    email: acc.email || null,
    expiresAt: acc.expiresAt || null,
  });

  // Check for duplicate
  const existing = db.prepare(
    "SELECT id FROM pool_accounts WHERE pool_id = ? AND label = ?"
  ).get(poolId, acc.email || "unknown");

  if (existing) {
    // Update existing
    db.prepare(
      "UPDATE pool_accounts SET session_token = ?, status = 'active', health_status = 'unknown' WHERE id = ?"
    ).run(sessionData, existing.id);
    console.log(`  UPDATE ${acc.email} (id=${existing.id})`);
    imported++;
  } else {
    // Insert new
    const r = db.prepare(
      "INSERT INTO pool_accounts (pool_id, label, session_token, platform, daily_limit, status) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(poolId, acc.email || `account-${Date.now()}`, sessionData, "codeium", 80000, "active");
    console.log(`  ADD ${acc.email} (id=${r.lastInsertRowid})`);
    imported++;
  }
}

console.log("");
console.log(`Done: ${imported} imported, ${skipped} skipped`);

// Sync to sessions.json for the gateway
const allAccounts = db.prepare(
  "SELECT * FROM pool_accounts WHERE pool_id = ? AND status = 'active'"
).all(poolId);

const sessions = allAccounts.map((a) => {
  let sessionToken = a.session_token;
  let extra = {};
  try {
    const parsed = JSON.parse(a.session_token);
    if (parsed && parsed.apiKey) {
      sessionToken = parsed.apiKey;
      extra = {
        apiKey: parsed.apiKey,
        firebaseIdToken: parsed.firebaseIdToken || null,
        uid: parsed.uid || null,
      };
    }
  } catch {}

  return {
    id: `db-${a.id}`,
    platform: a.platform || "codeium",
    sessionToken,
    email: a.label,
    label: a.label,
    enabled: true,
    extra,
  };
});

const sessionsFile = path.join(PROJECT_ROOT, "config", "sessions.json");
fs.mkdirSync(path.dirname(sessionsFile), { recursive: true });
fs.writeFileSync(sessionsFile, JSON.stringify({ sessions }, null, 2), "utf-8");
console.log(`Synced ${sessions.length} sessions to ${sessionsFile}`);

db.close();
