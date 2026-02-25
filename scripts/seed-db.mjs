import Database from "better-sqlite3";
import fs from "node:fs";

if (!fs.existsSync("data")) fs.mkdirSync("data", { recursive: true });
const db = new Database("data/wind.db");

db.prepare("UPDATE users SET role = 'admin' WHERE id = 1").run();
console.log("admin role set");

const pools = [
  ["广东1号", "GD-1", "pool-key-gd1", "guangdong", "39.97.51.119", "online"],
  ["广东2号", "GD-2", "pool-key-gd2", "guangdong", "39.97.51.119", "online"],
  ["广东3号", "GD-3", "pool-key-gd3", "guangdong", "39.97.51.119", "online"],
  ["上海1号", "SH-1", "pool-key-sh1", "shanghai", "39.97.51.119", "online"],
];

for (const [name, code, apiKey, region, ip, status] of pools) {
  try {
    db.prepare(
      "INSERT INTO pools (name, code, api_key, region, upstream_ip, status) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(name, code, apiKey, region, ip, status);
    console.log(`pool created: ${name}`);
  } catch (e) {
    console.log(`pool ${name} exists: ${e.message}`);
  }
}

try {
  db.prepare("INSERT INTO announcements (title, content) VALUES (?, ?)").run(
    "系统上线通知",
    "Wind 服务已上线，请选择号池后点击「运行切号」开始使用。"
  );
  console.log("announcement created");
} catch (e) {
  console.log("announcement exists:", e.message);
}

db.close();
console.log("seed done");
