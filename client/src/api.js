const DEFAULT_API = "http://47.84.31.126:18800";
const API_BASE = localStorage.getItem("wind_api_base") || DEFAULT_API;

function getToken() {
  return localStorage.getItem("wind_token");
}

async function request(method, path, body) {
  const headers = { "Content-Type": "application/json" };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const api = {
  register: (username, email, password) => request("POST", "/api/auth/register", { username, email, password }),
  login: (username, password) => request("POST", "/api/auth/login", { username, password }),
  me: () => request("GET", "/api/auth/me"),
  pools: () => request("GET", "/api/pools"),
  selectPool: (pool_id) => request("POST", "/api/pools/select", { pool_id }),
  detectPools: () => request("POST", "/api/pools/detect"),
  subscriptions: () => request("GET", "/api/subscriptions"),
  activateSub: (name) => request("POST", "/api/subscriptions/activate", { name }),
  announcements: () => request("GET", "/api/announcements"),
  logs: (limit = 50) => request("GET", `/api/logs?limit=${limit}`),
  proxyConfig: () => request("GET", "/api/proxy/config"),
  health: () => request("GET", "/api/health"),
  setApiBase: (url) => { localStorage.setItem("wind_api_base", url); },
  getApiBase: () => API_BASE,

  // Admin APIs
  adminUsers: () => request("GET", "/api/admin/users"),
  adminSetRole: (id, role) => request("POST", `/api/admin/users/${id}/role`, { role }),
  adminAddCredits: (id, amount) => request("POST", `/api/admin/users/${id}/credits`, { amount }),
  adminPoolAccounts: () => request("GET", "/api/admin/pool-accounts"),
  adminPoolAccountsByPool: (poolId) => request("GET", `/api/admin/pool-accounts/${poolId}`),
  adminAddPoolAccount: (pool_id, label, session_token, platform) =>
    request("POST", "/api/admin/pool-accounts", { pool_id, label, session_token, platform }),
  adminRemovePoolAccount: (id) => request("DELETE", `/api/admin/pool-accounts/${id}`),
  adminTogglePoolAccount: (id, status) => request("POST", `/api/admin/pool-accounts/${id}/status`, { status }),
  adminCreatePool: (name, code, api_key, region, upstream_ip) =>
    request("POST", "/api/admin/pools", { name, code, api_key, region, upstream_ip }),
  adminDeletePool: (id) => request("DELETE", `/api/admin/pools/${id}`),
  adminCreateAnnouncement: (title, content) => request("POST", "/api/admin/announcements", { title, content }),
  adminDeleteAnnouncement: (id) => request("DELETE", `/api/admin/announcements/${id}`),
};
