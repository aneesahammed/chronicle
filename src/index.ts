import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { fetchAll } from "./sources/fetchers.ts";
import { clusterItems } from "./pipeline/cluster.ts";
import {
  appendToHistory, loadHistory, novelty, pruneHistory, saveHistory,
} from "./pipeline/novelty.ts";
import {
  classifyClusters,
  classifyClustersDeterministically,
  type ClassificationResult,
} from "./llm/classify.ts";
import { createLlmProviders, type LlmProvider } from "./llm/providers.ts";
import { scoreCluster } from "./pipeline/score.ts";
import { selectDiverseClusters, sourceFamilyMix } from "./pipeline/diversity.ts";
import { writeFileAtomic, writeJsonAtomic } from "./pipeline/atomic-write.ts";
import { buildTopNews } from "./enrichment/top-news.ts";
import {
  writeArchiveIndexPage,
  writeFeedSchema,
  writeRenderedDailyPage,
  writeRenderedHomePage,
  writeSyndicationFeeds,
} from "./render/static-site.ts";
import {
  sourceRoleOf,
  type Cluster,
  type FeedFile,
  type FetchResult,
  type HistoryFile,
  type RawItem,
  type Registry,
  type SourceFetchFailure,
  type SourceHealth,
  type SourceRole,
  type TopNewsItem,
} from "./types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const REGISTRY = path.join(__dirname, "sources/registry.yaml");
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const SITE_URL = "https://chronicle.tinycrafts.ai/";

const DEFAULT_WINDOW_HOURS = 36;
const DEFAULT_REPO_WINDOW_HOURS = 168;
const DEFAULT_LEARNING_WINDOW_HOURS = 720;
const DEFAULT_MAX_OUTPUT = 60;
const MIN_ARCHIVE_PRUNE_KEEP_DAYS = 7;
const MAX_ARCHIVE_PRUNE_FRACTION = 0.25;

async function main() {
  await runPipeline();
}

interface RunPipelineOptions {
  now?: Date;
  registryPath?: string;
  publicDir?: string;
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  providers?: LlmProvider[];
}

