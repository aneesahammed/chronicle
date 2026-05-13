import Parser from "rss-parser";
import { XMLParser } from "fast-xml-parser";
import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import { extractFirstImageFromHtml, sanitizeImageUrl } from "../enrichment/images.ts";
import { canonicalizeUrl, urlHash } from "../pipeline/canonicalize.ts";
import type {
  DateConfidence,
  FetchResult,
  LearningMetadata,
  PublishedAtSource,
  RawItem,
  Registry,
  RepoMetadata,
  SourceConfig,
  SourceFetchFailure,
  SourceHealth,
} from "../types.ts";

const TIMEOUT_MS = 20_000;
const SITEMAP_PAGE_TIMEOUT_MS = 8_000;
const USER_AGENT = "Chronicle/0.1 by aneesahammed (+https://github.com/aneesahammed/chronicle)";
const YOUTUBE_RSS_ATTEMPTS = 4;
const YOUTUBE_RSS_RETRY_DELAY_MS = 500;
const YOUTUBE_RSS_SPACING_MS = 750;
const YOUTUBE_RSS_TIMEOUT_MS = 8_000;
const SITEMAP_CHILD_LIMIT = 25;
const SITEMAP_CANDIDATE_MULTIPLIER = 8;
const SITEMAP_MIN_CANDIDATES = 40;
const GITHUB_README_TIMEOUT_MS = 8_000;
const GITHUB_README_PREVIEW_CHARS = 500;
const UNKNOWN_PUBLISHED_AT = "1970-01-01T00:00:00.000Z";

class FetchHttpError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(message: string, options: { status: number; retryable: boolean }) {
    super(message);
    this.status = options.status;
    this.retryable = options.retryable;
  }
}

// rss-parser delegates to xml2js/sax-js, which does not dereference external
// entities. We still strip HTML from summaries before they enter the feed.
interface RssMediaNode {
  $?: {
    url?: string;
    type?: string;
  };
}
interface RssCustomItem {
  mediaContent?: RssMediaNode | RssMediaNode[];
  mediaThumbnail?: RssMediaNode | RssMediaNode[];
}
const rss = new Parser<unknown, RssCustomItem>({
  timeout: TIMEOUT_MS,
  customFields: {
    item: [
      ["media:content", "mediaContent", { keepArray: true }],
      ["media:thumbnail", "mediaThumbnail", { keepArray: true }],
    ],
  },
});
const xml = new XMLParser({ ignoreAttributes: true });

// ---- Generic RSS ----------------------------------------------------------
async function fetchRss(s: SourceConfig, kw: string[]): Promise<RawItem[]> {
  const feed = await rss.parseString(await fetchText(s.url));
  const items = (feed.items ?? []).slice(0, s.limit);
  const isDiscussionFeed = s.id === "lobsters_ai" || s.id.startsWith("r_");
  return items
    .map((it) => {
      const image = extractRssImage(it);
      return normalize(s, {
        title: it.title ?? "",
        url: it.link ?? "",
        summary: stripHtml(it.contentSnippet ?? it.content ?? ""),
        image_url: image?.url,
        image_source: image?.source,
        published_at: it.isoDate ?? it.pubDate ?? UNKNOWN_PUBLISHED_AT,
        published_at_source: it.isoDate || it.pubDate ? "feed" : "generated_fallback",
        date_confidence: it.isoDate || it.pubDate ? "high" : "low",
        discussion_url: isDiscussionFeed ? it.link ?? "" : undefined,
        discussion_source: isDiscussionFeed ? s.name : undefined,
      });
    })
    .filter(Boolean)
    .filter((it) => !s.ai_filter || isAiRelevant(it as RawItem, kw)) as RawItem[];
}

