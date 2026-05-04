export interface LlmJsonRequest {
  system: string;
  user: string;
  schemaName: string;
  schema: Record<string, unknown>;
  maxOutputTokens: number;
  temperature: number;
}

export interface LlmJsonResponse {
  content: string;
  provider: "gemini" | "groq";
  model: string;
}

export interface LlmProvider {
  name: "gemini" | "groq";
  model: string;
  batchDelayMs: number;
  cooldownUntilMs?: number;
  completeJson(request: LlmJsonRequest): Promise<LlmJsonResponse>;
}

export class ProviderBlockedError extends Error {
  readonly provider: string;
  readonly reason: string;

  constructor(
    provider: string,
    reason: string,
  ) {
    super(`${provider} blocked or stopped generation: ${reason}`);
    this.provider = provider;
    this.reason = reason;
  }
}

export class ProviderRateLimitError extends Error {
  readonly provider: string;
  readonly retryAfterMs?: number;

  constructor(
    provider: string,
    retryAfterMs?: number,
  ) {
    super(`${provider} rate limited`);
    this.provider = provider;
    this.retryAfterMs = retryAfterMs;
  }
}

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const GROQ_CHAT_COMPLETIONS_URL = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_GEMINI_MODEL = "gemini-2.0-flash";
const DEFAULT_GEMINI_BATCH_DELAY_MS = 4_500;
const DEFAULT_GROQ_MODEL = "qwen/qwen3-32b";
const DEFAULT_GROQ_BATCH_DELAY_MS = 30_000;

type FetchLike = typeof fetch;

export class GeminiProvider implements LlmProvider {
  readonly name = "gemini" as const;
  readonly batchDelayMs: number;
  readonly model: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;

  constructor(
    apiKey: string,
    model = DEFAULT_GEMINI_MODEL,
    options: { batchDelayMs?: number; fetchImpl?: FetchLike } = {},
  ) {
    this.apiKey = apiKey;
    this.model = model;
    this.batchDelayMs = options.batchDelayMs ?? 0;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async completeJson(request: LlmJsonRequest): Promise<LlmJsonResponse> {
    const response = await this.fetchImpl(`${GEMINI_URL}/${this.model}:generateContent`, {
      method: "POST",
      headers: {
        "x-goog-api-key": this.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [{ text: `${request.system}\n\n${request.user}` }],
        }],
        generationConfig: {
          temperature: request.temperature,
          maxOutputTokens: request.maxOutputTokens,
          responseMimeType: "application/json",
          responseJsonSchema: request.schema,
        },
      }),
    });

    const text = await response.text();
    const data = parseProviderJson(text, response.status, "Gemini");
    if (!response.ok) {
      if (response.status === 429 || response.status === 503) {
        throw new ProviderRateLimitError("gemini", retryDelayMs(data, response.headers));
      }
      throw new Error(`Gemini request failed (${response.status}): ${providerErrorMessage(data)}`);
    }

    const content = geminiContent(data);
    return { content, provider: this.name, model: this.model };
  }
}

export class GroqProvider implements LlmProvider {
  readonly name = "groq" as const;
  readonly batchDelayMs: number;
  readonly model: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;

