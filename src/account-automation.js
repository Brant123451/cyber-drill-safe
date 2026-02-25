/**
 * Account Automation - Puppeteer 自动登录 + Session 提取
 *
 * 用法：
 *   node src/account-automation.js login --email user@example.com --password xxx --platform codeium
 *   node src/account-automation.js extract --platform codeium
 *   node src/account-automation.js batch --file accounts-input.json
 *
 * 工作流：
 *   1. 启动无头浏览器
 *   2. 导航到目标平台登录页
 *   3. 自动填写凭据并登录
 *   4. 等待登录成功，提取 session token / cookies
 *   5. 写入 config/sessions.json
 *
 * ⚠️ 标记 [REVERSE-REQUIRED] 的地方需要根据目标平台实际页面结构填充选择器
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");

// ============================================================
// 平台登录配置
// ============================================================

const PLATFORM_CONFIGS = {
  codeium: {
    name: "Codeium / Windsurf",
    loginUrl: "https://codeium.com/account/login",
    // [REVERSE-REQUIRED] 以下选择器需要根据实际页面 DOM 填写
    selectors: {
      emailInput: 'input[type="email"], input[name="email"], #email',
      passwordInput: 'input[type="password"], input[name="password"], #password',
      submitButton: 'button[type="submit"], button:has-text("Sign in"), button:has-text("Log in")',
      loginSuccessIndicator: '[data-testid="dashboard"], .dashboard, .account-settings',
    },
    // [REVERSE-REQUIRED] 从哪里提取 session token
    tokenExtraction: {
      method: "localStorage", // "localStorage" | "cookie" | "networkIntercept"
      // localStorage key（如果 method=localStorage）
      localStorageKey: "auth_token",
      // cookie name（如果 method=cookie）
      cookieName: "session",
      // 网络请求 URL 模式（如果 method=networkIntercept）
      networkPattern: "**/api/v1/auth/**",
    },
    // [REVERSE-REQUIRED] 刷新 token 的方式
    refreshUrl: null,
    // 登录后等待时间（ms）
    postLoginWaitMs: 3000,
  },

  cursor: {
    name: "Cursor",
    loginUrl: "https://authenticator.cursor.sh/",
    selectors: {
      emailInput: 'input[type="email"]',
      passwordInput: 'input[type="password"]',
      submitButton: 'button[type="submit"]',
      loginSuccessIndicator: ".dashboard",
    },
    tokenExtraction: {
      method: "cookie",
      cookieName: "WorkosCursorSessionToken",
    },
    postLoginWaitMs: 3000,
  },
};

// ============================================================
// 核心自动化函数
// ============================================================

/**
 * 自动登录并提取 session
 * @param {Object} opts
 * @param {string} opts.platform - 平台名
 * @param {string} opts.email
 * @param {string} opts.password
 * @param {boolean} [opts.headless=true]
 * @param {string} [opts.proxyServer] - 代理服务器（如需代理）
 * @returns {Promise<Object>} 提取的 session 数据
 */
