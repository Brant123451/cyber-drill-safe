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
  apiServer: "https://server.codeium.com",

  // RPC 路径
  rpcCreateFbUser:
    "/exa.seat_management_pb.SeatManagementService/CreateFbUser",
  rpcRegisterUser:
    "/exa.seat_management_pb.SeatManagementService/RegisterUser",

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

function generateIdentity() {
  const firstName = randomElement(FIRST_NAMES);
  const lastName = randomElement(LAST_NAMES);
  const emailPrefix = randomString(16 + Math.floor(Math.random() * 6)); // 16-21 chars
  const emailDomain = randomElement(EMAIL_DOMAINS);
  const email = `${emailPrefix}@${emailDomain}`;
  const password = CONFIG.defaultPassword;

  return { firstName, lastName, email, password };
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
        "Content-Type": "application/connect+proto",
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
  const { email, password, firstName, lastName } = identity;

  // 动态导入
  let puppeteer, StealthPlugin;
  try {
    const pMod = await import("puppeteer-extra");
    puppeteer = pMod.default;
    const sMod = await import("puppeteer-extra-plugin-stealth");
    StealthPlugin = sMod.default;
    puppeteer.use(StealthPlugin());
  } catch {
    try {
      const pMod = await import("puppeteer");
      puppeteer = pMod.default;
      console.log("[registrar] ⚠ puppeteer-extra-plugin-stealth 未安装，使用原生 puppeteer");
    } catch {
      console.error("[registrar] ✗ 请先安装: npm install puppeteer puppeteer-extra puppeteer-extra-plugin-stealth");
      process.exit(1);
    }
  }

  console.log(`[registrar] Puppeteer 注册: ${email}`);
  console.log(`[registrar]   名字: ${firstName} ${lastName}`);
  console.log(`[registrar]   模式: ${headless ? "无头" : "有头"}`);

  const browser = await puppeteer.launch({
    headless: headless ? "new" : false,
    slowMo,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-web-security",
      "--window-size=1280,800",
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // 反检测
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      // 覆盖 permissions API
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) =>
        parameters.name === "notifications"
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(parameters);
    });

    // 监听所有网络请求，捕获 token
    let capturedToken = null;
    let capturedApiKey = null;

    await page.setRequestInterception(true);
    page.on("request", (req) => {
      req.continue();
    });
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

        // 判断通过的方法：检查 Turnstile iframe 消失 或 页面导航 或 出现新的表单内容
        const checkTurnstileSolved = async () => {
          return page.evaluate(() => {
            const bodyText = (document.body?.innerText || "").toLowerCase();
            // 如果页面不再包含 "verify" + "human"，说明已通过
            const hasCaptchaText = bodyText.includes("verify") && bodyText.includes("human");
            if (!hasCaptchaText) return "page_changed";
            // 检查 Turnstile 隐藏 input 是否有值
            const input = document.querySelector('[name*="turnstile"], [name*="cf-"]');
            if (input?.value?.length > 20) return "token_set";
            return null;
          });
        };

        // 先等10秒看是否自动通过
        let turnstilePassed = false;
        for (let i = 0; i < 10; i++) {
          await new Promise(r => setTimeout(r, 1000));
          const result = await checkTurnstileSolved();
          if (result) {
            console.log(`[registrar]   ✓ Turnstile 自动通过: ${result} (${i + 1}s)`);
            turnstilePassed = true;
            if (result === "token_set") await clickSubmitButton(page);
            break;
          }
        }

        if (!turnstilePassed && !headless) {
          // 有头模式：等待用户手动点击 Turnstile
          console.log("[registrar]   ⚠ Turnstile 需要手动验证");
          console.log("[registrar]   → 请在浏览器中点击 Turnstile 复选框，然后点 Continue...");

          for (let i = 0; i < 180; i++) {
            await new Promise(r => setTimeout(r, 1000));
            const result = await checkTurnstileSolved();
            if (result) {
              console.log(`[registrar]   ✓ Turnstile 已通过: ${result} (${i + 1}s)`);
              turnstilePassed = true;
              if (result === "token_set") await clickSubmitButton(page);
              break;
            }
            if (i % 30 === 29) {
              console.log(`[registrar]   等待中... (${i + 1}s)`);
            }
          }
        } else if (!turnstilePassed) {
          console.log("[registrar]   ✗ 无头模式无法手动通过 Turnstile");
          console.log("[registrar]   提示: 使用 --headful 手动点击 | 或集成 CapSolver 自动解决");
        }

        if (turnstilePassed) {
          await new Promise(r => setTimeout(r, 5000));
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

    // 检查是否需要邮箱验证
    const currentUrl = page.url();
    const pageText = await page.evaluate(() => document.body?.innerText || "");
    const needsVerification = pageText.toLowerCase().includes("verify") ||
      pageText.toLowerCase().includes("confirmation") ||
      pageText.toLowerCase().includes("check your email") ||
      pageText.includes("验证");

    if (needsVerification) {
      console.log("[registrar]   ⚠ 需要邮箱验证");
      console.log("[registrar]   当前页面内容:", pageText.substring(0, 200));
      // TODO: 自动从邮箱获取验证链接
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
      const identity = {
        email: getArg("email", null),
        password: getArg("password", CONFIG.defaultPassword),
        firstName: getArg("first-name", null),
        lastName: getArg("last-name", null),
      };

      // 如果没有提供邮箱，自动生成
      if (!identity.email) {
        const generated = generateIdentity();
        identity.email = generated.email;
        identity.firstName = identity.firstName || generated.firstName;
        identity.lastName = identity.lastName || generated.lastName;
      } else {
        identity.firstName = identity.firstName || randomElement(FIRST_NAMES);
        identity.lastName = identity.lastName || randomElement(LAST_NAMES);
      }

      console.log("[registrar] ═══════════════════════════════════════");
      console.log("[registrar] Windsurf 试用号注册");
      console.log("[registrar] ═══════════════════════════════════════");
      console.log(`[registrar] 邮箱: ${identity.email}`);
      console.log(`[registrar] 名字: ${identity.firstName} ${identity.lastName}`);
      console.log(`[registrar] 密码: ${identity.password}`);
      console.log();

      const result = await registerViaPuppeteer(identity, {
        headless: !getFlag("headful"),
        slowMo: parseInt(getArg("slow-mo", "50")),
      });

      addAccount(result);
      if (result.status === "registered") {
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
        const identity = generateIdentity();

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

    case "api-register": {
      // 纯 API 模式（需要手动提供 Turnstile token）
      const identity = generateIdentity();
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
