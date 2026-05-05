import type { Cluster, RawItem } from "../types.ts";

// Two-stage clustering:
//   1. Exact canonical URL match — same article from multiple feeds.
//   2. Title trigram Jaccard >= TITLE_THRESHOLD — paraphrased coverage.
//
// We avoid embeddings on purpose. They're a v2 problem. Trigrams catch
// "Anthropic launches Claude 4.7" / "Claude 4.7 released by Anthropic"
// well enough for v1, and the cost is zero.

const TITLE_THRESHOLD = 0.55;
const CLAIM_TITLE_THRESHOLD = 0.42;
const CLAIM_TOKEN_OVERLAP = 0.50;
const CLAIM_TOKEN_STRONG_OVERLAP = 0.60;
const MIN_SHARED_CLAIM_TOKENS = 4;

const STOPWORDS = new Set([
  "about", "after", "again", "against", "agent", "agents", "analysis", "and", "another",
  "are", "around", "artificial", "available", "based", "being", "best", "blog", "build",
  "building", "case", "chatbot", "could", "daily", "data", "deep", "does", "during",
  "for", "from", "generative", "gets", "guide", "have", "into", "large", "launch", "launches",
  "learn", "learning", "machine", "make", "makes", "making", "model", "models", "more",
  "news", "new", "open", "opens", "over", "paper", "part", "post", "release", "released",
  "releases", "research", "says", "should", "show", "shows", "study", "system", "systems",
  "than", "that", "the", "their", "this", "through", "using", "with", "without", "your",
]);

const ANCHOR_TOKENS = new Set([
  "ai21", "amazon", "anthropic", "apple", "bedrock", "claude", "cloudflare", "cohere",
  "cursor", "deepmind", "gemini", "github", "google", "groq", "huggingface", "langchain",
  "llama", "mistral", "nvidia", "openai", "perplexity", "qwen", "together", "vllm",
]);

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
  const signatures = stage1.map((c) => claimSignature(c));
  for (let i = 0; i < stage1.length; i++) {
    if (used.has(i)) continue;
    let cluster = stage1[i];
    for (let j = i + 1; j < stage1.length; j++) {
      if (used.has(j)) continue;
      const sim = jaccard(tris[i], tris[j]);
      if (sim >= TITLE_THRESHOLD || shouldMergeClaim(sim, signatures[i], signatures[j])) {
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
      title: m.title,
      url: m.url,
      published_at: m.published_at,
      published_at_source: m.published_at_source,
      date_confidence: m.date_confidence,
      discussion_url: m.discussion_url,
      discussion_source: m.discussion_source,
    }));
  return {
    id: primary.id,
    primary,
    members: sorted,
    source_trail: sorted.map((m) => ({
      source_id: m.source_id,
      source_name: m.source_name,
      title: m.title,
      url: m.url,
      published_at: m.published_at,
      published_at_source: m.published_at_source,
      date_confidence: m.date_confidence,
      discussion_url: m.discussion_url,
      discussion_source: m.discussion_source,
    })),
    also_seen_on,
  };
}

function mergeClusters(a: Cluster, b: Cluster): Cluster {
  // De-dup members by id.
  const all = new Map<string, RawItem>();
  for (const m of [...a.members, ...b.members]) all.set(m.id, m);
  return makeCluster([...all.values()]);
}

interface ClaimSignature {
  tokens: Set<string>;
  anchors: Set<string>;
}

function claimSignature(cluster: Cluster): ClaimSignature {
  const text = `${cluster.primary.title} ${cluster.primary.summary ?? ""}`;
  const tokens = importantTokens(text);
  return {
    tokens,
    anchors: new Set([...tokens].filter(isAnchorToken)),
  };
}

function shouldMergeClaim(
  titleSimilarity: number,
  a: ClaimSignature,
  b: ClaimSignature,
): boolean {
  if (!sharedAnchor(a, b)) return false;
  const shared = intersectionSize(a.tokens, b.tokens);
  if (shared < MIN_SHARED_CLAIM_TOKENS) return false;
  const overlap = shared / Math.max(1, Math.min(a.tokens.size, b.tokens.size));
  if (titleSimilarity >= CLAIM_TITLE_THRESHOLD && overlap >= CLAIM_TOKEN_OVERLAP) return true;
  return overlap >= CLAIM_TOKEN_STRONG_OVERLAP;
}

function importantTokens(text: string): Set<string> {
  const normalized = text
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/\b(show hn|ask hn|launch hn)\b/gi, " ")
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, " ");
  const tokens = normalized
    .split(/\s+/)
    .map((token) => normalizeClaimToken(token.replace(/^[.]+|[.]+$/g, "")))
    .filter((token) => token.length >= 3)
    .filter((token) => !STOPWORDS.has(token))
    .filter((token) => !/^\d+$/.test(token));
  return new Set(tokens.slice(0, 32));
}

function normalizeClaimToken(token: string): string {
  if (token.endsWith("ies") && token.length > 5) return `${token.slice(0, -3)}y`;
  if (token.endsWith("ing") && token.length > 6) return token.slice(0, -3);
  if (token.endsWith("ed") && token.length > 5) return token.slice(0, -2);
  if (token.endsWith("s") && token.length > 4) return token.slice(0, -1);
  return token;
}

function isAnchorToken(token: string): boolean {
  return ANCHOR_TOKENS.has(token)
    || /^(gpt|glm|qwen|llama|mistral|claude|gemini|deepseek|phi|v)\d/.test(token)
    || /\d/.test(token);
}

function sharedAnchor(a: ClaimSignature, b: ClaimSignature): boolean {
  for (const token of a.anchors) {
    if (b.anchors.has(token)) return true;
  }
  return false;
}

function intersectionSize(a: Set<string>, b: Set<string>): number {
  let count = 0;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  for (const token of small) {
    if (big.has(token)) count++;
  }
  return count;
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
