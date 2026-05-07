import assert from "node:assert/strict";
import test from "node:test";
import {
  selectDiverseClusters,
  sourceFamily,
  sourceFamilyMix,
} from "./diversity.ts";
import type { RawItem, ScoredCluster } from "../types.ts";

test("sourceFamily groups arXiv categories together", () => {
  assert.equal(sourceFamily("arxiv_cl"), "arxiv");
  assert.equal(sourceFamily("arxiv_lg"), "arxiv");
  assert.equal(sourceFamily("r_localllama"), "discussion");
  assert.equal(sourceFamily("hn_ai"), "hacker_news");
});

test("selectDiverseClusters caps arXiv at 3 items when alternatives exist", () => {
  const arxiv = Array.from({ length: 20 }, (_, index) => scored({
    id: `arxiv-${index}`,
    source_id: index % 2 === 0 ? "arxiv_cl" : "arxiv_lg",
    source_name: index % 2 === 0 ? "arXiv cs.CL" : "arXiv cs.LG",
    score: 0.88 - index * 0.001,
  }));
  const alternatives = Array.from({ length: 20 }, (_, index) => scored({
    id: `alt-${index}`,
    source_id: `source_${index}`,
    source_name: `Source ${index}`,
    score: 0.70 - index * 0.001,
  }));

  const selected = withSilencedWarnings(() => selectDiverseClusters([...arxiv, ...alternatives], { maxOutput: 20 }));
  const mix = sourceFamilyMix(selected);

  assert.equal(selected.length, 20);
  assert.equal(mix.arxiv, 3);
});

test("selectDiverseClusters caps other families at 40 percent", () => {
  const reporting = Array.from({ length: 20 }, (_, index) => scored({
    id: `reporting-${index}`,
    source_id: index % 2 === 0 ? "techcrunch_ai" : "the_decoder",
    source_name: index % 2 === 0 ? "TechCrunch AI" : "The Decoder",
    score: 0.84 - index * 0.001,
  }));
  const alternatives = Array.from({ length: 20 }, (_, index) => scored({
    id: `alt-${index}`,
    source_id: `source_${index}`,
    source_name: `Source ${index}`,
    score: 0.70 - index * 0.001,
  }));

  const selected = withSilencedWarnings(() => selectDiverseClusters([...reporting, ...alternatives], { maxOutput: 20 }));
  const mix = sourceFamilyMix(selected);

  assert.equal(selected.length, 20);
  assert.equal(mix.reporting, 8);
});

test("selectDiverseClusters does not allow arXiv exceptional overflow", () => {
  const arxiv = Array.from({ length: 20 }, (_, index) => scored({
    id: `arxiv-${index}`,
    source_id: "arxiv_cl",
    source_name: "arXiv cs.CL",
    score: 0.92 - index * 0.001,
  }));
  const alternatives = Array.from({ length: 20 }, (_, index) => scored({
    id: `alt-${index}`,
    source_id: `source_${index}`,
    source_name: `Source ${index}`,
    score: 0.70 - index * 0.001,
  }));

  const selected = withSilencedWarnings(() => selectDiverseClusters([...arxiv, ...alternatives], { maxOutput: 20 }));
  const mix = sourceFamilyMix(selected);

  assert.equal(selected.length, 20);
  assert.equal(mix.arxiv, 3);
});

test("selectDiverseClusters allows a small exceptional overflow for non-arXiv families", () => {
  const reporting = Array.from({ length: 20 }, (_, index) => scored({
    id: `reporting-${index}`,
    source_id: index % 2 === 0 ? "techcrunch_ai" : "the_decoder",
    source_name: index % 2 === 0 ? "TechCrunch AI" : "The Decoder",
    score: 0.92 - index * 0.001,
  }));
  const alternatives = Array.from({ length: 20 }, (_, index) => scored({
    id: `alt-${index}`,
    source_id: `source_${index}`,
    source_name: `Source ${index}`,
    score: 0.70 - index * 0.001,
  }));

  const selected = withSilencedWarnings(() => selectDiverseClusters([...reporting, ...alternatives], { maxOutput: 20 }));
  const mix = sourceFamilyMix(selected);

  assert.equal(selected.length, 20);
  assert.equal(mix.reporting, 9);
});

test("selectDiverseClusters treats maxOutput as a maximum when only arXiv is available", () => {
  const arxiv = Array.from({ length: 20 }, (_, index) => scored({
    id: `arxiv-${index}`,
    source_id: "arxiv_cl",
    source_name: "arXiv cs.CL",
    score: 0.88 - index * 0.001,
  }));

  const selected = selectDiverseClusters(arxiv, { maxOutput: 20 });

  assert.equal(selected.length, 3);
});

test("selectDiverseClusters applies a light same-family score penalty", () => {
  const selected = selectDiverseClusters([
    scored({ id: "reporting-1", source_id: "techcrunch_ai", score: 0.800 }),
    scored({ id: "reporting-2", source_id: "the_decoder", score: 0.790 }),
    scored({ id: "hn", source_id: "hn_ai", score: 0.786 }),
  ], { maxOutput: 10 });

  assert.deepEqual(selected.map((item) => item.id), [
    "reporting-1",
    "hn",
    "reporting-2",
  ]);
});

test("sourceFamily warns once for unmapped sources", () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => {
    warnings.push(String(message));
  };
  try {
    assert.equal(sourceFamily("unmapped_source_for_test"), "unmapped_source_for_test");
    assert.equal(sourceFamily("unmapped_source_for_test"), "unmapped_source_for_test");
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /not mapped in source-family-config/);
});

function scored(overrides: Partial<RawItem> & { score?: number } = {}): ScoredCluster {
  const primary: RawItem = {
    id: overrides.id ?? "item",
    source_id: overrides.source_id ?? "source",
    source_name: overrides.source_name ?? "Source",
    trust: overrides.trust ?? 0.8,
    kind_hint: overrides.kind_hint,
    title: overrides.title ?? "Useful AI item",
    url: overrides.url ?? `https://example.com/${overrides.id ?? "item"}`,
    original_url: overrides.original_url ?? overrides.url ?? `https://example.com/${overrides.id ?? "item"}`,
    discussion_url: overrides.discussion_url,
    discussion_source: overrides.discussion_source,
    summary: overrides.summary,
    image_url: overrides.image_url,
    image_source: overrides.image_source,
    published_at: overrides.published_at ?? "2026-05-03T10:00:00.000Z",
    published_at_source: overrides.published_at_source ?? "feed",
    date_confidence: overrides.date_confidence ?? "high",
    engagement: overrides.engagement,
  };
  return {
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
    kind: "news",
    quality: "signal",
    one_liner: "Useful one liner.",
    novelty: 0.8,
    novelty_label: "high",
    trust: primary.trust,
    score: overrides.score ?? 0.72,
    why_this_surfaced: ["high novelty against the 30-day history"],
    builder_action: "Read the primary source.",
  };
}

function withSilencedWarnings<T>(fn: () => T): T {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.warn = originalWarn;
  }
}
