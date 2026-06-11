import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import type { Registry } from "../types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("arXiv RSS sources fetch at most three entries each", async () => {
  const registry = YAML.parse(
    await fs.readFile(path.join(__dirname, "registry.yaml"), "utf8"),
  ) as Registry;
  const arxivSources = registry.sources.filter((source) => source.id.startsWith("arxiv_"));

  assert.ok(arxivSources.length > 0);
  for (const source of arxivSources) {
    assert.equal(source.limit, 3, `${source.id} should not fetch more than 3 entries`);
  }
});

test("Philipp Schmid is registered as a high-trust Signal source", async () => {
  const registry = YAML.parse(
    await fs.readFile(path.join(__dirname, "registry.yaml"), "utf8"),
  ) as Registry;
  const source = registry.sources.find((candidate) => candidate.id === "philschmid");

  assert.ok(source, "philschmid source should be present");
  assert.equal(source.type, "rss");
  assert.equal(source.url, "https://www.philschmid.de/rss");
  assert.equal(source.source_role ?? "main", "main");
  assert.equal(source.kind_hint, "tutorial");
  assert.equal(source.ai_filter, true);
  assert.ok(source.trust >= 0.88, "Philipp Schmid should rank with high-trust AI builders");
});
