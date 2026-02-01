const checkinUrl = "https://www.zhiyipdf.com/api/points/checkin";

const cookie = process.env.ZHIYI_COOKIE;
if (!cookie) {
  console.error("Missing ZHIYI_COOKIE");
  process.exit(1);
}

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

if (!response.ok || (payload.success === false && !alreadyChecked)) {
  throw new Error(`Check-in failed: ${response.status} ${JSON.stringify(payload)}`);
}

console.log("checkin:", payload);
