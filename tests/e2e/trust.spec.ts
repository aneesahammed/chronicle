import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ context }) => {
  await context.route(/https:\/\/(?!127\.0\.0\.1)/, route => route.abort());
});

test("mobile defaults to one card reader including Top News, with a persistent header view icon", async ({ page }) => {
  const feeds: string[] = [];
  page.on("request", request => { if (/\/(feed|repos|learning)\.json/.test(request.url())) feeds.push(request.url()); });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#mobileReader")).toBeVisible();
  await expect(page.locator("#topNews")).toBeHidden();
  await expect(page.locator("#feed article.item").first()).toBeHidden();
  const expected = await page.locator("#feedBootstrap").evaluate(node => JSON.parse(node.textContent || "{}"));
  await expect(page.locator(".reader-card.is-current .reader-title")).toHaveText(expected.top_news[0].title);
  await expect(page.locator(".reader-card.is-current .reader-featured")).toHaveText("Top story");
  const mode = page.locator(".masthead-actions #readerMode");
  await expect(mode).toHaveAttribute("aria-label", "Switch to compact list");
  await expect(mode).toHaveText("");
  const bounds = await mode.boundingBox();
  expect(bounds?.width).toBeGreaterThanOrEqual(44);
  expect(bounds?.height).toBeGreaterThanOrEqual(44);
  await page.getByRole("button", { name: "Index", exact: true }).click();
  const titles = await page.locator(".reader-index-row .reader-index-title").allTextContents();
  const rows = await page.locator(".reader-index-row").count();
  expect(rows).toBe(new Set([...expected.clusters.map((c: any) => c.primary.url), ...expected.top_news.map((n: any) => n.url)]).size);
  expect(new Set(titles).size).toBe(titles.length);
  await page.keyboard.press("Escape");
  expect(feeds).toEqual([]);
  await mode.click();
  await expect(page.locator("#feed article.item").first()).toBeVisible();
  await expect(page.locator("#topNews")).toBeVisible();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#readerMode")).toHaveAttribute("aria-label", "Switch to card reader");
  await expect(page.locator("#mobileReader")).toHaveCount(0);
  await page.locator("#readerMode").click();
  await expect(page.locator("#mobileReader")).toBeVisible();
  await expect(page.locator("#topNews")).toBeHidden();
});

test("held content displays its successful age and failure notice", async ({ page }) => {
  const feed = JSON.parse(readFileSync("public/feed.json", "utf8"));
  feed.generated_at = new Date().toISOString();
  feed.last_successful_generated_at = new Date(Date.now() - 72 * 3.6e6).toISOString();
  feed.refresh_status = "failed";
  await page.route("**/feed.json", route => route.fulfill({ json: feed }));
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Check for updates" }).click();
  await expect(page.locator("#statusText")).toContainText("refresh failed");
  await expect(page.locator("#statusText")).not.toContainText("just now");
  await expect(page.locator("#notice")).toContainText("older than 30 hours");
});

test("both themes and the methodology route work", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await page.locator("#themeToggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.locator("#themeToggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.goto("/methodology.html", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "How Chronicle works", exact: true })).toBeVisible();
  await page.locator("#themeToggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test.describe("offline edition", () => {
  test.use({ serviceWorkers: "allow" });
  test("service worker does not prefetch duplicate feed JSON and preserves cached content age", async ({ page, context }) => {
    const feeds: string[] = [];
    let navigations = 0;
    page.on("framenavigated", frame => { if (frame === page.mainFrame()) navigations++; });
    context.on("request", request => { if (/\/(feed|repos|learning)\.json/.test(request.url())) feeds.push(request.url()); });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
    expect(feeds).toEqual([]);
    expect(navigations).toBe(1);
    await page.getByRole("button", { name: "Check for updates" }).click();
    const online = await page.evaluate(async () => (await fetch("/feed.json")).json());
    await context.setOffline(true);
    const offline = await page.evaluate(async () => (await fetch("/feed.json")).json());
    expect(offline.last_successful_generated_at).toBe(online.last_successful_generated_at);
    expect(offline.generated_at).toBe(online.generated_at);
  });
});


test("Top News can still be read as cards when no matching cluster was retained", async ({ page }) => {
  const feed = JSON.parse(readFileSync("public/feed.json", "utf8"));
  feed.clusters = []; feed.count = 0; feed.top_news = feed.top_news.slice(0, 1);
  await page.route("**/feed.json", route => route.fulfill({ json: feed }));
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Check for updates" }).click();
  await expect(page.locator("#readerCounter")).toHaveText("1 / 1");
  await expect(page.locator(".reader-card.is-current .reader-title")).toHaveText(feed.top_news[0].title);
  await expect(page.locator("#topNews")).toBeHidden();
});
