import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runPipeline } from "./index.ts";
import type { LlmProvider } from "./llm/providers.ts";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("runPipeline rejects malformed numeric environment settings", async () => {
  await assert.rejects(
    runPipeline({
      registryPath: "/tmp/chronicle-missing-registry.yaml",
      publicDir: "/tmp/chronicle-public",
      dataDir: "/tmp/chronicle-data",
      env: { MAX_OUTPUT: "not-a-number" },
    }),
    /MAX_OUTPUT must be a non-negative integer/,
  );

  await assert.rejects(
    runPipeline({
      registryPath: "/tmp/chronicle-missing-registry.yaml",
      publicDir: "/tmp/chronicle-public",
      dataDir: "/tmp/chronicle-data",
      env: { WINDOW_HOURS: "0" },
    }),
    /WINDOW_HOURS must be a positive number/,
  );
});

test("runPipeline preserves the previous feed when every source fails", async () => {
  globalThis.fetch = async () => new Response("nope", { status: 500, statusText: "Server Error" });

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chronicle-pipeline-"));
  const publicDir = path.join(root, "public");
  const dataDir = path.join(root, "data");
  const registryPath = path.join(root, "registry.yaml");
  await fs.mkdir(publicDir, { recursive: true });
  await fs.writeFile(registryPath, `
sources:
  - id: failing_models
    name: Failing Models
    type: hf_models
    url: https://source.example.test/models
    trust: 0.5
    kind_hint: model_release
    limit: 5
hn_ai_keywords:
  - ai
`);

  const previous = {
    generated_at: "2026-05-01T06:00:00.000Z",
    last_successful_generated_at: "2026-05-01T06:00:00.000Z",
    refresh_status: "ok",
    classification_mode: "fallback",
    window_hours: 36,
    source_total: 1,
    source_ok: 1,
    source_failed: 0,
    failed_sources: [],
    count: 1,
    clusters: [{ id: "existing", primary: { title: "Existing item" } }],
  };
  await fs.writeFile(path.join(publicDir, "feed.json"), JSON.stringify(previous, null, 2));

  await runPipeline({
    registryPath,
    publicDir,
    dataDir,
    now: new Date("2026-05-02T06:00:00.000Z"),
    env: {},
  });

  const feed = JSON.parse(await fs.readFile(path.join(publicDir, "feed.json"), "utf8"));
  assert.equal(feed.refresh_status, "failed");
  assert.equal(feed.source_failed, 1);
  assert.equal(feed.count, 1);
  assert.deepEqual(feed.clusters, previous.clusters);
  assert.equal(feed.last_successful_generated_at, "2026-05-01T06:00:00.000Z");
});

test("runPipeline preserves previous repo and learning feeds when their sources fail", async () => {
  globalThis.fetch = async () => new Response("nope", { status: 500, statusText: "Server Error" });

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chronicle-role-fallback-"));
  const publicDir = path.join(root, "public");
  const dataDir = path.join(root, "data");
  const registryPath = path.join(root, "registry.yaml");
  await fs.mkdir(publicDir, { recursive: true });
  await fs.writeFile(registryPath, `
sources:
  - id: repo_test
    name: Repo Test
    type: github_releases
    url: https://api.github.com/repos/owner/repo/releases?per_page=10
    trust: 0.8
    source_role: repo
    kind_hint: repo_release
    limit: 5
  - id: yt_test
    name: YouTube Test
    type: youtube_rss
    url: https://www.youtube.com/feeds/videos.xml?channel_id=UC123
    trust: 0.8
    source_role: learning
    kind_hint: video
    limit: 5
hn_ai_keywords:
  - ai
`);

  const previousRepos = previousRoleFeed("repo", "repo_release", "Existing repo release");
  const previousLearning = previousRoleFeed("learning", "video", "Existing learning video");
  await fs.writeFile(path.join(publicDir, "repos.json"), JSON.stringify(previousRepos, null, 2));
  await fs.writeFile(path.join(publicDir, "learning.json"), JSON.stringify(previousLearning, null, 2));

  await runPipeline({
    registryPath,
    publicDir,
    dataDir,
    now: new Date("2026-05-02T06:00:00.000Z"),
    env: {},
  });

  const repos = JSON.parse(await fs.readFile(path.join(publicDir, "repos.json"), "utf8"));
  const learning = JSON.parse(await fs.readFile(path.join(publicDir, "learning.json"), "utf8"));
  assert.equal(repos.refresh_status, "failed");
  assert.equal(repos.count, 1);
  assert.deepEqual(repos.clusters, previousRepos.clusters);
  assert.equal(learning.refresh_status, "failed");
  assert.equal(learning.count, 1);
  assert.deepEqual(learning.clusters, previousLearning.clusters);
});

