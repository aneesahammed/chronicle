import { promises as fs } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../pipeline/atomic-write.ts";
import type { FeedFile, ScoredCluster, TopNewsItem } from "../types.ts";

const SITE_URL = "https://chronicle.tinycrafts.ai/";
const TOP_NEWS_START = "<!-- CHRONICLE_TOP_NEWS_START -->";
const TOP_NEWS_END = "<!-- CHRONICLE_TOP_NEWS_END -->";
const FEED_START = "<!-- CHRONICLE_FEED_START -->";
const FEED_END = "<!-- CHRONICLE_FEED_END -->";
const JSONLD_START = "<!-- CHRONICLE_JSONLD_START -->";
const JSONLD_END = "<!-- CHRONICLE_JSONLD_END -->";
const ARCHIVE_START = "<!-- CHRONICLE_ARCHIVE_START -->";
const ARCHIVE_END = "<!-- CHRONICLE_ARCHIVE_END -->";
type SourceGlyphKind =
  | "arxiv"
  | "reddit"
  | "youtube"
  | "github"
  | "huggingface"
  | "hacker-news"
  | "openai"
  | "news"
  | "discussion"
  | "feed";

interface SourceGlyphContext {
  source_id?: string;
  source_name?: string;
  url?: string;
  original_url?: string;
  discussion_url?: string;
  discussion_source?: string;
}

export interface ArchiveDay {
  date: string;
  generated_at: string;
  count: number;
  title: string;
  path: string;
  feed_path: string;
}

export async function writeRenderedHomePage(publicDir: string, feed: FeedFile) {
  const indexPath = path.join(publicDir, "index.html");
  const template = await readOptionalText(indexPath);
  if (!template) return;
  await writeFileAtomic(indexPath, renderFeedPage(template, feed, {
    canonicalUrl: SITE_URL,
    title: "Chronicle: Daily AI Signal for Builders",
    description: homeMetaDescription(),
    h1: "Chronicle: Daily AI Signal for Builders",
  }));
}

export async function writeRenderedDailyPage(publicDir: string, feed: FeedFile) {
  const date = feed.generated_at.slice(0, 10);
  const indexPath = path.join(publicDir, "index.html");
  const template = await readOptionalText(indexPath);
  if (!template) return;
  const dayPath = path.join(publicDir, "daily", date, "index.html");
  await writeFileAtomic(dayPath, renderFeedPage(template, feed, {
    canonicalUrl: `${SITE_URL}daily/${date}/`,
    title: `Chronicle AI Brief, ${longDate(date)}`,
    description: dailyMetaDescription(feed, date),
    h1: `Chronicle AI Brief, ${longDate(date)}`,
    archiveDate: date,
  }));
}

export async function writeArchiveIndexPage(
  publicDir: string,
  days: ArchiveDay[],
  generatedAt: string,
) {
  const archivePath = path.join(publicDir, "daily", "index.html");
  const template = await readOptionalText(archivePath);
  if (!template) return;
  const meta = archiveMeta(days);
  const description = archiveMetaDescription();
  let html = replaceBetween(template, ARCHIVE_START, ARCHIVE_END, renderArchiveDays(days), "archive markers");
  html = replaceRequired(
    html,
    /<meta name="description" content="[^"]*">/,
    `<meta name="description" content="${escapeAttr(description)}">`,
    "archive meta description",
  );
  html = replaceRequired(
    html,
    /<meta property="og:description" content="[^"]*">/,
    `<meta property="og:description" content="${escapeAttr(description)}">`,
    "archive Open Graph description",
  );
  html = replaceRequired(
    html,
    /<meta name="twitter:description" content="[^"]*">/,
    `<meta name="twitter:description" content="${escapeAttr(description)}">`,
    "archive Twitter description",
  );
  html = replaceRequired(
    html,
    /<p class="lede-meta" id="ledeMeta">[\s\S]*?<\/p>/,
    `<p class="lede-meta" id="ledeMeta">${escapeHtml(meta)}</p>`,
    "archive metadata",
  );
  html = replaceRequired(
    html,
    /<meta property="og:url" content="[^"]*">/,
    `<meta property="og:url" content="${SITE_URL}daily/">`,
    "archive Open Graph URL",
  );
  html = replaceRequired(
    html,
    /<link rel="canonical" href="[^"]*">/,
    `<link rel="canonical" href="${SITE_URL}daily/">`,
    "archive canonical link",
  );
  const next = replaceBetween(html, JSONLD_START, JSONLD_END, archiveJsonLd(days, generatedAt), "archive JSON-LD markers");
  await writeFileAtomic(archivePath, next);
}

