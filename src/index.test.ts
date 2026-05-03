import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runPipeline } from "./index.ts";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
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
  - id: models
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
  await fs.writeFile(path.join(publicDir, "index.html"), "<!doctype html><title>Chronicle</title>");
  await fs.writeFile(registryPath, `
sources:
  - id: models
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
  assert.match(await fs.readFile(path.join(publicDir, "sitemap.xml"), "utf8"), /chronicle\.tinycrafts\.ai\/daily\/2026-05-02\//);
  assert.match(await fs.readFile(path.join(publicDir, "robots.txt"), "utf8"), /Sitemap:/);
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
