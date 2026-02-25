import { useState, useEffect } from "react";
import { api } from "../api";
import { Plus, Trash2, Users, Server, Key, ToggleLeft, ToggleRight, Megaphone } from "lucide-react";

export default function Admin({ user }) {
  const [tab, setTab] = useState("accounts");
  const [pools, setPools] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [users, setUsers] = useState([]);
  const [announcements, setAnnouncements] = useState([]);
  const [msg, setMsg] = useState("");

  // Add account form
  const [addPoolId, setAddPoolId] = useState("");
  const [addLabel, setAddLabel] = useState("");
  const [addToken, setAddToken] = useState("");

  // Add pool form
  const [poolName, setPoolName] = useState("");
  const [poolCode, setPoolCode] = useState("");
  const [poolRegion, setPoolRegion] = useState("");

  // Add announcement form
  const [annTitle, setAnnTitle] = useState("");
  const [annContent, setAnnContent] = useState("");

  const showMsg = (m) => { setMsg(m); setTimeout(() => setMsg(""), 3000); };

  const refresh = async () => {
    try {
      const [p, a, u, an] = await Promise.all([
        api.pools(),
        api.adminPoolAccounts(),
        api.adminUsers(),
        api.announcements(),
      ]);
      setPools(p);
      setAccounts(a);
      setUsers(u);
      setAnnouncements(an);
      if (p.length > 0 && !addPoolId) setAddPoolId(String(p[0].id));
    } catch (e) {
      showMsg("加载失败: " + e.message);
    }
  };

  useEffect(() => { refresh(); }, []);

  const handleAddAccount = async () => {
    if (!addPoolId || !addLabel || !addToken) return showMsg("请填写完整");
    try {
      await api.adminAddPoolAccount(parseInt(addPoolId), addLabel, addToken, "codeium");
      setAddLabel("");
      setAddToken("");
      showMsg("账号添加成功");
      refresh();
    } catch (e) { showMsg("添加失败: " + e.message); }
  };

  const handleRemoveAccount = async (id) => {
    try {
      await api.adminRemovePoolAccount(id);
      showMsg("已删除");
      refresh();
    } catch (e) { showMsg("删除失败: " + e.message); }
  };

  const handleToggleAccount = async (id, currentStatus) => {
    const newStatus = currentStatus === "active" ? "disabled" : "active";
    try {
      await api.adminTogglePoolAccount(id, newStatus);
      showMsg(newStatus === "active" ? "已启用" : "已禁用");
      refresh();
    } catch (e) { showMsg("操作失败: " + e.message); }
  };

  const handleAddPool = async () => {
    if (!poolName || !poolCode) return showMsg("请填写号池名称和编号");
    try {
      await api.adminCreatePool(poolName, poolCode, "auto-" + Date.now(), poolRegion, "");
      setPoolName("");
      setPoolCode("");
      setPoolRegion("");
      showMsg("号池创建成功");
      refresh();
    } catch (e) { showMsg("创建失败: " + e.message); }
  };

  const handleDeletePool = async (id) => {
    try {
      await api.adminDeletePool(id);
      showMsg("号池已删除");
      refresh();
    } catch (e) { showMsg("删除失败: " + e.message); }
  };

  const handleAddAnnouncement = async () => {
    if (!annTitle || !annContent) return showMsg("请填写标题和内容");
    try {
      await api.adminCreateAnnouncement(annTitle, annContent);
      setAnnTitle("");
      setAnnContent("");
      showMsg("公告发布成功");
      refresh();
    } catch (e) { showMsg("发布失败: " + e.message); }
  };

  const handleDeleteAnnouncement = async (id) => {
    try {
      await api.adminDeleteAnnouncement(id);
      showMsg("公告已删除");
      refresh();
    } catch (e) { showMsg("删除失败: " + e.message); }
  };

  const tabs = [
    { key: "accounts", label: "号池账号", icon: <Key className="w-4 h-4" /> },
    { key: "pools", label: "号池管理", icon: <Server className="w-4 h-4" /> },
    { key: "users", label: "用户管理", icon: <Users className="w-4 h-4" /> },
    { key: "announcements", label: "公告管理", icon: <Megaphone className="w-4 h-4" /> },
  ];

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-800 mb-6">{"管理面板"}</h1>

      {msg && (
        <div className="fixed top-6 right-6 bg-white border border-gray-200 shadow-lg rounded-xl px-5 py-3 text-sm text-gray-800 z-50">
          {msg}
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-2 mb-6">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer ${
              tab === t.key ? "bg-gray-800 text-white" : "bg-white border border-gray-200 text-gray-600 hover:bg-gray-50"
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab: Pool Accounts */}
      {tab === "accounts" && (
        <div className="space-y-4">
          {/* Add form */}
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <div className="text-sm font-medium text-gray-600 mb-3">{"添加 Windsurf 账号"}</div>
            <div className="flex gap-3 items-end flex-wrap">
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-400">{"号池"}</label>
                <select
                  value={addPoolId}
                  onChange={(e) => setAddPoolId(e.target.value)}
                  className="border border-gray-200 rounded-lg px-3 py-2 text-sm w-40"
                >
                  {pools.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-400">{"标签"}</label>
                <input
                  value={addLabel}
                  onChange={(e) => setAddLabel(e.target.value)}
                  placeholder="ws-account-01"
                  className="border border-gray-200 rounded-lg px-3 py-2 text-sm w-40"
                />
              </div>
              <div className="flex flex-col gap-1 flex-1">
                <label className="text-xs text-gray-400">{"Session Token"}</label>
                <input
                  value={addToken}
                  onChange={(e) => setAddToken(e.target.value)}
                  placeholder="粘贴 Windsurf session token..."
                  className="border border-gray-200 rounded-lg px-3 py-2 text-sm w-full"
                />
              </div>
              <button
                onClick={handleAddAccount}
                className="flex items-center gap-1.5 bg-green-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-600 transition-colors cursor-pointer shrink-0"
              >
                <Plus className="w-4 h-4" />
                {"添加"}
              </button>
            </div>
          </div>

          {/* Account list */}
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <div className="text-sm font-medium text-gray-600 mb-3">
              {"账号列表"} <span className="text-gray-400 font-normal">({accounts.length} 个)</span>
            </div>
            {accounts.length === 0 ? (
              <p className="text-sm text-gray-400">{"暂无账号，请先添加"}</p>
            ) : (
              <div className="space-y-2">
                {accounts.map((a) => (
                  <div key={a.id} className="flex items-center justify-between py-2.5 px-3 border border-gray-100 rounded-lg hover:bg-gray-50">
                    <div className="flex items-center gap-3 min-w-0">
                      <span className={`w-2 h-2 rounded-full shrink-0 ${a.status === "active" ? "bg-green-500" : "bg-gray-300"}`} />
                      <span className="font-medium text-sm text-gray-800">{a.label}</span>
                      <span className="text-xs text-gray-400 bg-gray-50 px-2 py-0.5 rounded">{a.pool_name || "未知号池"}</span>
                      <span className="text-xs text-gray-400 font-mono truncate">{a.session_token}</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-xs text-gray-400">{a.used_tokens || 0} used</span>
                      <button
                        onClick={() => handleToggleAccount(a.id, a.status)}
                        className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors cursor-pointer"
                        title={a.status === "active" ? "禁用" : "启用"}
                      >
                        {a.status === "active"
                          ? <ToggleRight className="w-5 h-5 text-green-500" />
                          : <ToggleLeft className="w-5 h-5 text-gray-400" />
                        }
                      </button>
                      <button
                        onClick={() => handleRemoveAccount(a.id)}
                        className="p-1.5 rounded-lg hover:bg-red-50 transition-colors cursor-pointer"
                        title="删除"
                      >
                        <Trash2 className="w-4 h-4 text-red-400" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Tab: Pools */}
      {tab === "pools" && (
        <div className="space-y-4">
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <div className="text-sm font-medium text-gray-600 mb-3">{"创建号池"}</div>
            <div className="flex gap-3 items-end">
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-400">{"名称"}</label>
                <input value={poolName} onChange={(e) => setPoolName(e.target.value)} placeholder="广东4号" className="border border-gray-200 rounded-lg px-3 py-2 text-sm w-36" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-400">{"编号"}</label>
                <input value={poolCode} onChange={(e) => setPoolCode(e.target.value)} placeholder="GD-4" className="border border-gray-200 rounded-lg px-3 py-2 text-sm w-28" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-400">{"区域"}</label>
                <input value={poolRegion} onChange={(e) => setPoolRegion(e.target.value)} placeholder="guangdong" className="border border-gray-200 rounded-lg px-3 py-2 text-sm w-32" />
              </div>
              <button onClick={handleAddPool} className="flex items-center gap-1.5 bg-blue-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-600 transition-colors cursor-pointer">
                <Plus className="w-4 h-4" />{"创建"}
              </button>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <div className="text-sm font-medium text-gray-600 mb-3">{"号池列表"}</div>
            <div className="space-y-2">
              {pools.map((p) => (
                <div key={p.id} className="flex items-center justify-between py-2.5 px-3 border border-gray-100 rounded-lg">
                  <div className="flex items-center gap-3">
                    <span className={`w-2 h-2 rounded-full ${p.status === "online" ? "bg-green-500" : "bg-red-400"}`} />
                    <span className="font-medium text-sm">{p.name}</span>
                    <span className="text-xs text-gray-400">{p.code}</span>
                    <span className="text-xs text-gray-400">{p.region}</span>
                    <span className="text-xs text-gray-400">{p.latency_ms}ms</span>
                  </div>
                  <button onClick={() => handleDeletePool(p.id)} className="p-1.5 rounded-lg hover:bg-red-50 cursor-pointer">
                    <Trash2 className="w-4 h-4 text-red-400" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Tab: Users */}
      {tab === "users" && (
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="text-sm font-medium text-gray-600 mb-3">
            {"用户列表"} <span className="text-gray-400 font-normal">({users.length} 人)</span>
          </div>
          <div className="overflow-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-400 border-b border-gray-100">
                  <th className="pb-2 font-medium">ID</th>
                  <th className="pb-2 font-medium">{"用户名"}</th>
                  <th className="pb-2 font-medium">{"邮箱"}</th>
                  <th className="pb-2 font-medium">{"角色"}</th>
                  <th className="pb-2 font-medium">{"订阅"}</th>
                  <th className="pb-2 font-medium">{"积分"}</th>
                  <th className="pb-2 font-medium">{"注册时间"}</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className="border-b border-gray-50">
                    <td className="py-2 text-gray-400">{u.id}</td>
                    <td className="py-2 font-medium text-gray-800">{u.username}</td>
                    <td className="py-2 text-gray-500">{u.email}</td>
                    <td className="py-2">
                      <span className={`text-xs px-2 py-0.5 rounded ${u.role === "admin" ? "bg-red-100 text-red-600" : "bg-gray-100 text-gray-500"}`}>
                        {u.role}
                      </span>
                    </td>
                    <td className="py-2 text-gray-500">{u.subscription}</td>
                    <td className="py-2 text-gray-500">{u.credits}</td>
                    <td className="py-2 text-gray-400 text-xs">{u.created_at}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Tab: Announcements */}
      {tab === "announcements" && (
        <div className="space-y-4">
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <div className="text-sm font-medium text-gray-600 mb-3">{"发布公告"}</div>
            <div className="flex flex-col gap-3">
              <input value={annTitle} onChange={(e) => setAnnTitle(e.target.value)} placeholder="公告标题" className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
              <textarea value={annContent} onChange={(e) => setAnnContent(e.target.value)} placeholder="公告内容..." rows={3} className="border border-gray-200 rounded-lg px-3 py-2 text-sm resize-none" />
              <button onClick={handleAddAnnouncement} className="self-start flex items-center gap-1.5 bg-blue-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-600 transition-colors cursor-pointer">
                <Plus className="w-4 h-4" />{"发布"}
              </button>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <div className="text-sm font-medium text-gray-600 mb-3">{"公告列表"}</div>
            <div className="space-y-2">
              {announcements.map((a) => (
                <div key={a.id} className="flex items-start justify-between py-2.5 px-3 border border-gray-100 rounded-lg">
                  <div>
                    <div className="text-sm font-medium text-gray-800">{a.title}</div>
                    <div className="text-xs text-gray-500 mt-0.5">{a.content}</div>
                    <div className="text-xs text-gray-400 mt-1">{a.created_at}</div>
                  </div>
                  <button onClick={() => handleDeleteAnnouncement(a.id)} className="p-1.5 rounded-lg hover:bg-red-50 cursor-pointer shrink-0">
                    <Trash2 className="w-4 h-4 text-red-400" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
