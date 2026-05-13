import type { ClassificationMode, Cluster, Kind, Quality } from "../types.ts";
import { sourceRoleOf } from "../types.ts";
import { completeJsonWithProviders, type LlmJsonRequest, type LlmProvider } from "./providers.ts";

// We classify clusters in chunked LLM calls by feeding a numbered list and
// asking for a JSON object back. Missing or invalid items fall back per item.
//
// Why one shot instead of one-per-cluster:
//   - lower latency
//   - lower cost (no repeated system prompt)
//   - the model gets cross-cluster context, which slightly improves quality

const BATCH_SIZE = 10;
const MAX_COMPLETION_TOKENS = 1536;
const SUMMARY_CHARS = 280;
const NO_LLM_KINDS = new Set<Kind>(["repo_release", "repo_trending", "video", "course"]);

const LLM_KIND_VALUES = [
  "paper",
  "model_release",
  "company_announcement",
  "tutorial",
  "opinion",
  "discussion",
  "tool",
  "news",
  "unknown",
] as const;

const SYSTEM = `You triage AI/ML news for a daily digest aimed at experienced
ML/AI engineers. For each item, return:

  - kind: one of paper | model_release | company_announcement | tutorial |
          opinion | discussion | tool | news
  - quality: signal | mixed | hype
      signal = concrete contribution, useful to a builder or researcher
      mixed  = partially useful but padded, derivative, or restating known work
      hype   = marketing, vibes-only, "AI did X funny thing", clickbait
  - one_liner: <= 140 chars, factual, no marketing language. Plain English.

Be strict on quality. Most VC-flavored takes and "5 reasons why GPT will…"
posts are hype. Restating someone else's release without analysis is mixed.

For papers, do not mark every fresh paper as signal. A paper is signal only
when the title or summary shows a clear builder/research takeaway: a new method,
benchmark, dataset, model, safety result, evaluation finding, or measurable
systems result. Narrow applications, routine surveys, minor variants, and
unclear abstracts should usually be mixed unless the contribution is obvious.`;

const JSON_INSTRUCTIONS = `Return only valid JSON with this exact shape:
{"items":[{"index":0,"kind":"paper","quality":"signal","one_liner":"<= 140 chars"}]}

Use only these kind values:
paper, model_release, company_announcement, tutorial, opinion, discussion, tool, news, unknown

Use only these quality values:
signal, mixed, hype

Do not include reasoning, prose, Markdown, or code fences.`;

const CLASSIFICATION_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer", minimum: 0 },
          kind: { type: "string", enum: [...LLM_KIND_VALUES] },
          quality: { type: "string", enum: ["signal", "mixed", "hype"] },
          one_liner: { type: "string", maxLength: 200 },
        },
        required: ["index", "kind", "quality", "one_liner"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
  propertyOrdering: ["items"],
};

export interface Classification {
  kind: Kind;
  quality: Quality;
  one_liner: string;
}

export interface ClassificationResult {
  items: Classification[];
  mode: ClassificationMode;
}

export function classifyClustersDeterministically(clusters: Cluster[]): ClassificationResult {
  if (clusters.length === 0) return { items: [], mode: "fallback" };

  let llmEligible = 0;
  const items = clusters.map((cluster) => {
    if (shouldClassifyWithLlm(cluster)) {
      llmEligible++;
      return fallback(cluster);
    }
    return deterministicClassification(cluster);
  });

  return {
    items,
    mode: llmEligible > 0 ? "fallback" : "deterministic",
  };
}

export async function classifyClusters(
  clusters: Cluster[],
  providers: LlmProvider[] = [],
  completeJson?: (request: LlmJsonRequest) => Promise<{ content: string }>,
): Promise<ClassificationResult> {
  if (clusters.length === 0) return { items: [], mode: "fallback" };

  const items = new Array<Classification>(clusters.length);
  const llmWork: Array<{ cluster: Cluster; index: number }> = [];
  for (const [index, cluster] of clusters.entries()) {
    if (shouldClassifyWithLlm(cluster)) llmWork.push({ cluster, index });
    else items[index] = deterministicClassification(cluster);
  }

  if (llmWork.length === 0) return { items, mode: "deterministic" };
  if (providers.length === 0 && !completeJson) {
    console.warn("[llm] no LLM providers configured; using kind_hint fallback");
    for (const work of llmWork) items[work.index] = fallback(work.cluster);
    return { items, mode: "fallback" };
  }

  let failedClusters = 0;
  for (let start = 0; start < llmWork.length; start += BATCH_SIZE) {
    const batch = llmWork.slice(start, start + BATCH_SIZE);
    try {
      const classified = await classifyBatch(
        batch.map((work) => work.cluster),
        completeJson ?? ((request) => completeJsonWithProviders(providers, request)),
      );
      classified.forEach((classification, offset) => {
        items[batch[offset].index] = classification;
      });
    } catch (error) {
      failedClusters += batch.length;
      console.warn(`[llm] batch ${start / BATCH_SIZE + 1} failed: ${(error as Error).message}`);
      for (const work of batch) items[work.index] = fallback(work.cluster);
    }
  }

  return {
    items,
    mode: classificationMode({
      total: clusters.length,
      llmTotal: llmWork.length,
      failedClusters,
    }),
  };
}