async function readOptionalText(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeSyndicationFeeds(publicDir: string, feed: FeedFile) {
  await writeFileAtomic(path.join(publicDir, "rss.xml"), renderRss(feed));
  await writeFileAtomic(path.join(publicDir, "atom.xml"), renderAtom(feed));
}

export async function writeFeedSchema(publicDir: string) {
  await writeFileAtomic(
    path.join(publicDir, "feed.schema.json"),
    `${JSON.stringify(feedSchema(), null, 2)}\n`,
  );
}

function renderFeedPage(
  template: string,
  feed: FeedFile,
  options: { canonicalUrl: string; title: string; description: string; h1: string; archiveDate?: string },
): string {
  const hasTopNews = Boolean(feed.top_news?.length);
  const socialTitle = options.archiveDate ? options.title : "Chronicle";
  let html = replaceRequired(
    template,
    /<title>[\s\S]*?<\/title>/,
    `<title>${escapeHtml(options.title)}</title>`,
    "document title",
  );
  html = replaceRequired(
    html,
    /<meta name="description" content="[^"]*">/,
    `<meta name="description" content="${escapeAttr(options.description)}">`,
    "meta description",
  );
  html = replaceRequired(
    html,
    /<link rel="canonical" href="[^"]*">/,
    `<link rel="canonical" href="${escapeAttr(options.canonicalUrl)}">`,
    "canonical link",
  );
  html = replaceRequired(
    html,
    /<meta property="og:url" content="[^"]*">/,
    `<meta property="og:url" content="${escapeAttr(options.canonicalUrl)}">`,
    "Open Graph URL",
  );
  html = replaceRequired(
    html,
    /<meta property="og:title" content="[^"]*">/,
    `<meta property="og:title" content="${escapeAttr(socialTitle)}">`,
    "Open Graph title",
  );
  html = replaceRequired(
    html,
    /<meta property="og:description" content="[^"]*">/,
    `<meta property="og:description" content="${escapeAttr(options.description)}">`,
    "Open Graph description",
  );
  html = replaceRequired(
    html,
    /<meta name="twitter:title" content="[^"]*">/,
    `<meta name="twitter:title" content="${escapeAttr(socialTitle)}">`,
    "Twitter title",
  );
  html = replaceRequired(
    html,
    /<meta name="twitter:description" content="[^"]*">/,
    `<meta name="twitter:description" content="${escapeAttr(options.description)}">`,
    "Twitter description",
  );
  html = replaceRequired(
    html,
    /<h1 id="page-title"([^>]*)>[\s\S]*?<\/h1>/,
    `<h1 id="page-title"$1>${escapeHtml(options.h1)}</h1>`,
    "page H1",
  );
  html = replaceRequired(
    html,
    /<span id="statusText">[\s\S]*?<\/span>/,
    `<span id="statusText">${escapeHtml(statusText(feed))}</span>`,
    "status text",
  );
  html = replaceRequired(
    html,
    /<div class="health" id="healthStrip">[\s\S]*?<\/div>/,
    `<div class="health" id="healthStrip">${healthHtml(feed)}</div>`,
    "health strip",
  );
  html = replaceRequired(
    html,
    /<section class="top-news" id="topNews" aria-labelledby="top-news-title"(?: hidden)?>/,
    `<section class="top-news" id="topNews" aria-labelledby="top-news-title"${hasTopNews ? "" : " hidden"}>`,
    "top news section",
  );
  html = replaceRequired(
    html,
    /<div class="archive-banner" id="archiveBanner"(?: hidden)?>/,
    `<div class="archive-banner" id="archiveBanner"${options.archiveDate ? "" : " hidden"}>`,
    "archive banner",
  );
  html = replaceRequired(
    html,
    /<strong id="archiveDateLabel">[\s\S]*?<\/strong>/,
    `<strong id="archiveDateLabel">${escapeHtml(options.archiveDate ?? "")}</strong>`,
    "archive date label",
  );

  html = replaceBetween(html, TOP_NEWS_START, TOP_NEWS_END, renderTopNews(feed.top_news ?? []), "top news markers");
  html = replaceBetween(html, FEED_START, FEED_END, renderFeed(feed), "feed markers");
  html = replaceBetween(html, JSONLD_START, JSONLD_END, itemListJsonLd(feed, options.canonicalUrl), "JSON-LD markers");
  return html;
}

function renderTopNews(items: TopNewsItem[]): string {
  if (!items.length) return "";
  const [lead, ...rest] = items;
  return [
    renderTopStory(lead),
    `<div class="top-list">${rest.map(renderTopRow).join("\n")}</div>`,
  ].join("\n");
}

