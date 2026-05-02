import type { Cluster, RawItem } from "../types.ts";

// Two-stage clustering:
//   1. Exact canonical URL match — same article from multiple feeds.
//   2. Title trigram Jaccard >= TITLE_THRESHOLD — paraphrased coverage.
//
// We avoid embeddings on purpose. They're a v2 problem. Trigrams catch
// "Anthropic launches Claude 4.7" / "Claude 4.7 released by Anthropic"
// well enough for v1, and the cost is zero.

const TITLE_THRESHOLD = 0.55;

export function clusterItems(items: RawItem[]): Cluster[] {
  // Stage 1: bucket by canonical URL.
  const byUrl = new Map<string, RawItem[]>();
  for (const it of items) {
    const list = byUrl.get(it.url) ?? [];
    list.push(it);
    byUrl.set(it.url, list);
  }
  const stage1: Cluster[] = [];
  for (const list of byUrl.values()) {
    stage1.push(makeCluster(list));
  }

  // Stage 2: merge clusters whose primary titles are similar.
  // O(n^2) — fine at ~300 items/day.
  const merged: Cluster[] = [];
  const used = new Set<number>();
  const tris = stage1.map((c) => trigrams(c.primary.title));
  for (let i = 0; i < stage1.length; i++) {
    if (used.has(i)) continue;
    let cluster = stage1[i];
    for (let j = i + 1; j < stage1.length; j++) {
      if (used.has(j)) continue;
      const sim = jaccard(tris[i], tris[j]);
      if (sim >= TITLE_THRESHOLD) {
        cluster = mergeClusters(cluster, stage1[j]);
        used.add(j);
      }
    }
    merged.push(cluster);
    used.add(i);
  }
  return merged;
}

function makeCluster(members: RawItem[]): Cluster {
  // Primary = highest trust, then highest engagement, then earliest published.
  const sorted = [...members].sort((a, b) => {
    if (b.trust !== a.trust) return b.trust - a.trust;
    const ae = a.engagement?.score ?? 0;
    const be = b.engagement?.score ?? 0;
    if (be !== ae) return be - ae;
    return a.published_at.localeCompare(b.published_at);
  });
  const primary = sorted[0];
  const also_seen_on = sorted
    .slice(1)
    .map((m) => ({
      source_name: m.source_name,
      url: m.url,
      discussion_url: m.discussion_url,
      discussion_source: m.discussion_source,
    }));
  return { id: primary.id, primary, members: sorted, also_seen_on };
}

function mergeClusters(a: Cluster, b: Cluster): Cluster {
  // De-dup members by id.
  const all = new Map<string, RawItem>();
  for (const m of [...a.members, ...b.members]) all.set(m.id, m);
  return makeCluster([...all.values()]);
}

// ---- Title similarity ----------------------------------------------------

function normalizeTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function trigrams(t: string): Set<string> {
  const s = normalizeTitle(t);
  if (s.length < 3) return new Set([s]);
  const padded = `  ${s}  `;
  const out = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) {
    out.add(padded.slice(i, i + 3));
  }
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  for (const t of small) if (big.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}
