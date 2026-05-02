import Parser from "rss-parser";
import { XMLParser } from "fast-xml-parser";
import { canonicalizeUrl, urlHash } from "../pipeline/canonicalize.ts";
import type { FetchResult, RawItem, Registry, SourceConfig, SourceFetchFailure } from "../types.ts";

const TIMEOUT_MS = 20_000;
const USER_AGENT = "chronicle/0.1 (+https://github.com/aneesahammed/chronicle)";
// rss-parser delegates to xml2js/sax-js, which does not dereference external
// entities. We still strip HTML from summaries before they enter the feed.
const rss = new Parser({ timeout: TIMEOUT_MS });
const xml = new XMLParser({ ignoreAttributes: true });

// ---- Generic RSS ----------------------------------------------------------
async function fetchRss(s: SourceConfig, kw: string[]): Promise<RawItem[]> {
  const feed = await withRetry(() => rss.parseURL(s.url));
  const items = (feed.items ?? []).slice(0, s.limit);
  return items
    .map((it) => normalize(s, {
      title: it.title ?? "",
      url: it.link ?? "",
      summary: stripHtml(it.contentSnippet ?? it.content ?? ""),
      published_at: it.isoDate ?? it.pubDate ?? new Date().toISOString(),
      discussion_url: s.id === "lobsters_ai" ? it.link ?? "" : undefined,
      discussion_source: s.id === "lobsters_ai" ? "Lobsters" : undefined,
    }))
    .filter(Boolean)
    .filter((it) => !s.ai_filter || isAiRelevant(it as RawItem, kw)) as RawItem[];
}

// ---- Hacker News (Algolia) ------------------------------------------------
async function fetchHN(s: SourceConfig, kw: string[]): Promise<RawItem[]> {
  const data = await fetchJson<{ hits: HnHit[] }>(s.url);
  const filtered = data.hits.filter((h) => {
    const t = (h.title ?? "").toLowerCase();
    if ((h.points ?? 0) < 50) return false;
    return kw.some((k) => t.includes(k.toLowerCase()));
  });
  return filtered.slice(0, s.limit).map((h) => {
    const discussion = `https://news.ycombinator.com/item?id=${h.objectID}`;
    const url = h.url || `https://news.ycombinator.com/item?id=${h.objectID}`;
    return normalize(s, {
      title: h.title ?? "",
      url,
      summary: "",
      published_at: h.created_at ?? new Date().toISOString(),
      discussion_url: discussion,
      discussion_source: "Hacker News",
      engagement: { score: h.points ?? 0, comments: h.num_comments ?? 0 },
    })!;
  });
}
interface HnHit {
  objectID: string;
  title?: string;
  url?: string;
  points?: number;
  num_comments?: number;
  created_at?: string;
}

// ---- Reddit ---------------------------------------------------------------
async function fetchReddit(s: SourceConfig): Promise<RawItem[]> {
  const data = await fetchJson<RedditListing>(s.url, {
    "user-agent": USER_AGENT,
  });
  const posts = (data.data?.children ?? []).map((c) => c.data);
  const filtered = posts.filter((p) => (p.score ?? 0) >= 25 && !p.stickied);
  return filtered.slice(0, s.limit).map((p) => {
    const external = p.url_overridden_by_dest && !p.url_overridden_by_dest.includes("reddit.com");
    const discussion = `https://www.reddit.com${p.permalink}`;
    const url = external
      ? p.url_overridden_by_dest!
      : discussion;
    return normalize(s, {
      title: p.title,
      url,
      summary: p.selftext ? p.selftext.slice(0, 400) : "",
      published_at: new Date((p.created_utc ?? 0) * 1000).toISOString(),
      discussion_url: discussion,
      discussion_source: s.name,
      engagement: { score: p.score, comments: p.num_comments },
    })!;
  });
}
interface RedditListing {
  data?: { children?: { data: RedditPost }[] };
}
interface RedditPost {
  title: string;
  url_overridden_by_dest?: string;
  permalink: string;
  selftext?: string;
  score?: number;
  num_comments?: number;
  created_utc?: number;
  stickied?: boolean;
}