function renderTopStory(item: TopNewsItem): string {
  return [
    `<article class="top-story">`,
    `<div class="top-story-body">`,
    `<h2 class="top-story-title">${externalLink(item.url, item.title)}</h2>`,
    `<p class="top-story-dek">${escapeHtml(item.dek)}</p>`,
    item.brief && normalizeText(item.brief) !== normalizeText(item.dek)
      ? `<p class="top-story-brief">${escapeHtml(item.brief)}</p>`
      : "",
    `<div class="top-news-meta">${topNewsMeta(item)}</div>`,
    `</div>`,
    `</article>`,
  ].filter(Boolean).join("\n");
}

function renderTopRow(item: TopNewsItem): string {
  return [
    `<article class="top-row">`,
    `<div class="top-row-body">`,
    `<h3 class="top-row-title">${externalLink(item.url, item.title)}</h3>`,
    `<p class="top-row-dek">${escapeHtml(item.dek)}</p>`,
    `<div class="top-news-meta">${topNewsMeta(item)}</div>`,
    `</div>`,
    `</article>`,
  ].join("\n");
}

function renderFeed(feed: FeedFile): string {
  const items = feed.clusters ?? [];
  if (!items.length) {
    return `<div class="empty"><strong>No feed items</strong><p>The latest refresh did not publish ranked items.</p></div>`;
  }
  const now = Date.parse(feed.generated_at);
  const buckets = [
    { label: "Last 3 hours", items: [] as ScoredCluster[] },
    { label: "Earlier today", items: [] as ScoredCluster[] },
    { label: "Yesterday & older", items: [] as ScoredCluster[] },
  ];
  for (const item of items) {
    const age = (now - Date.parse(item.primary.published_at)) / 36e5;
    if (age <= 3) buckets[0].items.push(item);
    else if (age <= 24) buckets[1].items.push(item);
    else buckets[2].items.push(item);
  }

  const sections = buckets.flatMap((bucket) => {
    if (!bucket.items.length) return [];
    const sorted = bucket.items.sort((a, b) => b.score - a.score);
    return [
      `<div class="bucket-head">${escapeHtml(bucket.label)}<span class="count">(${bucket.items.length})</span></div>`,
      `<ol class="feed-list">${sorted.map((item, index) => `<li>${renderItem(item, index + 1)}</li>`).join("\n")}</ol>`,
    ];
  });
  sections.push(`<div class="completion-row"><strong>You're caught up</strong><span>Next refresh follows the public schedule.</span></div>`);
  return sections.join("\n");
}

function renderItem(item: ScoredCluster, index: number): string {
  const title = item.primary.title || "Untitled item";
  const line = readableLine(item.one_liner || item.primary.summary || "", title);
  const image = renderItemImage(item);
  return [
    `<article class="item${image ? " has-image" : ""}" data-tier="${item.novelty >= 0.7 ? "top" : "normal"}" data-read-index="${index}">`,
    `<div class="item-body">`,
    `<h3 class="item-title">${externalLink(item.primary.url, title)}</h3>`,
    line ? `<p class="item-line">${escapeHtml(line)}</p>` : "",
    `<div class="item-meta">${itemMeta(item)}</div>`,
    renderExplain(item),
    renderSourceTrail(item),
    `</div>`,
    image,
    `</article>`,
  ].filter(Boolean).join("\n");
}

function renderItemImage(item: ScoredCluster): string {
  const src = itemImageUrl(item);
  if (!src) return "";
  return `<img class="item-thumb" src="${escapeAttr(src)}" alt="${escapeAttr(imageAltText(item))}" width="352" height="220" loading="lazy" decoding="async" referrerpolicy="no-referrer" fetchpriority="low">`;
}

function itemImageUrl(item: ScoredCluster): string {
  for (const candidate of [item.primary, ...(item.members ?? [])]) {
    const src = safeImageUrl(candidate.image_url);
    if (src) return src;
  }
  return "";
}

function imageAltText(item: ScoredCluster): string {
  const title = compactText(item.primary.title || item.one_liner || "Chronicle item");
  return truncateText(`Thumbnail for ${title}`, 160);
}

function homeMetaDescription(): string {
  return "Chronicle is a daily AI signal filter for builders. Track AI news, model releases, papers, repos, and tutorials with repeated hype pushed down.";
}

function archiveMetaDescription(): string {
  return "Browse Chronicle's archived daily AI briefs, with past AI news, model releases, papers, repos, and learning links ranked for builders.";
}

