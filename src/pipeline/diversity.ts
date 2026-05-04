import type { ScoredCluster } from "../types.ts";
import sourceFamilyConfig from "./source-family-config.json" with { type: "json" };

// Calibrated from the 2026-05-04 arXiv takeover: the adjacent arXiv scores were
// tightly packed, so the penalty needs to be small enough to preserve relevance
// while still letting close non-arXiv items interleave.
const FAMILY_PENALTY = 0.015;
const EXCEPTIONAL_SCORE = 0.90;
const ARXIV_CAP_RATIO = 0.25;
const DEFAULT_FAMILY_CAP_RATIO = 0.40;
const EXCEPTION_CAP_RATIO = 0.05;
const warnedUnmappedSources = new Set<string>();

interface SourceFamilyConfig {
  prefixFamilies: Array<{ prefix: string; family: string }>;
  sourceFamilies: Record<string, string>;
}

const FAMILY_CONFIG = sourceFamilyConfig as SourceFamilyConfig;

export interface DiversitySelectionOptions {
  maxOutput: number;
}

export function selectDiverseClusters(
  clusters: ScoredCluster[],
  options: DiversitySelectionOptions,
): ScoredCluster[] {
  const maxOutput = Math.max(0, Math.floor(options.maxOutput));
  if (maxOutput === 0 || clusters.length === 0) return [];

  const remaining = [...clusters].sort((a, b) => b.score - a.score);
  const selected: ScoredCluster[] = [];
  const familyCounts = new Map<string, number>();

  while (selected.length < maxOutput && remaining.length > 0) {
    const index = bestCandidateIndex(remaining, familyCounts, maxOutput);
    if (index < 0) break;
    const [picked] = remaining.splice(index, 1);
    selected.push(picked);
    const family = sourceFamily(picked.primary.source_id);
    familyCounts.set(family, (familyCounts.get(family) ?? 0) + 1);
  }

  return selected;
}

export function sourceFamily(sourceId: string): string {
  for (const { prefix, family } of FAMILY_CONFIG.prefixFamilies) {
    if (sourceId.startsWith(prefix)) return family;
  }
  const configured = FAMILY_CONFIG.sourceFamilies[sourceId];
  if (configured) return configured;
  if (!warnedUnmappedSources.has(sourceId)) {
    warnedUnmappedSources.add(sourceId);
    console.warn(`[diversity] source "${sourceId}" is not mapped in source-family-config.json; using source id as family`);
  }
  return sourceId;
}

export function sourceFamilyMix(clusters: ScoredCluster[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const cluster of clusters) {
    const family = sourceFamily(cluster.primary.source_id);
    counts[family] = (counts[family] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
}

function bestCandidateIndex(
  candidates: ScoredCluster[],
  familyCounts: Map<string, number>,
  maxOutput: number,
): number {
  let bestIndex = -1;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const family = sourceFamily(candidate.primary.source_id);
    const count = familyCounts.get(family) ?? 0;
    if (!withinFamilyCap(candidate, count, maxOutput)) continue;

    const effectiveScore = candidate.score - count * FAMILY_PENALTY;
    if (effectiveScore > bestScore) {
      bestScore = effectiveScore;
      bestIndex = i;
    }
  }

  return bestIndex;
}

function withinFamilyCap(candidate: ScoredCluster, familyCount: number, maxOutput: number): boolean {
  const family = sourceFamily(candidate.primary.source_id);
  const cap = familyCap(family, maxOutput);
  if (familyCount < cap) return true;

  const exceptionCap = cap + Math.max(1, Math.ceil(maxOutput * EXCEPTION_CAP_RATIO));
  return candidate.score >= EXCEPTIONAL_SCORE && familyCount < exceptionCap;
}

function familyCap(family: string, maxOutput: number): number {
  if (family === "arxiv") return ratioCap(maxOutput, ARXIV_CAP_RATIO);
  return ratioCap(maxOutput, DEFAULT_FAMILY_CAP_RATIO);
}

function ratioCap(maxOutput: number, ratio: number): number {
  return Math.max(1, Math.floor(maxOutput * ratio));
}
