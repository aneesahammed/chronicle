import { expect, test } from "@playwright/test";

test("mobile reader enhances the static feed without removing the fallback list", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator("#mobileReader")).toBeVisible();
  await expect(page.locator(".reader-card.is-current")).toBeVisible();
  await expect(page.locator("#readerCounter")).toHaveText(/\d+ \/ \d+/);
  await expect(page.locator(".filterbar")).toBeHidden();
  await expect(page.locator("#feed .feed-list").first()).toBeHidden();

  await page.getByRole("button", { name: "Index" }).click();
  await expect(page.getByRole("dialog", { name: "Feed index" })).toBeVisible();
  await page.locator(".reader-refine summary").click();
  await expect(page.locator(".reader-refine-panel").getByRole("button", { name: "high novelty" })).toBeVisible();
  await expect(page.locator(".reader-index-row").first()).toHaveAttribute("aria-current", "true");

  await page.locator(".reader-index-row").nth(1).click();
  await expect(page.locator("#readerCounter")).toHaveText(/^2 \/ /);
  await expect(page.getByRole("dialog", { name: "Feed index" })).toBeHidden();
});

test("mobile reader supports custom swipe and keyboard navigation", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#mobileReader")).toBeVisible();

  await dragReader(page, -180);
  await expect(page.locator("#readerCounter")).toHaveText(/^2 \/ /);

  await page.locator("#readerDeck").focus();
  await page.keyboard.press("PageDown");
  await expect(page.locator("#readerCounter")).toHaveText(/^3 \/ /);

  await page.keyboard.press("PageUp");
  await expect(page.locator("#readerCounter")).toHaveText(/^2 \/ /);
});

test("desktop keeps the original list experience", async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  await page.goto("/");

  await expect(page.locator("#mobileReader")).toHaveCount(0);
  await expect(page.locator("#feed .item").first()).toBeVisible();
  await page.close();
});

async function dragReader(page: import("@playwright/test").Page, deltaY: number) {
  await page.locator("#readerDeck").evaluate((deck, dy) => {
    const rect = deck.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const init = {
      pointerId: 7,
      pointerType: "touch",
      isPrimary: true,
      clientX: x,
      clientY: y,
      bubbles: true,
      cancelable: true,
    };
    deck.dispatchEvent(new PointerEvent("pointerdown", init));
    deck.dispatchEvent(new PointerEvent("pointermove", { ...init, clientY: y + dy }));
    deck.dispatchEvent(new PointerEvent("pointerup", { ...init, clientY: y + dy }));
  }, deltaY);
}