export async function runPipeline(options: RunPipelineOptions = {}) {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const registryPath = options.registryPath ?? REGISTRY;
  const publicDir = options.publicDir ?? PUBLIC_DIR;
  const dataDir = options.dataDir ?? DATA_DIR;
  const feedOut = path.join(publicDir, "feed.json");
  const repoFeedOut = path.join(publicDir, "repos.json");
  const learningFeedOut = path.join(publicDir, "learning.json");
  const historyOut = path.join(dataDir, "history.json");
  const repoHistoryOut = path.join(dataDir, "repo-history.json");
  const enrichmentsOut = path.join(dataDir, "enrichments.json");
  const windowHours = readPositiveNumber(env, "WINDOW_HOURS", DEFAULT_WINDOW_HOURS);
  const repoWindowHours = readPositiveNumber(env, "REPO_WINDOW_HOURS", DEFAULT_REPO_WINDOW_HOURS);
  const learningWindowHours = readPositiveNumber(env, "LEARNING_WINDOW_HOURS", DEFAULT_LEARNING_WINDOW_HOURS);
  const mainMaxOutput = readNonNegativeInteger(env, "MAX_OUTPUT", DEFAULT_MAX_OUTPUT);
  const repoMaxOutput = readNonNegativeInteger(env, "REPO_MAX_OUTPUT", 40);
  const learningMaxOutput = readNonNegativeInteger(env, "LEARNING_MAX_OUTPUT", 40);

  console.log(`[run] ${now.toISOString()}  window=${windowHours}h repo_window=${repoWindowHours}h learning_window=${learningWindowHours}h`);

  const reg = YAML.parse(await fs.readFile(registryPath, "utf8")) as Registry;
  const previous = await loadExistingFeed(feedOut);
  const providers = options.providers ?? createLlmProviders(env);
  console.log(`[llm] providers=${providers.map((provider) => `${provider.name}:${provider.model}`).join(",") || "fallback"}`);

  // 1. Fetch
  const fetched = await fetchAll(reg, { env, now });
  const items = fetched.items;
  console.log(`[fetch] ${items.length} items from ${fetched.source_ok}/${fetched.source_total} sources`);

  // 2. Role-specific window filters
  const cutoff = now.getTime() - windowHours * 3.6e6;
  const repoCutoff = now.getTime() - repoWindowHours * 3.6e6;
  const learningCutoff = now.getTime() - learningWindowHours * 3.6e6;
  const allByRole = splitItemsByRole(items);
  const byRole = {
    main: freshItems(allByRole.main, cutoff),
    repo: freshItems(allByRole.repo, repoCutoff),
    learning: freshItems(allByRole.learning, learningCutoff),
  };
  console.log(`[window:main] ${byRole.main.length} items within ${windowHours}h`);
  console.log(`[window:repo] ${byRole.repo.length} items within ${repoWindowHours}h`);
  console.log(`[window:learning] ${byRole.learning.length} items within ${learningWindowHours}h`);

  const history = pruneHistory(await loadHistory(historyOut), now);
  const roleFetch = splitFetchResultByRole(fetched, reg);
  const repoHistory = await loadRepoHistory(repoHistoryOut);
  const repoItems = applyRepoHistory(byRole.repo, repoHistory, now, repoCutoff);
  const previousRepoFeed = await loadExistingFeed(repoFeedOut);
  const previousLearningFeed = await loadExistingFeed(learningFeedOut);

  const mainFeed = await buildRoleFeed({
    role: "main",
    items: byRole.main,
    healthItems: allByRole.main,
    fetched: roleFetch.main,
    previous,
    now,
    windowHours,
    maxOutput: mainMaxOutput,
    history,
    providers,
    topNews: { cachePath: enrichmentsOut, env },
  });
  const mainClusters = clusterItems(byRole.main);
  const updated = appendToHistory(history, mainClusters, now);
  await saveHistory(historyOut, updated);
  console.log(`[write] ${historyOut}  entries=${updated.entries.length}`);
  await writeFeed(feedOut, mainFeed);
  await writeRenderedHomePage(publicDir, mainFeed);
  await writeSyndicationFeeds(publicDir, mainFeed);
  await writeFeedSchema(publicDir);
  if (mainFeed.refresh_status !== "failed") {
    await writeArchiveOutputs(publicDir, mainFeed);
  }

  const repoFeed = await buildRoleFeed({
    role: "repo",
    items: repoItems,
    healthItems: allByRole.repo,
    fetched: roleFetch.repo,
    previous: previousRepoFeed,
    now,
    windowHours: repoWindowHours,
    maxOutput: repoMaxOutput,
    history: roleHistory("repo", previousRepoFeed, history),
    providers,
  });
  await writeFeed(repoFeedOut, repoFeed);
  await saveRepoHistory(repoHistoryOut, pruneRepoHistory(repoHistory, now));

  const learningFeed = await buildRoleFeed({
    role: "learning",
    items: byRole.learning,
    healthItems: allByRole.learning,
    fetched: roleFetch.learning,
    previous: previousLearningFeed,
    now,
    windowHours: learningWindowHours,
    maxOutput: learningMaxOutput,
    history: roleHistory("learning", previousLearningFeed, history),
    providers,
  });
  await writeFeed(learningFeedOut, learningFeed);
}

function freshItems(items: RawItem[], cutoff: number): RawItem[] {
  return items.filter((it) => new Date(it.published_at).getTime() >= cutoff);
}

