import { expect, test } from "@playwright/test";

test.use({ serviceWorkers: "allow", viewport: { width: 571, height: 1027 } });

test("an existing cache cannot apply old app code to the latest page", async ({ page, context }) => {
  await context.route(/https:\/\//, route => route.abort());
  await page.goto("/__test__/legacy-client.html");
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/__test__/legacy-worker.js", { scope: "/" });
    await navigator.serviceWorker.ready;
  });
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await page.reload();
  await page.addScriptTag({ url: "/app.js" });
  await expect(page.locator("#readerMode")).toHaveText("Use card reader");
  // The historical ignoreSearch behavior also defeats query-string version tags.
  expect(await page.evaluate(async () => (await fetch("/app.js?v=next")).text())).toContain("Use card reader");

  // Foundations remain available when external lesson feeds return no items.
  await page.goto("/?tab=learning&track=foundations", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#mobileReader")).toBeVisible();
  await expect(page.locator("#readerMode")).toHaveText("");
  await expect(page.locator("#readerMode svg")).toBeVisible();
  await expect(page.locator("#readerMode")).toHaveAttribute("aria-label", "Switch to compact list");
  await expect(page.getByRole("button", { name: /^Foundations/ })).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL.endsWith("/sw.js"))).toBe(true);
  await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.waiting == null)).toBe(true);
  await expect(page.locator("#pwaUpdateNotice")).toBeHidden();
  const appPath = await page.locator('script[type="module"]').getAttribute("src");
  expect(appPath).toMatch(/^\/assets\/app\.[a-f0-9]{16}\.js$/);
  const bounds = await page.locator("#readerMode").boundingBox();
  expect(bounds?.width).toBe(44);
  expect(bounds?.height).toBe(44);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#readerMode svg")).toBeVisible();
  // The current worker pre-caches the same immutable asset URLs for offline use.
  await context.setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#mobileReader")).toBeVisible();
  await expect(page.locator("#readerMode svg")).toBeVisible();
});
