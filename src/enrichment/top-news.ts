import { promises as fs } from "node:fs";
import path from "node:path";
import { sanitizeImageUrl } from "./images.ts";
import type { EnrichmentStatus, Kind, ScoredCluster, TopNewsItem } from "../types.ts";

export const TOP_NEWS_LIMIT = 5;
export const TOP_NEWS_INPUT_CHARS = 900;
export const TOP_NEWS_TIMEOUT_MS = 15_000;

const CACHE_VERSION = 1;
const MAX_CACHE_ENTRIES = 500;
const OK_CACHE_TTL_MS = 30 * 864e5;
const RETRY_AFTER_MS = 24 * 36e5;
const GROQ_CHAT_COMPLETIONS_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "qwen/qwen3-32b";
const PREFERRED_KINDS = new Set<Kind>(["news", "company_announcement", "model_release", "tool", "paper"]);

interface EnrichmentCacheFile {
  version: 1;
  entries: Record<string, CachedEnrichment>;
}

interface CachedEnrichment {
  url: string;
  title: string;
  source_name: string;
  dek: string;
  brief: string;
  image_url?: string;
  image_alt?: string;
  image_source?: string;
  status: EnrichmentStatus;
  attempted_at: string;
  enriched_at?: string;
  failure_count: number;
}

interface EnrichmentDraft {
  candidate: ScoredCluster;
  metadata: MetadataFallback;
  reader_text?: string;
  failed: boolean;
}

interface MetadataFallback {
  dek: string;
  brief: string;
  image_url?: string;
  image_source?: string;
}

interface SummaryInput {
  index: number;
  title: string;
  source_name: string;
  url: string;
  current_summary: string;
  reader_text: string;
}

interface SummaryOutput {
  index: number;
  dek: string;
  brief: string;
  image_alt?: string;
}

type FetchLike = typeof fetch;
type SummaryRunner = (items: SummaryInput[], apiKey: string) => Promise<SummaryOutput[]>;

export interface BuildTopNewsOptions {
  now: Date;
  cachePath: string;
  env: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  summarize?: SummaryRunner;
}

export async function buildTopNews(
  scored: ScoredCluster[],
  options: BuildTopNewsOptions,
): Promise<TopNewsItem[]> {
  const candidates = selectTopNewsCandidates(scored);
  if (candidates.length === 0) return [];

  const nowIso = options.now.toISOString();
  const cache = await loadEnrichmentCache(options.cachePath);
  const topNews: TopNewsItem[] = [];
  const drafts: EnrichmentDraft[] = [];
  const fetchImpl = options.fetchImpl ?? fetch;

  for (const candidate of candidates) {
    const cached = cache.entries[candidate.primary.url];
    if (cached && shouldUseCached(cached, options.now)) {
      topNews.push(topNewsFromCache(candidate, cached, nowIso));
      continue;
    }
    if (cached && shouldThrottleRetry(cached, options.now)) {
      topNews.push(topNewsFromCache(candidate, cached, nowIso));
      continue;
    }

    const metadata = fallbackFor(candidate);
    const draft: EnrichmentDraft = { candidate, metadata, failed: false };
    if (options.env.GROQ_API_KEY || options.summarize) {
      try {
        draft.reader_text = await fetchJinaReaderText(candidate.primary.url, {
          apiKey: options.env.JINA_API_KEY,
          fetchImpl,
        });
      } catch (error) {
        draft.failed = true;
        console.warn(`[top-news] Jina Reader failed for ${candidate.primary.url}: ${(error as Error).message}`);
      }
    }
    drafts.push(draft);
  }

  const summaryInputs = drafts
    .map((draft, index) => draft.reader_text ? summaryInput(draft, index) : null)
    .filter(Boolean) as SummaryInput[];
  const summaries = new Map<number, SummaryOutput>();
  if (summaryInputs.length > 0 && (options.env.GROQ_API_KEY || options.summarize)) {
    try {
      const runner = options.summarize ?? summarizeWithGroq;
      for (const item of await runner(summaryInputs, options.env.GROQ_API_KEY ?? "")) {
        summaries.set(item.index, item);
      }
    } catch (error) {
      console.warn(`[top-news] Groq summary failed: ${(error as Error).message}`);
      drafts.forEach((draft) => {
        if (draft.reader_text) draft.failed = true;
      });
    }
  }

  for (const draft of drafts) {
    const summary = summaries.get(drafts.indexOf(draft));
    const item = topNewsFromDraft(draft, summary, nowIso);
    topNews.push(item);
    cache.entries[draft.candidate.primary.url] = cacheEntryFromItem(
      item,
      draft.candidate,
      draft.failed || item.enrichment_status !== "ok",
      cache.entries[draft.candidate.primary.url],
    );
  }

  try {
    await saveEnrichmentCache(options.cachePath, pruneCache(cache));
  } catch (error) {
    console.warn(`[top-news] could not write enrichment cache: ${(error as Error).message}`);
  }
  return topNews.slice(0, TOP_NEWS_LIMIT);
}