async function buildRoleFeed(options: {
  role: SourceRole;
  items: RawItem[];
  healthItems?: RawItem[];
  fetched: FetchResult;
  previous: FeedFile | null;
  now: Date;
  windowHours: number;
  maxOutput: number;
  history: HistoryFile;
  providers: LlmProvider[];
  topNews?: { cachePath: string; env: NodeJS.ProcessEnv };
}): Promise<FeedFile> {
  const sourceHealth = enrichSourceHealth(
    options.fetched.source_health,
    options.healthItems ?? options.items,
    options.now.getTime() - options.windowHours * 3.6e6,
  );
  const clusters = clusterItems(options.items);
  console.log(`[cluster:${options.role}] ${options.items.length} → ${clusters.length} clusters`);

  const preclassified = classifyClustersDeterministically(clusters);

  if (clusters.length === 0 && options.previous && options.previous.clusters.length > 0) {
    return previousFeed(options.previous, {
      now: options.now,
      windowHours: options.windowHours,
      fetched: { ...options.fetched, source_health: sourceHealth },
      classificationMode: options.previous.classification_mode ?? "fallback",
      reason: "refresh produced zero clusters",
    });
  }

  const noveltyByClusterId = new Map<string, number>();
  const preliminaryScored = clusters
    .map((c, i) => {
      const noveltyScore = novelty(c.primary.title, options.history, options.now);
      noveltyByClusterId.set(c.id, noveltyScore);
      return scoreCluster(c, preclassified.items[i], noveltyScore, options.now);
    })
    .filter((s) => !(s.quality === "hype" && s.members.length < 2));
  const candidates = selectDiverseClusters(preliminaryScored, { maxOutput: options.maxOutput });
  let classificationMode: ClassificationResult["mode"] = preclassified.mode;
  let scored = candidates;

  if (options.role === "main" && candidates.length > 0 && options.providers.length > 0) {
    console.log(`[classify:${options.role}] ${candidates.length}/${clusters.length} candidate clusters selected for LLM`);
    const cls = await classifyClusters(candidates, options.providers);
    classificationMode = cls.mode;
    scored = candidates
      .map((c, i) => scoreCluster(c, cls.items[i], noveltyByClusterId.get(c.id) ?? c.novelty, options.now))
      .filter((s) => !(s.quality === "hype" && s.members.length < 2));
  }

  const selected = selectDiverseClusters(scored, { maxOutput: options.maxOutput });

  console.log(`[score:${options.role}] kept ${selected.length} after filtering`);
  console.log(`[diversity:${options.role}] ${JSON.stringify(sourceFamilyMix(selected))}`);

  if (selected.length === 0 && options.previous && options.previous.clusters.length > 0) {
    return previousFeed(options.previous, {
      now: options.now,
      windowHours: options.windowHours,
      fetched: { ...options.fetched, source_health: sourceHealth },
      classificationMode,
      reason: "refresh produced zero scored items",
    });
  }

  const topNews = options.topNews
    ? await buildTopNewsSafely(selected, {
      now: options.now,
      cachePath: options.topNews.cachePath,
      env: options.topNews.env,
      providers: options.providers,
    })
    : [];

  return {
    generated_at: options.now.toISOString(),
    last_successful_generated_at: selected.length
      ? options.now.toISOString()
      : options.previous?.last_successful_generated_at ?? options.previous?.generated_at ?? null,
    refresh_status: refreshStatus(selected.length, options.fetched),
    classification_mode: classificationMode,
    window_hours: options.windowHours,
    source_total: options.fetched.source_total,
    source_ok: options.fetched.source_ok,
    source_failed: options.fetched.source_failed,
    failed_sources: options.fetched.failed_sources,
    source_health: sourceHealth,
    ...(topNews.length ? { top_news: topNews } : {}),
    count: selected.length,
    clusters: selected,
  };
}

function splitItemsByRole(items: RawItem[]): Record<SourceRole, RawItem[]> {
  return {
    main: items.filter((item) => sourceRoleOf(item) === "main"),
    repo: items.filter((item) => sourceRoleOf(item) === "repo"),
    learning: items.filter((item) => sourceRoleOf(item) === "learning"),
  };
}

function splitFetchResultByRole(fetched: FetchResult, reg: Registry): Record<SourceRole, FetchResult> {
  const sourceRoles = new Map(reg.sources.map((source) => [source.id, (source.source_role ?? "main") as SourceRole]));
  return {
    main: fetchResultForRole("main", fetched, sourceRoles),
    repo: fetchResultForRole("repo", fetched, sourceRoles),
    learning: fetchResultForRole("learning", fetched, sourceRoles),
  };
}

function fetchResultForRole(
  role: SourceRole,
  fetched: FetchResult,
  sourceRoles: Map<string, SourceRole>,
): FetchResult {
  const sourceIds = new Set(
    [...sourceRoles.entries()]
      .filter(([, sourceRole]) => sourceRole === role)
      .map(([id]) => id),
  );
  const items = fetched.items.filter((item) => sourceRoleOf(item) === role);
  const failed_sources = fetched.failed_sources.filter((source) => sourceIds.has(source.id));
  const source_health = fetched.source_health.filter((source) => sourceIds.has(source.id));
  return {
    items,
    source_total: sourceIds.size,
    source_ok: sourceIds.size - failed_sources.length,
    source_failed: failed_sources.length,
    failed_sources,
    source_health,
  };
}

