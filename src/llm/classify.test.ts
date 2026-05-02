import assert from "node:assert/strict";
import test from "node:test";
import { classifyClusters } from "./classify.ts";
import type { Cluster, RawItem } from "../types.ts";

test("classifyClusters falls back when no API key is configured", async () => {
  const result = await classifyClusters([cluster()], undefined);

  assert.equal(result.mode, "fallback");
  assert.equal(result.items[0].kind, "paper");
  assert.equal(result.items[0].quality, "mixed");
});

test("classifyClusters falls back when the LLM runner throws", async () => {
  const result = await classifyClusters([cluster()], "test-key", async () => {
    throw new Error("rate limited");
  });

  assert.equal(result.mode, "fallback");
  assert.equal(result.items[0].quality, "mixed");
});

function cluster(): Cluster {
  const primary: RawItem = {
    id: "x",
    source_id: "arxiv",
    source_name: "arXiv",
    trust: 0.9,
    kind_hint: "paper",
    title: "A useful paper about inference",
    url: "https://arxiv.org/abs/2401.12345",
    original_url: "https://arxiv.org/abs/2401.12345",
    published_at: "2026-05-02T00:00:00.000Z",
  };
  return {
    id: "x",
    primary,
    members: [primary],
    also_seen_on: [],
  };
}
