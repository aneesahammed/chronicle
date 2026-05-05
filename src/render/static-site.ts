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
    title: "Chronicle - daily AI signal",
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
  const html = replaceBetween(template, ARCHIVE_START, ARCHIVE_END, renderArchiveDays(days))
    .replace(
      /<p class="lede-meta" id="ledeMeta">[\s\S]*?<\/p>/,
      `<p class="lede-meta" id="ledeMeta">${escapeHtml(meta)}</p>`,
    )
    .replace(
      /<meta property="og:url" content="[^"]*">/,
      `<meta property="og:url" content="${SITE_URL}daily/">`,
    )
    .replace(
      /<link rel="canonical" href="[^"]*">/,
      `<link rel="canonical" href="${SITE_URL}daily/">`,
    );
  const next = replaceBetween(html, JSONLD_START, JSONLD_END, archiveJsonLd(days, generatedAt));
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
  options: { canonicalUrl: string; title: string; archiveDate?: string },
): string {
  const hasTopNews = Boolean(feed.top_news?.length);
  let html = template
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(options.title)}</title>`)
    .replace(/<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${escapeAttr(options.canonicalUrl)}">`)
    .replace(/<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${escapeAttr(options.canonicalUrl)}">`)
    .replace(/<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${escapeAttr(options.archiveDate ? options.title : "Chronicle")}">`)
    .replace(
      /<span id="statusText">[\s\S]*?<\/span>/,
      `<span id="statusText">${escapeHtml(statusText(feed))}</span>`,
    )
    .replace(
      /<div class="health" id="healthStrip">[\s\S]*?<\/div>/,
      `<div class="health" id="healthStrip">${healthHtml(feed)}</div>`,
    )
    .replace(
      /<section class="top-news" id="topNews" aria-labelledby="top-news-title"(?: hidden)?>/,
      `<section class="top-news" id="topNews" aria-labelledby="top-news-title"${hasTopNews ? "" : " hidden"}>`,
    )
    .replace(
      /<div class="archive-banner" id="archiveBanner"(?: hidden)?>/,
      `<div class="archive-banner" id="archiveBanner"${options.archiveDate ? "" : " hidden"}>`,
    )
    .replace(
      /<strong id="archiveDateLabel">[\s\S]*?<\/strong>/,
      `<strong id="archiveDateLabel">${escapeHtml(options.archiveDate ?? "")}</strong>`,
    );

  html = replaceBetween(html, TOP_NEWS_START, TOP_NEWS_END, renderTopNews(feed.top_news ?? []));
  html = replaceBetween(html, FEED_START, FEED_END, renderFeed(feed));
  html = replaceBetween(html, JSONLD_START, JSONLD_END, itemListJsonLd(feed, options.canonicalUrl));
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
  return [
    `<article class="item" data-tier="${item.novelty >= 0.7 ? "top" : "normal"}" data-read-index="${index}">`,
    `<h3 class="item-title">${externalLink(item.primary.url, title)}</h3>`,
    line ? `<p class="item-line">${escapeHtml(line)}</p>` : "",
    `<div class="item-meta">${itemMeta(item)}</div>`,
    renderExplain(item),
    renderSourceTrail(item),
    `</article>`,
  ].filter(Boolean).join("\n");
}

function itemMeta(item: ScoredCluster): string {
  const parts = [
    `<span class="source">${escapeHtml(item.primary.source_name || "Unknown source")}</span>`,
    escapeHtml(relativeDate(item.primary.published_at)),
    item.kind && item.kind !== "unknown" ? escapeHtml(item.kind.replaceAll("_", " ")) : "",
  ].filter(Boolean);
  const score = Number.isFinite(item.score) ? item.score.toFixed(2) : "--";
  const detail = `n ${item.novelty.toFixed(2)} · t ${item.trust.toFixed(2)}`;
  return `${parts.join(`<span class="sep">·</span>`)}<span class="spacer"></span><span class="score">${score}</span><span class="score-detail">(${escapeHtml(detail)})</span>`;
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

function replaceBetween(html: string, start: string, end: string, content: string): string {
  const pattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`);
  if (!pattern.test(html)) return html;
  return html.replace(pattern, `${start}\n${content}\n${end}`);
}

function statusText(feed: FeedFile): string {
  const updated = relativeDate(feed.generated_at);
  return `${feed.count} items · updated ${updated}`;
}

function healthHtml(feed: FeedFile): string {
  const tail = [];
  if (feed.source_failed) tail.push(`${feed.source_failed} failed`);
  if (feed.classification_mode !== "llm") tail.push(`classify ${feed.classification_mode}`);
  tail.push(`window ${feed.window_hours}h`);
  return `<strong>${feed.source_ok}/${feed.source_total} sources</strong> · ${escapeHtml(tail.join(" · "))}`;
}

function topNewsMeta(item: TopNewsItem): string {
  return [
    `<span class="source">${escapeHtml(item.source_name || "Unknown source")}</span>`,
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

function safeHttpUrl(value: string): string {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : "";
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
    .replace(/>/g, "&gt;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

function escapeXml(value: string): string {
  return escapeAttr(value).replace(/'/g, "&apos;");
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
