import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildTopNews,
  readerUrlFor,
  selectTopNewsCandidates,
} from "./top-news.ts";
import { extractFirstImageFromHtml, sanitizeImageUrl } from "./images.ts";
import type { Kind, Quality, RawItem, ScoredCluster } from "../types.ts";

test("selectTopNewsCandidates filters hype, caps sources, and suppresses near duplicates", () => {
  const items = [
    scored({ id: "a1", source_id: "lab", kind: "news", title: "Anthropic launches Claude Security scanner" }),
    scored({ id: "a2", source_id: "lab", kind: "company_announcement", title: "Claude Security scanner launches for codebases" }),
    scored({ id: "a3", source_id: "lab", kind: "tool", title: "A different AI developer tool ships" }),
    scored({ id: "b1", source_id: "other", kind: "news", quality: "hype", title: "AI changes everything again" }),
    scored({ id: "b2", source_id: "reddit", kind: "discussion", url: "https://old.reddit.com/r/LocalLLaMA/comments/x", title: "What GPU should I buy?" }),
    scored({ id: "b3", source_id: "reddit", kind: "discussion", url: "https://github.com/example/project", score: 0.58, title: "Useful open source inference project" }),
    scored({ id: "b4", source_id: "other", kind: "news", url: "http://example.com/insecure", title: "Insecure source URL" }),
  ];

  const selected = selectTopNewsCandidates(items);

  assert.deepEqual(selected.map((item) => item.id), ["a1", "a3", "b3"]);
});

test("readerUrlFor wraps public URLs and rejects non-http URLs", () => {
  assert.equal(
    readerUrlFor("https://example.com/post?q=ai#section"),
    "https://r.jina.ai/https://example.com/post?q=ai",
  );
  assert.throws(() => readerUrlFor("file:///tmp/post.html"), /http\(s\)/);
});

test("image helpers only accept safe https images", () => {
  assert.equal(sanitizeImageUrl("https://cdn.example.com/image.png"), "https://cdn.example.com/image.png");
  assert.equal(sanitizeImageUrl("http://cdn.example.com/image.png"), undefined);
  assert.equal(sanitizeImageUrl("javascript:alert(1)"), undefined);
  assert.equal(
    extractFirstImageFromHtml('<p><img src="/og.png"></p>', "https://example.com/posts/1"),
    "https://example.com/og.png",
  );
});

test("buildTopNews enriches with Jina and Groq without storing raw article text", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chronicle-top-news-"));
  const cachePath = path.join(root, "enrichments.json");
  const fetchImpl = async (input: string | URL | Request) => {
    assert.match(String(input), /^https:\/\/r\.jina\.ai\//);
    return new Response("This is raw article text that should only be summarized in memory.");
  };

  const topNews = await buildTopNews([
    scored({
      id: "story",
      title: "Anthropic launches Claude Security",
      summary: "Anthropic launched a security scanner for codebases.",
      image_url: "https://cdn.example.com/security.png",
    }),
  ], {
    now: new Date("2026-05-03T12:00:00.000Z"),
    cachePath,
    env: { GROQ_API_KEY: "test-key" },
    fetchImpl,
    summarize: async (items) => {
      assert.equal(items.length, 1);
      assert.equal(items[0].reader_text.includes("raw article text"), true);
      return [{
        index: 0,
        dek: "Anthropic launched a code security scanner for Claude users.",
        brief: "The release adds AI-assisted vulnerability scanning for teams that already use Claude.",
        image_alt: "Security product illustration",
      }];
    },
  });

  assert.equal(topNews.length, 1);
  assert.equal(topNews[0].enrichment_status, "ok");
  assert.equal(topNews[0].image_url, "https://cdn.example.com/security.png");
  const cacheText = await fs.readFile(cachePath, "utf8");
  assert.equal(cacheText.includes("raw article text"), false);
  assert.match(cacheText, /code security scanner/);
});

