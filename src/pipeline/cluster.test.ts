import assert from "node:assert/strict";
import test from "node:test";
import { clusterItems } from "./cluster.ts";
import type { RawItem } from "../types.ts";

test("clusterItems merges exact canonical URL duplicates", () => {
  const clusters = clusterItems([
    item("a", "OpenAI releases a small model", "https://example.com/model", "HN", 0.6),
    item("b", "OpenAI releases a small model", "https://example.com/model", "OpenAI", 0.9),
  ]);

  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].members.length, 2);
  assert.equal(clusters[0].primary.source_name, "OpenAI");
});

test("clusterItems merges similar release titles", () => {
  const clusters = clusterItems([
    item("a", "Anthropic launches Claude 4.7 for coding", "https://a.example.com/claude"),
    item("b", "Anthropic launches Claude 4.7 coding model", "https://b.example.com/claude"),
  ]);

  assert.equal(clusters.length, 1);
});

test("clusterItems merges paraphrased claims with shared anchors", () => {
  const clusters = clusterItems([
    item(
      "a",
      "OpenAI adds streaming tool calls to the Realtime API",
      "https://a.example.com/realtime",
      "OpenAI",
      0.9,
      "Realtime API update adds streaming tool calls for voice agent workflows.",
    ),
    item(
      "b",
      "Realtime API now streams tool-use events for OpenAI voice agents",
      "https://b.example.com/openai-realtime",
      "Builder News",
      0.7,
      "OpenAI voice agents can receive streamed tool-use events through the Realtime API.",
    ),
  ]);

  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].members.length, 2);
});

test("clusterItems merges transitively regardless of input order", () => {
  // Regression: DiffusionGemma, 2026-06-11. The paraphrase (MarkTechPost)
  // claim-merged with the bridge title (Google Keyword) first, which froze
  // the bridge out of later comparisons — so the official DeepMind title
  // (0.82 similar to the bridge) stayed a separate cluster.
  const paraphrase = item(
    "m",
    "Google AI Releases DiffusionGemma, a 26B MoE Open Model Using Text Diffusion for High-Throughput Text Generation",
    "https://marktechpost.com/diffusiongemma",
    "MarkTechPost",
    0.6,
    "Google released DiffusionGemma, a 26 billion parameter MoE open model that uses text diffusion for high throughput text generation.",
  );
  const bridge = item(
    "k",
    "Google: DiffusionGemma: 4x faster text generation",
    "https://blog.google/diffusion-gemma",
    "Google AI on Keyword",
    0.9,
    "Google released DiffusionGemma, a 26B MoE open model with high throughput text diffusion.",
  );
  const official = item(
    "d",
    "DiffusionGemma: 4x faster text generation",
    "https://deepmind.google/blog/diffusiongemma",
    "Google DeepMind",
    0.9,
  );
  const aggregator = item(
    "r",
    "DiffusionGemma: 4x faster text generation",
    "https://old.reddit.com/r/LocalLLaMA/diffusiongemma",
    "r/LocalLLaMA",
    0.5,
  );

  const orders = [
    [paraphrase, bridge, official, aggregator],
    [official, aggregator, bridge, paraphrase],
    [bridge, paraphrase, aggregator, official],
  ];
  for (const order of orders) {
    const clusters = clusterItems(order);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].members.length, 4);
  }
});

test("clusterItems keeps unrelated titles separate", () => {
  const clusters = clusterItems([
    item("a", "A new attention kernel speeds up inference", "https://example.com/kernel"),
    item("b", "A robotics dataset ships with tactile sensors", "https://example.com/robotics"),
  ]);

  assert.equal(clusters.length, 2);
});

test("clusterItems does not merge generic claims without a shared anchor", () => {
  const clusters = clusterItems([
    item("a", "Benchmark improves agent planning with memory traces", "https://example.com/agent-memory"),
    item("b", "Vector index evaluation compares retrieval latency", "https://example.com/retrieval-traces"),
  ]);

  assert.equal(clusters.length, 2);
});

function item(
  id: string,
  title: string,
  url: string,
  source = "Source",
  trust = 0.5,
  summary?: string,
): RawItem {
  return {
    id,
    source_id: source.toLowerCase(),
    source_name: source,
    trust,
    title,
    url,
    original_url: url,
    summary,
    published_at: "2026-05-02T00:00:00.000Z",
    published_at_source: "feed",
    date_confidence: "high",
  };
}
