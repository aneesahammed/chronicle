import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

type ReaderStateApi = {
  prioritizeTopNews(items: any[], topNews: any[]): any[];
  clampIndex(index: number, total: number): number;
  itemKey(item: unknown): string;
  filterSignature(input: { learningTrack?: string; kinds?: string[]; highNovelty?: boolean; discussionOnly?: boolean }): string;
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


test("card reader includes Top News first, without repeating their clusters", async () => {
  const reader = await loadReaderState();
  const a = cluster("https://example.com/a", "Alpha"), b = cluster("https://example.com/b", "Beta");
  const news = [ { cluster_id: b.id, url: b.primary.url, title: "Beta", dek: "Beta brief" }, { cluster_id: "extra", url: "https://example.com/c", title: "Gamma" } ];
  const items = reader.prioritizeTopNews([a, b], news.concat(news[0]));
  assert.equal(items.length, 3);
  assert.equal(items[0].primary.title, "Beta");
  assert.equal(items[0].top_news.dek, "Beta brief");
  assert.equal(items[1].primary.title, "Gamma");
  assert.equal(items[2].primary.title, "Alpha");
  assert.equal((b as any).top_news, undefined);
});

test("Learning shelves have separate reader progress", async () => {
  const reader = await loadReaderState();
  assert.notEqual(reader.filterSignature({ learningTrack: "new" }), reader.filterSignature({ learningTrack: "foundations" }));
});
