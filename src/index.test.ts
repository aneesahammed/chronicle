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
