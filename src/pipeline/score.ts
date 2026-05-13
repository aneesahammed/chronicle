import type { Cluster, Kind, NoveltyLabel, Quality, ScoredCluster } from "../types.ts";
import type { Classification } from "../llm/classify.ts";

// Composite score in [0, 1]. Tunable weights. Eyeball the output and adjust.
//
// We deliberately keep this simple. The point of v1 is the *pipeline*, not
// a learned ranker. Once you've used the feed for two weeks you'll know
// which knob to turn.

const W = {
  trust:      0.23,
  novelty:    0.30,
  quality:    0.25,
  cluster:    0.10,  // multiple sources covering it = stronger signal
  recency:    0.08,
  engagement: 0.04,
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
  const cluster = Math.min(1, Math.sqrt(c.members.length) / 3);
  const ageHours =
    (now.getTime() - new Date(c.primary.published_at).getTime()) / 3.6e6;
  const recency = Math.max(0, Math.min(1, 1 - ageHours / 48));
  const engagement = engagementSignal(c);
  const repoVelocity = cls.kind === "repo_trending" ? repoTrendingVelocitySignal(c) : 0;

  const baseScore =
    W.trust   * trust +
    W.novelty * noveltyScore +
    W.quality * quality +
    W.cluster * cluster +
    W.recency * recency +
    W.engagement * engagement;
  const score = clamp(baseScore + repoVelocity * 0.12 - qualityPenalty(c, cls, noveltyScore));
  const novelty_label = noveltyLabel(noveltyScore);

  return {
    ...c,
    kind: cls.kind,
    quality: cls.quality,
    one_liner: cls.one_liner,
    novelty: round(noveltyScore),
    novelty_label,
    trust: round(trust),
    score: round(score),
    why_this_surfaced: whyThisSurfaced(c, cls, noveltyScore, recency, engagement),
    builder_action: builderAction(cls.kind),
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
  const novelty = noveltyLabel(noveltyScore);
  if (novelty === "high") reasons.push("high novelty against the 30-day history");
  else if (novelty === "medium") reasons.push("meaningfully different from recent coverage");
  else reasons.push("kept for context despite familiar coverage");

  if (cls.quality === "signal") reasons.push("classified as concrete builder or research signal");
  else if (cls.quality === "mixed") reasons.push("classified as useful but lower-confidence signal");
  else reasons.push("kept only because multiple signals offset hype risk");

  if (c.members.length > 1) reasons.push(`corroborated by ${c.members.length} sources`);
  if (cls.kind === "repo_trending" && repoTrendingVelocitySignal(c) >= 0.55) {
    reasons.push("high daily GitHub star velocity");
  }
  if (c.primary.trust >= 0.85) reasons.push("primary source has high trust weight");
  if (recency >= 0.85) reasons.push("fresh within the current refresh window");
  if (engagement >= 0.55) reasons.push("source-native discussion or engagement is unusually high");
  return reasons.slice(0, 4);
}

function builderAction(kind: Kind): string {
  switch (kind) {
    case "paper":
      return "Save this for technical review if the method maps to your roadmap.";
    case "model_release":
      return "Check migration notes, pricing, and benchmark deltas before adopting.";
    case "company_announcement":
      return "Scan for API, pricing, policy, or platform changes that affect shipped systems.";
    case "tutorial":
      return "Use this as implementation reference if it matches your stack.";
    case "tool":
      return "Try it in a small sandbox before adding it to production workflow.";
    case "repo_release":
      return "Review the changelog and test the release against your integration points.";
    case "repo_trending":
      return "Inspect docs, issue activity, and recent commits before depending on it.";
    case "video":
    case "course":
      return "Queue it for focused learning if the topic matches your current work.";
    case "discussion":
      return "Use this as weak signal and verify against primary sources.";
    default:
      return "Read the primary source and decide whether it changes your next action.";
  }
}
