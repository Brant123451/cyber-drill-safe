import { useState, useEffect } from "react";
import { api } from "../api";
import { FileText, RefreshCw } from "lucide-react";

export default function Logs() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => { loadLogs(); }, []);

  const loadLogs = async () => {
    setLoading(true);
    try {
      const data = await api.logs(100);
      setLogs(data);
    } catch {}
    setLoading(false);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-800">{"\u8bf7\u6c42\u65e5\u5fd7"}</h1>
        <button onClick={loadLogs} className="flex items-center gap-1 text-sm text-blue-500 hover:text-blue-700 cursor-pointer">
          <RefreshCw className="w-4 h-4" /> {"\u5237\u65b0"}
        </button>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 text-left text-gray-500">
              <th className="px-4 py-3 font-medium">{"\u65f6\u95f4"}</th>
              <th className="px-4 py-3 font-medium">{"\u7aef\u70b9"}</th>
              <th className="px-4 py-3 font-medium">{"\u6a21\u578b"}</th>
              <th className="px-4 py-3 font-medium">Tokens</th>
              <th className="px-4 py-3 font-medium">{"\u5ef6\u8fdf"}</th>
              <th className="px-4 py-3 font-medium">{"\u72b6\u6001"}</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400">{"\u52a0\u8f7d\u4e2d..."}</td></tr>
            ) : logs.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400">{"\u6682\u65e0\u65e5\u5fd7"}</td></tr>
            ) : (
              logs.map((log) => (
                <tr key={log.id} className="border-t border-gray-100 hover:bg-gray-50">
                  <td className="px-4 py-2.5 text-gray-500 text-xs">{log.created_at}</td>
                  <td className="px-4 py-2.5 text-gray-800 font-mono text-xs">{log.endpoint || "-"}</td>
                  <td className="px-4 py-2.5 text-gray-600 text-xs">{log.model || "-"}</td>
                  <td className="px-4 py-2.5 text-gray-600">{log.tokens_used}</td>
                  <td className="px-4 py-2.5 text-gray-600">{log.latency_ms}ms</td>
                  <td className="px-4 py-2.5">
                    <span className={`text-xs px-1.5 py-0.5 rounded ${log.status_code === 200 ? "bg-green-100 text-green-700" : "bg-red-100 text-red-600"}`}>
                      {log.status_code}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
