import type { Cluster, Quality, ScoredCluster } from "../types.ts";
import type { Classification } from "../llm/classify.ts";

// Composite score in [0, 1]. Tunable weights. Eyeball the output and adjust.
//
// We deliberately keep this simple. The point of v1 is the *pipeline*, not
// a learned ranker. Once you've used the feed for two weeks you'll know
// which knob to turn.

const W = {
  trust:    0.25,
  novelty:  0.30,
  quality:  0.25,
  cluster:  0.10,  // multiple sources covering it = stronger signal
  recency:  0.10,
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

  const score =
    W.trust   * trust +
    W.novelty * noveltyScore +
    W.quality * quality +
    W.cluster * cluster +
    W.recency * recency;

  return {
    ...c,
    kind: cls.kind,
    quality: cls.quality,
    one_liner: cls.one_liner,
    novelty: round(noveltyScore),
    trust: round(trust),
    score: round(score),
  };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
