import assert from "node:assert/strict";
import test from "node:test";
import { fetchAll } from "./fetchers.ts";
import type { Registry } from "../types.ts";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("fetchAll reports failed JSON sources without failing the whole run", async () => {
  globalThis.fetch = async () => new Response("nope", { status: 500, statusText: "Server Error" });

  const result = await fetchAll(registry("hf_models"));

  assert.equal(result.items.length, 0);
  assert.equal(result.source_failed, 1);
  assert.equal(result.failed_sources[0].id, "test");
});

test("fetchAll preserves Hacker News discussion URLs separately from primary URLs", async () => {
  globalThis.fetch = async () => Response.json({
    hits: [{
      objectID: "123",
      title: "OpenAI releases a new model",
      url: "https://openai.com/news/model?utm_source=hn",
      points: 100,
      num_comments: 42,
      created_at: "2026-05-02T00:00:00.000Z",
    }],
  });

  const result = await fetchAll({
    sources: [{
      id: "hn",
      name: "Hacker News",
      type: "hn_algolia",
      url: "https://hn.example.test",
      trust: 0.65,
      limit: 10,
    }],
    hn_ai_keywords: ["openai"],
  });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].url, "https://openai.com/news/model");
  assert.equal(result.items[0].discussion_url, "https://news.ycombinator.com/item?id=123");
  assert.equal(result.items[0].discussion_source, "Hacker News");
});

test("fetchAll reads sitemap sources with include filters and newest entries first", async () => {
  globalThis.fetch = async () => new Response(`
    <?xml version="1.0" encoding="UTF-8"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url>
        <loc>https://example.com/news/older-model</loc>
        <lastmod>2026-04-01T00:00:00.000Z</lastmod>
      </url>
      <url>
        <loc>https://example.com/product/pricing</loc>
        <lastmod>2026-05-02T00:00:00.000Z</lastmod>
      </url>
      <url>
        <loc>https://example.com/news/new-ai-model</loc>
        <lastmod>2026-05-01T00:00:00.000Z</lastmod>
      </url>
    </urlset>
  `, {
    headers: { "content-type": "application/xml" },
  });

  const result = await fetchAll({
    sources: [{
      id: "lab",
      name: "Example Lab",
      type: "sitemap",
      url: "https://example.com/sitemap.xml",
      trust: 0.9,
      kind_hint: "company_announcement",
      title_prefix: "Example Lab",
      url_include: ["example.com/news/"],
      limit: 1,
    }],
    hn_ai_keywords: ["model"],
  });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].url, "https://example.com/news/new-ai-model");
  assert.equal(result.items[0].title, "Example Lab: New AI Model");
  assert.equal(result.items[0].published_at, "2026-05-01T00:00:00.000Z");
});

function registry(type: Registry["sources"][number]["type"]): Registry {
  return {
    sources: [{
      id: "test",
      name: "Test Source",
      type,
      url: "https://source.example.test",
      trust: 0.5,
      limit: 5,
    }],
    hn_ai_keywords: ["ai"],
  };
}
