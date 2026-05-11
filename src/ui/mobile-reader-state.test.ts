import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

type ReaderStateApi = {
  clampIndex(index: number, total: number): number;
  itemKey(item: unknown): string;
  filterSignature(input: { kinds?: string[]; highNovelty?: boolean; discussionOnly?: boolean }): string;
  progressKey(day: string, tab: string, signature: string): string;
  restoreIndex(items: unknown[], saved: { itemKey?: string; index?: number } | null, fallbackIndex?: number): number;
  indexAfterFilterChange(previousKey: string, items: unknown[], previousIndex: number): number;
};

test("mobile reader state preserves position by stable item key", async () => {
  const reader = await loadReaderState();
  const items = [
    cluster("https://example.com/a", "Alpha"),
    cluster("https://example.com/b", "Beta"),
    cluster("https://example.com/c", "Gamma"),
  ];
  const saved = { itemKey: reader.itemKey(items[1]), index: 1 };

  assert.equal(reader.restoreIndex(items, saved), 1);
  assert.equal(reader.indexAfterFilterChange(saved.itemKey, [items[0], items[2]], 1), 1);
  assert.equal(reader.restoreIndex(items, { index: 99 }), 2);
});

test("mobile reader progress key is scoped by day tab and filters", async () => {
  const reader = await loadReaderState();
  const signatureA = reader.filterSignature({ kinds: ["paper", "tool"], highNovelty: true, discussionOnly: false });
  const signatureB = reader.filterSignature({ kinds: ["tool", "paper"], highNovelty: true, discussionOnly: false });

  assert.equal(signatureA, signatureB);
  assert.match(reader.progressKey("2026-05-11", "repo", signatureA), /^chronicle-reader:v1:/);
  assert.notEqual(
    reader.progressKey("2026-05-11", "repo", signatureA),
    reader.progressKey("2026-05-11", "learning", signatureA),
  );
});

async function loadReaderState(): Promise<ReaderStateApi> {
  const source = await fs.readFile(path.resolve("public/mobile-reader-state.js"), "utf8");
  const sandbox: { globalThis: Record<string, unknown>; ChronicleReaderState?: ReaderStateApi } = { globalThis: {} };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: "mobile-reader-state.js" });
  assert.ok(sandbox.ChronicleReaderState);
  return sandbox.ChronicleReaderState;
}

function cluster(url: string, title: string) {
  return {
    id: title.toLowerCase(),
    primary: {
      url,
      original_url: `${url}?utm_source=test`,
      title,
      published_at: "2026-05-11T10:00:00.000Z",
    },
  };
}