async function fetchYoutubeRss(s: SourceConfig, kw: string[]): Promise<RawItem[]> {
  const feed = await rss.parseString(await fetchText(s.url, {
    attempts: YOUTUBE_RSS_ATTEMPTS,
    initialDelayMs: YOUTUBE_RSS_RETRY_DELAY_MS,
    retryStatuses: new Set([404]),
    timeoutMs: YOUTUBE_RSS_TIMEOUT_MS,
  }));
  const channelId = safeUrl(s.url)?.searchParams.get("channel_id") ?? undefined;
  return (feed.items ?? [])
    .slice(0, youtubeCandidateLimit(s))
    .map((it) => {
      const link = it.link ?? "";
      const videoId = youtubeVideoId(link);
      const image = extractRssImage(it) ?? youtubeThumbnail(videoId);
      return normalize(s, {
        title: it.title ?? "",
        url: link,
        summary: stripHtml(it.contentSnippet ?? it.content ?? ""),
        image_url: image?.url,
        image_source: image?.source,
        published_at: it.isoDate ?? it.pubDate ?? UNKNOWN_PUBLISHED_AT,
        published_at_source: it.isoDate || it.pubDate ? "feed" : "generated_fallback",
        date_confidence: it.isoDate || it.pubDate ? "high" : "low",
        learning: {
          provider: "YouTube",
          channel_id: channelId,
          video_id: videoId,
        },
      });
    })
    .filter(Boolean)
    .filter((it) => !s.ai_filter || isAiRelevant(it as RawItem, kw))
    .filter((it) => isLearningVideoCandidate(it as RawItem))
    .slice(0, s.limit) as RawItem[];
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

// ---- GitHub releases and repo discovery ----------------------------------
async function fetchGithubReleases(s: SourceConfig, options: FetchAllOptions): Promise<RawItem[]> {
  const repo = repoFromGitHubApiUrl(s.url);
  const data = await fetchJson<GithubRelease[]>(s.url, githubHeaders(options.env));
  return data
    .filter((release) => !release.draft)
    .slice(0, s.limit)
    .map((release) => normalize(s, {
      title: `${repo}: ${release.name || release.tag_name}`,
      url: release.html_url,
      summary: stripHtml(release.body ?? ""),
      published_at: release.published_at ?? release.created_at ?? UNKNOWN_PUBLISHED_AT,
      published_at_source: release.published_at || release.created_at ? "api" : "generated_fallback",
      date_confidence: release.published_at || release.created_at ? "high" : "low",
      repo: {
        full_name: repo,
        html_url: `https://github.com/${repo}`,
        release_tag: release.tag_name,
        release_name: release.name ?? undefined,
      },
    }))
    .filter(Boolean) as RawItem[];
}

async function fetchGithubRepoSearch(s: SourceConfig, options: FetchAllOptions): Promise<RawItem[]> {
  const url = resolveGitHubSearchUrl(s.url, options.now ?? new Date());
  const data = await fetchJson<GithubSearchResponse>(url, githubHeaders(options.env));
  const seen = new Set<string>();
  return (data.items ?? [])
    .filter((repo) => isRepoRadarCandidate(repo))
    .filter((repo) => {
      if (seen.has(repo.full_name)) return false;
      seen.add(repo.full_name);
      return true;
    })
    .slice(0, s.limit)
    .map((repo) => normalize(s, {
      title: `${repo.full_name} (${formatNumber(repo.stargazers_count ?? 0)} stars)`,
      url: repo.html_url,
      summary: [
        repo.description,
        repo.language,
        repo.license?.spdx_id,
        ...(repo.topics ?? []),
      ].filter(Boolean).join(" · "),
      published_at: repo.pushed_at ?? repo.updated_at ?? repo.created_at ?? UNKNOWN_PUBLISHED_AT,
      published_at_source: repo.pushed_at || repo.updated_at || repo.created_at ? "api" : "generated_fallback",
      date_confidence: repo.pushed_at || repo.updated_at || repo.created_at ? "medium" : "low",
      engagement: { score: repo.stargazers_count ?? 0 },
      repo: {
        full_name: repo.full_name,
        html_url: repo.html_url,
        description: repo.description ?? undefined,
        language: repo.language ?? undefined,
        license: repo.license?.spdx_id ?? undefined,
        topics: repo.topics,
        stargazers_count: repo.stargazers_count,
        forks_count: repo.forks_count,
        open_issues_count: repo.open_issues_count,
        pushed_at: repo.pushed_at,
        created_at: repo.created_at,
      },
    }))
    .filter(Boolean) as RawItem[];
}

async function fetchGithubTrending(s: SourceConfig, options: FetchAllOptions): Promise<RawItem[]> {
  const now = options.now ?? new Date();
  const html = await fetchText(s.url);
  const candidates = parseGithubTrendingHtml(html, s.url);
  const seen = new Set<string>();
  const unique = candidates.filter((candidate) => {
    if (seen.has(candidate.full_name)) return false;
    seen.add(candidate.full_name);
    return true;
  });

  const items = await mapLimit(unique, 4, async (candidate) => {
    try {
      return await enrichGithubTrendingCandidate(s, candidate, options, now);
    } catch (error) {
      console.warn(`[github-trending] repo skipped for ${candidate.full_name}: ${(error as Error).message}`);
      return null;
    }
  });
  return items.filter(Boolean).slice(0, s.limit) as RawItem[];
}

async function enrichGithubTrendingCandidate(
  s: SourceConfig,
  candidate: GithubTrendingCandidate,
  options: FetchAllOptions,
  now: Date,
): Promise<RawItem | null> {
  const [repo, readme] = await Promise.all([
    fetchGithubRepoMetadata(candidate.full_name, options),
    fetchGithubReadme(candidate.full_name),
  ]);

  if (repo?.archived || repo?.disabled || repo?.fork) return null;

  const description = repo?.description ?? candidate.description;
  const topics = repo?.topics ?? [];
  const readmePreview = readme?.slice(0, GITHUB_README_PREVIEW_CHARS) ?? "";
  if (!isGithubTrendingAiCandidate(candidate, repo, readmePreview)) return null;

  const readmeUrl = githubRawReadmeUrl(candidate.full_name);
  const readmeImage = readme ? extractReadmeImage(readme, readmeUrl) : undefined;
  const starsToday = candidate.stars_today ?? 0;
  const totalStars = repo?.stargazers_count ?? candidate.stargazers_count;
  const forks = repo?.forks_count ?? candidate.forks_count;
  const license = repo?.license?.spdx_id ?? undefined;
  const language = repo?.language ?? candidate.language;
  const title = starsToday > 0
    ? `${candidate.full_name} (+${formatNumber(starsToday)} stars today)`
    : `${candidate.full_name} (${formatNumber(totalStars)} stars)`;

  return normalize(s, {
    title,
    url: repo?.html_url ?? candidate.html_url,
    summary: [
      description,
      language,
      license,
      starsToday > 0 ? `+${formatNumber(starsToday)} stars today` : undefined,
      ...topics,
    ].filter(Boolean).join(" · "),
    image_url: readmeImage,
    image_source: readmeImage ? "github_readme" : undefined,
    published_at: now.toISOString(),
    published_at_source: "generated_fallback",
    date_confidence: "low",
    engagement: { score: starsToday },
    repo: {
      full_name: candidate.full_name,
      html_url: repo?.html_url ?? candidate.html_url,
      description: description ?? undefined,
      language: language ?? undefined,
      license,
      topics,
      stargazers_count: totalStars,
      forks_count: forks,
      open_issues_count: repo?.open_issues_count,
      pushed_at: repo?.pushed_at,
      created_at: repo?.created_at,
      stars_today: starsToday,
      trending_period: "daily",
      readme_image_url: readmeImage,
    },
  });
}

interface GithubRelease {
  tag_name: string;
  name?: string | null;
  html_url: string;
  body?: string | null;
  published_at?: string | null;
  created_at?: string | null;
  draft?: boolean;
}

interface GithubSearchResponse {
  items?: GithubRepo[];
}

interface GithubRepo {
  full_name: string;
  name: string;
  html_url: string;
  description?: string | null;
  language?: string | null;
  license?: { spdx_id?: string | null } | null;
  topics?: string[];
  stargazers_count?: number;
  forks_count?: number;
  open_issues_count?: number;
  pushed_at?: string;
  updated_at?: string;
  created_at?: string;
  archived?: boolean;
  disabled?: boolean;
  fork?: boolean;
}

interface GithubTrendingCandidate {
  full_name: string;
  name: string;
  html_url: string;
  description?: string;
  language?: string;
  stargazers_count: number;
  forks_count: number;
  stars_today: number;
}

// ---- Selector-backed page list -------------------------------------------
async function fetchPageList(s: SourceConfig, kw: string[]): Promise<RawItem[]> {
  assertPageListSelectors(s);
  const html = await fetchText(s.url);
  const $ = cheerio.load(html);
  const base = new URL(s.url);
  const items: RawItem[] = [];
  for (const element of $(s.item_selector!).toArray()) {
    const row = $(element);
    const link = row.is(s.link_selector!) ? row : row.find(s.link_selector!).first();
    const href = link.attr("href");
    if (!href) continue;
    const parsed = new URL(href, base);
    if (!isHttpUrl(parsed)) continue;
    const url = parsed.toString();
    if (!sourceUrlMatches(url, s)) continue;
    const title = row.find(s.title_selector!).first().text().trim() || link.text().trim();
    if (!title) continue;
    if (/^(?:featured|blog|learn more)$/i.test(title)) continue;
    const summary = s.summary_selector ? row.find(s.summary_selector).first().text().trim() : "";
    let dateValue = "";
    if (s.date_selector) {
      const dateNode = row.find(s.date_selector).first();
      dateValue = dateNode.attr("datetime") ?? dateNode.attr("content") ?? dateNode.text().trim();
    }
    if (!dateValue) dateValue = nearestVisibleDate(row);
    const publishedAt = validDateOrFallback(dateValue);
    const normalized = normalize(s, {
      title: titleWithPrefix(title, s.title_prefix),
      url,
      summary,
      published_at: publishedAt,
      published_at_source: publishedAt === UNKNOWN_PUBLISHED_AT ? "generated_fallback" : "page_metadata",
      date_confidence: publishedAt === UNKNOWN_PUBLISHED_AT ? "low" : "medium",
      learning: s.source_role === "learning"
        ? { provider: s.name, course_url: url }
        : undefined,
    });
    if (normalized && (!s.ai_filter || isAiRelevant(normalized, kw))) items.push(normalized);
    if (items.length >= s.limit) break;
  }
  return items;
}

function nearestVisibleDate(row: cheerio.Cheerio<AnyNode>): string {
  let cursor = row;
  for (let depth = 0; depth < 4; depth++) {
    const date = matchVisibleDate(cursor.text().replace(/\s+/g, " "));
    if (date) return date;
    cursor = cursor.parent();
    if (cursor.length === 0) break;
  }
  return "";
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
        image_url: details.image_url,
        image_source: details.image_url ? "page_metadata" : undefined,
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

interface FetchAllOptions {
  env?: NodeJS.ProcessEnv;
  now?: Date;
}

interface PageDetails {
  title?: string;
  description?: string;
  image_url?: string;
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
      image_url: sanitizeImageUrl(extractMetaContent(html, [
        "og:image",
        "twitter:image",
        "thumbnail",
      ]), url),
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
    image_url?: string;
    image_source?: string;
    published_at: string;
    published_at_source: PublishedAtSource;
    date_confidence: DateConfidence;
    discussion_url?: string;
    discussion_source?: string;
    engagement?: RawItem["engagement"];
    repo?: RepoMetadata;
    learning?: LearningMetadata;
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
    source_role: s.source_role ?? "main",
    trust: s.trust,
    kind_hint: s.kind_hint,
    title: raw.title.trim().replace(/\s+/g, " "),
    url: canonical,
    original_url: raw.url,
    discussion_url: discussion || undefined,
    discussion_source: discussion ? raw.discussion_source : undefined,
    summary: cleanSummary(raw.summary),
    image_url: raw.image_url,
    image_source: raw.image_url ? raw.image_source : undefined,
    published_at: raw.published_at,
    published_at_source: raw.published_at_source,
    date_confidence: raw.date_confidence,
    engagement: raw.engagement,
    repo: raw.repo,
    learning: raw.learning,
  };
}

function extractRssImage(item: Parser.Item & RssCustomItem): { url: string; source: string } | undefined {
  const enclosure = item.enclosure;
  const enclosureUrl = sanitizeImageUrl(enclosure?.url);
  if (enclosureUrl && (!enclosure?.type || enclosure.type.toLowerCase().startsWith("image/"))) {
    return { url: enclosureUrl, source: "rss_enclosure" };
  }

  for (const node of asArray(item.mediaContent)) {
    const url = sanitizeImageUrl(node.$?.url);
    const type = node.$?.type?.toLowerCase() ?? "";
    if (url && (!type || type.startsWith("image/"))) return { url, source: "rss_media" };
  }
  for (const node of asArray(item.mediaThumbnail)) {
    const url = sanitizeImageUrl(node.$?.url);
    if (url) return { url, source: "rss_media" };
  }

  const htmlImage = extractFirstImageFromHtml(item.content);
  return htmlImage ? { url: htmlImage, source: "rss_content" } : undefined;
}

function stripHtml(s: string): string {
  return cleanSummary(s.replace(/<[^>]+>/g, " "))?.slice(0, 600) ?? "";
}

function cleanSummary(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let out = decodeHtml(value);
  out = out.replace(
    /^\s*arxiv:\s*\d{4}\.\d{4,5}(?:v\d+)?\s+announce\s+type:\s*[^:]+?\s+abstract:\s*/i,
    "",
  );
  for (let i = 0; i < 3; i++) {
    out = out.replace(/\\(?:textit|emph|textbf|texttt|textsc|mathrm|mathbf|mathit)\{([^{}]*)\}/g, "$1");
  }
  out = out
    .replace(/\\([{}_#$%&])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return out || undefined;
}

function isAiRelevant(item: RawItem, kw: string[]): boolean {
  const text = ` ${item.title} ${item.summary ?? ""} `.toLowerCase();
  return kw.some((k) => text.includes(k.toLowerCase()));
}

function youtubeCandidateLimit(source: SourceConfig): number {
  if (source.source_role !== "learning") return source.limit;
  return Math.max(source.limit, Math.min(source.limit * 4, 40));
}

function isLearningVideoCandidate(item: RawItem): boolean {
  if (item.source_role !== "learning" || item.kind_hint !== "video") return true;
  if (isYoutubeShortsItem(item)) return false;
  if (item.learning?.provider === "YouTube" && !item.learning.video_id) return false;

  const text = normalizeFilterText(`${item.title} ${item.summary ?? ""}`);
  const hasCourseSignal = /\b(courses?|lessons?|curriculum|classroom)\b/.test(text);
  const hasInstructionSignal = [
    /\bhow\s+(?:to|the)\b/,
    /\b(?:learn|tutorial|guide|workshop|lecture|training|webinar|walkthrough)\b/,
    /\b(?:hands[- ]on|deep dive|explained|from scratch|quickstart)\b/,
    /\b(?:build|building|deploy|code|coding|implement|debug|evaluate|benchmark)\b/,
    /\b(?:foundations?|office hours|build hour|dev community live)\b/,
  ].some((pattern) => pattern.test(text));
  const hasTechnicalLearningTopic = [
    /\b(?:llms?|agents?|rag|mcp|inference|fine[- ]?tun(?:e|ing)|evals?)\b/,
    /\b(?:embeddings?|vector search|transformers?|tokenizers?|quantiz(?:e|ation))\b/,
    /\b(?:multimodal|vlms?|cuda|pytorch|jax|open source models?)\b/,
  ].some((pattern) => pattern.test(text));
  const isPreReleaseMarketing = /\b(?:coming soon|almost here|trailer|teaser|save your spot|sign up)\b/.test(text);
  const isLaunchOrBrandMarketing = [
    /\b(?:ad|advert|advertisement|commercial|campaign|brand film)\b/,
    /\|\s*with chatgpt\b/,
    /\b(?:introducing|launch(?:ed)?|available now|is live|is here|sota for)\b/,
  ].some((pattern) => pattern.test(text));

  if (hasCourseSignal) return true;
  if (isPreReleaseMarketing) return false;
  if (hasInstructionSignal) return true;
  if (isLaunchOrBrandMarketing) return false;
  return hasTechnicalLearningTopic;
}

function isYoutubeShortsItem(item: RawItem): boolean {
  if (isYoutubeShortsUrl(item.url) || isYoutubeShortsUrl(item.original_url)) return true;
  const text = ` ${item.title} ${item.summary ?? ""} `;
  return /(?:^|\s)#shorts?\b/i.test(text) || /\byoutube shorts?\b/i.test(text);
}

function isYoutubeShortsUrl(value: string): boolean {
  const url = safeUrl(value);
  if (!url) return false;
  return url.hostname.endsWith("youtube.com") && url.pathname.split("/").filter(Boolean)[0]?.toLowerCase() === "shorts";
}

function normalizeFilterText(value: string): string {
  return decodeHtml(value)
    .toLowerCase()
    .replace(/[^a-z0-9+.#|/-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function githubHeaders(env: NodeJS.ProcessEnv | undefined): Record<string, string> {
  return {
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": USER_AGENT,
    ...(env?.GITHUB_TOKEN ? { Authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}),
  };
}

function parseGithubTrendingHtml(html: string, baseUrl: string): GithubTrendingCandidate[] {
  const $ = cheerio.load(html);
  return $("article.Box-row").toArray().flatMap((element) => {
    const row = $(element);
    const href = row.find("h2 a").first().attr("href");
    const fullName = href ? githubFullNameFromHref(href, baseUrl) : undefined;
    if (!fullName) return [];
    const name = fullName.split("/")[1] ?? fullName;
    const mutedLinks = row.find("a.Link--muted").map((_, link) => $(link).text().trim()).get();
    return [{
      full_name: fullName,
      name,
      html_url: `https://github.com/${fullName}`,
      description: textOrUndefined(row.find("p").first().text()),
      language: textOrUndefined(row.find('[itemprop="programmingLanguage"]').first().text()),
      stargazers_count: parseGithubCount(mutedLinks[0]),
      forks_count: parseGithubCount(mutedLinks[1]),
      stars_today: parseGithubCount(row.find("span.float-sm-right").first().text()),
    }];
  });
}

async function fetchGithubRepoMetadata(fullName: string, options: FetchAllOptions): Promise<GithubRepo | undefined> {
  try {
    return await fetchJson<GithubRepo>(githubRepoApiUrl(fullName), githubHeaders(options.env));
  } catch (error) {
    console.warn(`[github-trending] metadata skipped for ${fullName}: ${(error as Error).message}`);
    return undefined;
  }
}

async function fetchGithubReadme(fullName: string): Promise<string | undefined> {
  try {
    return await fetchText(githubRawReadmeUrl(fullName), {
      attempts: 1,
      timeoutMs: GITHUB_README_TIMEOUT_MS,
    });
  } catch (error) {
    console.warn(`[github-trending] README skipped for ${fullName}: ${(error as Error).message}`);
    return undefined;
  }
}

function isGithubTrendingAiCandidate(
  candidate: GithubTrendingCandidate,
  repo: GithubRepo | undefined,
  readmePreview: string,
): boolean {
  if (isLowSignalRepoName(candidate.name)) return false;
  const text = normalizeFilterText([
    candidate.full_name,
    repo?.description ?? candidate.description,
    ...(repo?.topics ?? []),
    readmePreview,
  ].filter(Boolean).join(" "));
  return repoAiPatterns().some((pattern) => pattern.test(text));
}

function extractReadmeImage(readme: string, readmeUrl: string): string | undefined {
  for (const image of markdownImages(readme)) {
    const safe = sanitizeImageUrl(resolveReadmeImageSrc(image.src, readmeUrl));
    if (safe && !isBadgeImage(safe, image.alt)) return safe;
  }

  const $ = cheerio.load(readme);
  for (const element of $("img").toArray()) {
    const img = $(element);
    const src = img.attr("src") ?? img.attr("data-src");
    const safe = sanitizeImageUrl(resolveReadmeImageSrc(src, readmeUrl));
    const alt = img.attr("alt") ?? img.attr("title") ?? "";
    if (safe && !isBadgeImage(safe, alt)) return safe;
  }
  return undefined;
}

function markdownImages(markdown: string): { alt: string; src: string }[] {
  const images: { alt: string; src: string }[] = [];
  const pattern = /!\[([^\]]*)]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g;
  for (const match of markdown.matchAll(pattern)) {
    images.push({ alt: match[1] ?? "", src: match[2] ?? "" });
  }
  return images;
}

function resolveReadmeImageSrc(value: string | undefined, readmeUrl: string): string | undefined {
  try {
    const raw = String(value ?? "").trim();
    if (!raw) return undefined;
    if (/^https?:\/\//i.test(raw)) return raw;
    const base = new URL(readmeUrl);
    if (raw.startsWith("/") && base.hostname === "raw.githubusercontent.com") {
      const [owner, repo, ref] = base.pathname.split("/").filter(Boolean);
      if (owner && repo && ref) return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}${raw}`;
    }
    return new URL(raw, base).toString();
  } catch {
    return undefined;
  }
}

function isBadgeImage(value: string, alt: string): boolean {
  const url = safeUrl(value);
  if (!url) return true;
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  const label = normalizeFilterText(`${alt} ${host} ${path}`);
  if (/(?:^|\.)shields\.io$|(?:^|\.)badgen\.net$|badge\.fury\.io$/.test(host)) return true;
  if (/^(?:api\.)?star-history\.com$|^starchart\.cc$|^readme-typing-svg\.demolab\.com$/.test(host)) return true;
  if (host === "skills.sh" && path.startsWith("/b/")) return true;
  if (/(?:^|\/)(?:badge|badges|shields?)(?:[./_-]|$)/.test(path)) return true;
  return /\.svg$/i.test(path) && /\b(?:badge|build|ci|coverage|license|version|npm|pypi|status|downloads?)\b/.test(label);
}

function githubFullNameFromHref(href: string, baseUrl: string): string | undefined {
  const url = new URL(href, baseUrl);
  if (url.hostname !== "github.com") return undefined;
  const parts = url.pathname.split("/").filter(Boolean).slice(0, 2);
  if (parts.length !== 2) return undefined;
  return parts.map(decodeURIComponent).join("/");
}

function githubRepoApiUrl(fullName: string): string {
  const [owner, repo] = fullName.split("/");
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function githubRawReadmeUrl(fullName: string): string {
  const [owner, repo] = fullName.split("/");
  return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/HEAD/README.md`;
}

function repoFromGitHubApiUrl(value: string): string {
  const url = new URL(value);
  const match = url.pathname.match(/\/repos\/([^/]+\/[^/]+)\/releases/);
  if (!match) throw new Error(`invalid GitHub releases API URL: ${value}`);
  return match[1];
}

function resolveGitHubSearchUrl(value: string, now: Date): string {
  return value
    .replaceAll("${date_minus_14d}", daysAgo(now, 14))
    .replaceAll("${date_minus_30d}", daysAgo(now, 30));
}

function daysAgo(now: Date, days: number): string {
  return new Date(now.getTime() - days * 864e5).toISOString().slice(0, 10);
}

function isRepoRadarCandidate(repo: GithubRepo): boolean {
  if (repo.archived || repo.disabled || repo.fork) return false;
  if ((repo.stargazers_count ?? 0) < 100) return false;
  if (isLowSignalRepoName(repo.name)) return false;
  const text = `${repo.full_name} ${repo.description ?? ""} ${(repo.topics ?? []).join(" ")}`.toLowerCase();
  return repoAiPatterns().some((pattern) => pattern.test(text));
}

function repoAiPatterns(): RegExp[] {
  return [
    /(?:^|[^a-z0-9])ai(?:$|[^a-z0-9])/,
    /(?:^|[^a-z0-9])ml(?:$|[^a-z0-9])/,
    /(?:^|[^a-z0-9])llms?(?:$|[^a-z0-9])/,
    /(?:^|[^a-z0-9])ai[- ]agents?(?:$|[^a-z0-9])/,
    /(?:^|[^a-z0-9])llm[- ]agents?(?:$|[^a-z0-9])/,
    /(?:^|[^a-z0-9])coding[- ]agents?(?:$|[^a-z0-9])/,
    /(?:^|[^a-z0-9])computer[- ]use[- ]agents?(?:$|[^a-z0-9])/,
    /(?:^|[^a-z0-9])agentic(?:$|[^a-z0-9])/,
    /(?:^|[^a-z0-9])inference(?:$|[^a-z0-9])/,
    /(?:^|[^a-z0-9])mcp(?:$|[^a-z0-9])/,
    /(?:^|[^a-z0-9])transformers?(?:$|[^a-z0-9])/,
    /(?:^|[^a-z0-9])rag(?:$|[^a-z0-9])/,
    /(?:^|[^a-z0-9])embeddings?(?:$|[^a-z0-9])/,
    /(?:^|[^a-z0-9])diffusion(?:$|[^a-z0-9])/,
    /(?:^|[^a-z0-9])machine[- ]learning(?:$|[^a-z0-9])/,
    /(?:^|[^a-z0-9])generative(?:$|[^a-z0-9])/,
    /(?:^|[^a-z0-9])openai(?:$|[^a-z0-9])/,
    /(?:^|[^a-z0-9])claude(?:$|[^a-z0-9])/,
    /(?:^|[^a-z0-9])anthropic(?:$|[^a-z0-9])/,
  ];
}

function isLowSignalRepoName(value: string): boolean {
  return /(?:^|[-_])(awesome|list|papers|prompts)(?:$|[-_])/i.test(value);
}

function textOrUndefined(value: string): string | undefined {
  const text = value.replace(/\s+/g, " ").trim();
  return text || undefined;
}

function parseGithubCount(value: string | undefined): number {
  const match = String(value ?? "").trim().toLowerCase().match(/([\d,.]+)\s*([km])?/);
  if (!match) return 0;
  const base = Number(match[1].replaceAll(",", ""));
  if (!Number.isFinite(base)) return 0;
  const suffix = match[2];
  if (suffix === "m") return Math.round(base * 1_000_000);
  if (suffix === "k") return Math.round(base * 1_000);
  return Math.round(base);
}

function assertPageListSelectors(s: SourceConfig): void {
  const missing = [
    "item_selector",
    "link_selector",
    "title_selector",
  ].filter((key) => !s[key as keyof SourceConfig]);
  if (missing.length) {
    throw new Error(`page_list source ${s.id} missing selectors: ${missing.join(", ")}`);
  }
}

function youtubeVideoId(value: string): string | undefined {
  const url = safeUrl(value);
  if (!url) return undefined;
  if (url.hostname.endsWith("youtu.be")) return url.pathname.split("/").filter(Boolean)[0];
  return url.searchParams.get("v") ?? undefined;
}

function youtubeThumbnail(videoId: string | undefined): { url: string; source: string } | undefined {
  if (!videoId) return undefined;
  return { url: `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`, source: "youtube_thumbnail" };
}

function safeUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

async function fetchJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  return await withRetry(async () => {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers,
    });
    if (!r.ok) throw await fetchHttpError(url, r);
    return (await r.json()) as T;
  });
}

async function fetchText(url: string, options: RetryOptions = {}): Promise<string> {
  return await withRetry(async () => {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
      headers: { "user-agent": USER_AGENT },
    });
    if (!r.ok) throw await fetchHttpError(url, r, options.retryStatuses);
    return await r.text();
  }, options);
}

interface RetryOptions {
  attempts?: number;
  initialDelayMs?: number;
  retryStatuses?: Set<number>;
  timeoutMs?: number;
}

async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  let last: unknown;
  const attempts = options.attempts ?? 2;
  const initialDelayMs = options.initialDelayMs ?? 500;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (e instanceof FetchHttpError && !e.retryable) throw e;
      if (attempt < attempts - 1) await sleep(initialDelayMs * (attempt + 1));
    }
  }
  throw last;
}