export function selectTopNewsCandidates(scored: ScoredCluster[]): ScoredCluster[] {
  const selected: ScoredCluster[] = [];
  const perSource = new Map<string, number>();
  const titleFingerprints: Set<string>[] = [];

  for (const item of scored) {
    if (!isEligibleTopNews(item)) continue;
    const sourceId = item.primary.source_id;
    if ((perSource.get(sourceId) ?? 0) >= 2) continue;
    const fingerprint = titleWords(item.primary.title);
    if (titleFingerprints.some((existing) => jaccard(existing, fingerprint) >= 0.55)) continue;
    selected.push(item);
    perSource.set(sourceId, (perSource.get(sourceId) ?? 0) + 1);
    titleFingerprints.push(fingerprint);
    if (selected.length >= TOP_NEWS_LIMIT) break;
  }

  return selected;
}

function isEligibleTopNews(item: ScoredCluster): boolean {
  if (item.quality === "hype") return false;
  if (!isHttpsUrl(item.primary.url)) return false;
  if (PREFERRED_KINDS.has(item.kind)) return true;
  if (item.kind !== "discussion") return false;
  if (isDiscussionUrl(item.primary.url)) return false;
  return item.score >= 0.55 || item.novelty >= 0.7;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isDiscussionUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.replace(/^www\./, "");
    return host === "news.ycombinator.com"
      || host.endsWith("reddit.com")
      || host === "lobste.rs";
  } catch {
    return true;
  }
}

export function readerUrlFor(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Reader URL must wrap an http(s) URL");
  }
  parsed.hash = "";
  return `https://r.jina.ai/${parsed.toString()}`;
}

async function fetchJinaReaderText(
  url: string,
  options: { apiKey?: string; fetchImpl: FetchLike },
): Promise<string> {
  const headers: Record<string, string> = {
    "Accept": "text/plain",
  };
  if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;
  const response = await options.fetchImpl(readerUrlFor(url), {
    headers,
    signal: AbortSignal.timeout(TOP_NEWS_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
  const text = await response.text();
  return text.replace(/\s+/g, " ").trim().slice(0, TOP_NEWS_INPUT_CHARS);
}

function summaryInput(draft: EnrichmentDraft, index: number): SummaryInput {
  return {
    index,
    title: draft.candidate.primary.title,
    source_name: draft.candidate.primary.source_name,
    url: draft.candidate.primary.url,
    current_summary: draft.metadata.brief,
    reader_text: (draft.reader_text ?? "").slice(0, TOP_NEWS_INPUT_CHARS),
  };
}

async function summarizeWithGroq(items: SummaryInput[], apiKey: string): Promise<SummaryOutput[]> {
  const body = {
    model: GROQ_MODEL,
    temperature: 0,
    max_completion_tokens: 1200,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          "You write compact AI news briefs for experienced builders.",
          "Return only JSON. Do not quote long source text.",
          "Summaries must be factual, plain English, and non-marketing.",
        ].join(" "),
      },
      {
        role: "user",
        content: [
          "For each item, write:",
          "- dek: one sentence, <= 180 chars",
          "- brief: one or two short paragraphs, <= 420 chars total",
          "- image_alt: <= 120 chars, if an image is likely useful",
          "",
          "Return shape:",
          '{"items":[{"index":0,"dek":"...","brief":"...","image_alt":"..."}]}',
          "",
          JSON.stringify(items, null, 2),
        ].join("\n"),
      },
    ],
  };
  try {
    return parseSummaryContent(await fetchGroqSummary(apiKey, body));
  } catch (error) {
    if (!isGroqJsonValidationError(error)) throw error;
    console.warn("[top-news] Groq JSON mode validation failed; retrying without response_format");
    return parseSummaryContent(await fetchGroqSummary(apiKey, withoutResponseFormat(body)));
  }
}

