import { useState, useEffect } from "react";
import { Routes, Route, Navigate, useNavigate } from "react-router-dom";
import { api } from "./api";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Subscription from "./pages/Subscription";
import GetSubscription from "./pages/GetSubscription";
import Admin from "./pages/Admin";
import Sidebar from "./components/Sidebar";

export default function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem("wind_token");
    if (token) {
      api.me().then((u) => { setUser(u); setLoading(false); }).catch(() => {
        localStorage.removeItem("wind_token");
        setLoading(false);
      });
    } else {
      setLoading(false);
    }
  }, []);

  const handleLogin = (token, userData) => {
    localStorage.setItem("wind_token", token);
    setUser(userData);
  };

  const handleLogout = () => {
    localStorage.removeItem("wind_token");
    setUser(null);
  };

  if (loading) {
    return <div className="flex items-center justify-center min-h-screen"><div className="text-gray-400">Loading...</div></div>;
  }

  if (!user) {
    return <Login onLogin={handleLogin} />;
  }

  return (
    <div className="flex h-screen bg-gray-50">
      <Sidebar user={user} onLogout={handleLogout} />
      <main className="flex-1 overflow-auto p-8">
        <Routes>
          <Route path="/" element={<Dashboard user={user} setUser={setUser} />} />
          <Route path="/subscription" element={<Subscription user={user} setUser={setUser} />} />
          <Route path="/get-subscription" element={<GetSubscription user={user} setUser={setUser} />} />
          {user.role === "admin" && <Route path="/admin" element={<Admin user={user} />} />}
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>
    </div>
  );
}
