import { useState, useEffect } from "react";
import { api } from "../api";
import { Database, Check, Wifi, WifiOff } from "lucide-react";

export default function Pools({ user, setUser }) {
  const [pools, setPools] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadPools();
  }, []);

  const loadPools = async () => {
    try {
      const data = await api.pools();
      setPools(data);
    } catch {}
    setLoading(false);
  };

  const selectPool = async (poolId) => {
    try {
      await api.selectPool(poolId);
      const u = await api.me();
      setUser(u);
    } catch {}
  };

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-800 mb-6">{"\u53f7\u6c60"}</h1>

      {loading ? (
        <div className="text-gray-400">{"\u52a0\u8f7d\u4e2d..."}</div>
      ) : pools.length === 0 ? (
        <div className="text-gray-400">{"\u6682\u65e0\u53ef\u7528\u53f7\u6c60"}</div>
      ) : (
        <div className="grid grid-cols-1 gap-3">
          {pools.map((pool) => {
            const isSelected = user.pool?.id === pool.id;
            return (
              <div
                key={pool.id}
                className={`bg-white rounded-xl border p-4 flex items-center justify-between transition-colors ${
                  isSelected ? "border-blue-400 bg-blue-50/50" : "border-gray-200 hover:border-gray-300"
                }`}
              >
                <div className="flex items-center gap-4">
                  <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${pool.status === "online" ? "bg-green-50" : "bg-red-50"}`}>
                    {pool.status === "online" ? <Wifi className="w-5 h-5 text-green-500" /> : <WifiOff className="w-5 h-5 text-red-400" />}
                  </div>
                  <div>
                    <div className="font-medium text-gray-800">{pool.name}</div>
                    <div className="text-xs text-gray-400 mt-0.5">
                      {"\u7f16\u53f7"}: {pool.code} &middot; {pool.region || "\u672a\u77e5\u5730\u533a"} &middot; {pool.latency_ms}ms
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className={`text-xs px-2 py-0.5 rounded ${pool.status === "online" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-600"}`}>
                    {pool.status}
                  </span>
                  {isSelected ? (
                    <span className="flex items-center gap-1 text-blue-600 text-sm font-medium">
                      <Check className="w-4 h-4" /> {"\u5df2\u9009\u62e9"}
                    </span>
                  ) : (
                    <button
                      onClick={() => selectPool(pool.id)}
                      disabled={pool.status !== "online"}
                      className="text-sm text-blue-500 hover:text-blue-700 disabled:text-gray-300 cursor-pointer"
                    >
                      {"\u9009\u62e9"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
