
import { chromium } from "@playwright/test";
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();
for (let i = 0; i < 12; i += 1) {
  await page.goto("https://github.com/Le-Minh-Nhut/coding-agent-web/actions/workflows/ci.yml", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(10000);
  const rows = await page.locator("[aria-label]").evaluateAll((els) =>
    els.map((e) => e.getAttribute("aria-label"))
       .filter((l) => l && /Run \\d+ of CI/i.test(l))
       .slice(0, 3));
  console.log(i, JSON.stringify(rows));
  if (rows.some((r) => /separate the deployed revision/i.test(r))) {
    const line = rows.find((r) => /separate the deployed revision/i.test(r));
    if (/completed successfully|failed/.test(line)) { console.log("FINAL:", line); break; }
  }
  await page.waitForTimeout(20000);
}
await browser.close();