function shouldClassifyWithLlm(cluster: Cluster): boolean {
  const role = sourceRoleOf(cluster.primary);
  if (role === "repo" || role === "learning") return false;
  const kind = cluster.primary.kind_hint;
  return !kind || !NO_LLM_KINDS.has(kind);
}

function deterministicClassification(cluster: Cluster): Classification {
  const kind = cluster.primary.kind_hint ?? "unknown";
  return {
    kind,
    quality: deterministicQuality(cluster, kind),
    one_liner: deterministicOneLiner(cluster),
  };
}

function deterministicQuality(cluster: Cluster, kind: Kind): Quality {
  if (kind === "repo_release") return cluster.primary.trust >= 0.75 ? "signal" : "mixed";
  if (kind === "repo_trending") {
    const stars = cluster.primary.repo?.stargazers_count ?? 0;
    const starsToday = cluster.primary.repo?.stars_today ?? 0;
    return stars >= 1000 || starsToday >= 50 ? "signal" : "mixed";
  }
  if (kind === "video" || kind === "course") return cluster.primary.trust >= 0.75 ? "signal" : "mixed";
  return fallbackQuality(cluster, kind);
}

function deterministicOneLiner(cluster: Cluster): string {
  const summary = String(cluster.primary.summary ?? "").replace(/\s+/g, " ").trim();
  if (!summary) return "";
  const title = normalizeText(cluster.primary.title);
  const line = normalizeText(summary);
  if (line === title || line.startsWith(title)) return "";
  if (isWeakSummary(line)) return "";
  return decodeText(summary).slice(0, 200);
}

function classificationMode(args: {
  total: number;
  llmTotal: number;
  failedClusters: number;
}): ClassificationMode {
  if (args.llmTotal === 0) return "deterministic";
  if (args.failedClusters === 0) return "llm";
  if (args.failedClusters >= args.llmTotal) {
    return args.llmTotal === args.total ? "fallback" : "partial";
  }
  return "partial";
}

interface RawClassifiedItem {
  index: number;
  kind: string;
  quality: string;
  one_liner: unknown;
}

interface ClassifiedItemsResponse {
  items: RawClassifiedItem[];
}

function parseClassifications(content: string): ClassifiedItemsResponse {
  const parsed = parseJsonFromContent(content);
  if (!isRecord(parsed) || !Array.isArray(parsed.items)) {
    throw new Error("invalid classification JSON");
  }
  return {
    items: parsed.items.flatMap((item) => {
      if (!isRecord(item) || typeof item.index !== "number") return [];
      return [{
        index: item.index,
        kind: String(item.kind ?? ""),
        quality: String(item.quality ?? ""),
        one_liner: item.one_liner,
      }];
    }),
  };
}

function parseJsonFromContent(content: string): unknown {
  const trimmed = stripJsonFence(content.trim());
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("classification response was not JSON");
  }
}

