import type { ClassificationMode, Cluster, Kind, Quality } from "../types.ts";

// We classify clusters in chunked Groq calls by feeding a numbered list and
// asking for a JSON object back. Missing or invalid items fall back per item.
//
// Why one shot instead of one-per-cluster:
//   - lower latency
//   - lower cost (no repeated system prompt)
//   - the model gets cross-cluster context, which slightly improves quality

const MODEL = "qwen/qwen3-32b";
const GROQ_CHAT_COMPLETIONS_URL = "https://api.groq.com/openai/v1/chat/completions";
const BATCH_SIZE = 12;
const MAX_COMPLETION_TOKENS = 1024;
const SUMMARY_CHARS = 280;
const GROQ_BATCH_DELAY_MS = 30_000;

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

const JSON_INSTRUCTIONS = `Return only valid JSON with this exact shape:
{"items":[{"index":0,"kind":"paper","quality":"signal","one_liner":"<= 140 chars"}]}

Use only these kind values:
paper, model_release, company_announcement, tutorial, opinion, discussion, tool, news

Use only these quality values:
signal, mixed, hype

Do not include reasoning, prose, Markdown, or code fences.`;

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
  createChatCompletion?: ChatCompletionRunner,
): Promise<ClassificationResult> {
  if (clusters.length === 0) return { items: [], mode: "fallback" };
  if (!apiKey) {
    console.warn("[llm] no API key; using kind_hint fallback");
    return { items: clusters.map((c) => fallback(c)), mode: "fallback" };
  }

  const runner: ChatCompletionRunner = createChatCompletion
    ?? ((args) => createGroqChatCompletion(apiKey, args));
  const shouldThrottle = createChatCompletion === undefined;
  const out: Classification[] = [];
  let failed = 0;

  for (let start = 0; start < clusters.length; start += BATCH_SIZE) {
    const batch = clusters.slice(start, start + BATCH_SIZE);
    if (shouldThrottle && start > 0) {
      console.log(`[llm] waiting ${GROQ_BATCH_DELAY_MS / 1000}s to stay under Groq TPM limits`);
      await sleep(GROQ_BATCH_DELAY_MS);
    }
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ChatCompletionRequest {
  model: string;
  temperature: number;
  max_completion_tokens: number;
  response_format?: { type: "json_object" };
  messages: Array<{
    role: "system" | "user";
    content: string;
  }>;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
  error?: {
    message?: string;
  };
}

type ChatCompletionRunner = (args: ChatCompletionRequest) => Promise<ChatCompletionResponse>;

async function createGroqChatCompletion(
  apiKey: string,
  body: ChatCompletionRequest,
): Promise<ChatCompletionResponse> {
  const resp = await fetch(GROQ_CHAT_COMPLETIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  const data = parseResponseBody(text, resp.status);

  if (!resp.ok) {
    throw new Error(`Groq request failed (${resp.status}): ${groqErrorMessage(data)}`);
  }

  return data as ChatCompletionResponse;
}

function parseResponseBody(text: string, status: number): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Groq returned non-JSON response (${status})`);
  }
}

function groqErrorMessage(data: unknown): string {
  if (isRecord(data) && isRecord(data.error) && typeof data.error.message === "string") {
    return data.error.message;
  }
  return "unknown error";
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
  runner: ChatCompletionRunner,
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

  const request: ChatCompletionRequest = {
    model: MODEL,
    temperature: 0,
    max_completion_tokens: MAX_COMPLETION_TOKENS,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: `${SYSTEM}\n\n${JSON_INSTRUCTIONS}` },
      { role: "user", content: userMsg },
    ],
  };

  let resp: ChatCompletionResponse;
  try {
    resp = await runner(request);
  } catch (error) {
    if (!isGroqJsonValidationError(error)) throw error;
    console.warn("[llm] Groq JSON mode validation failed; retrying without response_format");
    resp = await runner(withoutResponseFormat(request));
  }

  const content = resp.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("no message content in response");
  }
  const out = parseClassifications(content).items;
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

function isGroqJsonValidationError(error: unknown): boolean {
  const message = (error as Error).message?.toLowerCase?.() ?? "";
  return message.includes("validate json") || message.includes("failed_generation");
}

function withoutResponseFormat(request: ChatCompletionRequest): ChatCompletionRequest {
  const { response_format: _responseFormat, ...rest } = request;
  return rest;
}

function fallback(c: Cluster): Classification {
  const kind = c.primary.kind_hint ?? "unknown";
  return {
    kind,
    quality: fallbackQuality(c, kind),
    one_liner: fallbackOneLiner(c),
  };
}

function fallbackOneLiner(c: Cluster): string {
  const summary = String(c.primary.summary ?? "").replace(/\s+/g, " ").trim();
  if (!summary) return "";
  const title = normalizeText(c.primary.title);
  const line = normalizeText(summary);
  if (line === title || line.startsWith(title)) return "";
  if (isWeakSummary(line)) return "";
  return decodeText(summary).slice(0, 200);
}

function fallbackQuality(c: Cluster, kind: Kind): Quality {
  const title = normalizeText(c.primary.title);
  const summary = normalizeText(c.primary.summary ?? "");
  const text = `${title} ${summary}`;

  if (kind === "discussion" && isLowSignalDiscussion(title, text)) return "hype";
  if (kind === "paper" || kind === "tutorial" || kind === "tool") return "signal";
  return "mixed";
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

function isKind(k: string): k is Kind {
  return [
    "paper", "model_release", "company_announcement", "tutorial",
    "opinion", "discussion", "tool", "news", "unknown",
  ].includes(k);
}

function isQuality(q: string): q is Quality {
  return q === "signal" || q === "mixed" || q === "hype";
}
