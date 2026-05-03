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