async function fetchHttpError(
  url: string,
  response: Response,
  retryStatuses: Set<number> = new Set(),
): Promise<FetchHttpError> {
  const body = await response.text().catch(() => "");
  const rateLimit = githubRateLimitMessage(response.headers);
  const bodyMessage = body.trim().replace(/\s+/g, " ").slice(0, 240);
  const message = [
    `HTTP ${response.status} ${response.statusText}`.trim(),
    rateLimit,
    bodyMessage,
    `url=${url}`,
  ].filter(Boolean).join(" - ");
  return new FetchHttpError(message, {
    status: response.status,
    retryable: retryStatuses.has(response.status) || isRetryableStatus(response.status, response.headers),
  });
}

function isRetryableStatus(status: number, headers: Headers): boolean {
  if (status === 403 && headers.get("x-ratelimit-remaining") === "0") return false;
  if (status === 403 || status === 422) return false;
  return status === 408 || status === 429 || status >= 500;
}

function githubRateLimitMessage(headers: Headers): string {
  if (headers.get("x-ratelimit-remaining") !== "0") return "";
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (!Number.isFinite(reset)) return "GitHub rate limit exhausted";
  return `GitHub rate limit exhausted until ${new Date(reset * 1000).toISOString()}`;
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

function isHttpUrl(url: URL): boolean {
  return url.protocol === "http:" || url.protocol === "https:";
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
  return html.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},\s+\d{4}\b/i)?.[0];
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
  const decoded = decodeHtml(value).trim();
  const monthDate = parseMonthDateUtc(decoded);
  if (monthDate) return monthDate;
  const ms = Date.parse(decoded);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
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
  const monthDate = parseMonthDateUtc(value);
  if (monthDate) return monthDate;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : UNKNOWN_PUBLISHED_AT;
}

