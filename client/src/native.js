/**
 * Native bridge - abstracts Tauri invoke / Electron IPC / browser fallback
 */

let _invoke = null;

async function getInvoke() {
  if (_invoke) return _invoke;
  // Tauri v2
  if (window.__TAURI_INTERNALS__) {
    const { invoke } = await import("@tauri-apps/api/core");
    _invoke = invoke;
    return _invoke;
  }
  return null;
}

function parseResult(raw) {
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return { ok: true, message: raw }; }
  }
  return raw;
}

export function isNative() {
  return !!(window.__TAURI_INTERNALS__ || window.electronAPI);
}

export async function proxyInitialize() {
  const invoke = await getInvoke();
  if (invoke) return parseResult(await invoke("proxy_initialize"));
  if (window.electronAPI) return window.electronAPI.proxyInitialize();
  return { hostsModified: false, proxyRunning: false };
}

export async function proxyRun(gatewayUrl) {
  const invoke = await getInvoke();
  if (invoke) return parseResult(await invoke("proxy_run", { gatewayUrl: gatewayUrl || "" }));
  if (window.electronAPI) return window.electronAPI.proxyRun(gatewayUrl);
  return { ok: true, message: "simulated" };
}

export async function proxyStop() {
  const invoke = await getInvoke();
  if (invoke) return parseResult(await invoke("proxy_stop"));
  if (window.electronAPI) return window.electronAPI.proxyStop();
  return { ok: true, message: "simulated" };
}

export async function proxyRestore() {
  const invoke = await getInvoke();
  if (invoke) return parseResult(await invoke("proxy_restore"));
  if (window.electronAPI) return window.electronAPI.proxyRestore();
  return { ok: true, message: "simulated" };
}

export async function proxyStatus() {
  const invoke = await getInvoke();
  if (invoke) return parseResult(await invoke("proxy_status"));
  if (window.electronAPI) return window.electronAPI.proxyStatus();
  return { hostsModified: false, proxyRunning: false };
}