function refreshStatus(selectedCount: number, fetched: FetchResult): FeedFile["refresh_status"] {
  if (selectedCount === 0 && fetched.source_total > 0 && fetched.source_ok === 0) return "failed";
  if (fetched.source_failed > 0) return "partial";
  return "ok";
}

interface RepoHistoryEntry {
  full_name: string;
  first_seen_at: string;
  last_seen_at: string;
  stargazers_count: number;
}

interface RepoHistoryFile {
  repos: Record<string, RepoHistoryEntry>;
}

async function loadRepoHistory(repoHistoryOut: string): Promise<RepoHistoryFile> {
  try {
    const parsed = JSON.parse(await fs.readFile(repoHistoryOut, "utf8")) as RepoHistoryFile;
    return { repos: parsed.repos && typeof parsed.repos === "object" ? parsed.repos : {} };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { repos: {} };
    }
    throw new Error(`could not read repo history ${repoHistoryOut}: ${(error as Error).message}`);
  }
}

function previousFeedHistory(feed: FeedFile | null): HistoryFile {
  if (!feed) return { entries: [] };
  return {
    entries: feed.clusters.map((cluster) => ({
      id: cluster.primary.id,
      title: cluster.primary.title,
      url: cluster.primary.url,
      date: cluster.primary.published_at.slice(0, 10),
    })),
  };
}

function roleHistory(role: SourceRole, previous: FeedFile | null, mainHistory: HistoryFile): HistoryFile {
  if (role === "main") return mainHistory;
  return previousFeedHistory(previous);
}

function applyRepoHistory(
  items: RawItem[],
  history: RepoHistoryFile,
  now: Date,
  cutoff: number,
): RawItem[] {
  const nowIso = now.toISOString();
  const seenThisRun = new Set<string>();
  const out: RawItem[] = [];

  for (const item of items) {
    const repo = item.repo;
    const fullName = repo?.full_name;
    if (!fullName) {
      out.push(item);
      continue;
    }
    const previous = history.repos[fullName];
    const firstSeenAt = previous?.first_seen_at ?? nowIso;
    const currentStars = item.repo?.stargazers_count ?? previous?.stargazers_count ?? 0;
    const starsDelta = previous ? Math.max(0, currentStars - previous.stargazers_count) : 0;

    history.repos[fullName] = {
      full_name: fullName,
      first_seen_at: firstSeenAt,
      last_seen_at: nowIso,
      stargazers_count: currentStars,
    };

    if (item.kind_hint === "repo_trending") {
      if (seenThisRun.has(fullName)) continue;
      seenThisRun.add(fullName);
      if (Date.parse(firstSeenAt) < cutoff) continue;
    }

    out.push({
      ...item,
      repo: {
        full_name: repo.full_name,
        html_url: repo.html_url,
        description: repo.description,
        language: repo.language,
        license: repo.license,
        topics: repo.topics,
        stargazers_count: repo.stargazers_count,
        forks_count: repo.forks_count,
        open_issues_count: repo.open_issues_count,
        pushed_at: repo.pushed_at,
        created_at: repo.created_at,
        release_tag: repo.release_tag,
        release_name: repo.release_name,
        stars_delta_30d: starsDelta,
      },
    });
  }

  return out;
}

function pruneRepoHistory(history: RepoHistoryFile, now: Date): RepoHistoryFile {
  const cutoff = now.getTime() - 90 * 864e5;
  const repos: RepoHistoryFile["repos"] = {};
  for (const [fullName, entry] of Object.entries(history.repos)) {
    if (Date.parse(entry.last_seen_at) >= cutoff) repos[fullName] = entry;
  }
  return { repos };
}

