import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { fetchAll } from "./sources/fetchers.ts";
import { clusterItems } from "./pipeline/cluster.ts";
import {
  appendToHistory, loadHistory, novelty, pruneHistory, saveHistory,
} from "./pipeline/novelty.ts";
import { classifyClusters } from "./llm/classify.ts";
import { scoreCluster } from "./pipeline/score.ts";
import { buildTopNews } from "./enrichment/top-news.ts";
import type { FeedFile, Registry, SourceHealth, TopNewsItem } from "./types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const REGISTRY = path.join(__dirname, "sources/registry.yaml");
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const FEED_OUT = path.join(PUBLIC_DIR, "feed.json");
const HISTORY_OUT = path.join(DATA_DIR, "history.json");
const SITE_URL = "https://chronicle.tinycrafts.ai/";

const WINDOW_HOURS = Number(process.env.WINDOW_HOURS ?? "36");
const MAX_OUTPUT = Number(process.env.MAX_OUTPUT ?? "60");

async function main() {
  await runPipeline();
}

interface RunPipelineOptions {
  now?: Date;
  registryPath?: string;
  publicDir?: string;
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
}

export async function runPipeline(options: RunPipelineOptions = {}) {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const registryPath = options.registryPath ?? REGISTRY;
  const publicDir = options.publicDir ?? PUBLIC_DIR;
  const dataDir = options.dataDir ?? DATA_DIR;
  const feedOut = path.join(publicDir, "feed.json");
  const historyOut = path.join(dataDir, "history.json");
  const enrichmentsOut = path.join(dataDir, "enrichments.json");
  const windowHours = Number(env.WINDOW_HOURS ?? WINDOW_HOURS);
  const maxOutput = Number(env.MAX_OUTPUT ?? MAX_OUTPUT);

  console.log(`[run] ${now.toISOString()}  window=${windowHours}h`);

  const reg = YAML.parse(await fs.readFile(registryPath, "utf8")) as Registry;
  const previous = await loadExistingFeed(feedOut);

  // 1. Fetch
  const fetched = await fetchAll(reg);
  const items = fetched.items;
  console.log(`[fetch] ${items.length} items from ${fetched.source_ok}/${fetched.source_total} sources`);

  // 2. Window filter
  const cutoff = now.getTime() - windowHours * 3.6e6;
  const fresh = items.filter(
    (it) => new Date(it.published_at).getTime() >= cutoff,
  );
  const sourceHealth = enrichSourceHealth(fetched.source_health, items, cutoff);
  console.log(`[window] ${fresh.length} items within ${windowHours}h`);

  // 3. Cluster
  const clusters = clusterItems(fresh);
  console.log(`[cluster] ${fresh.length} → ${clusters.length} clusters`);

  // 4. Classify with chunked LLM calls, falling back if the API is unavailable.
  const cls = await classifyClusters(clusters, env.GROQ_API_KEY);

  // 5. Novelty against history
  const history = pruneHistory(await loadHistory(historyOut), now);

  if (clusters.length === 0 && previous && previous.clusters.length > 0) {
    await preservePreviousFeed(previous, feedOut, publicDir, {
      now,
      windowHours,
      fetched: { ...fetched, source_health: sourceHealth },
      classificationMode: previous.classification_mode ?? "fallback",
      reason: "refresh produced zero clusters",
    });
    return;
  }

  // 6. Score & rank
  const scored = clusters
    .map((c, i) => scoreCluster(c, cls.items[i], novelty(c.primary.title, history, now), now))
    // A single source can be fresh and still be low-signal. Keep hype only when
    // another source corroborates the cluster.
    .filter((s) => !(s.quality === "hype" && s.members.length < 2))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxOutput);

  console.log(`[score] kept ${scored.length} after filtering`);

  if (scored.length === 0 && previous && previous.clusters.length > 0) {
    await preservePreviousFeed(previous, feedOut, publicDir, {
      now,
      windowHours,
      fetched: { ...fetched, source_health: sourceHealth },
      classificationMode: cls.mode,
      reason: "refresh produced zero scored items",
    });
    const updated = appendToHistory(history, clusters, now);
    await saveHistory(historyOut, updated);
    console.log(`[write] ${historyOut}  entries=${updated.entries.length}`);
    return;
  }

  const topNews = await buildTopNewsSafely(scored, {
    now,
    cachePath: enrichmentsOut,
    env,
  });

  // 7. Emit feed
  const feed: FeedFile = {
    generated_at: now.toISOString(),
    last_successful_generated_at: scored.length
      ? now.toISOString()
      : previous?.last_successful_generated_at ?? previous?.generated_at ?? null,
    refresh_status: scored.length === 0 ? "failed" : fetched.source_failed > 0 ? "partial" : "ok",
    classification_mode: cls.mode,
    window_hours: windowHours,
    source_total: fetched.source_total,
    source_ok: fetched.source_ok,
    source_failed: fetched.source_failed,
    failed_sources: fetched.failed_sources,
    source_health: sourceHealth,
    ...(topNews.length ? { top_news: topNews } : {}),
    count: scored.length,
    clusters: scored,
  };
  await fs.mkdir(publicDir, { recursive: true });
  await fs.writeFile(feedOut, JSON.stringify(feed, null, 2));
  console.log(`[write] ${feedOut}`);
  if (feed.refresh_status !== "failed") {
    await writeArchiveOutputs(publicDir, feed);
  }

  // 8. Update history (using the *clustered, classified* items, not the
  //    final filtered output, so we don't re-surface a hype item tomorrow)
  const updated = appendToHistory(history, clusters, now);
  await saveHistory(historyOut, updated);
  console.log(`[write] ${historyOut}  entries=${updated.entries.length}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}

async function loadExistingFeed(feedPath: string): Promise<FeedFile | null> {
  try {
    return JSON.parse(await fs.readFile(feedPath, "utf8")) as FeedFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`[feed] could not read existing feed ${feedPath}; continuing without previous feed`, error);
    }
    return null;
  }
}

async function preservePreviousFeed(
  previousFeed: FeedFile,
  feedOut: string,
  publicDir: string,
  options: {
    now: Date;
    windowHours: number;
    fetched: {
      source_total: number;
      source_ok: number;
      source_failed: number;
      failed_sources: FeedFile["failed_sources"];
      source_health?: SourceHealth[];
    };
    classificationMode: FeedFile["classification_mode"];
    reason: string;
  },
) {
  const preserved: FeedFile = {
    generated_at: options.now.toISOString(),
    last_successful_generated_at:
      previousFeed.last_successful_generated_at ?? previousFeed.generated_at ?? null,
    refresh_status: "failed",
    classification_mode: options.classificationMode,
    window_hours: options.windowHours,
    source_total: options.fetched.source_total,
    source_ok: options.fetched.source_ok,
    source_failed: options.fetched.source_failed,
    failed_sources: options.fetched.failed_sources,
    source_health: options.fetched.source_health ?? [],
    ...(previousFeed.top_news?.length ? { top_news: previousFeed.top_news } : {}),
    count: previousFeed.clusters.length,
    clusters: previousFeed.clusters,
  };
  await fs.mkdir(publicDir, { recursive: true });
  await fs.writeFile(feedOut, JSON.stringify(preserved, null, 2));
  console.warn(`[write] preserved previous feed because ${options.reason}`);
}

async function buildTopNewsSafely(
  scored: FeedFile["clusters"],
  options: {
    now: Date;
    cachePath: string;
    env: NodeJS.ProcessEnv;
  },
): Promise<TopNewsItem[]> {
  try {
    const topNews = await buildTopNews(scored, options);
    console.log(`[top-news] kept ${topNews.length}`);
    return topNews;
  } catch (error) {
    console.warn(`[top-news] enrichment skipped: ${(error as Error).message}`);
    return [];
  }
}

function enrichSourceHealth(
  health: SourceHealth[],
  items: { source_id: string; published_at: string }[],
  cutoff: number,
): SourceHealth[] {
  const bySource = new Map<string, { fresh: number; stale: number; dates: string[] }>();
  for (const item of items) {
    const bucket = bySource.get(item.source_id) ?? { fresh: 0, stale: 0, dates: [] };
    const published = Date.parse(item.published_at);
    if (Number.isFinite(published)) {
      bucket.dates.push(new Date(published).toISOString());
      if (published >= cutoff) bucket.fresh++;
      else bucket.stale++;
    } else {
      bucket.stale++;
    }
    bySource.set(item.source_id, bucket);
  }

  return health.map((source) => {
    const stats = bySource.get(source.id) ?? { fresh: 0, stale: 0, dates: [] };
    const sortedDates = [...stats.dates].sort();
    return {
      ...source,
      fresh_count: stats.fresh,
      stale_count: stats.stale,
      oldest_published_at: sortedDates[0],
      newest_published_at: sortedDates.at(-1),
    };
  });
}

interface ArchiveIndex {
  generated_at: string;
  days: ArchiveDay[];
}

interface ArchiveDay {
  date: string;
  generated_at: string;
  count: number;
  title: string;
  path: string;
  feed_path: string;
}

async function writeArchiveOutputs(publicDir: string, feed: FeedFile) {
  const date = feed.generated_at.slice(0, 10);
  const dailyDir = path.join(publicDir, "daily");
  const dayDir = path.join(dailyDir, date);
  const dayFeedPath = path.join(dayDir, "feed.json");
  await fs.mkdir(dayDir, { recursive: true });
  await fs.writeFile(dayFeedPath, JSON.stringify(feed, null, 2));
  console.log(`[write] ${dayFeedPath}`);

  // Per-day snapshots reuse the main feed template; the daily index page is a
  // bespoke archive grid (public/daily/index.html) that we never overwrite here.
  await copyArchiveShell(publicDir, dayDir);

  const indexPath = path.join(dailyDir, "index.json");
  const previous = await readArchiveIndex(indexPath);
  const day: ArchiveDay = {
    date,
    generated_at: feed.generated_at,
    count: feed.count,
    title: feed.clusters[0]?.primary.title ?? "Chronicle",
    path: `daily/${date}/`,
    feed_path: `daily/${date}/feed.json`,
  };
  const days = [day, ...previous.days.filter((entry) => entry.date !== date)]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 120);
  const nextIndex: ArchiveIndex = { generated_at: feed.generated_at, days };
  await fs.mkdir(dailyDir, { recursive: true });
  await fs.writeFile(indexPath, JSON.stringify(nextIndex, null, 2));
  console.log(`[write] ${indexPath}`);
  await writeRobotsAndSitemap(publicDir, days, feed.generated_at);
}

async function readArchiveIndex(indexPath: string): Promise<ArchiveIndex> {
  try {
    const parsed = JSON.parse(await fs.readFile(indexPath, "utf8")) as ArchiveIndex;
    return {
      generated_at: parsed.generated_at,
      days: Array.isArray(parsed.days) ? parsed.days : [],
    };
  } catch {
    return { generated_at: "", days: [] };
  }
}

async function copyArchiveShell(publicDir: string, targetDir: string) {
  try {
    const html = await fs.readFile(path.join(publicDir, "index.html"), "utf8");
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(path.join(targetDir, "index.html"), html);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function writeRobotsAndSitemap(publicDir: string, days: ArchiveDay[], generatedAt: string) {
  const robots = [
    "User-agent: *",
    "Allow: /",
    `Sitemap: ${SITE_URL}sitemap.xml`,
    "",
  ].join("\n");
  await fs.writeFile(path.join(publicDir, "robots.txt"), robots);

  const urls = [
    { loc: SITE_URL, lastmod: generatedAt },
    { loc: `${SITE_URL}daily/`, lastmod: generatedAt },
    ...days.map((day) => ({
      loc: `${SITE_URL}${day.path}`,
      lastmod: day.generated_at,
    })),
  ];
  const sitemap = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map((url) => [
      "  <url>",
      `    <loc>${escapeXml(url.loc)}</loc>`,
      `    <lastmod>${escapeXml(url.lastmod)}</lastmod>`,
      "  </url>",
    ].join("\n")),
    "</urlset>",
    "",
  ].join("\n");
  await fs.writeFile(path.join(publicDir, "sitemap.xml"), sitemap);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