// ---- HuggingFace daily papers --------------------------------------------
async function fetchHfPapers(s: SourceConfig): Promise<RawItem[]> {
  const data = await fetchJson<HfPaper[]>(s.url);
  return data.slice(0, s.limit).map((p) => {
    const arxivId = p.paper?.id ?? "";
    const url = arxivId
      ? `https://arxiv.org/abs/${arxivId}`
      : `https://huggingface.co/papers/${p.paper?.id ?? ""}`;
    return normalize(s, {
      title: p.title ?? p.paper?.title ?? "",
      url,
      summary: p.paper?.summary ?? "",
      published_at: p.publishedAt ?? new Date().toISOString(),
      engagement: { score: p.paper?.upvotes ?? 0 },
    })!;
  });
}
interface HfPaper {
  title?: string;
  publishedAt?: string;
  paper?: { id?: string; title?: string; summary?: string; upvotes?: number };
}

// ---- HuggingFace trending models -----------------------------------------
async function fetchHfModels(s: SourceConfig): Promise<RawItem[]> {
  const data = await fetchJson<HfModel[]>(s.url);
  return data.slice(0, s.limit).map((m) => normalize(s, {
    title: `${m.id} (${m.downloads ?? 0} downloads, ${m.likes ?? 0} likes)`,
    url: `https://huggingface.co/${m.id}`,
    summary: (m.tags ?? []).slice(0, 6).join(", "),
    published_at: m.lastModified ?? new Date().toISOString(),
    engagement: { score: m.likes ?? 0 },
  })!);
}
interface HfModel {
  id: string;
  downloads?: number;
  likes?: number;
  lastModified?: string;
  tags?: string[];
}

// ---- Sitemap --------------------------------------------------------------
async function fetchSitemap(s: SourceConfig, kw: string[]): Promise<RawItem[]> {
  const data = await fetchSitemapEntries(s.url);
  return data
    .filter((entry) => sourceUrlMatches(entry.loc, s))
    .sort((a, b) => timestamp(b.lastmod) - timestamp(a.lastmod))
    .slice(0, s.limit)
    .map((entry) => normalize(s, {
      title: titleFromUrl(entry.loc, s.title_prefix),
      url: entry.loc,
      summary: "",
      published_at: validDateOrFallback(entry.lastmod),
    }))
    .filter(Boolean)
    .filter((it) => !s.ai_filter || isAiRelevant(it as RawItem, kw)) as RawItem[];
}

async function fetchSitemapEntries(url: string, depth = 0): Promise<SitemapEntry[]> {
  if (depth > 1) return [];
  const text = await fetchText(url);
  const parsed = xml.parse(text) as SitemapDocument;
  const urls = asArray(parsed.urlset?.url)
    .map((entry) => ({
      loc: String(entry.loc ?? "").trim(),
      lastmod: entry.lastmod ? String(entry.lastmod) : undefined,
    }))
    .filter((entry) => entry.loc);

  if (urls.length > 0) return urls;

  const childSitemaps = asArray(parsed.sitemapindex?.sitemap)
    .map((entry) => String(entry.loc ?? "").trim())
    .filter(Boolean)
    .slice(0, 5);
  const nested = await Promise.all(childSitemaps.map((child) => fetchSitemapEntries(child, depth + 1)));
  return nested.flat();
}

interface SitemapDocument {
  urlset?: { url?: SitemapUrl | SitemapUrl[] };
  sitemapindex?: { sitemap?: SitemapUrl | SitemapUrl[] };
}
interface SitemapUrl {
  loc?: string;
  lastmod?: string;
}
interface SitemapEntry {
  loc: string;
  lastmod?: string;
}

