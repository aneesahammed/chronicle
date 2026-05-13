import assert from "node:assert/strict";
import test from "node:test";
import { scoreCluster } from "./score.ts";
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
