import { NavLink } from "react-router-dom";
import { LayoutDashboard, CreditCard, ShoppingCart, LogOut, Zap, Shield } from "lucide-react";

const NAV_ITEMS = [
  { to: "/", icon: LayoutDashboard, label: "\u4eea\u8868\u76d8" },
  { to: "/subscription", icon: CreditCard, label: "\u6211\u7684\u8ba2\u9605" },
  { to: "/get-subscription", icon: ShoppingCart, label: "\u83b7\u53d6\u8ba2\u9605" },
];

export default function Sidebar({ user, onLogout }) {
  return (
    <aside className="w-44 bg-white border-r border-gray-200 flex flex-col h-full">
      <div className="p-4 border-b border-gray-100">
        <div className="flex items-center gap-2">
          <Zap className="w-5 h-5 text-blue-500" />
          <span className="text-lg font-bold text-blue-600">Wind</span>
        </div>
      </div>

      <nav className="flex-1 py-2">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            className={({ isActive }) =>
              `flex items-center gap-3 px-4 py-2.5 mx-2 rounded-lg text-sm transition-colors ${
                isActive
                  ? "bg-blue-50 text-blue-600 font-medium"
                  : "text-gray-600 hover:bg-gray-50"
              }`
            }
          >
            <item.icon className="w-4 h-4" />
            {item.label}
          </NavLink>
        ))}
        {user.role === "admin" && (
          <NavLink
            to="/admin"
            className={({ isActive }) =>
              `flex items-center gap-3 px-4 py-2.5 mx-2 rounded-lg text-sm transition-colors ${
                isActive
                  ? "bg-red-50 text-red-600 font-medium"
                  : "text-gray-600 hover:bg-gray-50"
              }`
            }
          >
            <Shield className="w-4 h-4" />
            {"\u7ba1\u7406"}
          </NavLink>
        )}
      </nav>

      <div className="p-4 border-t border-gray-100">
        <div className="text-sm font-medium text-gray-800">{user.username}</div>
        <button
          onClick={onLogout}
          className="flex items-center gap-1 text-xs text-blue-500 hover:text-blue-700 mt-1 cursor-pointer"
        >
          <LogOut className="w-3 h-3" />
          {"\u9000\u51fa\u767b\u5f55"}
        </button>
      </div>
    </aside>
  );
}