// ---- Normalization --------------------------------------------------------
function normalize(
  s: SourceConfig,
  raw: {
    title: string;
    url: string;
    summary?: string;
    published_at: string;
    discussion_url?: string;
    discussion_source?: string;
    engagement?: RawItem["engagement"];
  },
): RawItem | null {
  if (!raw.title || !raw.url) return null;
  const canonical = canonicalizeUrl(raw.url);
  if (!canonical) return null;
  const discussion = raw.discussion_url ? canonicalizeUrl(raw.discussion_url) : "";
  return {
    id: urlHash(canonical),
    source_id: s.id,
    source_name: s.name,
    trust: s.trust,
    kind_hint: s.kind_hint,
    title: raw.title.trim().replace(/\s+/g, " "),
    url: canonical,
    original_url: raw.url,
    discussion_url: discussion || undefined,
    discussion_source: discussion ? raw.discussion_source : undefined,
    summary: raw.summary?.trim() || undefined,
    published_at: raw.published_at,
    engagement: raw.engagement,
  };
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 600);
}

function isAiRelevant(item: RawItem, kw: string[]): boolean {
  const text = ` ${item.title} ${item.summary ?? ""} `.toLowerCase();
  return kw.some((k) => text.includes(k.toLowerCase()));
}

async function fetchJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  return await withRetry(async () => {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`.trim());
    return (await r.json()) as T;
  });
}

async function fetchText(url: string): Promise<string> {
  return await withRetry(async () => {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "user-agent": USER_AGENT },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`.trim());
    return await r.text();
  });
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (attempt === 0) await sleep(500);
    }
  }
  throw last;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sourceUrlMatches(url: string, s: SourceConfig): boolean {
  const canonical = canonicalizeUrl(url);
  if (!canonical) return false;
  if (s.url_include?.length && !s.url_include.some((needle) => canonical.includes(needle))) {
    return false;
  }
  if (s.url_exclude?.some((needle) => canonical.includes(needle))) {
    return false;
  }
  return true;
}

function titleFromUrl(url: string, prefix?: string): string {
  const path = new URL(url).pathname;
  const slug = path.split("/").filter(Boolean).at(-1) ?? "update";
  const title = slug
    .replace(/\.(html|htm)$/i, "")
    .replace(/[-_]+/g, " ")
    .split(" ")
    .map(titleWord)
    .join(" ");
  return prefix ? `${prefix}: ${title}` : title;
}

function titleWord(word: string): string {
  const acronyms: Record<string, string> = {
    ai: "AI",
    api: "API",
    cli: "CLI",
    dpo: "DPO",
    gpt: "GPT",
    llm: "LLM",
    lora: "LoRA",
    mcp: "MCP",
    ml: "ML",
    rag: "RAG",
    rlhf: "RLHF",
    sdk: "SDK",
    swe: "SWE",
  };
  const lower = word.toLowerCase();
  return acronyms[lower] ?? lower.replace(/^\w/, (m) => m.toUpperCase());
}

function validDateOrFallback(value?: string): string {
  if (!value) return new Date().toISOString();
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString();
}

function timestamp(value?: string): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

// ---- Public API -----------------------------------------------------------
export async function fetchAll(reg: Registry): Promise<FetchResult> {
  const failed_sources: SourceFetchFailure[] = [];
  const tasks = reg.sources.map(async (s) => {
    try {
      switch (s.type) {
        case "rss":         return await fetchRss(s, reg.hn_ai_keywords);
        case "hn_algolia":  return await fetchHN(s, reg.hn_ai_keywords);
        case "reddit":      return await fetchReddit(s);
        case "hf_papers":   return await fetchHfPapers(s);
        case "hf_models":   return await fetchHfModels(s);
        case "sitemap":     return await fetchSitemap(s, reg.hn_ai_keywords);
      }
    } catch (e) {
      const message = (e as Error).message;
      console.warn(`[fetch] ${s.id} failed: ${message}`);
      failed_sources.push({ id: s.id, name: s.name, message });
      return [];
    }
  });
  const results = await Promise.all(tasks);
  return {
    items: results.flat(),
    source_total: reg.sources.length,
    source_ok: reg.sources.length - failed_sources.length,
    source_failed: failed_sources.length,
    failed_sources,
  };
}
