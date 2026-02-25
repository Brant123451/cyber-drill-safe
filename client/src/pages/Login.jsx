import { useState } from "react";
import { Zap } from "lucide-react";
import { api } from "../api";

export default function Login({ onLogin }) {
  const [tab, setTab] = useState("login");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      let result;
      if (tab === "register") {
        result = await api.register(username, email, password);
      } else {
        result = await api.login(username, password);
      }
      onLogin(result.token, result.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="bg-white rounded-2xl shadow-lg w-full max-w-md p-8">
        <div className="text-center mb-6">
          <div className="flex items-center justify-center gap-2 mb-2">
            <Zap className="w-6 h-6 text-yellow-500" />
            <span className="text-2xl font-bold text-blue-600">Wind</span>
          </div>
          <p className="text-gray-500 text-sm">{"\u767b\u5f55\u6216\u6ce8\u518c\u4ee5\u7ee7\u7eed\u4f7f\u7528"}</p>
        </div>

        <div className="flex border-b border-gray-200 mb-6">
          <button
            onClick={() => setTab("login")}
            className={`flex-1 pb-3 text-sm font-medium border-b-2 transition-colors cursor-pointer ${
              tab === "login" ? "border-blue-500 text-blue-600" : "border-transparent text-gray-400 hover:text-gray-600"
            }`}
          >
            {"\u767b\u5f55"}
          </button>
          <button
            onClick={() => setTab("register")}
            className={`flex-1 pb-3 text-sm font-medium border-b-2 transition-colors cursor-pointer ${
              tab === "register" ? "border-blue-500 text-blue-600" : "border-transparent text-gray-400 hover:text-gray-600"
            }`}
          >
            {"\u6ce8\u518c"}
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">{"\u7528\u6237\u540d"}</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={"\u8bf7\u8f93\u5165\u7528\u6237\u540d"}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              required
            />
          </div>

          {tab === "register" && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">{"\u90ae\u7bb1"}</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={"\u8bf7\u8f93\u5165\u90ae\u7bb1"}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                required
              />
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">{"\u5bc6\u7801"}</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={"\u8bf7\u8f93\u5165\u5bc6\u7801"}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              required
            />
          </div>

          {error && <div className="text-red-500 text-sm">{error}</div>}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-500 text-white py-2.5 rounded-lg text-sm font-medium hover:bg-blue-600 disabled:opacity-50 transition-colors cursor-pointer"
          >
            {loading ? "..." : tab === "register" ? "\u6ce8\u518c" : "\u767b\u5f55"}
          </button>
        </form>
      </div>
    </div>
  );
}
