import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { scoreCluster, W } from "./score.ts";
import type { Cluster, RawItem } from "../types.ts";

test("scoreCluster ranks signal quality above hype for the same cluster", () => {
  const cluster = makeCluster();
  const now = new Date("2026-05-02T01:00:00.000Z");

  const signal = scoreCluster(cluster, {
    kind: "model_release",
    quality: "signal",
    one_liner: "Concrete release.",
  }, 1, now);

  const hype = scoreCluster(cluster, {
    kind: "model_release",
    quality: "hype",
    one_liner: "Marketing release.",
  }, 1, now);

  assert.ok(signal.score > hype.score);
});

test("methodology page shows the current ranking weights", async () => {
  const html = await readFile(new URL("../../public/methodology.html", import.meta.url), "utf8");
  const css = await readFile(new URL("../../public/policy.css", import.meta.url), "utf8");
  for (const [factor, weight] of Object.entries(W)) {
    const percent = Math.round(weight * 100);
    assert.match(html, new RegExp(`data-factor="${factor}" data-w="${percent}"`), `${factor} weight on methodology page`);
    assert.match(css, new RegExp(`\\[data-w="${percent}"\\] \\.weight-bar`), `bar width for ${percent}%`);
  }
});

test("scoreCluster boosts repo trending items with daily star velocity", () => {
  const now = new Date("2026-05-13T12:00:00.000Z");
  const slow = scoreCluster(makeRepoCluster(5), {
    kind: "repo_trending",
    quality: "mixed",
    one_liner: "Slow repo.",
  }, 1, now);
  const fast = scoreCluster(makeRepoCluster(500), {
    kind: "repo_trending",
    quality: "mixed",
    one_liner: "Fast repo.",
  }, 1, now);

  assert.ok(fast.score > slow.score);
  assert.ok(fast.why_this_surfaced.includes("high daily GitHub star velocity"));
});

function makeCluster(): Cluster {
  const primary: RawItem = {
    id: "x",
    source_id: "source",
    source_name: "Source",
    trust: 0.8,
    title: "New coding model released",
    url: "https://example.com/model",
    original_url: "https://example.com/model",
    published_at: "2026-05-02T00:00:00.000Z",
    published_at_source: "feed",
    date_confidence: "high",
  };
  return {
    id: "x",
    primary,
    members: [primary],
    source_trail: [{
      source_id: primary.source_id,
      source_name: primary.source_name,
      title: primary.title,
      url: primary.url,
      published_at: primary.published_at,
      published_at_source: primary.published_at_source,
      date_confidence: primary.date_confidence,
    }],
    also_seen_on: [],
  };
}

function makeRepoCluster(starsToday: number): Cluster {
  const primary: RawItem = {
    id: `repo-${starsToday}`,
    source_id: "github_trending_daily",
    source_name: "GitHub Trending",
    source_role: "repo",
    trust: 0.66,
    kind_hint: "repo_trending",
    title: `acme/repo-${starsToday}`,
    url: `https://github.com/acme/repo-${starsToday}`,
    original_url: `https://github.com/acme/repo-${starsToday}`,
    published_at: "2026-05-13T12:00:00.000Z",
    published_at_source: "generated_fallback",
    date_confidence: "low",
    engagement: { score: starsToday },
    repo: {
      full_name: `acme/repo-${starsToday}`,
      html_url: `https://github.com/acme/repo-${starsToday}`,
      stargazers_count: 900,
      stars_today: starsToday,
    },
  };
  return {
    id: primary.id,
    primary,
    members: [primary],
    source_trail: [{
      source_id: primary.source_id,
      source_name: primary.source_name,
      title: primary.title,
      url: primary.url,
      published_at: primary.published_at,
      published_at_source: primary.published_at_source,
      date_confidence: primary.date_confidence,
    }],
    also_seen_on: [],
  };
}

test("reposts change the coverage label without adding independent article weight", () => {
  const c = makeCluster();
  const cls = { kind: "model_release" as const, quality: "signal" as const, one_liner: "Release." };
  const before = scoreCluster(c, cls, 1, new Date("2026-05-02"));
  c.members.push({ ...c.primary, source_id: "hn_ai" });
  const after = scoreCluster(c, cls, 1, new Date("2026-05-02"));
  assert.equal(before.score, after.score);
  assert.ok(after.why_this_surfaced.some(reason => reason.includes("seen on 2 feeds")));
  assert.ok(!after.why_this_surfaced.some(reason => reason.includes("corroborated")));
});

test("action hints require source metadata supporting the review task", () => {
  const c = makeCluster();
  const cls = { kind: "model_release" as const, quality: "mixed" as const, one_liner: "Release." };
  assert.equal(scoreCluster(c, cls, 1, new Date("2026-05-02")).builder_action, "");
  c.primary.summary = "The release changes the API schema and includes migration instructions for existing integrations.";
  assert.match(scoreCluster(c, cls, 1, new Date("2026-05-02")).builder_action, /migration/);
});