async function fetchGroqSummary(
  apiKey: string,
  body: Record<string, unknown>,
): Promise<string> {
  const response = await fetch(GROQ_CHAT_COMPLETIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Groq returned non-JSON response (${response.status})`);
  }
  if (!response.ok) {
    const message = isRecord(data) && isRecord(data.error) && typeof data.error.message === "string"
      ? data.error.message
      : "unknown error";
    throw new Error(`Groq request failed (${response.status}): ${message}`);
  }
  return isRecord(data)
    && Array.isArray(data.choices)
    && isRecord(data.choices[0])
    && isRecord(data.choices[0].message)
    && typeof data.choices[0].message.content === "string"
    ? data.choices[0].message.content
    : "";
}

function isGroqJsonValidationError(error: unknown): boolean {
  const message = (error as Error).message?.toLowerCase?.() ?? "";
  return message.includes("validate json") || message.includes("failed_generation");
}

function withoutResponseFormat<T extends Record<string, unknown>>(body: T): T {
  const { response_format: _responseFormat, ...rest } = body;
  return rest as T;
}

function parseSummaryContent(content: string): SummaryOutput[] {
  const parsed = parseJsonFromContent(content);
  if (!isRecord(parsed) || !Array.isArray(parsed.items)) {
    throw new Error("invalid top news summary JSON");
  }
  return parsed.items.flatMap((item) => {
    if (!isRecord(item) || typeof item.index !== "number") return [];
    const dek = clampText(item.dek, 180);
    const brief = clampText(item.brief, 420);
    if (!dek || !brief) return [];
    const imageAlt = clampText(item.image_alt, 120);
    return [{
      index: item.index,
      dek,
      brief,
      ...(imageAlt ? { image_alt: imageAlt } : {}),
    }];
  });
}

function parseJsonFromContent(content: string): unknown {
  const trimmed = content.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("top news summary response was not JSON");
  }
}

function topNewsFromDraft(
  draft: EnrichmentDraft,
  summary: SummaryOutput | undefined,
  nowIso: string,
): TopNewsItem {
  const metadata = draft.metadata;
  const image = sanitizeImageUrl(metadata.image_url);
  const status: EnrichmentStatus = summary && !draft.failed ? "ok" : "metadata_only";
  return {
    cluster_id: draft.candidate.id,
    title: draft.candidate.primary.title,
    url: draft.candidate.primary.url,
    source_name: draft.candidate.primary.source_name,
    published_at: draft.candidate.primary.published_at,
    kind: draft.candidate.kind,
    score: draft.candidate.score,
    dek: summary?.dek ?? metadata.dek,
    brief: summary?.brief ?? metadata.brief,
    ...(image ? { image_url: image } : {}),
    ...(summary?.image_alt ? { image_alt: summary.image_alt } : {}),
    ...(image && metadata.image_source ? { image_source: metadata.image_source } : {}),
    enrichment_status: status,
    enriched_at: nowIso,
  };
}

function topNewsFromCache(candidate: ScoredCluster, cached: CachedEnrichment, nowIso: string): TopNewsItem {
  const image = sanitizeImageUrl(cached.image_url);
  return {
    cluster_id: candidate.id,
    title: candidate.primary.title,
    url: candidate.primary.url,
    source_name: candidate.primary.source_name,
    published_at: candidate.primary.published_at,
    kind: candidate.kind,
    score: candidate.score,
    dek: cached.dek || fallbackFor(candidate).dek,
    brief: cached.brief || fallbackFor(candidate).brief,
    ...(image ? { image_url: image } : {}),
    ...(cached.image_alt ? { image_alt: cached.image_alt } : {}),
    ...(image && cached.image_source ? { image_source: cached.image_source } : {}),
    enrichment_status: cached.status === "failed" ? "metadata_only" : cached.status,
    enriched_at: cached.enriched_at ?? cached.attempted_at ?? nowIso,
  };
}

function cacheEntryFromItem(
  item: TopNewsItem,
  candidate: ScoredCluster,
  failed: boolean,
  previous: CachedEnrichment | undefined,
): CachedEnrichment {
  return {
    url: item.url,
    title: item.title,
    source_name: item.source_name,
    dek: item.dek,
    brief: item.brief,
    ...(item.image_url ? { image_url: item.image_url } : {}),
    ...(item.image_alt ? { image_alt: item.image_alt } : {}),
    ...(item.image_source ? { image_source: item.image_source } : {}),
    status: failed ? "failed" : item.enrichment_status,
    attempted_at: item.enriched_at,
    ...(item.enrichment_status !== "failed" ? { enriched_at: item.enriched_at } : {}),
    failure_count: failed ? (previous?.failure_count ?? 0) + 1 : 0,
  };
}

function fallbackFor(item: ScoredCluster): MetadataFallback {
  const line = cleanLine(item.one_liner) || cleanLine(item.primary.summary) || item.primary.title;
  const summary = cleanLine(item.primary.summary);
  const brief = summary && normalizeText(summary) !== normalizeText(item.primary.title)
    ? summary
    : line;
  const image = firstClusterImage(item);
  return {
    dek: clampText(line, 180) || item.primary.title,
    brief: clampText(brief, 420) || clampText(line, 420) || item.primary.title,
    ...(image?.url ? { image_url: image.url } : {}),
    ...(image?.source ? { image_source: image.source } : {}),
  };
}

function firstClusterImage(item: ScoredCluster): { url: string; source: string } | undefined {
  for (const member of item.members) {
    const image = sanitizeImageUrl(member.image_url);
    if (image) return { url: image, source: member.image_source ?? "source_metadata" };
  }
  return undefined;
}

async function loadEnrichmentCache(cachePath: string): Promise<EnrichmentCacheFile> {
  try {
    const parsed = JSON.parse(await fs.readFile(cachePath, "utf8")) as Partial<EnrichmentCacheFile>;
    return {
      version: CACHE_VERSION,
      entries: isRecord(parsed.entries) ? sanitizeCacheEntries(parsed.entries) : {},
    };
  } catch {
    return { version: CACHE_VERSION, entries: {} };
  }
}

async function saveEnrichmentCache(cachePath: string, cache: EnrichmentCacheFile) {
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`);
}