async function loginAndExtract(opts) {
  const config = PLATFORM_CONFIGS[opts.platform];
  if (!config) {
    throw new Error(`unknown platform: ${opts.platform}. available: ${Object.keys(PLATFORM_CONFIGS).join(", ")}`);
  }

  // 动态导入 puppeteer
  let puppeteer;
  try {
    puppeteer = await import("puppeteer");
  } catch {
    console.error("[automation] puppeteer not installed. run: npm install puppeteer");
    console.error("[automation] or: npx puppeteer browsers install chrome");
    process.exit(1);
  }

  console.log(`[automation] logging into ${config.name} as ${opts.email}...`);

  const launchOpts = {
    headless: opts.headless !== false ? "new" : false,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
    ],
  };

  if (opts.proxyServer) {
    launchOpts.args.push(`--proxy-server=${opts.proxyServer}`);
  }

  const browser = await puppeteer.default.launch(launchOpts);

  try {
    const page = await browser.newPage();

    // 反检测
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      Object.defineProperty(navigator, "plugins", {
        get: () => [1, 2, 3, 4, 5],
      });
    });

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    );

    // 设置网络拦截（用于 networkIntercept 方式）
    let interceptedToken = null;
    if (config.tokenExtraction.method === "networkIntercept") {
      await page.setRequestInterception(true);
      page.on("response", async (response) => {
        const url = response.url();
        if (url.includes(config.tokenExtraction.networkPattern.replace("**", ""))) {
          try {
            const body = await response.json();
            interceptedToken = body?.token || body?.access_token || body?.session_token;
          } catch {}
        }
      });
    }

    // 导航到登录页
    console.log(`[automation] navigating to ${config.loginUrl}`);
    await page.goto(config.loginUrl, { waitUntil: "networkidle2", timeout: 30000 });

    // 填写邮箱
    await page.waitForSelector(config.selectors.emailInput, { timeout: 10000 });
    await page.type(config.selectors.emailInput, opts.email, { delay: 50 });

    // 填写密码
    await page.waitForSelector(config.selectors.passwordInput, { timeout: 10000 });
    await page.type(config.selectors.passwordInput, opts.password, { delay: 50 });

    // 点击登录
    await page.click(config.selectors.submitButton);

    // 等待登录成功
    console.log("[automation] waiting for login to complete...");
    await page.waitForSelector(config.selectors.loginSuccessIndicator, { timeout: 30000 })
      .catch(() => {
        console.log("[automation] login success indicator not found, waiting extra time...");
      });

    await new Promise((r) => setTimeout(r, config.postLoginWaitMs));

    // 提取 session token
    let sessionToken = null;
    let refreshToken = null;
    let cookies = [];

    switch (config.tokenExtraction.method) {
      case "localStorage": {
        sessionToken = await page.evaluate((key) => {
          return localStorage.getItem(key);
        }, config.tokenExtraction.localStorageKey);
        break;
      }

      case "cookie": {
        cookies = await page.cookies();
        const targetCookie = cookies.find((c) => c.name === config.tokenExtraction.cookieName);
        sessionToken = targetCookie?.value || null;
        break;
      }

      case "networkIntercept": {
        sessionToken = interceptedToken;
        break;
      }
    }

    // 尝试从所有 cookies 中找 session 相关的
    if (!sessionToken) {
      cookies = await page.cookies();
      const sessionCookies = cookies.filter(
        (c) => c.name.toLowerCase().includes("session") || c.name.toLowerCase().includes("token"),
      );
      if (sessionCookies.length > 0) {
        sessionToken = sessionCookies.map((c) => `${c.name}=${c.value}`).join("; ");
        console.log(`[automation] extracted session from cookies: ${sessionCookies.map((c) => c.name).join(", ")}`);
      }
    }

    if (!sessionToken) {
      // 最后手段：导出所有 localStorage
      const allStorage = await page.evaluate(() => {
        const items = {};
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          items[key] = localStorage.getItem(key);
        }
        return items;
      });
      console.log("[automation] localStorage dump:", JSON.stringify(allStorage, null, 2));
      throw new Error("could not extract session token. check localStorage dump above.");
    }

    console.log(`[automation] session extracted: ${sessionToken.slice(0, 20)}...`);

    // 获取设备信息
    const userAgent = await page.evaluate(() => navigator.userAgent);

    const sessionData = {
      id: `${opts.platform}-${opts.email.split("@")[0]}`,
      platform: opts.platform,
      email: opts.email,
      sessionToken,
      refreshToken,
      deviceId: crypto.randomUUID(),
      userAgent,
      enabled: true,
      loginMethod: "email",
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
      extra: {
        cookies: cookies.length > 0 ? cookies : undefined,
      },
    };

    return sessionData;
  } finally {
    await browser.close();
  }
}

/**
 * 将提取的 session 写入 sessions.json
 */
