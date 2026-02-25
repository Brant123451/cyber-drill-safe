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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");

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

// Catch-all 域名配置（Cloudflare Email Routing 转发到 IMAP_USER）
// 设置: CATCHALL_DOMAIN=chuangling.online
// 效果: 随机生成 xxxx@chuangling.online → 全部转发到 IMAP_USER (QQ邮箱)
const CATCHALL_DOMAIN = process.env.CATCHALL_DOMAIN || "";

function createImapAlias() {
  if (!CONFIG.imapUser) return null;
  const [local, domain] = CONFIG.imapUser.split("@");

  // 优先使用 catch-all 域名（无限邮箱）
  if (CATCHALL_DOMAIN) {
    const prefix = `ws${randomString(10).toLowerCase()}`;
    const alias = `${prefix}@${CATCHALL_DOMAIN}`;
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

async function waitForCodeViaIMAP(emailInfo, timeoutSecs = 120) {
  const { email } = emailInfo;
  console.log(`[gmail] 等待验证码... (IMAP, 最长 ${timeoutSecs}s)`);
  console.log(`[gmail] 目标邮箱: ${email}`);
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutSecs * 1000) {
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
      console.log(`[imap] 找到 ${uids.length} 封未读邮件 (目标: ${toAddr})`);

      if (uids.length > 0) {
        // 从最新的开始检查
        for (let mi = uids.length - 1; mi >= Math.max(0, uids.length - 3); mi--) {
          const uid = uids[mi];
          // 获取完整邮件（包含 headers + body）
          const fetchRes = await imap.fetch(uid, "BODY[]");

          // 打印调试信息
          const preview = fetchRes.substring(0, 1000).replace(/\r\n/g, "\n");
          console.log(`[imap] 邮件 UID=${uid} 预览:`);
          console.log(preview.substring(0, 500));

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
    }

    await new Promise(r => setTimeout(r, 5000));
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    if (elapsed % 15 === 0) {
      console.log(`[gmail] 等待中... (${elapsed}s)`);
    }
  }

  console.log("[gmail] ✗ 超时未收到验证码");
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

  const chromePaths = [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
  ];
  let chromePath = null;
  for (const p of chromePaths) {
    if (fs.existsSync(p)) { chromePath = p; break; }
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
    if (needsCaptcha && CONFIG.capsolverApiKey) {
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
        console.log("[codeium]   ✗ CapSolver 解题失败");
      }
    } else if (needsCaptcha) {
      console.log("[codeium]   ⚠ 需要 Turnstile 但未设置 CAPSOLVER_API_KEY");
    }

    // 等待页面跳转
    await new Promise(r => setTimeout(r, 3000));

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
          const code = await waitForVerificationCode(emailInfo, 120);
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
            console.log("[codeium]   ✗ 未获取到验证码");
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
      try {
        console.log("[codeium]   → 调用 RegisterUser RPC...");
        const regReq = encodeRegisterUserRequest(capturedToken);
        const regRes = await callConnectRpc(CONFIG.registerServer, CONFIG.rpcRegisterUser, regReq);
        if (regRes.status === 200) {
          const frames = parseConnectFrames(regRes.body);
          if (frames.length > 0) {
            const fields = extractStringsFromProtobuf(frames[0].data);
            result.apiKey = fields.find(f => f.field === 1)?.value;
            result.apiServerUrl = fields.find(f => f.field === 3)?.value;
            console.log(`[codeium]   ✓ API Key: ${result.apiKey?.substring(0, 20)}...`);
          }
        }
      } catch (err) {
        console.log(`[codeium]   ✗ RegisterUser error: ${err.message}`);
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
    const createRes = await new Promise((resolve, reject) => {
      const req = https.request(
        `${CONFIG.capsolverEndpoint}/createTask`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(createBody) },
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
      req.write(createBody);
      req.end();
    });

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

      const pollRes = await new Promise((resolve, reject) => {
        const req = https.request(
          `${CONFIG.capsolverEndpoint}/getTaskResult`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(pollBody) },
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
        req.write(pollBody);
        req.end();
      });

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
// 账号池管理
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

function addAccount(account) {
  const data = loadAccounts();
  // 去重
  const existing = data.accounts.findIndex((a) => a.email === account.email);
  if (existing >= 0) {
    data.accounts[existing] = account;
  } else {
    data.accounts.push(account);
  }
  saveAccounts(data);
  return data;
}

/**
 * 将注册的账号同步到 sessions.json（供 lab-server 使用）
 */
function syncToSessions(account) {
  if (!account.apiKey && !account.firebaseIdToken) return;

  const sessionsFile = CONFIG.sessionsFile;
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
}

// ============================================================
// 方案 D：登录已注册账号，捕获 Token + API Key
// ============================================================

async function loginViaCodeium(email, password, options = {}) {
  const { headless = true } = options;
  const { connect } = await import("puppeteer-real-browser");

  // 查找 Chrome
  const chromePaths = [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
  ];
  let chromePath = null;
  for (const p of chromePaths) {
    if (fs.existsSync(p)) { chromePath = p; break; }
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

      addAccount(result);
      if (result.status === "registered" || result.status === "registered_no_token") {
        syncToSessions(result);
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
      const delay = parseInt(getArg("delay", "15")); // 每个账号间隔秒数
      const headful = getFlag("headful");

      console.log("[registrar] ═══════════════════════════════════════");
      console.log(`[registrar] 批量注册: ${count} 个账号`);
      console.log(`[registrar] 间隔: ${delay} 秒`);
      console.log("[registrar] ═══════════════════════════════════════");

      const results = { success: [], failed: [] };

      for (let i = 0; i < count; i++) {
        console.log(`\n[registrar] ──── ${i + 1}/${count} ────`);
        const identity = await generateIdentity(true);

        try {
          const result = await registerViaPuppeteer(identity, {
            headless: !headful,
          });
          addAccount(result);
          if (result.status === "registered") {
            syncToSessions(result);
            results.success.push(result.email);
          } else {
            results.failed.push({ email: result.email, reason: result.status });
          }
        } catch (err) {
          console.error(`[registrar] ✗ 失败: ${err.message}`);
          results.failed.push({ email: identity.email, reason: err.message });
        }

        if (i < count - 1) {
          const jitter = delay * 1000 + Math.random() * 5000;
          console.log(`[registrar] 等待 ${(jitter / 1000).toFixed(1)} 秒...`);
          await new Promise((r) => setTimeout(r, jitter));
        }
      }

      console.log();
      console.log("[registrar] ═══════════════════════════════════════");
      console.log(`[registrar] 完成: ${results.success.length} 成功, ${results.failed.length} 失败`);
      if (results.failed.length > 0) {
        console.log("[registrar] 失败列表:");
        for (const f of results.failed) {
          console.log(`  - ${f.email}: ${f.reason}`);
        }
      }
      console.log("[registrar] ═══════════════════════════════════════");
      break;
    }

    case "status": {
      const data = loadAccounts();
      const total = data.accounts.length;
      const registered = data.accounts.filter((a) => a.status === "registered").length;
      const active = data.accounts.filter(
        (a) => a.status === "registered" && new Date(a.expiresAt) > new Date(),
      ).length;
      const expired = data.accounts.filter(
        (a) => new Date(a.expiresAt) <= new Date(),
      ).length;

      console.log("[registrar] ═══════════════════════════════════════");
      console.log("[registrar] 账号池状态");
      console.log("[registrar] ═══════════════════════════════════════");
      console.log(`  总计:   ${total}`);
      console.log(`  已注册: ${registered}`);
      console.log(`  有效:   ${active}`);
      console.log(`  过期:   ${expired}`);

      if (data.accounts.length > 0) {
        console.log();
        console.log("  最近账号:");
        for (const a of data.accounts.slice(-5)) {
          const expires = new Date(a.expiresAt);
          const isExpired = expires <= new Date();
          const daysLeft = Math.ceil((expires - new Date()) / 86400000);
          console.log(
            `    ${a.email} | ${a.status} | ${isExpired ? "已过期" : `${daysLeft}天后到期`}`,
          );
        }
      }

      console.log("[registrar] ═══════════════════════════════════════");
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
        syncToSessions(result);

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
            syncToSessions({ ...acc, ...result });
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

    default: {
      console.log(`
Windsurf 试用号自动注册系统

用法:
  node scripts/windsurf-registrar.js register              # 注册单个试用号
  node scripts/windsurf-registrar.js register --headful     # 有头模式（看浏览器操作）
  node scripts/windsurf-registrar.js register --email x@y   # 指定邮箱
  node scripts/windsurf-registrar.js batch --count 5        # 批量注册 5 个
  node scripts/windsurf-registrar.js batch --count 10 --delay 30  # 每个间隔30秒
  node scripts/windsurf-registrar.js status                 # 查看账号池状态
  node scripts/windsurf-registrar.js api-register --turnstile-token xxx  # 纯API注册

配置:
  注册端点: ${CONFIG.registerServer}
  OAuth Client ID: ${CONFIG.clientId}
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
