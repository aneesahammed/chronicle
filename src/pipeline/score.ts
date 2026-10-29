import { builderValue, instructionalIntent } from "./quality-policy.ts";
import { canonicalizeUrl } from "./canonicalize.ts";
import type { Cluster, NoveltyLabel, Quality, ScoredCluster } from "../types.ts";
import type { Classification } from "../llm/classify.ts";

// Composite ranking score, not factual confidence. Evaluate changes on the editorial corpus.
// Keep changes reviewable against the versioned usefulness regression corpus.

const W = {
  trust:      0.20,
  novelty:    0.20,
  quality:    0.25,
  cluster:    0.05,  // distinct articles; discussion reposts add no weight
  recency:    0.07,
  engagement: 0.03,
  builder:    0.20,
};

const QUALITY_VALUE: Record<Quality, number> = {
  signal: 1.0,
  mixed:  0.55,
  hype:   0.15,
};

export function scoreCluster(
  c: Cluster,
  cls: Classification,
  noveltyScore: number,
  now: Date,
): ScoredCluster {
  const trust = c.primary.trust;
  const quality = QUALITY_VALUE[cls.quality];
  // sqrt squashes big clusters so a 10-source pile-up doesn't dominate.
  const cluster = Math.min(1, Math.sqrt(new Set(c.members.map((member) => canonicalizeUrl(member.url))).size) / 3);
  const ageHours =
    (now.getTime() - new Date(c.primary.discovered_at ?? c.primary.published_at).getTime()) / 3.6e6;
  const recency = Math.max(0, Math.min(1, 1 - ageHours / 48));
  const engagement = engagementSignal(c);
  const repoVelocity = cls.kind === "repo_trending" ? repoTrendingVelocitySignal(c) : 0;

  const baseScore =
    W.trust   * trust +
    W.novelty * noveltyScore +
    W.quality * quality +
    W.cluster * cluster +
    W.recency * recency +
    W.engagement * engagement +
    W.builder * builderValue(c);
  const score = clamp(baseScore + repoVelocity * 0.12 - qualityPenalty(c, cls, noveltyScore));
  const novelty_label = noveltyLabel(noveltyScore);

  return {
    ...c,
    kind: cls.kind,
    quality: cls.quality,
    one_liner: cls.one_liner,
    classification_method: cls.classification_method,
    classification_reason: cls.classification_reason,
    classification_provider: cls.classification_provider,
    classification_model: cls.classification_model,
    novelty: round(noveltyScore),
    novelty_label,
    trust: round(trust),
    score: round(score),
    why_this_surfaced: whyThisSurfaced(c, cls, noveltyScore, recency, engagement),
    builder_action: builderAction(c),
  };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function clamp(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function noveltyLabel(novelty: number): NoveltyLabel {
  if (novelty >= 0.75) return "high";
  if (novelty >= 0.45) return "medium";
  return "familiar";
}

function engagementSignal(c: Cluster): number {
  const signals = c.members.map((member) => member.engagement ?? {});
  const score = Math.max(0, ...signals.map((engagement) => engagement.score ?? 0));
  const comments = Math.max(0, ...signals.map((engagement) => engagement.comments ?? 0));
  const scoreSignal = Math.log10(score + 1) / 3;
  const commentSignal = Math.log10(comments + 1) / 2.5;
  return clamp(Math.max(scoreSignal, commentSignal));
}

function repoTrendingVelocitySignal(c: Cluster): number {
  const starsToday = Math.max(0, ...c.members.map((member) => member.repo?.stars_today ?? 0));
  return clamp(Math.log10(starsToday + 1) / 3);
}

function qualityPenalty(c: Cluster, cls: Classification, noveltyScore: number): number {
  let penalty = 0;
  if (cls.kind === "discussion" && c.members.length === 1 && engagementSignal(c) < 0.25) {
    penalty += 0.08;
  }
  if (c.primary.date_confidence === "low") penalty += 0.04;
  if (cls.quality === "mixed" && noveltyScore < 0.35 && c.members.length === 1) {
    penalty += 0.05;
  }
  return penalty;
}

function whyThisSurfaced(
  c: Cluster,
  cls: Classification,
  noveltyScore: number,
  recency: number,
  engagement: number,
): string[] {
  const reasons: string[] = [];
  if (builderValue(c) >= 0.8) reasons.push("specific engineering subject or instructional task in source metadata");
  const novelty = noveltyLabel(noveltyScore);
  if (novelty === "high") reasons.push("high novelty against the 30-day history");
  else if (novelty === "medium") reasons.push("meaningfully different from recent coverage");
  else reasons.push("kept for context despite familiar coverage");

  if (cls.quality === "signal") reasons.push("classified as concrete builder or research signal");
  else if (cls.quality === "mixed") reasons.push("classified as useful but lower-confidence signal");
  else reasons.push("kept only because multiple signals offset hype risk");

  const feeds = new Set(c.members.map((member) => member.source_id)).size;
  if (feeds > 1) reasons.push(`seen on ${feeds} feeds; not independent verification`);
  if (c.primary.discovery_reason) reasons.push(`${c.primary.discovery_reason === "trending" ? "trending observed" : "listed on Daily Papers"} ${c.primary.discovered_at?.slice(0, 10)}; publication date preserved`);
  if (cls.kind === "repo_trending" && repoTrendingVelocitySignal(c) >= 0.55) {
    reasons.push("high daily GitHub star velocity");
  }
  if (c.primary.trust >= 0.85) reasons.push("primary source has high trust weight");
  if (recency >= 0.85) reasons.push("fresh within the current refresh window");
  if (engagement >= 0.55) reasons.push("source-native discussion or engagement is unusually high");
  return reasons.slice(0, 6);
}

function builderAction(cluster: Cluster): string {
  const item = cluster.primary;
  const repo = item.repo;
  if (repo) return `Review ${repo.full_name}: ${repo.license && repo.license !== "NOASSERTION" ? `license ${repo.license}` : "license not established"}; ${repo.has_readme ? "README available" : "README not verified"}. Check usage and maintenance before adopting.`;
  const summary = item.summary?.trim() ?? "";
  if (summary.length < 40) return "";
  if (item.source_role === "learning" && instructionalIntent(item.title, summary)) {
    return "Work through the instructional example; check the source description for prerequisites.";
  }
  const text = `${item.title} ${summary}`;
  if (/\b(deprecat\w*|breaking changes?|migrat\w*)\b/i.test(text)) {
    return "Check the migration or deprecation details against your current integrations.";
  }
  if (/\b(benchmarks?|evaluat\w*|datasets?)\b/i.test(text)) {
    return "Inspect the evaluation setup, data and baselines before applying the reported results.";
  }
  if (/\b(licen[cs]e|open weights)\b/i.test(text)) {
    return "Read the source's license and usage conditions before adopting the release.";
  }
  if (/\b(latency|throughput|memory usage|kv cache)\b/i.test(text)) {
    return "Compare the reported performance conditions with your hardware and workload.";
  }
  // Withhold a next step when metadata does not support a specific review task.
  return "";
}
