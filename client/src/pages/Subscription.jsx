import { useState, useEffect } from "react";
import { api } from "../api";

function useCountdown(targetSeconds) {
  const [remaining, setRemaining] = useState(targetSeconds);
  useEffect(() => {
    if (remaining <= 0) return;
    const timer = setInterval(() => setRemaining((r) => Math.max(0, r - 1)), 1000);
    return () => clearInterval(timer);
  }, [remaining > 0]);

  const h = Math.floor(remaining / 3600);
  const m = Math.floor((remaining % 3600) / 60);
  const s = remaining % 60;
  return remaining > 0 ? `${h}\u65f6${String(m).padStart(2, "0")}\u5206${String(s).padStart(2, "0")}\u79d2\u540e\u6062\u590d` : null;
}

export default function Subscription({ user, setUser }) {
  const sub = user.subscription_detail;
  const credits = user.credits ?? 0;
  const maxCredits = 1000;
  const usagePercent = Math.min(100, (credits / maxCredits) * 100);

  const refreshHours = { free: 24, basic: 5, pro: 3, unlimited: 1 };
  const currentRefresh = refreshHours[user.subscription] || 5;

  const countdown = useCountdown(currentRefresh * 3600 - 38 * 60 - 3);

  const [preferredIdx, setPreferredIdx] = useState(0);

  const historyRaw = [
    { name: "\u4e13\u4e1a\u7248", tag: "\u6309\u65f6", active: true, status: "\u751f\u6548\u4e2d", countdown: null, full: true, expiry: "2026-02-26 21:47", used: 1000, max: 1000 },
    { name: "\u57fa\u7840\u7248", tag: "\u6309\u65f6", active: true, status: "\u751f\u6548\u4e2d", countdown, full: false, expiry: "2026-02-27 18:16", used: 9, max: 1000 },
    { name: "\u57fa\u7840\u7248", tag: "\u6309\u65f6", active: false, status: "\u5df2\u8fc7\u671f", countdown: null, full: false, expiry: "2026-02-25 15:37", used: 1000, max: 1000 },
  ].sort((a, b) => new Date(b.expiry) - new Date(a.expiry));

  const activeItems = historyRaw.filter((h) => h.active);
  const history = historyRaw.map((item) => {
    if (!item.active) return { ...item, preferred: false };
    const idx = activeItems.indexOf(item);
    return { ...item, preferred: idx === preferredIdx };
  });

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-800 mb-6">{"\u6211\u7684\u8ba2\u9605"}</h1>

      {/* Subscription Info */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 mb-4">
        <div className="text-sm text-blue-500 font-medium mb-3">{"\u8ba2\u9605\u4fe1\u606f"}</div>
        <div className="flex gap-16">
          <div>
            <div className="text-xs text-gray-400 mb-1">{"\u5f53\u524d\u5957\u9910"}</div>
            <div className="text-2xl font-bold text-gray-800">{"\u57fa\u7840\u7248"}</div>
            <div className="text-xs text-gray-400 mt-1">{"\u6807\u8bc6"}: {user.subscription || "basic"}</div>
          </div>
          <div>
            <div className="text-xs text-gray-400 mb-1">{"\u5230\u671f\u65f6\u95f4"}</div>
            <div className="text-2xl font-bold text-gray-800">2026-02-27 18:16:21</div>
          </div>
        </div>
      </div>

      {/* Credits Usage */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 mb-4">
        <div className="text-sm text-gray-500 mb-3">{"\u79ef\u5206\u7528\u91cf"}</div>
        <div className="flex items-end justify-between mb-2">
          <div>
            <div className="text-5xl font-bold text-blue-500">{credits}</div>
            <div className="text-xs text-gray-400 mt-1">{"\u5f53\u524d\u79ef\u5206"} / {maxCredits} {"\u4e0a\u9650"}</div>
          </div>
          <div className="flex gap-12 text-right">
            <div>
              <div className="text-xs text-gray-400">{"\u6062\u590d\u95f4\u9694"}</div>
              <div className="text-lg font-bold text-gray-800">{currentRefresh} {"\u5c0f\u65f6"}</div>
            </div>
            <div>
              <div className="text-xs text-gray-400">{"\u6bcf\u6b21\u6062\u590d"}</div>
              <div className="text-lg font-bold text-gray-800">+1000 {"\u79ef\u5206"}</div>
            </div>
          </div>
        </div>
        <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
          <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${usagePercent}%` }} />
        </div>
      </div>

      {/* Subscription History List */}
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <div className="text-sm text-gray-500 mb-4">{"\u8ba2\u9605\u5217\u8868"}</div>
        <div className="space-y-5">
          {history.slice(0, 5).map((item, i) => (
            <div key={i} className="border-b border-gray-100 pb-4 last:border-0 last:pb-0">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-bold text-gray-800">{item.name}</span>
                  <span className="text-xs bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">{item.tag}</span>
                  {item.active && item.preferred && <span className="text-xs bg-blue-100 text-blue-600 px-1.5 py-0.5 rounded">{"\u5f53\u524d\u751f\u6548"}</span>}
                  {item.active && item.preferred && <span className="text-xs bg-orange-100 text-orange-600 px-1.5 py-0.5 rounded">{"\u4f18\u5148\u8bbe\u7f6e"}</span>}
                  <span className={`text-xs px-1.5 py-0.5 rounded ${item.status === "\u751f\u6548\u4e2d" ? "bg-green-100 text-green-600" : "bg-red-100 text-red-500"}`}>
                    {item.status}
                  </span>
                  {item.full && <span className="text-xs bg-purple-100 text-purple-600 px-1.5 py-0.5 rounded">{"\u79ef\u5206\u5df2\u6ee1"}</span>}
                  {item.countdown && <span className="text-xs text-blue-400">{item.countdown}</span>}
                </div>
                <div className="flex items-center gap-4 text-xs shrink-0">
                  {item.active && item.preferred && <span className="text-green-500 font-medium">{"\u5df2\u4f18\u5148"}</span>}
                  {item.active && !item.preferred && <span onClick={() => setPreferredIdx(activeItems.indexOf(item))} className="text-gray-800 font-medium cursor-pointer hover:underline">{"\u8bbe\u4e3a\u4f18\u5148"}</span>}
                  <span className="text-gray-400">{"\u5230\u671f"}: {item.expiry}</span>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                  <div className="h-full bg-blue-500 rounded-full" style={{ width: `${(item.used / item.max) * 100}%` }} />
                </div>
                <span className="text-xs text-gray-500 shrink-0">{item.used} / {item.max}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
