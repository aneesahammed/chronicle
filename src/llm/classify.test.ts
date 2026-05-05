import assert from "node:assert/strict";
import test from "node:test";
import { classifyClusters, classifyClustersDeterministically } from "./classify.ts";
import type { Cluster, RawItem } from "../types.ts";

test("classifyClusters falls back when no API key is configured", async () => {
  const result = await classifyClusters([cluster({
    title: "A benchmark for inference throughput",
    summary: "Introduces a benchmark for measuring LLM serving latency.",
  })]);

  assert.equal(result.mode, "fallback");
  assert.equal(result.items[0].kind, "paper");
  assert.equal(result.items[0].quality, "signal");
});

test("classifyClusters falls back when the LLM runner throws", async () => {
  const result = await classifyClusters([cluster({
    title: "A benchmark for inference throughput",
    summary: "Introduces a benchmark for measuring LLM serving latency.",
  })], [], async () => {
    throw new Error("rate limited");
  });

  assert.equal(result.mode, "fallback");
  assert.equal(result.items[0].quality, "signal");
});

test("fallback classifier does not mark every paper as signal", async () => {
  const result = await classifyClusters([cluster({
    title: "A narrow survey of chatbot preferences",
    summary: "A small collection of observations about chatbot user preferences.",
  })]);

  assert.equal(result.items[0].kind, "paper");
  assert.equal(result.items[0].quality, "mixed");
});

test("classifyClustersDeterministically scores LLM-eligible items without provider calls", () => {
  const result = classifyClustersDeterministically([cluster({
    title: "A benchmark for inference throughput",
    summary: "Introduces a benchmark for measuring LLM serving latency.",
  })]);

  assert.equal(result.mode, "fallback");
  assert.equal(result.items[0].kind, "paper");
  assert.equal(result.items[0].quality, "signal");
});

test("classifyClusters reads LLM JSON in item order", async () => {
  const result = await classifyClusters([
    cluster({ title: "A useful paper about inference" }),
    cluster({ title: "A mixed company update", kind_hint: "news" }),
  ], [], async (request) => {
    assert.equal(request.maxOutputTokens, 1536);
    assert.equal(request.schemaName, "classification");
    assert.match(request.system, /For papers, do not mark every fresh paper as signal/);
    const schema = request.schema as {
      properties: { items: { items: { properties: { kind: { enum: string[] } } } } };
    };
    assert.ok(schema.properties.items.items.properties.kind.enum.includes("paper"));
    assert.ok(!schema.properties.items.items.properties.kind.enum.includes("video"));
    return {
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
    };
  });

  assert.equal(result.mode, "llm");
  assert.equal(result.items[0].kind, "paper");
  assert.equal(result.items[0].one_liner, "Paper improves inference throughput.");
  assert.equal(result.items[1].kind, "news");
  assert.equal(result.items[1].quality, "mixed");
});

test("classifyClusters preserves mixed paper classifications from the LLM", async () => {
  const result = await classifyClusters([cluster({
    title: "A narrow survey of chatbot preferences",
    summary: "A small collection of observations about chatbot user preferences.",
  })], [], async () => ({
    content: JSON.stringify({
      items: [{
        index: 0,
        kind: "paper",
        quality: "mixed",
        one_liner: "Survey has limited direct builder signal.",
      }],
    }),
  }));

  assert.equal(result.mode, "llm");
  assert.equal(result.items[0].kind, "paper");
  assert.equal(result.items[0].quality, "mixed");
});

test("classifyClusters rejects non-LLM kind values from LLM output", async () => {
  const result = await classifyClusters([cluster({
    title: "OpenAI ships a model update",
    kind_hint: "company_announcement",
    summary: "New API behavior is available.",
  })], [], async () => ({
    content: JSON.stringify({
      items: [{
        index: 0,
        kind: "video",
        quality: "signal",
        one_liner: "Model update is available.",
      }],
    }),
  }));

  assert.equal(result.mode, "llm");
  assert.equal(result.items[0].kind, "company_announcement");
  assert.equal(result.items[0].quality, "mixed");
});

test("fallback one-liners decode greater-than entities", async () => {
  const result = await classifyClusters([cluster({
    title: "Qwen comparison",
    summary: "Qwen &gt; Llama for this synthetic benchmark.",
  })]);

  assert.equal(result.items[0].one_liner, "Qwen > Llama for this synthetic benchmark.");
});

test("fallback classifier demotes low-effort single-source discussion prompts", async () => {
  const result = await classifyClusters([cluster({
    source_id: "r_localllama",
    source_name: "r/LocalLLaMA",
    trust: 0.5,
    kind_hint: "discussion",
    title: "24gb vram to 48gb vram",
    summary: "I wanted to hear your experiences. Do you think there is a significant capability gain?",
  })]);

  assert.equal(result.items[0].quality, "hype");
});

test("classifyClusters skips LLM work for repo and learning kinds", async () => {
  let calls = 0;
  const result = await classifyClusters([
    cluster({
      source_role: "repo",
      kind_hint: "repo_release",
      title: "owner/repo v1.0.0",
      summary: "Adds faster inference.",
    }),
    cluster({
      source_role: "learning",
      kind_hint: "video",
      title: "Build agents",
      summary: "A practical agent tutorial.",
    }),
  ], [], async () => {
    calls++;
    throw new Error("should not be called");
  });

  assert.equal(calls, 0);
  assert.equal(result.mode, "deterministic");
  assert.equal(result.items[0].kind, "repo_release");
  assert.equal(result.items[0].quality, "signal");
  assert.equal(result.items[1].kind, "video");
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
