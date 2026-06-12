import { promises as fs } from "node:fs";
import path from "node:path";
import { jaccard, trigrams } from "./cluster.ts";
import { writeJsonAtomic } from "./atomic-write.ts";
import type { Cluster, HistoryFile } from "../types.ts";

const HISTORY_DAYS = 30;

export async function loadHistory(historyPath: string): Promise<HistoryFile> {
  try {
    const buf = await fs.readFile(historyPath, "utf8");
    return JSON.parse(buf) as HistoryFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`[history] could not read ${historyPath}; starting with empty history`, error);
    }
    return { entries: [] };
  }
}

export function pruneHistory(h: HistoryFile, today: Date): HistoryFile {
  const cutoff = new Date(today);
  cutoff.setUTCDate(cutoff.getUTCDate() - HISTORY_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  return { entries: h.entries.filter((e) => e.date >= cutoffStr) };
}

// Trigram sets per history entry, computed once per HistoryFile instead of
// once per cluster (novelty is called ~300 times per run against the same
// ~1800-entry history).
const historyTrigramCache = new WeakMap<HistoryFile, Set<string>[]>();

function historyTrigrams(history: HistoryFile): Set<string>[] {
  let tris = historyTrigramCache.get(history);
  if (!tris) {
    tris = history.entries.map((e) => trigrams(e.title));
    historyTrigramCache.set(history, tris);
  }
  return tris;
}

// novelty in [0, 1]: 1 = never seen, 0 = identical to a recent item.
export function novelty(title: string, history: HistoryFile, today?: Date): number {
  if (history.entries.length === 0) return 1;
  const todayStr = today?.toISOString().slice(0, 10);
  const t = trigrams(title);
  const tris = historyTrigrams(history);
  let max = 0;
  for (let i = 0; i < history.entries.length; i++) {
    if (todayStr && history.entries[i].date === todayStr) continue;
    const sim = jaccard(t, tris[i]);
    if (sim > max) max = sim;
    if (max >= 0.95) break;
  }
  return Math.max(0, 1 - max);
}

export function appendToHistory(
  h: HistoryFile,
  clusters: Cluster[],
  today: Date,
): HistoryFile {
  const date = today.toISOString().slice(0, 10);
  const seen = new Set(h.entries.map((e) => e.id));
  const next = [...h.entries];
  for (const c of clusters) {
    if (seen.has(c.primary.id)) continue;
    next.push({
      id: c.primary.id,
      title: c.primary.title,
      url: c.primary.url,
      date,
    });
  }
  return { entries: next };
}

export async function saveHistory(historyPath: string, h: HistoryFile) {
  await fs.mkdir(path.dirname(historyPath), { recursive: true });
  await writeJsonAtomic(historyPath, h);
}