function parseMonthDateUtc(value: string): string | undefined {
  const match = value.trim().match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),\s+(\d{4})$/i);
  if (!match) return undefined;
  const month = monthNumber(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (month === undefined || !Number.isInteger(day) || !Number.isInteger(year)) return undefined;
  return new Date(Date.UTC(year, month, day)).toISOString();
}

function monthNumber(value: string): number | undefined {
  const normalized = value.toLowerCase().replace(/\.$/, "");
  const aliases: Record<string, number> = {
    jan: 0,
    january: 0,
    feb: 1,
    february: 1,
    mar: 2,
    march: 2,
    apr: 3,
    april: 3,
    may: 4,
    jun: 5,
    june: 5,
    jul: 6,
    july: 6,
    aug: 7,
    august: 7,
    sep: 8,
    sept: 8,
    september: 8,
    oct: 9,
    october: 9,
    nov: 10,
    november: 10,
    dec: 11,
    december: 11,
  };
  return aliases[normalized];
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
export async function fetchAll(reg: Registry, options: FetchAllOptions = {}): Promise<FetchResult> {
  const youtubeGate = createSerialGate(YOUTUBE_RSS_SPACING_MS);
  const tasks = reg.sources.map(async (s) => {
    try {
      let items: RawItem[] = [];
      switch (s.type) {
        case "rss":         items = await fetchRss(s, reg.hn_ai_keywords); break;
        case "youtube_rss": items = await youtubeGate(() => fetchYoutubeRss(s, reg.hn_ai_keywords)); break;
        case "hn_algolia":  items = await fetchHN(s, reg.hn_ai_keywords); break;
        case "reddit":      items = await fetchReddit(s); break;
        case "hf_papers":   items = await fetchHfPapers(s); break;
        case "hf_models":   items = await fetchHfModels(s); break;
        case "sitemap":     items = await fetchSitemap(s, reg.hn_ai_keywords); break;
        case "github_releases": items = await fetchGithubReleases(s, options); break;
        case "github_repo_search": items = await fetchGithubRepoSearch(s, options); break;
        case "github_trending": items = await fetchGithubTrending(s, options); break;
        case "page_list":   items = await fetchPageList(s, reg.hn_ai_keywords); break;
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

function createSerialGate(spacingMs: number): <T>(run: () => Promise<T>) => Promise<T> {
  let tail = Promise.resolve();
  return async (run) => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await run();
    } finally {
      if (spacingMs > 0) await sleep(spacingMs);
      release();
    }
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