  constructor(
    apiKey: string,
    model = DEFAULT_GROQ_MODEL,
    options: { batchDelayMs?: number; fetchImpl?: FetchLike } = {},
  ) {
    this.apiKey = apiKey;
    this.model = model;
    this.batchDelayMs = options.batchDelayMs ?? DEFAULT_GROQ_BATCH_DELAY_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async completeJson(request: LlmJsonRequest): Promise<LlmJsonResponse> {
    const body = groqBody(request, this.model, true);
    try {
      return {
        content: await this.fetchGroqContent(body),
        provider: this.name,
        model: this.model,
      };
    } catch (error) {
      if (!isGroqJsonValidationError(error)) throw error;
      console.warn("[llm] Groq JSON mode validation failed; retrying without response_format");
      return {
        content: await this.fetchGroqContent(groqBody(request, this.model, false)),
        provider: this.name,
        model: this.model,
      };
    }
  }

  private async fetchGroqContent(body: Record<string, unknown>): Promise<string> {
    const response = await this.fetchImpl(GROQ_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    const data = parseProviderJson(text, response.status, "Groq");
    if (!response.ok) {
      if (response.status === 429 || response.status === 503) {
        throw new ProviderRateLimitError("groq", retryDelayMs(data, response.headers));
      }
      throw new Error(`Groq request failed (${response.status}): ${providerErrorMessage(data)}`);
    }
    if (
      isRecord(data)
      && Array.isArray(data.choices)
      && isRecord(data.choices[0])
      && isRecord(data.choices[0].message)
      && typeof data.choices[0].message.content === "string"
    ) {
      return data.choices[0].message.content;
    }
    throw new ProviderBlockedError("groq", "empty content");
  }
}

export function createLlmProviders(env: NodeJS.ProcessEnv): LlmProvider[] {
  const order = (env.LLM_PROVIDER_ORDER ?? "gemini,groq")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const providers: LlmProvider[] = [];
  for (const name of order) {
    if (name === "gemini" && env.GEMINI_API_KEY) {
      providers.push(new GeminiProvider(
        env.GEMINI_API_KEY,
        env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL,
        { batchDelayMs: envMs(env, "GEMINI_BATCH_DELAY_MS", DEFAULT_GEMINI_BATCH_DELAY_MS) },
      ));
    }
    if (name === "groq" && env.GROQ_API_KEY) {
      providers.push(new GroqProvider(
        env.GROQ_API_KEY,
        env.GROQ_MODEL ?? DEFAULT_GROQ_MODEL,
        { batchDelayMs: envMs(env, "GROQ_BATCH_DELAY_MS", DEFAULT_GROQ_BATCH_DELAY_MS) },
      ));
    }
  }
  return providers;
}

function envMs(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const value = env[key];
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${key} must be a non-negative number of milliseconds; received ${JSON.stringify(value)}`);
  }
  return Math.floor(parsed);
}

export async function completeJsonWithProviders(
  providers: LlmProvider[],
  request: LlmJsonRequest,
): Promise<LlmJsonResponse> {
  if (providers.length === 0) throw new Error("no LLM providers configured");
  let lastError: unknown;
  for (const provider of providers) {
    if (isCoolingDown(provider)) {
      console.warn(`[llm] skipping ${provider.name}:${provider.model}; rate-limit cooldown is active`);
      continue;
    }
    try {
      if (provider.batchDelayMs > 0) {
        console.log(`[llm] waiting ${provider.batchDelayMs / 1000}s before ${provider.name}:${provider.model}`);
        await sleep(provider.batchDelayMs);
      }
      return await withProviderRetry(provider, () => provider.completeJson(request));
    } catch (error) {
      lastError = error;
      if (error instanceof ProviderRateLimitError) {
        provider.cooldownUntilMs = Date.now() + providerCooldownMs(provider, error);
      }
      console.warn(`[llm] ${provider.name}:${provider.model} failed: ${(error as Error).message}`);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("all LLM providers failed");
}

function isCoolingDown(provider: LlmProvider): boolean {
  return typeof provider.cooldownUntilMs === "number" && provider.cooldownUntilMs > Date.now();
}

function providerCooldownMs(provider: LlmProvider, error: ProviderRateLimitError): number {
  const providerFloor = provider.name === "gemini" ? 10 * 60_000 : 60_000;
  const retryAfter = typeof error.retryAfterMs === "number" ? error.retryAfterMs : 0;
  return Math.min(Math.max(providerFloor, retryAfter), 10 * 60_000);
}

async function withProviderRetry<T>(
  provider: LlmProvider,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    // Retry only short provider-declared throttles in-place. Other failures
    // fall through to the next provider so one bad backend cannot stall a run.
    const wait = error instanceof ProviderRateLimitError
      ? error.retryAfterMs ?? shortRetryMs(provider.name)
      : undefined;
    if (wait === undefined || wait > 30_000) throw error;
    await sleep(wait + Math.floor(Math.random() * 250));
    return await run();
  }
}

function groqBody(request: LlmJsonRequest, model: string, jsonMode: boolean): Record<string, unknown> {
  return {
    model,
    temperature: request.temperature,
    max_completion_tokens: request.maxOutputTokens,
    ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
    messages: [
      { role: "system", content: request.system },
      { role: "user", content: request.user },
    ],
  };
}

function geminiContent(data: unknown): string {
  if (!isRecord(data)) throw new ProviderBlockedError("gemini", "malformed response");
  const promptFeedback = data.promptFeedback;
  if (isRecord(promptFeedback) && typeof promptFeedback.blockReason === "string") {
    throw new ProviderBlockedError("gemini", promptFeedback.blockReason);
  }
  if (!Array.isArray(data.candidates)) throw new ProviderBlockedError("gemini", "no candidates");
  const candidate = data.candidates[0];
  if (!isRecord(candidate)) throw new ProviderBlockedError("gemini", "no candidates");
  const finishReason = typeof candidate.finishReason === "string" ? candidate.finishReason : "";
  if (finishReason && finishReason !== "STOP") {
    throw new ProviderBlockedError("gemini", finishReason);
  }
  const content = candidate.content;
  if (!isRecord(content) || !Array.isArray(content.parts)) {
    throw new ProviderBlockedError("gemini", "empty content");
  }
  const text = content.parts
    .map((part) => isRecord(part) && typeof part.text === "string" ? part.text : "")
    .join("")
    .trim();
  if (!text) throw new ProviderBlockedError("gemini", "empty content");
  return text;
}

function retryDelayMs(data: unknown, headers?: Headers): number | undefined {
  const retryAfter = headers?.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  const details = isRecord(data) && isRecord(data.error) && Array.isArray(data.error.details)
    ? data.error.details
    : [];
  for (const detail of details) {
    if (
      isRecord(detail)
      && detail["@type"] === "type.googleapis.com/google.rpc.RetryInfo"
      && typeof detail.retryDelay === "string"
    ) {
      const match = detail.retryDelay.match(/^(\d+(?:\.\d+)?)s$/);
      if (match) return Number(match[1]) * 1000;
    }
  }
  return undefined;
}

function shortRetryMs(provider: LlmProvider["name"]): number {
  return provider === "gemini" ? 2_000 : 10_000;
}

function parseProviderJson(text: string, status: number, provider: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${provider} returned non-JSON response (${status})`);
  }
}

function providerErrorMessage(data: unknown): string {
  if (isRecord(data) && isRecord(data.error) && typeof data.error.message === "string") {
    return data.error.message;
  }
  return "unknown error";
}

function isGroqJsonValidationError(error: unknown): boolean {
  const message = (error as Error).message?.toLowerCase?.() ?? "";
  return message.includes("validate json") || message.includes("failed_generation");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
