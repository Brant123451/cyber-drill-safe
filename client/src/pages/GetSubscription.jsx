import { useState } from "react";
import { api } from "../api";

const PLANS = {
  hourly: [
    {
      name: "\u57fa\u7840\u7248",
      price: "\u00a59.9",
      period: "1\u5929",
      features: ["\u79ef\u5206\u4e0a\u9650: 1000", "\u6062\u590d\u95f4\u9694: 5 \u5c0f\u65f6", "\u6062\u590d\u6570\u91cf: +1000"],
      desc: "\u5168\u6a21\u578b\u8bbf\u95ee(pro\u53f7\u6c60)\uff0c\u9002\u5408\u4e2a\u4eba\u5f00\u53d1\n\u6bcf\u4e94\u5c0f\u65f6\u6062\u590d\u81f31000\u79ef\u5206\n\u9000\u6b3e\u65b9\u5f0f\uff1a\u6309\u7167\u5c0f\u65f6\u9000\u6b3e\u5728\u6fc0\u6d3b\u4e4b\u540e(\u5269\u4f59\u591a\u5c11\u5c0f\u65f6\u9000\u591a\u5c11)",
      active: true,
      key: "basic",
    },
    {
      name: "\u4e13\u4e1a\u7248",
      price: "\u00a515.88",
      period: "1\u5929",
      features: ["\u79ef\u5206\u4e0a\u9650: 1000", "\u6062\u590d\u95f4\u9694: 3 \u5c0f\u65f6", "\u6062\u590d\u6570\u91cf: +1000"],
      desc: "\u5168\u6a21\u578b\uff0c\u79ef\u5206\u5feb\u901f\u5237\u65b0",
      active: false,
      key: "pro",
    },
    {
      name: "\u65d7\u8230\u7248",
      price: "\u00a525",
      period: "1\u5929",
      features: ["\u79ef\u5206\u4e0a\u9650: 1000", "\u6062\u590d\u95f4\u9694: 1 \u5c0f\u65f6", "\u6062\u590d\u6570\u91cf: +1000"],
      desc: "\u6700\u9ad8\u4f18\u5148\u7ea7 + \u5168\u6a21\u578b",
      active: false,
      key: "unlimited",
    },
  ],
};

export default function GetSubscription({ user, setUser }) {
  const [tab, setTab] = useState("hourly");
  const [activating, setActivating] = useState(null);

  const handleActivate = async (key) => {
    setActivating(key);
    try {
      await api.activateSub(key);
      const u = await api.me();
      setUser(u);
    } catch {}
    setActivating(null);
  };

  const plans = PLANS[tab] || PLANS.hourly;

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-800 mb-6">{"\u83b7\u53d6\u8ba2\u9605"}</h1>

      {/* Tabs */}
      <div className="flex gap-6 border-b border-gray-200 mb-6">
        {[
          { key: "hourly", label: "\u5305\u65f6\u8ba2\u9605" },
          { key: "code", label: "\u6fc0\u6d3b\u7801\u6fc0\u6d3b" },
        ].map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`pb-3 text-sm font-medium border-b-2 transition-colors cursor-pointer ${
              tab === t.key ? "border-blue-500 text-blue-600" : "border-transparent text-gray-400 hover:text-gray-600"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Info banner */}
      <div className="bg-blue-50 text-blue-600 text-sm px-4 py-2.5 rounded-lg mb-6">
        {tab === "hourly" && "\u6309\u65f6\u95f4\u8ba1\u8d39\uff0c\u79ef\u5206\u7528\u5b8c\u540e\u9700\u8981\u7b49\u5f85\u6062\u590d\u6216\u7eed\u8d39"}
        {tab === "monthly" && "\u5305\u6708\u8ba2\u9605\uff0c\u6bcf\u6708\u81ea\u52a8\u7eed\u8d39"}
        {tab === "code" && "\u8f93\u5165\u6fc0\u6d3b\u7801\u6fc0\u6d3b\u8ba2\u9605"}
      </div>

      {tab === "code" ? (
        <ActivationCodeForm />
      ) : (
        <div className="grid grid-cols-3 gap-5">
          {plans.map((plan) => {
            const isCurrent = user.subscription === plan.key;
            return (
              <div
                key={plan.key}
                className={`bg-white rounded-xl border-2 p-6 flex flex-col ${
                  isCurrent ? "border-blue-400" : "border-gray-200"
                }`}
              >
                <div className="text-center mb-4">
                  <div className="text-lg font-bold text-gray-800">{plan.name}</div>
                </div>

                <div className="text-center mb-5">
                  <span className="text-3xl font-bold text-blue-500">{plan.price}</span>
                  <span className="text-sm text-gray-400 ml-1">/ {plan.period}</span>
                </div>

                <div className="space-y-2 mb-4 text-sm text-gray-600">
                  {plan.features.map((f, i) => (
                    <div key={i} className="flex items-start gap-1.5">
                      <span className="text-blue-400 mt-0.5">+</span>
                      <span>{f}</span>
                    </div>
                  ))}
                </div>

                {plan.desc && (
                  <div className="text-xs text-gray-400 mb-5 whitespace-pre-line leading-relaxed flex-1">
                    {plan.desc}
                  </div>
                )}

                <div className="mt-auto">
                  {isCurrent ? (
                    <div className="text-center border border-blue-400 text-blue-600 py-2 rounded-lg text-sm font-medium">
                      {"\u5f53\u524d\u8ba2\u9605"}
                    </div>
                  ) : (
                    <button
                      onClick={() => handleActivate(plan.key)}
                      disabled={activating === plan.key}
                      className="w-full text-center border border-gray-300 text-gray-500 py-2 rounded-lg text-sm hover:bg-gray-50 transition-colors cursor-pointer disabled:opacity-50"
                    >
                      {activating === plan.key ? "..." : "\u4f7f\u7528\u6fc0\u6d3b\u7801\u6fc0\u6d3b"}
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

function ActivationCodeForm() {
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState("");

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!code.trim()) return;
    setMsg("\u6fc0\u6d3b\u7801\u529f\u80fd\u5f85\u5f00\u53d1");
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6 max-w-md">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">{"\u6fc0\u6d3b\u7801"}</label>
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder={"\u8bf7\u8f93\u5165\u6fc0\u6d3b\u7801"}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        {msg && <div className="text-sm text-orange-500">{msg}</div>}
        <button
          type="submit"
          className="bg-blue-500 text-white px-6 py-2 rounded-lg text-sm font-medium hover:bg-blue-600 transition-colors cursor-pointer"
        >
          {"\u6fc0\u6d3b"}
        </button>
      </form>
    </div>
  );
}
