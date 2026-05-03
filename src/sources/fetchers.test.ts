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

test("fetchAll uses page published date instead of sitemap lastmod", async () => {
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/sitemap.xml")) {
      return new Response(`
        <?xml version="1.0" encoding="UTF-8"?>
        <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url>
            <loc>https://cursor.example/blog/self-hosted-cloud-agents</loc>
            <lastmod>2026-05-02T16:00:29.929Z</lastmod>
          </url>
        </urlset>
      `);
    }
    return new Response(`
      <html>
        <head>
          <meta property="og:title" content="Run cloud agents in your own infrastructure · Cursor">
          <meta name="description" content="Self-hosted cloud agents.">
          <script type="application/ld+json">
            {"@type":"BlogPosting","datePublished":"2026-03-25T12:00:00.000Z"}
          </script>
        </head>
      </html>
    `);
  };

  const result = await fetchAll({
    sources: [{
      id: "cursor",
      name: "Cursor",
      type: "sitemap",
      url: "https://cursor.example/sitemap.xml",
      trust: 0.82,
      kind_hint: "company_announcement",
      title_prefix: "Cursor",
      url_include: ["cursor.example/blog/"],
      limit: 5,
    }],
    hn_ai_keywords: [],
  });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].title, "Cursor: Run cloud agents in your own infrastructure");
  assert.equal(result.items[0].summary, "Self-hosted cloud agents.");
  assert.equal(result.items[0].published_at, "2026-03-25T12:00:00.000Z");
});

test("fetchAll extracts safe RSS and page metadata images", async () => {
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/feed.xml")) {
      return new Response(`
        <?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
          <channel>
            <item>
              <title>AI image story</title>
              <link>https://example.com/news/image-story</link>
              <pubDate>Sat, 02 May 2026 00:00:00 GMT</pubDate>
              <media:content url="https://cdn.example.com/story.jpg" type="image/jpeg" />
            </item>
          </channel>
        </rss>
      `);
    }
    return new Response(`
      <html>
        <head>
          <meta property="og:title" content="Page image story">
          <meta property="og:image" content="/og.png">
          <script type="application/ld+json">
            {"datePublished":"2026-05-02T00:00:00.000Z"}
          </script>
        </head>
      </html>
    `);
  };

  const rssResult = await fetchAll({
    sources: [{
      id: "rss",
      name: "RSS",
      type: "rss",
      url: "https://example.com/feed.xml",
      trust: 0.7,
      limit: 5,
    }],
    hn_ai_keywords: [],
  });
  assert.equal(rssResult.items[0].image_url, "https://cdn.example.com/story.jpg");

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/sitemap.xml")) {
      return new Response(`
        <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url><loc>https://example.com/news/page-image-story</loc><lastmod>2026-05-02T00:00:00.000Z</lastmod></url>
        </urlset>
      `);
    }
    return new Response(`
      <meta property="og:title" content="Page image story">
      <meta property="og:image" content="/og.png">
      <script type="application/ld+json">{"datePublished":"2026-05-02T00:00:00.000Z"}</script>
    `);
  };

  const sitemapResult = await fetchAll({
    sources: [{
      id: "site",
      name: "Site",
      type: "sitemap",
      url: "https://example.com/sitemap.xml",
      trust: 0.7,
      url_include: ["example.com/news/"],
      limit: 5,
    }],
    hn_ai_keywords: [],
  });
  assert.equal(sitemapResult.items[0].image_url, "https://example.com/og.png");
});

test("fetchAll follows more than five child sitemaps", async () => {
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/sitemap.xml")) {
      return new Response(`
        <?xml version="1.0" encoding="UTF-8"?>
        <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          ${Array.from({ length: 6 }, (_, i) => `
            <sitemap><loc>https://example.com/sitemap-${i + 1}.xml</loc></sitemap>
          `).join("")}
        </sitemapindex>
      `);
    }
    const child = url.match(/sitemap-(\d+)\.xml/)?.[1];
    if (child) {
      return new Response(`
        <?xml version="1.0" encoding="UTF-8"?>
        <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url>
            <loc>https://example.com/news/item-${child}</loc>
            <lastmod>2026-05-0${child}T00:00:00.000Z</lastmod>
          </url>
        </urlset>
      `);
    }
    const item = url.match(/item-(\d+)/)?.[1] ?? "1";
    return new Response(`
      <script type="application/ld+json">
        {"datePublished":"2026-05-0${item}T00:00:00.000Z"}
      </script>
    `);
  };

  const result = await fetchAll({
    sources: [{
      id: "lab",
      name: "Example Lab",
      type: "sitemap",
      url: "https://example.com/sitemap.xml",
      trust: 0.9,
      kind_hint: "company_announcement",
      url_include: ["example.com/news/"],
      limit: 10,
    }],
    hn_ai_keywords: [],
  });

  assert.equal(result.items.length, 6);
  assert.ok(result.items.some((item) => item.url === "https://example.com/news/item-6"));
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