function dailyMetaDescription(feed: FeedFile, date: string): string {
  const topics = feed.clusters
    .slice(0, 2)
    .map((item) => metaTopic(item))
    .filter(Boolean);
  const prefix = `${longDate(date)} Chronicle AI brief`;
  if (!topics.length) {
    return `${prefix}: ranked AI news, papers, model releases, repos, and learning links for builders.`;
  }
  const extraCount = Math.max(0, feed.clusters.length - topics.length);
  const extra = extraCount ? `, plus ${extraCount} more AI signals` : "";
  return truncateText(`${prefix}: ${topics.join(", ")}${extra}.`, 160);
}

function metaTopic(item: ScoredCluster): string {
  const title = item.primary.title || "";
  const line = readableLine(item.one_liner || item.primary.summary || "", title);
  return truncateText(compactText(line || title), 38);
}

function truncateText(value: string, maxLength: number): string {
  const text = compactText(value);
  if (text.length <= maxLength) return text;
  const clipped = text.slice(0, Math.max(0, maxLength - 1));
  const boundary = clipped.search(/\s+\S*$/);
  const trimmed = (boundary > maxLength * 0.62 ? clipped.slice(0, boundary) : clipped).trimEnd();
  return `${trimmed.replace(/[,:;.\s]+$/, "")}...`;
}

function compactText(value: string): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function itemMeta(item: ScoredCluster): string {
  const parts = [
    sourceLabelHtml(item.primary),
    escapeHtml(relativeDate(item.primary.published_at)),
    item.kind && item.kind !== "unknown" ? escapeHtml(item.kind.replaceAll("_", " ")) : "",
    item.primary.repo?.stargazers_count ? escapeHtml(`${formatNumber(item.primary.repo.stargazers_count)} stars`) : "",
    item.primary.repo?.stars_today ? escapeHtml(`+${formatNumber(item.primary.repo.stars_today)} stars today`) : "",
    !item.primary.repo?.stars_today && item.primary.repo?.stars_delta_30d
      ? escapeHtml(`+${formatNumber(item.primary.repo.stars_delta_30d)} stars`)
      : "",
  ].filter(Boolean);
  const score = Number.isFinite(item.score) ? item.score.toFixed(2) : "--";
  const detail = `n ${item.novelty.toFixed(2)} · t ${item.trust.toFixed(2)}`;
  return `${parts.join(`<span class="sep">·</span>`)}<span class="spacer"></span><span class="score">${score}</span><span class="score-detail">(${escapeHtml(detail)})</span>`;
}

function sourceLabelHtml(source: SourceGlyphContext): string {
  const name = escapeHtml(source.source_name || "Unknown source");
  return `<span class="source">${sourceGlyphSvg(sourceGlyphKind(source))}<span>${name}</span></span>`;
}

