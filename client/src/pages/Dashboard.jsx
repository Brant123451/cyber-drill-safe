import { useState, useEffect } from "react";
import { api } from "../api";
import { Database, CreditCard, Wifi, Bell, Play, Square, RotateCcw, Radar } from "lucide-react";
import { isNative, proxyInitialize, proxyRun, proxyStop, proxyRestore, proxyStatus } from "../native";

export default function Dashboard({ user, setUser }) {
  const [announcements, setAnnouncements] = useState([]);
  const [proxyRunning, setProxyRunning] = useState(false);
  const [hostsStatus, setHostsStatus] = useState("inactive");
  const [detecting, setDetecting] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");

  useEffect(() => {
    api.announcements().then(setAnnouncements).catch(() => {});
    refreshStatus();
  }, []);

  const refreshStatus = async () => {
    if (isNative()) {
      const s = await proxyStatus();
      setHostsStatus(s.hostsModified ? "active" : "inactive");
      setProxyRunning(s.proxyRunning);
    }
  };

  const refreshUser = async () => {
    try {
      const u = await api.me();
      setUser(u);
    } catch {}
  };

  const showMsg = (msg) => { setStatusMsg(msg); setTimeout(() => setStatusMsg(""), 3000); };

  const handleDetect = async () => {
    setDetecting(true);
    try {
      const res = await api.detectPools();
      await refreshUser();
      const best = res.selected;
      showMsg(best ? `\u5df2\u5207\u6362\u5230\u6700\u4f18\u53f7\u6c60: ${best.name}` : "\u63a2\u6d4b\u5b8c\u6210");
    } catch { showMsg("\u63a2\u6d4b\u5931\u8d25"); }
    setDetecting(false);
  };

  const handleInit = async () => {
    const r = await proxyInitialize();
    showMsg(isNative() ? "\u521d\u59cb\u5316\u6210\u529f\uff0chosts \u5df2\u914d\u7f6e" : "\u521d\u59cb\u5316\u6210\u529f\uff08\u6d4f\u89c8\u5668\u6a21\u62df\uff09");
    setHostsStatus("active");
  };

  const handleRun = async () => {
    let gatewayUrl = null;
    try {
      const cfg = await api.proxyConfig();
      if (cfg.pool) gatewayUrl = `https://${cfg.pool.upstream_ip || "47.84.31.126"}:18790`;
    } catch {}
    const r = await proxyRun(gatewayUrl);
    showMsg(isNative() ? "\u4ee3\u7406\u5df2\u542f\u52a8\uff0c\u53ef\u4ee5\u4f7f\u7528 Windsurf \u4e86" : "\u4ee3\u7406\u5df2\u542f\u52a8\uff08\u6d4f\u89c8\u5668\u6a21\u62df\uff09");
    setProxyRunning(true);
    setHostsStatus("active");
  };

  const handleStop = async () => {
    const r = await proxyStop();
    showMsg(isNative() ? "\u4ee3\u7406\u5df2\u505c\u6b62" : "\u4ee3\u7406\u5df2\u505c\u6b62\uff08\u6d4f\u89c8\u5668\u6a21\u62df\uff09");
    setProxyRunning(false);
  };

  const handleRestore = async () => {
    const r = await proxyRestore();
    showMsg(isNative() ? "\u5df2\u8fd8\u539f\uff0chosts \u5df2\u6e05\u7406" : "\u5df2\u8fd8\u539f\uff08\u6d4f\u89c8\u5668\u6a21\u62df\uff09");
    setProxyRunning(false);
    setHostsStatus("inactive");
  };

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-800 mb-6">{"\u4eea\u8868\u76d8"}</h1>

      {/* Status Cards */}
      <div className="grid grid-cols-2 gap-4 mb-6">
        <StatusCard
          icon={<Database className="w-5 h-5 text-gray-400" />}
          label={"\u5f53\u524d\u53f7\u6c60"}
          value={user.pool?.name || "\u672a\u9009\u62e9"}
          sub={user.pool ? `\u53f7\u6c60 \u7f16\u53f7: ${user.pool.code}` : ""}
        />
        <StatusCard
          icon={<Wifi className="w-5 h-5 text-gray-400" />}
          label={"\u914d\u7f6e\u72b6\u6001"}
          value={
            hostsStatus === "active"
              ? <span className="text-green-500 font-bold">{"\u5df2\u914d\u7f6e"}</span>
              : <span className="text-gray-400">{"\u672a\u914d\u7f6e"}</span>
          }
          sub=""
        />
      </div>

      {/* Announcements */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
        <div className="flex items-center gap-2 mb-4">
          <Bell className="w-4 h-4 text-gray-400" />
          <span className="text-sm font-medium text-gray-600">{"\u7cfb\u7edf\u516c\u544a"}</span>
        </div>
        <div className="space-y-3 max-h-64 overflow-auto">
          {announcements.length === 0 && (
            <p className="text-sm text-gray-400">{"\u6682\u65e0\u516c\u544a"}</p>
          )}
          {announcements.map((a) => (
            <div key={a.id} className="flex items-start gap-3 py-2 border-b border-gray-50 last:border-0">
              <div className="w-1.5 h-1.5 rounded-full bg-blue-500 mt-1.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-gray-800">{a.title}</div>
                <div className="text-xs text-gray-500 mt-0.5">{a.content}</div>
              </div>
              <div className="text-xs text-gray-400 shrink-0">{a.created_at}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Toast - top right */}
      {statusMsg && (
        <div className="fixed top-6 right-6 bg-white border border-gray-200 shadow-lg rounded-xl px-5 py-3 text-sm text-gray-800 z-50 animate-[fadeIn_0.2s_ease-out]">
          {statusMsg}
        </div>
      )}

      {/* Action Buttons */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleDetect}
          disabled={detecting}
          className="flex items-center gap-2 bg-red-500 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-red-600 disabled:opacity-50 transition-colors cursor-pointer"
        >
          <Radar className="w-4 h-4" />
          {detecting ? "\u63a2\u6d4b\u4e2d..." : "\u4e00\u952e\u63a2\u6d4b\u9009\u8def"}
        </button>
        <button
          onClick={handleInit}
          disabled={proxyRunning}
          className="flex items-center gap-2 bg-white border border-gray-300 text-gray-700 px-5 py-2 rounded-lg text-sm font-medium hover:bg-gray-50 disabled:opacity-50 transition-colors cursor-pointer"
        >
          <Play className="w-4 h-4" />
          {"\u521d\u59cb\u5316"}
        </button>
        <button
          onClick={handleRestore}
          className="flex items-center gap-2 bg-white border border-gray-300 text-gray-700 px-5 py-2 rounded-lg text-sm font-medium hover:bg-gray-50 transition-colors cursor-pointer"
        >
          <RotateCcw className="w-4 h-4" />
          {"\u8fd8\u539f\u521d\u59cb\u5316"}
        </button>
        {proxyRunning ? (
          <button
            onClick={handleStop}
            className="flex items-center gap-2 bg-red-500 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-red-600 transition-colors cursor-pointer"
          >
            <Square className="w-4 h-4" />
            {"\u505c\u6b62\u8fd0\u884c"}
          </button>
        ) : (
          <button
            onClick={handleRun}
            className="flex items-center gap-2 bg-green-500 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-green-600 transition-colors cursor-pointer"
          >
            <Play className="w-4 h-4" />
            {"\u8fd0\u884c\u5207\u53f7"}
          </button>
        )}
      </div>
    </div>
  );
}

function StatusCard({ icon, label, value, sub, progress }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <div className="flex items-center gap-2 text-sm text-gray-500 mb-2">
        {icon}
        {label}
      </div>
      <div className="text-xl font-bold text-gray-800">{value}</div>
      {sub && <div className="text-xs text-gray-400 mt-1">{sub}</div>}
      {progress !== undefined && progress > 0 && (
        <div className="mt-2 h-1.5 bg-gray-100 rounded-full overflow-hidden">
          <div
            className="h-full bg-blue-500 rounded-full transition-all"
            style={{ width: `${Math.min(100, progress)}%` }}
          />
        </div>
      )}
    </div>
  );
}
