import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const learning = JSON.parse(readFileSync("public/learning.json", "utf8"));
const foundations = learning.clusters.filter((item: any) => item.primary.learning?.track === "foundations");
// The current edition can legitimately have no new lessons. Keep interaction
// coverage stable, and cover that empty edition separately below.
learning.clusters = [{
  id: "lesson-fixture",
  primary: { id: "lesson-fixture", title: "Build a reproducible model evaluation", url: "https://example.test/lesson", source_name: "Learning fixture", published_at: new Date().toISOString() },
  members: [], kind: "video", score: 0.8, novelty: 0.8,
  one_liner: "Follow a practical evaluation walkthrough with reproducible examples.",
}, ...foundations];
learning.count = learning.clusters.length;
learning.generated_at = learning.last_successful_generated_at = new Date().toISOString();
learning.source_failed = 0;
learning.failed_sources = [];

test.beforeEach(async ({ context }) => {
  await context.route(/https:\/\//, route => route.abort());
  await context.route("**/learning.json", route => route.fulfill({ json: learning }));
});

test("Learning separates new lessons from Foundations and retains course context in both views", async ({ page }) => {
  await page.goto("/?tab=learning", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: /^New lessons/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".reader-card.is-current")).not.toHaveClass(/is-foundation/);
  await page.getByRole("button", { name: /^Foundations/ }).click();
  await expect(page).toHaveURL(/track=foundations/);
  await expect(page.getByRole("button", { name: /^Foundations/ })).toBeFocused();
  await expect(page.locator("#readerCounter")).toHaveText(`1 / ${foundations.length}`);
  await expect(page.locator(".reader-card.is-current")).toHaveClass(/is-foundation/);
  await expect(page.locator(".reader-card.is-current .course-summary")).toContainText("Examples not run");
  await page.locator(".reader-card.is-current .reader-explain summary").click();
  await expect(page.locator(".reader-card.is-current .course-facts")).toContainText("Prerequisites");
  await expect(page.locator(".reader-card.is-current .course-facts")).toContainText("Syllabus reviewed");
  await expect(page.locator(".reader-card.is-current .course-facts")).toContainText("Code compatibility");
  await page.getByRole("button", { name: "Switch to compact list" }).click();
  await expect(page.locator("#feed article.item")).toHaveCount(foundations.length);
  await expect(page.locator("#feed")).toContainText("April 2023 bootcamp");
  await expect(page.locator("#feed")).toContainText("2022 course");
  await expect(page.locator("#feed")).not.toContainText("1970");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: /^Foundations/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#feed article.item")).toHaveCount(foundations.length);
  await page.getByRole("tab", { name: /Signal/ }).click();
  await expect(page.locator("#learningTracks")).toBeHidden();
});

test("Foundations work in both themes on a small phone", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  // A source warning consumes vertical space and previously hid course facts.
  await page.route("**/learning.json", route => route.fulfill({ json: {
    ...learning, refresh_status: "partial", source_total: 10, source_ok: 5, source_failed: 5,
    failed_sources: ["lesson-a", "lesson-b", "lesson-c", "lesson-d", "lesson-e"],
  } }));
  await page.goto("/?tab=learning&track=foundations", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#notice")).toContainText("5 sources skipped");
  for (const theme of ["light", "dark"]) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    for (let index = 0; index < foundations.length; index++) {
    await page.getByRole("button", { name: "Index", exact: true }).click();
    await page.locator(".reader-index-row").nth(index).click();
    await expect(page.locator(".reader-card.is-current .reader-title")).toBeVisible();
    const bounds = await page.locator(".reader-card.is-current").evaluate(card => ({
      title: card.querySelector(".reader-title")!.getBoundingClientRect().bottom,
      facts: card.querySelector(".course-review")!.getBoundingClientRect().bottom,
      explain: card.querySelector(".reader-explain")!.getBoundingClientRect().top,
      card: card.getBoundingClientRect().bottom,
      viewport: innerHeight,
    }));
    expect(bounds.title).toBeLessThan(bounds.explain);
    expect(bounds.facts).toBeLessThan(bounds.explain);
    expect(bounds.card).toBeLessThanOrEqual(bounds.viewport);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  }
});

test("Learning explains an empty new-lessons shelf and keeps Foundations available", async ({ page }) => {
  await page.route("**/learning.json", route => route.fulfill({ json: {
    ...learning, refresh_status: "partial", clusters: foundations, count: foundations.length,
    source_total: 10, source_ok: 5, source_failed: 5,
  } }));
  await page.goto("/?tab=learning", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#feed")).toContainText("No new lessons in this edition");
  await expect(page.locator("#feed")).toContainText("Foundations");
  await expect(page.locator("#notice")).toContainText("5 sources skipped");
  await page.getByRole("button", { name: /^Foundations/ }).click();
  await expect(page.locator(".reader-card.is-current")).toHaveClass(/is-foundation/);
  await expect(page.locator("#readerCounter")).toHaveText(`1 / ${foundations.length}`);
});
