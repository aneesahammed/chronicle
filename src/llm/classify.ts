import Anthropic from "@anthropic-ai/sdk";
import type { ClassificationMode, Cluster, Kind, Quality } from "../types.ts";

// We classify all clusters in a single Anthropic call by feeding a numbered
// list and asking for a JSON array back. Tool use forces the schema. Cheap.
//
// Why one shot instead of one-per-cluster:
//   - lower latency
//   - lower cost (no repeated system prompt)
//   - the model gets cross-cluster context, which slightly improves quality

const MODEL = "claude-haiku-4-5-20251001";
const BATCH_SIZE = 35;

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
posts are hype. Restating someone else's release without analysis is mixed.`;

const TOOL = {
  name: "emit_classifications",
  description: "Emit classifications for all items, in input order.",
  input_schema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            index: { type: "integer" },
            kind: {
              type: "string",
              enum: [
                "paper", "model_release", "company_announcement", "tutorial",
                "opinion", "discussion", "tool", "news",
              ],
            },
            quality: { type: "string", enum: ["signal", "mixed", "hype"] },
            one_liner: { type: "string", maxLength: 200 },
          },
          required: ["index", "kind", "quality", "one_liner"],
        },
      },
    },
    required: ["items"],
  },
} as const;

export interface Classification {
  kind: Kind;
  quality: Quality;
  one_liner: string;
}

export interface ClassificationResult {
  items: Classification[];
  mode: ClassificationMode;
}

export async function classifyClusters(
  clusters: Cluster[],
  apiKey: string | undefined,
  createMessage?: MessageRunner,
): Promise<ClassificationResult> {
  if (clusters.length === 0) return { items: [], mode: "fallback" };
  if (!apiKey) {
    console.warn("[llm] no API key; using kind_hint fallback");
    return { items: clusters.map((c) => fallback(c)), mode: "fallback" };
  }

  const client = new Anthropic({ apiKey });
  const runner: MessageRunner = createMessage ?? (async (args) => {
    const resp = await client.messages.create(args as Parameters<typeof client.messages.create>[0]);
    return resp as unknown as { content: Array<{ type: string; input?: unknown }> };
  });
  const out: Classification[] = [];
  let failed = 0;

  for (let start = 0; start < clusters.length; start += BATCH_SIZE) {
    const batch = clusters.slice(start, start + BATCH_SIZE);
    try {
      out.push(...await classifyBatch(batch, runner));
    } catch (e) {
      failed++;
      console.warn(`[llm] batch ${start / BATCH_SIZE + 1} failed: ${(e as Error).message}`);
      out.push(...batch.map((c) => fallback(c)));
    }
  }

  const mode: ClassificationMode = failed === 0 ? "llm" : failed * BATCH_SIZE >= clusters.length ? "fallback" : "partial";
  return { items: out, mode };
}

type MessageRunner = (args: unknown) => Promise<{
  content: Array<{ type: string; input?: unknown }>;
}>;

async function classifyBatch(
  clusters: Cluster[],
  runner: MessageRunner,
): Promise<Classification[]> {
  const payload = clusters.map((c, i) => ({
    index: i,
    title: c.primary.title,
    source: c.primary.source_name,
    summary: (c.primary.summary ?? "").slice(0, 400),
    url: c.primary.url,
  }));

  const userMsg =
    `Classify these ${clusters.length} items. ` +
    `Return one entry per item, same index.\n\n` +
    JSON.stringify(payload, null, 2);

  const resp = await runner({
    model: MODEL,
    max_tokens: 4096,
    system: SYSTEM,
    tools: [TOOL],
    tool_choice: { type: "tool", name: TOOL.name },
    messages: [{ role: "user", content: userMsg }],
  });

  const block = resp.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    throw new Error("no tool_use in response");
  }
  const out = (block.input as { items: ClassifiedItem[] }).items ?? [];
  // Reassemble in input order. Missing entries fall back.
  const byIdx = new Map<number, ClassifiedItem>();
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

interface ClassifiedItem {
  index: number;
  kind: Kind;
  quality: Quality;
  one_liner: string;
}

function fallback(c: Cluster): Classification {
  return {
    kind: c.primary.kind_hint ?? "unknown",
    quality: "mixed",
    one_liner: c.primary.title.slice(0, 140),
  };
}

function isKind(k: string): k is Kind {
  return [
    "paper", "model_release", "company_announcement", "tutorial",
    "opinion", "discussion", "tool", "news", "unknown",
  ].includes(k);
}

function isQuality(q: string): q is Quality {
  return q === "signal" || q === "mixed" || q === "hype";
}