test("buildTopNews falls back to metadata_only when Groq returns malformed JSON", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chronicle-top-news-fallback-"));
  const cachePath = path.join(root, "enrichments.json");

  const topNews = await buildTopNews([scored({
    id: "fallback",
    title: "Useful AI launch",
    summary: "A useful launch summary from the source feed.",
  })], {
    now: new Date("2026-05-03T12:00:00.000Z"),
    cachePath,
    env: { GROQ_API_KEY: "test-key" },
    fetchImpl: async () => new Response("Reader text that should be ignored after summary failure."),
    summarize: async () => {
      throw new Error("malformed JSON");
    },
  });

  assert.equal(topNews.length, 1);
  assert.equal(topNews[0].enrichment_status, "metadata_only");
  assert.equal(topNews[0].dek, "Useful one liner.");
  assert.equal(topNews[0].brief, "A useful launch summary from the source feed.");

  const cache = JSON.parse(await fs.readFile(cachePath, "utf8"));
  assert.equal(cache.entries["https://example.com/fallback"].status, "failed");
  assert.equal(cache.entries["https://example.com/fallback"].failure_count, 1);
});

test("buildTopNews retries stale failures and prunes cache deterministically", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chronicle-top-news-cache-"));
  const cachePath = path.join(root, "enrichments.json");
  const entries: Record<string, unknown> = Object.fromEntries(Array.from({ length: 505 }, (_, index) => {
    const key = `https://example.com/old-${String(index).padStart(3, "0")}`;
    return [key, {
      url: key,
      title: `Old ${index}`,
      source_name: "Example",
      dek: "Old cached dek",
      brief: "Old cached brief",
      status: "ok",
      attempted_at: new Date(2026, 0, 1, 0, index).toISOString(),
      enriched_at: new Date(2026, 0, 1, 0, index).toISOString(),
      failure_count: 0,
    }];
  }));
  entries["https://example.com/story"] = {
    url: "https://example.com/story",
    title: "Failed story",
    source_name: "Example",
    dek: "Failed dek",
    brief: "Failed brief",
    status: "failed",
    attempted_at: "2026-05-01T00:00:00.000Z",
    failure_count: 1,
  };
  await fs.writeFile(cachePath, JSON.stringify({ version: 1, entries }, null, 2));

  let fetched = false;
  await buildTopNews([scored({ id: "story", url: "https://example.com/story" })], {
    now: new Date("2026-05-03T12:00:00.000Z"),
    cachePath,
    env: { GROQ_API_KEY: "test-key" },
    fetchImpl: async () => {
      fetched = true;
      return new Response("Fresh article text.");
    },
    summarize: async () => [{
      index: 0,
      dek: "Fresh dek",
      brief: "Fresh brief",
    }],
  });

  assert.equal(fetched, true);
  const cache = JSON.parse(await fs.readFile(cachePath, "utf8"));
  const keys = Object.keys(cache.entries);
  assert.equal(keys.length, 500);
  assert.deepEqual(keys, [...keys].sort());
  assert.equal(cache.entries["https://example.com/story"].status, "ok");
});

function scored(overrides: Partial<RawItem> & {
  kind?: Kind;
  quality?: Quality;
  score?: number;
  novelty?: number;
} = {}): ScoredCluster {
  const primary: RawItem = {
    id: overrides.id ?? "item",
    source_id: overrides.source_id ?? "source",
    source_name: overrides.source_name ?? "Source",
    trust: overrides.trust ?? 0.8,
    kind_hint: overrides.kind_hint,
    title: overrides.title ?? "Useful AI news",
    url: overrides.url ?? `https://example.com/${overrides.id ?? "item"}`,
    original_url: overrides.original_url ?? overrides.url ?? `https://example.com/${overrides.id ?? "item"}`,
    discussion_url: overrides.discussion_url,
    discussion_source: overrides.discussion_source,
    summary: overrides.summary ?? "Useful summary.",
    image_url: overrides.image_url,
    image_source: overrides.image_source ?? (overrides.image_url ? "test" : undefined),
    published_at: overrides.published_at ?? "2026-05-03T10:00:00.000Z",
    published_at_source: overrides.published_at_source ?? "feed",
    date_confidence: overrides.date_confidence ?? "high",
    engagement: overrides.engagement,
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
    kind: overrides.kind ?? "news",
    quality: overrides.quality ?? "signal",
    one_liner: "Useful one liner.",
    novelty: overrides.novelty ?? 0.8,
    trust: primary.trust,
    score: overrides.score ?? 0.72,
  };
}
