import assert from "node:assert/strict";
import test from "node:test";
import { classifyClusters } from "./classify.ts";
import type { Cluster, RawItem } from "../types.ts";

test("classifyClusters falls back when no API key is configured", async () => {
  const result = await classifyClusters([cluster()], undefined);

  assert.equal(result.mode, "fallback");
  assert.equal(result.items[0].kind, "paper");
  assert.equal(result.items[0].quality, "signal");
});

test("classifyClusters falls back when the LLM runner throws", async () => {
  const result = await classifyClusters([cluster()], "test-key", async () => {
    throw new Error("rate limited");
  });

  assert.equal(result.mode, "fallback");
  assert.equal(result.items[0].quality, "signal");
});

test("classifyClusters reads Groq chat completion JSON in item order", async () => {
  const result = await classifyClusters([
    cluster({ title: "A useful paper about inference" }),
    cluster({ title: "A mixed company update", kind_hint: "news" }),
  ], "test-key", async (request) => {
    assert.equal(request.model, "qwen/qwen3-32b");
    assert.equal(request.response_format.type, "json_object");
    return {
      choices: [{
        message: {
          content: JSON.stringify({
            items: [
              {
                index: 1,
                kind: "news",
                quality: "mixed",
                one_liner: "Company update with some useful context.",
              },
              {
                index: 0,
                kind: "paper",
                quality: "signal",
                one_liner: "Paper improves inference throughput.",
              },
            ],
          }),
        },
      }],
    };
  });

  assert.equal(result.mode, "llm");
  assert.equal(result.items[0].kind, "paper");
  assert.equal(result.items[0].one_liner, "Paper improves inference throughput.");
  assert.equal(result.items[1].kind, "news");
  assert.equal(result.items[1].quality, "mixed");
});

test("fallback classifier demotes low-effort single-source discussion prompts", async () => {
  const result = await classifyClusters([cluster({
    source_id: "r_localllama",
    source_name: "r/LocalLLaMA",
    trust: 0.5,
    kind_hint: "discussion",
    title: "24gb vram to 48gb vram",
    summary: "I wanted to hear your experiences. Do you think there is a significant capability gain?",
  })], undefined);

  assert.equal(result.items[0].quality, "hype");
});

function cluster(overrides: Partial<RawItem> = {}): Cluster {
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
    published_at_source: "feed",
    date_confidence: "high",
    ...overrides,
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
