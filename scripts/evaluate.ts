import { readFileSync } from "node:fs";
import { classifyClustersDeterministically } from "../src/llm/classify.ts";
import { scoreCluster } from "../src/pipeline/score.ts";
import { selectDiverseClusters, sourceFamilyMix } from "../src/pipeline/diversity.ts";
import { canonicalizeUrl } from "../src/pipeline/canonicalize.ts";
import type { ScoredCluster } from "../src/types.ts";

interface Entry { id: number; role: "main" | "repo" | "learning"; edition: string; cluster: ScoredCluster; expected_useful: boolean; rationale: string; }
const corpus: { version: number; entries: Entry[] } = JSON.parse(readFileSync("data/evaluation/editorial-v1.json", "utf8"));
if (corpus.entries.length < 100 || corpus.entries.some(e => typeof e.expected_useful !== "boolean" || !e.rationale)) throw new Error("Evaluation corpus must have 100 reviewed entries");
let failed = false;
for (const role of ["main", "repo", "learning"] as const) {
  const entries = corpus.entries.filter(e => e.role === role);
  const labels = new Map(entries.map(e => [e.cluster.id, e.expected_useful]));
  const classified = classifyClustersDeterministically(entries.map(e => e.cluster));
  const ranked = entries.map((e, i) => scoreCluster(e.cluster, classified.items[i], e.cluster.novelty, new Date(`${e.edition}T23:59:59Z`)));
  const selected = selectDiverseClusters(ranked.filter(c => c.quality !== "hype"), { maxOutput: 10, enforceFamilyRatio: role === "main" });
  const precision = selected.length ? selected.filter(c => labels.get(c.id)).length / selected.length : 0;
  const signal = ranked.filter(c => c.quality === "signal");
  const signalPrecision = signal.length ? signal.filter(c => labels.get(c.id)).length / signal.length : null;
  const urls = selected.map(c => canonicalizeUrl(c.primary.url));
  const duplicates = urls.length - new Set(urls).size;
  console.log(JSON.stringify({ role, corpus: entries.length, selectedCount: selected.length, precisionAt10: +precision.toFixed(2), signalPrecision, signalCount: signal.length, duplicateLeakage: duplicates, sourceMix: sourceFamilyMix(selected), topIds: selected.map(c => entries.find(e => e.cluster.id === c.id)!.id) }));
  // Release gate for the main fallback ranking; other lanes' historical descriptions
  // predate the parser repair and intentionally cannot certify current quality.
  if (role === "main" && (precision < 0.7 || duplicates > 0)) failed = true;
}
console.log("Metadata usefulness regression only; labels were reviewed by Codex, not a human factual-accuracy study. Revisit the frozen corpus before changing thresholds.");
if (failed) process.exitCode = 1;
