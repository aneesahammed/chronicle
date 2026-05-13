import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { FeedFile, RawItem, ScoredCluster } from "../types.ts";
import { writeRenderedHomePage, writeSyndicationFeeds } from "./static-site.ts";

test("writeRenderedHomePage renders escaped feed content into the template", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chronicle-static-render-"));
  await fs.writeFile(path.join(root, "index.html"), feedTemplate());

  await writeRenderedHomePage(root, feedFixture());

  const html = await fs.readFile(path.join(root, "index.html"), "utf8");
  assert.match(html, /<script type="application\/ld\+json">/);
  assert.match(html, /Alpha &quot;Beta&quot; &amp; Co/);
  assert.match(html, /Read &#39;now&#39; &lt;tag&gt;/);
  assert.match(html, /<ol class="feed-list">/);
});

test("writeRenderedHomePage renders muted source glyphs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chronicle-static-arxiv-"));
  await fs.writeFile(path.join(root, "index.html"), feedTemplate());

  await writeRenderedHomePage(root, feedFixture({}, [
    {
      source_id: "arxiv_lg",
      source_name: "arXiv cs.LG",
      url: "https://arxiv.org/abs/2605.06676",
      original_url: "https://arxiv.org/abs/2605.06676",
    },
    {
      source_id: "hn_ai",
      source_name: "Hacker News (AI-filtered)",
      url: "https://news.ycombinator.com/item?id=1",
      original_url: "https://news.ycombinator.com/item?id=1",
    },
    {
      source_id: "github_ai_recent_stars",
      source_name: "GitHub",
      url: "https://github.com/example/repo",
      original_url: "https://github.com/example/repo",
    },
  ]));

  const html = await fs.readFile(path.join(root, "index.html"), "utf8");
  assert.match(html, /data-source-glyph="arxiv" viewBox="0 0 17\.732 24\.269"/);
  assert.match(html, /data-source-glyph="hacker-news"/);
  assert.match(html, /data-source-glyph="github"/);
  assert.match(html, /<span>arXiv cs\.LG<\/span>/);
});

test("writeRenderedHomePage renders repo README images and daily star velocity", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chronicle-static-repo-image-"));
  await fs.writeFile(path.join(root, "index.html"), feedTemplate());

  await writeRenderedHomePage(root, feedFixture({
    source_id: "github_trending_daily",
    source_name: "GitHub Trending",
    url: "https://github.com/acme/agent-runtime",
    original_url: "https://github.com/acme/agent-runtime",
    image_url: "https://cdn.example.com/agent.png",
    image_source: "github_readme",
    kind: "repo_trending",
    repo: {
      full_name: "acme/agent-runtime",
      html_url: "https://github.com/acme/agent-runtime",
      stargazers_count: 1300,
      stars_today: 143,
    },
  }));

  const html = await fs.readFile(path.join(root, "index.html"), "utf8");
  assert.match(html, /<img class="item-thumb" src="https:\/\/cdn\.example\.com\/agent\.png"/);
  assert.match(html, /\+143 stars today/);
});

test("writeRenderedHomePage fails when required template anchors are missing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chronicle-static-missing-"));
  await fs.writeFile(path.join(root, "index.html"), "<!doctype html><title>Chronicle</title>");

  await assert.rejects(
    writeRenderedHomePage(root, feedFixture()),
    /static template is missing canonical link/,
  );
});

test("writeSyndicationFeeds strips XML-invalid control characters", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chronicle-syndication-"));

  await writeSyndicationFeeds(root, feedFixture({
    title: "Alpha \u0007 \"Beta\" & Co",
    one_liner: "Read \u000b'now' <tag>",
  }));

  const rss = await fs.readFile(path.join(root, "rss.xml"), "utf8");
  const atom = await fs.readFile(path.join(root, "atom.xml"), "utf8");
  assert.doesNotMatch(rss, /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/);
  assert.doesNotMatch(atom, /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/);
  assert.match(rss, /Alpha  &quot;Beta&quot; &amp; Co/);
  assert.match(atom, /Read &apos;now&apos; &lt;tag&gt;/);
});