function sourceGlyphSvg(kind: SourceGlyphKind): string {
  switch (kind) {
    case "arxiv":
      return svgGlyph(kind, "0 0 17.732 24.269", `<path fill="currentColor" d="M573.549,280.916l2.266,2.738,6.674-7.84c.353-.47.52-.717.353-1.117a1.218,1.218,0,0,0-1.061-.748h0a.953.953,0,0,0-.712.262Z" transform="translate(-566.984 -271.548)"/><path fill="currentColor" d="M579.525,282.225l-10.606-10.174a1.413,1.413,0,0,0-.834-.5,1.09,1.09,0,0,0-1.027.66c-.167.4-.047.681.319,1.206l8.44,10.242h0l-6.282,7.716a1.336,1.336,0,0,0-.323,1.3,1.114,1.114,0,0,0,1.04.69A.992.992,0,0,0,571,293l8.519-7.92A1.924,1.924,0,0,0,579.525,282.225Z" transform="translate(-566.984 -271.548)"/><path fill="currentColor" d="M584.32,293.912l-8.525-10.275,0,0L573.53,280.9l-1.389,1.254a2.063,2.063,0,0,0,0,2.965l10.812,10.419a.925.925,0,0,0,.742.282,1.039,1.039,0,0,0,.953-.667A1.261,1.261,0,0,0,584.32,293.912Z" transform="translate(-566.984 -271.548)"/>`);
    case "reddit":
      return svgGlyph(kind, "0 0 24 24", `<path fill="currentColor" d="M12 0C5.373 0 0 5.373 0 12c0 3.314 1.343 6.314 3.515 8.485l-2.286 2.286C.775 23.225 1.097 24 1.738 24H12c6.627 0 12-5.373 12-12S18.627 0 12 0Zm4.388 3.199c1.104 0 1.999.895 1.999 1.999 0 1.105-.895 2-1.999 2-.946 0-1.739-.657-1.947-1.539v.002c-1.147.162-2.032 1.15-2.032 2.341v.007c1.776.067 3.4.567 4.686 1.363.473-.363 1.064-.58 1.707-.58 1.547 0 2.802 1.254 2.802 2.802 0 1.117-.655 2.081-1.601 2.531-.088 3.256-3.637 5.876-7.997 5.876-4.361 0-7.905-2.617-7.998-5.87-.954-.447-1.614-1.415-1.614-2.538 0-1.548 1.255-2.802 2.803-2.802.645 0 1.239.218 1.712.585 1.275-.79 2.881-1.291 4.64-1.365v-.01c0-1.663 1.263-3.034 2.88-3.207.188-.911.993-1.595 1.959-1.595Zm-8.085 8.376c-.784 0-1.459.78-1.506 1.797-.047 1.016.64 1.429 1.426 1.429.786 0 1.371-.369 1.418-1.385.047-1.017-.553-1.841-1.338-1.841Zm7.406 0c-.786 0-1.385.824-1.338 1.841.047 1.017.634 1.385 1.418 1.385.785 0 1.473-.413 1.426-1.429-.046-1.017-.721-1.797-1.506-1.797Zm-3.703 4.013c-.974 0-1.907.048-2.77.135-.147.015-.241.168-.183.305.483 1.154 1.622 1.964 2.953 1.964 1.33 0 2.47-.81 2.953-1.964.057-.137-.037-.29-.184-.305-.863-.087-1.795-.135-2.769-.135Z"/>`);
    case "youtube":
      return svgGlyph(kind, "0 0 24 24", `<rect x="3.5" y="6.5" width="17" height="11" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path fill="currentColor" d="M10.4 9.25v5.5L15.25 12l-4.85-2.75Z"/>`);
    case "github":
      return svgGlyph(kind, "0 0 24 24", `<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M7 4.5h9.5a2 2 0 0 1 2 2v13H8a2.5 2.5 0 0 1 0-5h10.5M7 4.5a2 2 0 0 0-2 2v10.5M9 8h6"/>`);
    case "huggingface":
      return svgGlyph(kind, "0 0 24 24", `<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M5.5 13.5c-.9-3.5 1.6-7 6.5-7s7.4 3.5 6.5 7c-.5 3.3-2.9 5.5-6.5 5.5s-6-2.2-6.5-5.5Z"/><circle cx="8.8" cy="10.5" r="1.05" fill="currentColor"/><circle cx="15.2" cy="10.5" r="1.05" fill="currentColor"/><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.8" d="M8.4 15c1.1 1.25 2.3 1.85 3.6 1.85s2.5-.6 3.6-1.85"/>`);
    case "hacker-news":
      return svgGlyph(kind, "0 0 24 24", `<rect x="4.5" y="4.5" width="15" height="15" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M8.5 8l3.5 4 3.5-4M12 12v4"/>`);
    case "openai":
      return svgGlyph(kind, "0 0 24 24", `<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.7" d="M12 3.5l1.5 4 4 1.5-4 1.5-1.5 4-1.5-4-4-1.5 4-1.5L12 3.5ZM5 16.5l.65 1.85L7.5 19l-1.85.65L5 21.5l-.65-1.85L2.5 19l1.85-.65L5 16.5ZM18.5 14l.45 1.25 1.3.5-1.3.5-.45 1.25-.5-1.25-1.25-.5 1.25-.5.5-1.25Z"/>`);
    case "news":
      return svgGlyph(kind, "0 0 24 24", `<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M4.5 6.5h15v10.8a1.7 1.7 0 0 1-1.7 1.7H6.2a1.7 1.7 0 0 1-1.7-1.7V6.5ZM7.5 10h4.5M7.5 13h9M7.5 16h7M14.5 9.5H17v2.5h-2.5z"/>`);
    case "discussion":
      return svgGlyph(kind, "0 0 24 24", `<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M5 6.5h10a2.5 2.5 0 0 1 2.5 2.5v3.5A2.5 2.5 0 0 1 15 15H8l-3 3v-3.2A2.5 2.5 0 0 1 2.5 12.3V9A2.5 2.5 0 0 1 5 6.5ZM8 10h5M8 12.8h3.5"/>`);
    case "feed":
      return svgGlyph(kind, "0 0 24 24", `<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.9" d="M5 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM4 10a10 10 0 0 1 10 10M4 5a15 15 0 0 1 15 15"/>`);
  }
}

function svgGlyph(kind: SourceGlyphKind, viewBox: string, content: string): string {
  return `<svg class="source-glyph" data-source-glyph="${kind}" viewBox="${viewBox}" aria-hidden="true" focusable="false">${content}</svg>`;
}

