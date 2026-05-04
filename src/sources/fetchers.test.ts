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
          <meta property="og:title" content="Qwen &gt; Llama · Cursor">
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
  assert.equal(result.items[0].title, "Cursor: Qwen > Llama");
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

test("fetchAll normalizes GitHub releases into repo role items", async () => {
  globalThis.fetch = async (_input, init) => {
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer test-token");
    return Response.json([{
      tag_name: "v1.2.0",
      name: "v1.2.0",
      html_url: "https://github.com/ggml-org/llama.cpp/releases/tag/v1.2.0",
      body: "Improves CUDA inference throughput.",
      published_at: "2026-05-02T00:00:00Z",
    }]);
  };

  const result = await fetchAll({
    sources: [{
      id: "repo_llamacpp",
      name: "llama.cpp releases",
      type: "github_releases",
      url: "https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=10",
      trust: 0.82,
      source_role: "repo",
      kind_hint: "repo_release",
      limit: 10,
    }],
    hn_ai_keywords: [],
  }, { env: { GITHUB_TOKEN: "test-token" } });

  assert.equal(result.items[0].source_role, "repo");
  assert.equal(result.items[0].kind_hint, "repo_release");
  assert.equal(result.items[0].repo?.full_name, "ggml-org/llama.cpp");
  assert.equal(result.items[0].repo?.release_tag, "v1.2.0");
});

test("fetchAll fails malformed GitHub release API URLs before fetching", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json([]);
  };

  const result = await fetchAll({
    sources: [{
      id: "repo_bad",
      name: "Bad Repo",
      type: "github_releases",
      url: "https://api.github.com/search/repositories?q=llm",
      trust: 0.82,
      source_role: "repo",
      kind_hint: "repo_release",
      limit: 10,
    }],
    hn_ai_keywords: [],
  });

  assert.equal(calls, 0);
  assert.equal(result.source_failed, 1);
  assert.match(result.failed_sources[0].message, /invalid GitHub releases API URL/);
});

test("fetchAll does not retry exhausted GitHub rate limits", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json(
      { message: "API rate limit exceeded" },
      {
        status: 403,
        statusText: "Forbidden",
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "1770000000",
        },
      },
    );
  };

  const result = await fetchAll({
    sources: [{
      id: "repo_limited",
      name: "Limited Repo",
      type: "github_releases",
      url: "https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=10",
      trust: 0.82,
      source_role: "repo",
      kind_hint: "repo_release",
      limit: 10,
    }],
    hn_ai_keywords: [],
  });

  assert.equal(calls, 1);
  assert.equal(result.source_failed, 1);
  assert.match(result.failed_sources[0].message, /GitHub rate limit exhausted/);
});

test("fetchAll filters and de-duplicates GitHub repo search results", async () => {
  globalThis.fetch = async (input) => {
    assert.match(String(input), /pushed:%3E=2026-04-02|pushed:>=2026-04-02/);
    return Response.json({
      items: [
        githubRepo({ full_name: "owner/agent-runtime", name: "agent-runtime", stars: 5000 }),
        githubRepo({ full_name: "owner/agent-runtime", name: "agent-runtime", stars: 5000 }),
        githubRepo({ full_name: "owner/awesome-ai", name: "awesome-ai", stars: 10000 }),
        githubRepo({ full_name: "owner/web-app", name: "web-app", description: "A plain app", stars: 2000, topics: [] }),
      ],
    });
  };

  const result = await fetchAll({
    sources: [{
      id: "github_ai_recent",
      name: "GitHub AI recent",
      type: "github_repo_search",
      url: "https://api.github.com/search/repositories?q=llm%20pushed:>=${date_minus_30d}&sort=stars&order=desc",
      trust: 0.62,
      source_role: "repo",
      kind_hint: "repo_trending",
      limit: 10,
    }],
    hn_ai_keywords: [],
  }, { now: new Date("2026-05-02T00:00:00.000Z") });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].repo?.full_name, "owner/agent-runtime");
  assert.equal(result.items[0].kind_hint, "repo_trending");
});

