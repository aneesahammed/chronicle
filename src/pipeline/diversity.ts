import type { ScoredCluster } from "../types.ts";

const FAMILY_PENALTY = 0.015;
const EXCEPTIONAL_SCORE = 0.90;
const ARXIV_CAP_RATIO = 0.25;
const EXCEPTION_CAP_RATIO = 0.05;

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
  if (sourceId.startsWith("arxiv_")) return "arxiv";
  if (sourceId.startsWith("r_") || sourceId === "lobsters_ai") return "discussion";
  if (sourceId.startsWith("hf_")) return "huggingface";
  if (sourceId === "hn_ai") return "hacker_news";
  if (["openai", "deepmind", "anthropic", "mistral"].includes(sourceId)) return "labs";
  if (["techcrunch_ai", "the_decoder", "mit_tech_review_ai", "ars_ai", "infoq_ai", "the_verge_ai", "wired_ai", "nine_to_five_google_ai"].includes(sourceId)) {
    return "reporting";
  }
  if (["simonw", "latent_space", "interconnects", "import_ai", "eugene_yan", "hamel", "lilian_weng", "chip_huyen", "daniel_miessler"].includes(sourceId)) {
    return "builders";
  }
  if (["together", "modal", "cursor", "product_hunt", "stackoverflow_blog"].includes(sourceId)) return "tools";
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
  return maxOutput;
}

function ratioCap(maxOutput: number, ratio: number): number {
  return Math.max(1, Math.floor(maxOutput * ratio));
}