function sourceGlyphKind(source: SourceGlyphContext): SourceGlyphKind {
  const values = [
    source.source_id,
    source.source_name,
    source.url,
    source.original_url,
    source.discussion_url,
    source.discussion_source,
  ].filter(Boolean).join(" ").toLowerCase();
  const sourceId = String(source.source_id ?? "").toLowerCase();
  const sourceName = String(source.source_name ?? "").toLowerCase();
  if (sourceId.startsWith("r_") || sourceName.startsWith("r/") || values.includes("reddit.com")) return "reddit";
  if (sourceId.startsWith("arxiv_") || sourceName.startsWith("arxiv") || values.includes("arxiv.org")) return "arxiv";
  if (sourceId.startsWith("yt_") || values.includes("youtube") || values.includes("youtu.be")) return "youtube";
  if (sourceId.startsWith("github_") || sourceId.startsWith("repo_") || values.includes("github.com") || /\breleases\b/.test(sourceName)) return "github";
  if (sourceId.startsWith("hf_") || values.includes("hugging face") || values.includes("huggingface.co")) return "huggingface";
  if (sourceId.startsWith("hn_") || values.includes("hacker news") || values.includes("news.ycombinator.com")) return "hacker-news";
  if (sourceId === "openai" || sourceName.startsWith("openai") || values.includes("openai.com")) return "openai";
  if (sourceId.includes("lobsters") || values.includes("lobste.rs")) return "discussion";
  if (/(infoq|techcrunch|decoder|wired|venturebeat|verge)/.test(values)) return "news";
  return "feed";
}

