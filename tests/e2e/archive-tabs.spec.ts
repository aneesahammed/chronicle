import { expect, test } from "@playwright/test";

test("dated archive tabs switch instead of silently staying on Signal", async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  await page.goto("/daily/2026-05-03/");

  await page.getByRole("tab", { name: /Repos/ }).click();

  await expect(page.getByRole("tab", { name: /Repos/ })).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/\/daily\/2026-05-03\/\?tab=repo$/);
  await expect(page.locator("#feed")).toContainText(/unavailable/i);

  await page.close();
});

test("dated archive tabs load same-day role snapshots when present", async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  await page.goto("/daily/2026-06-03/");

  await page.getByRole("tab", { name: /Repos/ }).click();

  await expect(page.getByRole("tab", { name: /Repos/ })).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/\/daily\/2026-06-03\/\?tab=repo$/);
  await expect(page.locator("#statusText")).toContainText("9 items");
  await expect(page.locator("#feed article.item")).toHaveCount(9);

  await page.close();
});