test("runPipeline refuses to overwrite a corrupt repo history file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chronicle-corrupt-repo-history-"));
  const dataDir = path.join(root, "data");
  const registryPath = path.join(root, "registry.yaml");
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, "repo-history.json"), "{not json");
  await fs.writeFile(registryPath, `
sources: []
hn_ai_keywords: []
`);

  await assert.rejects(
    runPipeline({
      registryPath,
      publicDir: path.join(root, "public"),
      dataDir,
      now: new Date("2026-05-02T06:00:00.000Z"),
      env: {},
    }),
    /could not read repo history/,
  );
});

test("runPipeline keeps previously seen repos when they are currently trending", async () => {
  const trendingHtml = readFileSync(new URL("./sources/fixtures/github-trending-daily.html", import.meta.url), "utf8");
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === "https://github.com/trending?since=daily") return new Response(trendingHtml);
    if (url === "https://api.github.com/repos/acme/agent-runtime") {
      return Response.json({
        full_name: "acme/agent-runtime",
        name: "agent-runtime",
        html_url: "https://github.com/acme/agent-runtime",
        description: "Persistent memory and tool runtime for AI coding agents.",
        language: "TypeScript",
        license: { spdx_id: "MIT" },
        topics: ["llm", "agents"],
        stargazers_count: 1300,
        forks_count: 90,
        open_issues_count: 7,
        pushed_at: "2026-05-13T08:00:00.000Z",
        created_at: "2026-04-01T00:00:00.000Z",
      });
    }
    if (url === "https://raw.githubusercontent.com/acme/agent-runtime/HEAD/README.md") {
      return new Response("![preview](https://cdn.example.com/agent.png)\nAI coding agent runtime.");
    }
    if (url.startsWith("https://api.github.com/repos/")) {
      return Response.json({
        full_name: url.replace("https://api.github.com/repos/", ""),
        name: url.split("/").at(-1),
        html_url: url.replace("https://api.github.com/repos/", "https://github.com/"),
        description: "General web project",
        stargazers_count: 1000,
        topics: [],
      });
    }
    if (url.startsWith("https://raw.githubusercontent.com/")) return new Response("General web project.");
    throw new Error(`unexpected fetch ${url}`);
  };

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chronicle-current-trending-repo-"));
  const publicDir = path.join(root, "public");
  const dataDir = path.join(root, "data");
  const registryPath = path.join(root, "registry.yaml");
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, "repo-history.json"), JSON.stringify({
    repos: {
      "acme/agent-runtime": {
        full_name: "acme/agent-runtime",
        first_seen_at: "2026-04-01T00:00:00.000Z",
        last_seen_at: "2026-04-02T00:00:00.000Z",
        stargazers_count: 1000,
      },
    },
  }, null, 2));
  await fs.writeFile(registryPath, `
sources:
  - id: github_trending_daily
    name: GitHub Trending
    type: github_trending
    url: https://github.com/trending?since=daily
    trust: 0.66
    source_role: repo
    kind_hint: repo_trending
    limit: 25
hn_ai_keywords:
  - ai
`);

  await runPipeline({
    registryPath,
    publicDir,
    dataDir,
    now: new Date("2026-05-13T12:00:00.000Z"),
    env: {},
  });

  const repos = JSON.parse(await fs.readFile(path.join(publicDir, "repos.json"), "utf8"));
  const repo = repos.clusters.find((cluster: { primary: { repo?: { full_name?: string } } }) =>
    cluster.primary.repo?.full_name === "acme/agent-runtime");
  assert.ok(repo);
  assert.equal(repo.primary.repo.stars_today, 143);
  assert.equal(repo.primary.repo.stars_delta_run, 300);
  assert.equal(repo.quality, "signal");
});

