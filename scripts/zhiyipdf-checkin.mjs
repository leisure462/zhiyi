const checkinUrl = "https://www.zhiyipdf.com/api/points/checkin";

const rawCookies = process.env.ZHIYI_COOKIES || "";
const cookieList = rawCookies
  .split(/\r?\n/)
  .map((item) => item.trim())
  .filter(Boolean);
const fallbackCookie = (process.env.ZHIYI_COOKIE || "").trim();

if (cookieList.length === 0 && !fallbackCookie) {
  console.error("Missing ZHIYI_COOKIES or ZHIYI_COOKIE");
  process.exit(1);
}

const cookies = cookieList.length > 0 ? cookieList : [fallbackCookie];
const webhook = (process.env.FEISHU_WEBHOOK || "").trim();

const sendFeishu = async (text) => {
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
};

const results = [];
let hasFailure = false;

for (let index = 0; index < cookies.length; index += 1) {
  const cookie = cookies[index];
  const headers = {
    accept: "*/*",
    "content-type": "application/json",
    origin: "https://www.zhiyipdf.com",
    referer: "https://www.zhiyipdf.com/dashboard",
    cookie,
  };

  const response = await fetch(checkinUrl, {
    method: "POST",
    headers,
  });

  const payload = await response.json().catch(() => ({}));
  const message = typeof payload.message === "string" ? payload.message : "";
  const alreadyChecked = /already|checked|duplicate|已|重复/i.test(message);
  const okStatus = response.ok || response.status === 409 || alreadyChecked;
  const ok = okStatus && (payload.success !== false || alreadyChecked);

  results.push({ index: index + 1, ok, status: response.status, payload });
  if (!ok) hasFailure = true;
}

for (const result of results) {
  console.log(`account_${result.index}:`, result.payload);
}

await sendFeishu(hasFailure ? "签到失败" : "签到成功");

if (hasFailure) {
  const failed = results.filter((item) => !item.ok);
  throw new Error(`Check-in failed: ${JSON.stringify(failed)}`);
}
