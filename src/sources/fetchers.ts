import Parser from "rss-parser";
import { XMLParser } from "fast-xml-parser";
import { canonicalizeUrl, urlHash } from "../pipeline/canonicalize.ts";
import type {
  DateConfidence,
  FetchResult,
  PublishedAtSource,
  RawItem,
  Registry,
  SourceConfig,
  SourceFetchFailure,
  SourceHealth,
} from "../types.ts";

const TIMEOUT_MS = 20_000;
const SITEMAP_PAGE_TIMEOUT_MS = 8_000;
const USER_AGENT = "Chronicle/0.1 by aneesahammed (+https://github.com/aneesahammed/chronicle)";
const SITEMAP_CHILD_LIMIT = 25;
const SITEMAP_CANDIDATE_MULTIPLIER = 8;
const SITEMAP_MIN_CANDIDATES = 40;
const UNKNOWN_PUBLISHED_AT = "1970-01-01T00:00:00.000Z";
// rss-parser delegates to xml2js/sax-js, which does not dereference external
// entities. We still strip HTML from summaries before they enter the feed.
const rss = new Parser({ timeout: TIMEOUT_MS });
const xml = new XMLParser({ ignoreAttributes: true });

// ---- Generic RSS ----------------------------------------------------------
async function fetchRss(s: SourceConfig, kw: string[]): Promise<RawItem[]> {
  const feed = await rss.parseString(await fetchText(s.url));
  const items = (feed.items ?? []).slice(0, s.limit);
  const isDiscussionFeed = s.id === "lobsters_ai" || s.id.startsWith("r_");
  return items
    .map((it) => normalize(s, {
      title: it.title ?? "",
      url: it.link ?? "",
      summary: stripHtml(it.contentSnippet ?? it.content ?? ""),
      published_at: it.isoDate ?? it.pubDate ?? UNKNOWN_PUBLISHED_AT,
      published_at_source: it.isoDate || it.pubDate ? "feed" : "generated_fallback",
      date_confidence: it.isoDate || it.pubDate ? "high" : "low",
      discussion_url: isDiscussionFeed ? it.link ?? "" : undefined,
      discussion_source: isDiscussionFeed ? s.name : undefined,
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
      published_at: h.created_at ?? UNKNOWN_PUBLISHED_AT,
      published_at_source: h.created_at ? "api" : "generated_fallback",
      date_confidence: h.created_at ? "high" : "low",
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
    "Accept": "application/json",
    "User-Agent": USER_AGENT,
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
      published_at_source: p.created_utc ? "api" : "generated_fallback",
      date_confidence: p.created_utc ? "high" : "low",
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
      published_at: p.publishedAt ?? UNKNOWN_PUBLISHED_AT,
      published_at_source: p.publishedAt ? "api" : "generated_fallback",
      date_confidence: p.publishedAt ? "high" : "low",
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
  return data.slice(0, s.limit).map((m) => {
    const published = m.createdAt ?? m.lastModified;
    return normalize(s, {
      title: `${m.id} (${m.downloads ?? 0} downloads, ${m.likes ?? 0} likes)`,
      url: `https://huggingface.co/${m.id}`,
      summary: (m.tags ?? []).slice(0, 6).join(", "),
      published_at: published ?? UNKNOWN_PUBLISHED_AT,
      published_at_source: m.createdAt ? "api" : m.lastModified ? "api_last_modified" : "generated_fallback",
      date_confidence: m.createdAt ? "high" : m.lastModified ? "medium" : "low",
      engagement: { score: m.likes ?? 0 },
    })!;
  });
}
interface HfModel {
  id: string;
  downloads?: number;
  likes?: number;
  lastModified?: string;
  createdAt?: string;
  tags?: string[];
}

// ---- Sitemap --------------------------------------------------------------
async function fetchSitemap(s: SourceConfig, kw: string[]): Promise<RawItem[]> {
  const data = await fetchSitemapEntries(s.url);
  const candidateLimit = Math.max(s.limit * SITEMAP_CANDIDATE_MULTIPLIER, SITEMAP_MIN_CANDIDATES);
  const candidates = data
    .filter((entry) => sourceUrlMatches(entry.loc, s))
    .sort((a, b) => timestamp(b.lastmod) - timestamp(a.lastmod))
    .slice(0, candidateLimit);

  const pages = await mapLimit(candidates, 4, async (entry) => ({
    entry,
    details: await fetchPageDetails(entry.loc),
  }));

  return pages
    .map(({ entry, details }) => {
      const hasPageDate = Boolean(details.published_at);
      const hasSitemapDate = Boolean(entry.lastmod);
      return normalize(s, {
        title: titleWithPrefix(details.title ?? titleFromUrl(entry.loc), s.title_prefix),
        url: entry.loc,
        summary: details.description ?? "",
        published_at: validDateOrFallback(details.published_at ?? entry.lastmod),
        published_at_source: hasPageDate
          ? "page_metadata"
          : hasSitemapDate
            ? "sitemap_lastmod"
            : "generated_fallback",
        date_confidence: hasPageDate ? "high" : hasSitemapDate ? "medium" : "low",
      });
    })
    .filter(Boolean)
    .sort((a, b) => timestamp((b as RawItem).published_at) - timestamp((a as RawItem).published_at))
    .slice(0, s.limit)
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
    .slice(0, SITEMAP_CHILD_LIMIT);
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

interface PageDetails {
  title?: string;
  description?: string;
  published_at?: string;
}

async function fetchPageDetails(url: string): Promise<PageDetails> {
  try {
    const html = await fetchPageText(url);
    return {
      title: extractTitle(html),
      description: extractMetaContent(html, [
        "description",
        "og:description",
        "twitter:description",
      ]),
      published_at: extractPublishedDate(html),
    };
  } catch (e) {
    console.warn(`[sitemap] could not inspect ${url}: ${(e as Error).message}`);
    return {};
  }
}

async function fetchPageText(url: string): Promise<string> {
  const r = await fetch(url, {
    signal: AbortSignal.timeout(SITEMAP_PAGE_TIMEOUT_MS),
    headers: { "user-agent": USER_AGENT },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`.trim());
  return await r.text();
}

// ---- Normalization --------------------------------------------------------
function normalize(
  s: SourceConfig,
  raw: {
    title: string;
    url: string;
    summary?: string;
    published_at: string;
    published_at_source: PublishedAtSource;
    date_confidence: DateConfidence;
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
    published_at_source: raw.published_at_source,
    date_confidence: raw.date_confidence,
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
  return titleWithPrefix(title, prefix);
}

function titleWithPrefix(title: string, prefix?: string): string {
  const clean = title
    .replace(/\s+[·|-]\s+.*$/u, "")
    .trim();
  if (!prefix) return clean;
  return clean.toLowerCase().startsWith(prefix.toLowerCase())
    ? clean
    : `${prefix}: ${clean}`;
}

function extractTitle(html: string): string | undefined {
  const metaTitle = extractMetaContent(html, ["og:title", "twitter:title"]);
  const rawTitle = metaTitle ?? matchFirst(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  return rawTitle ? decodeHtml(rawTitle).replace(/\s+/g, " ").trim() : undefined;
}

function extractPublishedDate(html: string): string | undefined {
  const candidates = [
    extractJsonDate(html, "datePublished"),
    extractMetaContent(html, [
      "article:published_time",
      "datePublished",
      "date",
      "publish_date",
      "pubdate",
      "sailthru.date",
    ]),
    matchTimeDatetime(html),
    matchVisibleDate(html),
  ];

  for (const candidate of candidates) {
    const valid = isoDate(candidate);
    if (valid) return valid;
  }
  return undefined;
}

function extractJsonDate(html: string, key: string): string | undefined {
  return matchFirst(html, new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`, "i"));
}

function extractMetaContent(html: string, names: string[]): string | undefined {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const metaTags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of metaTags) {
    const name =
      attr(tag, "property") ??
      attr(tag, "name") ??
      attr(tag, "itemprop");
    if (!name || !wanted.has(name.toLowerCase())) continue;
    const content = attr(tag, "content");
    if (content) return decodeHtml(content);
  }
  return undefined;
}

function matchTimeDatetime(html: string): string | undefined {
  const timeTags = html.match(/<time\b[^>]*>/gi) ?? [];
  for (const tag of timeTags) {
    const datetime = attr(tag, "datetime");
    if (datetime) return decodeHtml(datetime);
  }
  return undefined;
}

function matchVisibleDate(html: string): string | undefined {
  return matchFirst(
    html,
    /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},\s+\d{4}\b/i,
  );
}

function attr(tag: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = tag.match(new RegExp(`\\b${escaped}\\s*=\\s*(["'])(.*?)\\1`, "i"));
  return match?.[2];
}

function matchFirst(value: string, pattern: RegExp): string | undefined {
  return value.match(pattern)?.[1];
}

function isoDate(value?: string): string | undefined {
  if (!value) return undefined;
  const ms = Date.parse(decodeHtml(value).trim());
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, " ");
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
  if (!value) return UNKNOWN_PUBLISHED_AT;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : UNKNOWN_PUBLISHED_AT;
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

async function mapLimit<T, U>(
  values: T[],
  limit: number,
  mapper: (value: T) => Promise<U>,
): Promise<U[]> {
  const out: U[] = [];
  for (let i = 0; i < values.length; i += limit) {
    out.push(...await Promise.all(values.slice(i, i + limit).map(mapper)));
  }
  return out;
}

// ---- Public API -----------------------------------------------------------
export async function fetchAll(reg: Registry): Promise<FetchResult> {
  const tasks = reg.sources.map(async (s) => {
    try {
      let items: RawItem[] = [];
      switch (s.type) {
        case "rss":         items = await fetchRss(s, reg.hn_ai_keywords); break;
        case "hn_algolia":  items = await fetchHN(s, reg.hn_ai_keywords); break;
        case "reddit":      items = await fetchReddit(s); break;
        case "hf_papers":   items = await fetchHfPapers(s); break;
        case "hf_models":   items = await fetchHfModels(s); break;
        case "sitemap":     items = await fetchSitemap(s, reg.hn_ai_keywords); break;
      }
      return {
        items,
        failed_source: null,
        health: sourceHealth(s, "ok", items.length),
      };
    } catch (e) {
      const message = (e as Error).message;
      console.warn(`[fetch] ${s.id} failed: ${message}`);
      return {
        items: [],
        failed_source: { id: s.id, name: s.name, message },
        health: sourceHealth(s, "failed", 0, message),
      };
    }
  });
  const results = await Promise.all(tasks);
  const failed_sources = results
    .map((result) => result.failed_source)
    .filter(Boolean) as SourceFetchFailure[];
  return {
    items: results.flatMap((result) => result.items),
    source_total: reg.sources.length,
    source_ok: reg.sources.length - failed_sources.length,
    source_failed: failed_sources.length,
    failed_sources,
    source_health: results.map((result) => result.health),
  };
}

function sourceHealth(
  source: SourceConfig,
  status: SourceHealth["status"],
  fetchedCount: number,
  message?: string,
): SourceHealth {
  return {
    id: source.id,
    name: source.name,
    status,
    fetched_count: fetchedCount,
    ...(message ? { message } : {}),
  };
}
