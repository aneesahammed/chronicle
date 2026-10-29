import assert from "node:assert/strict";
import test from "node:test";
import { evidenceQuality, instructionalIntent } from "./quality-policy.ts";
import type { Cluster } from "../types.ts";

test("learning intent excludes pricing and interviews despite technical language", () => {
  assert.equal(instructionalIntent("API credits, now in ChatGPT Pro and Business plans"), false);
  assert.equal(instructionalIntent("Building the future of legal work with AI | Legora CEO"), false);
  assert.equal(instructionalIntent("How to build an agent from scratch"), true);
  assert.equal(instructionalIntent("Gemini 4: what is next"), false);
});
test("repo quality needs documented usable metadata, not popularity", () => {
  const cluster = { primary: { published_at: "2026-10-29T00:00:00Z", repo: { stargazers_count: 100000, stars_today: 1000 } } } as Cluster;
  assert.equal(evidenceQuality(cluster, "repo_trending"), "mixed");
  Object.assign(cluster.primary.repo!, { has_readme: true, license: "MIT", description: "A documented evaluation harness for retrieval augmented generation.", pushed_at: "2026-10-20T00:00:00Z" });
  assert.equal(evidenceQuality(cluster, "repo_trending"), "signal");
  cluster.primary.repo!.license = "NOASSERTION";
  assert.equal(evidenceQuality(cluster, "repo_trending"), "mixed");
});