test("runPipeline preserves the previous feed when scoring produces no output", async () => {
  globalThis.fetch = async () => Response.json([{
    id: "org/model",
    downloads: 100,
    likes: 5,
    lastModified: "2026-05-02T05:00:00.000Z",
  }]);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chronicle-empty-score-"));
  const publicDir = path.join(root, "public");
  const dataDir = path.join(root, "data");
  const registryPath = path.join(root, "registry.yaml");
  await fs.mkdir(publicDir, { recursive: true });
  await fs.writeFile(registryPath, `
sources:
  - id: hf_models_test
    name: Models
    type: hf_models
    url: https://source.example.test/models
    trust: 0.5
    kind_hint: model_release
    limit: 5
hn_ai_keywords:
  - ai
`);

  const previous = {
    generated_at: "2026-05-01T06:00:00.000Z",
    last_successful_generated_at: "2026-05-01T06:00:00.000Z",
    refresh_status: "ok",
    classification_mode: "fallback",
    window_hours: 36,
    source_total: 1,
    source_ok: 1,
    source_failed: 0,
    failed_sources: [],
    count: 1,
    clusters: [{ id: "existing", primary: { title: "Existing item" } }],
  };
  await fs.writeFile(path.join(publicDir, "feed.json"), JSON.stringify(previous, null, 2));

  await runPipeline({
    registryPath,
    publicDir,
    dataDir,
    now: new Date("2026-05-02T06:00:00.000Z"),
    env: { MAX_OUTPUT: "0" },
  });

  const feed = JSON.parse(await fs.readFile(path.join(publicDir, "feed.json"), "utf8"));
  assert.equal(feed.refresh_status, "failed");
  assert.equal(feed.count, 1);
  assert.deepEqual(feed.clusters, previous.clusters);
});

