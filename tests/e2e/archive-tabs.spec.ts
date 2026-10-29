import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

test("dated archive tabs report a missing role instead of silently staying on Signal", async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  await page.route(/https:\/\//, route => route.abort());
  const date = JSON.parse(readFileSync("public/daily/index.json", "utf8")).days[0].date;
  await page.route(`**/daily/${date}/repos.json`, route => route.fulfill({ status: 404, body: "Not found" }));
  await page.goto(`/daily/${date}/`, { waitUntil: "domcontentloaded" });

  await page.getByRole("tab", { name: /Repos/ }).click();

  await expect(page.getByRole("tab", { name: /Repos/ })).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(new RegExp(`/daily/${date}/\\?tab=repo$`));
  await expect(page.locator("#feed")).toContainText(/unavailable/i);

  await page.close();
});

test("dated archive tabs load same-day role snapshots when present", async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  await page.route(/https:\/\//, route => route.abort());
  const days = JSON.parse(readFileSync("public/daily/index.json", "utf8")).days;
  const date = days.find((day: { date: string }) => { try { return JSON.parse(readFileSync(`public/daily/${day.date}/repos.json`, "utf8")).count > 0; } catch { return false; } }).date;
  const count = JSON.parse(readFileSync(`public/daily/${date}/repos.json`, "utf8")).count;
  await page.goto(`/daily/${date}/`, { waitUntil: "domcontentloaded" });

  await page.getByRole("tab", { name: /Repos/ }).click();

  await expect(page.getByRole("tab", { name: /Repos/ })).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(new RegExp(`/daily/${date}/\\?tab=repo$`));
  await expect(page.locator("#statusText")).toContainText(`${count} ${count === 1 ? "item" : "items"}`);
  await expect(page.locator("#feed article.item")).toHaveCount(count);

  await page.close();
});