function stripJsonFence(value: string): string {
  return value
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function classifyBatch(
  clusters: Cluster[],
  completeJson: (request: LlmJsonRequest) => Promise<{ content: string }>,
): Promise<Classification[]> {
  const payload = clusters.map((c, i) => ({
    index: i,
    title: c.primary.title,
    source: c.primary.source_name,
    summary: (c.primary.summary ?? "").slice(0, SUMMARY_CHARS),
    url: c.primary.url,
  }));

  const userMsg =
    `Classify these ${clusters.length} items. ` +
    `Return one entry per item, same index.\n\n` +
    JSON.stringify(payload, null, 2);

  const resp = await completeJson({
    system: `${SYSTEM}\n\n${JSON_INSTRUCTIONS}`,
    user: userMsg,
    schemaName: "classification",
    schema: CLASSIFICATION_SCHEMA,
    temperature: 0,
    maxOutputTokens: MAX_COMPLETION_TOKENS,
  });

  const out = parseClassifications(resp.content).items;
  // Reassemble in input order. Missing entries fall back.
  const byIdx = new Map<number, RawClassifiedItem>();
  for (const it of out) byIdx.set(it.index, it);
  return clusters.map((c, i) => {
    const got = byIdx.get(i);
    if (!got) return fallback(c);
    if (!isKind(got.kind) || !isQuality(got.quality)) return fallback(c);
    return {
      kind: got.kind,
      quality: got.quality,
      one_liner: String(got.one_liner || c.primary.title).slice(0, 200),
    };
  });
}

function fallback(c: Cluster): Classification {
  const kind = c.primary.kind_hint ?? "unknown";
  return {
    kind,
    quality: fallbackQuality(c, kind),
    one_liner: deterministicOneLiner(c),
  };
}

function fallbackQuality(c: Cluster, kind: Kind): Quality {
  const title = normalizeText(c.primary.title);
  const summary = normalizeText(c.primary.summary ?? "");
  const text = `${title} ${summary}`;

  if (kind === "discussion" && isLowSignalDiscussion(title, text)) return "hype";
  if (kind === "paper") return isLikelySignalPaper(text) ? "signal" : "mixed";
  if (kind === "tutorial" || kind === "tool" || kind === "repo_release" || kind === "video" || kind === "course") {
    return "signal";
  }
  if (kind === "repo_trending") return deterministicQuality(c, kind);
  return "mixed";
}

function isLikelySignalPaper(text: string): boolean {
  const directSignalPatterns = [
    /\bbenchmark(?:s|ing)?\b/,
    /\bdataset(?:s)?\b/,
    /\bevaluat(?:e|es|ed|ion|ing)\b/,
    /\bmeasurement\b/,
    /\bsafety\b/,
    /\balignment\b/,
    /\bjailbreak(?:ing|s)?\b/,
    /\battack(?:s)?\b/,
    /\brobustness\b/,
    /\bthroughput\b/,
    /\blatency\b/,
    /\bspeed(?:up)?\b/,
    /\baccuracy\b/,
    /\bstate of the art\b/,
    /\bsota\b/,
  ];
  if (directSignalPatterns.some((pattern) => pattern.test(text))) return true;

  const contributionVerb = /\b(?:introduc(?:e|es|ing)|propos(?:e|es|ing)|present(?:s|ing)|develop(?:s|ed|ing)?|release(?:s|d)?|improv(?:e|es|ed|ing)|reduc(?:e|es|ed|ing)|accelerat(?:e|es|ed|ing)|outperform(?:s|ed|ing)?)\b/;
  const technicalObject = /\b(?:method|model|algorithm|architecture|framework|system|inference|training|retrieval|routing|verification|reasoning)\b/;
  return contributionVerb.test(text) && technicalObject.test(text);
}

function isLowSignalDiscussion(title: string, text: string): boolean {
  if (title.length < 18) return true;
  const lowSignalPatterns = [
    /\bbruh\b/,
    /\bhelp\b/,
    /\bquestion\b/,
    /\bwhat'?s your\b/,
    /\bwhat is the best\b/,
    /\bbest .* for\b/,
    /\blooking for\b/,
    /\bneed advice\b/,
    /\brecommend(?:ation|ed|s)?\b/,
    /\bshould i\b/,
    /\bdo you think\b/,
    /\bcan someone\b/,
    /\banyone (?:know|tried|using)\b/,
    /\bhow do i\b/,
    /\bis there\b/,
    /\bi wanted to hear\b/,
    /\bfeedback on\b/,
    /\bworth it\b/,
  ];
  return lowSignalPatterns.some((pattern) => pattern.test(text));
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function isWeakSummary(value: string): boolean {
  return (
    value === "comments" ||
    value.includes("/images/") ||
    value.includes("[link] [comments]") ||
    value.includes("submitted by /u/")
  );
}

function decodeText(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function isKind(value: string): value is Kind {
  return (LLM_KIND_VALUES as readonly string[]).includes(value);
}

function isQuality(value: string): value is Quality {
  return value === "signal" || value === "mixed" || value === "hype";
}