function renderExplain(item: ScoredCluster): string {
  const reasons = item.why_this_surfaced ?? [];
  if (!reasons.length && !item.builder_action) return "";
  return [
    `<details class="item-explain">`,
    `<summary>why surfaced · ${escapeHtml(item.novelty_label ?? "signal")}</summary>`,
    `<ul>`,
    ...reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`),
    item.builder_action ? `<li>${escapeHtml(item.builder_action)}</li>` : "",
    `</ul>`,
    `</details>`,
  ].filter(Boolean).join("\n");
}

function renderSourceTrail(item: ScoredCluster): string {
  const trail = item.source_trail?.length ? item.source_trail : [];
  if (trail.length <= 1 && item.primary.date_confidence === "high") return "";
  return [
    `<details class="item-also">`,
    `<summary>source trail · ${trail.length}</summary>`,
    `<ul class="also-list">`,
    ...trail.map((source) => [
      `<li>`,
      externalLink(source.url, source.source_name || "source"),
      `<span class="also-meta">${escapeHtml(shortDate(source.published_at))} · ${escapeHtml(source.date_confidence || "unknown")} date</span>`,
      source.title && source.title !== item.primary.title ? `<span class="also-title">${escapeHtml(source.title)}</span>` : "",
      `</li>`,
    ].filter(Boolean).join("")),
    `</ul>`,
    `</details>`,
  ].join("\n");
}

function renderArchiveDays(days: ArchiveDay[]): string {
  if (!days.length) {
    return `<div class="empty"><strong>No archived days yet</strong><p>Chronicle will add daily snapshots after refreshes.</p></div>`;
  }
  const groups = new Map<string, ArchiveDay[]>();
  for (const day of days) {
    const key = day.date.slice(0, 7);
    groups.set(key, [...(groups.get(key) ?? []), day]);
  }
  return [...groups.values()].map((group) => renderArchiveMonth(group)).join("\n");
}

function renderArchiveMonth(group: ArchiveDay[]): string {
  const total = group.reduce((sum, day) => sum + day.count, 0);
  const first = new Date(`${group[0].date}T00:00:00Z`);
  return [
    `<section class="month-section">`,
    `<div class="month-head">`,
    `<h2 class="month-name">${escapeHtml(first.toLocaleDateString("en", { month: "long", year: "numeric", timeZone: "UTC" }))}</h2>`,
    `<span class="month-stats">${group.length} day${group.length === 1 ? "" : "s"} · ${total} items</span>`,
    `</div>`,
    `<div class="day-grid">`,
    ...group.map((day) => [
      `<a class="day-cell" data-weight="${archiveWeight(day.count)}" href="./${escapeAttr(day.date)}/" title="${escapeAttr(day.title)}">`,
      `<span class="day-date">${escapeHtml(dayLabel(day.date))}</span>`,
      `<span class="day-count">${day.count} item${day.count === 1 ? "" : "s"}</span>`,
      `</a>`,
    ].join("")),
    `</div>`,
    `</section>`,
  ].join("\n");
}

function renderRss(feed: FeedFile): string {
  const items = feed.clusters.slice(0, 60).map((item) => [
    "    <item>",
    `      <title>${escapeXml(item.primary.title)}</title>`,
    `      <link>${escapeXml(item.primary.url)}</link>`,
    `      <guid isPermaLink="false">${escapeXml(item.id)}</guid>`,
    `      <pubDate>${new Date(item.primary.published_at).toUTCString()}</pubDate>`,
    `      <description>${escapeXml(item.one_liner || item.primary.summary || item.primary.title)}</description>`,
    "    </item>",
  ].join("\n")).join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0">',
    "  <channel>",
    "    <title>Chronicle - daily AI signal</title>",
    `    <link>${SITE_URL}</link>`,
    "    <description>Daily AI signal for builders, clustered and ranked.</description>",
    `    <lastBuildDate>${new Date(feed.generated_at).toUTCString()}</lastBuildDate>`,
    items,
    "  </channel>",
    "</rss>",
    "",
  ].join("\n");
}

function renderAtom(feed: FeedFile): string {
  const updated = feed.generated_at;
  const entries = feed.clusters.slice(0, 60).map((item) => [
    "  <entry>",
    `    <title>${escapeXml(item.primary.title)}</title>`,
    `    <link href="${escapeXml(item.primary.url)}"/>`,
    `    <id>chronicle:${escapeXml(item.id)}</id>`,
    `    <updated>${escapeXml(item.primary.published_at)}</updated>`,
    `    <summary>${escapeXml(item.one_liner || item.primary.summary || item.primary.title)}</summary>`,
    "  </entry>",
  ].join("\n")).join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    "  <title>Chronicle - daily AI signal</title>",
    `  <link href="${SITE_URL}atom.xml" rel="self"/>`,
    `  <link href="${SITE_URL}"/>`,
    `  <id>${SITE_URL}</id>`,
    `  <updated>${escapeXml(updated)}</updated>`,
    entries,
    "</feed>",
    "",
  ].join("\n");
}

function itemListJsonLd(feed: FeedFile, url: string): string {
  const data = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "Chronicle AI signal brief",
    url,
    datePublished: feed.generated_at,
    numberOfItems: feed.clusters.length,
    itemListElement: feed.clusters.slice(0, 20).map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      url: item.primary.url,
      name: item.primary.title,
      description: item.one_liner || item.primary.summary || undefined,
    })),
  };
  return `<script type="application/ld+json">${escapeScriptJson(data)}</script>`;
}

function archiveJsonLd(days: ArchiveDay[], generatedAt: string): string {
  const data = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "Chronicle archive",
    url: `${SITE_URL}daily/`,
    dateModified: generatedAt,
    hasPart: days.slice(0, 30).map((day) => ({
      "@type": "WebPage",
      url: `${SITE_URL}${day.path}`,
      name: `Chronicle AI Brief, ${longDate(day.date)}`,
    })),
  };
  return `<script type="application/ld+json">${escapeScriptJson(data)}</script>`;
}

function feedSchema(): Record<string, unknown> {
  return {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": `${SITE_URL}feed.schema.json`,
    title: "Chronicle Feed",
    type: "object",
    required: [
      "generated_at", "last_successful_generated_at", "refresh_status",
      "classification_mode", "window_hours", "source_total", "source_ok",
      "source_failed", "failed_sources", "source_health", "count", "clusters",
    ],
    properties: {
      generated_at: { type: "string", format: "date-time" },
      last_successful_generated_at: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
      refresh_status: { enum: ["ok", "partial", "failed"] },
      classification_mode: { enum: ["llm", "partial", "fallback", "deterministic"] },
      window_hours: { type: "number" },
      source_total: { type: "number" },
      source_ok: { type: "number" },
      source_failed: { type: "number" },
      failed_sources: { type: "array" },
      source_health: { type: "array" },
      count: { type: "number" },
      top_news: { type: "array" },
      clusters: {
        type: "array",
        items: {
          type: "object",
          required: [
            "id", "primary", "members", "source_trail", "kind", "quality",
            "one_liner", "novelty", "novelty_label", "trust", "score",
            "why_this_surfaced", "builder_action",
          ],
        },
      },
    },
  };
}

function replaceRequired(html: string, pattern: RegExp, replacement: string, label: string): string {
  if (!pattern.test(html)) {
    throw new Error(`static template is missing ${label}`);
  }
  return html.replace(pattern, replacement);
}

function replaceBetween(html: string, start: string, end: string, content: string, label: string): string {
  const pattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`);
  if (!pattern.test(html)) {
    throw new Error(`static template is missing ${label}`);
  }
  return html.replace(pattern, `${start}\n${content}\n${end}`);
}

