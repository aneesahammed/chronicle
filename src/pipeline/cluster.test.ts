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

test("clusterItems keeps unrelated titles separate", () => {
  const clusters = clusterItems([
    item("a", "A new attention kernel speeds up inference", "https://example.com/kernel"),
    item("b", "A robotics dataset ships with tactile sensors", "https://example.com/robotics"),
  ]);

  assert.equal(clusters.length, 2);
});

function item(
  id: string,
  title: string,
  url: string,
  source = "Source",
  trust = 0.5,
): RawItem {
  return {
    id,
    source_id: source.toLowerCase(),
    source_name: source,
    trust,
    title,
    url,
    original_url: url,
    published_at: "2026-05-02T00:00:00.000Z",
  };
}
