import { useState } from "react";
import { Settings as SettingsIcon, Save, Server } from "lucide-react";
import { api } from "../api";

export default function Settings({ user }) {
  const [apiBase, setApiBase] = useState(api.getApiBase());
  const [saved, setSaved] = useState(false);

  const handleSave = () => {
    api.setApiBase(apiBase);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-800 mb-6">{"\u8bbe\u7f6e"}</h1>

      <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-6 max-w-xl">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Server className="w-4 h-4 text-gray-400" />
            <label className="text-sm font-medium text-gray-700">{"\u670d\u52a1\u5668\u5730\u5740"}</label>
          </div>
          <input
            type="text"
            value={apiBase}
            onChange={(e) => setApiBase(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="http://127.0.0.1:18800"
          />
          <p className="text-xs text-gray-400 mt-1">{"\u4fee\u6539\u540e\u9700\u91cd\u65b0\u767b\u5f55"}</p>
        </div>

        <div>
          <label className="text-sm font-medium text-gray-700">{"\u8d26\u6237\u4fe1\u606f"}</label>
          <div className="mt-2 text-sm text-gray-600 space-y-1">
            <div>{"\u7528\u6237\u540d"}: <span className="font-medium">{user.username}</span></div>
            <div>{"\u90ae\u7bb1"}: <span className="font-medium">{user.email}</span></div>
            <div>{"\u89d2\u8272"}: <span className="font-medium">{user.role}</span></div>
            <div>{"\u6ce8\u518c\u65f6\u95f4"}: <span className="font-medium">{user.created_at}</span></div>
          </div>
        </div>

        <button
          onClick={handleSave}
          className="flex items-center gap-2 bg-blue-500 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-blue-600 transition-colors cursor-pointer"
        >
          <Save className="w-4 h-4" />
          {saved ? "\u5df2\u4fdd\u5b58" : "\u4fdd\u5b58\u8bbe\u7f6e"}
        </button>
      </div>
    </div>
  );
}
