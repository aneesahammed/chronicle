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
import type { FeedFile, Registry } from "./types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const REGISTRY = path.join(__dirname, "sources/registry.yaml");
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const FEED_OUT = path.join(PUBLIC_DIR, "feed.json");
const HISTORY_OUT = path.join(DATA_DIR, "history.json");

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
  console.log(`[window] ${fresh.length} items within ${windowHours}h`);

  // 3. Cluster
  const clusters = clusterItems(fresh);
  console.log(`[cluster] ${fresh.length} → ${clusters.length} clusters`);

  // 4. Classify with chunked LLM calls, falling back if the API is unavailable.
  const cls = await classifyClusters(clusters, env.ANTHROPIC_API_KEY);

  // 5. Novelty against history
  const history = pruneHistory(await loadHistory(historyOut), now);

  if (clusters.length === 0 && (previous?.clusters.length ?? 0) > 0) {
    const previousFeed = previous as FeedFile;
    const preserved: FeedFile = {
      generated_at: now.toISOString(),
      last_successful_generated_at:
        previousFeed.last_successful_generated_at ?? previousFeed.generated_at ?? null,
      refresh_status: "failed",
      classification_mode: previousFeed.classification_mode ?? "fallback",
      window_hours: windowHours,
      source_total: fetched.source_total,
      source_ok: fetched.source_ok,
      source_failed: fetched.source_failed,
      failed_sources: fetched.failed_sources,
      count: previousFeed.clusters.length,
      clusters: previousFeed.clusters,
    };
    await fs.mkdir(publicDir, { recursive: true });
    await fs.writeFile(feedOut, JSON.stringify(preserved, null, 2));
    console.warn("[write] preserved previous feed because refresh produced zero clusters");
    return;
  }

  // 6. Score & rank
  const scored = clusters
    .map((c, i) => scoreCluster(c, cls.items[i], novelty(c.primary.title, history, now), now))
    // Drop hard hype unless it's somehow novel + cluster-confirmed
    .filter((s) => !(s.quality === "hype" && s.score < 0.4))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxOutput);

  console.log(`[score] kept ${scored.length} after filtering`);

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
    count: scored.length,
    clusters: scored,
  };
  await fs.mkdir(publicDir, { recursive: true });
  await fs.writeFile(feedOut, JSON.stringify(feed, null, 2));
  console.log(`[write] ${feedOut}`);

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
