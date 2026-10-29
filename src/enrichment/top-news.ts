import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { boundedText, safeFetch } from "../sources/safe-fetch.ts";
import { sanitizeImageUrl } from "./images.ts";
import { writeFileAtomic } from "../pipeline/atomic-write.ts";
import { sourceFamily } from "../pipeline/diversity.ts";
import type { EnrichmentStatus, Kind, ScoredCluster, TopNewsItem } from "../types.ts";
import {
  createLlmProviders,
  type LlmProvider,
} from "../llm/providers.ts";

export const TOP_NEWS_LIMIT = 5;
export const TOP_NEWS_INPUT_CHARS = 12_000;
export const TOP_NEWS_TIMEOUT_MS = 15_000;

const CACHE_VERSION = 1;
const MAX_CACHE_ENTRIES = 500;
const OK_CACHE_TTL_MS = 6 * 36e5;
const PREFERRED_KINDS = new Set<Kind>(["news", "company_announcement", "model_release", "tool", "paper"]);

interface EnrichmentCacheFile {
  version: 1;
  entries: Record<string, CachedEnrichment>;
}

interface CachedEnrichment {
  input_hash?: string;
  source_content_hash?: string;
  summary_version?: number;
  summary_method?: TopNewsItem["summary_method"];
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
type SummaryRunner = (items: SummaryInput[], providers: LlmProvider[]) => Promise<SummaryOutput[]>;

export interface BuildTopNewsOptions {
  now: Date;
  cachePath: string;
  env: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  summarize?: SummaryRunner;
  providers?: LlmProvider[];
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
  const fetchImpl = options.fetchImpl ?? fetch;
  const providers = options.providers ?? createLlmProviders(options.env);
  const canRead = Boolean(options.fetchImpl || options.summarize || providers.length || options.env.JINA_API_KEY);
  for (const candidate of candidates) {
    const draft: EnrichmentDraft = { candidate, metadata: fallbackFor(candidate), failed: false };
    if (canRead) {
      try { draft.reader_text = await fetchJinaReaderText(candidate.primary.url, { apiKey: options.env.JINA_API_KEY, fetchImpl }); }
      catch (error) { draft.failed = true; console.warn(`[top-news] reader unavailable for ${candidate.primary.url}`); }
    }
    const contentHash = draft.reader_text ? fingerprint(draft.reader_text) : undefined;
    const cached = cache.entries[candidate.primary.url];
    // Always re-read available source text before reusing a brief: same-title corrections matter.
    if (cached && !draft.failed && cached.input_hash === inputFingerprint(candidate)
      && cached.source_content_hash === contentHash && cached.summary_version === 2 && shouldUseCached(cached, options.now)) {
      topNews.push(topNewsFromCache(candidate, cached, nowIso));
      continue;
    }
    let summary: SummaryOutput | undefined;
    if (draft.reader_text) {
      const input = summaryInput(draft, 0);
      try {
        const proposed = options.summarize ? (await options.summarize([input], providers))[0] : extractSummary(input);
        if (proposed && isGroundedExcerpt(proposed, input.reader_text)) summary = proposed;
        else draft.failed = true;
      } catch { draft.failed = true; }
    }
    const item = topNewsFromDraft(draft, summary, nowIso);
    item.summary_method = summary ? "extractive" : "source_metadata";
    item.summary_version = 2;
    item.source_content_hash = contentHash;
    topNews.push(item);
    cache.entries[candidate.primary.url] = cacheEntryFromItem(item, candidate, draft.failed, cached);
  }
  try { await saveEnrichmentCache(options.cachePath, pruneCache(cache)); }
  catch (error) { console.warn(`[top-news] cache write failed: ${(error as Error).message}`); }
  return topNews;
}

function fingerprint(text: string): string { return createHash("sha256").update(text).digest("hex"); }
function inputFingerprint(item: ScoredCluster): string { return fingerprint(JSON.stringify([item.primary.title, item.primary.summary, item.primary.url])); }
export function isGroundedExcerpt(summary: SummaryOutput, text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  const parts = [...new Set([summary.dek, summary.brief])];
  return parts.every((part) => part.length >= 20 && normalized.includes(part))
    && parts.join(" ").split(/\s+/).length <= 25;
}
function extractSummary(input: SummaryInput): SummaryOutput | undefined {
  const titleWords = new Set(input.title.toLowerCase().match(/[a-z]{4,}/g) ?? []);
  const paragraphs = input.reader_text.split(/\n\s*\n/).map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length >= 60 && !/^(title:|url source:|published time:|#|\[|!)/i.test(line) && !/subscribe|cookie policy|sign up for/i.test(line));
  paragraphs.sort((a,b) => [...titleWords].filter(w=>b.toLowerCase().includes(w)).length - [...titleWords].filter(w=>a.toLowerCase().includes(w)).length);
  const paragraph = paragraphs[0];
  if (!paragraph) return undefined;
  let excerpt = paragraph.split(/\s+/).slice(0, 25).join(" ");
  if (excerpt.length > 180) excerpt = excerpt.slice(0, 180).replace(/\s+\S*$/, "");
  return { index: input.index, dek: excerpt, brief: excerpt };
}

export function selectTopNewsCandidates(scored: ScoredCluster[]): ScoredCluster[] {
  const selected: ScoredCluster[] = [];
  const perSource = new Map<string, number>();
  const usedFamilies = new Set<string>();
  const titleFingerprints: Set<string>[] = [];

  for (const item of scored) {
    if (!isEligibleTopNews(item)) continue;
    const sourceId = item.primary.source_id;
    const family = sourceFamily(sourceId);
    if ((perSource.get(sourceId) ?? 0) >= 2) continue;
    if (usedFamilies.has(family)) continue;
    const fingerprint = titleWords(item.primary.title);
    if (titleFingerprints.some((existing) => jaccard(existing, fingerprint) >= 0.55)) continue;
    selected.push(item);
    perSource.set(sourceId, (perSource.get(sourceId) ?? 0) + 1);
    usedFamilies.add(family);
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
  const response = await safeFetch(readerUrlFor(url), {
    headers,
    signal: AbortSignal.timeout(TOP_NEWS_TIMEOUT_MS),
  }, options.fetchImpl);
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
  const text = await boundedText(response, 1_000_000);
  return (text.split("Markdown Content:").at(-1) ?? text).trim().slice(0, TOP_NEWS_INPUT_CHARS);
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
    summary_method: cached.summary_method,
    source_content_hash: cached.source_content_hash,
    summary_version: cached.summary_version,
  };
}

function cacheEntryFromItem(
  item: TopNewsItem,
  candidate: ScoredCluster,
  failed: boolean,
  previous: CachedEnrichment | undefined,
): CachedEnrichment {
  return {
    input_hash: inputFingerprint(candidate),
    source_content_hash: item.source_content_hash,
    summary_version: item.summary_version,
    summary_method: item.summary_method,
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
  const line = cleanLine(item.primary.summary) || item.primary.title;
  const summary = cleanLine(item.primary.summary);
  const dek = clampText(line, 180) || item.primary.title;
  const brief = summary && normalizeText(summary) !== normalizeText(item.primary.title)
    ? summary
    : line;
  const distinctBrief = isDistinctExpansion(brief, dek) ? brief : dek;
  const image = firstClusterImage(item);
  return {
    dek,
    brief: clampText(distinctBrief, 420) || dek,
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
  await writeFileAtomic(cachePath, `${JSON.stringify(cache, null, 2)}\n`);
}

function sanitizeCacheEntries(entries: Record<string, unknown>): Record<string, CachedEnrichment> {
  const out: Record<string, CachedEnrichment> = {};
  for (const [key, value] of Object.entries(entries).sort(([a], [b]) => a.localeCompare(b))) {
    if (!isRecord(value)) continue;
    const url = typeof value.url === "string" ? value.url : key;
    const status = value.status === "ok" || value.status === "metadata_only" || value.status === "failed"
      ? value.status
      : "failed";
    const dek = clampText(value.dek, 180);
    const brief = clampText(value.brief, 420);
    out[key] = {
      input_hash: typeof value.input_hash === "string" ? value.input_hash : undefined,
      source_content_hash: typeof value.source_content_hash === "string" ? value.source_content_hash : undefined,
      summary_version: typeof value.summary_version === "number" ? value.summary_version : undefined,
      summary_method: value.summary_method === "extractive" ? "extractive" : "source_metadata",
      url,
      title: String(value.title ?? ""),
      source_name: String(value.source_name ?? ""),
      dek,
      brief: isDistinctExpansion(brief, dek) ? brief : dek,
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
  let out = String(value ?? "");
  out = out.replace(
    /^\s*arxiv:\s*\d{4}\.\d{4,5}(?:v\d+)?\s+announce\s+type:\s*[^:]+?\s+abstract:\s*/i,
    "",
  );
  for (let i = 0; i < 3; i++) {
    out = out.replace(/\\(?:textit|emph|textbf|texttt|textsc|mathrm|mathbf|mathit)\{([^{}]*)\}/g, "$1");
  }
  return out
    .replace(/\\([{}_#$%&])/g, "$1")
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

function isDistinctExpansion(candidate: string, lead: string): boolean {
  const candidateText = comparableText(candidate);
  const leadText = comparableText(lead);
  if (!candidateText || !leadText || candidateText === leadText) return false;
  const prefix = leadText.slice(0, Math.min(80, leadText.length));
  return prefix.length < 40 || !candidateText.startsWith(prefix);
}

function comparableText(value: string): string {
  return normalizeText(value.replace(/[.…]+$/g, ""));
}

function isIsoDate(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
