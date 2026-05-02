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
  };
  return {
    id: "x",
    primary,
    members: [primary],
    also_seen_on: [],
  };
}