test("runPipeline writes source health and a successful daily archive", async () => {
  globalThis.fetch = async () => Response.json([{
    id: "org/model",
    downloads: 100,
    likes: 5,
    lastModified: "2026-05-02T05:00:00.000Z",
  }]);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chronicle-archive-"));
  const publicDir = path.join(root, "public");
  const dataDir = path.join(root, "data");
  const registryPath = path.join(root, "registry.yaml");
  await fs.mkdir(publicDir, { recursive: true });
  await fs.mkdir(path.join(publicDir, "daily/2026-05-01"), { recursive: true });
  await fs.writeFile(path.join(publicDir, "daily/2026-05-01/feed.json"), JSON.stringify({
    generated_at: "2026-05-01T06:00:00.000Z",
    count: 1,
    clusters: [{ primary: { title: "Previous archive item" } }],
  }));
  await fs.mkdir(path.join(publicDir, "daily/2026-04-30"), { recursive: true });
  await fs.writeFile(path.join(publicDir, "daily/2026-04-30/orphan.txt"), "keep until archive history is established");
  await fs.writeFile(registryPath, `
sources:
  - id: hf_models_test
    name: Models
    type: hf_models
    url: https://source.example.test/models
    trust: 0.5
    kind_hint: model_release
    limit: 5
hn_ai_keywords:
  - ai
`);

  await runPipeline({
    registryPath,
    publicDir,
    dataDir,
    now: new Date("2026-05-02T06:00:00.000Z"),
    env: {},
  });

  const feed = JSON.parse(await fs.readFile(path.join(publicDir, "feed.json"), "utf8"));
  assert.equal(feed.source_health[0].fresh_count, 1);
  assert.equal(feed.clusters[0].primary.published_at_source, "api_last_modified");
  assert.equal(feed.clusters[0].source_trail.length, 1);
  assert.equal(feed.top_news.length, 1);
  assert.equal(feed.top_news[0].enrichment_status, "metadata_only");

  const archived = JSON.parse(await fs.readFile(path.join(publicDir, "daily/2026-05-02/feed.json"), "utf8"));
  assert.equal(archived.generated_at, feed.generated_at);
  assert.deepEqual(archived.top_news, feed.top_news);
  const archiveIndex = JSON.parse(await fs.readFile(path.join(publicDir, "daily/index.json"), "utf8"));
  assert.equal(archiveIndex.days[0].date, "2026-05-02");
  assert.equal(archiveIndex.days[1].date, "2026-05-01");
  assert.match(await fs.readFile(path.join(publicDir, "sitemap.xml"), "utf8"), /chronicle\.tinycrafts\.ai\/daily\/2026-05-02\//);
  assert.match(await fs.readFile(path.join(publicDir, "sitemap.xml"), "utf8"), /chronicle\.tinycrafts\.ai\/daily\/2026-05-01\//);
  assert.match(await fs.readFile(path.join(publicDir, "robots.txt"), "utf8"), /Sitemap:/);
  assert.equal(await fileExists(path.join(publicDir, "daily/2026-04-30/orphan.txt")), true);
});

test("runPipeline classifies only preselected main feed candidates", async () => {
  const titles = [
    "Alpha routing benchmark improves agent planning",
    "Beacon dataset evaluates retrieval quality",
    "Cobalt inference system reduces serving latency",
    "Delta safety benchmark probes jailbreaks",
    "Ember model release improves token efficiency",
    "Falcon tool debugs RAG pipelines",
    "Granite tutorial explains vector search",
    "Harbor framework measures batch throughput",
    "Ion architecture accelerates multimodal training",
    "Jade evaluation suite checks agent memory",
    "Kepler method improves reasoning verification",
    "Lumen report compares open model inference",
  ];
  globalThis.fetch = async () => new Response(`
    <rss version="2.0"><channel>
      ${titles.map((title, index) => `
        <item>
          <title>${title}</title>
          <link>https://example.com/${index}</link>
          <pubDate>Sat, 02 May 2026 05:${String(index).padStart(2, "0")}:00 GMT</pubDate>
          <description>${title} with concrete AI engineering details.</description>
        </item>
      `).join("")}
    </channel></rss>
  `);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chronicle-preselect-"));
  const publicDir = path.join(root, "public");
  const dataDir = path.join(root, "data");
  const registryPath = path.join(root, "registry.yaml");
  await fs.mkdir(publicDir, { recursive: true });
  await fs.writeFile(registryPath, `
sources:
  - id: papers
    name: Papers
    type: rss
    url: https://source.example.test/feed
    trust: 0.9
    kind_hint: paper
    limit: 20
hn_ai_keywords:
  - ai
`);

  const classifiedBatchSizes: number[] = [];
  const provider: LlmProvider = {
    name: "groq",
    model: "test",
    batchDelayMs: 0,
    completeJson: async (request) => {
      if (request.schemaName !== "classification") {
        return { content: '{"items":[]}', provider: "groq", model: "test" };
      }
      const payload = JSON.parse(request.user.slice(request.user.indexOf("["))) as Array<{ index: number }>;
      classifiedBatchSizes.push(payload.length);
      return {
        content: JSON.stringify({
          items: payload.map((item) => ({
            index: item.index,
            kind: "paper",
            quality: "signal",
            one_liner: "Useful AI engineering result.",
          })),
        }),
        provider: "groq",
        model: "test",
      };
    },
  };

  await runPipeline({
    registryPath,
    publicDir,
    dataDir,
    now: new Date("2026-05-02T06:00:00.000Z"),
    env: { MAX_OUTPUT: "5" },
    providers: [provider],
  });

  const feed = JSON.parse(await fs.readFile(path.join(publicDir, "feed.json"), "utf8"));
  assert.equal(classifiedBatchSizes.length, 1);
  assert.ok(classifiedBatchSizes[0] < titles.length);
  assert.equal(classifiedBatchSizes[0], feed.count);
  assert.equal(feed.classification_mode, "llm");
});

test("runPipeline excludes old sitemap articles even when sitemap lastmod is fresh", async () => {
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
      <script type="application/ld+json">
        {"datePublished":"2026-03-25T12:00:00.000Z"}
      </script>
    `);
  };

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chronicle-old-sitemap-"));
  const publicDir = path.join(root, "public");
  const dataDir = path.join(root, "data");
  const registryPath = path.join(root, "registry.yaml");
  await fs.writeFile(registryPath, `
sources:
  - id: cursor
    name: Cursor
    type: sitemap
    url: https://cursor.example/sitemap.xml
    trust: 0.82
    kind_hint: company_announcement
    title_prefix: Cursor
    url_include:
      - cursor.example/blog/
    limit: 5
hn_ai_keywords:
  - ai
`);

  await runPipeline({
    registryPath,
    publicDir,
    dataDir,
    now: new Date("2026-05-02T22:40:00.000Z"),
    env: {},
  });

  const feed = JSON.parse(await fs.readFile(path.join(publicDir, "feed.json"), "utf8"));
  assert.equal(feed.count, 0);
  assert.equal(feed.clusters.length, 0);
});

function previousRoleFeed(role: "repo" | "learning", kindHint: "repo_release" | "video", title: string) {
  const primary = {
    id: `${role}-existing`,
    source_id: `${role}_test`,
    source_name: `${role} test`,
    source_role: role,
    trust: 0.8,
    kind_hint: kindHint,
    title,
    url: `https://example.com/${role}`,
    original_url: `https://example.com/${role}`,
    published_at: "2026-05-01T06:00:00.000Z",
    published_at_source: "feed",
    date_confidence: "high",
    ...(role === "repo"
      ? { repo: { full_name: "owner/repo", html_url: "https://github.com/owner/repo" } }
      : { learning: { provider: "YouTube", video_id: "abc123" } }),
  };
  return {
    generated_at: "2026-05-01T06:00:00.000Z",
    last_successful_generated_at: "2026-05-01T06:00:00.000Z",
    refresh_status: "ok",
    classification_mode: "deterministic",
    window_hours: 168,
    source_total: 1,
    source_ok: 1,
    source_failed: 0,
    failed_sources: [],
    source_health: [],
    count: 1,
    clusters: [{
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
      kind: kindHint,
      quality: "signal",
      one_liner: title,
      novelty: 1,
      trust: 0.8,
      score: 0.8,
    }],
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
