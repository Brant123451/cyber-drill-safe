/**
 * Windsurf 试用号自动注册系统
 *
 * 完整流程：
 *   1. 生成随机邮箱 + 用户名
 *   2. Puppeteer 打开 windsurf.com/windsurf/signup 完成注册
 *   3. 提取 Firebase ID Token
 *   4. 调用 RegisterUser RPC 获取 API Key
 *   5. 写入账号池
 *
 * 用法：
 *   node scripts/windsurf-registrar.js register              # 注册单个试用号
 *   node scripts/windsurf-registrar.js register --headful     # 有头模式（调试）
 *   node scripts/windsurf-registrar.js batch --count 5        # 批量注册 5 个
 *   node scripts/windsurf-registrar.js batch --count 10 --delay 30  # 每个间隔30秒
 *   node scripts/windsurf-registrar.js status                 # 查看账号池状态
 *
 * 环境要求：
 *   npm install puppeteer puppeteer-extra puppeteer-extra-plugin-stealth
 *
 * 逆向工程数据来源：
 *   - 注册端点：https://register.windsurf.com
 *   - 服务名：exa.seat_management_pb.SeatManagementService
 *   - RPC: CreateFbUser(email, password, turnstile_token, first_name, last_name) → uid
 *   - RPC: RegisterUser(firebase_id_token) → apiKey, name, apiServerUrl
 *   - OAuth: client_id=3GUryQ7ldAeKEuD2obYnppsnmj58eP5u
 *   - 网站：https://windsurf.com/windsurf/signup
 *   - CAPTCHA：Cloudflare Turnstile
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import https from "node:https";
import http from "node:http";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");

// 加载 .env 文件
function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith("#")) continue;
    const eqIdx = text.indexOf("=");
    if (eqIdx < 0) continue;
    const key = text.substring(0, eqIdx).trim();
    const val = text.substring(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = val;
  }
}
loadEnvFile(path.join(PROJECT_ROOT, ".env"));

// Windows: chrome-launcher 清理临时文件时可能触发 EPERM，忽略此错误
process.on("uncaughtException", (err) => {
  if (err.code === "EPERM" && err.path && err.path.includes("lighthouse")) {
    // 忽略 chrome-launcher 临时文件清理错误
    return;
  }
  console.error("[FATAL]", err);
  process.exit(1);
});

// ============================================================
// 配置
// ============================================================

const CONFIG = {
  // Windsurf OAuth 配置（从 extension.js 逆向提取）
  clientId: "3GUryQ7ldAeKEuD2obYnppsnmj58eP5u",
  website: "https://windsurf.com",
  registerServer: "https://register.windsurf.com",
  webBackend: "https://windsurf.com",
  apiServer: "https://server.codeium.com",

  // RPC 路径（web 端用 /_backend/ 前缀）
  rpcCreateFbUser:
    "/_backend/exa.seat_management_pb.SeatManagementService/CreateFbUser",
  rpcRegisterUser:
    "/_backend/exa.seat_management_pb.SeatManagementService/RegisterUser",
  rpcSendEmailVerification:
    "/_backend/exa.seat_management_pb.SeatManagementService/SendEmailVerification",

  // 注册页面 URL 模板
  get signupUrl() {
    const state = crypto.randomUUID();
    const params = new URLSearchParams([
      ["response_type", "token"],
      ["client_id", this.clientId],
      ["redirect_uri", "show-auth-token"],
      ["state", state],
      ["prompt", "login"],
      ["redirect_parameters_type", "query"],
      ["workflow", ""],
    ]);
    return `${this.website}/windsurf/signup?${params.toString()}`;
  },

  // 账号池文件
  accountsFile: path.join(PROJECT_ROOT, "config", "windsurf-accounts.json"),
  sessionsFile: path.join(PROJECT_ROOT, "config", "sessions.json"),

  // 默认密码（批量注册用）
  defaultPassword: "Ws@Trial2026!",

  // CapSolver 配置（Turnstile 自动解题）
  capsolverApiKey: process.env.CAPSOLVER_API_KEY || "",
  capsolverEndpoint: "https://api.capsolver.com",

  // 2Captcha 配置（hCaptcha 解题，已停用）
  twoCaptchaApiKey: process.env.TWOCAPTCHA_API_KEY || "",

  // CapMonster Cloud 配置（hCaptcha 解题，替代 2Captcha/CapSolver）
  capmonsterApiKey: process.env.CAPMONSTER_API_KEY || "",
  capmonsterEndpoint: "https://api.capmonster.cloud",

  // Firebase API Key（从页面自动提取，或手动设置）
  firebaseApiKey: process.env.FIREBASE_API_KEY || "",

  // 已知 Turnstile sitekey（备选，页面自动提取优先）
  turnstileSitekey: "0x4AAAAAAA447Bur1xJStKg5",

  // IMAP 邮箱配置（用于读取验证码）
  // 支持 Gmail 和 QQ 邮箱：
  //   Gmail:  IMAP_USER=xxx@gmail.com  IMAP_PASS=应用专用密码
  //   QQ邮箱: IMAP_USER=xxx@qq.com    IMAP_PASS=授权码
  //   QQ邮箱授权码获取: 设置→账户→POP3/IMAP服务→开启→生成授权码
  // 也兼容旧变量名 GMAIL_USER / GMAIL_APP_PASSWORD
  imapUser: process.env.IMAP_USER || process.env.GMAIL_USER || "",
  imapPass: process.env.IMAP_PASS || process.env.GMAIL_APP_PASSWORD || "",
  get imapHost() {
    const user = this.imapUser;
    if (user.endsWith("@qq.com") || user.endsWith("@foxmail.com")) return "imap.qq.com";
    if (user.endsWith("@163.com")) return "imap.163.com";
    if (user.endsWith("@126.com")) return "imap.126.com";
    if (user.endsWith("@outlook.com") || user.endsWith("@hotmail.com")) return "imap-mail.outlook.com";
    return "imap.gmail.com";
  },
  imapPort: 993,

  // 虚拟信用卡 (VCC) 配置 —— Pro Trial 绑卡用
  // 格式: VCC_CARDS='4242424242424242,12/30,123,10001;4000...' (分号分隔多张卡)
  // 或单卡: VCC_CARD_NUMBER, VCC_CARD_EXPIRY, VCC_CARD_CVC, VCC_CARD_ZIP
  vccCards: (process.env.VCC_CARDS || "").split(";").filter(Boolean).map(c => {
    const [number, expiry, cvc, zip] = c.split(",").map(s => s.trim());
    return { number, expiry, cvc, zip: zip || "10001" };
  }),
  get vccSingleCard() {
    if (this.vccCards.length > 0) return this.vccCards[0];
    const num = process.env.VCC_CARD_NUMBER || "";
    if (!num) return null;
    return {
      number: num,
      expiry: process.env.VCC_CARD_EXPIRY || "12/30",
      cvc: process.env.VCC_CARD_CVC || "123",
      zip: process.env.VCC_CARD_ZIP || "10001",
    };
  },
  // 已使用的 VCC 索引追踪文件
  vccUsageFile: path.join(PROJECT_ROOT, "config", "vcc-usage.json"),

  // Pro Trial 相关 URL
  pricingUrl: "https://windsurf.com/pricing",
  manageSubscriptionUrl: "https://windsurf.com/subscription/manage-plan",
  cancelSubscriptionUrl: "https://windsurf.com/subscription/cancel",
  loginUrl: "https://windsurf.com/account/login",

  // 试用取消提前天数（到期前 N 天自动取消）
  cancelBeforeDays: parseInt(process.env.CANCEL_BEFORE_DAYS || "2"),

  // Buvei 虚拟信用卡平台配置
  buveiEmail: process.env.BUVEI_EMAIL || "15988621875@163.com",
  buveiPassword: process.env.BUVEI_PASSWORD || "",
  buveiPayPin: process.env.BUVEI_PAY_PIN || "", // 6 位支付密码
  buveiBaseUrl: "https://app.buvei.com",
  buveiDefaultBalance: parseFloat(process.env.BUVEI_DEFAULT_BALANCE || "10"), // 每张卡 Card balance（最低 $10）
  buveiDefaultQuantity: parseInt(process.env.BUVEI_DEFAULT_QUANTITY || "1"), // 每次开卡数量

  // 域名自动购买配置
  dynadotApiKey: process.env.DYNADOT_API_KEY || "",
  cloudflareApiToken: process.env.CLOUDFLARE_API_TOKEN || "",
  cloudflareAccountId: process.env.CLOUDFLARE_ACCOUNT_ID || "",
  domainsFile: path.join(PROJECT_ROOT, "config", "domains.json"),
};

// ============================================================
// 随机身份生成器
// ============================================================

const FIRST_NAMES = [
  "James", "Mary", "Robert", "Patricia", "John", "Jennifer", "Michael", "Linda",
  "David", "Elizabeth", "William", "Barbara", "Richard", "Susan", "Joseph", "Jessica",
  "Thomas", "Sarah", "Charles", "Karen", "Christopher", "Lisa", "Daniel", "Nancy",
  "Matthew", "Betty", "Anthony", "Margaret", "Mark", "Sandra", "Donald", "Ashley",
  "Steven", "Dorothy", "Paul", "Kimberly", "Andrew", "Emily", "Joshua", "Donna",
  "Kenneth", "Michelle", "Kevin", "Carol", "Brian", "Amanda", "George", "Melissa",
  "Timothy", "Deborah", "Ronald", "Stephanie", "Edward", "Rebecca", "Jason", "Sharon",
  "Jeffrey", "Laura", "Ryan", "Cynthia", "Jacob", "Kathleen", "Gary", "Amy",
  "Nicholas", "Angela", "Eric", "Shirley", "Jonathan", "Anna", "Stephen", "Brenda",
  "Larry", "Pamela", "Justin", "Emma", "Scott", "Nicole", "Brandon", "Helen",
  "Benjamin", "Samantha", "Samuel", "Katherine", "Raymond", "Christine", "Gregory", "Debra",
  "Frank", "Rachel", "Alexander", "Carolyn", "Patrick", "Janet", "Jack", "Catherine",
];

const LAST_NAMES = [
  "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis",
  "Rodriguez", "Martinez", "Hernandez", "Lopez", "Gonzalez", "Wilson", "Anderson",
  "Thomas", "Taylor", "Moore", "Jackson", "Martin", "Lee", "Perez", "Thompson",
  "White", "Harris", "Sanchez", "Clark", "Ramirez", "Lewis", "Robinson", "Walker",
  "Young", "Allen", "King", "Wright", "Scott", "Torres", "Nguyen", "Hill", "Flores",
  "Green", "Adams", "Nelson", "Baker", "Hall", "Rivera", "Campbell", "Mitchell",
  "Carter", "Roberts", "Gomez", "Phillips", "Evans", "Turner", "Diaz", "Parker",
  "Cruz", "Edwards", "Collins", "Reyes", "Stewart", "Morris", "Morales", "Murphy",
  "Cook", "Rogers", "Gutierrez", "Ortiz", "Morgan", "Cooper", "Peterson", "Bailey",
  "Reed", "Kelly", "Howard", "Ramos", "Kim", "Cox", "Ward", "Richardson", "Watson",
  "Brooks", "Chavez", "Wood", "James", "Bennett", "Gray", "Mendoza", "Ruiz", "Hughes",
  "Price", "Alvarez", "Castillo", "Sanders", "Patel", "Myers", "Long", "Ross", "Foster",
];

const EMAIL_DOMAINS = ["gmail.com", "outlook.com", "yahoo.com", "qq.com", "hotmail.com"];

// ============================================================
// Gmail IMAP 邮箱验证（用 +alias 批量注册，IMAP 读取验证码）
// ============================================================

// ============================================================
// 域名自动购买 & 配置（Namesilo + Cloudflare Email Routing）
// ============================================================

function loadDomains() {
  try {
    if (fs.existsSync(CONFIG.domainsFile)) {
      return JSON.parse(fs.readFileSync(CONFIG.domainsFile, "utf8"));
    }
  } catch {}
  return { domains: [] };
}

function saveDomains(data) {
  const dir = path.dirname(CONFIG.domainsFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG.domainsFile, JSON.stringify(data, null, 2));
}

// 通用 HTTPS JSON 请求
function httpsJson(method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      headers: { "Content-Type": "application/json", ...headers },
    };
    if (data) opts.headers["Content-Length"] = Buffer.byteLength(data);

    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, data: raw }); }
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// Dynadot API请求 (api3 JSON 格式)
function dynadotApi(command, params = {}) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams({
      key: CONFIG.dynadotApiKey, command, ...params,
    });
    const url = `https://api.dynadot.com/api3.json?${qs.toString()}`;
    https.get(url, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        try { resolve(JSON.parse(raw)); }
        catch { resolve({ error: raw }); }
      });
    }).on("error", reject);
  });
}

// 生成随机域名
function generateDomainName() {
  const words = ["mail", "box", "note", "fast", "sky", "net", "hub", "run", "go", "one",
    "web", "app", "dev", "lab", "pro", "zen", "air", "bit", "log", "tap",
    "mix", "pin", "dot", "jet", "fox", "owl", "bee", "elm", "oak", "bay"];
  const w1 = words[Math.floor(Math.random() * words.length)];
  const w2 = words[Math.floor(Math.random() * words.length)];
  const num = Math.floor(Math.random() * 900) + 100;
  return `${w1}${w2}${num}.top`;
}

// Dynadot: 检查域名可用性
async function dynadotCheckAvailability(domain) {
  const res = await dynadotApi("search", { domain0: domain, show_price: "1" });
  const sr = res.SearchResponse;
  if (!sr || String(sr.ResponseCode) !== "0") {
    return { available: false, error: sr?.ResponseMessage || JSON.stringify(res) };
  }
  const result = Array.isArray(sr.SearchResults) ? sr.SearchResults[0] : sr.SearchResults;
  if (!result) return { available: false, error: "no result" };
  const avail = String(result.Available).toLowerCase() === "yes";
  return { available: avail, price: result.Price };
}

// Dynadot: 注册域名
async function dynadotRegister(domain) {
  const res = await dynadotApi("register", { domain, duration: "1" });
  const rr = res.RegisterResponse;
  if (rr && String(rr.ResponseCode) === "0") {
    return { success: true, domain };
  }
  return { success: false, error: rr?.ResponseMessage || JSON.stringify(res) };
}

// Dynadot: 更新 Nameservers
async function dynadotChangeNS(domain, ns1, ns2) {
  const res = await dynadotApi("set_ns", { domain, ns0: ns1, ns1: ns2 });
  const sr = res.SetNsResponse;
  const ok = sr && String(sr.ResponseCode) === "0";
  return { success: ok, detail: sr?.ResponseMessage || JSON.stringify(res) };
}

// Cloudflare API 请求
async function cloudflareApi(method, endpoint, body) {
  const url = `https://api.cloudflare.com/client/v4${endpoint}`;
  return httpsJson(method, url, body, {
    Authorization: `Bearer ${CONFIG.cloudflareApiToken}`,
  });
}

// Cloudflare: 添加域名
async function cloudflareAddZone(domain) {
  const res = await cloudflareApi("POST", "/zones", {
    name: domain,
    account: { id: CONFIG.cloudflareAccountId },
    type: "full",
  });
  if (res.data?.success) {
    const zone = res.data.result;
    return {
      success: true,
      zoneId: zone.id,
      nameServers: zone.name_servers,
    };
  }
  // 如果域名已存在，尝试获取
  if (res.data?.errors?.[0]?.code === 1061) {
    const existing = await cloudflareApi("GET", `/zones?name=${domain}`);
    if (existing.data?.result?.[0]) {
      const zone = existing.data.result[0];
      return { success: true, zoneId: zone.id, nameServers: zone.name_servers, existing: true };
    }
  }
  return { success: false, error: JSON.stringify(res.data?.errors || res.data) };
}

// Cloudflare: 设置 Email Routing catch-all
async function cloudflareSetupEmailRouting(zoneId, forwardTo) {
  // 1. 启用 Email Routing
  const enableRes = await cloudflareApi("POST", `/zones/${zoneId}/email/routing/enable`, {});
  if (enableRes.data?.success) {
    console.log(`[domain]   Email Routing 已启用`);
  } else {
    console.log(`[domain]   Email Routing 启用: ${JSON.stringify(enableRes.data?.errors || enableRes.status)}`);
  }

  // 2. 添加目标邮箱（account 级别接口）
  const addrRes = await cloudflareApi("POST",
    `/accounts/${CONFIG.cloudflareAccountId}/email/routing/addresses`,
    { email: forwardTo });
  if (addrRes.data?.success) {
    console.log(`[domain]   目标邮箱已添加（可能需要验证）`);
  } else {
    // 可能已经添加过
    const errCode = addrRes.data?.errors?.[0]?.code;
    if (errCode === 1032) {
      console.log(`[domain]   目标邮箱已存在，跳过`);
    } else {
      console.log(`[domain]   添加目标邮箱: ${JSON.stringify(addrRes.data?.errors || addrRes.status)}`);
    }
  }

  // 3. 设置 catch-all 规则（专用端点）
  const ruleRes = await cloudflareApi("PUT", `/zones/${zoneId}/email/routing/rules/catch_all`, {
    actions: [{ type: "forward", value: [forwardTo] }],
    matchers: [{ type: "all" }],
    enabled: true,
    name: "Catch-all forward",
  });

  return {
    success: ruleRes.data?.success || false,
    detail: ruleRes.data?.errors || "ok",
  };
}

// 完整流程：购买域名 + 配置邮件转发
async function provisionDomain() {
  if (!CONFIG.dynadotApiKey) throw new Error("需要 DYNADOT_API_KEY");
  if (!CONFIG.cloudflareApiToken) throw new Error("需要 CLOUDFLARE_API_TOKEN");
  if (!CONFIG.cloudflareAccountId) throw new Error("需要 CLOUDFLARE_ACCOUNT_ID");

  // 1. 找一个可用域名
  let domain = null;
  for (let i = 0; i < 10; i++) {
    const candidate = generateDomainName();
    console.log(`[domain] 检查: ${candidate}...`);
    const avail = await dynadotCheckAvailability(candidate);
    if (avail.available) {
      domain = candidate;
      console.log(`[domain] ✓ 可用: ${domain} ($${avail.price || "?"})`);
      break;
    }
    console.log(`[domain] ✗ 已注册`);
  }
  if (!domain) throw new Error("未找到可用域名（尝试 10 次）");

  // 2. 注册域名
  console.log(`[domain] 注册: ${domain}...`);
  const regResult = await dynadotRegister(domain);
  if (!regResult.success) throw new Error(`注册失败: ${regResult.error}`);
  console.log(`[domain] ✓ 注册成功`);

  // 3. 添加到 Cloudflare
  console.log(`[domain] 添加到 Cloudflare...`);
  const cfZone = await cloudflareAddZone(domain);
  if (!cfZone.success) throw new Error(`Cloudflare 添加失败: ${cfZone.error}`);
  console.log(`[domain] ✓ Cloudflare zone: ${cfZone.zoneId}`);
  console.log(`[domain]   NS: ${cfZone.nameServers.join(", ")}`);

  // 4. 更新 Namesilo 的 NS 指向 Cloudflare
  console.log(`[domain] 更新 Nameservers...`);
  const nsResult = await dynadotChangeNS(domain, cfZone.nameServers[0], cfZone.nameServers[1]);
  if (!nsResult.success) console.log(`[domain] ⚠ NS 更新可能失败: ${nsResult.detail}`);
  else console.log(`[domain] ✓ NS 已更新`);

  // 5. 添加 MX 记录（Cloudflare Email Routing 需要）
  console.log(`[domain] 添加 MX 记录...`);
  for (let i = 1; i <= 3; i++) {
    const mx = `route${i}.mx.cloudflare.net`;
    const mxRes = await cloudflareApi("POST", `/zones/${cfZone.zoneId}/dns_records`, {
      type: "MX", name: "@", content: mx, priority: i * 10, ttl: 1,
    });
    if (!mxRes.data?.success) {
      console.log(`[domain]   ⚠ MX ${mx}: ${JSON.stringify(mxRes.data?.errors?.[0]?.message || mxRes.status)}`);
    }
  }
  // SPF 记录
  await cloudflareApi("POST", `/zones/${cfZone.zoneId}/dns_records`, {
    type: "TXT", name: "@", content: "v=spf1 include:_spf.mx.cloudflare.net ~all", ttl: 1,
  });
  console.log(`[domain] ✓ MX + SPF 记录已添加`);

  // 6. 设置 Email Routing
  const forwardTo = CONFIG.imapUser;
  console.log(`[domain] 配置 Email Routing → ${forwardTo}...`);
  const emailResult = await cloudflareSetupEmailRouting(cfZone.zoneId, forwardTo);
  if (!emailResult.success) {
    console.log(`[domain] ⚠ Email Routing 配置可能需要手动确认: ${JSON.stringify(emailResult.detail)}`);
  } else {
    console.log(`[domain] ✓ Email Routing 已配置`);
  }

  // 6. 保存到 domains.json
  const domainsData = loadDomains();
  domainsData.domains.push({
    domain,
    zoneId: cfZone.zoneId,
    nameServers: cfZone.nameServers,
    forwardTo,
    registeredAt: new Date().toISOString(),
    registrar: "dynadot",
    status: "active",
  });
  saveDomains(domainsData);

  console.log(`[domain] ✓ 域名已保存到 ${CONFIG.domainsFile}`);
  return domain;
}

// 获取所有可用的 catch-all 域名（来自 env + domains.json）
function getAllCatchallDomains() {
  const envDomains = (process.env.CATCHALL_DOMAINS || process.env.CATCHALL_DOMAIN || "")
    .split(",").map(d => d.trim()).filter(Boolean);
  const fileDomains = loadDomains().domains
    .filter(d => d.status === "active")
    .map(d => d.domain);
  return [...new Set([...envDomains, ...fileDomains])];
}

// Catch-all 域名配置（Cloudflare Email Routing 转发到 IMAP_USER）
// 设置: CATCHALL_DOMAIN=chuangling.online
// 效果: 随机生成 xxxx@chuangling.online → 全部转发到 IMAP_USER (QQ邮箱)
let CATCHALL_DOMAIN = process.env.CATCHALL_DOMAIN || "";
// 从所有可用域名中随机选一个
function pickCatchallDomain() {
  const all = getAllCatchallDomains();
  if (all.length > 0) return all[Math.floor(Math.random() * all.length)];
  return CATCHALL_DOMAIN || "";
}

function createImapAlias() {
  if (!CONFIG.imapUser) return null;
  const [local, domain] = CONFIG.imapUser.split("@");

  // 重新读取（daemon 模式下可能轮换）
  const currentDomain = process.env.CATCHALL_DOMAIN || pickCatchallDomain();
  // 优先使用 catch-all 域名（无限邮箱）
  if (currentDomain) {
    const prefix = `ws${randomString(10).toLowerCase()}`;
    const alias = `${prefix}@${currentDomain}`;
    console.log(`[imap] 生成 catch-all 邮箱: ${alias} → 转发到 ${CONFIG.imapUser}`);
    return { email: alias, baseEmail: CONFIG.imapUser, suffix: prefix };
  }

  // Gmail 支持 +alias
  if (domain === "gmail.com") {
    const suffix = randomString(8).toLowerCase();
    const alias = `${local}+ws${suffix}@${domain}`;
    console.log(`[imap] 生成 Gmail 别名: ${alias}`);
    return { email: alias, baseEmail: CONFIG.imapUser, suffix };
  }

  // QQ邮箱等：直接用原始邮箱（不支持别名，只能注册一个）
  console.log(`[imap] 使用原始邮箱: ${CONFIG.imapUser} (${domain} 不支持别名)`);
  return { email: CONFIG.imapUser, baseEmail: CONFIG.imapUser, suffix: null };
}

// 最小化 IMAP 客户端（纯 TLS，无需外部包）
class MiniIMAP {
  constructor(host, port) {
    this.host = host;
    this.port = port;
    this.socket = null;
    this.buffer = "";
    this.tagCounter = 0;
    this.ready = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.socket = tls.connect(this.port, this.host, { rejectUnauthorized: true }, () => {
        this.ready = true;
      });
      this.socket.setEncoding("utf8");
      this.socket.on("error", reject);

      // 等待服务器欢迎消息
      let welcomed = false;
      this.socket.on("data", (data) => {
        if (!welcomed && data.includes("OK")) {
          welcomed = true;
          resolve();
        }
        this.buffer += data;
      });

      setTimeout(() => { if (!welcomed) reject(new Error("IMAP connect timeout")); }, 10000);
    });
  }

  async command(cmd) {
    const tag = `A${++this.tagCounter}`;
    const line = `${tag} ${cmd}\r\n`;

    return new Promise((resolve, reject) => {
      this.buffer = "";
      this.socket.write(line);

      const check = () => {
        const tagLine = this.buffer.split("\n").find(l => l.startsWith(tag));
        if (tagLine) {
          if (tagLine.includes("OK")) {
            resolve(this.buffer);
          } else {
            reject(new Error(`IMAP error: ${tagLine.trim()}`));
          }
          return true;
        }
        return false;
      };

      if (check()) return;

      const onData = (data) => {
        this.buffer += data;
        if (check()) {
          this.socket.removeListener("data", onData);
          clearTimeout(timer);
        }
      };
      this.socket.on("data", onData);

      const timer = setTimeout(() => {
        this.socket.removeListener("data", onData);
        reject(new Error("IMAP command timeout"));
      }, 30000);
    });
  }

  async login(user, password) {
    return this.command(`LOGIN "${user}" "${password}"`);
  }

  async select(mailbox) {
    return this.command(`SELECT "${mailbox}"`);
  }

  async search(criteria) {
    const res = await this.command(`SEARCH ${criteria}`);
    const searchLine = res.split("\n").find(l => l.startsWith("* SEARCH"));
    if (!searchLine) return [];
    return searchLine.replace("* SEARCH", "").trim().split(/\s+/).filter(Boolean);
  }

  async fetch(uid, part) {
    return this.command(`FETCH ${uid} ${part}`);
  }

  async store(uid, action, flags) {
    return this.command(`STORE ${uid} ${action} (${flags})`);
  }

  async logout() {
    try {
      await this.command("LOGOUT");
    } catch {} finally {
      this.socket?.destroy();
    }
  }
}

async function waitForVerificationCode(emailInfo, timeoutSecs = 120) {
  // Gmail IMAP 模式
  if (emailInfo.baseEmail && CONFIG.imapPass) {
    return waitForCodeViaIMAP(emailInfo, timeoutSecs);
  }
  // mail.tm 模式（备选）
  if (emailInfo.jwt) {
    return waitForCodeViaMailTm(emailInfo, timeoutSecs);
  }
  console.log("[email] ✗ 无可用的邮箱验证方式");
  return null;
}

// IMAP 信号量：限制并发 IMAP 连接数（QQ邮箱限制 ~5 并发）
let _imapConcurrency = 0;
const _imapMaxConcurrency = 3; // 允许3个并行IMAP连接
const _imapWaiters = [];

async function acquireImapSlot() {
  while (_imapConcurrency >= _imapMaxConcurrency) {
    await new Promise(r => _imapWaiters.push(r));
  }
  _imapConcurrency++;
}

function releaseImapSlot() {
  if (_imapConcurrency > 0) _imapConcurrency--;
  if (_imapWaiters.length > 0) {
    const next = _imapWaiters.shift();
    next();
  }
}

async function waitForCodeViaIMAP(emailInfo, timeoutSecs = 120) {
  const { email } = emailInfo;
  console.log(`[gmail] 等待验证码... (IMAP, 最长 ${timeoutSecs}s)`);
  console.log(`[gmail] 目标邮箱: ${email}`);
  const startTime = Date.now();

  // 记录当前最大 UID，只检查更新的邮件（避免重试时拿到旧验证码）
  let baselineUid = 0;
  let baselineSlotAcquired = false;
  try {
    await acquireImapSlot();
    baselineSlotAcquired = true;
    const initImap = new MiniIMAP(CONFIG.imapHost, CONFIG.imapPort);
    await initImap.connect();
    await initImap.login(CONFIG.imapUser, CONFIG.imapPass);
    const selectRes = await initImap.select("INBOX");
    // 从 SELECT 响应解析 UIDNEXT（下一个将分配的 UID）
    const uidNextMatch = /UIDNEXT\s+(\d+)/i.exec(selectRes);
    if (uidNextMatch) {
      baselineUid = parseInt(uidNextMatch[1]) - 1;
    }
    await initImap.logout();
    console.log(`[imap] 基线 UID: ${baselineUid}`);
  } catch (err) {
    console.log(`[imap] 获取基线 UID 失败: ${err.message}`);
  } finally {
    if (baselineSlotAcquired) releaseImapSlot();
  }

  while (Date.now() - startTime < timeoutSecs * 1000) {
    // 获取 IMAP 信号量（避免并行时 QQ 邮箱连接数超限）
    await acquireImapSlot();
    let imap;
    try {
      imap = new MiniIMAP(CONFIG.imapHost, CONFIG.imapPort);
      await imap.connect();
      await imap.login(CONFIG.imapUser, CONFIG.imapPass);
      await imap.select("INBOX");

      // 搜索 Windsurf/Codeium 发来的验证邮件
      const toAddr = email.toLowerCase();
      // 搜索策略：同时匹配 FROM + TO，避免读到旧邮件
      // catch-all 转发后，邮件的 TO 字段仍是原始地址（如 xxx@chuangling.online）
      let uids = await imap.search(`UNSEEN FROM "windsurf" TO "${toAddr}"`).catch(() => []);
      if (uids.length === 0) {
        uids = await imap.search(`UNSEEN FROM "codeium" TO "${toAddr}"`).catch(() => []);
      }
      if (uids.length === 0) {
        // 退回：只按 FROM 搜索（非 catch-all 模式，或转发后 TO 被改写）
        uids = await imap.search(`UNSEEN FROM "windsurf"`).catch(() => []);
      }
      if (uids.length === 0) {
        uids = await imap.search(`UNSEEN FROM "codeium"`).catch(() => []);
      }
      // 过滤掉基线之前的旧邮件
      if (baselineUid > 0) {
        const newer = uids.filter(u => Number(u) > baselineUid);
        // 兜底：有时验证码邮件在记录 baseline 前已到达，会被 strict baseline 过滤掉
        // 这种情况下回退检查最新 3 封，后续再用 Date 头过滤旧邮件
        uids = newer.length > 0 ? newer : uids.slice(-3);
      }
      console.log(`[imap] 找到 ${uids.length} 封新邮件 (目标: ${toAddr}, baseline>${baselineUid})`);

      if (uids.length > 0) {
        // 从最新的开始检查（并行模式下扫描更多邮件）
        for (let mi = uids.length - 1; mi >= Math.max(0, uids.length - 10); mi--) {
          const uid = uids[mi];
          // 获取完整邮件（包含 headers + body）
          const fetchRes = await imap.fetch(uid, "BODY[]");

          // 过滤过旧邮件（重试同一邮箱时避免拿到历史验证码）
          const dateLine = /^Date:\s*(.+)$/mi.exec(fetchRes);
          if (dateLine) {
            const msgTs = Date.parse(dateLine[1]);
            if (Number.isFinite(msgTs) && msgTs < startTime - 15000) {
              console.log(`[imap] UID=${uid} 邮件时间过旧，跳过`);
              continue;
            }
          }

          // 简短日志
          const toMatch = fetchRes.toLowerCase().includes(toAddr);
          console.log(`[imap] UID=${uid} len=${fetchRes.length} match=${toMatch}`);

          // 检查是否是 Windsurf/Codeium 的验证邮件
          const isVerification = /windsurf|codeium|verification|verify/i.test(fetchRes);
          if (!isVerification && uids.length > 1) {
            console.log(`[imap] UID=${uid} 不是验证邮件，跳过`);
            continue;
          }

          // 检查邮件是否是发给目标地址的（避免读到旧邮件）
          const isForTarget = fetchRes.toLowerCase().includes(toAddr);
          if (!isForTarget && CATCHALL_DOMAIN) {
            console.log(`[imap] UID=${uid} 不是发给 ${toAddr} 的，跳过`);
            continue;
          }

          // 提取验证码：先找明确的验证码模式
          // Windsurf 验证码通常是 6 位数字
          // 尝试多种模式
          let code = null;

          // 模式1: "verification code is XXXXXX" 或 "code: XXXXXX"
          const pattern1 = /(?:code|verify|verification)[:\s]+(\d{6})/i.exec(fetchRes);
          if (pattern1) code = pattern1[1];

          // 模式2: HTML 中大字号显示的验证码（常见格式）
          if (!code) {
            const pattern2 = /(?:font-size|style)[^>]*>(\d{6})</i.exec(fetchRes);
            if (pattern2) code = pattern2[1];
          }

          // 模式3: 独立的 6 位数字（在验证邮件中）
          if (!code && isVerification) {
            const allCodes = fetchRes.match(/\b(\d{6})\b/g) || [];
            // 排除常见的非验证码数字（年份、端口等）
            const filtered = allCodes.filter(c => !["000000", "123456", "654321", "222222", "111111"].includes(c) && !/^20[0-9]{4}$/.test(c));
            if (filtered.length > 0) {
              code = filtered[0];
            } else if (allCodes.length > 0) {
              code = allCodes[0];
            }
          }

          if (code) {
            console.log(`[imap] ✓ 验证码: ${code} (UID=${uid})`);
            console.log(`[imap] ✓ 等待验证码耗时: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
            // 标记为已读，避免下次重复扫描
            try { await imap.store(uid, "+FLAGS", "\\Seen"); } catch {}
            await imap.logout();
            return code;
          }

          console.log(`[imap] UID=${uid} 未找到验证码`);
        }
      }

      await imap.logout();
    } catch (err) {
      console.log(`[gmail] IMAP 错误: ${err.message}`);
      try { imap?.logout(); } catch {}
    } finally {
      releaseImapSlot();
    }

    await new Promise(r => setTimeout(r, 5000));
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    if (elapsed % 15 === 0) {
      console.log(`[gmail] 等待中... (${elapsed}s)`);
    }
  }

  console.log(`[gmail] ✗ 超时未收到验证码 (耗时 ${((Date.now() - startTime) / 1000).toFixed(1)}s)`);
  return null;
}

// mail.tm 备选（保留但不作为主要方案）
function mailTmRequest(method, apiPath, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      method,
      hostname: "api.mail.tm",
      path: apiPath,
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
    };
    if (token) options.headers["Authorization"] = `Bearer ${token}`;
    if (data) options.headers["Content-Length"] = Buffer.byteLength(data);

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        try {
          resolve({ status: res.statusCode, data: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode, data: raw });
        }
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function createTempEmail() {
  console.log("[tempmail] → 获取 mail.tm 可用域名...");
  const domainsRes = await mailTmRequest("GET", "/domains");
  let domains = domainsRes.data?.["hydra:member"] || (Array.isArray(domainsRes.data) ? domainsRes.data : null);
  if (domainsRes.status !== 200 || !domains?.length) {
    console.log(`[tempmail] ✗ 获取域名失败: ${JSON.stringify(domainsRes.data).substring(0, 200)}`);
    return null;
  }
  const domain = domains[Math.floor(Math.random() * domains.length)].domain;
  const login = randomString(10).toLowerCase();
  const address = `${login}@${domain}`;
  const mailPass = "TempPass2026!";

  console.log(`[tempmail] → 创建邮箱: ${address}`);
  const createRes = await mailTmRequest("POST", "/accounts", { address, password: mailPass });
  if (createRes.status !== 201 && createRes.status !== 200) {
    console.log(`[tempmail] ✗ 创建邮箱失败 (${createRes.status}): ${JSON.stringify(createRes.data).substring(0, 200)}`);
    return null;
  }
  const tokenRes = await mailTmRequest("POST", "/token", { address, password: mailPass });
  if (!tokenRes.data?.token) {
    console.log(`[tempmail] ✗ 获取token失败: ${JSON.stringify(tokenRes.data).substring(0, 200)}`);
    return null;
  }
  console.log(`[tempmail] ✓ 邮箱已创建: ${address}`);
  return { email: address, login, domain, jwt: tokenRes.data.token };
}

async function waitForCodeViaMailTm(tempMailInfo, timeoutSecs = 120) {
  const { jwt } = tempMailInfo;
  console.log(`[tempmail] 等待验证码... (最长 ${timeoutSecs}s)`);
  const startTime = Date.now();
  let lastMsgCount = 0;

  while (Date.now() - startTime < timeoutSecs * 1000) {
    try {
      const res = await mailTmRequest("GET", "/messages", null, jwt);
      const messages = res.data?.["hydra:member"] || (Array.isArray(res.data) ? res.data : []);
      if (messages.length > lastMsgCount) {
        lastMsgCount = messages.length;
        const msg = messages[0];
        console.log(`[tempmail] 收到邮件: "${msg.subject}" from ${msg.from?.address || "?"}`);
        const fullRes = await mailTmRequest("GET", `/messages/${msg.id}`, null, jwt);
        const fullMsg = fullRes.data;
        if (fullMsg) {
          const textBody = fullMsg.text || "";
          const htmlBody = fullMsg.html?.join("") || "";
          const codeMatch = textBody.match(/\b(\d{6})\b/) || htmlBody.match(/\b(\d{6})\b/);
          if (codeMatch) {
            console.log(`[tempmail] ✓ 验证码: ${codeMatch[1]}`);
            return codeMatch[1];
          }
          console.log(`[tempmail] 邮件内容: ${textBody.substring(0, 300)}`);
        }
      }
    } catch (err) {
      console.log(`[tempmail] 轮询错误: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 5000));
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    if (elapsed % 15 === 0) console.log(`[tempmail] 等待中... (${elapsed}s)`);
  }
  console.log("[tempmail] ✗ 超时未收到验证码");
  return null;
}

function randomElement(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomString(length) {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

async function generateIdentity(useTempMail = true) {
  const firstName = randomElement(FIRST_NAMES);
  const lastName = randomElement(LAST_NAMES);
  const password = CONFIG.defaultPassword;

  if (useTempMail) {
    // 优先使用 Gmail +alias（Windsurf 不会封 Gmail 域名）
    if (CONFIG.imapUser && CONFIG.imapPass) {
      const imapInfo = createImapAlias();
      if (imapInfo) {
        return { firstName, lastName, email: imapInfo.email, password, tempMail: imapInfo };
      }
    }

    // 备选：mail.tm 临时邮箱
    const tempMail = await createTempEmail();
    if (tempMail) {
      return { firstName, lastName, email: tempMail.email, password, tempMail };
    }
    console.log("[registrar] ⚠ 邮箱创建失败，使用随机邮箱（无法自动验证）");
  }

  const emailPrefix = randomString(16 + Math.floor(Math.random() * 6));
  const emailDomain = randomElement(EMAIL_DOMAINS);
  const email = `${emailPrefix}@${emailDomain}`;
  return { firstName, lastName, email, password, tempMail: null };
}

// ============================================================
// Protobuf 编码（手工实现，不依赖外部库）
// ============================================================

function encodeVarint(value) {
  const bytes = [];
  let v = BigInt(value);
  while (v > 127n) {
    bytes.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}

function encodeString(fieldNumber, value) {
  const strBuf = Buffer.from(value, "utf8");
  const tag = encodeVarint((fieldNumber << 3) | 2);
  const len = encodeVarint(strBuf.length);
  return Buffer.concat([tag, len, strBuf]);
}

/**
 * 编码 CreateFbUserRequest
 * field 1: email (string)
 * field 2: password (string)
 * field 3: turnstile_token (string)
 * field 6: first_name (string)
 * field 7: last_name (string)
 */
function encodeCreateFbUserRequest({ email, password, turnstileToken, firstName, lastName }) {
  const parts = [
    encodeString(1, email),
    encodeString(2, password),
  ];
  if (turnstileToken) parts.push(encodeString(3, turnstileToken));
  if (firstName) parts.push(encodeString(6, firstName));
  if (lastName) parts.push(encodeString(7, lastName));
  return Buffer.concat(parts);
}

/**
 * 编码 RegisterUserRequest
 * field 1: firebase_id_token (string)
 */
function encodeRegisterUserRequest(firebaseIdToken) {
  return encodeString(1, firebaseIdToken);
}

/**
 * 将 protobuf 消息包装为 Connect Protocol 帧
 * flags(1 byte) + length(4 bytes BE) + data
 */
function wrapConnectFrame(data, compressed = false) {
  const header = Buffer.alloc(5);
  header[0] = compressed ? 0x01 : 0x00;
  header.writeUInt32BE(data.length, 1);
  return Buffer.concat([header, data]);
}

/**
 * 解析 Connect Protocol 响应帧
 */
function parseConnectFrames(buf) {
  const frames = [];
  let offset = 0;
  while (offset + 5 <= buf.length) {
    const flags = buf[offset];
    const len = buf.readUInt32BE(offset + 1);
    offset += 5;
    if (offset + len > buf.length) break;
    frames.push({ flags, data: buf.subarray(offset, offset + len) });
    offset += len;
  }
  return frames;
}

/**
 * 从 protobuf 响应中提取字符串字段
 */
function extractStringsFromProtobuf(buf) {
  const strings = [];
  let offset = 0;
  while (offset < buf.length) {
    try {
      let tag = 0;
      let shift = 0;
      let b;
      do {
        if (offset >= buf.length) return strings;
        b = buf[offset++];
        tag |= (b & 0x7f) << shift;
        shift += 7;
      } while (b & 0x80);

      const fieldNumber = tag >> 3;
      const wireType = tag & 0x07;

      switch (wireType) {
        case 0: { // varint
          do {
            if (offset >= buf.length) return strings;
            b = buf[offset++];
          } while (b & 0x80);
          break;
        }
        case 1: { // 64-bit
          offset += 8;
          break;
        }
        case 2: { // length-delimited
          let len = 0;
          shift = 0;
          do {
            if (offset >= buf.length) return strings;
            b = buf[offset++];
            len |= (b & 0x7f) << shift;
            shift += 7;
          } while (b & 0x80);

          if (offset + len > buf.length) return strings;
          const data = buf.subarray(offset, offset + len);
          offset += len;

          // Try as UTF-8 string
          const str = data.toString("utf8");
          if (/^[\x20-\x7E]+$/.test(str) && str.length > 0) {
            strings.push({ field: fieldNumber, value: str });
          }
          break;
        }
        case 5: { // 32-bit
          offset += 4;
          break;
        }
        default:
          return strings;
      }
    } catch {
      break;
    }
  }
  return strings;
}

// ============================================================
// Connect Protocol RPC 调用
// ============================================================

/**
 * 调用 Connect Protocol RPC
 */
/**
 * 调用 Web 后端 RPC（原始 protobuf，无 Connect 帧封装）
 */
async function callWebRpc(baseUrl, rpcPath, requestBody) {
  const url = new URL(rpcPath, baseUrl);

  return new Promise((resolve, reject) => {
    const body = Buffer.from(requestBody);

    const options = {
      method: "POST",
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname,
      headers: {
        "Content-Type": "application/proto",
        "Accept": "application/proto",
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
        "Origin": "https://windsurf.com",
        "Referer": "https://windsurf.com/editor/signup",
        "Content-Length": body.length,
      },
    };

    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const data = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: data,
        });
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function callConnectRpc(baseUrl, rpcPath, requestBody) {
  const url = new URL(rpcPath, baseUrl);

  return new Promise((resolve, reject) => {
    const body = wrapConnectFrame(requestBody);

    const options = {
      method: "POST",
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname,
      headers: {
        "Content-Type": "application/grpc",
        "Connect-Protocol-Version": "1",
        "Accept-Encoding": "identity",
        "User-Agent": "connect-es/2.0.0-rc.3",
        "Content-Length": body.length,
      },
    };

    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const data = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: data,
        });
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ============================================================
// 方案 C：Codeium.com 简化注册（无CAPTCHA、无邮箱验证）
// ============================================================
// 对标产品 windsurf-vip-free 的方案：
//   注册页: https://codeium.com/account/register
//   流程: 填邮箱+密码 → submit → onboarding(name→skip→skip) → 完成
//   邮箱: 2925.com 或 Gmail +alias，不需要验证

const CODEIUM_URLS = {
  register: "https://codeium.com/account/register",
  profile: "https://codeium.com/profile",
  onboardingName: "https://codeium.com/account/onboarding?page=name",
  onboardingAbout: "https://codeium.com/account/onboarding?page=about",
  onboardingSource: "https://codeium.com/account/onboarding?page=source",
};

async function registerViaCodeium(identity, options = {}) {
  const { headless = true } = options;
  const { email, password, firstName, lastName } = identity;

  let connect;
  try {
    const mod = await import("puppeteer-real-browser");
    connect = mod.connect;
  } catch {
    console.error("[registrar] ✗ 请先安装: npm install puppeteer-real-browser");
    process.exit(1);
  }

  const chromePaths = process.platform === "win32"
    ? [
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      ]
    : [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium-browser",
        "/usr/bin/chromium",
      ];
  let chromePath = process.env.CHROME_PATH || null;
  if (!chromePath) {
    for (const p of chromePaths) {
      if (fs.existsSync(p)) { chromePath = p; break; }
    }
  }

  console.log(`[codeium] 注册: ${email}`);
  console.log(`[codeium]   名字: ${firstName} ${lastName}`);
  console.log(`[codeium]   模式: ${headless ? "无头" : "有头(Xvfb)"}`);

  const { browser, page } = await connect({
    headless: false,
    turnstile: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--window-size=1280,800",
    ],
    customConfig: chromePath ? { chromePath } : {},
    fingerprint: true,
  });

  const screenshotDir = path.join(PROJECT_ROOT, "screenshots");
  fs.mkdirSync(screenshotDir, { recursive: true });

  let capturedToken = null;
  let capturedApiKey = null;

  // 监听网络响应，捕获 token
  page.on("response", async (res) => {
    const url = res.url();
    if (url.includes("identitytoolkit") || url.includes("securetoken")) {
      try {
        const body = await res.json();
        if (body.idToken) {
          capturedToken = body.idToken;
          console.log("[codeium]   ← 捕获 Firebase ID Token");
        }
      } catch {}
    }
    if (url.includes("RegisterUser") || url.includes("registerUser")) {
      try {
        const buf = await res.buffer();
        const strings = extractStringsFromProtobuf(buf);
        const apiKey = strings.find(s => s.value && s.value.length > 20 && !s.value.includes(" "));
        if (apiKey) {
          capturedApiKey = apiKey.value;
          console.log("[codeium]   ← 捕获 API Key");
        }
      } catch {}
    }
  });

  try {
    // Step 1: 打开注册页
    console.log("[codeium]   → 打开注册页...");
    await page.goto(CODEIUM_URLS.register, { waitUntil: "networkidle2", timeout: 60000 });
    await new Promise(r => setTimeout(r, 2000));
    await page.screenshot({ path: path.join(screenshotDir, `codeium-1-loaded-${Date.now()}.png`), fullPage: true });

    // 检查页面状态（是否已登录）
    const currentUrl = page.url();
    if (currentUrl.includes("/profile")) {
      console.log("[codeium]   ⚠ 已有登录态，先登出...");
      // 尝试找退出按钮
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll("button")].find(b =>
          b.textContent?.toLowerCase().includes("log out") || b.textContent?.toLowerCase().includes("sign out")
        );
        if (btn) btn.click();
      });
      await new Promise(r => setTimeout(r, 3000));
      await page.goto(CODEIUM_URLS.register, { waitUntil: "networkidle2", timeout: 60000 });
      await new Promise(r => setTimeout(r, 2000));
    }

    // Step 2: 填写注册表单
    console.log("[codeium]   → 填写注册表单...");

    // 先诊断页面上有哪些元素
    const pageInfo = await page.evaluate(() => {
      const inputs = [...document.querySelectorAll("input")].map(e => ({
        type: e.type, name: e.name, id: e.id, placeholder: e.placeholder,
        visible: e.offsetParent !== null,
      }));
      const buttons = [...document.querySelectorAll("button")].map(e => ({
        text: e.textContent?.trim().substring(0, 40), type: e.type, visible: e.offsetParent !== null,
      }));
      const headings = [...document.querySelectorAll("h1,h2,h3")].map(e => e.textContent?.trim());
      const bodyText = (document.body?.innerText || "").substring(0, 500);
      return { inputs, buttons, headings, bodyText, url: location.href };
    });
    console.log(`[codeium]   页面 URL: ${pageInfo.url}`);
    console.log(`[codeium]   标题: ${JSON.stringify(pageInfo.headings)}`);
    console.log(`[codeium]   输入框: ${pageInfo.inputs.filter(i => i.visible).map(i => `${i.type}:${i.name||i.id||i.placeholder}`).join(", ") || "无"}`);
    console.log(`[codeium]   按钮: ${pageInfo.buttons.filter(b => b.visible).map(b => b.text).join(", ") || "无"}`);

    // ── Step 2a: 填写第一页（姓名 + 邮箱 + Terms）──
    // 先填姓名
    const fnInput = await page.waitForSelector('input[name="firstName"]', { timeout: 5000 }).catch(() => null);
    if (fnInput) {
      await fnInput.click({ clickCount: 3 });
      await fnInput.type(firstName, { delay: 30 });
      console.log(`[codeium]   ✓ 名: ${firstName}`);
    }

    const lnInput = await page.waitForSelector('input[name="lastName"]', { timeout: 5000 }).catch(() => null);
    if (lnInput) {
      await lnInput.click({ clickCount: 3 });
      await lnInput.type(lastName, { delay: 30 });
      console.log(`[codeium]   ✓ 姓: ${lastName}`);
    }

    // 填邮箱
    const emailInput = await page.waitForSelector('input[name="email"], input[type="email"]', { timeout: 10000 }).catch(() => null);
    if (emailInput) {
      await emailInput.click({ clickCount: 3 });
      await emailInput.type(email, { delay: 30 });
      console.log(`[codeium]   ✓ 邮箱: ${email}`);
    } else {
      console.log("[codeium]   ✗ 未找到邮箱输入框");
    }

    // 勾选 Terms
    const termsChecked = await page.evaluate(() => {
      const cb = document.querySelector('#terms, #termsAccepted, input[name="agreeTOS"], input[type="checkbox"]');
      if (cb && !cb.checked) { cb.click(); return true; }
      return cb?.checked || false;
    });
    console.log(termsChecked ? "[codeium]   ✓ Terms 已勾选" : "[codeium]   ⚠ 未找到 Terms");

    await page.screenshot({ path: path.join(screenshotDir, `codeium-2a-step1-${Date.now()}.png`), fullPage: true });

    // 点击 Continue（精确匹配，不要点 "Sign up with Google"）
    console.log("[codeium]   → 点击 Continue...");
    const continueClicked = await page.evaluate(() => {
      const btns = [...document.querySelectorAll("button")];
      // 精确找只包含 "Continue" 的按钮，排除包含 "Google/GitHub/Devin" 的
      const continueBtn = btns.find(b => {
        const t = (b.textContent || "").trim();
        return t === "Continue" || (t.toLowerCase().includes("continue") && !t.toLowerCase().includes("google") && !t.toLowerCase().includes("github"));
      });
      if (continueBtn) { continueBtn.click(); return continueBtn.textContent?.trim(); }
      return null;
    });
    console.log(`[codeium]   ✓ 点击: ${continueClicked || "未找到 Continue"}`);
    await new Promise(r => setTimeout(r, 3000));

    // ── Step 2b: 第二页（密码）──
    console.log("[codeium]   → 检查 Step 2 (密码页面)...");

    // 诊断第二步页面
    const step2Info = await page.evaluate(() => {
      const inputs = [...document.querySelectorAll("input")].map(e => ({
        type: e.type, name: e.name, id: e.id, visible: e.offsetParent !== null,
      }));
      return { inputs: inputs.filter(i => i.visible), url: location.href, text: (document.body?.innerText || "").substring(0, 300) };
    });
    console.log(`[codeium]   Step 2 URL: ${step2Info.url}`);
    console.log(`[codeium]   Step 2 输入框: ${step2Info.inputs.map(i => `${i.type}:${i.name||i.id}`).join(", ") || "无"}`);

    let pwInput = await page.waitForSelector('input[name="password"], input[type="password"]', { timeout: 10000 }).catch(() => null);
    if (pwInput) {
      await pwInput.click({ clickCount: 3 });
      await pwInput.type(password, { delay: 30 });
      console.log("[codeium]   ✓ 密码");
    } else {
      console.log("[codeium]   ✗ 未找到密码输入框");
      console.log(`[codeium]   页面文本: ${step2Info.text.substring(0, 200)}`);
      await page.screenshot({ path: path.join(screenshotDir, `codeium-2b-no-pw-${Date.now()}.png`), fullPage: true });
    }

    // 确认密码
    const confirmInput = await page.waitForSelector('input[name="confirmPassword"]', { timeout: 5000 }).catch(() => null);
    if (confirmInput) {
      await confirmInput.click({ clickCount: 3 });
      await confirmInput.type(password, { delay: 30 });
      console.log("[codeium]   ✓ 确认密码");
    }

    await page.screenshot({ path: path.join(screenshotDir, `codeium-2b-filled-${Date.now()}.png`), fullPage: true });

    // Step 3: 提交（点击 Continue/Sign up/Create）
    console.log("[codeium]   → 提交注册...");
    const submitClicked = await page.evaluate(() => {
      const btns = [...document.querySelectorAll("button")];
      const btn = btns.find(b => {
        const t = (b.textContent || "").trim().toLowerCase();
        return (t === "continue" || t.includes("sign up") || t.includes("create") || t.includes("register"))
          && !t.includes("google") && !t.includes("github") && !t.includes("devin");
      });
      if (btn) { btn.click(); return btn.textContent?.trim(); }
      return null;
    });
    console.log(`[codeium]   ✓ 提交: ${submitClicked || "未找到按钮"}`);

    // 等待页面响应
    await new Promise(r => setTimeout(r, 5000));
    await page.screenshot({ path: path.join(screenshotDir, `codeium-3-submitted-${Date.now()}.png`), fullPage: true });

    // 检查是否邮箱已存在
    const pageText = await page.evaluate(() => document.body?.innerText || "");
    if (pageText.includes("already associated")) {
      console.log("[codeium]   ✗ 邮箱已被注册");
      return { email, password, firstName, lastName, status: "email_exists" };
    }

    // Step 4: Turnstile CAPTCHA ("Please verify that you are human")
    const needsCaptcha = pageText.toLowerCase().includes("verify") && pageText.toLowerCase().includes("human");
    if (needsCaptcha && CONFIG.capsolverApiKey && headless) {
      console.log("[codeium]   → Step 4: Turnstile CAPTCHA 验证");
      const sitekey = CONFIG.turnstileSitekey;
      const currentUrl = page.url();

      console.log("[codeium]   → CapSolver 解题...");
      const turnstileToken = await solveTurnstileWithCapSolver(currentUrl, sitekey);

      if (turnstileToken) {
        // 注入 fetch 拦截器：保留原始请求体，只追加 turnstile token 字段
        // Protobuf 允许重复字段（最后一个值生效），所以追加 field 3 即可
        await page.evaluate((token) => {
          window.__netCaptures = [];

          function pbString(fieldNum, str) {
            const bytes = new TextEncoder().encode(str);
            const tag = (fieldNum << 3) | 2;
            const arr = [tag];
            let len = bytes.length;
            while (len > 127) { arr.push((len & 0x7f) | 0x80); len >>= 7; }
            arr.push(len);
            return new Uint8Array([...arr, ...bytes]);
          }

          const origFetch = window.fetch;
          window.fetch = async function(...args) {
            const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "?";
            if (url.includes("SeatManagement") && args[1]?.body) {
              // 读取原始请求体
              let origBytes;
              const body = args[1].body;
              if (body instanceof ArrayBuffer) {
                origBytes = new Uint8Array(body);
              } else if (body instanceof Uint8Array) {
                origBytes = body;
              } else if (ArrayBuffer.isView(body)) {
                origBytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
              } else {
                // 如果是其他类型（string等），直接按原方式处理
                origBytes = new Uint8Array(0);
              }

              // 构建 turnstile token 字段 (field 3)
              const tokenField = pbString(3, token);

              // 追加到原始请求体末尾
              const newBody = new Uint8Array(origBytes.length + tokenField.length);
              newBody.set(origBytes, 0);
              newBody.set(tokenField, origBytes.length);
              args[1] = { ...args[1], body: newBody };

              const entry = { url: url.substring(0, 200), origSize: origBytes.length, newSize: newBody.length };
              window.__netCaptures.push(entry);
              const resp = await origFetch.apply(this, args);
              entry.status = resp.status;
              return resp;
            }
            const entry = { url: url.substring(0, 200) };
            window.__netCaptures.push(entry);
            const resp = await origFetch.apply(this, args);
            entry.status = resp.status;
            return resp;
          };
        }, turnstileToken);

        // React fiber 遍历调用 onVerify + onNext
        const injectResult = await page.evaluate((token) => {
          const results = [];
          try {
            const el = document.querySelector('[data-sitekey], .cf-turnstile, [id*="turnstile"]')
              || document.querySelector('div[style*="width: 300px"]')
              || document.querySelector('div[class*="turnstile"]');

            // 找 React fiber
            let fiber = null;
            if (el) {
              const key = Object.keys(el).find(k => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
              if (key) fiber = el[key];
            }
            if (!fiber) {
              // 从 body 遍历找
              const allDivs = document.querySelectorAll("div");
              for (const div of allDivs) {
                const key = Object.keys(div).find(k => k.startsWith("__reactFiber$"));
                if (key && div[key]?.memoizedProps?.onVerify) {
                  fiber = div[key];
                  results.push("found:onVerify_from_scan");
                  break;
                }
              }
            }

            // 找 onVerify
            let onVerify = null;
            if (fiber?.memoizedProps?.onVerify) {
              onVerify = fiber.memoizedProps.onVerify;
              results.push("found:onVerify_from_el");
            }

            // 找 onNext（向上遍历）
            let onNext = null;
            let current = fiber;
            for (let depth = 0; depth < 15 && current; depth++) {
              current = current.return;
              if (current?.memoizedProps?.onNext) {
                onNext = current.memoizedProps.onNext;
                results.push(`found:onNext@depth${depth}`);
                break;
              }
            }

            // 也尝试从按钮找
            if (!onNext) {
              const btns = [...document.querySelectorAll("button")];
              const continueBtn = btns.find(b => b.textContent?.trim() === "Continue");
              if (continueBtn) {
                const key = Object.keys(continueBtn).find(k => k.startsWith("__reactFiber$"));
                if (key) {
                  let f = continueBtn[key];
                  for (let d = 0; d < 10 && f; d++) {
                    if (f.memoizedProps?.onClick) {
                      onNext = f.memoizedProps.onClick;
                      results.push(`found:onClick_from_button@depth${d}`);
                      break;
                    }
                    f = f.return;
                  }
                }
              }
            }

            if (onVerify) { onVerify(token); results.push("called:onVerify"); }
            if (onNext) {
              setTimeout(() => onNext(), 200);
              results.push("called:onNext");
            }

            // 也直接点击 Continue 按钮作为备用
            if (!onNext) {
              const btns = [...document.querySelectorAll("button")];
              const continueBtn = btns.find(b => b.textContent?.trim() === "Continue");
              if (continueBtn) {
                setTimeout(() => continueBtn.click(), 500);
                results.push("clicked:Continue_button");
              }
            }
          } catch (e) {
            results.push(`error:${e.message}`);
          }
          return results;
        }, turnstileToken);

        console.log(`[codeium]   注入结果: ${JSON.stringify(injectResult)}`);
        await new Promise(r => setTimeout(r, 5000));

        // 检查捕获的请求
        const captures = await page.evaluate(() => window.__netCaptures || []);
        if (captures.length > 0) {
          console.log(`[codeium]   === 捕获 ${captures.length} 个网络请求 ===`);
          for (const c of captures) {
            const sizeInfo = c.origSize != null ? ` (orig=${c.origSize}→new=${c.newSize})` : "";
            console.log(`[codeium]   ${c.url} → ${c.status || "?"}${sizeInfo}`);
          }
        }

        await page.screenshot({ path: path.join(screenshotDir, `codeium-4-captcha-${Date.now()}.png`), fullPage: true });
        console.log("[codeium]   ✓ Turnstile 已处理");
      } else {
        console.log("[codeium]   ✗ CapSolver 解题失败，等待浏览器自动处理或手动点击...");
        // fallback: 等待浏览器处理 Turnstile
        for (let w = 0; w < 120; w++) {
          await new Promise(r => setTimeout(r, 1000));
          const url = page.url();
          if (url.includes("onboarding") || url.includes("profile")) {
            console.log("[codeium]   ✓ 页面已跳转（Turnstile 已通过）");
            break;
          }
          const done = await page.evaluate(() => {
            const input = document.querySelector('input[name="cf-turnstile-response"], input[name="turnstileToken"], [name*="turnstile"]');
            return input?.value ? true : false;
          });
          if (done) {
            console.log(`[codeium]   ✓ Turnstile 已完成 (${w + 1}s)`);
            break;
          }
          if (w === 10) console.log("[codeium]   → 请在浏览器中手动完成 Turnstile 验证...");
          if (w === 60) console.log("[codeium]   → 仍在等待...（最多 120s）");
        }
      }
    } else if (needsCaptcha) {
      console.log("[codeium]   ⚠ 需要 Turnstile，等待浏览器自动处理或手动点击...");
      for (let w = 0; w < 120; w++) {
        await new Promise(r => setTimeout(r, 1000));
        const url = page.url();
        if (url.includes("onboarding") || url.includes("profile")) {
          console.log("[codeium]   ✓ 页面已跳转（Turnstile 已通过）");
          break;
        }
        const done = await page.evaluate(() => {
          const input = document.querySelector('input[name="cf-turnstile-response"], input[name="turnstileToken"], [name*="turnstile"]');
          return input?.value ? true : false;
        });
        if (done) {
          console.log(`[codeium]   ✓ Turnstile 已完成 (${w + 1}s)`);
          // Turnstile 完成后点击 Continue 按钮
          await new Promise(r => setTimeout(r, 1000));
          const clicked = await page.evaluate(() => {
            const btns = [...document.querySelectorAll("button, input[type='submit']")];
            const continueBtn = btns.find(b => /continue|submit|next|verify/i.test(b.textContent?.trim()));
            if (continueBtn) { continueBtn.click(); return continueBtn.textContent?.trim(); }
            return null;
          });
          if (clicked) console.log(`[codeium]   ✓ 点击: ${clicked}`);
          break;
        }
        if (w === 10) console.log("[codeium]   → 请在浏览器中手动完成 Turnstile 验证...");
        if (w === 60) console.log("[codeium]   → 仍在等待...（最多 120s）");
      }
    }

    // 等待页面跳转
    await new Promise(r => setTimeout(r, 5000));

    // Step 5: Onboarding
    console.log("[codeium]   → 等待 Onboarding 页面...");
    let onboardingReached = false;

    for (let i = 0; i < 30; i++) {
      const url = page.url();
      if (url.includes("onboarding")) {
        onboardingReached = true;
        break;
      }
      if (url.includes("profile")) {
        console.log("[codeium]   ✓ 已跳转到 Profile（可能无 onboarding）");
        onboardingReached = true;
        break;
      }
      // 检查是否需要邮箱验证
      const text = await page.evaluate(() => (document.body?.innerText || "").toLowerCase());
      if ((text.includes("check your inbox") || text.includes("verification code")) && text.includes(email.toLowerCase().substring(0, 10))) {
        console.log("[codeium]   → 需要邮箱验证，尝试 IMAP 读取验证码...");

        // 构建 emailInfo 用于 IMAP 查询
        const emailInfo = identity.tempMail || { email, baseEmail: CONFIG.imapUser || email };

        if (CONFIG.imapUser && CONFIG.imapPass) {
          // 重发机制：如果 60s 内没收到验证码，点 Resend 再等
          let code = null;
          const maxResends = 2;
          for (let resendAttempt = 0; resendAttempt <= maxResends; resendAttempt++) {
            const waitTime = resendAttempt === 0 ? 70 : 60;
            code = await waitForVerificationCode(emailInfo, waitTime);
            if (code) break;

            if (resendAttempt < maxResends) {
              console.log(`[codeium]   ⚠ ${waitTime}s 未收到验证码，尝试 Resend (${resendAttempt + 1}/${maxResends})...`);
              const resent = await page.evaluate(() => {
                const links = [...document.querySelectorAll("a, button, span")];
                const resendEl = links.find(el => {
                  const t = (el.textContent || "").toLowerCase();
                  return t.includes("resend") || t.includes("重新发送") || t.includes("send again");
                });
                if (resendEl) { resendEl.click(); return true; }
                return false;
              });
              if (resent) {
                console.log("[codeium]   → 已点击 Resend，继续等待...");
                await new Promise(r => setTimeout(r, 3000));
              } else {
                console.log("[codeium]   ⚠ 未找到 Resend 按钮");
              }
            }
          }

          if (code) {
            console.log(`[codeium]   ✓ 获取到验证码: ${code}`);
            // 填入验证码
            const codeInputs = await page.$$('input[type="text"], input[type="number"], input[inputmode="numeric"]');
            if (codeInputs.length >= 1) {
              // 单个输入框
              if (codeInputs.length === 1) {
                await codeInputs[0].click({ clickCount: 3 });
                await codeInputs[0].type(code, { delay: 50 });
              } else {
                // 多个输入框（每格一位）
                for (let ci = 0; ci < Math.min(code.length, codeInputs.length); ci++) {
                  await codeInputs[ci].click();
                  await codeInputs[ci].type(code[ci], { delay: 30 });
                }
              }
              console.log("[codeium]   ✓ 验证码已填入");
              await new Promise(r => setTimeout(r, 500));

              // 点击 Create account / Verify / Continue
              await page.evaluate(() => {
                const btns = [...document.querySelectorAll("button")];
                const btn = btns.find(b => {
                  const t = (b.textContent || "").trim().toLowerCase();
                  return t.includes("create") || t.includes("verify") || t.includes("continue");
                });
                if (btn) btn.click();
              });
              console.log("[codeium]   → 提交验证码...");
              await new Promise(r => setTimeout(r, 5000));
              await page.screenshot({ path: path.join(screenshotDir, `codeium-5-verified-${Date.now()}.png`), fullPage: true });

              // 检查是否成功
              const newUrl = page.url();
              if (newUrl.includes("onboarding") || newUrl.includes("profile")) {
                onboardingReached = true;
              }
            } else {
              console.log("[codeium]   ✗ 未找到验证码输入框");
            }
          } else {
            console.log("[codeium]   ✗ 未获取到验证码（含重发尝试）");
          }
        } else {
          console.log("[codeium]   ✗ 未配置 IMAP (设置 IMAP_USER 和 IMAP_PASS)");
        }
        break;
      }
      await new Promise(r => setTimeout(r, 1000));
    }

    if (onboardingReached) {
      const url = page.url();

      // Name 页面
      if (url.includes("onboarding") && url.includes("name")) {
        console.log("[codeium]   → Onboarding: 填写姓名...");
        try {
          const fnInput = await page.waitForSelector('input[name="firstName"]', { timeout: 5000 });
          await fnInput.click({ clickCount: 3 });
          await fnInput.type(firstName, { delay: 30 });

          const lnInput = await page.waitForSelector('input[name="lastName"]', { timeout: 5000 });
          await lnInput.click({ clickCount: 3 });
          await lnInput.type(lastName, { delay: 30 });

          await new Promise(r => setTimeout(r, 500));
          await page.evaluate(() => {
            const btn = document.querySelector("button[type='submit']");
            if (btn) btn.click();
          });
          console.log("[codeium]   ✓ 姓名已填写，点击 Continue");
          await new Promise(r => setTimeout(r, 3000));
        } catch (e) {
          console.log(`[codeium]   ⚠ 姓名页面错误: ${e.message}`);
        }
      }

      // About 页面 → Skip
      const url2 = page.url();
      if (url2.includes("about")) {
        console.log("[codeium]   → Onboarding: Skip About...");
        await page.evaluate(() => {
          const btns = [...document.querySelectorAll("button")];
          const skip = btns.find(b => b.textContent?.toLowerCase().includes("skip"));
          if (skip) skip.click();
          else {
            const submit = document.querySelector("button[type='submit']");
            if (submit) submit.click();
          }
        });
        console.log("[codeium]   ✓ About 已跳过");
        await new Promise(r => setTimeout(r, 3000));
      }

      // Source 页面 → Skip
      const url3 = page.url();
      if (url3.includes("source")) {
        console.log("[codeium]   → Onboarding: Skip Source...");
        await page.evaluate(() => {
          const btns = [...document.querySelectorAll("button")];
          const skip = btns.find(b => b.textContent?.toLowerCase().includes("skip"));
          if (skip) skip.click();
          else {
            const submit = document.querySelector("button[type='submit']");
            if (submit) submit.click();
          }
        });
        console.log("[codeium]   ✓ Source 已跳过");
        await new Promise(r => setTimeout(r, 3000));
      }
    }

    // Step 5: 提取 token
    console.log("[codeium]   → 检查注册结果...");
    await page.screenshot({ path: path.join(screenshotDir, `codeium-4-final-${Date.now()}.png`), fullPage: true });

    const finalUrl = page.url();
    console.log(`[codeium]   最终 URL: ${finalUrl}`);

    // 尝试从页面提取 token
    if (!capturedToken) {
      // 尝试从 localStorage 获取
      capturedToken = await page.evaluate(() => {
        // Firebase 通常在 localStorage 中存储 token
        for (const key of Object.keys(localStorage)) {
          if (key.includes("firebase") || key.includes("token") || key.includes("auth")) {
            const val = localStorage.getItem(key);
            if (val && val.length > 100) return val;
            try {
              const parsed = JSON.parse(val);
              if (parsed?.stsTokenManager?.accessToken) return parsed.stsTokenManager.accessToken;
              if (parsed?.idToken) return parsed.idToken;
            } catch {}
          }
        }
        return null;
      });
      if (capturedToken) console.log("[codeium]   ✓ 从 localStorage 提取 token");
    }

    // 尝试从 cookies 提取
    if (!capturedToken) {
      const cookies = await page.cookies();
      const authCookie = cookies.find(c => c.name.includes("token") || c.name.includes("session") || c.name.includes("auth"));
      if (authCookie) {
        capturedToken = authCookie.value;
        console.log(`[codeium]   ✓ 从 cookie 提取 token: ${authCookie.name}`);
      }
    }

    const finalText = await page.evaluate(() => (document.body?.innerText || "").substring(0, 300));
    console.log(`[codeium]   页面内容: ${finalText.substring(0, 150)}`);

    const result = {
      email,
      password,
      firstName,
      lastName,
      firebaseIdToken: capturedToken,
      apiKey: capturedApiKey,
      uid: null,
      registeredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 14 * 24 * 3600_000).toISOString(),
      status: capturedToken ? "registered" : (onboardingReached ? "registered_no_token" : "pending_verification"),
    };

    // 如果有 token，调用 RegisterUser RPC 获取 API Key
    if (capturedToken && !capturedApiKey) {
      const rpcEndpoints = [
        { base: CONFIG.registerServer, path: CONFIG.rpcRegisterUser },
        { base: "https://server.codeium.com", path: "/exa.seat_management_pb.SeatManagementService/RegisterUser" },
      ];
      for (const ep of rpcEndpoints) {
        if (result.apiKey) break;
        try {
          console.log(`[codeium]   → RegisterUser RPC: ${ep.base}${ep.path}`);
          const regReq = encodeRegisterUserRequest(capturedToken);
          const regRes = await callConnectRpc(ep.base, ep.path, regReq);
          console.log(`[codeium]     status=${regRes.status}, body=${regRes.body.length}B`);
          if (regRes.status === 200 && regRes.body.length > 5) {
            const frames = parseConnectFrames(regRes.body);
            if (frames.length > 0) {
              const fields = extractStringsFromProtobuf(frames[0].data);
              console.log(`[codeium]     fields: ${fields.map(f => `f${f.field}=${f.value?.substring(0,25)}`).join(", ")}`);
              result.apiKey = fields.find(f => f.field === 1)?.value;
              result.apiServerUrl = fields.find(f => f.field === 3)?.value;
              if (result.apiKey) {
                console.log(`[codeium]   ✓ API Key: ${result.apiKey.substring(0, 30)}...`);
              }
            }
          }
        } catch (err) {
          console.log(`[codeium]   ✗ ${ep.base} error: ${err.message}`);
        }
      }
    }

    return result;

  } finally {
    await browser.close();
  }
}

// ============================================================
// 方案 A：纯 API 注册（需要 Turnstile token）
// ============================================================

/**
 * 通过 RPC 直接注册（需要预先获取的 Turnstile token）
 */
async function registerViaApi({ email, password, firstName, lastName, turnstileToken }) {
  console.log(`[registrar] API 注册: ${email}`);

  // Step 1: CreateFbUser
  console.log("[registrar]   → CreateFbUser...");
  const createReq = encodeCreateFbUserRequest({
    email, password, turnstileToken, firstName, lastName,
  });

  const createRes = await callConnectRpc(
    CONFIG.registerServer,
    CONFIG.rpcCreateFbUser,
    createReq,
  );

  if (createRes.status !== 200) {
    const errText = createRes.body.toString("utf8");
    throw new Error(`CreateFbUser failed (${createRes.status}): ${errText}`);
  }

  const createFrames = parseConnectFrames(createRes.body);
  const createStrings = createFrames.length > 0
    ? extractStringsFromProtobuf(createFrames[0].data)
    : [];

  const uid = createStrings.find((s) => s.field === 1)?.value;
  console.log(`[registrar]   ← uid: ${uid || "unknown"}`);

  if (!uid) {
    console.log("[registrar]   raw response:", createRes.body.toString("hex"));
    throw new Error("CreateFbUser did not return uid");
  }

  // Step 2: 需要获取 Firebase ID Token
  // CreateFbUser 返回 uid，但 RegisterUser 需要 firebase_id_token
  // 这个 token 通常由 Firebase Auth SDK 在客户端登录后生成
  // 我们需要用 Firebase Auth REST API 登录来获取
  console.log("[registrar]   → 获取 Firebase ID Token (需要 Firebase API Key)...");
  // TODO: 需要找到 Windsurf 的 Firebase API Key
  // 或者用 Puppeteer 方案替代

  return { uid, email, password, firstName, lastName };
}

// ============================================================
// CapSolver Turnstile 自动解题
// ============================================================

/**
 * 调用 CapSolver API 解决 Cloudflare Turnstile
 * @param {string} websiteURL - 注册页面 URL
 * @param {string} websiteKey - Turnstile sitekey
 * @returns {string|null} Turnstile token
 */
async function solveTurnstileWithCapSolver(websiteURL, websiteKey, maxRetries = 3) {
  if (!CONFIG.capsolverApiKey) {
    console.log("[capsolver] ✗ 未设置 CAPSOLVER_API_KEY 环境变量");
    return null;
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (attempt > 1) {
      console.log(`[capsolver] → 重试 ${attempt}/${maxRetries} (等待 5s)...`);
      await new Promise(r => setTimeout(r, 5000));
    }

    console.log(`[capsolver] → 提交 Turnstile 解题任务...`);
    console.log(`[capsolver]   sitekey: ${websiteKey}`);

    const createBody = JSON.stringify({
      clientKey: CONFIG.capsolverApiKey,
      task: {
        type: "AntiTurnstileTaskProxyLess",
        websiteURL,
        websiteKey,
      },
    });

    // 创建任务
    let createRes;
    try {
      createRes = await new Promise((resolve, reject) => {
        const req = https.request(
          `${CONFIG.capsolverEndpoint}/createTask`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(createBody) },
            timeout: 15000,
          },
          (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
              try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
              catch { reject(new Error("CapSolver JSON parse error")); }
            });
          },
        );
        req.on("error", reject);
        req.on("timeout", () => { req.destroy(); reject(new Error("CapSolver request timeout")); });
        req.write(createBody);
        req.end();
      });
    } catch (e) {
      console.log(`[capsolver] ✗ 网络错误: ${e.message}`);
      continue; // 重试
    }

    if (createRes.errorId) {
      console.log(`[capsolver] ✗ 创建任务失败: ${createRes.errorDescription || createRes.errorCode}`);
      continue; // 重试
    }

    const taskId = createRes.taskId;
    console.log(`[capsolver] ✓ 任务已创建: ${taskId}`);

    // 轮询结果（最多 120 秒）
    let solved = false;
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 3000));

      const pollBody = JSON.stringify({
        clientKey: CONFIG.capsolverApiKey,
        taskId,
      });

      let pollRes;
      try {
        pollRes = await new Promise((resolve, reject) => {
          const req = https.request(
            `${CONFIG.capsolverEndpoint}/getTaskResult`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(pollBody) },
              timeout: 15000,
            },
            (res) => {
              const chunks = [];
              res.on("data", (c) => chunks.push(c));
              res.on("end", () => {
                try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
                catch { reject(new Error("CapSolver JSON parse error")); }
              });
            },
          );
          req.on("error", reject);
          req.on("timeout", () => { req.destroy(); reject(new Error("poll timeout")); });
          req.write(pollBody);
          req.end();
        });
      } catch (e) {
        console.log(`[capsolver] ✗ 轮询网络错误: ${e.message}`);
        break; // 跳出轮询
      }

      if (pollRes.status === "ready") {
        const token = pollRes.solution?.token;
        if (token) {
          console.log(`[capsolver] ✓ Turnstile 已解决 (${(i + 1) * 3}s), token: ${token.substring(0, 30)}...`);
          return token;
        }
      } else if (pollRes.status === "failed" || pollRes.errorId) {
        console.log(`[capsolver] ✗ 解题失败: ${pollRes.errorDescription || pollRes.errorCode || "unknown"}`);
        break; // 跳出轮询，进入下一次重试
      }

      if (i % 5 === 4) {
        console.log(`[capsolver]   轮询中... (${(i + 1) * 3}s)`);
      }
    }
  } // end retry loop

  console.log("[capsolver] ✗ 所有重试均失败");
  return null;
}

/**
 * 调用 CapMonster Cloud API 解决 hCaptcha
 * @param {string} websiteURL - 页面 URL
 * @param {string} websiteKey - hCaptcha sitekey
 * @returns {string|null} hCaptcha token
 */
async function solveHCaptchaWithCapMonster(websiteURL, websiteKey, maxRetries = 3) {
  if (!CONFIG.capmonsterApiKey) {
    console.log("[capmonster] ✗ 未设置 CAPMONSTER_API_KEY 环境变量");
    return null;
  }

  const cleanUrl = websiteURL.split('#')[0];

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (attempt > 1) {
      console.log(`[capmonster] → hCaptcha 重试 ${attempt}/${maxRetries} (等待 5s)...`);
      await new Promise(r => setTimeout(r, 5000));
    }

    console.log(`[capmonster] → 提交 hCaptcha 解题任务...`);
    console.log(`[capmonster]   sitekey: ${websiteKey}`);
    console.log(`[capmonster]   url: ${cleanUrl}`);

    const createBody = JSON.stringify({
      clientKey: CONFIG.capmonsterApiKey,
      task: {
        type: "HCaptchaTaskProxyless",
        websiteURL: cleanUrl,
        websiteKey,
      },
    });

    const createRes = await new Promise((resolve, reject) => {
      const req = https.request(
        `${CONFIG.capmonsterEndpoint}/createTask`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(createBody) },
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
            catch { reject(new Error("CapMonster JSON parse error")); }
          });
        },
      );
      req.on("error", reject);
      req.end(createBody);
    });

    if (createRes.errorId) {
      console.log(`[capmonster] ✗ 创建任务失败: ${createRes.errorDescription || createRes.errorCode}`);
      continue;
    }

    const taskId = createRes.taskId;
    console.log(`[capmonster] ✓ 任务已创建: ${taskId}`);

    // 轮询结果（hCaptcha 通常 10-60s）
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 3000));

      const pollBody = JSON.stringify({
        clientKey: CONFIG.capmonsterApiKey,
        taskId,
      });

      const pollRes = await new Promise((resolve, reject) => {
        const req = https.request(
          `${CONFIG.capmonsterEndpoint}/getTaskResult`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(pollBody) },
          },
          (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
              try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
              catch { reject(new Error("CapMonster JSON parse error")); }
            });
          },
        );
        req.on("error", reject);
        req.end(pollBody);
      });

      if (pollRes.status === "ready") {
        const token = pollRes.solution?.gRecaptchaResponse;
        if (token) {
          console.log(`[capmonster] ✓ hCaptcha 已解决 (${(i + 1) * 3}s), token: ${token.substring(0, 30)}...`);
          return token;
        }
      } else if (pollRes.status === "failed" || pollRes.errorId) {
        console.log(`[capmonster] ✗ hCaptcha 解题失败: ${pollRes.errorDescription || pollRes.errorCode || "unknown"}`);
        break;
      }

      if (i % 5 === 4) {
        console.log(`[capmonster]   轮询中... (${(i + 1) * 3}s)`);
      }
    }
  }

  console.log("[capmonster] ✗ hCaptcha 所有重试均失败");
  return null;
}

/**
 * 用 CapSolver 解 hCaptcha（备选方案，当 CapMonster 不支持时）
 */
async function solveHCaptchaWithCapSolver(websiteURL, websiteKey, maxRetries = 3) {
  if (!CONFIG.capsolverApiKey) {
    console.log("[capsolver-hc] ✗ 未设置 CAPSOLVER_API_KEY");
    return null;
  }

  const cleanUrl = websiteURL.split('#')[0];

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (attempt > 1) {
      console.log(`[capsolver-hc] → 重试 ${attempt}/${maxRetries} (等待 5s)...`);
      await new Promise(r => setTimeout(r, 5000));
    }

    console.log(`[capsolver-hc] → 提交 hCaptcha 解题任务...`);
    const createBody = JSON.stringify({
      clientKey: CONFIG.capsolverApiKey,
      task: {
        type: "HCaptchaTaskProxyLess",
        websiteURL: cleanUrl,
        websiteKey,
      },
    });

    let createRes;
    try {
      createRes = await new Promise((resolve, reject) => {
        const req = https.request(
          `${CONFIG.capsolverEndpoint}/createTask`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(createBody) },
            timeout: 15000,
          },
          (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
              try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
              catch { reject(new Error("JSON parse error")); }
            });
          },
        );
        req.on("error", reject);
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
        req.write(createBody);
        req.end();
      });
    } catch (e) {
      console.log(`[capsolver-hc] ✗ 网络错误: ${e.message}`);
      continue;
    }

    if (createRes.errorId) {
      console.log(`[capsolver-hc] ✗ 创建失败: ${createRes.errorDescription || createRes.errorCode}`);
      continue;
    }

    const taskId = createRes.taskId;
    console.log(`[capsolver-hc] ✓ 任务已创建: ${taskId}`);

    // 轮询结果（hCaptcha 通常 10-60s）
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 3000));

      const pollBody = JSON.stringify({ clientKey: CONFIG.capsolverApiKey, taskId });
      let pollRes;
      try {
        pollRes = await new Promise((resolve, reject) => {
          const req = https.request(
            `${CONFIG.capsolverEndpoint}/getTaskResult`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(pollBody) },
              timeout: 10000,
            },
            (res) => {
              const chunks = [];
              res.on("data", (c) => chunks.push(c));
              res.on("end", () => {
                try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
                catch { reject(new Error("JSON parse error")); }
              });
            },
          );
          req.on("error", reject);
          req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
          req.write(pollBody);
          req.end();
        });
      } catch (e) {
        continue;
      }

      if (pollRes.status === "ready") {
        const token = pollRes.solution?.gRecaptchaResponse || pollRes.solution?.token;
        if (token) {
          console.log(`[capsolver-hc] ✓ hCaptcha 已解决 (${(i + 1) * 3}s), token: ${token.substring(0, 30)}...`);
          return token;
        }
      } else if (pollRes.status === "failed" || pollRes.errorId) {
        console.log(`[capsolver-hc] ✗ 解题失败: ${pollRes.errorDescription || pollRes.errorCode || "unknown"}`);
        break;
      }

      if (i % 5 === 4) console.log(`[capsolver-hc]   轮询中... (${(i + 1) * 3}s)`);
    }
  }

  console.log("[capsolver-hc] ✗ hCaptcha 所有重试均失败");
  return null;
}

/**
 * 用 2Captcha 解 hCaptcha（最终备选，限制最少）
 */
async function solveHCaptchaWith2Captcha(websiteURL, websiteKey, maxRetries = 2) {
  if (!CONFIG.twoCaptchaApiKey) {
    console.log("[2captcha] ✗ 未设置 TWOCAPTCHA_API_KEY");
    return null;
  }

  const cleanUrl = websiteURL.split('#')[0];

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (attempt > 1) {
      console.log(`[2captcha] → 重试 ${attempt}/${maxRetries} (等待 5s)...`);
      await new Promise(r => setTimeout(r, 5000));
    }

    console.log(`[2captcha] → 提交 hCaptcha 解题任务...`);

    // 2Captcha API v2: 用 POST 方式提交
    const postBody = JSON.stringify({
      clientKey: CONFIG.twoCaptchaApiKey,
      task: {
        type: "HCaptchaTaskProxyless",
        websiteURL: cleanUrl,
        websiteKey,
      },
    });

    let submitRes;
    try {
      submitRes = await new Promise((resolve, reject) => {
        const req = https.request(
          "https://api.2captcha.com/createTask",
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(postBody) },
            timeout: 15000,
          },
          (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
              try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
              catch { reject(new Error("JSON parse error")); }
            });
          },
        );
        req.on("error", reject);
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
        req.write(postBody);
        req.end();
      });
    } catch (e) {
      console.log(`[2captcha] ✗ 网络错误: ${e.message}`);
      continue;
    }

    if (submitRes.errorId) {
      console.log(`[2captcha] ✗ 提交失败: ${submitRes.errorDescription || submitRes.errorCode || JSON.stringify(submitRes)}`);
      continue;
    }

    const taskId = submitRes.taskId;
    console.log(`[2captcha] ✓ 任务已提交: ${taskId}`);

    // 轮询结果（hCaptcha 通常 20-90s）
    await new Promise(r => setTimeout(r, 15000)); // 先等 15s
    for (let i = 0; i < 30; i++) {
      const pollBody = JSON.stringify({ clientKey: CONFIG.twoCaptchaApiKey, taskId });

      let pollRes;
      try {
        pollRes = await new Promise((resolve, reject) => {
          const req = https.request(
            "https://api.2captcha.com/getTaskResult",
            {
              method: "POST",
              headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(pollBody) },
              timeout: 10000,
            },
            (res) => {
              const chunks = [];
              res.on("data", (c) => chunks.push(c));
              res.on("end", () => {
                try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
                catch { reject(new Error("JSON parse error")); }
              });
            },
          );
          req.on("error", reject);
          req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
          req.write(pollBody);
          req.end();
        });
      } catch (e) {
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      if (pollRes.status === "ready") {
        const token = pollRes.solution?.gRecaptchaResponse || pollRes.solution?.token;
        if (token) {
          console.log(`[2captcha] ✓ hCaptcha 已解决 (${15 + (i + 1) * 5}s), token: ${token.substring(0, 30)}...`);
          return token;
        }
      }

      if (pollRes.status === "processing") {
        if (i % 4 === 3) console.log(`[2captcha]   轮询中... (${15 + (i + 1) * 5}s)`);
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      if (pollRes.errorId) {
        console.log(`[2captcha] ✗ 错误: ${pollRes.errorDescription || pollRes.errorCode}`);
        break;
      }

      await new Promise(r => setTimeout(r, 5000));
    }
  }

  console.log("[2captcha] ✗ hCaptcha 所有重试均失败");
  return null;
}

// ============================================================
// 方案 B：Puppeteer 自动化注册（推荐）
// ============================================================

/**
 * 等待 Turnstile CAPTCHA 完成
 */
async function waitForTurnstile(page, headless) {
  const hasTurnstile = await page.$("iframe[src*='turnstile'], .cf-turnstile, [data-sitekey]");
  if (!hasTurnstile) {
    console.log("[registrar]   ✓ 未检测到 CAPTCHA");
    return;
  }

  console.log("[registrar]   ⚠ 检测到 Cloudflare Turnstile CAPTCHA");
  console.log("[registrar]   → 等待 Turnstile 自动完成（invisible 模式）...");

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const turnstileResponse = await page.evaluate(() => {
      const input = document.querySelector(
        'input[name="cf-turnstile-response"], input[name="turnstileToken"], [name*="turnstile"]',
      );
      return input?.value || null;
    });
    if (turnstileResponse) {
      console.log(`[registrar]   ✓ Turnstile 已完成 (${i + 1}s)`);
      return;
    }
    if (i === 14 && !headless) {
      console.log("[registrar]   → 请在浏览器中手动完成 CAPTCHA...");
    }
    if (i === 29) {
      console.log("[registrar]   ✗ Turnstile 超时，尝试继续...");
    }
  }
}

/**
 * 点击提交/继续按钮
 */
async function clickSubmitButton(page) {
  const submitSelectors = [
    'button[type="submit"]',
    'button:not([type="button"])',
    'input[type="submit"]',
  ];
  const submitTexts = ["sign up", "create", "register", "continue", "submit", "get started", "next", "注册"];

  for (const sel of submitSelectors) {
    try {
      const buttons = await page.$$(sel);
      for (const btn of buttons) {
        const text = await btn.evaluate((e) => e.textContent?.trim());
        const isVisible = await btn.evaluate((e) => e.offsetParent !== null);
        if (isVisible && submitTexts.some(t => text?.toLowerCase().includes(t))) {
          await btn.click();
          console.log(`[registrar]   ✓ 点击: "${text}"`);
          return true;
        }
      }
    } catch {}
  }
  console.log("[registrar]   ✗ 未找到提交按钮");
  return false;
}

/**
 * Puppeteer 自动化完整注册流程
 */
async function registerViaPuppeteer(identity, options = {}) {
  const { headless = true, slowMo = 50 } = options;
  const { email, password, firstName, lastName, tempMail } = identity;

  // 使用 puppeteer-real-browser（真实浏览器指纹，绕过 Turnstile）
  let connect;
  try {
    const mod = await import("puppeteer-real-browser");
    connect = mod.connect;
  } catch {
    console.error("[registrar] ✗ 请先安装: npm install puppeteer-real-browser");
    process.exit(1);
  }

  // 自动检测浏览器路径
  const chromePaths = process.platform === "win32"
    ? [
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      ]
    : [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium-browser",
        "/usr/bin/chromium",
        "/snap/bin/chromium",
      ];

  let chromePath = null;
  for (const p of chromePaths) {
    if (fs.existsSync(p)) { chromePath = p; break; }
  }

  console.log(`[registrar] Real-Browser 注册: ${email}`);
  console.log(`[registrar]   名字: ${firstName} ${lastName}`);
  // 强制非 headless 模式（用 Xvfb 虚拟桌面，绕过 Cloudflare headless 检测）
  const forceVisible = true;
  const useHeadless = forceVisible ? false : (headless ? "new" : false);
  console.log(`[registrar]   模式: ${useHeadless === false ? "有头(Xvfb)" : "无头"}`);
  console.log(`[registrar]   DISPLAY: ${process.env.DISPLAY || "未设置"}`);
  console.log(`[registrar]   浏览器: ${chromePath || "自动检测"}`);

  const connectOpts = {
    headless: useHeadless,
    turnstile: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--window-size=1280,800",
    ],
    customConfig: chromePath ? { chromePath } : {},
    skipTarget: [],
    fingerprint: true,
    connectOption: {},
  };

  const { browser, page } = await connect(connectOpts);

  // 不使用 evaluateOnNewDocument（会被反自动化检测阻止 Turnstile 渲染）
  // Turnstile hook 在 Step 3 通过 page.evaluate 动态注入

  // 监听网络响应，捕获 Firebase ID Token 和 API Key
  page.on("response", async (res) => {
    const url = res.url();
    // 捕获 Firebase Auth 相关响应
    if (url.includes("identitytoolkit") || url.includes("securetoken")) {
      try {
        const body = await res.json();
        if (body.idToken) {
          capturedToken = body.idToken;
          console.log("[registrar]   ← 捕获 Firebase ID Token");
        }
        if (body.refreshToken) {
          console.log("[registrar]   ← 捕获 Refresh Token");
        }
      } catch {}
    }
    // 捕获注册响应
    if (url.includes("RegisterUser") || url.includes("registerUser")) {
      try {
        const buf = await res.buffer();
        const strings = extractStringsFromProtobuf(buf);
        const apiKey = strings.find(
          (s) => s.value && s.value.length > 20 && !s.value.includes(" "),
        );
        if (apiKey) {
          capturedApiKey = apiKey.value;
          console.log("[registrar]   ← 捕获 API Key");
        }
      } catch {}
    }
  });

  // 监听浏览器 console 输出（捕获 hook 脚本日志）
  page.on("console", (msg) => {
    const text = msg.text();
    if (text.includes("[capsolver-hook]")) {
      console.log(`[registrar]   🔧 ${text}`);
    }
  });

  let capturedToken = null;
  let capturedApiKey = null;

  try {
    // 导航到注册页
    const signupUrl = CONFIG.signupUrl;
    console.log(`[registrar]   → 导航到注册页...`);
    await page.goto(signupUrl, { waitUntil: "networkidle2", timeout: 60000 });

    // 等待页面加载
    await new Promise(r => setTimeout(r, 2000));

    // 截图（调试用）
    const screenshotDir = path.join(PROJECT_ROOT, "screenshots");
    fs.mkdirSync(screenshotDir, { recursive: true });
    await page.screenshot({
      path: path.join(screenshotDir, `signup-1-loaded-${Date.now()}.png`),
      fullPage: true,
    });
    console.log("[registrar]   ✓ 注册页已加载，截图已保存");

    // 分析页面结构
    const pageContent = await page.content();
    const pageUrl = page.url();
    console.log(`[registrar]   当前 URL: ${pageUrl}`);

    // 尝试查找并填写注册表单
    // Windsurf 注册页可能的结构：
    // - 邮箱输入框
    // - 密码输入框
    // - 名字输入框
    // - Turnstile CAPTCHA
    // - 提交按钮

    // 策略：尝试多种可能的选择器
    const selectors = {
      email: [
        'input[type="email"]',
        'input[name="email"]',
        'input[placeholder*="email" i]',
        'input[placeholder*="Email"]',
        '#email',
      ],
      password: [
        'input[type="password"]',
        'input[name="password"]',
        '#password',
      ],
      firstName: [
        'input[name="firstName"]',
        'input[name="first_name"]',
        'input[name="given-name"]',
        'input[placeholder*="first" i]',
        'input[placeholder*="First"]',
      ],
      lastName: [
        'input[name="lastName"]',
        'input[name="last_name"]',
        'input[name="family-name"]',
        'input[placeholder*="last" i]',
        'input[placeholder*="Last"]',
      ],
      fullName: [
        'input[name="name"]',
        'input[name="fullName"]',
        'input[placeholder*="name" i]',
        'input[placeholder*="Name"]',
      ],
      submit: [
        'button[type="submit"]',
        'button:not([type="button"])',
        'input[type="submit"]',
      ],
    };

    async function findAndFill(selectorList, value, label) {
      for (const sel of selectorList) {
        try {
          const el = await page.$(sel);
          if (el) {
            const isVisible = await el.evaluate((e) => {
              const style = window.getComputedStyle(e);
              return style.display !== "none" && style.visibility !== "hidden" && e.offsetParent !== null;
            });
            if (isVisible) {
              await el.click({ clickCount: 3 }); // select all
              await el.type(value, { delay: 30 + Math.random() * 40 });
              console.log(`[registrar]   ✓ ${label}: ${sel}`);
              return true;
            }
          }
        } catch {}
      }
      console.log(`[registrar]   ✗ ${label}: 未找到匹配选择器`);
      return false;
    }

    // 填写表单
    const emailFilled = await findAndFill(selectors.email, email, "邮箱");
    if (!emailFilled) {
      // 如果没有邮箱输入框，可能是 OAuth-only 页面
      // 记录页面内容帮助调试
      console.log("[registrar]   页面可能使用 OAuth 登录（Google/GitHub）");
      console.log("[registrar]   页面标题:", await page.title());

      // 查找所有 input 元素
      const inputs = await page.$$eval("input", (els) =>
        els.map((e) => ({
          type: e.type,
          name: e.name,
          placeholder: e.placeholder,
          id: e.id,
          visible: e.offsetParent !== null,
        })),
      );
      console.log("[registrar]   页面 inputs:", JSON.stringify(inputs, null, 2));

      // 查找所有按钮
      const buttons = await page.$$eval("button, a[role='button']", (els) =>
        els.map((e) => ({
          text: e.textContent?.trim().substring(0, 50),
          type: e.type,
          href: e.href,
          visible: e.offsetParent !== null,
        })),
      );
      console.log("[registrar]   页面 buttons:", JSON.stringify(buttons, null, 2));

      await page.screenshot({
        path: path.join(screenshotDir, `signup-2-noform-${Date.now()}.png`),
        fullPage: true,
      });

      throw new Error("无法找到邮箱输入框，请检查截图调整选择器");
    }

    // 填写名字
    const firstNameFilled = await findAndFill(selectors.firstName, firstName, "名");
    const lastNameFilled = await findAndFill(selectors.lastName, lastName, "姓");
    if (!firstNameFilled && !lastNameFilled) {
      await findAndFill(selectors.fullName, `${firstName} ${lastName}`, "全名");
    }

    // 勾选 Terms of Service 复选框
    console.log("[registrar]   → 勾选 Terms of Service...");
    const tosChecked = await page.evaluate(() => {
      // 查找 checkbox
      const checkboxes = document.querySelectorAll('input[type="checkbox"]');
      for (const cb of checkboxes) {
        if (!cb.checked) {
          cb.click();
          return true;
        }
      }
      // 也可能是 label 或 div 伪装的 checkbox
      const labels = document.querySelectorAll('label, [role="checkbox"]');
      for (const label of labels) {
        const text = label.textContent?.toLowerCase() || "";
        if (text.includes("terms") || text.includes("agree") || text.includes("privacy")) {
          label.click();
          return true;
        }
      }
      return false;
    });
    console.log(tosChecked ? "[registrar]   ✓ Terms 已勾选" : "[registrar]   ⚠ 未找到 Terms 复选框");

    // 填写密码（第一步可能没有密码框，跳过）
    const pwFilled = await findAndFill(selectors.password, password, "密码");

    await page.screenshot({
      path: path.join(screenshotDir, `signup-3-filled-${Date.now()}.png`),
      fullPage: true,
    });

    // 等待 Turnstile CAPTCHA（如果有的话）
    console.log("[registrar]   → 检查 Turnstile CAPTCHA...");
    await waitForTurnstile(page, headless);

    // ──── Step 1: 点击 Continue ────
    console.log("[registrar]   → 点击 Continue (Step 1)...");
    await clickSubmitButton(page);
    await new Promise(r => setTimeout(r, 3000));

    await page.screenshot({
      path: path.join(screenshotDir, `signup-4-step1-done-${Date.now()}.png`),
      fullPage: true,
    });

    // ──── Step 2: 检测第二步页面内容 ────
    console.log("[registrar]   → 检测 Step 2...");
    const step2Url = page.url();
    console.log(`[registrar]   Step 2 URL: ${step2Url}`);

    // 分析 Step 2 页面
    const step2Info = await page.evaluate(() => {
      const inputs = [...document.querySelectorAll("input")].map(e => ({
        type: e.type, name: e.name, placeholder: e.placeholder, id: e.id,
        visible: e.offsetParent !== null,
      }));
      const headings = [...document.querySelectorAll("h1, h2, h3")].map(e => e.textContent?.trim());
      const bodyText = document.body?.innerText?.substring(0, 500) || "";
      return { inputs, headings, bodyText };
    });

    console.log(`[registrar]   Step 2 标题: ${JSON.stringify(step2Info.headings)}`);
    console.log(`[registrar]   Step 2 输入框: ${step2Info.inputs.filter(i => i.visible).map(i => i.type + ":" + (i.name || i.placeholder || i.id)).join(", ")}`);

    const bodyLower = step2Info.bodyText.toLowerCase();
    const hasPasswordStep = step2Info.inputs.some(i => i.type === "password" && i.visible);
    const hasOtpStep = bodyLower.includes("verification") || bodyLower.includes("code") ||
      bodyLower.includes("otp") || bodyLower.includes("check your email") ||
      bodyLower.includes("verify");

    if (hasPasswordStep) {
      // Step 2 是设置密码
      console.log("[registrar]   → Step 2: 设置密码");
      await findAndFill(selectors.password, password, "密码");

      // 可能有确认密码框
      const confirmPwSelectors = [
        'input[name="confirmPassword"]',
        'input[name="confirm_password"]',
        'input[name="passwordConfirm"]',
        'input[placeholder*="confirm" i]',
        'input[placeholder*="Confirm"]',
      ];
      await findAndFill(confirmPwSelectors, password, "确认密码");

      await clickSubmitButton(page);
      await new Promise(r => setTimeout(r, 3000));

      await page.screenshot({
        path: path.join(screenshotDir, `signup-5-step2-pw-${Date.now()}.png`),
        fullPage: true,
      });

      // ──── Step 3: Turnstile CAPTCHA（密码提交后出现）────
      const step3Text = await page.evaluate(() => document.body?.innerText?.substring(0, 500) || "");
      const isCaptchaPage = step3Text.toLowerCase().includes("verify") &&
        step3Text.toLowerCase().includes("human");

      if (isCaptchaPage) {
        console.log("[registrar]   → Step 3: Cloudflare Turnstile CAPTCHA");

        let turnstilePassed = false;

        // 诊断 + 等待 Turnstile 渲染
        console.log("[registrar]   → 等待 Turnstile 渲染...");
        await new Promise(r => setTimeout(r, 3000));

        // 诊断页面状态
        const diag = await page.evaluate(() => {
          const t = window.turnstile;
          const cfEls = document.querySelectorAll(".cf-turnstile, [data-sitekey]");
          const iframes = [...document.querySelectorAll("iframe")];
          const scripts = [...document.querySelectorAll("script[src]")]
            .filter(s => s.src.includes("turnstile"))
            .map(s => s.src.substring(0, 100));
          return {
            hasTurnstile: !!t,
            hasRender: t ? typeof t.render : "N/A",
            cfElements: cfEls.length,
            cfElHtml: cfEls.length > 0 ? cfEls[0].outerHTML.substring(0, 200) : "",
            iframeCount: iframes.length,
            iframeSrcs: iframes.map(f => f.src.substring(0, 80)),
            turnstileScripts: scripts,
            privateSample: t?._private ? typeof t._private : "N/A",
          };
        });
        console.log(`[registrar]   诊断: turnstile=${diag.hasTurnstile} render=${diag.hasRender} cf-els=${diag.cfElements} iframes=${diag.iframeCount}`);
        if (diag.cfElements > 0) console.log(`[registrar]   cf-el: ${diag.cfElHtml}`);
        if (diag.iframeSrcs.length > 0) console.log(`[registrar]   iframes: ${JSON.stringify(diag.iframeSrcs)}`);
        if (diag.turnstileScripts.length > 0) console.log(`[registrar]   scripts: ${JSON.stringify(diag.turnstileScripts)}`);

        // 使用已知 sitekey
        const sitekey = CONFIG.turnstileSitekey || "0x4AAAAAAA447Bur1xJStKg5";

        // 方案：CapSolver 解题 + 直接调 React 回调
        if (CONFIG.capsolverApiKey) {
          const currentUrl = page.url();
          console.log("[registrar]   → CapSolver 解题...");
          const turnstileToken = await solveTurnstileWithCapSolver(currentUrl, sitekey);

          if (turnstileToken) {
            // 设置网络拦截：捕获请求 + 修改 SendEmailVerification 的 body 注入 token
            await page.evaluate((params) => {
              const { token, email, password, firstName, lastName } = params;
              window.__netCaptures = [];

              // protobuf 编码函数
              function pbString(fieldNum, str) {
                const bytes = new TextEncoder().encode(str);
                const tag = (fieldNum << 3) | 2;
                const arr = [tag];
                let len = bytes.length;
                while (len > 127) { arr.push((len & 0x7f) | 0x80); len >>= 7; }
                arr.push(len);
                return new Uint8Array([...arr, ...bytes]);
              }

              const origFetch = window.fetch;
              window.fetch = async function(...args) {
                const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "?";
                const method = args[1]?.method || "GET";
                let bodyInfo = null;

                // 如果是 SendEmailVerification 或 CreateFbUser，注入完整 protobuf
                if (url.includes("SeatManagement") && args[1]?.body) {
                  console.log("[fetch-hook] 拦截:", url.split("/").pop());

                  // 构建包含 token 的完整 protobuf body
                  const parts = [];
                  if (email) parts.push(pbString(1, email));
                  if (password) parts.push(pbString(2, password));
                  if (token) parts.push(pbString(3, token));
                  if (firstName) parts.push(pbString(6, firstName));
                  if (lastName) parts.push(pbString(7, lastName));

                  const totalLen = parts.reduce((s, p) => s + p.length, 0);
                  const newBody = new Uint8Array(totalLen);
                  let offset = 0;
                  for (const part of parts) {
                    newBody.set(part, offset);
                    offset += part.length;
                  }

                  // 替换 body
                  if (args[1]) {
                    args[1] = { ...args[1], body: newBody };
                  }
                  bodyInfo = "[modified protobuf " + totalLen + " bytes, token included]";
                  console.log("[fetch-hook] body 已修改:", totalLen, "bytes");
                } else {
                  const body = args[1]?.body;
                  if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
                    bodyInfo = "[binary " + (body.byteLength || body.length) + " bytes]";
                  } else if (body && typeof body !== "string") {
                    try { bodyInfo = JSON.stringify(body); } catch { bodyInfo = String(body); }
                  } else {
                    bodyInfo = body;
                  }
                }

                const entry = { url: url.substring(0, 200), method, body: bodyInfo ? String(bodyInfo).substring(0, 500) : null };
                window.__netCaptures.push(entry);
                try {
                  const resp = await origFetch.apply(this, args);
                  const clone = resp.clone();
                  try {
                    const text = await clone.text();
                    entry.status = resp.status;
                    entry.response = text.substring(0, 500);
                  } catch {}
                  return resp;
                } catch (err) {
                  entry.error = err.message;
                  throw err;
                }
              };
            }, { token: turnstileToken, email, password, firstName, lastName });

            console.log("[registrar]   → 精准注入: onVerify(token) + onNext()...");

            const injectResult = await page.evaluate((token) => {
              const results = [];

              // 1. 覆写 turnstile API
              if (window.turnstile) {
                window.turnstile.getResponse = () => token;
                window.turnstile.isExpired = () => false;
                results.push("api_set");
              }

              // 2. 从 Continue 按钮向上找 React fiber 树
              const allButtons = [...document.querySelectorAll("button")];
              const continueBtn = allButtons.find(b =>
                b.textContent?.toLowerCase().includes("continue"),
              );

              let onNextFn = null;
              let onVerifyFn = null;

              if (continueBtn) {
                const fk = Object.keys(continueBtn).find(
                  k => k.startsWith("__reactFiber") || k.startsWith("__reactInternalInstance"),
                );
                if (fk) {
                  let fiber = continueBtn[fk];
                  let d = 0;
                  while (fiber && d < 50) {
                    const props = fiber.memoizedProps || {};

                    // 找 onNext（表单提交）
                    if (typeof props.onNext === "function" && !onNextFn) {
                      onNextFn = props.onNext;
                      results.push("found:onNext@depth" + d);
                    }

                    // 找 onVerify（Turnstile 回调）
                    if (typeof props.onVerify === "function" && !onVerifyFn) {
                      onVerifyFn = props.onVerify;
                      results.push("found:onVerify@depth" + d);
                    }

                    // 列出所有函数 props（诊断）
                    const fnProps = Object.keys(props).filter(k => typeof props[k] === "function");
                    if (fnProps.length > 0 && d < 30) {
                      results.push("d" + d + ":" + fnProps.join(","));
                    }

                    fiber = fiber.return;
                    d++;
                  }
                }
              }

              // 3. 也从所有 DOM 元素找 onVerify
              if (!onVerifyFn) {
                const allEls = document.querySelectorAll("div, section, form");
                for (const el of allEls) {
                  const fk = Object.keys(el).find(k => k.startsWith("__reactFiber"));
                  if (fk) {
                    let fiber = el[fk];
                    let d = 0;
                    while (fiber && d < 10) {
                      if (fiber.memoizedProps?.onVerify && !onVerifyFn) {
                        onVerifyFn = fiber.memoizedProps.onVerify;
                        results.push("found:onVerify_from_el");
                      }
                      fiber = fiber.return;
                      d++;
                    }
                  }
                  if (onVerifyFn) break;
                }
              }

              // 4. 精准执行：先 onVerify，再 onNext
              if (onVerifyFn) {
                try { onVerifyFn(token); results.push("called:onVerify"); } catch(e) { results.push("err:onVerify:" + e.message); }
              } else {
                results.push("MISSING:onVerify");
              }

              // 等 100ms 让 React 处理 state 更新
              return new Promise(resolve => {
                setTimeout(() => {
                  if (onNextFn) {
                    try { onNextFn(); results.push("called:onNext"); } catch(e) { results.push("err:onNext:" + e.message); }
                  } else {
                    results.push("MISSING:onNext");
                  }
                  resolve(results);
                }, 200);
              });
            }, turnstileToken);

            console.log(`[registrar]   注入结果: ${JSON.stringify(injectResult)}`);

            // 等待页面变化 + 网络请求完成
            await new Promise(r => setTimeout(r, 5000));

            // 打印捕获的网络请求
            const netCaptures = await page.evaluate(() => window.__netCaptures || []);
            if (netCaptures.length > 0) {
              console.log(`[registrar]   === 捕获 ${netCaptures.length} 个网络请求 ===`);
              for (const req of netCaptures) {
                console.log(`[registrar]   ${req.method} ${req.url}`);
                if (req.body) console.log(`[registrar]     body: ${req.body}`);
                if (req.status) console.log(`[registrar]     status: ${req.status}`);
                if (req.response) console.log(`[registrar]     response: ${req.response.substring(0, 300)}`);
                if (req.error) console.log(`[registrar]     error: ${req.error}`);
              }
              console.log("[registrar]   === 请求捕获结束 ===");
            } else {
              console.log("[registrar]   (无网络请求被捕获)");
            }

            const afterText = await page.evaluate(() =>
              (document.body?.innerText || "").toLowerCase().substring(0, 300),
            );
            console.log(`[registrar]   页面状态: ${afterText.substring(0, 150)}`);

            if (!afterText.includes("verify") || !afterText.includes("human")) {
              turnstilePassed = true;
              console.log("[registrar]   ✓ Turnstile 已通过!");
            } else if (afterText.includes("error")) {
              console.log("[registrar]   ⚠ 服务器返回错误");
            }
          }
        }

        if (!turnstilePassed) {
          console.log("[registrar]   ✗ Turnstile 未通过");
          await page.screenshot({
            path: path.join(screenshotDir, `signup-5b-turnstile-failed-${Date.now()}.png`),
            fullPage: true,
          });
        } else {
          await page.screenshot({
            path: path.join(screenshotDir, `signup-5b-turnstile-passed-${Date.now()}.png`),
            fullPage: true,
          });
        }
      }
    } else if (hasOtpStep) {
      // Step 2 是邮箱验证 OTP
      console.log("[registrar]   → Step 2: 邮箱验证 (OTP)");
      console.log("[registrar]   ⚠ 需要从邮箱获取验证码");
      console.log(`[registrar]   页面内容: ${step2Info.bodyText.substring(0, 200)}`);

      // 如果是有头模式，等待人工输入
      if (!headless) {
        console.log("[registrar]   → 请在浏览器中手动输入验证码...");
        // 等待最多 120 秒
        for (let i = 0; i < 120; i++) {
          await new Promise(r => setTimeout(r, 1000));
          const newUrl = page.url();
          if (newUrl !== step2Url) {
            console.log(`[registrar]   ✓ 页面已跳转: ${newUrl}`);
            break;
          }
          if (i % 15 === 14) {
            console.log(`[registrar]   等待中... (${i + 1}s)`);
          }
        }
      } else {
        console.log("[registrar]   ✗ 无头模式无法自动完成邮箱验证");
        console.log("[registrar]   提示: 使用 --headful 模式手动输入验证码");
        console.log("[registrar]   提示: 或使用支持 IMAP 的真实邮箱自动获取验证码");
      }
    } else {
      // 未识别的 Step 2，可能已经跳过或者页面未变化
      console.log("[registrar]   → Step 2: 未识别，可能仍在 Step 1 或已完成");
      console.log(`[registrar]   页面内容: ${step2Info.bodyText.substring(0, 200)}`);

      // 再等一下看是否自动跳转
      await new Promise(r => setTimeout(r, 5000));
    }

    // ──── Step 3: 检查最终状态 ────
    console.log("[registrar]   → 检查最终状态...");
    await new Promise(r => setTimeout(r, 3000));

    await page.screenshot({
      path: path.join(screenshotDir, `signup-6-final-${Date.now()}.png`),
      fullPage: true,
    });

    // ──── Step 4: 邮箱验证码 ────
    const currentUrl = page.url();
    const pageText = await page.evaluate(() => document.body?.innerText || "");
    const needsVerification = pageText.toLowerCase().includes("check your inbox") ||
      pageText.toLowerCase().includes("verification code") ||
      pageText.toLowerCase().includes("enter the") ||
      pageText.toLowerCase().includes("check your email");

    if (needsVerification && tempMail) {
      console.log("[registrar]   → Step 4: 自动邮箱验证");
      console.log(`[registrar]   临时邮箱: ${tempMail.email}`);

      // 等待验证码邮件
      const code = await waitForVerificationCode(tempMail, 120);

      if (code && typeof code === "string") {
        console.log(`[registrar]   → 输入验证码: ${code}`);

        // 找到验证码输入框并填入
        const codeEntered = await page.evaluate((verifyCode) => {
          // 找所有可能的输入框
          const inputs = document.querySelectorAll(
            'input[type="text"], input[type="number"], input[type="tel"], input:not([type])',
          );
          let filled = false;
          for (const input of inputs) {
            const name = (input.name || "").toLowerCase();
            const placeholder = (input.placeholder || "").toLowerCase();
            const ariaLabel = (input.getAttribute("aria-label") || "").toLowerCase();
            if (name.includes("code") || name.includes("otp") || name.includes("verify") ||
                placeholder.includes("code") || placeholder.includes("verify") ||
                ariaLabel.includes("code") || ariaLabel.includes("verify") ||
                input.maxLength === 6 || input.inputMode === "numeric") {
              // React 方式设值
              const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype, "value",
              ).set;
              nativeInputValueSetter.call(input, verifyCode);
              input.dispatchEvent(new Event("input", { bubbles: true }));
              input.dispatchEvent(new Event("change", { bubbles: true }));
              filled = true;
              break;
            }
          }
          // 如果没找到特定输入框，填第一个可见的文本输入框
          if (!filled) {
            for (const input of inputs) {
              const style = window.getComputedStyle(input);
              if (style.display !== "none" && style.visibility !== "hidden" && input.offsetParent) {
                const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                  window.HTMLInputElement.prototype, "value",
                ).set;
                nativeInputValueSetter.call(input, verifyCode);
                input.dispatchEvent(new Event("input", { bubbles: true }));
                input.dispatchEvent(new Event("change", { bubbles: true }));
                filled = true;
                break;
              }
            }
          }
          return filled;
        }, code);

        console.log(`[registrar]   验证码填入: ${codeEntered}`);

        await new Promise(r => setTimeout(r, 1000));

        // 点击 Create Account / Submit / Verify 按钮
        const submitClicked = await page.evaluate(() => {
          const btns = [...document.querySelectorAll("button")];
          const submitTexts = ["create account", "verify", "submit", "continue", "confirm"];
          for (const text of submitTexts) {
            const btn = btns.find(b => b.textContent?.toLowerCase().includes(text));
            if (btn && !btn.disabled) {
              btn.click();
              return btn.textContent?.trim();
            }
          }
          // 强制点击（可能是禁用状态）
          for (const text of submitTexts) {
            const btn = btns.find(b => b.textContent?.toLowerCase().includes(text));
            if (btn) {
              btn.disabled = false;
              btn.removeAttribute("disabled");
              btn.click();
              return btn.textContent?.trim() + " (forced)";
            }
          }
          return null;
        });

        console.log(`[registrar]   提交: ${submitClicked || "未找到按钮"}`);

        // 等待页面响应
        await new Promise(r => setTimeout(r, 8000));

        await page.screenshot({
          path: path.join(screenshotDir, `signup-7-after-verify-${Date.now()}.png`),
          fullPage: true,
        });

        const afterVerifyText = await page.evaluate(() =>
          (document.body?.innerText || "").substring(0, 400),
        );
        console.log(`[registrar]   验证后页面: ${afterVerifyText.substring(0, 200)}`);
      } else if (code && code.type === "link") {
        console.log(`[registrar]   → 访问验证链接...`);
        await page.goto(code.url, { waitUntil: "networkidle2", timeout: 30000 });
        await new Promise(r => setTimeout(r, 5000));
      } else {
        console.log("[registrar]   ✗ 未获取到验证码");
      }
    } else if (needsVerification) {
      console.log("[registrar]   ⚠ 需要邮箱验证但无临时邮箱信息");
      console.log("[registrar]   当前页面内容:", pageText.substring(0, 200));
    }

    // 检查是否已获取 token
    if (capturedToken) {
      console.log("[registrar]   ✓ 已获取 Firebase ID Token");
    }

    // 检查 URL 中的 access_token（show-auth-token 模式）
    if (!capturedToken) {
      const urlParams = new URL(currentUrl).searchParams;
      const accessToken = urlParams.get("access_token");
      if (accessToken) {
        capturedToken = accessToken;
        console.log("[registrar]   ✓ 从 URL 提取 access_token");
      }
    }

    // 检查页面是否显示了 token（show-auth-token 模式）
    if (!capturedToken) {
      const tokenOnPage = await page.evaluate(() => {
        // 查找可能显示 token 的元素
        const codeEls = document.querySelectorAll("code, pre, .token, [data-token]");
        for (const el of codeEls) {
          const text = el.textContent?.trim();
          if (text && text.length > 50 && !text.includes(" ")) {
            return text;
          }
        }
        // 查找 input 中的 token
        const inputs = document.querySelectorAll("input[type='text'], input[readonly]");
        for (const input of inputs) {
          if (input.value && input.value.length > 50) {
            return input.value;
          }
        }
        return null;
      });

      if (tokenOnPage) {
        capturedToken = tokenOnPage;
        console.log("[registrar]   ✓ 从页面提取 token");
      }
    }

    // 等待更长时间，再次检查
    if (!capturedToken) {
      console.log("[registrar]   → 继续等待 token...");
      await new Promise(r => setTimeout(r, 10000));

      // 最终截图
      await page.screenshot({
        path: path.join(screenshotDir, `signup-5-final-${Date.now()}.png`),
        fullPage: true,
      });
      console.log(`[registrar]   最终 URL: ${page.url()}`);
    }

    // 结果
    const result = {
      email,
      password,
      firstName,
      lastName,
      firebaseIdToken: capturedToken,
      apiKey: capturedApiKey,
      uid: null,
      registeredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 14 * 24 * 3600_000).toISOString(), // 14 天
      status: capturedToken ? "registered" : "pending_verification",
    };

    // 如果有 token 但没有 apiKey，调用 RegisterUser RPC
    if (capturedToken && !capturedApiKey) {
      try {
        console.log("[registrar]   → 调用 RegisterUser RPC...");
        const regReq = encodeRegisterUserRequest(capturedToken);
        const regRes = await callConnectRpc(
          CONFIG.registerServer,
          CONFIG.rpcRegisterUser,
          regReq,
        );

        if (regRes.status === 200) {
          const frames = parseConnectFrames(regRes.body);
          if (frames.length > 0) {
            const fields = extractStringsFromProtobuf(frames[0].data);
            result.apiKey = fields.find((f) => f.field === 1)?.value; // apiKey is field 1
            result.apiServerUrl = fields.find((f) => f.field === 3)?.value;
            console.log(`[registrar]   ✓ API Key: ${result.apiKey?.substring(0, 20)}...`);
          }
        } else {
          console.log(`[registrar]   ✗ RegisterUser failed: ${regRes.status}`);
          console.log(`[registrar]     ${regRes.body.toString("utf8").substring(0, 200)}`);
        }
      } catch (err) {
        console.log(`[registrar]   ✗ RegisterUser error: ${err.message}`);
      }
    }

    return result;
  } finally {
    await browser.close();
  }
}

// ============================================================
// 文件锁（并行安全）
// ============================================================

const _fileLocks = new Map();

async function withFileLock(filePath, fn) {
  const lockPath = filePath + ".lock";
  const maxWait = 10_000;
  const start = Date.now();

  // 进程内互斥
  while (_fileLocks.get(lockPath)) {
    await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
    if (Date.now() - start > maxWait) throw new Error(`Lock timeout (in-process): ${lockPath}`);
  }
  _fileLocks.set(lockPath, true);

  // 文件系统互斥（跨进程）
  while (true) {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
      break;
    } catch {
      if (Date.now() - start > maxWait) {
        // 超时强制清锁（可能是遗留的死锁）
        try { fs.unlinkSync(lockPath); } catch {}
        fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
        break;
      }
      await new Promise(r => setTimeout(r, 50 + Math.random() * 200));
    }
  }

  try {
    return await fn();
  } finally {
    try { fs.unlinkSync(lockPath); } catch {}
    _fileLocks.delete(lockPath);
  }
}

// ============================================================
// 账号池管理（带文件锁）
// ============================================================

function loadAccounts() {
  if (!fs.existsSync(CONFIG.accountsFile)) {
    return { accounts: [], lastUpdated: null };
  }
  return JSON.parse(fs.readFileSync(CONFIG.accountsFile, "utf8"));
}

function saveAccounts(data) {
  data.lastUpdated = new Date().toISOString();
  fs.mkdirSync(path.dirname(CONFIG.accountsFile), { recursive: true });
  fs.writeFileSync(CONFIG.accountsFile, JSON.stringify(data, null, 2), "utf8");
}

async function addAccount(account) {
  return withFileLock(CONFIG.accountsFile, () => {
    const data = loadAccounts();
    const existing = data.accounts.findIndex((a) => a.email === account.email);
    if (existing >= 0) {
      data.accounts[existing] = account;
    } else {
      data.accounts.push(account);
    }
    saveAccounts(data);
    return data;
  });
}

/**
 * 将注册的账号同步到 sessions.json（供 lab-server 使用）
 */
async function syncToSessions(account) {
  if (!account.apiKey && !account.firebaseIdToken) return;

  const sessionsFile = CONFIG.sessionsFile;
  await withFileLock(sessionsFile, () => {
    let sessions = { sessions: [] };
    if (fs.existsSync(sessionsFile)) {
      sessions = JSON.parse(fs.readFileSync(sessionsFile, "utf8"));
      if (Array.isArray(sessions)) sessions = { sessions };
    }

    const sessionEntry = {
      id: `ws-trial-${account.email.split("@")[0].substring(0, 8)}`,
      platform: "windsurf",
      email: account.email,
      sessionToken: account.apiKey || account.firebaseIdToken,
      enabled: account.status === "registered",
      loginMethod: "trial-auto",
      acquiredAt: account.registeredAt,
      expiresAt: account.expiresAt,
    };

    const idx = sessions.sessions.findIndex((s) => s.email === account.email);
    if (idx >= 0) {
      sessions.sessions[idx] = sessionEntry;
    } else {
      sessions.sessions.push(sessionEntry);
    }

    fs.writeFileSync(sessionsFile, JSON.stringify(sessions, null, 2), "utf8");
    console.log(`[registrar] ✓ 已同步到 ${sessionsFile}`);
  });
}

// ============================================================
// 方案 D：登录已注册账号，捕获 Token + API Key
// ============================================================

async function loginViaCodeium(email, password, options = {}) {
  const { headless = true } = options;
  const { connect } = await import("puppeteer-real-browser");

  // 查找 Chrome/Edge
  const chromePaths = process.platform === "win32"
    ? [
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      ]
    : [
        "/usr/bin/google-chrome-stable",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium-browser",
        "/usr/bin/chromium",
      ];
  let chromePath = process.env.CHROME_PATH || null;
  if (!chromePath) {
    for (const p of chromePaths) {
      if (fs.existsSync(p)) { chromePath = p; break; }
    }
  }

  console.log(`[login] 登录: ${email}`);
  console.log(`[login]   模式: ${headless ? "无头" : "有头(Xvfb)"}`);

  const { browser, page } = await connect({
    headless: false,
    turnstile: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--window-size=1280,800",
    ],
    customConfig: chromePath ? { chromePath } : {},
    fingerprint: true,
  });

  const screenshotDir = path.join(PROJECT_ROOT, "screenshots");
  fs.mkdirSync(screenshotDir, { recursive: true });

  let capturedToken = null;
  let capturedApiKey = null;
  let firebaseApiKey = null;

  // 监听网络响应，捕获 token
  page.on("response", async (res) => {
    const url = res.url();

    // 从 identitytoolkit URL 中提取 Firebase API Key
    if (url.includes("identitytoolkit.googleapis.com")) {
      const match = url.match(/[?&]key=([^&]+)/);
      if (match) {
        firebaseApiKey = match[1];
        console.log(`[login]   ← 捕获 Firebase API Key: ${firebaseApiKey}`);
      }
      try {
        const body = await res.json();
        if (body.idToken) {
          capturedToken = body.idToken;
          console.log("[login]   ← 捕获 Firebase ID Token");
        }
      } catch {}
    }
    if (url.includes("securetoken")) {
      try {
        const body = await res.json();
        if (body.id_token) {
          capturedToken = body.id_token;
          console.log("[login]   ← 捕获 Firebase ID Token (refresh)");
        }
      } catch {}
    }
    if (url.includes("RegisterUser") || url.includes("registerUser")) {
      try {
        const buf = await res.buffer();
        const strings = extractStringsFromProtobuf(buf);
        const key = strings.find(s => s.value && s.value.length > 20 && !s.value.includes(" "));
        if (key) {
          capturedApiKey = key.value;
          console.log("[login]   ← 捕获 API Key");
        }
      } catch {}
    }
  });

  try {
    // Step 1: 打开登录页
    const loginUrl = "https://codeium.com/account/login";
    console.log("[login]   → 打开登录页...");
    await page.goto(loginUrl, { waitUntil: "networkidle2", timeout: 60000 });
    await new Promise(r => setTimeout(r, 2000));
    await page.screenshot({ path: path.join(screenshotDir, `login-1-loaded-${Date.now()}.png`), fullPage: true });

    // Step 2: 填写登录表单
    console.log("[login]   → 填写邮箱和密码...");

    // 诊断页面元素
    const formInfo = await page.evaluate(() => {
      const inputs = [...document.querySelectorAll("input")];
      const buttons = [...document.querySelectorAll("button")];
      return {
        inputs: inputs.map(i => ({ type: i.type, name: i.name, placeholder: i.placeholder, id: i.id })),
        buttons: buttons.map(b => ({ text: b.textContent?.trim(), type: b.type })),
      };
    });
    console.log(`[login]   页面: ${formInfo.inputs.length} inputs, ${formInfo.buttons.length} buttons`);

    // 填写邮箱
    const emailInput = await page.$('input[type="email"], input[name="email"], input[placeholder*="email" i], input[placeholder*="Email" i]');
    if (emailInput) {
      await emailInput.click({ clickCount: 3 });
      await emailInput.type(email, { delay: 30 });
    } else {
      // 尝试第一个 text/email input
      const firstInput = await page.$("input[type='text'], input:not([type])");
      if (firstInput) {
        await firstInput.click({ clickCount: 3 });
        await firstInput.type(email, { delay: 30 });
      }
    }

    // 填写密码
    const pwInput = await page.$('input[type="password"]');
    if (pwInput) {
      await pwInput.click({ clickCount: 3 });
      await pwInput.type(password, { delay: 30 });
    }

    await new Promise(r => setTimeout(r, 500));
    await page.screenshot({ path: path.join(screenshotDir, `login-2-filled-${Date.now()}.png`), fullPage: true });

    // Step 3: 点击登录按钮
    console.log("[login]   → 点击登录...");
    const clicked = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll("button")];
      const loginBtn = buttons.find(b => {
        const t = (b.textContent || "").toLowerCase().trim();
        return t === "log in" || t === "login" || t === "sign in" || t === "signin" || t === "continue";
      });
      if (loginBtn) { loginBtn.click(); return true; }
      // 尝试 submit 按钮
      const submitBtn = buttons.find(b => b.type === "submit");
      if (submitBtn) { submitBtn.click(); return true; }
      return false;
    });

    if (!clicked) {
      // 尝试按 Enter
      await page.keyboard.press("Enter");
    }

    // Step 4: 等待登录完成
    console.log("[login]   → 等待登录响应...");
    await new Promise(r => setTimeout(r, 8000));
    await page.screenshot({ path: path.join(screenshotDir, `login-3-after-${Date.now()}.png`), fullPage: true });

    const currentUrl = page.url();
    console.log(`[login]   当前 URL: ${currentUrl}`);

    // 如果跳转到了 profile/onboarding 页面，说明登录成功
    if (currentUrl.includes("profile") || currentUrl.includes("onboarding") || currentUrl.includes("dashboard")) {
      console.log("[login]   ✓ 登录成功！");
    }

    // 等待更多网络请求完成
    await new Promise(r => setTimeout(r, 5000));

    // 尝试从 localStorage 获取 token
    if (!capturedToken) {
      capturedToken = await page.evaluate(() => {
        for (const key of Object.keys(localStorage)) {
          if (key.includes("firebase") || key.includes("token") || key.includes("auth")) {
            const val = localStorage.getItem(key);
            if (val && val.length > 100) return val;
            try {
              const parsed = JSON.parse(val);
              if (parsed && typeof parsed === "object") {
                for (const v of Object.values(parsed)) {
                  if (typeof v === "string" && v.length > 100) return v;
                }
              }
            } catch {}
          }
        }
        return null;
      });
      if (capturedToken) console.log("[login]   ← 从 localStorage 获取 Token");
    }

    // 如果有 token 但没有 apiKey，调用 RegisterUser RPC
    if (capturedToken && !capturedApiKey) {
      try {
        console.log("[login]   → 调用 RegisterUser RPC...");
        const regReq = encodeRegisterUserRequest(capturedToken);
        const regRes = await callConnectRpc(CONFIG.registerServer, CONFIG.rpcRegisterUser, regReq);
        if (regRes.status === 200) {
          const frames = parseConnectFrames(regRes.body);
          if (frames.length > 0) {
            const strings = extractStringsFromProtobuf(frames[0].data);
            const key = strings.find(s => s.value && s.value.length > 20 && !s.value.includes(" "));
            if (key) {
              capturedApiKey = key.value;
              console.log(`[login]   ✓ API Key: ${capturedApiKey.substring(0, 30)}...`);
            }
          }
        } else {
          console.log(`[login]   ✗ RegisterUser failed: ${regRes.status}`);
        }
      } catch (err) {
        console.log(`[login]   ✗ RegisterUser error: ${err.message}`);
      }
    }
  } catch (err) {
    console.error(`[login] 错误: ${err.message}`);
  } finally {
    await browser.close().catch(() => {});
  }

  if (!capturedToken && !capturedApiKey) {
    return null;
  }

  // 保存 Firebase API Key（如果捕获到了）
  if (firebaseApiKey) {
    const envLine = `FIREBASE_API_KEY=${firebaseApiKey}`;
    const envFile = path.join(PROJECT_ROOT, ".env");
    const envContent = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "";
    if (!envContent.includes("FIREBASE_API_KEY=")) {
      fs.appendFileSync(envFile, `\n${envLine}\n`, "utf8");
      console.log(`[login] ✓ Firebase API Key 已保存到 .env`);
    }
  }

  return {
    email,
    firebaseIdToken: capturedToken,
    apiKey: capturedApiKey,
    firebaseApiKey,
    status: capturedApiKey ? "registered" : "registered_no_token",
  };
}

// ============================================================
// VCC（虚拟信用卡）管理 —— 支持 NOBE 导出导入
// ============================================================

// VCC 卡池文件（持久化存储所有卡片）
const VCC_POOL_FILE = path.join(PROJECT_ROOT, "config", "vcc-pool.json");

function loadVccPool() {
  try {
    if (fs.existsSync(VCC_POOL_FILE)) {
      return JSON.parse(fs.readFileSync(VCC_POOL_FILE, "utf8"));
    }
  } catch {}
  return { cards: [], importedAt: null };
}

function saveVccPool(data) {
  const dir = path.dirname(VCC_POOL_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(VCC_POOL_FILE, JSON.stringify(data, null, 2));
}

/**
 * 导入 NOBE 导出的卡片数据
 * 支持格式：
 *   1. CSV（一键导出格式）: 卡号,过期月/年,CVV,姓名,地址,城市,州,邮编,...
 *   2. 纯文本每行一张卡: 卡号,MM/YY,CVV,ZIP
 *   3. JSON 数组: [{ number, expiry, cvc, zip, name? }]
 */
function importNobeCards(filePath) {
  const content = fs.readFileSync(filePath, "utf8").trim();
  const pool = loadVccPool();
  const existingNumbers = new Set(pool.cards.map(c => c.number));
  let imported = 0;

  // 尝试 JSON
  if (content.startsWith("[") || content.startsWith("{")) {
    try {
      let cards = JSON.parse(content);
      if (!Array.isArray(cards)) cards = [cards];
      for (const c of cards) {
        const num = (c.number || c.cardNumber || c.card_number || "").replace(/\s/g, "");
        if (num.length >= 13 && !existingNumbers.has(num)) {
          pool.cards.push({
            number: num,
            expiry: c.expiry || c.exp || c.expDate || c.exp_date || "",
            cvc: String(c.cvc || c.cvv || c.cvv2 || c.security_code || ""),
            zip: c.zip || c.postal || c.postalCode || c.zipCode || "10001",
            name: c.name || c.cardHolder || "",
            source: "nobe",
            status: "available",
            importedAt: new Date().toISOString(),
          });
          existingNumbers.add(num);
          imported++;
        }
      }
    } catch (err) {
      console.error(`[vcc] JSON 解析失败: ${err.message}`);
    }
  } else {
    // CSV / 纯文本
    const lines = content.split(/\r?\n/).filter(l => l.trim() && !l.startsWith("#"));
    // 检测是否有表头
    const firstLine = lines[0].toLowerCase();
    const hasHeader = firstLine.includes("card") || firstLine.includes("卡号") ||
      firstLine.includes("number") || firstLine.includes("expir");
    const dataLines = hasHeader ? lines.slice(1) : lines;

    for (const line of dataLines) {
      // 支持逗号、Tab、竖线分隔
      const parts = line.split(/[,\t|]/).map(s => s.trim().replace(/^["']|["']$/g, ""));
      // 找到看起来像卡号的字段（13-19 位纯数字）
      let cardIdx = parts.findIndex(p => /^\d{13,19}$/.test(p.replace(/\s/g, "")));
      if (cardIdx === -1) continue;

      const num = parts[cardIdx].replace(/\s/g, "");
      if (existingNumbers.has(num)) continue;

      // 后续字段：过期日期, CVV, 可能还有姓名/地址/邮编
      let expiry = "", cvc = "", zip = "10001", name = "";

      for (let i = 0; i < parts.length; i++) {
        if (i === cardIdx) continue;
        const p = parts[i];
        // 过期日期: MM/YY 或 MM/YYYY 或 MMYY
        if (!expiry && /^\d{2}[\/\-]\d{2,4}$/.test(p)) { expiry = p; continue; }
        if (!expiry && /^\d{4}$/.test(p) && parseInt(p.slice(0,2)) <= 12) {
          expiry = p.slice(0,2) + "/" + p.slice(2); continue;
        }
        // CVV: 3-4 位数字
        if (!cvc && /^\d{3,4}$/.test(p) && !expiry.includes(p)) { cvc = p; continue; }
        // 邮编: 5 位数字
        if (zip === "10001" && /^\d{5}(-\d{4})?$/.test(p)) { zip = p; continue; }
        // 姓名: 包含字母
        if (!name && /[a-zA-Z]/.test(p) && p.length > 2 && p.length < 40) { name = p; }
      }

      pool.cards.push({
        number: num, expiry, cvc, zip, name,
        source: "nobe", status: "available",
        importedAt: new Date().toISOString(),
      });
      existingNumbers.add(num);
      imported++;
    }
  }

  pool.importedAt = new Date().toISOString();
  saveVccPool(pool);
  return { imported, total: pool.cards.length };
}

function loadVccUsage() {
  try {
    if (fs.existsSync(CONFIG.vccUsageFile)) {
      return JSON.parse(fs.readFileSync(CONFIG.vccUsageFile, "utf8"));
    }
  } catch {}
  return { used: [], nextIndex: 0 };
}

function saveVccUsage(data) {
  const dir = path.dirname(CONFIG.vccUsageFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG.vccUsageFile, JSON.stringify(data, null, 2));
}

// 获取下一张可用 VCC（轮换使用）
function getNextVcc() {
  const cards = CONFIG.vccCards;
  if (cards.length === 0) {
    const single = CONFIG.vccSingleCard;
    if (single) return single;
    return null;
  }
  const usage = loadVccUsage();
  const idx = usage.nextIndex % cards.length;
  usage.nextIndex = idx + 1;
  saveVccUsage(usage);
  return cards[idx];
}

// 标记 VCC 已绑定到某账号
function markVccUsed(card, email) {
  const usage = loadVccUsage();
  usage.used.push({
    cardLast4: card.number.slice(-4),
    email,
    boundAt: new Date().toISOString(),
  });
  saveVccUsage(usage);
}

// ============================================================
// Buvei 虚拟信用卡自动开卡（浏览器自动化）
// ============================================================

/**
 * 登录 Buvei 平台
 */
async function buveiLogin(page, screenshotDir) {
  const prefix = "[buvei]";
  const email = CONFIG.buveiEmail;
  const password = CONFIG.buveiPassword;

  if (!email || !password) {
    console.log(`${prefix} ✗ 需要配置 BUVEI_EMAIL 和 BUVEI_PASSWORD`);
    return false;
  }

  console.log(`${prefix} → 登录 Buvei: ${email}`);
  await page.goto(`${CONFIG.buveiBaseUrl}/signin`, { waitUntil: "networkidle2", timeout: 60000 });
  await new Promise(r => setTimeout(r, 2000));

  // Step 1: 等待 Cloudflare 安全验证通过
  console.log(`${prefix}   → 等待 Cloudflare 验证...`);
  for (let i = 0; i < 60; i++) {
    const pageText = await page.evaluate(() => document.body?.innerText || "");
    const hasChallenge = pageText.includes("执行安全验证") || pageText.includes("Verifying") ||
                         pageText.includes("正在验证") || pageText.includes("checking your browser") ||
                         pageText.includes("Just a moment") || pageText.includes("Enable JavaScript");
    if (!hasChallenge) {
      console.log(`${prefix}   ✓ Cloudflare 验证通过`);
      break;
    }
    if (i === 0 && screenshotDir) {
      await page.screenshot({ path: path.join(screenshotDir, `buvei-cf-challenge-${Date.now()}.png`), fullPage: true });
    }
    if (i % 10 === 9) console.log(`${prefix}     等待中... (${i + 1}s)`);
    await new Promise(r => setTimeout(r, 1000));
  }

  await new Promise(r => setTimeout(r, 3000));
  if (screenshotDir) {
    await page.screenshot({ path: path.join(screenshotDir, `buvei-login-1-after-cf-${Date.now()}.png`), fullPage: true });
  }

  // 检查是否已登录（直接跳转到了 dashboard）
  const url = page.url();
  console.log(`${prefix}   当前 URL: ${url}`);
  if (!url.includes("/login") && !url.includes("/signin") && !url.includes("/register") && !url.includes("/signup")) {
    console.log(`${prefix}   ✓ 已登录（跳过）`);
    return true;
  }

  // Step 2: 点击 "Continue with Email" 展开邮箱登录表单
  console.log(`${prefix}   → 点击 "Continue with Email"...`);
  await new Promise(r => setTimeout(r, 2000));
  const emailLoginClicked = await page.evaluate(() => {
    // Buvei SPA 不用标准 <button>，遍历所有可见元素
    // 关键：只匹配文本较短的元素（避免命中整个页面容器）
    const allEls = [...document.querySelectorAll("a, div, span, p, button, [role='button'], [class*='btn'], [class*='button']")];
    // 第一轮：精确匹配 "Continue with Email"，文本长度限制 < 50
    for (const el of allEls) {
      const t = (el.textContent || "").trim();
      if (t.length < 50 && t.toLowerCase().includes("continue with email") && el.offsetParent !== null) {
        el.click();
        return t;
      }
    }
    // 第二轮：匹配包含 "email" 的短文本元素（排除 Google、sign up 等）
    for (const el of allEls) {
      const t = (el.textContent || "").trim();
      if (t.length < 40 && t.toLowerCase().includes("email") &&
          !t.toLowerCase().includes("google") && !t.toLowerCase().includes("don't") &&
          !t.toLowerCase().includes("sign up") && el.offsetParent !== null) {
        el.click();
        return t;
      }
    }
    return null;
  });
  console.log(`${prefix}   → 点击结果: ${emailLoginClicked || "(未找到)"}`);
  await new Promise(r => setTimeout(r, 3000));

  if (screenshotDir) {
    await page.screenshot({ path: path.join(screenshotDir, `buvei-login-2-after-email-btn-${Date.now()}.png`), fullPage: true });
  }

  // Step 3: 等待邮箱/密码输入框出现
  console.log(`${prefix}   → 等待登录表单...`);
  let formFound = false;
  for (let i = 0; i < 20; i++) {
    const hasInput = await page.evaluate(() => {
      const inputs = document.querySelectorAll('input[type="email"], input[type="text"], input[type="password"], input[name="email"], input[name="username"]');
      // 排除搜索框（Buvei 有个 rc_select 搜索框）
      const realInputs = [...inputs].filter(inp => inp.id !== "rc_select_0" && inp.type !== "search");
      return realInputs.length > 0;
    });
    if (hasInput) { formFound = true; break; }
    await new Promise(r => setTimeout(r, 1000));
  }

  if (!formFound) {
    console.log(`${prefix}   → 未找到表单，诊断中...`);
    await new Promise(r => setTimeout(r, 3000));
    if (screenshotDir) {
      await page.screenshot({ path: path.join(screenshotDir, `buvei-login-no-form-${Date.now()}.png`), fullPage: true });
    }
    const diag = await page.evaluate(() => {
      return {
        url: location.href,
        title: document.title,
        inputs: [...document.querySelectorAll("input")].map(i => ({ type: i.type, name: i.name, placeholder: i.placeholder, id: i.id })),
        allClickables: [...document.querySelectorAll("a, div[class*='btn'], span[class*='btn'], button")].slice(0, 20)
          .map(e => ({ tag: e.tagName, text: (e.textContent || "").trim().substring(0, 40), class: (e.className || "").substring(0, 40) })),
        bodyText: (document.body?.innerText || "").substring(0, 800),
        iframes: document.querySelectorAll("iframe").length,
      };
    });
    console.log(`${prefix}   诊断:`, JSON.stringify(diag, null, 2));
  }

  if (screenshotDir) {
    await page.screenshot({ path: path.join(screenshotDir, `buvei-login-2-form-${Date.now()}.png`), fullPage: true });
  }

  // Step 3: 填写邮箱/用户名
  const emailSelectors = [
    'input[type="email"]', 'input[name="email"]', 'input[name="username"]',
    'input[placeholder*="email" i]', 'input[placeholder*="邮箱" i]',
    'input[placeholder*="phone" i]', 'input[placeholder*="手机" i]',
    'input[placeholder*="account" i]', 'input[placeholder*="账号" i]',
    'input[type="text"]',
  ];
  let emailFilled = false;
  for (const sel of emailSelectors) {
    const el = await page.$(sel);
    if (el) {
      await el.click({ clickCount: 3 });
      await new Promise(r => setTimeout(r, 200));
      await el.type(email, { delay: 30 });
      console.log(`${prefix}   ✓ 邮箱 (${sel})`);
      emailFilled = true;
      break;
    }
  }
  if (!emailFilled) console.log(`${prefix}   ⚠ 未找到邮箱输入框`);

  // Step 4: 填写密码
  await new Promise(r => setTimeout(r, 500));
  const pwSelectors = ['input[type="password"]', 'input[name="password"]', 'input[placeholder*="password" i]', 'input[placeholder*="密码" i]'];
  let pwFilled = false;
  for (const sel of pwSelectors) {
    const el = await page.$(sel);
    if (el) {
      await el.click({ clickCount: 3 });
      await new Promise(r => setTimeout(r, 200));
      await el.type(password, { delay: 30 });
      console.log(`${prefix}   ✓ 密码 (${sel})`);
      pwFilled = true;
      break;
    }
  }
  if (!pwFilled) console.log(`${prefix}   ⚠ 未找到密码输入框`);

  await new Promise(r => setTimeout(r, 500));

  if (screenshotDir) {
    await page.screenshot({ path: path.join(screenshotDir, `buvei-login-3-filled-${Date.now()}.png`), fullPage: true });
  }

  // Step 5: 点击登录按钮
  const clickedBtn = await page.evaluate(() => {
    const btns = [...document.querySelectorAll("button, [role='button'], input[type='submit'], a[class*='btn']")];
    const keywords = ["log in", "login", "sign in", "signin", "登录", "submit", "continue", "登入"];
    for (const kw of keywords) {
      const btn = btns.find(b => {
        const t = (b.textContent || b.value || "").toLowerCase().trim();
        return t.includes(kw) && b.offsetParent !== null;
      });
      if (btn) { btn.click(); return (btn.textContent || btn.value || "").trim(); }
    }
    // fallback: submit button
    const sb = btns.find(b => b.type === "submit" && b.offsetParent !== null);
    if (sb) { sb.click(); return "submit_btn"; }
    return null;
  });
  console.log(`${prefix}   → 点击: ${clickedBtn || "(未找到按钮)"}`);

  // Step 6: 等待登录完成（URL 离开 signin 页面）
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const curUrl = page.url();
    if (!curUrl.includes("/login") && !curUrl.includes("/signin") && !curUrl.includes("/register")) {
      console.log(`${prefix}   ✓ 登录成功 → ${curUrl}`);
      if (screenshotDir) {
        await page.screenshot({ path: path.join(screenshotDir, `buvei-login-4-done-${Date.now()}.png`), fullPage: true });
      }
      return true;
    }
    // 检查是否有错误提示
    if (i === 10) {
      const errText = await page.evaluate(() => {
        const errs = [...document.querySelectorAll("[class*='error'], [class*='alert'], [class*='warning'], [role='alert']")];
        return errs.map(e => (e.textContent || "").trim()).filter(Boolean).join(" | ");
      });
      if (errText) console.log(`${prefix}   ⚠ 错误提示: ${errText}`);
      if (screenshotDir) {
        await page.screenshot({ path: path.join(screenshotDir, `buvei-login-wait-${Date.now()}.png`), fullPage: true });
      }
    }
  }

  if (screenshotDir) {
    await page.screenshot({ path: path.join(screenshotDir, `buvei-login-fail-${Date.now()}.png`), fullPage: true });
  }
  console.log(`${prefix}   ✗ 登录超时`);
  return false;
}

/**
 * 在 Buvei 后台创建一张新虚拟卡并提取卡片详情
 * 返回: { number, expiry, cvc, zip, cardId, ... } 或 null
 */
async function buveiCreateCard(page, screenshotDir, options = {}) {
  const prefix = "[buvei-card]";
  const quantity = options.quantity || CONFIG.buveiDefaultQuantity;
  const balance = Math.max(10, options.balance || CONFIG.buveiDefaultBalance);

  // Step 1: 确保在 dashboard 页面
  console.log(`${prefix} → 导航到 Dashboard...`);
  await page.goto(`${CONFIG.buveiBaseUrl}/dashboard`, { waitUntil: "networkidle2", timeout: 30000 });
  await new Promise(r => setTimeout(r, 3000));
  await page.screenshot({ path: path.join(screenshotDir, `buvei-card-1-dashboard-${Date.now()}.png`), fullPage: true });

  // Step 2: 打开侧边栏（点击左上角 ≡ 汉堡菜单）
  console.log(`${prefix} → 打开侧边栏菜单...`);
  const menuOpened = await page.evaluate(() => {
    // 找汉堡菜单按钮（≡ 图标，通常是 svg 或特定 class）
    const candidates = [...document.querySelectorAll(
      "[class*='menu'], [class*='hamburger'], [class*='sidebar'], [class*='toggle'], " +
      "[class*='drawer'], [aria-label*='menu' i], [class*='burger'], " +
      "button, div[role='button'], span[role='button']"
    )];
    // 找左上角的小按钮（位置在 x<100, y<100）
    for (const el of candidates) {
      const rect = el.getBoundingClientRect();
      if (rect.left < 100 && rect.top < 80 && rect.width < 60 && rect.height < 60 &&
          rect.width > 10 && el.offsetParent !== null) {
        el.click();
        return `${el.tagName}.${(el.className || "").toString().substring(0, 40)} @ (${Math.round(rect.left)},${Math.round(rect.top)})`;
      }
    }
    // fallback: 找任何包含 ≡ 或三条横线 svg 的元素
    const allEls = [...document.querySelectorAll("*")];
    for (const el of allEls) {
      const rect = el.getBoundingClientRect();
      if (rect.left < 80 && rect.top < 80 && rect.width > 15 && rect.width < 60 && rect.height < 60) {
        const hasSvg = el.querySelector("svg") || el.tagName === "SVG";
        const hasLines = (el.innerHTML || "").includes("line") || (el.innerHTML || "").includes("path");
        if (hasSvg || hasLines) {
          el.click();
          return `fallback: ${el.tagName} @ (${Math.round(rect.left)},${Math.round(rect.top)})`;
        }
      }
    }
    return null;
  });
  console.log(`${prefix}   → 菜单: ${menuOpened || "(未找到)"}`);
  await new Promise(r => setTimeout(r, 2000));
  await page.screenshot({ path: path.join(screenshotDir, `buvei-card-2-sidebar-${Date.now()}.png`), fullPage: true });

  // Step 3: 侧边栏中点击 "Issue Card"
  console.log(`${prefix} → 点击 "Issue Card"...`);
  const issueCardClicked = await page.evaluate(() => {
    const allEls = [...document.querySelectorAll("a, div, span, li, [role='menuitem'], [class*='menu-item'], [class*='nav-item']")];
    // 精确匹配 "Issue Card"（不是 "My Cards"，不是 "Transactions"）
    for (const el of allEls) {
      const t = (el.textContent || "").trim();
      if (t.length < 30 && /issue\s*card/i.test(t) && el.offsetParent !== null) {
        el.click();
        return t;
      }
    }
    // fallback: 找包含 "issue" 的短文本菜单项
    for (const el of allEls) {
      const t = (el.textContent || "").trim();
      if (t.length < 20 && t.toLowerCase().includes("issue") && el.offsetParent !== null) {
        el.click();
        return t;
      }
    }
    return null;
  });
  console.log(`${prefix}   → 结果: ${issueCardClicked || "(未找到)"}`);
  await new Promise(r => setTimeout(r, 3000));
  await page.screenshot({ path: path.join(screenshotDir, `buvei-card-3-issuepage-${Date.now()}.png`), fullPage: true });

  // Step 4a: 关闭客服聊天弹窗（如果存在）
  await page.evaluate(() => {
    // 关闭 Buvei 右下角客服弹窗 / iframe / 遮挡层
    const chatEls = document.querySelectorAll(
      "[class*='chat-widget'], [class*='chatbot'], [class*='intercom'], " +
      "[class*='crisp'], [class*='tawk'], [class*='livechat'], " +
      "[id*='chat'], [id*='intercom'], iframe[src*='chat'], iframe[src*='crisp']"
    );
    for (const el of chatEls) el.style.display = "none";
    // 关闭所有可能的 close 按钮
    const closeBtns = [...document.querySelectorAll("[class*='close'], [aria-label*='close' i], [aria-label*='dismiss' i]")];
    for (const btn of closeBtns) {
      const rect = btn.getBoundingClientRect();
      // 只关闭聊天区域的（一般在左下角或右下角）
      if (rect.width < 50 && rect.height < 50) btn.click();
    }
  });
  await new Promise(r => setTimeout(r, 500));

  // Step 4b: 页面显示三种卡片，按文本定位 "AI and SaaS" 卡片，点击其 "Issue a card"
  console.log(`${prefix} → 选择卡片类型（AI and SaaS）...`);
  const cardTypeClicked = await page.evaluate(() => {
    // 策略 1: 找包含 "AI and SaaS" 或 "ChatGPT" 文字的容器，再找里面的 "Issue" 按钮
    const allEls = [...document.querySelectorAll("div, section, article, li")];
    for (const container of allEls) {
      const t = (container.textContent || "").toLowerCase();
      if ((t.includes("ai and saas") || t.includes("chatgpt") || t.includes("claude")) &&
          t.length < 300 && container.offsetParent !== null) {
        // 在此容器中找 "Issue a card" 按钮
        const btns = [...container.querySelectorAll("button, a, div, span, [role='button'], [class*='btn']")];
        const issueBtn = btns.find(b => {
          const bt = (b.textContent || "").trim();
          return bt.length < 30 && /issue/i.test(bt) && b.offsetParent !== null;
        });
        if (issueBtn) {
          issueBtn.click();
          return `AI/SaaS容器内: ${(issueBtn.textContent || "").trim()}`;
        }
        // 容器本身可能可点击
        container.click();
        return `AI/SaaS容器: ${t.substring(0, 50)}`;
      }
    }

    // 策略 2: 用坐标排序 "Issue a card" 按钮，选中间的
    const allBtns = [...document.querySelectorAll("button, a, div, span, [role='button'], [class*='btn']")];
    const issueButtons = allBtns.filter(el => {
      const bt = (el.textContent || "").trim();
      return bt.length < 30 && /^issue\s*(a\s*)?card$/i.test(bt) && el.offsetParent !== null;
    }).sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return ra.left - rb.left;  // 按水平位置排序
    });

    if (issueButtons.length >= 2) {
      // 点第二个（中间）
      issueButtons[1].click();
      return `按位置排序第2个(共${issueButtons.length}): ${(issueButtons[1].textContent || "").trim()}`;
    } else if (issueButtons.length === 1) {
      issueButtons[0].click();
      return `唯一: ${(issueButtons[0].textContent || "").trim()}`;
    }
    return null;
  });
  console.log(`${prefix}   → 结果: ${cardTypeClicked || "(未找到)"}`);
  await new Promise(r => setTimeout(r, 3000));
  await page.screenshot({ path: path.join(screenshotDir, `buvei-card-4-binselect-${Date.now()}.png`), fullPage: true });

  // Step 4c: 在 BIN 表格中点击第一个 "Issue" 按钮（选择 BIN）
  console.log(`${prefix} → 等待 BIN 选择表格...`);
  let binTableFound = false;
  for (let i = 0; i < 10; i++) {
    const hasBinTable = await page.evaluate(() => {
      const text = document.body?.innerText || "";
      return text.includes("Select a card BIN") || text.includes("BIN") && text.includes("Action");
    });
    if (hasBinTable) { binTableFound = true; break; }
    await new Promise(r => setTimeout(r, 1000));
  }

  if (binTableFound) {
    console.log(`${prefix} → 选择第一个 BIN，点击 "Issue"...`);
    const binIssueClicked = await page.evaluate(() => {
      // 找表格中 Action 列的 "Issue" 按钮
      const allEls = [...document.querySelectorAll("button, a, div, span, [role='button'], [class*='btn']")];
      for (const el of allEls) {
        const t = (el.textContent || "").trim();
        if (/^issue$/i.test(t) && el.offsetParent !== null) {
          el.click();
          return t;
        }
      }
      // fallback: 找 td 中短文本 "Issue" 的元素
      const tds = [...document.querySelectorAll("td, [class*='action'], [class*='cell']")];
      for (const td of tds) {
        const t = (td.textContent || "").trim();
        if (/^issue$/i.test(t) && td.offsetParent !== null) {
          td.click();
          return t;
        }
      }
      return null;
    });
    console.log(`${prefix}   → BIN Issue: ${binIssueClicked || "(未找到)"}`);
    await new Promise(r => setTimeout(r, 3000));
    await page.screenshot({ path: path.join(screenshotDir, `buvei-card-4d-after-bin-issue-${Date.now()}.png`), fullPage: true });
  }

  // Step 5: 等待开卡信息表单出现（"Enter card information" / "First name"）
  console.log(`${prefix} → 等待开卡信息表单...`);
  let step3Found = false;
  for (let i = 0; i < 15; i++) {
    const hasForm = await page.evaluate(() => {
      const text = document.body?.innerText || "";
      // 检测页面文本包含 "Enter card information" 或 "First name"
      if (text.includes("Enter card information") || text.includes("First name")) return true;
      // 检测输入框
      const inputs = document.querySelectorAll("input");
      for (const inp of inputs) {
        const ph = (inp.placeholder || "").toLowerCase();
        if (ph.includes("first") || ph.includes("last name")) return true;
      }
      return false;
    });
    if (hasForm) { step3Found = true; break; }
    await new Promise(r => setTimeout(r, 1000));
  }

  if (!step3Found) {
    console.log(`${prefix}   ⚠ 开卡信息表单未出现，诊断中...`);
    const diag = await page.evaluate(() => ({
      url: location.href,
      bodyText: (document.body?.innerText || "").substring(0, 600),
    }));
    console.log(`${prefix}   URL: ${diag.url}`);
    console.log(`${prefix}   页面: ${diag.bodyText.substring(0, 300)}`);
    await page.screenshot({ path: path.join(screenshotDir, `buvei-card-5-no-form-${Date.now()}.png`), fullPage: true });
    return null;
  }

  await page.screenshot({ path: path.join(screenshotDir, `buvei-card-5-step3form-${Date.now()}.png`), fullPage: true });

  // Step 6: 填写 Step2 表单
  // 生成随机姓名
  const firstNames = ["James", "John", "Robert", "Michael", "David", "William", "Richard", "Thomas", "Mark", "Steven",
                      "Daniel", "Paul", "Andrew", "Chris", "Kevin", "Brian", "George", "Edward", "Alex", "Peter"];
  const lastNames = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Miller", "Davis", "Wilson", "Moore", "Taylor",
                     "Anderson", "Thomas", "Jackson", "White", "Harris", "Martin", "Thompson", "Garcia", "Clark", "Lewis"];
  const firstName = firstNames[Math.floor(Math.random() * firstNames.length)];
  const lastName = lastNames[Math.floor(Math.random() * lastNames.length)];

  console.log(`${prefix} → 填写表单: ${firstName} ${lastName}, 数量: ${quantity}, 余额: $${balance}`);

  // 辅助函数：清空输入框再填值（Ctrl+A → Backspace → 输入）
  async function clearAndType(el, value, delay = 30) {
    await el.click();
    await new Promise(r => setTimeout(r, 100));
    // 全选 → 删除 → 输入
    await page.keyboard.down("Control");
    await page.keyboard.press("a");
    await page.keyboard.up("Control");
    await page.keyboard.press("Backspace");
    await new Promise(r => setTimeout(r, 100));
    await el.type(String(value), { delay });
  }

  // 填 First name
  const fnSelectors = ['input[placeholder*="first name" i]', 'input[placeholder*="Enter the first" i]', 'input[name*="first" i]'];
  for (const sel of fnSelectors) {
    const el = await page.$(sel);
    if (el) {
      await clearAndType(el, firstName);
      console.log(`${prefix}   ✓ First name: ${firstName}`);
      break;
    }
  }

  // 填 Last name
  const lnSelectors = ['input[placeholder*="last name" i]', 'input[placeholder*="Enter the last" i]', 'input[name*="last" i]'];
  for (const sel of lnSelectors) {
    const el = await page.$(sel);
    if (el) {
      await clearAndType(el, lastName);
      console.log(`${prefix}   ✓ Last name: ${lastName}`);
      break;
    }
  }

  // 填 Quantity — 用 nativeInputValueSetter 确保值精确覆盖
  console.log(`${prefix}   → 设置 Quantity: ${quantity}`);
  const qtySet = await page.evaluate((qty) => {
    // 找所有输入框，通过前面的 label 文本定位
    const allInputs = [...document.querySelectorAll("input")].filter(i => i.offsetParent !== null && i.type !== "search" && i.type !== "hidden");
    // 策略 1: 找 placeholder 包含 quantity 的
    for (const inp of allInputs) {
      if ((inp.placeholder || "").toLowerCase().includes("quantity") || (inp.name || "").toLowerCase().includes("quantity")) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        setter.call(inp, String(qty));
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        inp.dispatchEvent(new Event("change", { bubbles: true }));
        return `placeholder/name: ${inp.placeholder || inp.name}`;
      }
    }
    // 策略 2: 通过 "Quantity" label 旁边的 input
    const labels = [...document.querySelectorAll("label, span, div, p")];
    for (const lbl of labels) {
      const lt = (lbl.textContent || "").trim();
      if (/^[\*\s]*quantity\s*$/i.test(lt)) {
        // 找紧邻的 input
        const parent = lbl.closest("[class]") || lbl.parentElement;
        if (!parent) continue;
        const inp = parent.querySelector("input") || parent.nextElementSibling?.querySelector("input");
        if (inp) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
          setter.call(inp, String(qty));
          inp.dispatchEvent(new Event("input", { bubbles: true }));
          inp.dispatchEvent(new Event("change", { bubbles: true }));
          return `label: ${lt}`;
        }
      }
    }
    // 策略 3: 按表单中输入框顺序，第三个是 Quantity（First name, Last name, Quantity, Card balance）
    if (allInputs.length >= 3) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(allInputs[2], String(qty));
      allInputs[2].dispatchEvent(new Event("input", { bubbles: true }));
      allInputs[2].dispatchEvent(new Event("change", { bubbles: true }));
      return `index[2]: ${allInputs[2].placeholder || allInputs[2].value}`;
    }
    return null;
  }, quantity);
  console.log(`${prefix}   ✓ Quantity: ${quantity} (${qtySet || "未设置"})`);

  // 填 Card balance — 同样用 nativeInputValueSetter
  console.log(`${prefix}   → 设置 Card balance: $${balance}`);
  const balSet = await page.evaluate((bal) => {
    const allInputs = [...document.querySelectorAll("input")].filter(i => i.offsetParent !== null && i.type !== "search" && i.type !== "hidden");
    // 策略 1: placeholder/name
    for (const inp of allInputs) {
      if ((inp.placeholder || "").toLowerCase().includes("balance") || (inp.name || "").toLowerCase().includes("balance")) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        setter.call(inp, String(bal));
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        inp.dispatchEvent(new Event("change", { bubbles: true }));
        return `placeholder/name: ${inp.placeholder || inp.name}`;
      }
    }
    // 策略 2: label
    const labels = [...document.querySelectorAll("label, span, div, p")];
    for (const lbl of labels) {
      const lt = (lbl.textContent || "").trim();
      if (/^[\*\s]*card\s*balance\s*$/i.test(lt) || /^[\*\s]*balance\s*$/i.test(lt)) {
        const parent = lbl.closest("[class]") || lbl.parentElement;
        if (!parent) continue;
        const inp = parent.querySelector("input") || parent.nextElementSibling?.querySelector("input");
        if (inp) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
          setter.call(inp, String(bal));
          inp.dispatchEvent(new Event("input", { bubbles: true }));
          inp.dispatchEvent(new Event("change", { bubbles: true }));
          return `label: ${lt}`;
        }
      }
    }
    // 策略 3: 第四个输入框
    if (allInputs.length >= 4) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(allInputs[3], String(bal));
      allInputs[3].dispatchEvent(new Event("input", { bubbles: true }));
      allInputs[3].dispatchEvent(new Event("change", { bubbles: true }));
      return `index[3]: ${allInputs[3].placeholder || allInputs[3].value}`;
    }
    return null;
  }, balance);
  console.log(`${prefix}   ✓ Card balance: $${balance} (${balSet || "未设置"})`);

  await new Promise(r => setTimeout(r, 1000));
  await page.screenshot({ path: path.join(screenshotDir, `buvei-card-6-filled-${Date.now()}.png`), fullPage: true });

  // Step 7: 点击 "Issue Credit Card" 按钮
  console.log(`${prefix} → 点击 "Issue Credit Card"...`);
  const issueClicked = await page.evaluate(() => {
    const btns = [...document.querySelectorAll("button, a, [role='button'], [class*='btn']")];
    // 精确匹配 "Issue Credit Card"
    for (const btn of btns) {
      const t = (btn.textContent || "").trim();
      if (/issue\s*credit\s*card/i.test(t) && btn.offsetParent !== null && !btn.disabled) {
        btn.click();
        return t;
      }
    }
    // fallback: 包含 "issue" 的按钮
    for (const btn of btns) {
      const t = (btn.textContent || "").trim();
      if (t.length < 30 && t.toLowerCase().includes("issue") && btn.offsetParent !== null && !btn.disabled) {
        btn.click();
        return t;
      }
    }
    return null;
  });
  console.log(`${prefix}   → 结果: ${issueClicked || "(未找到)"}`);

  // Step 8: 处理支付密码确认弹窗
  await new Promise(r => setTimeout(r, 3000));

  // 检测是否出现支付密码弹窗
  const hasPinDialog = await page.evaluate(() => {
    const text = document.body?.innerText || "";
    return text.includes("password") || text.includes("Confirm") ||
           document.querySelectorAll('input[type="password"], input[type="tel"]').length > 2;
  });

  if (hasPinDialog) {
    const payPin = CONFIG.buveiPayPin;
    if (!payPin) {
      console.log(`${prefix}   ⚠ 出现支付密码弹窗，但未配置 BUVEI_PAY_PIN`);
      await page.screenshot({ path: path.join(screenshotDir, `buvei-card-7-need-pin-${Date.now()}.png`), fullPage: true });
      return null;
    }

    console.log(`${prefix} → 输入支付密码...`);
    // 支付密码通常是 6 个独立输入框（每框一位数字）
    const pinInputs = await page.$$('input[type="password"], input[type="tel"], input[type="number"]');
    const visiblePinInputs = [];
    for (const inp of pinInputs) {
      const vis = await inp.evaluate(e => e.offsetParent !== null);
      if (vis) visiblePinInputs.push(inp);
    }

    if (visiblePinInputs.length >= 6) {
      // 逐个输入 PIN 数字
      for (let i = 0; i < 6 && i < payPin.length; i++) {
        await visiblePinInputs[i].type(payPin[i], { delay: 50 });
      }
      console.log(`${prefix}   ✓ PIN 已输入（${visiblePinInputs.length} 格）`);
    } else if (visiblePinInputs.length >= 1) {
      // 可能是单个密码输入框
      await visiblePinInputs[0].type(payPin, { delay: 30 });
      console.log(`${prefix}   ✓ PIN 已输入（单框）`);
    } else {
      // 尝试直接键盘输入（焦点可能已在PIN框上）
      await page.keyboard.type(payPin, { delay: 50 });
      console.log(`${prefix}   ✓ PIN 键盘输入`);
    }

    await new Promise(r => setTimeout(r, 500));

    // 点击 "Confirm" 按钮
    const confirmClicked = await page.evaluate(() => {
      const btns = [...document.querySelectorAll("button, a, [role='button'], [class*='btn']")];
      for (const btn of btns) {
        const t = (btn.textContent || "").trim();
        if (/^confirm$/i.test(t) && btn.offsetParent !== null && !btn.disabled) {
          btn.click();
          return t;
        }
      }
      return null;
    });
    console.log(`${prefix}   → Confirm: ${confirmClicked || "(未找到)"}`);
  }

  // 等待开卡完成
  await new Promise(r => setTimeout(r, 8000));
  await page.screenshot({ path: path.join(screenshotDir, `buvei-card-8-result-${Date.now()}.png`), fullPage: true });

  // 检查是否有成功提示或错误
  const resultCheck = await page.evaluate(() => {
    const text = document.body?.innerText || "";
    const hasSuccess = text.includes("success") || text.includes("created") || text.includes("成功");
    const hasError = text.includes("error") || text.includes("fail") || text.includes("insufficient") ||
                    text.includes("余额不足") || text.includes("locked");
    return { hasSuccess, hasError, url: location.href, text: text.substring(0, 300) };
  });
  if (resultCheck.hasSuccess) console.log(`${prefix}   ✓ 开卡成功提示`);
  if (resultCheck.hasError) console.log(`${prefix}   ⚠ 可能有错误: ${resultCheck.text.substring(0, 100)}`);
  console.log(`${prefix}   URL: ${resultCheck.url}`);

  // Step 9: 提取新卡详情
  return await buveiExtractLatestCard(page, screenshotDir);
}

/**
 * 从 Buvei 后台提取最新创建的卡片信息
 */
async function buveiExtractLatestCard(page, screenshotDir) {
  const prefix = "[buvei-extract]";

  // 导航到 Dashboard，然后用侧边栏 "My Cards"
  console.log(`${prefix} → 通过侧边栏导航到 My Cards...`);
  await page.goto(`${CONFIG.buveiBaseUrl}/dashboard`, { waitUntil: "networkidle2", timeout: 30000 });
  await new Promise(r => setTimeout(r, 2000));

  // 打开侧边栏
  await page.evaluate(() => {
    const allEls = [...document.querySelectorAll("*")];
    for (const el of allEls) {
      const rect = el.getBoundingClientRect();
      if (rect.left < 80 && rect.top < 80 && rect.width > 15 && rect.width < 60 && rect.height < 60) {
        const hasSvg = el.querySelector("svg") || el.tagName === "SVG";
        const hasLines = (el.innerHTML || "").includes("line") || (el.innerHTML || "").includes("path");
        if (hasSvg || hasLines) { el.click(); return; }
      }
    }
  });
  await new Promise(r => setTimeout(r, 1500));

  // 点击 "My Cards"
  const myCardsClicked = await page.evaluate(() => {
    const allEls = [...document.querySelectorAll("a, div, span, li, [role='menuitem']")];
    for (const el of allEls) {
      const t = (el.textContent || "").trim();
      if (t.length < 20 && /my\s*cards/i.test(t) && el.offsetParent !== null) {
        el.click();
        return t;
      }
    }
    return null;
  });
  console.log(`${prefix}   → My Cards: ${myCardsClicked || "(未找到)"}`);
  await new Promise(r => setTimeout(r, 3000));
  await page.screenshot({ path: path.join(screenshotDir, `buvei-extract-1-mycards-${Date.now()}.png`), fullPage: true });

  // 点击最新的卡片查看详情
  const cardClicked = await page.evaluate(() => {
    // 找包含卡号 (****XXXX 或 238003****XXXX) 的元素
    const rows = [...document.querySelectorAll("tr, [class*='card'], [class*='item'], [class*='row'], div")];
    const cardRow = rows.find(r => {
      const t = r.textContent || "";
      return (/\*{4}\s*\d{4}|\d{4,6}\s*\*{4}/.test(t)) && r.offsetParent !== null && r.getBoundingClientRect().height < 200;
    });
    if (cardRow) {
      const detailBtn = cardRow.querySelector("a, button, [class*='detail'], [class*='view']");
      if (detailBtn) { detailBtn.click(); return `detail: ${(detailBtn.textContent || "").trim().substring(0, 20)}`; }
      cardRow.click();
      return `row: ${(cardRow.textContent || "").trim().substring(0, 40)}`;
    }
    return null;
  });

  if (cardClicked) {
    console.log(`${prefix}   ✓ 点击卡片: ${cardClicked}`);
    await new Promise(r => setTimeout(r, 3000));
    await page.screenshot({ path: path.join(screenshotDir, `buvei-extract-2-detail-${Date.now()}.png`), fullPage: true });
  }

  // 提取卡片信息
  console.log(`${prefix} → 提取卡片信息...`);
  const cardInfo = await page.evaluate(() => {
    const text = document.body?.innerText || "";

    // 提取完整卡号（16 位数字，可能有空格）
    const numberMatch = text.match(/\b(\d{4}\s?\d{4}\s?\d{4}\s?\d{4})\b/);
    // 提取 CVV/CVC（3-4 位，通常在 "CVV" 或 "CVC" 旁边）
    const cvvMatch = text.match(/(?:CVV|CVC|CVV2|Security\s*Code|安全码)[:\s]*(\d{3,4})/i) ||
                     text.match(/\b(\d{3})\b(?=\s*(?:Expir|有效|Valid|$))/);
    // 提取过期日期 (MM/YY 或 MM/YYYY)
    const expiryMatch = text.match(/(?:Expir|Valid|有效期|到期)[^0-9]*(\d{2}[\/\-]\d{2,4})/i) ||
                        text.match(/\b(\d{2}\/\d{2,4})\b/);

    // 也尝试从 input/span 元素获取
    let number = numberMatch ? numberMatch[1].replace(/\s/g, "") : "";
    let cvv = cvvMatch ? cvvMatch[1] : "";
    let expiry = expiryMatch ? expiryMatch[1] : "";

    if (!number) {
      // 从 input 获取
      const inputs = [...document.querySelectorAll("input, [class*='card-number'], [class*='cardNumber']")];
      for (const inp of inputs) {
        const val = (inp.value || inp.textContent || "").replace(/\s/g, "");
        if (/^\d{16}$/.test(val)) { number = val; break; }
      }
    }

    // 尝试从 data 属性获取
    if (!number) {
      const els = [...document.querySelectorAll("[data-card-number], [data-number]")];
      for (const el of els) {
        const val = (el.getAttribute("data-card-number") || el.getAttribute("data-number") || "").replace(/\s/g, "");
        if (/^\d{16}$/.test(val)) { number = val; break; }
      }
    }

    // 查找 "显示" / "Show" / "Reveal" 按钮（卡号可能被隐藏）
    const revealBtns = [...document.querySelectorAll("button, [role='button'], a, span[class*='eye'], [class*='reveal'], [class*='show']")];
    const hasReveal = revealBtns.some(b => {
      const t = (b.textContent || "").toLowerCase();
      return t.includes("show") || t.includes("reveal") || t.includes("显示") || t.includes("查看");
    });

    return { number, cvv, expiry, hasReveal, pageText: text.substring(0, 500) };
  });

  console.log(`${prefix}   卡号: ${cardInfo.number || "(未获取)"}`);
  console.log(`${prefix}   CVV: ${cardInfo.cvv || "(未获取)"}`);
  console.log(`${prefix}   过期: ${cardInfo.expiry || "(未获取)"}`);

  // 如果有 "显示" 按钮，点击它来显示完整卡号
  if (cardInfo.hasReveal && !cardInfo.number) {
    console.log(`${prefix}   → 点击显示/Reveal 按钮...`);
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll("button, [role='button'], a, span, [class*='eye']")];
      const revealBtns = btns.filter(b => {
        const t = (b.textContent || "").toLowerCase();
        return (t.includes("show") || t.includes("reveal") || t.includes("显示") || t.includes("查看") ||
                b.className.toLowerCase().includes("eye") || b.className.toLowerCase().includes("reveal"));
      });
      revealBtns.forEach(b => b.click());
    });

    await new Promise(r => setTimeout(r, 2000));
    await page.screenshot({ path: path.join(screenshotDir, `buvei-extract-3-revealed-${Date.now()}.png`), fullPage: true });

    // 再次提取
    const revealed = await page.evaluate(() => {
      const text = document.body?.innerText || "";
      const numberMatch = text.match(/\b(\d{4}\s?\d{4}\s?\d{4}\s?\d{4})\b/);
      const cvvMatch = text.match(/(?:CVV|CVC|CVV2|Security\s*Code|安全码)[:\s]*(\d{3,4})/i);
      const expiryMatch = text.match(/(?:Expir|Valid|有效期|到期)[^0-9]*(\d{2}[\/\-]\d{2,4})/i) ||
                          text.match(/\b(\d{2}\/\d{2,4})\b/);
      return {
        number: numberMatch ? numberMatch[1].replace(/\s/g, "") : "",
        cvv: cvvMatch ? cvvMatch[1] : "",
        expiry: expiryMatch ? expiryMatch[1] : "",
      };
    });

    if (revealed.number) cardInfo.number = revealed.number;
    if (revealed.cvv) cardInfo.cvv = revealed.cvv;
    if (revealed.expiry) cardInfo.expiry = revealed.expiry;

    console.log(`${prefix}   (revealed) 卡号: ${cardInfo.number || "(未获取)"}`);
    console.log(`${prefix}   (revealed) CVV: ${cardInfo.cvv || "(未获取)"}`);
    console.log(`${prefix}   (revealed) 过期: ${cardInfo.expiry || "(未获取)"}`);
  }

  if (!cardInfo.number) {
    console.log(`${prefix}   ⚠ 无法自动提取卡号，页面内容: ${cardInfo.pageText.substring(0, 200)}`);
    return null;
  }

  const card = {
    number: cardInfo.number,
    expiry: cardInfo.expiry || "",
    cvc: cardInfo.cvv || "",
    zip: "10001",
    source: "buvei",
    status: "available",
    createdAt: new Date().toISOString(),
  };

  // 保存到 VCC 池
  const pool = loadVccPool();
  const exists = pool.cards.some(c => c.number === card.number);
  if (!exists) {
    pool.cards.push(card);
    saveVccPool(pool);
    console.log(`${prefix}   ✓ 卡片已保存到 VCC 池 (共 ${pool.cards.length} 张)`);
  }

  return card;
}

/**
 * 完整流程：开浏览器 → 登录 Buvei → 创建卡 → 提取详情 → 保存
 */
async function buveiProvisionCard(options = {}) {
  const prefix = "[buvei-provision]";

  let connect;
  try {
    const mod = await import("puppeteer-real-browser");
    connect = mod.connect;
  } catch {
    console.error(`${prefix} ✗ 请先安装: npm install puppeteer-real-browser`);
    return null;
  }

  const chromePaths = process.platform === "win32"
    ? [
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      ]
    : ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium-browser"];
  let chromePath = process.env.CHROME_PATH || null;
  if (!chromePath) { for (const p of chromePaths) { if (fs.existsSync(p)) { chromePath = p; break; } } }

  const screenshotDir = path.join(PROJECT_ROOT, "screenshots", "buvei");
  fs.mkdirSync(screenshotDir, { recursive: true });

  const { browser, page } = await connect({
    headless: false, turnstile: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--window-size=1280,800"],
    customConfig: chromePath ? { chromePath } : {},
    fingerprint: true,
  });

  try {
    // 登录
    const loggedIn = await buveiLogin(page, screenshotDir);
    if (!loggedIn) return null;

    // 如果只是探测模式（了解页面结构）
    if (options.probe) {
      console.log(`${prefix} → 探测模式：截图并分析页面结构`);
      // 访问各个可能的页面并截图
      const probeUrls = [
        "/dashboard", "/card", "/card/list", "/card/create", "/card/new",
        "/cards", "/wallet", "/billing", "/settings",
      ];
      for (const p of probeUrls) {
        try {
          const resp = await page.goto(`${CONFIG.buveiBaseUrl}${p}`, { waitUntil: "networkidle2", timeout: 10000 });
          const status = resp ? resp.status() : "?";
          const finalUrl = page.url();
          const safeName = p.replace(/\//g, "_");
          await page.screenshot({ path: path.join(screenshotDir, `probe${safeName}-${status}-${Date.now()}.png`), fullPage: true });
          console.log(`${prefix}   ${p} → ${status} → ${finalUrl}`);
          await new Promise(r => setTimeout(r, 1000));
        } catch (err) {
          console.log(`${prefix}   ${p} → ERR: ${err.message}`);
        }
      }
      console.log(`${prefix} ✓ 截图已保存到: ${screenshotDir}`);
      return null;
    }

    // 创建卡片
    const card = await buveiCreateCard(page, screenshotDir, options);
    if (!card) {
      console.log(`${prefix} ✗ 开卡失败，请检查 screenshots/buvei/ 下的截图`);
      return null;
    }

    console.log(`${prefix} ✓ 新卡: **** **** **** ${card.number.slice(-4)}`);
    return card;
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * 批量开卡
 */
async function buveiBatchProvision(count, options = {}) {
  const prefix = "[buvei-batch]";
  const delay = options.delay || 10;

  console.log(`${prefix} ═══════════════════════════════════════`);
  console.log(`${prefix} 批量开卡: ${count} 张`);
  console.log(`${prefix} ═══════════════════════════════════════`);

  let success = 0, failed = 0;
  const cards = [];

  for (let i = 0; i < count; i++) {
    console.log(`\n${prefix} ──── 第 ${i + 1}/${count} 张 ────`);
    try {
      const card = await buveiProvisionCard(options);
      if (card) {
        success++;
        cards.push(card);
        console.log(`${prefix}   ✓ ${card.number.slice(-4)}`);
      } else {
        failed++;
      }
    } catch (err) {
      failed++;
      console.error(`${prefix}   ✗ ${err.message}`);
    }

    if (i < count - 1) {
      const jitter = delay * 1000 + Math.random() * 5000;
      console.log(`${prefix} 等待 ${(jitter / 1000).toFixed(1)} 秒...`);
      await new Promise(r => setTimeout(r, jitter));
    }
  }

  console.log(`\n${prefix} ═══════════════════════════════════════`);
  console.log(`${prefix} 完成: ✓${success} ✗${failed}`);
  if (cards.length) {
    console.log(`${prefix} 新卡: ${cards.map(c => "*" + c.number.slice(-4)).join(", ")}`);
  }
  console.log(`${prefix} ═══════════════════════════════════════`);

  return { success, failed, cards };
}

// ============================================================
// 方案 E：Pro Trial 激活（登录 → 定价页 → Stripe 绑卡）
// ============================================================

/**
 * 在已登录的 page 上激活 Pro Trial
 * 流程：导航到 pricing → 点击 Start Free Trial → Stripe Checkout 填 VCC → 确认
 */
async function activateProTrialOnPage(page, vcc, screenshotDir) {
  const prefix = "[pro-trial]";

  // Step 1: 导航到定价页
  console.log(`${prefix} → 导航到定价页...`);
  await page.goto(CONFIG.pricingUrl, { waitUntil: "networkidle2", timeout: 60000 });
  await new Promise(r => setTimeout(r, 3000));

  // 先滚动页面确保所有元素加载
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    for (let y = 0; y <= document.body.scrollHeight; y += 300) {
      window.scrollTo(0, y);
    }
    window.scrollTo(0, 0);
  });
  await new Promise(r => setTimeout(r, 2000));

  // 等待 "Select plan" 或 "Start Free Trial" 按钮出现（最多 90 秒）
  console.log(`${prefix}   → 等待 Select plan / Start Free Trial 按钮加载...`);
  for (let w = 0; w < 90; w++) {
    const found = await page.evaluate(() => {
      const els = [...document.querySelectorAll("button, a, [role='button'], div")];
      return els.some(el => {
        const t = (el.textContent || "").trim().toLowerCase();
        return (t === "select plan" || t === "start free trial") && el.offsetParent !== null;
      });
    });
    if (found) {
      console.log(`${prefix}   ✓ 按钮已出现 (${w + 1}s)`);
      break;
    }
    if (w === 15) console.log(`${prefix}   → 仍在等待按钮加载... (15s)`);
    if (w === 30) console.log(`${prefix}   → 仍在等待... (30s)`);
    if (w === 60) console.log(`${prefix}   → 仍在等待... (60s)`);
    if (w === 89) console.log(`${prefix}   ⚠ 90s 后仍未找到按钮`);
    await new Promise(r => setTimeout(r, 1000));
  }

  await page.screenshot({ path: path.join(screenshotDir, `trial-1-pricing-${Date.now()}.png`), fullPage: true });

  // 诊断定价页
  const pricingInfo = await page.evaluate(() => {
    // 扩大选择器范围：包括 div/span/role=button
    const selectors = "button, a, [role='button'], [class*='button'], [class*='btn']";
    const buttons = [...document.querySelectorAll(selectors)].map(el => ({
      tag: el.tagName, text: (el.textContent || "").trim().substring(0, 60),
      href: el.href || "", visible: el.offsetParent !== null,
      classes: el.className?.toString?.()?.substring(0, 80) || "",
    }));
    const headings = [...document.querySelectorAll("h1,h2,h3,h4")].map(el => el.textContent?.trim());
    // 额外诊断：搜索所有包含 "select" 或 "plan" 的可见元素
    const selectPlanEls = [...document.querySelectorAll("*")].filter(el => {
      const t = (el.textContent || "").trim().toLowerCase();
      return (t === "select plan" || t === "select") && el.offsetParent !== null && el.children.length === 0;
    }).map(el => ({
      tag: el.tagName, text: el.textContent?.trim(), classes: el.className?.toString?.()?.substring(0, 80) || "",
      parentTag: el.parentElement?.tagName, parentClasses: el.parentElement?.className?.toString?.()?.substring(0, 80) || "",
    }));
    return { buttons: buttons.filter(b => b.visible), headings, url: location.href, selectPlanEls };
  });
  console.log(`${prefix}   URL: ${pricingInfo.url}`);
  console.log(`${prefix}   标题: ${JSON.stringify(pricingInfo.headings.slice(0, 5))}`);
  const trialButtons = pricingInfo.buttons.filter(b =>
    /trial|start|select.plan|upgrade|pro/i.test(b.text)
  );
  console.log(`${prefix}   试用相关按钮: ${trialButtons.map(b => `"${b.text}" (${b.tag})`).join(", ") || "无"}`);
  if (pricingInfo.selectPlanEls?.length > 0) {
    console.log(`${prefix}   "Select plan" 元素: ${JSON.stringify(pricingInfo.selectPlanEls)}`);
  } else {
    console.log(`${prefix}   ⚠ 未找到 "Select plan" 文字元素`);
    console.log(`${prefix}   所有按钮: ${pricingInfo.buttons.map(b => `${b.tag}:"${b.text}"`).join(" | ")}`);
  }

  // Step 2: 点击 "Start Free Trial" 或 "Select Plan" (Pro)
  console.log(`${prefix} → 点击 Pro Trial 按钮...`);
  const clickResult = await page.evaluate(() => {
    const allEls = [...document.querySelectorAll("button, a, [role='button'], [class*='button'], [class*='btn'], [class*='cta']")];
    // 也搜索包含确切 "Select plan" 文字的叶子节点的父级可点击元素
    const leafEls = [...document.querySelectorAll("*")].filter(el => {
      const t = (el.textContent || "").trim().toLowerCase();
      return t === "select plan" && el.offsetParent !== null;
    });
    for (const leaf of leafEls) {
      if (!allEls.includes(leaf)) {
        // 加入叶子节点本身和其可点击的父元素
        allEls.push(leaf);
        let p = leaf.parentElement;
        for (let d = 0; d < 5 && p; d++) {
          if (p.tagName === 'A' || p.tagName === 'BUTTON' || p.getAttribute('role') === 'button'
            || p.style?.cursor === 'pointer' || p.onclick) {
            if (!allEls.includes(p)) allEls.push(p);
          }
          p = p.parentElement;
        }
      }
    }
    // 优先找 "Start Free Trial" — 只匹配短文本的 BUTTON/A，避免点击大容器 DIV
    const priorities = [
      "start free trial", "start trial", "free trial",
      "select plan", "try pro", "upgrade to pro", "get started",
    ];
    for (const keyword of priorities) {
      // 优先匹配 button/a 标签（真正可交互的元素）
      const preferredTags = ["BUTTON", "A"];
      const candidates = allEls.filter(e => {
        const t = (e.textContent || "").toLowerCase().trim();
        return t.includes(keyword) && t.length < 50 && e.offsetParent !== null;
      });
      // 先找 button/a，再找其他
      const el = candidates.find(c => preferredTags.includes(c.tagName))
              || candidates.find(c => c.children.length === 0)
              || candidates[0];
      if (el) {
        const parent = el.closest("[class*='pro'], [class*='Pro'], [data-plan='pro']") || el.parentElement;
        const parentText = (parent?.textContent || "").toLowerCase();
        const isProSection = parentText.includes("$15") || parentText.includes("pro") || parentText.includes("500");
        if (el.href) {
          location.href = el.href;
        } else {
          el.click();
        }
        return { clicked: (el.textContent || "").trim().substring(0, 50), tag: el.tagName, isProSection, keyword };
      }
    }
    // 兜底：找包含 "$15" 附近的按钮
    for (const el of allEls) {
      const card = el.closest("div[class*='card'], div[class*='plan'], section");
      if (card && card.textContent?.includes("$15") && el.offsetParent !== null) {
        const t = (el.textContent || "").trim();
        if (t.length < 30 && /select|start|get|try|upgrade/i.test(t)) {
          if (el.href) location.href = el.href;
          else el.click();
          return { clicked: t, fallback: true };
        }
      }
    }
    return null;
  });

  if (!clickResult) {
    console.log(`${prefix}   ✗ 未找到 Pro Trial 按钮`);
    await page.screenshot({ path: path.join(screenshotDir, `trial-2-no-button-${Date.now()}.png`), fullPage: true });
    return { success: false, error: "no_trial_button" };
  }
  console.log(`${prefix}   ✓ 点击: ${JSON.stringify(clickResult)}`);

  // Step 2.5: 处理 "Start your free trial" 模态框 (Turnstile CAPTCHA + Continue)
  console.log(`${prefix} → 检测 Trial 模态框...`);
  await new Promise(r => setTimeout(r, 3000));

  // 先关闭 Cookie 弹窗（如果有）
  await page.evaluate(() => {
    const cookieBtn = [...document.querySelectorAll("button")].find(b =>
      /accept all|accept/i.test((b.textContent || "").trim()) && b.offsetParent !== null
    );
    if (cookieBtn) cookieBtn.click();
  });
  await new Promise(r => setTimeout(r, 1000));

  // 检测 Turnstile CAPTCHA 并用 CapSolver 解决
  console.log(`${prefix} → 处理 Turnstile CAPTCHA...`);

  // 提取 sitekey
  const sitekey = await page.evaluate(() => {
    const el = document.querySelector('[data-sitekey], .cf-turnstile');
    if (el) return el.getAttribute('data-sitekey');
    const iframes = [...document.querySelectorAll('iframe[src*="turnstile"]')];
    for (const f of iframes) {
      const m = f.src.match(/sitekey=([^&]+)/);
      if (m) return m[1];
    }
    // 从页面 script 标签中找
    const scripts = document.querySelectorAll('script');
    for (const s of scripts) {
      const m = (s.textContent || '').match(/sitekey['":\s]+['"]([0-9a-zA-Zx_-]+)['"]/);
      if (m) return m[1];
    }
    return null;
  }) || "0x4AAAAAAA447Bur1xJStKg5"; // 回退到已知 sitekey

  console.log(`${prefix}   sitekey: ${sitekey}`);

  // 先等 5s 看是否自动通过
  let turnstilePassed = false;
  for (let i = 0; i < 5; i++) {
    const st = await page.evaluate(() => {
      const body = document.body?.innerText || "";
      if (body.includes("Success!")) return "success";
      const inp = document.querySelector('input[name="cf-turnstile-response"]');
      if (inp?.value) return "success";
      return "waiting";
    });
    if (st === "success") { turnstilePassed = true; break; }
    await new Promise(r => setTimeout(r, 1000));
  }

  if (!turnstilePassed && CONFIG.capsolverApiKey) {
    console.log(`${prefix}   → CapSolver 解题...`);
    const turnstileToken = await solveTurnstileWithCapSolver(page.url(), sitekey);

    if (turnstileToken) {
      console.log(`${prefix}   ✓ Token 获取成功 (${turnstileToken.substring(0, 30)}...)`);

      // 多种策略注入 Turnstile token
      const injectResult = await page.evaluate((token) => {
        const results = [];
        try {
          // 策略 1: window.turnstile API
          if (window.turnstile) {
            const widgetIds = Object.keys(window.turnstile._widgets || {});
            if (widgetIds.length > 0) {
              for (const id of widgetIds) {
                const w = window.turnstile._widgets[id];
                if (w && w.callback) {
                  w.callback(token);
                  results.push("called:turnstile_widget_callback");
                }
              }
            }
          }

          // 策略 2: 找 Turnstile iframe 同级的隐藏 input 并设值
          const inputs = document.querySelectorAll('input[name="cf-turnstile-response"], input[name*="turnstile"]');
          for (const inp of inputs) {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
            setter.call(inp, token);
            inp.dispatchEvent(new Event("input", { bubbles: true }));
            inp.dispatchEvent(new Event("change", { bubbles: true }));
            results.push("set:hidden_input:" + inp.name);
          }

          // 策略 3: React fiber 遍历找 onVerify（扫描所有 DOM 元素）
          let onVerifyFn = null;
          const allEls = document.querySelectorAll("div, section, form, button");
          for (const el of allEls) {
            const fk = Object.keys(el).find(k => k.startsWith("__reactFiber"));
            if (!fk) continue;
            let fiber = el[fk];
            for (let d = 0; d < 15 && fiber; d++) {
              const props = fiber.memoizedProps || {};
              if (typeof props.onVerify === "function" && !onVerifyFn) {
                onVerifyFn = props.onVerify;
                results.push("found:onVerify@depth" + d);
              }
              // 也找 onSuccess / onCallback / onChange
              for (const key of ["onSuccess", "onCallback", "onChange"]) {
                if (typeof props[key] === "function") {
                  try { props[key](token); results.push("called:" + key); } catch {}
                }
              }
              fiber = fiber.return;
            }
            if (onVerifyFn) break;
          }
          if (onVerifyFn) {
            try { onVerifyFn(token); results.push("called:onVerify"); } catch(e) { results.push("err:onVerify:" + e.message); }
          }

          // 策略 4: 找 Turnstile 的 cf_turnstile.execute 回调
          if (typeof window.__CF$cv$params === "object") {
            const cbs = window.__CF$cv$params;
            for (const key of Object.keys(cbs)) {
              if (typeof cbs[key] === "function") {
                try { cbs[key](token); results.push("called:CF_callback:" + key); } catch {}
              }
            }
          }

          // 策略 5: 强制启用 Continue 按钮
          const btns = [...document.querySelectorAll("button")];
          const continueBtn = btns.find(b => (b.textContent || "").trim().toLowerCase() === "continue");
          if (continueBtn) {
            continueBtn.disabled = false;
            continueBtn.removeAttribute("disabled");
            continueBtn.style.pointerEvents = "auto";
            continueBtn.style.opacity = "1";
            // 移除父元素的 disabled 状态
            const parent = continueBtn.parentElement;
            if (parent) {
              parent.style.pointerEvents = "auto";
              parent.style.opacity = "1";
            }
            results.push("enabled:continueBtn");
          }
        } catch (e) {
          results.push("error:" + e.message);
        }
        return results;
      }, turnstileToken);

      console.log(`${prefix}   注入结果: ${JSON.stringify(injectResult)}`);
      await new Promise(r => setTimeout(r, 2000));
    } else {
      console.log(`${prefix}   ✗ CapSolver 解题失败`);
    }
  } else if (turnstilePassed) {
    console.log(`${prefix}   ✓ Turnstile 自动通过`);
  }

  await page.screenshot({ path: path.join(screenshotDir, `trial-2-turnstile-${Date.now()}.png`), fullPage: true });

  // 点击 "Continue" 按钮
  console.log(`${prefix} → 点击 Continue...`);
  await new Promise(r => setTimeout(r, 500));
  const continueClicked = await page.evaluate(() => {
    const btns = [...document.querySelectorAll("button")];
    const continueBtn = btns.find(b => {
      const t = (b.textContent || "").trim().toLowerCase();
      return t === "continue" && b.offsetParent !== null;
    });
    if (continueBtn) {
      // 强制启用并点击
      continueBtn.disabled = false;
      continueBtn.removeAttribute("disabled");
      continueBtn.click();
      return true;
    }
    return false;
  });

  if (continueClicked) {
    console.log(`${prefix}   ✓ Continue 已点击`);
  } else {
    console.log(`${prefix}   ⚠ 未找到 Continue 按钮`);
  }

  // 等待跳转到 Stripe Checkout
  console.log(`${prefix} → 等待 Stripe Checkout 跳转...`);
  await new Promise(r => setTimeout(r, 5000));
  await page.screenshot({ path: path.join(screenshotDir, `trial-2-after-continue-${Date.now()}.png`), fullPage: true });

  // Step 3: 检查是否进入 Stripe Checkout
  const currentUrl = page.url();
  console.log(`${prefix}   当前 URL: ${currentUrl}`);

  const isStripeCheckout = currentUrl.includes("checkout.stripe.com");
  const hasStripeEmbed = await page.evaluate(() => {
    return document.querySelectorAll('iframe[src*="stripe"], iframe[name*="stripe"]').length > 0
      || document.querySelector('[class*="StripeElement"], #payment-element, [data-stripe]') !== null
      || location.href.includes("stripe");
  });

  console.log(`${prefix}   Stripe Checkout: ${isStripeCheckout} | Stripe 嵌入: ${hasStripeEmbed}`);

  // Step 4: 填写 Stripe 支付信息
  if (isStripeCheckout) {
    return await fillStripeCheckoutPage(page, vcc, screenshotDir);
  } else if (hasStripeEmbed) {
    return await fillStripeEmbedded(page, vcc, screenshotDir);
  } else {
    // 可能还在中间页面，等待更长时间看是否跳转
    const pageText = await page.evaluate(() => (document.body?.innerText || "").substring(0, 500));
    console.log(`${prefix}   页面内容: ${pageText.substring(0, 200)}`);

    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const url = page.url();
      if (url.includes("stripe") || url.includes("checkout") || url.includes("billing")) {
        console.log(`${prefix}   → 页面跳转到: ${url}`);
        await new Promise(r => setTimeout(r, 3000));
        if (url.includes("checkout.stripe.com")) {
          return await fillStripeCheckoutPage(page, vcc, screenshotDir);
        }
        const hasEmbed = await page.evaluate(() => {
          return document.querySelectorAll('iframe[src*="stripe"]').length > 0
            || document.querySelector('[class*="StripeElement"]') !== null;
        });
        if (hasEmbed) return await fillStripeEmbedded(page, vcc, screenshotDir);
        break;
      }
    }

    await page.screenshot({ path: path.join(screenshotDir, `trial-3-unknown-${Date.now()}.png`), fullPage: true });
    return { success: false, error: "no_stripe_page", url: page.url() };
  }
}

/**
 * 填写 Stripe Checkout 页面（独立页面模式 checkout.stripe.com）
 */
async function fillStripeCheckoutPage(page, vcc, screenshotDir) {
  const prefix = "[stripe]";
  console.log(`${prefix} → Stripe Checkout 页面模式`);
  await new Promise(r => setTimeout(r, 3000));
  await page.screenshot({ path: path.join(screenshotDir, `stripe-1-loaded-${Date.now()}.png`), fullPage: true });

  // Stripe Checkout 页面的输入框直接在主文档中（不在 iframe）
  // 但卡号/过期/CVC 可能在 Stripe Elements iframe 中
  const pageInfo = await page.evaluate(() => {
    const inputs = [...document.querySelectorAll("input")].map(i => ({
      name: i.name, id: i.id, placeholder: i.placeholder, type: i.type,
      ariaLabel: i.getAttribute("aria-label") || "",
      visible: i.offsetParent !== null,
    }));
    const iframes = [...document.querySelectorAll("iframe")].map(f => ({
      src: (f.src || "").substring(0, 100), name: f.name, title: f.title || "",
    }));
    return { inputs: inputs.filter(i => i.visible), iframes };
  });

  console.log(`${prefix}   输入框: ${pageInfo.inputs.map(i => `${i.name||i.id||i.placeholder||i.ariaLabel}`).join(", ") || "无"}`);
  console.log(`${prefix}   iframes: ${pageInfo.iframes.length}`);

  // 尝试直接在主页面填写（Stripe Checkout 独立页面模式）
  let filled = false;

  // 先取消 "Save my information" (Stripe Link)，避免 Link 弹窗拦截支付
  try {
    const stripePassUnchecked = await page.evaluate(() => {
      // 方式 1: 直接点击 input
      const input = document.querySelector('input[name="enableStripePass"]');
      if (input && input.checked) {
        input.click();
        if (!input.checked) return 'input_click';
      }
      // 方式 2: 点击包裹的 label
      if (input) {
        const label = input.closest('label') || document.querySelector('label[for="enableStripePass"]');
        if (label) { label.click(); return 'label_click'; }
      }
      // 方式 3: 点击包含 "Save my information" 的区域
      const saveInfo = [...document.querySelectorAll('div, label, span')].find(el => {
        const t = (el.textContent || '').trim();
        return t.includes('Save my information') && el.querySelector('input[type="checkbox"]');
      });
      if (saveInfo) {
        const cb = saveInfo.querySelector('input[type="checkbox"]');
        if (cb && cb.checked) { cb.click(); return 'container_click'; }
      }
      return input ? (input.checked ? 'still_checked' : 'already_unchecked') : 'not_found';
    });
    console.log(`${prefix}   Stripe Link uncheck: ${stripePassUnchecked}`);
    await new Promise(r => setTimeout(r, 500));
  } catch (e) {
    console.log(`${prefix}   ⚠ Stripe Link uncheck error: ${e.message}`);
  }

  // 尝试直接填写卡号
  const cardSelectors = [
    'input[name="cardNumber"]', 'input[name="number"]',
    'input[id="cardNumber"]', 'input[placeholder*="card number" i]',
    'input[autocomplete="cc-number"]', 'input[data-elements-stable-field-name="cardNumber"]',
  ];
  for (const sel of cardSelectors) {
    const el = await page.$(sel);
    if (el) {
      await el.click({ clickCount: 3 });
      await el.type(vcc.number, { delay: 50 });
      console.log(`${prefix}   ✓ 卡号 (${sel})`);
      filled = true;
      break;
    }
  }

  // 填写过期日期、CVC、账单姓名、邮编（Stripe Checkout 独立页面有这些字段）
  if (filled) {
    await new Promise(r => setTimeout(r, 500));

    // 过期日期
    const expirySelectors = ['input[name="cardExpiry"]', 'input[name="exp-date"]', 'input[autocomplete="cc-exp"]'];
    for (const sel of expirySelectors) {
      const el = await page.$(sel);
      if (el) {
        await el.click({ clickCount: 3 });
        await el.type(vcc.expiry, { delay: 50 });
        console.log(`${prefix}   ✓ 过期日期 (${sel})`);
        break;
      }
    }
    await new Promise(r => setTimeout(r, 300));

    // CVC
    const cvcSelectors = ['input[name="cardCvc"]', 'input[name="cvc"]', 'input[autocomplete="cc-csc"]'];
    for (const sel of cvcSelectors) {
      const el = await page.$(sel);
      if (el) {
        await el.click({ clickCount: 3 });
        await el.type(vcc.cvc, { delay: 50 });
        console.log(`${prefix}   ✓ CVC (${sel})`);
        break;
      }
    }
    await new Promise(r => setTimeout(r, 500));

    // 选国家 = Singapore
    console.log(`${prefix}   → 选择国家 SG...`);
    await page.evaluate(() => {
      const sel = document.querySelector('select[name="billingCountry"]');
      if (sel) { sel.value = "SG"; sel.dispatchEvent(new Event("change", { bubbles: true })); }
    });
    await new Promise(r => setTimeout(r, 1500));

    // 点击"手动输入地址"链接（避免 Google 地址自动补全）
    const manualAddrClicked = await page.evaluate(() => {
      const all = [...document.querySelectorAll("a, button, span, div, p")];
      for (const el of all) {
        const t = (el.textContent || "").trim();
        if ((t === "Enter address manually" || t === "enter address manually" ||
             t === "Enter an address manually" || t.includes("Enter address") ||
             t.includes("manually")) && el.offsetParent !== null) {
          el.click();
          return t;
        }
      }
      return null;
    });
    console.log(`${prefix}   手动地址: ${manualAddrClicked || "(未找到链接，直接填写)"}`);
    await new Promise(r => setTimeout(r, 1500));

    // 账单地址（Address line 1）
    const addrSelectors = [
      'input[name="billingAddressLine1"]', 'input[name="addressLine1"]',
      'input[name="address"]', 'input[placeholder="Address"]',
    ];
    for (const sel of addrSelectors) {
      const el = await page.$(sel);
      if (el) {
        await el.click({ clickCount: 3 });
        await el.type("1 Raffles Place #01-01", { delay: 30 });
        // Escape 关闭 Google 地址自动补全下拉
        await page.keyboard.press("Escape");
        await new Promise(r => setTimeout(r, 300));
        console.log(`${prefix}   ✓ 地址 (${sel})`);
        break;
      }
    }
    await new Promise(r => setTimeout(r, 800));

    // 邮编
    if (vcc.zip) {
      const zipSelectors = [
        'input[name="billingPostalCode"]', 'input[name="postalCode"]',
        'input[name="postal"]', 'input[name="zip"]', 'input[autocomplete="postal-code"]',
      ];
      for (const sel of zipSelectors) {
        const el = await page.$(sel);
        if (el) {
          await el.click({ clickCount: 3 });
          await el.type(vcc.zip || '048616', { delay: 50 });
          await page.keyboard.press("Escape");
          console.log(`${prefix}   ✓ 邮编 (${sel})`);
          break;
        }
      }
    }
    await new Promise(r => setTimeout(r, 500));

    // 账单姓名（最后填，避免被地址自动补全覆盖清空）
    const nameSelectors = ['input[name="billingName"]', 'input[name="name"]', 'input[autocomplete="name"]'];
    for (const sel of nameSelectors) {
      const el = await page.$(sel);
      if (el) {
        await el.click({ clickCount: 3 });
        await new Promise(r => setTimeout(r, 200));
        await el.type("ZIJIAN XUE", { delay: 50 });
        console.log(`${prefix}   ✓ 姓名 (${sel})`);
        // 验证是否真的填上了
        const val = await page.evaluate(s => document.querySelector(s)?.value || "", sel);
        if (!val) {
          console.log(`${prefix}   ⚠ 姓名为空，重试...`);
          await el.focus();
          await page.keyboard.type("ZIJIAN XUE", { delay: 50 });
        }
        break;
      }
    }
    await new Promise(r => setTimeout(r, 300));
  }

  // 如果主页面没有卡号字段，尝试在 Stripe iframe 中填写
  if (!filled) {
    filled = await fillStripeIframes(page, vcc, screenshotDir);
  }

  if (!filled) {
    // 兜底：Tab 顺序填写
    console.log(`${prefix}   → 尝试 Tab 顺序填写...`);
    const firstInput = await page.$("input:not([type='hidden']):not([type='email'])");
    if (firstInput) {
      await firstInput.click();
      await firstInput.type(vcc.number, { delay: 50 });
      await page.keyboard.press("Tab");
      await new Promise(r => setTimeout(r, 300));
      await page.keyboard.type(vcc.expiry, { delay: 50 });
      await page.keyboard.press("Tab");
      await new Promise(r => setTimeout(r, 300));
      await page.keyboard.type(vcc.cvc, { delay: 50 });
      await page.keyboard.press("Tab");
      await new Promise(r => setTimeout(r, 300));
      if (vcc.zip) {
        await page.keyboard.type(vcc.zip, { delay: 50 });
      }
      filled = true;
      console.log(`${prefix}   ✓ Tab 顺序填写完成`);
    }
  }

  if (!filled) {
    console.log(`${prefix}   ✗ 无法填写支付信息`);
    return { success: false, error: "cannot_fill_stripe" };
  }

  await new Promise(r => setTimeout(r, 1000));

  // 关闭 Stripe Link 弹窗（如果出现）
  const linkDismissed = await page.evaluate(() => {
    const btns = [...document.querySelectorAll("button, a")];
    const cancelBtn = btns.find(b => {
      const t = (b.textContent || "").trim().toLowerCase();
      return t.includes("cancel payment") && b.offsetParent !== null;
    });
    if (cancelBtn) {
      cancelBtn.click();
      return true;
    }
    return false;
  });
  if (linkDismissed) {
    console.log(`${prefix}   ✓ 已关闭 Stripe Link 弹窗`);
    await new Promise(r => setTimeout(r, 2000));
  }

  await page.screenshot({ path: path.join(screenshotDir, `stripe-2-filled-${Date.now()}.png`), fullPage: true });

  // 提交支付
  return await submitStripePayment(page, screenshotDir);
}

/**
 * 填写嵌入式 Stripe Elements（iframe 模式）
 */
async function fillStripeEmbedded(page, vcc, screenshotDir) {
  const prefix = "[stripe-embed]";
  console.log(`${prefix} → Stripe 嵌入式模式`);
  await new Promise(r => setTimeout(r, 2000));

  const filled = await fillStripeIframes(page, vcc, screenshotDir);
  if (!filled) {
    console.log(`${prefix}   ✗ 无法在 iframe 中填写`);
    return { success: false, error: "cannot_fill_stripe_embed" };
  }

  await page.screenshot({ path: path.join(screenshotDir, `stripe-embed-filled-${Date.now()}.png`), fullPage: true });
  return await submitStripePayment(page, screenshotDir);
}

/**
 * 在 Stripe iframe 中填写卡信息
 * Stripe Elements 通常有多个 iframe：cardNumber, cardExpiry, cardCvc
 * 或一个统一的 payment iframe
 */
async function fillStripeIframes(page, vcc, screenshotDir) {
  const prefix = "[stripe-iframe]";
  const frames = page.frames();
  console.log(`${prefix} 检查 ${frames.length} 个 frames`);

  let cardFilled = false;

  for (const frame of frames) {
    const url = frame.url();
    if (!url.includes("stripe.com") && !url.includes("js.stripe.com")) continue;
    console.log(`${prefix}   Stripe frame: ${url.substring(0, 80)}`);

    try {
      // 卡号 iframe
      if (url.includes("cardNumber") || url.includes("card-number")) {
        const input = await frame.$('input[name="cardnumber"], input[name="cardNumber"], input[autocomplete="cc-number"], input');
        if (input) {
          await input.click();
          await input.type(vcc.number, { delay: 50 });
          console.log(`${prefix}   ✓ 卡号`);
          cardFilled = true;
        }
        continue;
      }

      // 过期日期 iframe
      if (url.includes("cardExpiry") || url.includes("card-expiry") || url.includes("exp")) {
        const input = await frame.$('input[name="exp-date"], input[name="cardExpiry"], input[autocomplete="cc-exp"], input');
        if (input) {
          await input.click();
          await input.type(vcc.expiry, { delay: 50 });
          console.log(`${prefix}   ✓ 过期日期`);
        }
        continue;
      }

      // CVC iframe
      if (url.includes("cardCvc") || url.includes("card-cvc") || url.includes("cvc")) {
        const input = await frame.$('input[name="cvc"], input[name="cardCvc"], input[autocomplete="cc-csc"], input');
        if (input) {
          await input.click();
          await input.type(vcc.cvc, { delay: 50 });
          console.log(`${prefix}   ✓ CVC`);
        }
        continue;
      }

      // 统一 payment element
      if (url.includes("elements") || url.includes("payment")) {
        // 尝试查找统一卡号输入框
        const cardInput = await frame.$('input[name="cardnumber"], input[name="number"], input[autocomplete="cc-number"], input[placeholder*="card" i]');
        if (cardInput) {
          await cardInput.click();
          await cardInput.type(vcc.number, { delay: 50 });
          console.log(`${prefix}   ✓ 卡号 (unified)`);
          cardFilled = true;

          // Tab 到过期
          await frame.evaluate(() => {
            const inputs = [...document.querySelectorAll("input")];
            if (inputs[1]) inputs[1].focus();
          });
          await new Promise(r => setTimeout(r, 300));
          const expInput = await frame.$('input[name="exp-date"], input[autocomplete="cc-exp"]');
          if (expInput) {
            await expInput.click();
            await expInput.type(vcc.expiry, { delay: 50 });
            console.log(`${prefix}   ✓ 过期日期 (unified)`);
          }

          // CVC
          await new Promise(r => setTimeout(r, 300));
          const cvcInput = await frame.$('input[name="cvc"], input[autocomplete="cc-csc"]');
          if (cvcInput) {
            await cvcInput.click();
            await cvcInput.type(vcc.cvc, { delay: 50 });
            console.log(`${prefix}   ✓ CVC (unified)`);
          }
        }
      }
    } catch (err) {
      console.log(`${prefix}   ⚠ frame 操作失败: ${err.message}`);
    }
  }

  // 邮编通常在主页面而非 iframe
  if (cardFilled && vcc.zip) {
    const zipSelectors = [
      'input[name="postalCode"]', 'input[name="postal"]', 'input[name="zip"]',
      'input[name="billingPostalCode"]', 'input[autocomplete="postal-code"]',
      'input[placeholder*="zip" i]', 'input[placeholder*="postal" i]',
    ];
    for (const sel of zipSelectors) {
      const el = await page.$(sel);
      if (el) {
        await el.click({ clickCount: 3 });
        await el.type(vcc.zip, { delay: 50 });
        console.log(`${prefix}   ✓ 邮编`);
        break;
      }
    }
  }

  return cardFilled;
}

/**
 * 提交 Stripe 支付
 */
async function submitStripePayment(page, screenshotDir) {
  const prefix = "[stripe-submit]";
  console.log(`${prefix} → 提交支付...`);

  const submitResult = await page.evaluate(() => {
    const btns = [...document.querySelectorAll("button, input[type='submit']")];
    const keywords = [
      "subscribe", "start trial", "start free trial", "pay",
      "confirm", "submit", "continue", "complete",
      "订阅", "开始试用", "付款", "确认", "提交", "继续",
    ];
    for (const kw of keywords) {
      const btn = btns.find(b => {
        const t = (b.textContent || b.value || "").toLowerCase().trim();
        return t.includes(kw) && b.offsetParent !== null && !b.disabled;
      });
      if (btn) {
        btn.click();
        return { clicked: (btn.textContent || btn.value || "").trim().substring(0, 40) };
      }
    }
    // 兜底：点第一个 primary/submit 按钮
    const primary = btns.find(b =>
      b.type === "submit" || b.classList.contains("primary") || b.classList.contains("SubmitButton")
    );
    if (primary) {
      primary.click();
      return { clicked: (primary.textContent || "").trim().substring(0, 40), fallback: true };
    }
    return null;
  });

  if (!submitResult) {
    console.log(`${prefix}   ✗ 未找到提交按钮`);
    return { success: false, error: "no_submit_button" };
  }
  console.log(`${prefix}   ✓ 点击: ${JSON.stringify(submitResult)}`);

  // 等待支付处理（先等 5s 让 hCaptcha 弹出）
  console.log(`${prefix}   → 等待支付处理...`);
  await new Promise(r => setTimeout(r, 5000));

  // 检测 hCaptcha 弹窗
  const hasHCaptcha = await page.evaluate(() => {
    const text = document.body?.innerText || "";
    return text.includes("I am human") || text.includes("One more step") ||
      document.querySelector('iframe[src*="hcaptcha"]') !== null ||
      document.querySelector('[data-hcaptcha-widget-id]') !== null;
  });

  if (hasHCaptcha) {
    console.log(`${prefix}   → 检测到 hCaptcha!`);
    await page.screenshot({ path: path.join(screenshotDir, `stripe-hcaptcha-${Date.now()}.png`), fullPage: true });

    // 方式 1：CDP 扫射点击 hCaptcha checkbox（视口中心偏左区域）
    let hcaptchaSolved = false;
    try {
      const client = await page.createCDPSession();
      const vp = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
      const centerX = vp.w / 2;
      const centerY = vp.h / 2;

      // hCaptcha 弹窗居中，checkbox 在弹窗左侧
      const sweepPoints = [];
      for (let y = centerY - 30; y <= centerY + 30; y += 15) {
        for (let x = centerX - 150; x <= centerX - 80; x += 15) {
          sweepPoints.push({ x, y });
        }
      }
      console.log(`${prefix}   → CDP 扫射点击 hCaptcha checkbox (${sweepPoints.length} 点)...`);
      for (const pt of sweepPoints) {
        await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pt.x, y: pt.y });
        await new Promise(r => setTimeout(r, 10));
        await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: pt.x, y: pt.y, button: "left", clickCount: 1 });
        await new Promise(r => setTimeout(r, 10));
        await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pt.x, y: pt.y, button: "left", clickCount: 1 });
      }
      console.log(`${prefix}   ✓ CDP 扫射完成`);
      await client.detach();

      // 等 5s 看是否自动通过
      await new Promise(r => setTimeout(r, 5000));
      const stillHc = await page.evaluate(() => {
        const text = document.body?.innerText || "";
        return text.includes("I am human") || text.includes("One more step") ||
          document.querySelector('iframe[src*="hcaptcha"]') !== null;
      });
      if (!stillHc || !page.url().includes("stripe")) {
        hcaptchaSolved = true;
        console.log(`${prefix}   ✓ hCaptcha 已通过!`);
      }
    } catch (e) {
      console.log(`${prefix}   CDP 扫射失败: ${e.message}`);
    }

    // 方式 2：暂停等待手动点击（通过 SSH 隧道 + edge://inspect）
    if (!hcaptchaSolved) {
      console.log(`${prefix}   ╔════════════════════════════════════════════════════╗`);
      console.log(`${prefix}   ║  hCaptcha 需要手动点击!                           ║`);
      console.log(`${prefix}   ║                                                    ║`);
      console.log(`${prefix}   ║  1. SSH 隧道: ssh -L 9222:localhost:9222 ECS-IP    ║`);
      console.log(`${prefix}   ║  2. 本地浏览器打开: edge://inspect/#devices        ║`);
      console.log(`${prefix}   ║  3. 添加 localhost:9222, 点击 inspect              ║`);
      console.log(`${prefix}   ║  4. 手动点击 hCaptcha checkbox                     ║`);
      console.log(`${prefix}   ║                                                    ║`);
      console.log(`${prefix}   ║  等待中... (最多 5 分钟)                            ║`);
      console.log(`${prefix}   ╚════════════════════════════════════════════════════╝`);

      // 轮询等待 hCaptcha 消失或页面跳转（最多 5 分钟）
      for (let i = 0; i < 150; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const currentUrl = page.url();
        if (!currentUrl.includes("stripe")) {
          hcaptchaSolved = true;
          console.log(`${prefix}   ✓ 页面已跳转，hCaptcha 已通过! (${(i+1)*2}s)`);
          break;
        }
        const stillHc = await page.evaluate(() => {
          const text = document.body?.innerText || "";
          return text.includes("I am human") || text.includes("One more step") ||
            text.includes("真实访客") || text.includes("还需一步") ||
            document.querySelector('iframe[src*="hcaptcha"]') !== null;
        });
        if (!stillHc) {
          hcaptchaSolved = true;
          console.log(`${prefix}   ✓ hCaptcha 已消失，验证通过! (${(i+1)*2}s)`);
          break;
        }
        if (i % 15 === 14) console.log(`${prefix}   ⏳ 仍在等待手动点击... (${(i+1)*2}s)`);
      }

      if (!hcaptchaSolved) {
        console.log(`${prefix}   ✗ 5 分钟超时，hCaptcha 未解决`);
      }
    }

    // 等待处理完成
    await new Promise(r => setTimeout(r, 5000));
  } else {
    // 没有 hCaptcha，正常等待
    await new Promise(r => setTimeout(r, 5000));
  }

  await page.screenshot({ path: path.join(screenshotDir, `stripe-3-submitted-${Date.now()}.png`), fullPage: true });

  // 检查结果
  const finalUrl = page.url();
  const finalText = await page.evaluate(() => (document.body?.innerText || "").substring(0, 500).toLowerCase());
  console.log(`${prefix}   最终 URL: ${finalUrl}`);

  const isSuccess = finalText.includes("thank") || finalText.includes("success") ||
    finalText.includes("welcome") || finalText.includes("activated") ||
    finalText.includes("trial started") || finalText.includes("pro plan") ||
    finalUrl.includes("success") || finalUrl.includes("welcome") ||
    // 如果回到了 windsurf 页面（不再是 stripe），通常意味着成功
    (!finalUrl.includes("stripe") && !finalUrl.includes("error"));

  const isError = finalText.includes("declined") || finalText.includes("failed") ||
    finalText.includes("error") || finalText.includes("invalid") ||
    finalText.includes("insufficient");

  if (isError) {
    const errorSnippet = finalText.substring(0, 200);
    console.log(`${prefix}   ✗ 支付失败: ${errorSnippet}`);
    return { success: false, error: "payment_declined", detail: errorSnippet };
  }

  if (isSuccess) {
    console.log(`${prefix}   ✓ Pro Trial 激活成功!`);
    return { success: true };
  }

  console.log(`${prefix}   ⚠ 状态不确定: ${finalText.substring(0, 150)}`);
  return { success: false, error: "uncertain_status", url: finalUrl };
}

/**
 * 完整 Pro Trial 激活流程（登录 + 激活）
 */
async function activateProTrial(account, vcc, options = {}) {
  const { headless = true } = options;
  const { email, password } = account;

  let connect;
  try {
    const mod = await import("puppeteer-real-browser");
    connect = mod.connect;
  } catch {
    console.error("[pro-trial] ✗ 请先安装: npm install puppeteer-real-browser");
    process.exit(1);
  }

  const chromePaths = process.platform === "win32"
    ? [
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      ]
    : [
        "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome",
        "/usr/bin/chromium-browser", "/usr/bin/chromium",
      ];
  let chromePath = process.env.CHROME_PATH || null;
  if (!chromePath) {
    for (const p of chromePaths) {
      if (fs.existsSync(p)) { chromePath = p; break; }
    }
  }

  console.log("[pro-trial] ═══════════════════════════════════════");
  console.log(`[pro-trial] 激活 Pro Trial: ${email}`);
  console.log(`[pro-trial] VCC: **** **** **** ${vcc.number.slice(-4)}`);
  console.log("[pro-trial] ═══════════════════════════════════════");

  const { browser, page } = await connect({
    headless: false,
    turnstile: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--window-size=1280,800"],
    customConfig: chromePath ? { chromePath } : {},
    fingerprint: true,
  });

  const screenshotDir = path.join(PROJECT_ROOT, "screenshots");
  fs.mkdirSync(screenshotDir, { recursive: true });

  let capturedToken = null;
  let capturedApiKey = null;

  // 监听网络响应捕获 token
  page.on("response", async (res) => {
    const url = res.url();
    if (url.includes("identitytoolkit") || url.includes("securetoken")) {
      try {
        const body = await res.json();
        if (body.idToken) { capturedToken = body.idToken; }
        if (body.id_token) { capturedToken = body.id_token; }
      } catch {}
    }
    if (url.includes("RegisterUser") || url.includes("registerUser")) {
      try {
        const buf = await res.buffer();
        const strings = extractStringsFromProtobuf(buf);
        const key = strings.find(s => s.value && s.value.length > 20 && !s.value.includes(" "));
        if (key) { capturedApiKey = key.value; }
      } catch {}
    }
  });

  try {
    // Step 1: 登录
    console.log("[pro-trial] → 登录...");
    await page.goto(CONFIG.loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    // 等待页面渲染完成（Cloudflare 检查 + JS 加载）
    console.log("[pro-trial]   → 等待页面就绪...");
    for (let rr = 0; rr < 60; rr++) {
      const bodyText = await page.evaluate(() => (document.body?.innerText || "").trim());
      const hasInputs = await page.evaluate(() => !!document.querySelector('input[type="email"], input[type="password"]'));
      if (hasInputs) {
        console.log(`[pro-trial]   ✓ 登录表单已加载 (${rr + 1}s)`);
        break;
      }
      if (bodyText === "Redirecting" || bodyText.includes("Checking your browser")) {
        if (rr === 10) console.log("[pro-trial]   → Cloudflare 验证中... (10s)");
        if (rr === 30) console.log("[pro-trial]   → 仍在等待... (30s)");
      }
      // 如果已经跳转到非登录页（已登录），直接退出
      const url = page.url();
      if (!url.includes("/login") && !url.includes("/register") && !url.includes("about:blank")) {
        console.log(`[pro-trial]   ✓ 已登录，跳转到: ${url}`);
        break;
      }
      await new Promise(r => setTimeout(r, 1000));
    }

    // 填写邮箱
    const emailInput = await page.$('input[type="email"], input[name="email"], input[placeholder*="email" i]');
    if (emailInput) {
      await emailInput.click({ clickCount: 3 });
      await emailInput.type(email, { delay: 30 });
    } else {
      const firstInput = await page.$("input[type='text'], input:not([type])");
      if (firstInput) { await firstInput.click({ clickCount: 3 }); await firstInput.type(email, { delay: 30 }); }
    }

    // 填写密码
    const pwInput = await page.$('input[type="password"]');
    if (pwInput) {
      await pwInput.click({ clickCount: 3 });
      await pwInput.type(password || CONFIG.defaultPassword, { delay: 30 });
    }

    // 点击登录
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll("button")];
      const loginBtn = btns.find(b => {
        const t = (b.textContent || "").toLowerCase().trim();
        return t === "log in" || t === "login" || t === "sign in" || t === "continue";
      });
      if (loginBtn) loginBtn.click();
      else { const sb = btns.find(b => b.type === "submit"); if (sb) sb.click(); }
    });

    console.log("[pro-trial]   → 等待登录完成...");
    // 等待 URL 离开 login 页，最多 60 秒
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const currentUrl = page.url();
      if (!currentUrl.includes("/login") && !currentUrl.includes("/register")) {
        console.log(`[pro-trial]   ✓ 登录成功，URL: ${currentUrl}`);
        break;
      }
      // 检查页面是否有 Turnstile 需要处理
      if (i === 5) {
        const hasTurnstile = await page.evaluate(() => {
          return !!document.querySelector('iframe[src*="turnstile"], .cf-turnstile, [data-sitekey]');
        });
        if (hasTurnstile) {
          console.log("[pro-trial]   → 检测到 Turnstile，等待自动处理...");
        }
      }
      // 检查是否需要密码（两步登录）
      if (i === 3) {
        const needsPassword = await page.evaluate(() => {
          const pwInput = document.querySelector('input[type="password"]');
          return pwInput && !pwInput.value;
        });
        if (needsPassword) {
          console.log("[pro-trial]   → 两步登录：重新填写密码...");
          const pw2 = await page.$('input[type="password"]');
          if (pw2) {
            await pw2.click({ clickCount: 3 });
            await pw2.type(password || CONFIG.defaultPassword, { delay: 30 });
            await page.evaluate(() => {
              const btns = [...document.querySelectorAll("button")];
              const btn = btns.find(b => /log.in|login|sign.in|continue/i.test(b.textContent?.trim()));
              if (btn) btn.click();
            });
          }
        }
      }
      if (i === 10) {
        const errText = await page.evaluate(() => (document.body?.innerText || "").substring(0, 300));
        if (errText.toLowerCase().includes("invalid") || errText.toLowerCase().includes("incorrect")) {
          console.log("[pro-trial]   ✗ 登录失败: 密码错误");
          return { success: false, error: "login_failed", email };
        }
        console.log(`[pro-trial]   → 仍在等待... 页面: ${errText.substring(0, 100)}`);
      }
      if (i === 30) console.log("[pro-trial]   → 登录等待已 30s...");
    }
    await new Promise(r => setTimeout(r, 3000));
    await page.screenshot({ path: path.join(screenshotDir, `trial-0-logged-in-${Date.now()}.png`), fullPage: true });

    const loginUrl = page.url();
    console.log(`[pro-trial]   登录后 URL: ${loginUrl}`);
    if (loginUrl.includes("login")) {
      console.log("[pro-trial]   ⚠ 60s 后仍在登录页");
      const errText = await page.evaluate(() => (document.body?.innerText || "").substring(0, 200));
      console.log(`[pro-trial]   页面: ${errText.substring(0, 150)}`);
      if (errText.toLowerCase().includes("invalid") || errText.toLowerCase().includes("incorrect")) {
        return { success: false, error: "login_failed", email };
      }
    }

    // Step 2: 激活 Pro Trial
    const result = await activateProTrialOnPage(page, vcc, screenshotDir);

    // Step 3: 如果成功，提取 token
    if (result.success) {
      // 等待一下让 token 刷新
      await new Promise(r => setTimeout(r, 5000));

      // 从 localStorage 获取 token
      if (!capturedToken) {
        capturedToken = await page.evaluate(() => {
          for (const key of Object.keys(localStorage)) {
            if (key.includes("firebase") || key.includes("token") || key.includes("auth")) {
              const val = localStorage.getItem(key);
              if (val && val.length > 100) return val;
              try {
                const parsed = JSON.parse(val);
                if (parsed?.stsTokenManager?.accessToken) return parsed.stsTokenManager.accessToken;
                if (parsed?.idToken) return parsed.idToken;
              } catch {}
            }
          }
          return null;
        });
        if (capturedToken) console.log("[pro-trial]   ✓ 从 localStorage 提取 Token");
      }

      // RegisterUser RPC 获取 API Key
      if (capturedToken && !capturedApiKey) {
        try {
          const regReq = encodeRegisterUserRequest(capturedToken);
          const regRes = await callConnectRpc(CONFIG.registerServer, CONFIG.rpcRegisterUser, regReq);
          if (regRes.status === 200 && regRes.body.length > 5) {
            const frames = parseConnectFrames(regRes.body);
            if (frames.length > 0) {
              const fields = extractStringsFromProtobuf(frames[0].data);
              capturedApiKey = fields.find(f => f.field === 1)?.value;
              if (capturedApiKey) console.log(`[pro-trial]   ✓ API Key: ${capturedApiKey.substring(0, 30)}...`);
            }
          }
        } catch (err) {
          console.log(`[pro-trial]   ⚠ RegisterUser RPC: ${err.message}`);
        }
      }
    }

    return {
      ...result,
      email,
      firebaseIdToken: capturedToken,
      apiKey: capturedApiKey,
      trialActivatedAt: result.success ? new Date().toISOString() : null,
      trialExpiresAt: result.success ? new Date(Date.now() + 14 * 24 * 3600_000).toISOString() : null,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * 取消 Pro Trial 订阅
 */
async function cancelProTrial(account, options = {}) {
  const { headless = true } = options;
  const { email, password } = account;

  let connect;
  try {
    const mod = await import("puppeteer-real-browser");
    connect = mod.connect;
  } catch {
    console.error("[cancel] ✗ 请先安装: npm install puppeteer-real-browser");
    process.exit(1);
  }

  const chromePaths = process.platform === "win32"
    ? ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"]
    : ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium"];
  let chromePath = process.env.CHROME_PATH || null;
  if (!chromePath) { for (const p of chromePaths) { if (fs.existsSync(p)) { chromePath = p; break; } } }

  console.log(`[cancel] 取消订阅: ${email}`);

  const { browser, page } = await connect({
    headless: false, turnstile: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    customConfig: chromePath ? { chromePath } : {},
    fingerprint: true,
  });

  const screenshotDir = path.join(PROJECT_ROOT, "screenshots");
  fs.mkdirSync(screenshotDir, { recursive: true });

  try {
    // 登录
    await page.goto(CONFIG.loginUrl, { waitUntil: "networkidle2", timeout: 60000 });
    await new Promise(r => setTimeout(r, 3000));

    const emailInput = await page.$('input[type="email"], input[name="email"]');
    if (emailInput) { await emailInput.click({ clickCount: 3 }); await emailInput.type(email, { delay: 30 }); }
    const pwInput = await page.$('input[type="password"]');
    if (pwInput) { await pwInput.click({ clickCount: 3 }); await pwInput.type(password || CONFIG.defaultPassword, { delay: 30 }); }
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll("button")];
      const btn = btns.find(b => /log.in|login|sign.in|continue/i.test(b.textContent?.trim() || ""));
      if (btn) btn.click(); else { const sb = btns.find(b => b.type === "submit"); if (sb) sb.click(); }
    });
    await new Promise(r => setTimeout(r, 8000));

    // 导航到取消页
    console.log("[cancel] → 导航到取消页...");
    await page.goto(CONFIG.cancelSubscriptionUrl, { waitUntil: "networkidle2", timeout: 60000 });
    await new Promise(r => setTimeout(r, 3000));
    await page.screenshot({ path: path.join(screenshotDir, `cancel-1-page-${Date.now()}.png`), fullPage: true });

    const cancelUrl = page.url();
    console.log(`[cancel]   URL: ${cancelUrl}`);

    // 点击 Cancel Plan
    const cancelResult = await page.evaluate(() => {
      const allEls = [...document.querySelectorAll("button, a, [role='button']")];
      const keywords = ["cancel plan", "cancel subscription", "cancel trial", "cancel", "end trial"];
      for (const kw of keywords) {
        const el = allEls.find(e => {
          const t = (e.textContent || "").toLowerCase().trim();
          return t.includes(kw) && e.offsetParent !== null;
        });
        if (el) { el.click(); return { clicked: (el.textContent || "").trim().substring(0, 40) }; }
      }
      return null;
    });

    if (!cancelResult) {
      // 可能需要去 manage-plan 页面
      console.log("[cancel]   → 尝试 manage-plan 页面...");
      await page.goto(CONFIG.manageSubscriptionUrl, { waitUntil: "networkidle2", timeout: 60000 });
      await new Promise(r => setTimeout(r, 3000));
      await page.screenshot({ path: path.join(screenshotDir, `cancel-2-manage-${Date.now()}.png`), fullPage: true });

      const manageResult = await page.evaluate(() => {
        const allEls = [...document.querySelectorAll("button, a, [role='button']")];
        const keywords = ["cancel plan", "cancel subscription", "cancel"];
        for (const kw of keywords) {
          const el = allEls.find(e => (e.textContent || "").toLowerCase().includes(kw) && e.offsetParent !== null);
          if (el) { el.click(); return { clicked: (el.textContent || "").trim().substring(0, 40) }; }
        }
        return null;
      });

      if (!manageResult) {
        console.log("[cancel]   ✗ 未找到取消按钮");
        return { success: false, error: "no_cancel_button" };
      }
      console.log(`[cancel]   ✓ 点击: ${JSON.stringify(manageResult)}`);
    } else {
      console.log(`[cancel]   ✓ 点击: ${JSON.stringify(cancelResult)}`);
    }

    // 等待确认对话框
    await new Promise(r => setTimeout(r, 3000));
    await page.screenshot({ path: path.join(screenshotDir, `cancel-3-confirm-${Date.now()}.png`), fullPage: true });

    // 确认取消（可能有 "Are you sure?" 对话框）
    const confirmResult = await page.evaluate(() => {
      const allEls = [...document.querySelectorAll("button, a")];
      const keywords = ["confirm", "yes, cancel", "cancel plan", "cancel anyway", "proceed"];
      for (const kw of keywords) {
        const el = allEls.find(e => (e.textContent || "").toLowerCase().includes(kw) && e.offsetParent !== null);
        if (el) { el.click(); return { confirmed: (el.textContent || "").trim().substring(0, 40) }; }
      }
      return null;
    });
    if (confirmResult) console.log(`[cancel]   ✓ 确认: ${JSON.stringify(confirmResult)}`);

    await new Promise(r => setTimeout(r, 5000));
    await page.screenshot({ path: path.join(screenshotDir, `cancel-4-done-${Date.now()}.png`), fullPage: true });

    const finalText = await page.evaluate(() => (document.body?.innerText || "").substring(0, 300).toLowerCase());
    const isSuccess = finalText.includes("cancelled") || finalText.includes("canceled") ||
      finalText.includes("downgrade") || finalText.includes("free plan");

    return { success: isSuccess || !!cancelResult, email };
  } finally {
    await browser.close().catch(() => {});
  }
}

// ============================================================
// 方案 F：邀请推荐自动化（Referral Bonus +250 credits）
// ============================================================

/**
 * 从已登录的页面提取 referral code
 * 流程：导航到 /refer → 等待页面渲染 → 提取 referral link 中的 code
 */
async function extractReferralCode(page, screenshotDir) {
  const prefix = "[referral]";
  console.log(`${prefix} → 导航到推荐页面...`);
  await page.goto("https://windsurf.com/refer", { waitUntil: "networkidle2", timeout: 60000 });
  await new Promise(r => setTimeout(r, 5000));

  if (screenshotDir) {
    await page.screenshot({ path: path.join(screenshotDir, `refer-page-${Date.now()}.png`), fullPage: true });
  }

  // 提取 referral code（多种方式）
  const result = await page.evaluate(() => {
    // 方式 1: 从页面中的 referral link 提取
    const allText = document.body?.innerText || "";
    const linkMatch = allText.match(/windsurf\.com\/refer\?referral_code=([a-zA-Z0-9]+)/);
    if (linkMatch) return { code: linkMatch[1], source: "page_text" };

    // 方式 2: 从 input/textarea 中提取（Copy 按钮旁边的）
    const inputs = [...document.querySelectorAll("input, textarea")];
    for (const inp of inputs) {
      const val = inp.value || "";
      const refMatch = val.match(/referral_code=([a-zA-Z0-9]+)/);
      if (refMatch) return { code: refMatch[1], source: "input" };
    }

    // 方式 3: 从 clipboard 区域或 data 属性中提取
    const els = [...document.querySelectorAll("[data-referral-code], [data-code], [data-clipboard-text]")];
    for (const el of els) {
      const code = el.getAttribute("data-referral-code") || el.getAttribute("data-code") ||
                   el.getAttribute("data-clipboard-text") || "";
      const refMatch = code.match(/referral_code=([a-zA-Z0-9]+)/) || (code.length > 5 && code.length < 30 ? [null, code] : null);
      if (refMatch) return { code: refMatch[1], source: "data_attr" };
    }

    // 方式 4: 从 a[href] 中提取
    const links = [...document.querySelectorAll("a[href*='referral_code']")];
    for (const a of links) {
      const refMatch = a.href.match(/referral_code=([a-zA-Z0-9]+)/);
      if (refMatch) return { code: refMatch[1], source: "href" };
    }

    // 方式 5: 从 URL 参数提取（可能 /refer 本身就带了 code）
    const urlMatch = location.href.match(/referral_code=([a-zA-Z0-9]+)/);
    if (urlMatch) return { code: urlMatch[1], source: "url" };

    return null;
  });

  if (!result) {
    // 尝试点击 Copy 按钮然后从剪贴板读取
    console.log(`${prefix}   → 尝试点击 Copy 按钮...`);
    const copyClicked = await page.evaluate(() => {
      const btns = [...document.querySelectorAll("button, [role='button']")];
      const copyBtn = btns.find(b => {
        const t = (b.textContent || "").trim().toLowerCase();
        return (t === "copy" || t.includes("copy link") || t.includes("copy referral")) && b.offsetParent !== null;
      });
      if (copyBtn) { copyBtn.click(); return true; }
      return false;
    });

    if (copyClicked) {
      await new Promise(r => setTimeout(r, 1000));
      // 再次检查页面是否有显示 code
      const retryResult = await page.evaluate(() => {
        const allText = document.body?.innerText || "";
        const linkMatch = allText.match(/referral_code=([a-zA-Z0-9]+)/);
        if (linkMatch) return { code: linkMatch[1], source: "page_text_retry" };
        return null;
      });
      if (retryResult) {
        console.log(`${prefix}   ✓ 提取 referral code: ${retryResult.code} (${retryResult.source})`);
        return retryResult.code;
      }
    }

    // 最终诊断
    const pageText = await page.evaluate(() => (document.body?.innerText || "").substring(0, 1000));
    console.log(`${prefix}   ✗ 无法提取 referral code`);
    console.log(`${prefix}   页面内容: ${pageText.substring(0, 300)}`);
    return null;
  }

  console.log(`${prefix}   ✓ 提取 referral code: ${result.code} (${result.source})`);
  return result.code;
}

/**
 * 在已登录的 free 账号页面上接受推荐邀请 + 绑定 VCC
 * 流程：打开 referral link → 点击升级/绑卡 → Stripe 填 VCC → 完成
 */
async function acceptReferralOnPage(page, referralCode, vcc, screenshotDir) {
  const prefix = "[referral-accept]";
  const referralUrl = `https://windsurf.com/refer?referral_code=${referralCode}`;

  console.log(`${prefix} → 打开推荐链接: ${referralUrl}`);
  await page.goto(referralUrl, { waitUntil: "networkidle2", timeout: 60000 });
  await new Promise(r => setTimeout(r, 5000));

  await page.screenshot({ path: path.join(screenshotDir, `referral-accept-1-loaded-${Date.now()}.png`), fullPage: true });

  // 检查是否有错误（已经是付费用户）
  const pageCheck = await page.evaluate(() => {
    const text = (document.body?.innerText || "").toLowerCase();
    if (text.includes("already on a paid") || text.includes("ineligible")) return { error: "already_paid" };
    if (text.includes("invalid") || text.includes("expired")) return { error: "invalid_code" };
    return { error: null, text: text.substring(0, 500) };
  });

  if (pageCheck.error === "already_paid") {
    console.log(`${prefix}   ✗ 该账号已是付费用户，无法接受推荐`);
    return { success: false, error: "already_paid" };
  }
  if (pageCheck.error === "invalid_code") {
    console.log(`${prefix}   ✗ 推荐码无效或已过期`);
    return { success: false, error: "invalid_referral_code" };
  }

  console.log(`${prefix}   页面状态: ${(pageCheck.text || "").substring(0, 200)}`);

  // 关闭 Cookie 弹窗（如果有）
  await page.evaluate(() => {
    const cookieBtn = [...document.querySelectorAll("button")].find(b =>
      /accept all|accept/i.test((b.textContent || "").trim()) && b.offsetParent !== null
    );
    if (cookieBtn) cookieBtn.click();
  });
  await new Promise(r => setTimeout(r, 1000));

  // 点击 "Start Pro Trial" / "Accept" / "Get Started" / "Claim" 按钮
  console.log(`${prefix} → 点击接受推荐按钮...`);
  const clickResult = await page.evaluate(() => {
    const allEls = [...document.querySelectorAll("button, a, [role='button'], [class*='button'], [class*='btn'], [class*='cta']")];
    const priorities = [
      "claim", "accept", "get started", "start free trial", "start trial",
      "select plan", "try pro", "upgrade", "continue", "start",
    ];
    for (const keyword of priorities) {
      const el = allEls.find(e => {
        const t = (e.textContent || "").toLowerCase().trim();
        return t.includes(keyword) && e.offsetParent !== null && !e.disabled;
      });
      if (el) {
        if (el.href) location.href = el.href;
        else el.click();
        return { clicked: (el.textContent || "").trim().substring(0, 50), keyword };
      }
    }
    return null;
  });

  if (!clickResult) {
    console.log(`${prefix}   ⚠ 未找到明显的接受按钮，尝试继续...`);
    // 页面可能直接就是 Stripe checkout
  } else {
    console.log(`${prefix}   ✓ 点击: "${clickResult.clicked}" (keyword: ${clickResult.keyword})`);
  }

  // 等待 Turnstile（如果有）
  console.log(`${prefix} → 等待 Turnstile CAPTCHA...`);
  for (let i = 0; i < 15; i++) {
    const turnstile = await page.evaluate(() => {
      const text = document.body?.innerText || "";
      if (text.includes("Success!")) return "success";
      if (text.includes("Verifying")) return "verifying";
      const hasWidget = !!document.querySelector('iframe[src*="turnstile"], .cf-turnstile');
      return hasWidget ? "widget_present" : "none";
    });
    if (turnstile === "success" || turnstile === "none") break;
    console.log(`${prefix}   Turnstile: ${turnstile} (${i + 1}/15)`);
    await new Promise(r => setTimeout(r, 2000));
  }

  // 点击 Continue（模态框中的）
  const continueClicked = await page.evaluate(() => {
    const btns = [...document.querySelectorAll("button")];
    const btn = btns.find(b => {
      const t = (b.textContent || "").trim().toLowerCase();
      return t === "continue" && b.offsetParent !== null && !b.disabled;
    });
    if (btn) { btn.click(); return true; }
    return false;
  });
  if (continueClicked) console.log(`${prefix}   ✓ Continue 已点击`);

  // 等待 Stripe Checkout
  console.log(`${prefix} → 等待 Stripe Checkout...`);
  await new Promise(r => setTimeout(r, 5000));
  await page.screenshot({ path: path.join(screenshotDir, `referral-accept-2-checkout-${Date.now()}.png`), fullPage: true });

  const currentUrl = page.url();
  console.log(`${prefix}   URL: ${currentUrl}`);

  const isStripeCheckout = currentUrl.includes("checkout.stripe.com");
  const hasStripeEmbed = await page.evaluate(() => {
    return document.querySelectorAll('iframe[src*="stripe"], iframe[name*="stripe"]').length > 0
      || document.querySelector('[class*="StripeElement"], #payment-element, [data-stripe]') !== null;
  });

  if (isStripeCheckout) {
    return await fillStripeCheckoutPage(page, vcc, screenshotDir);
  } else if (hasStripeEmbed) {
    return await fillStripeEmbedded(page, vcc, screenshotDir);
  }

  // 可能还需等待跳转
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const url = page.url();
    if (url.includes("stripe") || url.includes("checkout") || url.includes("billing")) {
      console.log(`${prefix}   → 跳转到: ${url}`);
      await new Promise(r => setTimeout(r, 3000));
      if (url.includes("checkout.stripe.com")) {
        return await fillStripeCheckoutPage(page, vcc, screenshotDir);
      }
      const hasEmbed = await page.evaluate(() =>
        document.querySelectorAll('iframe[src*="stripe"]').length > 0 ||
        document.querySelector('[class*="StripeElement"]') !== null
      );
      if (hasEmbed) return await fillStripeEmbedded(page, vcc, screenshotDir);
      break;
    }
    // 检查是否已成功（有些情况下绑卡后直接跳回）
    const pageText = await page.evaluate(() => (document.body?.innerText || "").toLowerCase());
    if (pageText.includes("success") || pageText.includes("welcome to pro") || pageText.includes("trial activated")) {
      console.log(`${prefix}   ✓ 推荐接受成功！`);
      return { success: true };
    }
  }

  await page.screenshot({ path: path.join(screenshotDir, `referral-accept-3-unknown-${Date.now()}.png`), fullPage: true });
  return { success: false, error: "no_stripe_page", url: page.url() };
}

/**
 * 完整邀请推荐流程
 * 1. 登录推荐人（已有 Pro Trial 账号） → 提取 referral code
 * 2. 注册新 Free 账号
 * 3. 新账号登录 → 打开推荐链接 → 绑 VCC → 双方获得 +250 credits
 */
async function referralFlow(referrerAccount, vcc, options = {}) {
  const { headless = true, skipRegister = false, newAccountEmail = null } = options;
  const prefix = "[refer-flow]";

  let connect;
  try {
    const mod = await import("puppeteer-real-browser");
    connect = mod.connect;
  } catch {
    console.error(`${prefix} ✗ 请先安装: npm install puppeteer-real-browser`);
    process.exit(1);
  }

  const chromePaths = process.platform === "win32"
    ? [
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      ]
    : [
        "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome",
        "/usr/bin/chromium-browser", "/usr/bin/chromium",
      ];
  let chromePath = process.env.CHROME_PATH || null;
  if (!chromePath) {
    for (const p of chromePaths) {
      if (fs.existsSync(p)) { chromePath = p; break; }
    }
  }

  const screenshotDir = path.join(PROJECT_ROOT, "screenshots");
  fs.mkdirSync(screenshotDir, { recursive: true });

  console.log(`${prefix} ═══════════════════════════════════════`);
  console.log(`${prefix} 邀请推荐流程`);
  console.log(`${prefix}   推荐人: ${referrerAccount.email}`);
  console.log(`${prefix}   VCC: **** **** **** ${vcc.number.slice(-4)}`);
  console.log(`${prefix} ═══════════════════════════════════════`);

  // ── Phase 1: 登录推荐人，提取 referral code ──
  console.log(`\n${prefix} ══ Phase 1: 提取推荐码 ══`);

  const { browser: browser1, page: page1 } = await connect({
    headless: false, turnstile: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--window-size=1280,800"],
    customConfig: chromePath ? { chromePath } : {},
    fingerprint: true,
  });

  let referralCode = null;

  try {
    // 登录推荐人
    await page1.goto(CONFIG.loginUrl, { waitUntil: "networkidle2", timeout: 60000 });
    await new Promise(r => setTimeout(r, 3000));

    const emailInput = await page1.$('input[type="email"], input[name="email"], input[placeholder*="email" i]');
    if (emailInput) {
      await emailInput.click({ clickCount: 3 });
      await emailInput.type(referrerAccount.email, { delay: 30 });
    } else {
      const firstInput = await page1.$("input[type='text'], input:not([type])");
      if (firstInput) { await firstInput.click({ clickCount: 3 }); await firstInput.type(referrerAccount.email, { delay: 30 }); }
    }

    const pwInput = await page1.$('input[type="password"]');
    if (pwInput) {
      await pwInput.click({ clickCount: 3 });
      await pwInput.type(referrerAccount.password || CONFIG.defaultPassword, { delay: 30 });
    }

    await page1.evaluate(() => {
      const btns = [...document.querySelectorAll("button")];
      const loginBtn = btns.find(b => {
        const t = (b.textContent || "").toLowerCase().trim();
        return t === "log in" || t === "login" || t === "sign in" || t === "continue";
      });
      if (loginBtn) loginBtn.click();
      else { const sb = btns.find(b => b.type === "submit"); if (sb) sb.click(); }
    });

    // 等待登录完成
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const url = page1.url();
      if (!url.includes("/login") && !url.includes("/register") && !url.includes("/signup")) {
        console.log(`${prefix}   ✓ 推荐人登录成功`);
        break;
      }
      if (i === 59) {
        console.log(`${prefix}   ✗ 登录超时`);
        return { success: false, error: "referrer_login_timeout" };
      }
    }

    await new Promise(r => setTimeout(r, 3000));

    // 提取 referral code
    referralCode = await extractReferralCode(page1, screenshotDir);
    if (!referralCode) {
      return { success: false, error: "cannot_extract_referral_code" };
    }

    console.log(`${prefix}   ✓ 推荐码: ${referralCode}`);
    console.log(`${prefix}   推荐链接: https://windsurf.com/refer?referral_code=${referralCode}`);
  } finally {
    await browser1.close().catch(() => {});
  }

  // ── Phase 2: 注册新 Free 账号（如果没有指定跳过） ──
  let newAccount;
  if (skipRegister && newAccountEmail) {
    // 使用已有账号
    const data = loadAccounts();
    newAccount = data.accounts.find(a => a.email === newAccountEmail);
    if (!newAccount) {
      console.log(`${prefix} ✗ 未找到账号: ${newAccountEmail}`);
      return { success: false, error: "account_not_found" };
    }
    console.log(`\n${prefix} ══ Phase 2: 使用已有账号 ${newAccount.email} ══`);
  } else {
    console.log(`\n${prefix} ══ Phase 2: 注册新 Free 账号 ══`);
    const identity = await generateIdentity(false);
    console.log(`${prefix}   新邮箱: ${identity.email}`);

    let regResult;
    try {
      regResult = await registerViaCodeium(identity, { headless: !options.headful });
    } catch (err) {
      console.log(`${prefix}   ✗ 注册失败: ${err.message}`);
      return { success: false, error: "registration_failed", referralCode };
    }

    if (!regResult || regResult.status === "pending_verification") {
      console.log(`${prefix}   ✗ 注册未完成`);
      return { success: false, error: "registration_incomplete", referralCode };
    }

    await addAccount(regResult);
    console.log(`${prefix}   ✓ 注册成功: ${regResult.email}`);
    newAccount = regResult;
  }

  await new Promise(r => setTimeout(r, 5000)); // 等账号稳定

  // ── Phase 3: 新账号登录 → 接受推荐 → 绑 VCC ──
  console.log(`\n${prefix} ══ Phase 3: 接受推荐 + 绑卡 ══`);

  const { browser: browser2, page: page2 } = await connect({
    headless: false, turnstile: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--window-size=1280,800"],
    customConfig: chromePath ? { chromePath } : {},
    fingerprint: true,
  });

  let capturedToken = null;
  let capturedApiKey = null;

  page2.on("response", async (res) => {
    const url = res.url();
    if (url.includes("identitytoolkit") || url.includes("securetoken")) {
      try {
        const body = await res.json();
        if (body.idToken) capturedToken = body.idToken;
        if (body.id_token) capturedToken = body.id_token;
      } catch {}
    }
    if (url.includes("RegisterUser") || url.includes("registerUser")) {
      try {
        const buf = await res.buffer();
        const strings = extractStringsFromProtobuf(buf);
        const key = strings.find(s => s.value && s.value.length > 20 && !s.value.includes(" "));
        if (key) capturedApiKey = key.value;
      } catch {}
    }
  });

  try {
    // 登录新账号
    await page2.goto(CONFIG.loginUrl, { waitUntil: "networkidle2", timeout: 60000 });
    await new Promise(r => setTimeout(r, 3000));

    const emailInput = await page2.$('input[type="email"], input[name="email"], input[placeholder*="email" i]');
    if (emailInput) {
      await emailInput.click({ clickCount: 3 });
      await emailInput.type(newAccount.email, { delay: 30 });
    } else {
      const firstInput = await page2.$("input[type='text'], input:not([type])");
      if (firstInput) { await firstInput.click({ clickCount: 3 }); await firstInput.type(newAccount.email, { delay: 30 }); }
    }

    const pwInput = await page2.$('input[type="password"]');
    if (pwInput) {
      await pwInput.click({ clickCount: 3 });
      await pwInput.type(newAccount.password || CONFIG.defaultPassword, { delay: 30 });
    }

    await page2.evaluate(() => {
      const btns = [...document.querySelectorAll("button")];
      const loginBtn = btns.find(b => {
        const t = (b.textContent || "").toLowerCase().trim();
        return t === "log in" || t === "login" || t === "sign in" || t === "continue";
      });
      if (loginBtn) loginBtn.click();
      else { const sb = btns.find(b => b.type === "submit"); if (sb) sb.click(); }
    });

    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const url = page2.url();
      if (!url.includes("/login") && !url.includes("/register") && !url.includes("/signup")) {
        console.log(`${prefix}   ✓ 新账号登录成功`);
        break;
      }
      if (i === 59) {
        return { success: false, error: "new_account_login_timeout", referralCode };
      }
    }

    await new Promise(r => setTimeout(r, 3000));

    // 接受推荐 + 绑卡
    const result = await acceptReferralOnPage(page2, referralCode, vcc, screenshotDir);

    if (result.success) {
      markVccUsed(vcc, newAccount.email);

      // 更新新账号状态
      const data = loadAccounts();
      const acct = data.accounts.find(a => a.email === newAccount.email);
      if (acct) {
        acct.status = "pro_trial";
        acct.referredBy = referrerAccount.email;
        acct.referralCode = referralCode;
        acct.trialActivatedAt = new Date().toISOString();
        acct.trialExpiresAt = new Date(Date.now() + 14 * 24 * 3600_000).toISOString();
        acct.vccLast4 = vcc.number.slice(-4);
        if (capturedApiKey) acct.apiKey = capturedApiKey;
        if (capturedToken) acct.firebaseIdToken = capturedToken;
        saveAccounts(data);
        await syncToSessions(acct);
      }

      // 更新推荐人记录
      const referrerAcct = data.accounts.find(a => a.email === referrerAccount.email);
      if (referrerAcct) {
        if (!referrerAcct.referrals) referrerAcct.referrals = [];
        referrerAcct.referrals.push({
          email: newAccount.email,
          referralCode,
          bonusCredits: 250,
          at: new Date().toISOString(),
        });
        referrerAcct.referralBonusTotal = (referrerAcct.referralBonusTotal || 0) + 250;
        saveAccounts(data);
      }

      console.log(`\n${prefix} ═══════════════════════════════════════`);
      console.log(`${prefix} ✓ 邀请推荐完成!`);
      console.log(`${prefix}   推荐人: ${referrerAccount.email} (+250 credits)`);
      console.log(`${prefix}   被推荐: ${newAccount.email} (+250 credits)`);
      console.log(`${prefix}   推荐码: ${referralCode}`);
      console.log(`${prefix} ═══════════════════════════════════════`);

      return {
        success: true,
        referrerEmail: referrerAccount.email,
        newEmail: newAccount.email,
        referralCode,
        bonusCredits: 250,
      };
    } else {
      console.log(`${prefix}   ✗ 接受推荐失败: ${result.error}`);
      return { success: false, error: result.error, referralCode };
    }
  } finally {
    await browser2.close().catch(() => {});
  }
}

/**
 * 从账号池中随机选择一个可用的推荐人（Pro Trial 状态）
 */
function pickReferrer(excludeEmails = []) {
  const data = loadAccounts();
  const eligible = data.accounts.filter(a =>
    a.status === "pro_trial" && a.apiKey && !excludeEmails.includes(a.email)
  );
  if (eligible.length === 0) return null;
  // 优先选推荐次数少的
  eligible.sort((a, b) => (a.referrals?.length || 0) - (b.referrals?.length || 0));
  return eligible[0];
}

// ============================================================
// CLI
// ============================================================

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  function getFlag(name) {
    return args.includes(`--${name}`);
  }
  function getArg(name, defaultValue) {
    const idx = args.indexOf(`--${name}`);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : defaultValue;
  }

  switch (command) {
    case "register": {
      const mode = getArg("mode", "codeium"); // codeium(默认) 或 windsurf
      const identity = {
        email: getArg("email", null),
        password: getArg("password", CONFIG.defaultPassword),
        firstName: getArg("first-name", null),
        lastName: getArg("last-name", null),
      };

      // 如果没有提供邮箱，自动生成
      if (!identity.email) {
        if (mode === "codeium" && CONFIG.imapUser && CONFIG.imapPass) {
          // codeium 模式 + IMAP 配置：用 IMAP 邮箱注册（这样能读验证码）
          const generated = await generateIdentity(true);
          identity.email = generated.email;
          identity.firstName = identity.firstName || generated.firstName;
          identity.lastName = identity.lastName || generated.lastName;
          identity.tempMail = generated.tempMail;
        } else if (mode === "codeium") {
          // codeium 模式无 IMAP：用随机邮箱（无法自动验证）
          const generated = await generateIdentity(false);
          identity.email = generated.email;
          identity.firstName = identity.firstName || generated.firstName;
          identity.lastName = identity.lastName || generated.lastName;
        } else {
          const generated = await generateIdentity(true);
          identity.email = generated.email;
          identity.firstName = identity.firstName || generated.firstName;
          identity.lastName = identity.lastName || generated.lastName;
          identity.tempMail = generated.tempMail;
        }
      } else {
        identity.firstName = identity.firstName || randomElement(FIRST_NAMES);
        identity.lastName = identity.lastName || randomElement(LAST_NAMES);
      }

      console.log("[registrar] ═══════════════════════════════════════");
      console.log(`[registrar] Windsurf 试用号注册 (${mode} 模式)`);
      console.log("[registrar] ═══════════════════════════════════════");
      console.log(`[registrar] 邮箱: ${identity.email}`);
      console.log(`[registrar] 名字: ${identity.firstName} ${identity.lastName}`);
      console.log(`[registrar] 密码: ${identity.password}`);
      console.log();

      let result;
      if (mode === "codeium") {
        result = await registerViaCodeium(identity, {
          headless: !getFlag("headful"),
        });
      } else {
        result = await registerViaPuppeteer(identity, {
          headless: !getFlag("headful"),
          slowMo: parseInt(getArg("slow-mo", "50")),
        });
      }

      await addAccount(result);
      if (result.status === "registered" || result.status === "registered_no_token") {
        await syncToSessions(result);
      }

      console.log();
      console.log("[registrar] ═══════════════════════════════════════");
      console.log(`[registrar] 结果: ${result.status}`);
      if (result.apiKey) {
        console.log(`[registrar] API Key: ${result.apiKey}`);
      }
      if (result.firebaseIdToken) {
        console.log(`[registrar] Firebase Token: ${result.firebaseIdToken.substring(0, 30)}...`);
      }
      console.log(`[registrar] 到期时间: ${result.expiresAt}`);
      console.log("[registrar] ═══════════════════════════════════════");
      break;
    }

    case "batch": {
      const count = parseInt(getArg("count", "3"));
      const delay = parseInt(getArg("delay", "15"));
      const parallel = parseInt(getArg("parallel", "2"));
      const headful = getFlag("headful");
      const mode = getArg("mode", "codeium");
      const maxRetries = parseInt(getArg("retries", "1"));

      console.log("[batch] ═══════════════════════════════════════");
      console.log(`[batch] 批量注册: ${count} 个账号`);
      console.log(`[batch] 模式: ${mode} | 并行: ${parallel} | 间隔: ${delay}s | 重试: ${maxRetries}`);
      console.log(`[batch] IMAP: ${CONFIG.imapUser || "未配置"}`);
      console.log(`[batch] Catch-all: ${CATCHALL_DOMAIN || "未配置"}`);
      console.log("[batch] ═══════════════════════════════════════");

      // 清理收件箱：标记旧的 Windsurf/Codeium 邮件为已读
      if (CONFIG.imapUser && CONFIG.imapPass) {
        console.log("[batch] 清理收件箱中旧的未读邮件...");
        try {
          const cleanImap = new MiniIMAP(CONFIG.imapHost, CONFIG.imapPort);
          await cleanImap.connect();
          await cleanImap.login(CONFIG.imapUser, CONFIG.imapPass);
          await cleanImap.select("INBOX");
          let oldUids = await cleanImap.search('UNSEEN FROM "windsurf"').catch(() => []);
          const oldUids2 = await cleanImap.search('UNSEEN FROM "codeium"').catch(() => []);
          const allOld = [...new Set([...oldUids, ...oldUids2])];
          if (allOld.length > 0) {
            for (const uid of allOld) {
              try { await cleanImap.store(uid, "+FLAGS", "\\Seen"); } catch {}
            }
            console.log(`[batch] ✓ 已标记 ${allOld.length} 封旧邮件为已读`);
          } else {
            console.log("[batch] ✓ 收件箱干净");
          }
          await cleanImap.logout();
        } catch (err) {
          console.log(`[batch] ⚠ 清理收件箱失败: ${err.message}`);
        }
      }

      const results = { success: [], failed: [], noApiKey: [], durationsSec: [] };
      const startTime = Date.now();
      let completed = 0;

      // 单个账号注册+后处理的完整流程
      async function registerOneAccount(taskIndex) {
        const wk = `[W${taskIndex % parallel}]`;
        const accountStart = Date.now();
        console.log(`\n${wk} ════ ${taskIndex + 1}/${count} ════`);

        // 随机交错启动延迟（避免同时访问）
        if (parallel > 1 && taskIndex >= parallel) {
          const jitter = delay * 1000 + Math.random() * 5000;
          console.log(`${wk} 等待 ${(jitter / 1000).toFixed(1)} 秒...`);
          await new Promise((r) => setTimeout(r, jitter));
        } else if (parallel > 1 && taskIndex > 0) {
          // 首批 worker 之间加 3-8 秒交错
          const stagger = 3000 + Math.random() * 5000;
          await new Promise((r) => setTimeout(r, stagger));
        }

        let identity = await generateIdentity(true);
        console.log(`${wk} 邮箱: ${identity.email}`);

        let result = null;
        let lastErr = null;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          if (attempt > 0) {
            console.log(`${wk}   重试 ${attempt}/${maxRetries}...`);
            await new Promise((r) => setTimeout(r, 5000));
            // 重试时换新邮箱，避免同一邮箱旧验证码干扰
            identity = await generateIdentity(true);
            console.log(`${wk}   新邮箱: ${identity.email}`);
          }

          try {
            if (mode === "codeium") {
              result = await registerViaCodeium(identity, { headless: !headful });
            } else {
              result = await registerViaPuppeteer(identity, { headless: !headful });
            }
            if (result && (result.status === "registered" || result.status === "registered_no_token")) {
              break;
            }
            lastErr = result?.status || "unknown";
          } catch (err) {
            lastErr = err.message;
            console.error(`${wk}   ✗ 错误: ${err.message}`);
          }
        }

        if (result) {
          await addAccount(result);

          // apiKey 补获取
          if (result.firebaseIdToken && !result.apiKey) {
            console.log(`${wk}   → 补获取 apiKey...`);
            const endpoints = [
              { base: CONFIG.registerServer, path: CONFIG.rpcRegisterUser },
              { base: "https://server.codeium.com", path: "/exa.seat_management_pb.SeatManagementService/RegisterUser" },
            ];
            for (const ep of endpoints) {
              if (result.apiKey) break;
              try {
                const regReq = encodeRegisterUserRequest(result.firebaseIdToken);
                const regRes = await callConnectRpc(ep.base, ep.path, regReq);
                console.log(`${wk}     ${ep.base} → ${regRes.status} (${regRes.body.length}B)`);
                if (regRes.status === 200 && regRes.body.length > 5) {
                  const frames = parseConnectFrames(regRes.body);
                  if (frames.length > 0) {
                    const strings = extractStringsFromProtobuf(frames[0].data);
                    const key = strings.find(s => s.value && s.value.length > 20 && !s.value.includes(" "));
                    if (key) {
                      result.apiKey = key.value;
                      await addAccount(result);
                      console.log(`${wk}   ✓ apiKey: ${result.apiKey.substring(0, 30)}...`);
                    }
                  }
                }
              } catch (err) {
                console.log(`${wk}     ✗ ${ep.base}: ${err.message}`);
              }
            }
          }

          if (result.status === "registered" || result.status === "registered_no_token") {
            await syncToSessions(result);
            if (result.apiKey) {
              results.success.push(result.email);
            } else {
              results.noApiKey.push(result.email);
            }
          } else {
            results.failed.push({ email: result.email, reason: result.status });
          }
        } else {
          results.failed.push({ email: identity.email, reason: lastErr || "all retries failed" });
        }

        const accountDurationSec = (Date.now() - accountStart) / 1000;
        results.durationsSec.push(accountDurationSec);
        console.log(`${wk} ⏱ 本账号耗时: ${accountDurationSec.toFixed(1)}s`);

        completed++;
        const pct = ((completed / count) * 100).toFixed(0);
        const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
        console.log(`${wk} ── 进度: ${completed}/${count} (${pct}%) | 成功:${results.success.length} 无key:${results.noApiKey.length} 失败:${results.failed.length} | ${elapsed}min`);
      }

      if (parallel <= 1) {
        // 串行模式
        for (let i = 0; i < count; i++) {
          await registerOneAccount(i);
          if (i < count - 1) {
            const jitter = delay * 1000 + Math.random() * 5000;
            console.log(`[batch] 等待 ${(jitter / 1000).toFixed(1)} 秒...`);
            await new Promise((r) => setTimeout(r, jitter));
          }
        }
      } else {
        // 并行模式：worker pool
        const queue = Array.from({ length: count }, (_, i) => i);
        const workers = [];

        for (let w = 0; w < Math.min(parallel, count); w++) {
          workers.push((async () => {
            while (queue.length > 0) {
              const taskIndex = queue.shift();
              if (taskIndex === undefined) break;
              try {
                await registerOneAccount(taskIndex);
              } catch (err) {
                console.error(`[W${w}] 未捕获错误: ${err.message}`);
                results.failed.push({ email: `task-${taskIndex}`, reason: err.message });
                completed++;
              }
            }
          })());
        }

        await Promise.all(workers);
      }

      const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
      const timingCount = results.durationsSec.length;
      const timingAvg = timingCount > 0
        ? (results.durationsSec.reduce((a, b) => a + b, 0) / timingCount)
        : 0;
      const timingMin = timingCount > 0 ? Math.min(...results.durationsSec) : 0;
      const timingMax = timingCount > 0 ? Math.max(...results.durationsSec) : 0;

      console.log();
      console.log("[batch] ═══════════════════════════════════════");
      console.log(`[batch] 完成! 耗时 ${elapsed} 分钟 (${parallel} 并行)`);
      console.log(`[batch]   ✓ 完整成功 (有apiKey): ${results.success.length}`);
      console.log(`[batch]   △ 注册成功 (无apiKey): ${results.noApiKey.length}`);
      console.log(`[batch]   ✗ 失败: ${results.failed.length}`);
      console.log(`[batch]   ⏱ 单账号耗时(秒): avg=${timingAvg.toFixed(1)} min=${timingMin.toFixed(1)} max=${timingMax.toFixed(1)}`);
      if (results.failed.length > 0) {
        console.log("[batch] 失败列表:");
        for (const f of results.failed) {
          console.log(`  - ${f.email}: ${f.reason}`);
        }
      }
      console.log("[batch] ═══════════════════════════════════════");
      break;
    }

    case "daemon": {
      // 守护进程模式：持续维持账号池（动态号池管理）
      const staticTarget = parseInt(getArg("target-pool", "0")); // 0=动态模式
      const intervalMin = parseInt(getArg("interval", "30"));
      const mode = getArg("mode", "codeium");
      const headful = getFlag("headful");
      const maxRetries = parseInt(getArg("retries", "1"));
      const perDomainDailyLimit = parseInt(getArg("domain-daily-limit", "60"));
      const userMultiplier = parseFloat(getArg("user-multiplier", "1.5"));
      const bufferAccounts = parseInt(getArg("buffer", "5"));

      // 多域名轮换：来自 env + domains.json
      let domainList = getAllCatchallDomains();
      let domainIndex = 0;
      const minDomains = parseInt(getArg("min-domains", "2"));
      const autoProvision = CONFIG.dynadotApiKey && CONFIG.cloudflareApiToken && CONFIG.cloudflareAccountId;

      // 每域名每日注册计数 { "2026-02-26": { "onemail590.top": 3, ... } }
      const domainDailyUsage = {};
      function todayStr() { return new Date().toISOString().slice(0, 10); }
      function getDomainUsageToday(domain) {
        const day = todayStr();
        return (domainDailyUsage[day] && domainDailyUsage[day][domain]) || 0;
      }
      function incDomainUsage(domain) {
        const day = todayStr();
        if (!domainDailyUsage[day]) domainDailyUsage[day] = {};
        domainDailyUsage[day][domain] = (domainDailyUsage[day][domain] || 0) + 1;
        // 清理旧日期
        for (const k of Object.keys(domainDailyUsage)) {
          if (k < day) delete domainDailyUsage[k];
        }
      }
      // 选择今日用量最少且未达上限的域名
      function pickBestDomain() {
        if (domainList.length === 0) return null;
        let best = null, bestCount = Infinity;
        for (const d of domainList) {
          const count = getDomainUsageToday(d);
          if (count < perDomainDailyLimit && count < bestCount) {
            best = d; bestCount = count;
          }
        }
        return best;
      }
      function getTotalDailyRemaining() {
        return domainList.reduce((sum, d) => sum + Math.max(0, perDomainDailyLimit - getDomainUsageToday(d)), 0);
      }

      // ── wind.db 集成 ──
      // wind.db 可能在多个位置
      const DB_CANDIDATES = [
        path.join(PROJECT_ROOT, "data", "wind.db"),
        "/opt/wind-server/data/wind.db",
        path.join(PROJECT_ROOT, "..", "wind-server", "data", "wind.db"),
        path.join(PROJECT_ROOT, "..", "data", "wind.db"),
      ];
      const DB_PATH = DB_CANDIDATES.find(p => fs.existsSync(p)) || DB_CANDIDATES[0];
      let windDb = null;
      function getWindDb() {
        if (windDb) return windDb;
        try {
          const Database = require("better-sqlite3");
          windDb = new Database(DB_PATH);
          windDb.pragma("journal_mode = WAL");
          return windDb;
        } catch (err) {
          console.log(`[daemon] ⚠ 无法连接 wind.db: ${err.message}`);
          return null;
        }
      }
      // 查询最近7天活跃用户数
      function getActiveUserCount() {
        const db = getWindDb();
        if (!db) return 0;
        try {
          const row = db.prepare(
            "SELECT COUNT(*) as c FROM users WHERE last_login > datetime('now', '-7 days')"
          ).get();
          return row?.c || 0;
        } catch { return 0; }
      }
      // 查询 pool_accounts 中有效账号数
      function getPoolAccountCount() {
        const db = getWindDb();
        if (!db) return 0;
        try {
          const row = db.prepare(
            "SELECT COUNT(*) as c FROM pool_accounts WHERE status = 'active'"
          ).get();
          return row?.c || 0;
        } catch { return 0; }
      }
      // 注册成功后写入 pool_accounts
      function writeToPoolAccounts(account) {
        const db = getWindDb();
        if (!db || !account.apiKey) return false;
        try {
          // 获取默认 pool
          let pool = db.prepare("SELECT id FROM pools WHERE code = 'default' LIMIT 1").get();
          if (!pool) pool = db.prepare("SELECT id FROM pools ORDER BY id LIMIT 1").get();
          if (!pool) {
            console.log(`[daemon] ⚠ wind.db 无可用 pool，跳过写入`);
            return false;
          }
          const sessionData = JSON.stringify({
            apiKey: account.apiKey,
            firebaseIdToken: account.firebaseIdToken || null,
            uid: account.uid || null,
            email: account.email || null,
            expiresAt: account.expiresAt || null,
          });
          // 去重
          const existing = db.prepare(
            "SELECT id FROM pool_accounts WHERE pool_id = ? AND label = ?"
          ).get(pool.id, account.email);
          if (existing) {
            db.prepare("UPDATE pool_accounts SET session_token = ?, status = 'active' WHERE id = ?").run(sessionData, existing.id);
          } else {
            db.prepare(
              "INSERT INTO pool_accounts (pool_id, label, session_token, platform, daily_limit, status) VALUES (?, ?, ?, ?, ?, 'active')"
            ).run(pool.id, account.email, sessionData, "codeium", 80000);
          }
          console.log(`[daemon] ✓ 已写入 pool_accounts (pool=${pool.id})`);
          return true;
        } catch (err) {
          console.log(`[daemon] ⚠ 写入 pool_accounts 失败: ${err.message}`);
          return false;
        }
      }
      // 动态计算目标池大小
      function calcTargetPool() {
        if (staticTarget > 0) return staticTarget; // 手动指定则用固定值
        const activeUsers = getActiveUserCount();
        const target = Math.ceil(activeUsers * userMultiplier) + bufferAccounts;
        return Math.max(target, 10); // 最少维持 10 个
      }

      // PID 文件
      const pidFile = path.join(PROJECT_ROOT, "config", "daemon.pid");
      fs.writeFileSync(pidFile, String(process.pid));

      const activeUsers = getActiveUserCount();
      const initialTarget = calcTargetPool();
      console.log("[daemon] ═══════════════════════════════════════");
      console.log(`[daemon] 守护进程启动 (PID: ${process.pid})`);
      console.log(`[daemon] 模式: ${staticTarget > 0 ? '固定' : '动态'} | 目标: ${initialTarget} (活跃用户: ${activeUsers}, 倍率: ${userMultiplier}x + 缓冲: ${bufferAccounts})`);
      console.log(`[daemon] 注册间隔: ${intervalMin} 分钟`);
      console.log(`[daemon] 每域名日限: ${perDomainDailyLimit} 个`);
      console.log(`[daemon] 注册模式: ${mode}`);
      console.log(`[daemon] IMAP: ${CONFIG.imapUser || "未配置"}`);
      console.log(`[daemon] 域名池: ${domainList.length > 0 ? domainList.join(", ") : "未配置"}`);
      console.log(`[daemon] 自动购买域名: ${autoProvision ? `启用 (最少 ${minDomains} 个)` : "未配置"}`);
      console.log(`[daemon] wind.db: ${fs.existsSync(DB_PATH) ? '已连接' : '未找到(仅用JSON)'}`);
      console.log("[daemon] ═══════════════════════════════════════");

      // 统计
      const stats = { attempts: 0, success: 0, failed: 0, startTime: Date.now() };

      // 优雅退出
      let running = true;
      const shutdown = () => {
        console.log("\n[daemon] 收到退出信号，停止...");
        running = false;
        try { fs.unlinkSync(pidFile); } catch {}
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);

      // 计算当前有效账号数
      function countActiveAccounts() {
        const data = loadAccounts();
        return data.accounts.filter(
          a => a.status === "registered" && a.apiKey && new Date(a.expiresAt) > new Date()
        ).length;
      }

      // 清理收件箱
      async function cleanInbox() {
        if (!CONFIG.imapUser || !CONFIG.imapPass) return;
        try {
          const cleanImap = new MiniIMAP(CONFIG.imapHost, CONFIG.imapPort);
          await cleanImap.connect();
          await cleanImap.login(CONFIG.imapUser, CONFIG.imapPass);
          await cleanImap.select("INBOX");
          let oldUids = await cleanImap.search('UNSEEN FROM "windsurf"').catch(() => []);
          const oldUids2 = await cleanImap.search('UNSEEN FROM "codeium"').catch(() => []);
          const allOld = [...new Set([...oldUids, ...oldUids2])];
          if (allOld.length > 0) {
            for (const uid of allOld) {
              try { await cleanImap.store(uid, "+FLAGS", "\\Seen"); } catch {}
            }
            console.log(`[daemon] 清理 ${allOld.length} 封旧邮件`);
          }
          await cleanImap.logout();
        } catch (err) {
          console.log(`[daemon] 清理收件箱失败: ${err.message}`);
        }
      }

      // 注册一个账号
      async function daemonRegisterOne() {
        // 智能选择域名（用量最少且未达日限）
        let originalDomain = CATCHALL_DOMAIN;
        const chosenDomain = pickBestDomain();
        if (chosenDomain) {
          process.env.CATCHALL_DOMAIN = chosenDomain;
          console.log(`[daemon] 使用域名: ${chosenDomain} (今日已用: ${getDomainUsageToday(chosenDomain)}/${perDomainDailyLimit})`);
        } else if (domainList.length > 0) {
          console.log(`[daemon] ⚠ 所有域名已达今日上限 (${perDomainDailyLimit}/域名)，跳过本轮`);
          return false;
        }

        let identity = await generateIdentity(true);
        console.log(`[daemon] 邮箱: ${identity.email}`);

        let result = null;
        let lastErr = null;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          if (attempt > 0) {
            console.log(`[daemon]   重试 ${attempt}/${maxRetries}...`);
            await new Promise(r => setTimeout(r, 5000));
            identity = await generateIdentity(true);
            console.log(`[daemon]   新邮箱: ${identity.email}`);
          }

          try {
            if (mode === "codeium") {
              result = await registerViaCodeium(identity, { headless: !headful });
            } else {
              result = await registerViaPuppeteer(identity, { headless: !headful });
            }
            if (result && (result.status === "registered" || result.status === "registered_no_token")) {
              break;
            }
            lastErr = result?.status || "unknown";
          } catch (err) {
            lastErr = err.message;
            console.error(`[daemon]   ✗ 错误: ${err.message}`);
          }
        }

        // 恢复原域名
        if (originalDomain) process.env.CATCHALL_DOMAIN = originalDomain;

        if (result) {
          await addAccount(result);
          // 记录域名使用量
          if (chosenDomain) incDomainUsage(chosenDomain);

          // apiKey 补获取
          if (result.firebaseIdToken && !result.apiKey) {
            console.log("[daemon]   → 补获取 apiKey...");
            const endpoints = [
              { base: CONFIG.registerServer, path: CONFIG.rpcRegisterUser },
              { base: "https://server.codeium.com", path: "/exa.seat_management_pb.SeatManagementService/RegisterUser" },
            ];
            for (const ep of endpoints) {
              if (result.apiKey) break;
              try {
                const regReq = encodeRegisterUserRequest(result.firebaseIdToken);
                const regRes = await callConnectRpc(ep.base, ep.path, regReq);
                if (regRes.status === 200 && regRes.body.length > 5) {
                  const frames = parseConnectFrames(regRes.body);
                  if (frames.length > 0) {
                    const strings = extractStringsFromProtobuf(frames[0].data);
                    const key = strings.find(s => s.value && s.value.length > 20 && !s.value.includes(" "));
                    if (key) {
                      result.apiKey = key.value;
                      await addAccount(result);
                      console.log(`[daemon]   ✓ apiKey: ${result.apiKey.substring(0, 30)}...`);
                    }
                  }
                }
              } catch (err) {
                console.log(`[daemon]     ✗ ${ep.base}: ${err.message}`);
              }
            }
          }

          if (result.status === "registered" || result.status === "registered_no_token") {
            await syncToSessions(result);
            if (result.apiKey) {
              stats.success++;
              // 写入 wind.db pool_accounts
              writeToPoolAccounts(result);
              console.log(`[daemon] ✓ 注册成功: ${result.email}`);
              return true;
            } else {
              console.log(`[daemon] △ 注册成功但无 apiKey: ${result.email}`);
              return true;
            }
          }
        }

        stats.failed++;
        console.log(`[daemon] ✗ 注册失败: ${lastErr}`);
        return false;
      }

      // 主循环
      while (running) {
        const targetPool = calcTargetPool();
        const active = countActiveAccounts();
        const dbAccounts = getPoolAccountCount();
        const dailyRemaining = getTotalDailyRemaining();
        const users = getActiveUserCount();
        const uptimeMin = ((Date.now() - stats.startTime) / 60000).toFixed(0);
        console.log(`\n[daemon] ── ${new Date().toLocaleString()} ──`);
        console.log(`[daemon] 活跃用户: ${users} | 目标池: ${targetPool} | JSON账号: ${active} | DB账号: ${dbAccounts}`);
        console.log(`[daemon] 今日剩余额度: ${dailyRemaining} | 累计: ✓${stats.success} ✗${stats.failed} | 运行${uptimeMin}min`);
        // 域名用量明细
        for (const d of domainList) {
          console.log(`[daemon]   ${d}: ${getDomainUsageToday(d)}/${perDomainDailyLimit}`);
        }

        if (active >= targetPool) {
          console.log(`[daemon] 池已满 (${active}/${targetPool})，休眠 ${intervalMin} 分钟...`);
        } else if (dailyRemaining <= 0) {
          console.log(`[daemon] 今日所有域名已达上限，休眠到明天...`);
          // 计算到明天 00:05 的毫秒数
          const now = new Date();
          const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
          tomorrow.setHours(0, 5, 0, 0);
          const sleepMs = tomorrow - now;
          console.log(`[daemon] 将在 ${(sleepMs / 3600000).toFixed(1)} 小时后恢复`);
          const sleepEnd = Date.now() + sleepMs;
          while (running && Date.now() < sleepEnd) {
            await new Promise(r => setTimeout(r, 30000));
          }
          continue;
        } else {
          const deficit = targetPool - active;
          console.log(`[daemon] 需补充 ${deficit} 个账号，开始注册...`);

          // 检查域名池，不足时自动购买
          domainList = getAllCatchallDomains();
          if (domainList.length < minDomains && autoProvision) {
            const need = minDomains - domainList.length;
            console.log(`[daemon] 域名不足 (${domainList.length}/${minDomains})，自动购买 ${need} 个...`);
            for (let di = 0; di < need; di++) {
              try {
                const newDomain = await provisionDomain();
                domainList.push(newDomain);
                console.log(`[daemon] ✓ 新域名: ${newDomain}`);
              } catch (err) {
                console.log(`[daemon] ✗ 购买域名失败: ${err.message}`);
                break;
              }
              if (di < need - 1) await new Promise(r => setTimeout(r, 5000));
            }
          }

          stats.attempts++;
          await cleanInbox();
          await daemonRegisterOne();
        }

        // 等待 interval（可被 SIGINT 中断）
        const waitMs = intervalMin * 60 * 1000 + Math.random() * 60000; // 加随机抖动
        const waitEnd = Date.now() + waitMs;
        while (running && Date.now() < waitEnd) {
          await new Promise(r => setTimeout(r, 5000));
        }
      }

      // 退出统计
      const totalMin = ((Date.now() - stats.startTime) / 60000).toFixed(1);
      console.log("\n[daemon] ═══════════════════════════════════════");
      console.log(`[daemon] 守护进程退出`);
      console.log(`[daemon]   运行时间: ${totalMin} 分钟`);
      console.log(`[daemon]   注册尝试: ${stats.attempts}`);
      console.log(`[daemon]   成功: ${stats.success}`);
      console.log(`[daemon]   失败: ${stats.failed}`);
      console.log("[daemon] ═══════════════════════════════════════");
      try { fs.unlinkSync(pidFile); } catch {}
      break;
    }

    case "buy-domain": {
      // 手动购买域名
      const domainCount = parseInt(getArg("count", "1"));
      console.log("[domain] ═══════════════════════════════════════");
      console.log(`[domain] 购买 ${domainCount} 个 .top 域名`);
      console.log("[domain] ═══════════════════════════════════════");

      if (!CONFIG.dynadotApiKey) {
        console.error("[domain] ✗ 需要 DYNADOT_API_KEY（在 .env 中配置）");
        console.error("[domain]   1. 注册 https://www.dynadot.com/");
        console.error("[domain]   2. 充值 $5+（支持支付宝）");
        console.error("[domain]   3. 设置页生成 API Key");
        process.exit(1);
      }
      if (!CONFIG.cloudflareApiToken || !CONFIG.cloudflareAccountId) {
        console.error("[domain] ✗ 需要 CLOUDFLARE_API_TOKEN 和 CLOUDFLARE_ACCOUNT_ID（在 .env 中配置）");
        console.error("[domain]   1. 注册 https://dash.cloudflare.com/");
        console.error("[domain]   2. Profile → API Tokens → Create Token");
        console.error("[domain]   3. 权限: Zone:Edit, Email Routing:Edit");
        console.error("[domain]   4. Account ID 在 Cloudflare 首页右侧栏");
        process.exit(1);
      }

      const purchased = [];
      for (let i = 0; i < domainCount; i++) {
        console.log(`\n[domain] ── ${i + 1}/${domainCount} ──`);
        try {
          const domain = await provisionDomain();
          purchased.push(domain);
        } catch (err) {
          console.error(`[domain] ✗ 失败: ${err.message}`);
        }
        if (i < domainCount - 1) await new Promise(r => setTimeout(r, 3000));
      }

      console.log("\n[domain] ═══════════════════════════════════════");
      console.log(`[domain] 完成: ${purchased.length}/${domainCount} 个域名`);
      if (purchased.length > 0) {
        console.log(`[domain] 新域名: ${purchased.join(", ")}`);
        console.log(`[domain] 所有可用域名: ${getAllCatchallDomains().join(", ")}`);
      }
      console.log("[domain] ═══════════════════════════════════════");
      console.log("[domain] ⚠ 注意：Cloudflare Email Routing 目标邮箱首次需手动验证");
      console.log("[domain]   检查 QQ 邮箱是否收到 Cloudflare 验证邮件并点击确认");
      console.log("[domain] ⚠ DNS 生效需要 5-30 分钟，之后才能接收转发邮件");
      break;
    }

    case "list-domains": {
      const allDomains = getAllCatchallDomains();
      const domainsData = loadDomains();
      console.log("[domain] ═══════════════════════════════════════");
      console.log(`[domain] 可用域名: ${allDomains.length} 个`);
      console.log("[domain] ═══════════════════════════════════════");
      for (const d of allDomains) {
        const info = domainsData.domains.find(x => x.domain === d);
        if (info) {
          console.log(`  ${d} | ${info.registrar} | ${info.registeredAt} | → ${info.forwardTo}`);
        } else {
          console.log(`  ${d} | env 配置`);
        }
      }
      console.log("[domain] ═══════════════════════════════════════");
      break;
    }

    case "status": {
      const data = loadAccounts();
      const now = new Date();
      const total = data.accounts.length;
      const registered = data.accounts.filter(a => a.status === "registered").length;
      const proTrial = data.accounts.filter(a => a.status === "pro_trial").length;
      const proTrialActive = data.accounts.filter(a =>
        a.status === "pro_trial" && a.trialExpiresAt && new Date(a.trialExpiresAt) > now
      ).length;
      const cancelled = data.accounts.filter(a => a.status === "trial_cancelled").length;
      const active = data.accounts.filter(a =>
        (a.status === "registered" || a.status === "pro_trial") &&
        a.apiKey && new Date(a.expiresAt) > now
      ).length;
      const expired = data.accounts.filter(a => new Date(a.expiresAt) <= now).length;
      const pending = data.accounts.filter(a => a.status === "pending_verification").length;

      // VCC 使用统计
      const vccUsage = loadVccUsage();
      const vccAvailable = CONFIG.vccCards.length || (CONFIG.vccSingleCard ? 1 : 0);

      console.log("[status] ═══════════════════════════════════════");
      console.log("[status] 账号池状态");
      console.log("[status] ═══════════════════════════════════════");
      console.log(`  总计:       ${total}`);
      console.log(`  已注册:     ${registered} (普通试用)`);
      console.log(`  Pro Trial:  ${proTrial} (活跃: ${proTrialActive})`);
      console.log(`  已取消:     ${cancelled}`);
      console.log(`  待验证:     ${pending}`);
      console.log(`  有效(有key): ${active}`);
      console.log(`  过期:       ${expired}`);
      console.log();
      console.log(`  VCC 配置:   ${vccAvailable} 张`);
      console.log(`  VCC 已绑定: ${vccUsage.used?.length || 0} 次`);

      // 即将到期的 Pro Trial（需要取消）
      const soonExpire = data.accounts.filter(a =>
        a.status === "pro_trial" && a.trialExpiresAt && !a.cancelledAt &&
        new Date(a.trialExpiresAt) <= new Date(now.getTime() + CONFIG.cancelBeforeDays * 86400_000)
      );
      if (soonExpire.length > 0) {
        console.log();
        console.log(`  ⚠ ${soonExpire.length} 个 Pro Trial 即将到期（需取消）:`);
        for (const a of soonExpire) {
          const daysLeft = Math.ceil((new Date(a.trialExpiresAt) - now) / 86400_000);
          console.log(`    ${a.email} | ${daysLeft}天后到期 | VCC *${a.vccLast4 || "?"}`);
        }
        console.log(`  → 运行: node windsurf-registrar.js auto-cancel`);
      }

      if (data.accounts.length > 0) {
        console.log();
        console.log("  最近账号:");
        for (const a of data.accounts.slice(-8)) {
          const expiresField = a.trialExpiresAt || a.expiresAt;
          const expires = new Date(expiresField);
          const isExpired = expires <= now;
          const daysLeft = Math.ceil((expires - now) / 86400_000);
          const statusIcon = a.status === "pro_trial" ? "⭐" :
            a.status === "trial_cancelled" ? "🚫" :
            a.status === "registered" ? "✓" : "◌";
          console.log(
            `    ${statusIcon} ${a.email} | ${a.status} | ${isExpired ? "已过期" : `${daysLeft}天`} ${a.vccLast4 ? `| VCC *${a.vccLast4}` : ""}`,
          );
        }
      }

      console.log("[status] ═══════════════════════════════════════");
      break;
    }

    case "login": {
      // 登录已注册的账号，捕获 Firebase ID Token 和 API Key
      const email = getArg("email", null);
      const password = getArg("password", CONFIG.defaultPassword);

      if (!email) {
        console.error("[login] 需要 --email 参数");
        process.exit(1);
      }

      console.log("[login] ═══════════════════════════════════════");
      console.log(`[login] 登录账号: ${email}`);
      console.log("[login] ═══════════════════════════════════════");

      const result = await loginViaCodeium(email, password, {
        headless: !getFlag("headful"),
      });

      if (result) {
        // 更新账号池
        const data = loadAccounts();
        const idx = data.accounts.findIndex((a) => a.email === email);
        if (idx >= 0) {
          data.accounts[idx].firebaseIdToken = result.firebaseIdToken;
          data.accounts[idx].apiKey = result.apiKey;
          data.accounts[idx].status = result.apiKey ? "registered" : data.accounts[idx].status;
          saveAccounts(data);
        }
        await syncToSessions(result);

        console.log("[login] ═══════════════════════════════════════");
        console.log(`[login] 结果: ${result.apiKey ? "成功" : "仅获取 Token"}`);
        if (result.apiKey) console.log(`[login] API Key: ${result.apiKey.substring(0, 30)}...`);
        if (result.firebaseIdToken) console.log(`[login] Firebase Token: ${result.firebaseIdToken.substring(0, 30)}...`);
        if (result.firebaseApiKey) console.log(`[login] Firebase API Key: ${result.firebaseApiKey}`);
        console.log("[login] ═══════════════════════════════════════");
      } else {
        console.log("[login] ✗ 登录失败");
      }
      break;
    }

    case "batch-login": {
      // 批量登录所有 pending 账号
      const data = loadAccounts();
      const pending = data.accounts.filter(
        (a) => !a.apiKey && (a.status === "registered" || a.status === "pending_verification")
      );
      const limit = parseInt(getArg("count", String(pending.length)));
      const delay = parseInt(getArg("delay", "10"));
      const targets = pending.slice(0, limit);

      console.log("[batch-login] ═══════════════════════════════════════");
      console.log(`[batch-login] 待登录: ${targets.length} 个账号`);
      console.log("[batch-login] ═══════════════════════════════════════");

      let success = 0;
      let failed = 0;

      for (let i = 0; i < targets.length; i++) {
        const acc = targets[i];
        console.log(`\n[batch-login] ──── ${i + 1}/${targets.length}: ${acc.email} ────`);

        try {
          const result = await loginViaCodeium(acc.email, acc.password || CONFIG.defaultPassword, {
            headless: !getFlag("headful"),
          });

          if (result && (result.apiKey || result.firebaseIdToken)) {
            acc.firebaseIdToken = result.firebaseIdToken;
            acc.apiKey = result.apiKey;
            acc.status = result.apiKey ? "registered" : acc.status;
            saveAccounts(data);
            await syncToSessions({ ...acc, ...result });
            success++;
            console.log(`[batch-login]   ✓ ${result.apiKey ? "API Key 获取成功" : "仅 Token"}`);
          } else {
            failed++;
            console.log("[batch-login]   ✗ 登录失败");
          }
        } catch (err) {
          failed++;
          console.error(`[batch-login]   ✗ 错误: ${err.message}`);
        }

        if (i < targets.length - 1) {
          const jitter = delay * 1000 + Math.random() * 3000;
          console.log(`[batch-login] 等待 ${(jitter / 1000).toFixed(1)} 秒...`);
          await new Promise((r) => setTimeout(r, jitter));
        }
      }

      console.log();
      console.log("[batch-login] ═══════════════════════════════════════");
      console.log(`[batch-login] 完成: ${success} 成功, ${failed} 失败`);
      console.log("[batch-login] ═══════════════════════════════════════");
      break;
    }

    case "api-register": {
      // 纯 API 模式（需要手动提供 Turnstile token）
      const identity = await generateIdentity(false);
      const turnstileToken = getArg("turnstile-token", null);

      if (!turnstileToken) {
        console.error("[registrar] API 模式需要 --turnstile-token 参数");
        console.error("[registrar] 你可以从浏览器开发者工具中手动获取 Turnstile token");
        process.exit(1);
      }

      const result = await registerViaApi({
        ...identity,
        turnstileToken,
      });
      console.log("[registrar] 结果:", result);
      break;
    }

    case "activate-trial": {
      // 为已注册的账号激活 Pro Trial（绑定 VCC）
      const email = getArg("email", null);
      const headful = getFlag("headful");

      if (!email) {
        console.error("[activate-trial] 需要 --email 参数");
        console.error("[activate-trial] 用法: node windsurf-registrar.js activate-trial --email user@example.com");
        process.exit(1);
      }

      // 获取 VCC
      const vcc = getNextVcc();
      if (!vcc) {
        console.error("[activate-trial] ✗ 未配置 VCC（虚拟信用卡）");
        console.error("[activate-trial] 配置方法（.env 文件）:");
        console.error("  VCC_CARD_NUMBER=4242424242424242");
        console.error("  VCC_CARD_EXPIRY=12/30");
        console.error("  VCC_CARD_CVC=123");
        console.error("  VCC_CARD_ZIP=10001");
        console.error("  或多张卡: VCC_CARDS='4242...,12/30,123,10001;4000...,06/28,456,90210'");
        process.exit(1);
      }

      // 查找账号
      const data = loadAccounts();
      const account = data.accounts.find(a => a.email === email);
      if (!account) {
        console.error(`[activate-trial] ✗ 账号 ${email} 不在账号池中`);
        process.exit(1);
      }

      const result = await activateProTrial(account, vcc, { headless: !headful });

      if (result.success) {
        markVccUsed(vcc, email);
        account.status = "pro_trial";
        account.trialActivatedAt = result.trialActivatedAt;
        account.trialExpiresAt = result.trialExpiresAt;
        account.vccLast4 = vcc.number.slice(-4);
        if (result.apiKey) account.apiKey = result.apiKey;
        if (result.firebaseIdToken) account.firebaseIdToken = result.firebaseIdToken;
        saveAccounts(data);
        await syncToSessions(account);

        console.log("[activate-trial] ═══════════════════════════════════════");
        console.log(`[activate-trial] ✓ Pro Trial 激活成功!`);
        console.log(`[activate-trial]   邮箱: ${email}`);
        console.log(`[activate-trial]   VCC: **** ${vcc.number.slice(-4)}`);
        console.log(`[activate-trial]   到期: ${result.trialExpiresAt}`);
        if (result.apiKey) console.log(`[activate-trial]   API Key: ${result.apiKey.substring(0, 30)}...`);
        console.log("[activate-trial] ═══════════════════════════════════════");
      } else {
        console.log("[activate-trial] ═══════════════════════════════════════");
        console.log(`[activate-trial] ✗ 激活失败: ${result.error}`);
        console.log("[activate-trial] ═══════════════════════════════════════");
      }
      break;
    }

    case "cancel-trial": {
      // 取消指定账号的 Pro Trial
      const email = getArg("email", null);
      const headful = getFlag("headful");

      if (!email) {
        console.error("[cancel-trial] 需要 --email 参数");
        process.exit(1);
      }

      const data = loadAccounts();
      const account = data.accounts.find(a => a.email === email);
      if (!account) {
        console.error(`[cancel-trial] ✗ 账号 ${email} 不在账号池中`);
        process.exit(1);
      }

      const result = await cancelProTrial(account, { headless: !headful });

      if (result.success) {
        account.status = "trial_cancelled";
        account.cancelledAt = new Date().toISOString();
        saveAccounts(data);

        console.log("[cancel-trial] ═══════════════════════════════════════");
        console.log(`[cancel-trial] ✓ 订阅已取消: ${email}`);
        console.log("[cancel-trial] ═══════════════════════════════════════");
      } else {
        console.log(`[cancel-trial] ✗ 取消失败: ${result.error || "unknown"}`);
      }
      break;
    }

    case "batch-activate": {
      // 批量激活：为所有已注册但未激活的账号绑 VCC + 激活 Pro Trial
      const headful = getFlag("headful");
      const limit = parseInt(getArg("count", "10"));
      const delay = parseInt(getArg("delay", "15"));

      const data = loadAccounts();
      const eligible = data.accounts.filter(a =>
        a.status === "registered" && a.apiKey && !a.trialActivatedAt
      );
      const targets = eligible.slice(0, limit);

      if (targets.length === 0) {
        console.log("[batch-activate] 没有可激活的账号（需 status=registered + 有 apiKey + 未激活）");
        break;
      }

      console.log("[batch-activate] ═══════════════════════════════════════");
      console.log(`[batch-activate] 批量激活 Pro Trial: ${targets.length} 个账号`);
      console.log("[batch-activate] ═══════════════════════════════════════");

      let success = 0, failed = 0;

      for (let i = 0; i < targets.length; i++) {
        const account = targets[i];
        console.log(`\n[batch-activate] ──── ${i + 1}/${targets.length}: ${account.email} ────`);

        const vcc = getNextVcc();
        if (!vcc) {
          console.error("[batch-activate] ✗ VCC 用完或未配置");
          break;
        }

        try {
          const result = await activateProTrial(account, vcc, { headless: !headful });
          if (result.success) {
            markVccUsed(vcc, account.email);
            account.status = "pro_trial";
            account.trialActivatedAt = result.trialActivatedAt;
            account.trialExpiresAt = result.trialExpiresAt;
            account.vccLast4 = vcc.number.slice(-4);
            if (result.apiKey) account.apiKey = result.apiKey;
            if (result.firebaseIdToken) account.firebaseIdToken = result.firebaseIdToken;
            saveAccounts(data);
            await syncToSessions(account);
            success++;
            console.log(`[batch-activate]   ✓ 成功`);
          } else {
            failed++;
            console.log(`[batch-activate]   ✗ 失败: ${result.error}`);
          }
        } catch (err) {
          failed++;
          console.error(`[batch-activate]   ✗ 错误: ${err.message}`);
        }

        if (i < targets.length - 1) {
          const jitter = delay * 1000 + Math.random() * 5000;
          console.log(`[batch-activate] 等待 ${(jitter / 1000).toFixed(1)} 秒...`);
          await new Promise(r => setTimeout(r, jitter));
        }
      }

      console.log("\n[batch-activate] ═══════════════════════════════════════");
      console.log(`[batch-activate] 完成: ✓${success} ✗${failed}`);
      console.log("[batch-activate] ═══════════════════════════════════════");
      break;
    }

    case "auto-cancel": {
      // 自动取消即将到期的 Pro Trial（到期前 N 天取消，避免扣费）
      const headful = getFlag("headful");
      const beforeDays = parseInt(getArg("before-days", String(CONFIG.cancelBeforeDays)));

      const data = loadAccounts();
      const now = new Date();
      const cutoff = new Date(now.getTime() + beforeDays * 24 * 3600_000);

      const needCancel = data.accounts.filter(a =>
        a.status === "pro_trial" &&
        a.trialExpiresAt &&
        new Date(a.trialExpiresAt) <= cutoff &&
        !a.cancelledAt
      );

      if (needCancel.length === 0) {
        console.log(`[auto-cancel] 无需取消（到期前 ${beforeDays} 天内无 Pro Trial 账号）`);
        break;
      }

      console.log("[auto-cancel] ═══════════════════════════════════════");
      console.log(`[auto-cancel] 自动取消 ${needCancel.length} 个即将到期的 Pro Trial`);
      console.log(`[auto-cancel] 阈值: 到期前 ${beforeDays} 天`);
      console.log("[auto-cancel] ═══════════════════════════════════════");

      let success = 0, failed = 0;

      for (let i = 0; i < needCancel.length; i++) {
        const account = needCancel[i];
        const daysLeft = Math.ceil((new Date(account.trialExpiresAt) - now) / 86400_000);
        console.log(`\n[auto-cancel] ──── ${i + 1}/${needCancel.length}: ${account.email} (${daysLeft}天后到期) ────`);

        try {
          const result = await cancelProTrial(account, { headless: !headful });
          if (result.success) {
            account.status = "trial_cancelled";
            account.cancelledAt = new Date().toISOString();
            saveAccounts(data);
            success++;
            console.log(`[auto-cancel]   ✓ 已取消`);
          } else {
            failed++;
            console.log(`[auto-cancel]   ✗ 取消失败: ${result.error || "unknown"}`);
          }
        } catch (err) {
          failed++;
          console.error(`[auto-cancel]   ✗ 错误: ${err.message}`);
        }

        if (i < needCancel.length - 1) {
          await new Promise(r => setTimeout(r, 10000 + Math.random() * 5000));
        }
      }

      console.log("\n[auto-cancel] ═══════════════════════════════════════");
      console.log(`[auto-cancel] 完成: ✓${success} ✗${failed}`);
      console.log("[auto-cancel] ═══════════════════════════════════════");
      break;
    }

    case "full-pipeline": {
      // 完整流水线：注册 → 激活 Pro Trial → 提取 Token（一键完成）
      const headful = getFlag("headful");
      const mode = getArg("mode", "codeium");

      // 检查 VCC
      const vcc = getNextVcc();
      if (!vcc) {
        console.error("[pipeline] ✗ 需要配置 VCC，请在 .env 中设置 VCC_CARD_NUMBER 等");
        process.exit(1);
      }

      console.log("[pipeline] ═══════════════════════════════════════");
      console.log("[pipeline] 完整流水线: 注册 → 激活 Pro Trial → 提取 Token");
      console.log("[pipeline] ═══════════════════════════════════════");

      // Step 1: 注册
      console.log("\n[pipeline] ═══ Step 1: 注册账号 ═══");
      let identity = await generateIdentity(true);
      let regResult;
      if (mode === "codeium") {
        regResult = await registerViaCodeium(identity, { headless: !headful });
      } else {
        regResult = await registerViaPuppeteer(identity, { headless: !headful });
      }

      if (!regResult || regResult.status === "pending_verification") {
        console.log("[pipeline] ✗ 注册失败，流水线终止");
        break;
      }

      await addAccount(regResult);
      await syncToSessions(regResult);
      console.log(`[pipeline] ✓ 注册成功: ${regResult.email}`);

      // Step 2: 激活 Pro Trial
      console.log("\n[pipeline] ═══ Step 2: 激活 Pro Trial ═══");
      await new Promise(r => setTimeout(r, 5000)); // 等一下让账号稳定

      const trialResult = await activateProTrial(regResult, vcc, { headless: !headful });

      if (trialResult.success) {
        markVccUsed(vcc, regResult.email);
        regResult.status = "pro_trial";
        regResult.trialActivatedAt = trialResult.trialActivatedAt;
        regResult.trialExpiresAt = trialResult.trialExpiresAt;
        regResult.vccLast4 = vcc.number.slice(-4);
        if (trialResult.apiKey) regResult.apiKey = trialResult.apiKey;
        if (trialResult.firebaseIdToken) regResult.firebaseIdToken = trialResult.firebaseIdToken;
        await addAccount(regResult);
        await syncToSessions(regResult);

        console.log("\n[pipeline] ═══════════════════════════════════════");
        console.log("[pipeline] ✓ 流水线完成!");
        console.log(`[pipeline]   邮箱: ${regResult.email}`);
        console.log(`[pipeline]   密码: ${regResult.password}`);
        console.log(`[pipeline]   状态: Pro Trial`);
        console.log(`[pipeline]   到期: ${regResult.trialExpiresAt}`);
        if (regResult.apiKey) console.log(`[pipeline]   API Key: ${regResult.apiKey.substring(0, 30)}...`);
        console.log("[pipeline] ═══════════════════════════════════════");
      } else {
        console.log(`[pipeline] ⚠ 注册成功但 Pro Trial 激活失败: ${trialResult.error}`);
        console.log("[pipeline]   账号已保存，可手动激活: activate-trial --email " + regResult.email);
      }
      break;
    }

    case "get-referral-code": {
      // 获取指定账号的推荐码
      const email = getArg("email", null);
      const headful = getFlag("headful");
      if (!email) {
        console.log("[get-referral-code] 请指定 --email");
        break;
      }
      const data = loadAccounts();
      const account = data.accounts.find(a => a.email === email);
      if (!account) {
        console.log(`[get-referral-code] 未找到账号: ${email}`);
        break;
      }

      let connectMod;
      try { connectMod = await import("puppeteer-real-browser"); } catch {
        console.error("[get-referral-code] 请先安装: npm install puppeteer-real-browser");
        break;
      }

      const chromePaths2 = process.platform === "win32"
        ? ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"]
        : ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium"];
      let chromePath2 = process.env.CHROME_PATH || null;
      if (!chromePath2) { for (const p of chromePaths2) { if (fs.existsSync(p)) { chromePath2 = p; break; } } }

      const ssDir = path.join(PROJECT_ROOT, "screenshots");
      fs.mkdirSync(ssDir, { recursive: true });

      const { browser: br, page: pg } = await connectMod.connect({
        headless: false, turnstile: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--window-size=1280,800"],
        customConfig: chromePath2 ? { chromePath: chromePath2 } : {},
        fingerprint: true,
      });

      try {
        await pg.goto(CONFIG.loginUrl, { waitUntil: "networkidle2", timeout: 60000 });
        await new Promise(r => setTimeout(r, 3000));
        const eIn = await pg.$('input[type="email"], input[name="email"], input[placeholder*="email" i]');
        if (eIn) { await eIn.click({ clickCount: 3 }); await eIn.type(account.email, { delay: 30 }); }
        const pIn = await pg.$('input[type="password"]');
        if (pIn) { await pIn.click({ clickCount: 3 }); await pIn.type(account.password || CONFIG.defaultPassword, { delay: 30 }); }
        await pg.evaluate(() => {
          const btns = [...document.querySelectorAll("button")];
          const b = btns.find(b => /^(log in|login|sign in|continue)$/i.test((b.textContent||"").trim()));
          if (b) b.click(); else { const sb = btns.find(b => b.type === "submit"); if (sb) sb.click(); }
        });
        for (let i = 0; i < 60; i++) {
          await new Promise(r => setTimeout(r, 1000));
          if (!pg.url().includes("/login")) break;
        }
        await new Promise(r => setTimeout(r, 3000));
        const code = await extractReferralCode(pg, ssDir);
        if (code) {
          console.log(`\n推荐链接: https://windsurf.com/refer?referral_code=${code}`);
          // 保存到账号记录
          account.referralCode = code;
          saveAccounts(data);
        }
      } finally {
        await br.close().catch(() => {});
      }
      break;
    }

    case "refer": {
      // 单次邀请推荐流程
      const headful = getFlag("headful");
      const referrerEmail = getArg("referrer", null);
      const newEmail = getArg("new-email", null);
      const skipReg = getFlag("skip-register");

      // 选择推荐人
      let referrer;
      if (referrerEmail) {
        const data = loadAccounts();
        referrer = data.accounts.find(a => a.email === referrerEmail);
        if (!referrer) {
          console.log(`[refer] 未找到推荐人账号: ${referrerEmail}`);
          break;
        }
      } else {
        referrer = pickReferrer();
        if (!referrer) {
          console.log("[refer] 没有可用的推荐人（需 status=pro_trial + 有 apiKey）");
          break;
        }
        console.log(`[refer] 自动选择推荐人: ${referrer.email} (已推荐 ${referrer.referrals?.length || 0} 次)`);
      }

      const vcc = getNextVcc();
      if (!vcc) {
        console.error("[refer] VCC 用完或未配置");
        break;
      }

      const result = await referralFlow(referrer, vcc, {
        headful,
        skipRegister: skipReg,
        newAccountEmail: newEmail,
      });

      if (!result.success) {
        console.log(`[refer] 失败: ${result.error}`);
        if (result.referralCode) {
          console.log(`[refer] 推荐码已获取: ${result.referralCode}`);
          console.log(`[refer] 可手动打开: https://windsurf.com/refer?referral_code=${result.referralCode}`);
        }
      }
      break;
    }

    case "batch-refer": {
      // 批量邀请推荐
      const count = parseInt(getArg("count", "3"));
      const delay = parseInt(getArg("delay", "30"));
      const headful = getFlag("headful");

      console.log("[batch-refer] ═══════════════════════════════════════");
      console.log(`[batch-refer] 批量邀请推荐: ${count} 轮`);
      console.log("[batch-refer] ═══════════════════════════════════════");

      let success = 0, failed = 0;

      for (let i = 0; i < count; i++) {
        console.log(`\n[batch-refer] ──── 第 ${i + 1}/${count} 轮 ────`);

        const referrer = pickReferrer();
        if (!referrer) {
          console.log("[batch-refer] ✗ 没有可用的推荐人");
          break;
        }
        console.log(`[batch-refer] 推荐人: ${referrer.email} (已推荐 ${referrer.referrals?.length || 0} 次)`);

        const vcc = getNextVcc();
        if (!vcc) {
          console.error("[batch-refer] ✗ VCC 用完");
          break;
        }

        try {
          const result = await referralFlow(referrer, vcc, { headful });
          if (result.success) {
            success++;
            console.log(`[batch-refer]   ✓ 成功: ${result.referrerEmail} → ${result.newEmail}`);
          } else {
            failed++;
            console.log(`[batch-refer]   ✗ 失败: ${result.error}`);
          }
        } catch (err) {
          failed++;
          console.error(`[batch-refer]   ✗ 错误: ${err.message}`);
        }

        if (i < count - 1) {
          const jitter = delay * 1000 + Math.random() * 10000;
          console.log(`[batch-refer] 等待 ${(jitter / 1000).toFixed(1)} 秒...`);
          await new Promise(r => setTimeout(r, jitter));
        }
      }

      console.log("\n[batch-refer] ═══════════════════════════════════════");
      console.log(`[batch-refer] 完成: ✓${success} ✗${failed}`);
      console.log("[batch-refer] ═══════════════════════════════════════");
      break;
    }

    case "vcc-probe": {
      // 探测 Buvei 后台页面结构（截图分析）
      console.log("[vcc-probe] ═══════════════════════════════════════");
      console.log("[vcc-probe] 探测 Buvei 后台页面结构");
      console.log("[vcc-probe] ═══════════════════════════════════════");

      if (!CONFIG.buveiPassword) {
        console.error("[vcc-probe] ✗ 需要配置 BUVEI_PASSWORD（.env 中设置）");
        process.exit(1);
      }

      await buveiProvisionCard({ probe: true });
      console.log("[vcc-probe] ✓ 截图已保存到 screenshots/buvei/");
      break;
    }

    case "vcc-create": {
      // 自动开一张 Buvei 虚拟卡
      const createQty = parseInt(getArg("quantity", String(CONFIG.buveiDefaultQuantity)));
      const createBal = parseFloat(getArg("balance", String(CONFIG.buveiDefaultBalance)));

      console.log("[vcc-create] ═══════════════════════════════════════");
      console.log(`[vcc-create] Buvei 自动开卡 (数量: ${createQty}, 余额: $${createBal})`);
      console.log("[vcc-create] ═══════════════════════════════════════");

      if (!CONFIG.buveiPassword) {
        console.error("[vcc-create] ✗ 需要配置 BUVEI_PASSWORD（.env 中设置）");
        process.exit(1);
      }

      const card = await buveiProvisionCard({ quantity: createQty, balance: createBal });
      if (card) {
        console.log("[vcc-create] ✓ 新卡:");
        console.log(`  卡号: ${card.number}`);
        console.log(`  过期: ${card.expiry}`);
        console.log(`  CVV:  ${card.cvc}`);
        console.log(`  邮编: ${card.zip}`);
      } else {
        console.log("[vcc-create] ✗ 开卡失败，请检查 screenshots/buvei/ 目录下的截图排查原因");
      }
      break;
    }

    case "batch-vcc": {
      // 批量开卡
      const vccCount = parseInt(getArg("count", "5"));
      const vccDelay = parseInt(getArg("delay", "10"));

      console.log("[batch-vcc] ═══════════════════════════════════════");
      console.log(`[batch-vcc] 批量开卡: ${vccCount} 张，间隔 ${vccDelay} 秒`);
      console.log("[batch-vcc] ═══════════════════════════════════════");

      if (!CONFIG.buveiPassword) {
        console.error("[batch-vcc] ✗ 需要配置 BUVEI_PASSWORD（.env 中设置）");
        process.exit(1);
      }

      await buveiBatchProvision(vccCount, { delay: vccDelay });
      break;
    }

    case "vcc-status": {
      // 显示 VCC 卡池状态
      console.log("[vcc-status] ═══════════════════════════════════════");
      console.log("[vcc-status] VCC 卡池状态");
      console.log("[vcc-status] ═══════════════════════════════════════");

      const pool = loadVccPool();
      const usage = loadVccUsage();
      const available = pool.cards.filter(c => c.status === "available");
      const used = pool.cards.filter(c => c.status === "used");
      const buveiCards = pool.cards.filter(c => c.source === "buvei");
      const nobeCards = pool.cards.filter(c => c.source === "nobe");

      console.log(`  总计: ${pool.cards.length} 张`);
      console.log(`  可用: ${available.length} 张`);
      console.log(`  已用: ${used.length} 张`);
      console.log(`  来源: Buvei ${buveiCards.length} / NOBE ${nobeCards.length} / 其他 ${pool.cards.length - buveiCards.length - nobeCards.length}`);
      console.log(`  绑定记录: ${usage.used ? usage.used.length : 0} 条`);

      if (pool.cards.length > 0) {
        console.log("\n  最近 10 张卡:");
        const recent = pool.cards.slice(-10);
        for (const c of recent) {
          const last4 = c.number ? c.number.slice(-4) : "????";
          const src = c.source || "manual";
          const st = c.status || "?";
          const exp = c.expiry || "??/??";
          console.log(`    **** ${last4} | ${exp} | ${src} | ${st} | ${c.createdAt || c.importedAt || "?"}`);
        }
      }

      // 也显示 .env 中配置的卡
      if (CONFIG.vccCards.length > 0) {
        console.log(`\n  .env 配置卡: ${CONFIG.vccCards.length} 张`);
        for (const c of CONFIG.vccCards) {
          console.log(`    **** ${c.number.slice(-4)} | ${c.expiry}`);
        }
      }

      console.log("[vcc-status] ═══════════════════════════════════════");
      break;
    }

    default: {
      console.log(`
Windsurf 试用号自动注册 + Pro Trial 激活系统

用法:
  === 注册 ===
  node windsurf-registrar.js register              # 注册单个试用号
  node windsurf-registrar.js register --headful     # 有头模式（看浏览器操作）
  node windsurf-registrar.js register --email x@y   # 指定邮箱
  node windsurf-registrar.js batch --count 5        # 批量注册 5 个
  node windsurf-registrar.js daemon                 # 守护进程模式

  === Pro Trial 激活（需配置 VCC） ===
  node windsurf-registrar.js activate-trial --email user@x.com   # 单个激活
  node windsurf-registrar.js batch-activate --count 10            # 批量激活
  node windsurf-registrar.js full-pipeline                        # 一键: 注册+激活

  === 邀请推荐（双方 +250 credits） ===
  node windsurf-registrar.js get-referral-code --email x@y        # 获取推荐码
  node windsurf-registrar.js refer                                 # 一键邀请（自动选推荐人+注册+绑卡）
  node windsurf-registrar.js refer --referrer x@y                  # 指定推荐人
  node windsurf-registrar.js refer --skip-register --new-email y@z # 用已有账号接受推荐
  node windsurf-registrar.js batch-refer --count 5                 # 批量邀请推荐

  === 订阅取消（到期前自动取消，避免扣费） ===
  node windsurf-registrar.js cancel-trial --email user@x.com     # 单个取消
  node windsurf-registrar.js auto-cancel --before-days 2          # 自动取消即将到期的

  === VCC 虚拟信用卡（Buvei 自动开卡） ===
  node windsurf-registrar.js vcc-probe                           # 探测 Buvei 后台结构（截图）
  node windsurf-registrar.js vcc-create                          # 自动开 1 张卡（$10）
  node windsurf-registrar.js vcc-create --quantity 3 --balance 10  # 开 3 张卡，每张 $10
  node windsurf-registrar.js batch-vcc --count 5                 # 批量开 5 张卡（每次 1 张×5 轮）
  node windsurf-registrar.js batch-vcc --count 10 --delay 15     # 批量开卡，间隔 15 秒
  node windsurf-registrar.js vcc-status                          # 查看 VCC 卡池状态

  === 其他 ===
  node windsurf-registrar.js status                 # 查看账号池状态
  node windsurf-registrar.js login --email x@y      # 登录获取 Token
  node windsurf-registrar.js buy-domain             # 购买新域名

VCC 配置（.env）:
  VCC_CARD_NUMBER=4242424242424242
  VCC_CARD_EXPIRY=12/30
  VCC_CARD_CVC=123
  VCC_CARD_ZIP=10001
  # 多张卡: VCC_CARDS='卡号,过期,CVC,邮编;卡号2,...'

Buvei 自动开卡（.env）:
  BUVEI_EMAIL=your@email.com
  BUVEI_PASSWORD=your_password
  BUVEI_DEFAULT_TOPUP=2       # 每张卡默认充值金额(USD)

Docker 沙盒:
  docker build -t ws-registrar -f scripts/Dockerfile.registrar .
  docker run --rm -e VCC_CARDS=... -e IMAP_USER=... ws-registrar full-pipeline

配置:
  注册端点: ${CONFIG.registerServer}
  账号池文件: ${CONFIG.accountsFile}
  Sessions 文件: ${CONFIG.sessionsFile}
      `);
    }
  }
}

main().catch((err) => {
  console.error("[registrar] 致命错误:", err);
  process.exit(1);
});