test("fetchAll adds learning metadata for YouTube RSS", async () => {
  globalThis.fetch = async () => new Response(`
    <feed xmlns="http://www.w3.org/2005/Atom">
      <entry>
        <title>Build AI agents</title>
        <link href="https://www.youtube.com/watch?v=abc123" />
        <published>2026-05-01T00:00:00Z</published>
      </entry>
    </feed>
  `);

  const result = await fetchAll({
    sources: [{
      id: "yt_test",
      name: "YouTube Test",
      type: "youtube_rss",
      url: "https://www.youtube.com/feeds/videos.xml?channel_id=UC123",
      trust: 0.78,
      source_role: "learning",
      kind_hint: "video",
      ai_filter: true,
      limit: 5,
    }],
    hn_ai_keywords: ["agent"],
  });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].source_role, "learning");
  assert.equal(result.items[0].learning?.provider, "YouTube");
  assert.equal(result.items[0].learning?.video_id, "abc123");
  assert.equal(result.items[0].image_url, "https://i.ytimg.com/vi/abc123/hqdefault.jpg");
  assert.equal(result.items[0].image_source, "youtube_thumbnail");
});

test("fetchAll parses selector-backed page lists", async () => {
  globalThis.fetch = async () => new Response(`
    <article>
      <a href="/courses/build-ai-agents"><h2>Build AI Agents</h2></a>
      <p>Learn practical agent patterns.</p>
      <time datetime="2026-04-01T00:00:00Z"></time>
    </article>
  `);

  const result = await fetchAll({
    sources: [{
      id: "courses",
      name: "Courses",
      type: "page_list",
      url: "https://example.com/courses/",
      trust: 0.78,
      source_role: "learning",
      kind_hint: "course",
      url_include: ["/courses/"],
      item_selector: "article",
      link_selector: "a[href]",
      title_selector: "h2",
      summary_selector: "p",
      date_selector: "time[datetime]",
      limit: 5,
    }],
    hn_ai_keywords: ["agent"],
  });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].source_role, "learning");
  assert.equal(result.items[0].kind_hint, "course");
  assert.equal(result.items[0].learning?.course_url, "https://example.com/courses/build-ai-agents");
});

test("fetchAll skips non-http links from selector-backed page lists", async () => {
  globalThis.fetch = async () => new Response(`
    <article>
      <a href="javascript:alert(1)"><h2>Build AI Agents</h2></a>
      <p>Learn practical agent patterns.</p>
      <time datetime="2026-04-01T00:00:00Z"></time>
    </article>
  `);

  const result = await fetchAll({
    sources: [{
      id: "courses",
      name: "Courses",
      type: "page_list",
      url: "https://example.com/courses/",
      trust: 0.78,
      source_role: "learning",
      kind_hint: "course",
      item_selector: "article",
      link_selector: "a[href]",
      title_selector: "h2",
      summary_selector: "p",
      date_selector: "time[datetime]",
      limit: 5,
    }],
    hn_ai_keywords: ["agent"],
  });

  assert.equal(result.items.length, 0);
});

test("fetchAll parses anchor-backed page lists with parent dates", async () => {
  globalThis.fetch = async () => new Response(`
    <section>
      <div>
        <a href="https://ai.meta.com/blog/scaling-how-we-build-test-advanced-ai/">Scaling How We Build and Test Our Most Advanced AI</a>
        <span>Apr 8, 2026</span>
      </div>
      <div>
        <a href="https://ai.meta.com/blog/empty-card/">FEATURED</a>
        <span>Apr 8, 2026</span>
      </div>
    </section>
  `);

  const result = await fetchAll({
    sources: [{
      id: "meta_ai",
      name: "Meta AI Blog",
      type: "page_list",
      url: "https://ai.meta.com/blog/",
      trust: 0.86,
      kind_hint: "company_announcement",
      url_include: ["ai.meta.com/blog/"],
      item_selector: 'a[href*="ai.meta.com/blog/"]',
      link_selector: 'a[href*="ai.meta.com/blog/"]',
      title_selector: 'a[href*="ai.meta.com/blog/"]',
      limit: 5,
    }],
    hn_ai_keywords: [],
  });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].title, "Scaling How We Build and Test Our Most Advanced AI");
  assert.equal(result.items[0].published_at, "2026-04-08T00:00:00.000Z");
});

function githubRepo(overrides: {
  full_name: string;
  name: string;
  description?: string;
  stars: number;
  topics?: string[];
}) {
  return {
    full_name: overrides.full_name,
    name: overrides.name,
    html_url: `https://github.com/${overrides.full_name}`,
    description: overrides.description ?? "LLM agent inference runtime",
    language: "TypeScript",
    license: { spdx_id: "MIT" },
    topics: overrides.topics ?? ["llm", "agents"],
    stargazers_count: overrides.stars,
    forks_count: 10,
    open_issues_count: 4,
    pushed_at: "2026-05-01T00:00:00Z",
    created_at: "2026-04-01T00:00:00Z",
  };
}

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
