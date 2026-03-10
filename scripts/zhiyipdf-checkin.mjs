import { chromium } from "playwright";

const loginUrl = "https://www.zhiyipdf.com/login";
const dashboardUrl = "https://www.zhiyipdf.com/dashboard";
const checkinUrl = "https://www.zhiyipdf.com/api/points/checkin";
const webhook = (process.env.FEISHU_WEBHOOK || "").trim();

class NotifiedError extends Error {}

function parseAccounts() {
  const raw = (process.env.ZHIYI_ACCOUNTS_JSON || "").trim();

  if (!raw) {
    throw new Error("Missing ZHIYI_ACCOUNTS_JSON");
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid ZHIYI_ACCOUNTS_JSON: ${error.message}`);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("ZHIYI_ACCOUNTS_JSON must be a non-empty array");
  }

  return parsed.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Account #${index + 1} must be an object`);
    }

    const name = String(item.name || `account_${index + 1}`).trim();
    const username = String(item.username || "").trim();
    const password = String(item.password || "").trim();

    if (!username || !password) {
      throw new Error(`Account "${name}" is missing username or password`);
    }

    return { name, username, password };
  });
}

async function sendFeishu(text) {
  if (!webhook) return;

  const response = await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      msg_type: "text",
      content: { text },
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    console.warn(`Feishu webhook failed: ${response.status} ${body}`);
  }
}

function sanitizeText(value, fallback = "") {
  if (typeof value !== "string") return fallback;
  return value
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\s+/g, " ")
    .trim() || fallback;
}

function isAlreadyChecked(message) {
  return /already|checked|duplicate|已|重复/i.test(message);
}

function formatSummary(results, title) {
  const lines = [
    title,
    `时间: ${new Date().toISOString()}`,
    `成功: ${results.filter((item) => item.ok).length}/${results.length}`,
  ];

  for (const result of results) {
    if (result.ok) {
      lines.push(`- ${result.name}: 成功 (${result.message})`);
      continue;
    }

    lines.push(`- ${result.name}: 失败 (${result.message})`);
  }

  return lines.join("\n");
}

async function findVisibleLocator(page, candidates, description, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const candidate of candidates) {
      const locator = candidate.first();
      const visible = await locator.isVisible().catch(() => false);
      if (visible) {
        return locator;
      }
    }

    await page.waitForTimeout(250);
  }

  throw new Error(`Timed out waiting for ${description}`);
}

async function readLoginError(page) {
  const errorLocator = page.locator(
    [
      ".ant-form-item-explain-error",
      ".ant-message-notice-content",
      ".ant-alert-content",
      ".ant-notification-notice-message",
      ".ant-notification-notice-description",
    ].join(", "),
  );

  const texts = await errorLocator.allInnerTexts().catch(() => []);
  return texts.map((item) => sanitizeText(item)).filter(Boolean).join(" | ");
}

async function waitForDashboard(page, accountName, timeoutMs = 30000) {
  const dashboardMarkers = [
    page.getByRole("link", { name: /个人中心|profile/i }),
    page.getByRole("button", { name: /今日已签到|签到|check/i }),
    page.locator("text=个人中心"),
    page.locator("text=今日已签到"),
  ];

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (page.url().startsWith(dashboardUrl)) {
      return;
    }

    for (const marker of dashboardMarkers) {
      const visible = await marker.first().isVisible().catch(() => false);
      if (visible) {
        return;
      }
    }

    const loginError = await readLoginError(page);
    if (loginError) {
      throw new Error(`Login rejected for ${accountName}: ${loginError}`);
    }

    await page.waitForTimeout(500);
  }

  throw new Error(`Dashboard not detected for ${accountName}; current URL: ${page.url()}`);
}

async function requestCheckin(page) {
  return page.evaluate(async (url) => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        accept: "*/*",
        "content-type": "application/json",
      },
    });

    const text = await response.text();
    let payload = {};

    try {
      payload = JSON.parse(text);
    } catch {
      payload = {};
    }

    return {
      status: response.status,
      ok: response.ok,
      text,
      payload,
    };
  }, checkinUrl);
}

async function checkinAccount(browser, account) {
  const context = await browser.newContext({
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
  });

  const page = await context.newPage();

  try {
    await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});

    const passwordTab = page.getByRole("tab", { name: /^密码$/ });
    if (await passwordTab.first().isVisible().catch(() => false)) {
      await passwordTab.first().click();
    }

    const usernameInput = await findVisibleLocator(
      page,
      [
        page.getByPlaceholder(/用户名|email|手机号/i),
        page.getByRole("textbox", { name: /用户名|email|手机号|username|phone/i }),
        page.locator("input[type='text']"),
      ],
      `username input for ${account.name}`,
    );

    const passwordInput = await findVisibleLocator(
      page,
      [
        page.getByPlaceholder(/密码|password/i),
        page.locator("input[type='password']"),
      ],
      `password input for ${account.name}`,
    );

    const submitButton = await findVisibleLocator(
      page,
      [
        page.getByRole("button", { name: /登\s*录|log in|sign in/i }),
        page.locator("button[type='submit']"),
      ],
      `login button for ${account.name}`,
    );

    await usernameInput.fill(account.username);
    await passwordInput.fill(account.password);
    await submitButton.click();

    await waitForDashboard(page, account.name);

    if (!page.url().startsWith("https://www.zhiyipdf.com/")) {
      await page.goto(dashboardUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    }

    const result = await requestCheckin(page);
    const payloadMessage = sanitizeText(result.payload?.message, "");
    const fallbackMessage = sanitizeText(result.text, "");
    const message = payloadMessage || fallbackMessage || `HTTP ${result.status}`;
    const alreadyChecked = isAlreadyChecked(message);
    const okStatus = result.ok || result.status === 409 || alreadyChecked;
    const ok = okStatus && (result.payload?.success !== false || alreadyChecked);

    return {
      name: account.name,
      ok,
      status: result.status,
      message,
      payload: result.payload,
    };
  } finally {
    await context.close();
  }
}

async function main() {
  const accounts = parseAccounts();
  const browser = await chromium.launch({ headless: true });
  const results = [];

  try {
    for (const account of accounts) {
      try {
        const result = await checkinAccount(browser, account);
        results.push(result);
        console.log(`${result.name}:`, {
          ok: result.ok,
          status: result.status,
          message: result.message,
        });
      } catch (error) {
        const message = sanitizeText(error?.message, "Unknown error");
        const failure = {
          name: account.name,
          ok: false,
          status: 0,
          message,
          payload: {},
        };

        results.push(failure);
        console.error(`${account.name}:`, failure);
      }
    }
  } finally {
    await browser.close();
  }

  const hasFailure = results.some((item) => !item.ok);
  const text = formatSummary(
    results,
    hasFailure ? "ZhiyiPDF 签到失败" : "ZhiyiPDF 签到成功",
  );

  await sendFeishu(text);

  if (hasFailure) {
    throw new NotifiedError(text);
  }
}

try {
  await main();
} catch (error) {
  if (!(error instanceof NotifiedError)) {
    const message = sanitizeText(error?.message, "Unknown fatal error");
    await sendFeishu(`ZhiyiPDF 签到失败\n时间: ${new Date().toISOString()}\n原因: ${message}`);
  }

  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