function statusText(feed: FeedFile): string {
  const updated = relativeDate(feed.generated_at);
  const parts = [`${feed.count} ${itemCountLabel(feed.count)}`, `updated ${updated}`];
  if (feed.refresh_status === "failed") {
    parts.push("refresh failed");
  } else if (feed.source_failed > 0) {
    parts.push(sourceSkipSummary(feed.source_failed));
  }
  return parts.join(" · ");
}

function healthHtml(feed: FeedFile): string {
  const tail = [];
  if (feed.classification_mode !== "llm") tail.push(`classify ${feed.classification_mode}`);
  tail.push(`window ${feed.window_hours}h`);
  const sourceDetails = feed.source_failed > 0 ? sourceFailureDetailsHtml(feed) : "";
  return [
    `<strong>${feed.source_ok}/${feed.source_total} sources</strong>`,
    sourceDetails,
    tail.length ? escapeHtml(tail.join(" · ")) : "",
  ].filter(Boolean).join(" · ");
}

function sourceSkipSummary(count: number): string {
  return `${count} source${count === 1 ? "" : "s"} skipped`;
}

function itemCountLabel(count: number): string {
  return count === 1 ? "item" : "items";
}

function sourceFailureDetailsHtml(feed: FeedFile): string {
  const failed = feed.failed_sources ?? [];
  const rows = failed.length
    ? failed.map((source) => {
      const name = source.name || source.id || "Unknown source";
      const message = compactErrorMessage(source.message);
      return `<span class="source-details-row"><strong>${escapeHtml(name)}</strong>${message ? `: ${escapeHtml(message)}` : ""}</span>`;
    }).join("")
    : `<span class="source-details-row">${escapeHtml(sourceSkipSummary(feed.source_failed))}</span>`;
  return [
    `<details class="source-details">`,
    `<summary>${escapeHtml(sourceSkipSummary(feed.source_failed))}</summary>`,
    `<span class="source-details-body">`,
    `<span class="source-details-context">Feed refreshed from ${feed.source_ok}/${feed.source_total} sources.</span>`,
    `<span class="source-details-list">${rows}</span>`,
    `</span>`,
    `</details>`,
  ].join("");
}

function compactErrorMessage(message: string | undefined): string {
  return String(message ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function topNewsMeta(item: TopNewsItem): string {
  return [
    sourceLabelHtml(item),
    escapeHtml(relativeDate(item.published_at)),
    item.kind && item.kind !== "unknown" ? escapeHtml(item.kind.replaceAll("_", " ")) : "",
    Number.isFinite(item.score) ? item.score.toFixed(2) : "",
  ].filter(Boolean).join(`<span class="sep">·</span>`);
}

function externalLink(url: string, label: string): string {
  const href = safeHttpUrl(url) || "#";
  const attrs = href === "#"
    ? ""
    : ` target="_blank" rel="noopener noreferrer"`;
  return `<a href="${escapeAttr(href)}"${attrs}>${escapeHtml(label || url)}</a>`;
}

function readableLine(line: string, title: string): string {
  const normalizedLine = normalizeText(line);
  const normalizedTitle = normalizeText(title);
  if (!normalizedLine || normalizedLine === normalizedTitle) return "";
  if (normalizedTitle && normalizedLine.startsWith(normalizedTitle)) return "";
  return line;
}

function archiveMeta(days: ArchiveDay[]): string {
  if (!days.length) return "No archived days yet.";
  const newest = days[0].date;
  const oldest = days.at(-1)?.date ?? newest;
  const total = days.reduce((sum, day) => sum + day.count, 0);
  return `${days.length} days · ${oldest} -> ${newest} · ${total} items`;
}

function archiveWeight(count: number): string {
  if (count >= 60) return "high";
  if (count >= 45) return "medium";
  return "low";
}

function dayLabel(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en", {
    weekday: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function longDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function relativeDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown";
  return date.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function shortDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown";
  return date.toISOString().slice(0, 10);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function safeHttpUrl(value: string): string {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function safeImageUrl(value: string | undefined): string {
  try {
    const parsed = new URL(String(value || ""));
    return parsed.protocol === "https:" ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function normalizeText(value: string): string {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function escapeHtml(value: string): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}

function escapeXml(value: string): string {
  return stripInvalidXmlChars(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function stripInvalidXmlChars(value: string): string {
  const input = String(value ?? "");
  let output = "";
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if ((code >= 0x00 && code <= 0x08) || code === 0x0B || code === 0x0C || (code >= 0x0E && code <= 0x1F)) {
      continue;
    }
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = input.charCodeAt(i + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        output += input[i] + input[i + 1];
        i++;
      }
      continue;
    }
    if (code >= 0xDC00 && code <= 0xDFFF) continue;
    output += input[i];
  }
  return output;
}

function escapeScriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