function sanitizeCacheEntries(entries: Record<string, unknown>): Record<string, CachedEnrichment> {
  const out: Record<string, CachedEnrichment> = {};
  for (const [key, value] of Object.entries(entries).sort(([a], [b]) => a.localeCompare(b))) {
    if (!isRecord(value)) continue;
    const url = typeof value.url === "string" ? value.url : key;
    const status = value.status === "ok" || value.status === "metadata_only" || value.status === "failed"
      ? value.status
      : "failed";
    out[key] = {
      url,
      title: String(value.title ?? ""),
      source_name: String(value.source_name ?? ""),
      dek: clampText(value.dek, 180),
      brief: clampText(value.brief, 420),
      ...(sanitizeImageUrl(typeof value.image_url === "string" ? value.image_url : undefined) ? { image_url: sanitizeImageUrl(String(value.image_url)) } : {}),
      ...(typeof value.image_alt === "string" ? { image_alt: clampText(value.image_alt, 120) } : {}),
      ...(typeof value.image_source === "string" ? { image_source: clampText(value.image_source, 80) } : {}),
      status,
      attempted_at: isIsoDate(value.attempted_at) ? String(value.attempted_at) : new Date(0).toISOString(),
      ...(isIsoDate(value.enriched_at) ? { enriched_at: String(value.enriched_at) } : {}),
      failure_count: Number.isFinite(value.failure_count) ? Number(value.failure_count) : 0,
    };
  }
  return out;
}

function pruneCache(cache: EnrichmentCacheFile): EnrichmentCacheFile {
  const kept = Object.entries(cache.entries)
    .sort(([keyA, a], [keyB, b]) => {
      const byTime = timestampFor(b) - timestampFor(a);
      return byTime || keyA.localeCompare(keyB);
    })
    .slice(0, MAX_CACHE_ENTRIES)
    .sort(([a], [b]) => a.localeCompare(b));
  return { version: CACHE_VERSION, entries: Object.fromEntries(kept) };
}

function shouldUseCached(entry: CachedEnrichment, now: Date): boolean {
  if (entry.status !== "ok" && entry.status !== "metadata_only") return false;
  const base = Date.parse(entry.enriched_at ?? entry.attempted_at);
  return Number.isFinite(base) && now.getTime() - base < OK_CACHE_TTL_MS;
}

function shouldThrottleRetry(entry: CachedEnrichment, now: Date): boolean {
  const attempted = Date.parse(entry.attempted_at);
  return Number.isFinite(attempted) && now.getTime() - attempted < RETRY_AFTER_MS;
}

function timestampFor(entry: CachedEnrichment): number {
  return Date.parse(entry.enriched_at ?? entry.attempted_at) || 0;
}

function titleWords(value: string): Set<string> {
  return new Set(normalizeText(value).split(" ").filter((part) => part.length > 2));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  for (const value of small) if (big.has(value)) inter++;
  return inter / (a.size + b.size - inter);
}

function cleanLine(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .replace(/\[link\]\s*\[comments\]/gi, "")
    .replace(/submitted by \/u\/\S+/gi, "")
    .trim();
}

function clampText(value: unknown, max: number): string {
  const clean = cleanLine(value);
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function isIsoDate(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
