import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => localStorage.setItem("chronicle-reader-mode", "deck"));
  await context.route(/https:\/\/(?!127\.0\.0\.1)/, route => route.abort());
});

test("mobile reader enhances the static feed without removing the fallback list", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });

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
  await page.goto("/", { waitUntil: "domcontentloaded" });
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
  const page = await browser.newPage({ viewport: { width: 375, height: 667 }, serviceWorkers: "block" });
  await page.addInitScript(() => localStorage.setItem("chronicle-reader-mode", "deck"));
  await installImageFeed(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#mobileReader")).toBeVisible();

  await page.getByRole("button", { name: "Index" }).click();
  await page.locator(".reader-index-row").nth(10).click();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#mobileReader")).toBeVisible();

  await page.getByRole("button", { name: "Index" }).click();
  await page.locator('.reader-index-row[data-reader-index="5"]').click();
  const image = page.locator(".reader-card.is-current .reader-media");
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(800);

  const closed = await visibleBounds(page);
  expect(closed.cardBottom).toBeLessThanOrEqual(closed.viewportHeight);
  expect(closed.titleBottom).toBeLessThan(closed.explainTop);

  await page.locator(".reader-card.is-current .reader-explain summary").click();
  const open = await visibleBounds(page);
  expect(open.explainBottom).toBeLessThanOrEqual(open.viewportHeight);

  await page.close();
});

test("mobile reader preserves readable content when an image fails", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await installImageFeed(page, true);
  await page.goto("/", { waitUntil: "domcontentloaded" });

  const card = page.locator(".reader-card.is-current");
  await expect(card).toHaveClass(/is-text-first/);
  await expect(card.locator(".reader-media")).toHaveCount(0);
  await expect(card.locator(".reader-title a")).toHaveAttribute("href", "https://example.test/reader/0");
  await expect(card.locator(".reader-title")).toBeVisible();
  const closed = await visibleBounds(page);
  expect(closed.titleBottom).toBeLessThan(closed.explainTop);
  await card.locator(".reader-explain summary").click();
  const open = await visibleBounds(page);
  expect(open.explainBottom).toBeLessThanOrEqual(open.viewportHeight);
});

test("desktop keeps the original list experience", async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  await page.goto("/", { waitUntil: "domcontentloaded" });

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

async function installImageFeed(page: Page, failImage = false) {
  // Exercise layout with a decoded image, independently of today's feeds and
  // third-party hosts. Aborting the image tests the text fallback instead.
  const now = new Date().toISOString();
  const clusters = Array.from({ length: 12 }, (_, index) => ({
    id: `reader-fixture-${index}`,
    primary: {
      title: `Engineering lesson ${index + 1}: building and evaluating reliable language model applications`,
      url: `https://example.test/reader/${index}`,
      image_url: "https://example.test/reader-image.svg",
      published_at: now,
      source_name: "Reader layout fixture",
    },
    members: [],
    kind: "tutorial",
    score: 0.8,
    novelty: 0.8,
    one_liner: "A practical walkthrough of evaluation methods, deployment tradeoffs, and reproducible examples for developers.",
    why_this_surfaced: ["Includes implementation details and reproducible examples."],
    builder_action: "Review the examples and compare the evaluation results.",
  }));
  const feed = {
    generated_at: now, last_successful_generated_at: now, refresh_status: "success",
    count: clusters.length, clusters, top_news: [], source_total: 1, source_ok: 1,
    source_failed: 0, failed_sources: [], source_health: [],
  };
  const html = readFileSync("public/index.html", "utf8").replace(
    /(<script id="feedBootstrap" type="application\/json">)[\s\S]*?(<\/script>)/,
    (_match, start, end) => `${start}${JSON.stringify(feed)}${end}`,
  );
  await page.route(/https:\/\//, route => route.abort());
  await page.route("https://example.test/reader-image.svg", route => failImage
    ? route.abort()
    : route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450"><rect width="800" height="450" fill="#657986"/></svg>' }));
  await page.route(url => url.pathname === "/", route => route.fulfill({ contentType: "text/html", body: html }));
  await page.route("**/feed.json", route => route.fulfill({ json: feed }));
}
