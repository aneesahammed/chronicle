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

test("mobile reader supports scroll snap and keyboard navigation", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#mobileReader")).toBeVisible();

  await scrollReaderTo(page, 1);
  await expect(page.locator("#readerCounter")).toHaveText(/^2 \/ /);

  await page.locator("#readerDeck").focus();
  await page.keyboard.press("PageDown");
  await expect(page.locator("#readerCounter")).toHaveText(/^3 \/ /);

  await page.keyboard.press("PageUp");
  await expect(page.locator("#readerCounter")).toHaveText(/^2 \/ /);
});

test("compact mobile reader keeps image cards readable on iPhone SE", async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 375, height: 667 } });
  await page.goto("/");
  await expect(page.locator("#mobileReader")).toBeVisible();

  await page.getByRole("button", { name: "Index" }).click();
  await page.locator(".reader-index-row").nth(10).click();
  await page.reload();
  await expect(page.locator("#mobileReader")).toBeVisible();

  await page.getByRole("button", { name: "Index" }).click();
  const imageIndex = await firstImageReaderIndex(page, 5);
  await page.locator(`.reader-index-row[data-reader-index="${imageIndex}"]`).click();
  await expect(page.locator(".reader-card.is-current .reader-media")).toBeVisible();

  const closed = await visibleBounds(page);
  expect(closed.cardBottom).toBeLessThanOrEqual(closed.viewportHeight);
  expect(closed.titleBottom).toBeLessThan(closed.explainTop);

  await page.locator(".reader-card.is-current .reader-explain summary").click();
  const open = await visibleBounds(page);
  expect(open.explainBottom).toBeLessThanOrEqual(open.viewportHeight);

  await page.close();
});

test("desktop keeps the original list experience", async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  await page.goto("/");

  await expect(page.locator("#mobileReader")).toHaveCount(0);
  await expect(page.locator("#feed .item").first()).toBeVisible();
  await page.close();
});

async function scrollReaderTo(page: import("@playwright/test").Page, index: number) {
  await page.waitForTimeout(80);
  await page.locator("#readerDeck").evaluate((deck, targetIndex) => {
    const target = deck.querySelector(`.reader-card[data-reader-index="${targetIndex}"]`);
    if (!target) throw new Error(`reader card ${targetIndex} not found`);
    deck.scrollTo({ top: (target as HTMLElement).offsetTop, behavior: "auto" });
    deck.dispatchEvent(new Event("scroll"));
  }, index);
}

async function visibleBounds(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const card = document.querySelector(".reader-card.is-current");
    const title = card?.querySelector(".reader-title");
    const explain = card?.querySelector(".reader-explain");
    const rect = (element: Element | null | undefined) => {
      const bounds = element?.getBoundingClientRect();
      return bounds ? { top: bounds.top, bottom: bounds.bottom } : { top: 0, bottom: 0 };
    };
    return {
      viewportHeight: window.innerHeight,
      cardBottom: rect(card).bottom,
      titleBottom: rect(title).bottom,
      explainTop: rect(explain).top,
      explainBottom: rect(explain).bottom,
    };
  });
}

async function firstImageReaderIndex(page: import("@playwright/test").Page, startIndex: number) {
  return page.locator(".reader-card").evaluateAll((cards, minIndex) => {
    const card = cards.find((candidate) => {
      const index = Number((candidate as HTMLElement).dataset.readerIndex || -1);
      return index >= Number(minIndex) && Boolean(candidate.querySelector(".reader-media"));
    }) as HTMLElement | undefined;
    if (!card?.dataset.readerIndex) throw new Error("No image-backed reader card found");
    return Number(card.dataset.readerIndex);
  }, startIndex);
}