async function saveRepoHistory(repoHistoryOut: string, history: RepoHistoryFile) {
  await fs.mkdir(path.dirname(repoHistoryOut), { recursive: true });
  await writeJsonAtomic(repoHistoryOut, history);
  console.log(`[write] ${repoHistoryOut}  repos=${Object.keys(history.repos).length}`);
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

function previousFeed(
  previousFeed: FeedFile,
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
): FeedFile {
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
  console.warn(`[write] preserved previous feed because ${options.reason}`);
  return preserved;
}

async function writeFeed(feedOut: string, feed: FeedFile) {
  await fs.mkdir(path.dirname(feedOut), { recursive: true });
  await writeJsonAtomic(feedOut, feed);
  console.log(`[write] ${feedOut}`);
}

async function buildTopNewsSafely(
  scored: FeedFile["clusters"],
  options: {
    now: Date;
    cachePath: string;
    env: NodeJS.ProcessEnv;
    providers?: LlmProvider[];
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

function readPositiveNumber(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const value = env[key];
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${key} must be a positive number; received ${JSON.stringify(value)}`);
  }
  return parsed;
}

function readNonNegativeInteger(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const value = env[key];
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
    throw new Error(`${key} must be a non-negative integer; received ${JSON.stringify(value)}`);
  }
  return parsed;
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
  await writeJsonAtomic(dayFeedPath, feed);
  console.log(`[write] ${dayFeedPath}`);

  await writeRenderedDailyPage(publicDir, feed);

  const indexPath = path.join(dailyDir, "index.json");
  const previous = await readArchiveIndex(indexPath);
  const existingDays = await readArchiveDirs(dailyDir);
  const day: ArchiveDay = {
    date,
    generated_at: feed.generated_at,
    count: feed.count,
    title: feed.clusters[0]?.primary.title ?? "Chronicle",
    path: `daily/${date}/`,
    feed_path: `daily/${date}/feed.json`,
  };
  const previousDays = mergeArchiveDays([...previous.days, ...existingDays]);
  const days = [day, ...previousDays.filter((entry) => entry.date !== date)]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 120);
  const nextIndex: ArchiveIndex = { generated_at: feed.generated_at, days };
  await fs.mkdir(dailyDir, { recursive: true });
  await writeJsonAtomic(indexPath, nextIndex);
  console.log(`[write] ${indexPath}`);
  await writeArchiveIndexPage(publicDir, days, feed.generated_at);
  await pruneArchiveDirs(dailyDir, days);
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

async function readArchiveDirs(dailyDir: string): Promise<ArchiveDay[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dailyDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const days = await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) return null;
    const feedPath = path.join(dailyDir, entry.name, "feed.json");
    try {
      const feed = JSON.parse(await fs.readFile(feedPath, "utf8")) as FeedFile;
      return {
        date: entry.name,
        generated_at: feed.generated_at,
        count: feed.count,
        title: feed.clusters[0]?.primary.title ?? "Chronicle",
        path: `daily/${entry.name}/`,
        feed_path: `daily/${entry.name}/feed.json`,
      };
    } catch {
      return null;
    }
  }));
  return days.filter((day): day is ArchiveDay => Boolean(day));
}

function mergeArchiveDays(days: ArchiveDay[]): ArchiveDay[] {
  const byDate = new Map<string, ArchiveDay>();
  for (const day of days) {
    const existing = byDate.get(day.date);
    if (!existing || day.generated_at > existing.generated_at) {
      byDate.set(day.date, day);
    }
  }
  return [...byDate.values()];
}

async function pruneArchiveDirs(dailyDir: string, days: ArchiveDay[]) {
  const keep = new Set(days.map((day) => day.date));
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dailyDir, { withFileTypes: true });
  } catch {
    return;
  }
  const archiveDirs = entries.filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name));
  const deletions = archiveDirs.filter((entry) => !keep.has(entry.name));
  if (!deletions.length) return;
  if (keep.size < MIN_ARCHIVE_PRUNE_KEEP_DAYS) {
    console.warn(`[archive] skipped pruning ${deletions.length} stale archive dirs; only ${keep.size} retained days are known`);
    return;
  }
  const maxDeletes = Math.max(3, Math.floor(archiveDirs.length * MAX_ARCHIVE_PRUNE_FRACTION));
  if (deletions.length > maxDeletes) {
    console.warn(`[archive] skipped pruning ${deletions.length} stale archive dirs; safety limit is ${maxDeletes}`);
    return;
  }
  await Promise.all(deletions.map(async (entry) => {
    await fs.rm(path.join(dailyDir, entry.name), { recursive: true, force: true });
    console.log(`[archive] pruned ${path.join(dailyDir, entry.name)}`);
  }));
}

async function writeRobotsAndSitemap(publicDir: string, days: ArchiveDay[], generatedAt: string) {
  const robots = [
    "User-agent: *",
    "Allow: /",
    `Sitemap: ${SITE_URL}sitemap.xml`,
    "",
  ].join("\n");
  await writeFileAtomic(path.join(publicDir, "robots.txt"), robots);

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
  await writeFileAtomic(path.join(publicDir, "sitemap.xml"), sitemap);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