function saveSession(sessionData) {
  const sessionsFile = path.join(PROJECT_ROOT, "config", "sessions.json");

  let existing = { sessions: [] };
  if (fs.existsSync(sessionsFile)) {
    existing = JSON.parse(fs.readFileSync(sessionsFile, "utf8").replace(/^\uFEFF/, ""));
    if (Array.isArray(existing)) existing = { sessions: existing };
  }

  // 去重更新
  const idx = existing.sessions.findIndex((s) => s.id === sessionData.id);
  if (idx >= 0) {
    existing.sessions[idx] = sessionData;
  } else {
    existing.sessions.push(sessionData);
  }

  fs.mkdirSync(path.dirname(sessionsFile), { recursive: true });
  fs.writeFileSync(sessionsFile, JSON.stringify(existing, null, 2), "utf8");
  console.log(`[automation] session saved to ${sessionsFile}`);
}

/**
 * 批量登录
 */
async function batchLogin(inputFile) {
  const raw = fs.readFileSync(inputFile, "utf8").replace(/^\uFEFF/, "");
  const accounts = JSON.parse(raw);
  const list = Array.isArray(accounts) ? accounts : accounts.accounts || [];

  console.log(`[automation] batch login: ${list.length} accounts`);

  const results = { success: [], failed: [] };

  for (const account of list) {
    try {
      console.log(`\n[automation] processing: ${account.email} (${account.platform})`);
      const session = await loginAndExtract({
        platform: account.platform,
        email: account.email,
        password: account.password,
        headless: account.headless,
        proxyServer: account.proxyServer,
      });
      saveSession(session);
      results.success.push(account.email);
    } catch (err) {
      console.error(`[automation] FAILED: ${account.email}: ${err.message}`);
      results.failed.push({ email: account.email, error: err.message });
    }

    // 随机延迟 2-5 秒，避免被检测
    const delay = 2000 + Math.random() * 3000;
    await new Promise((r) => setTimeout(r, delay));
  }

  console.log(`\n[automation] batch complete: ${results.success.length} success, ${results.failed.length} failed`);
  return results;
}

// ============================================================
// CLI 入口
// ============================================================

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  function getArg(name) {
    const idx = args.indexOf(`--${name}`);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
  }

  switch (command) {
    case "login": {
      const platform = getArg("platform") || "codeium";
      const email = getArg("email");
      const password = getArg("password");
      const headless = getArg("headless") !== "false";

      if (!email || !password) {
        console.error("usage: node src/account-automation.js login --email xxx --password xxx [--platform codeium] [--headless false]");
        process.exit(1);
      }

      const session = await loginAndExtract({ platform, email, password, headless });
      saveSession(session);
      break;
    }

    case "batch": {
      const file = getArg("file") || path.join(PROJECT_ROOT, "config", "accounts-input.json");
      await batchLogin(file);
      break;
    }

    case "platforms": {
      console.log("available platforms:");
      for (const [key, config] of Object.entries(PLATFORM_CONFIGS)) {
        console.log(`  ${key}: ${config.name} (${config.loginUrl})`);
      }
      break;
    }

    default: {
      console.log(`
Account Automation - Puppeteer Login & Session Extraction

Usage:
  node src/account-automation.js login --email user@example.com --password xxx [--platform codeium]
  node src/account-automation.js batch --file config/accounts-input.json
  node src/account-automation.js platforms

Commands:
  login      - Login to a single account and extract session
  batch      - Batch login from a JSON file
  platforms  - List available platforms
      `);
    }
  }
}

// 仅当直接运行时执行 CLI
const isMain = process.argv[1] && (
  process.argv[1].endsWith("account-automation.js") ||
  process.argv[1].includes("account-automation")
);

if (isMain) {
  main().catch((err) => {
    console.error("[automation] fatal:", err.message);
    process.exit(1);
  });
}

export { loginAndExtract, saveSession, batchLogin, PLATFORM_CONFIGS };
