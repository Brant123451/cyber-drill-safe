/**
 * Proxy Manager
 * Handles: hosts file modification, local HTTPS proxy start/stop
 * Requires elevated privileges (admin) for hosts file access
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOSTS_FILE = "C:\\Windows\\System32\\drivers\\etc\\hosts";
const HOSTS_MARKER = "# WIND-PROXY";
const TARGET_DOMAIN = "server.self-serve.windsurf.com";
const HOSTS_ENTRY = `127.0.0.1 ${TARGET_DOMAIN} ${HOSTS_MARKER}`;

// Path to local-proxy.js (relative to project root)
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const PROXY_SCRIPT = path.join(PROJECT_ROOT, "src", "local-proxy.js");
const CERT_KEY = path.join(PROJECT_ROOT, "certs", "server.key");
const CERT_CRT = path.join(PROJECT_ROOT, "certs", "server.crt");

let proxyProcess = null;

// ============================================================
// Hosts file operations
// ============================================================

export function isHostsConfigured() {
  try {
    const content = fs.readFileSync(HOSTS_FILE, "utf-8");
    return content.includes(HOSTS_MARKER);
  } catch {
    return false;
  }
}

export function addHostsEntry() {
  try {
    const content = fs.readFileSync(HOSTS_FILE, "utf-8");
    if (content.includes(HOSTS_MARKER)) return { ok: true, msg: "already configured" };

    const newContent = content.trimEnd() + "\n" + HOSTS_ENTRY + "\n";
    fs.writeFileSync(HOSTS_FILE, newContent, "utf-8");
    return { ok: true, msg: "hosts entry added" };
  } catch (err) {
    return { ok: false, msg: `Failed to modify hosts: ${err.message}. Run as Administrator.` };
  }
}

export function removeHostsEntry() {
  try {
    const content = fs.readFileSync(HOSTS_FILE, "utf-8");
    if (!content.includes(HOSTS_MARKER)) return { ok: true, msg: "already clean" };

    const lines = content.split("\n").filter((l) => !l.includes(HOSTS_MARKER));
    fs.writeFileSync(HOSTS_FILE, lines.join("\n"), "utf-8");
    return { ok: true, msg: "hosts entry removed" };
  } catch (err) {
    return { ok: false, msg: `Failed to restore hosts: ${err.message}. Run as Administrator.` };
  }
}

// ============================================================
// Proxy process control
// ============================================================

export function isProxyRunning() {
  return proxyProcess !== null && !proxyProcess.killed;
}

export function startProxy(gatewayUrl) {
  if (isProxyRunning()) return { ok: true, msg: "proxy already running" };

  // Check certs exist
  if (!fs.existsSync(CERT_KEY) || !fs.existsSync(CERT_CRT)) {
    return { ok: false, msg: `TLS certs not found at ${CERT_KEY}` };
  }

  const env = {
    ...process.env,
    PROXY_MODE: gatewayUrl ? "gateway" : "passthrough",
  };
  if (gatewayUrl) env.GATEWAY_URL = gatewayUrl;

  try {
    proxyProcess = spawn("node", [PROXY_SCRIPT], {
      cwd: PROJECT_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    proxyProcess.stdout.on("data", (d) => console.log("[proxy]", d.toString().trim()));
    proxyProcess.stderr.on("data", (d) => console.error("[proxy:err]", d.toString().trim()));
    proxyProcess.on("exit", (code) => {
      console.log(`[proxy] exited with code ${code}`);
      proxyProcess = null;
    });

    return { ok: true, msg: `proxy started (PID ${proxyProcess.pid})` };
  } catch (err) {
    return { ok: false, msg: `Failed to start proxy: ${err.message}` };
  }
}

export function stopProxy() {
  if (!isProxyRunning()) return { ok: true, msg: "proxy not running" };

  proxyProcess.kill("SIGTERM");
  proxyProcess = null;
  return { ok: true, msg: "proxy stopped" };
}

// ============================================================
// Combined operations (what buttons do)
// ============================================================

/** 初始化: add hosts entry + install cert trust */
export function initialize() {
  const result = addHostsEntry();
  return result;
}

/** 运行切号: start local proxy (hosts must be configured first) */
export function runProxy(gatewayUrl) {
  if (!isHostsConfigured()) {
    const init = addHostsEntry();
    if (!init.ok) return init;
  }
  return startProxy(gatewayUrl);
}

/** 停止运行: stop proxy process */
export function stopRunning() {
  return stopProxy();
}

/** 还原初始化: stop proxy + remove hosts entry */
export function restore() {
  stopProxy();
  return removeHostsEntry();
}

/** Get full status */
export function getStatus() {
  return {
    hostsConfigured: isHostsConfigured(),
    proxyRunning: isProxyRunning(),
    proxyPid: proxyProcess?.pid || null,
  };
}