function feedTemplate(): string {
  return [
    "<!doctype html>",
    "<html>",
    "<head>",
    "<title>Chronicle</title>",
    '<link rel="canonical" href="https://chronicle.tinycrafts.ai/">',
    '<meta property="og:title" content="Chronicle">',
    '<meta property="og:url" content="https://chronicle.tinycrafts.ai/">',
    "<!-- CHRONICLE_JSONLD_START -->",
    "<!-- CHRONICLE_JSONLD_END -->",
    "</head>",
    "<body>",
    '<span id="statusText">checking sources...</span>',
    '<div class="health" id="healthStrip">checking sources...</div>',
    '<section class="top-news" id="topNews" aria-labelledby="top-news-title" hidden>',
    "<!-- CHRONICLE_TOP_NEWS_START -->",
    "<!-- CHRONICLE_TOP_NEWS_END -->",
    "</section>",
    '<div class="archive-banner" id="archiveBanner" hidden>',
    '<strong id="archiveDateLabel"></strong>',
    "</div>",
    "<main>",
    "<!-- CHRONICLE_FEED_START -->",
    "<!-- CHRONICLE_FEED_END -->",
    "</main>",
    "</body>",
    "</html>",
  ].join("\n");
}

function feedFixture(overrides: {
  title?: string;
  one_liner?: string;
  source_id?: string;
  source_name?: string;
  url?: string;
  original_url?: string;
  image_url?: string;
  image_source?: string;
  kind?: ScoredCluster["kind"];
  repo?: RawItem["repo"];
} = {}, extraItems: Partial<RawItem>[] = []): FeedFile {
  const primary: RawItem = {
    id: "item-1",
    source_id: overrides.source_id ?? "source",
    source_name: overrides.source_name ?? "Source",
    trust: 0.9,
    title: overrides.title ?? "Alpha \"Beta\" & Co",
    url: overrides.url ?? "https://example.com/a?x=1&y=2",
    original_url: overrides.original_url ?? "https://example.com/a?x=1&y=2",
    summary: "Summary",
    image_url: overrides.image_url,
    image_source: overrides.image_source,
    published_at: "2026-05-05T09:00:00.000Z",
    published_at_source: "feed",
    date_confidence: "high",
    repo: overrides.repo,
  };
  const clusters: ScoredCluster[] = [primary, ...extraItems.map((item, index) => ({
    ...primary,
    id: `item-${index + 2}`,
    source_id: item.source_id ?? primary.source_id,
    source_name: item.source_name ?? primary.source_name,
    title: item.title ?? `${primary.title} ${index + 2}`,
    url: item.url ?? primary.url,
    original_url: item.original_url ?? item.url ?? primary.original_url,
  }))].map((item, index) => ({
    id: `cluster-${index + 1}`,
    primary: item,
    members: [item],
    source_trail: [{
      source_id: item.source_id,
      source_name: item.source_name,
      title: item.title,
      url: item.url,
      published_at: item.published_at,
      published_at_source: item.published_at_source,
      date_confidence: item.date_confidence,
    }],
    also_seen_on: [],
    kind: overrides.kind ?? "tool",
    quality: "signal",
    one_liner: overrides.one_liner ?? "Read 'now' <tag>",
    novelty: 0.9,
    novelty_label: "high",
    trust: 0.9,
    score: 0.8 - index * 0.01,
    why_this_surfaced: ["high novelty against the 30-day history"],
    builder_action: "Try it in a sandbox.",
  }));
  return {
    generated_at: "2026-05-05T10:00:00.000Z",
    last_successful_generated_at: "2026-05-05T10:00:00.000Z",
    refresh_status: "ok",
    classification_mode: "llm",
    window_hours: 36,
    source_total: 1,
    source_ok: 1,
    source_failed: 0,
    failed_sources: [],
    source_health: [],
    count: clusters.length,
    clusters,
  };
}
