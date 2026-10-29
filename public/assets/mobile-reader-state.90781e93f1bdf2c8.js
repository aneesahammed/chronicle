(function attachChronicleReaderState(global) {
  "use strict";

  const PREFIX = "chronicle-reader:v1";

  function clampIndex(index, total) {
    const count = Number(total) || 0;
    if (count <= 0) return 0;
    const value = Number.isFinite(Number(index)) ? Math.trunc(Number(index)) : 0;
    return Math.max(0, Math.min(count - 1, value));
  }

  function itemKey(item) {
    const primary = item && (item.primary || item);
    const url = stringOrEmpty(primary && (primary.canonical_url || primary.url || primary.original_url));
    if (url) return `url:${url}`;
    const id = stringOrEmpty(item && item.id);
    if (id) return `id:${id}`;
    const title = stringOrEmpty(primary && primary.title).toLowerCase().replace(/\s+/g, " ").trim();
    const published = stringOrEmpty(primary && primary.published_at);
    return `text:${title}|${published}`;
  }

  function prioritizeTopNews(items, topNews) {
    const result = [], seen = new Set();
    const add = (item) => { const key = itemKey(item); if (!seen.has(key)) { seen.add(key); result.push(item); } };
    for (const news of topNews || []) {
      const item = items.find(item => item.id === news.cluster_id || item.primary?.url === news.url);
      const fallback = { id: news.cluster_id, primary: { url: news.url, title: news.title, source_name: news.source_name, image_url: news.image_url, image_source: news.image_source, published_at: news.published_at }, kind: news.kind, score: news.score, one_liner: news.dek };
      add({ ...(item || fallback), top_news: news });
    }
    items.forEach(add);
    return result;
  }

  function filterSignature(input) {
    const kinds = Array.isArray(input && input.kinds) ? input.kinds.slice().sort() : [];
    const novelty = input && input.highNovelty ? "novelty:high" : "novelty:any";
    const discussion = input && input.discussionOnly ? "discussion:1" : "discussion:0";
    const parts = [novelty, discussion, `kinds:${kinds.join(",")}`];
    if (input?.learningTrack) parts.push(`track:${input.learningTrack}`);
    return parts.join("|");
  }

  function progressKey(day, tab, signature) {
    return [PREFIX, encodePart(day || "today"), encodePart(tab || "main"), encodePart(signature || "default")].join(":");
  }

  function restoreIndex(items, saved, fallbackIndex) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return 0;
    if (saved && saved.itemKey) {
      const match = list.findIndex((item) => itemKey(item) === saved.itemKey);
      if (match >= 0) return match;
    }
    if (saved && Number.isFinite(Number(saved.index))) return clampIndex(saved.index, list.length);
    return clampIndex(fallbackIndex, list.length);
  }

  function indexAfterFilterChange(previousKey, items, previousIndex) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return 0;
    if (previousKey) {
      const match = list.findIndex((item) => itemKey(item) === previousKey);
      if (match >= 0) return match;
    }
    return clampIndex(previousIndex, list.length);
  }

  function encodePart(value) {
    return encodeURIComponent(String(value)).replace(/%/g, "~");
  }

  function stringOrEmpty(value) {
    return typeof value === "string" ? value : "";
  }

  global.ChronicleReaderState = Object.freeze({
    PREFIX,
    prioritizeTopNews,
    clampIndex,
    itemKey,
    filterSignature,
    progressKey,
    restoreIndex,
    indexAfterFilterChange,
  });
})(globalThis);
