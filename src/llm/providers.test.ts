import assert from "node:assert/strict";
import test from "node:test";
import {
  completeJsonWithProviders,
  createLlmProviders,
  GeminiProvider,
  GroqProvider,
  ProviderBlockedError,
} from "./providers.ts";

const request = {
  system: "System prompt",
  user: "User prompt",
  schemaName: "test",
  schema: {
    type: "object",
    properties: { ok: { type: "string", enum: ["yes", "no"] } },
    required: ["ok"],
  },
  maxOutputTokens: 128,
  temperature: 0,
};

test("GeminiProvider sends native structured output request", async () => {
  let body: any;
  const provider = new GeminiProvider("key", "gemini-test", {
    fetchImpl: async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json({
        candidates: [{
          finishReason: "STOP",
          content: { parts: [{ text: '{"ok":"yes"}' }] },
        }],
      });
    },
  });

  const result = await provider.completeJson(request);

  assert.equal(result.provider, "gemini");
  assert.equal(result.model, "gemini-test");
  assert.equal(body.generationConfig.responseMimeType, "application/json");
  assert.deepEqual(body.generationConfig.responseJsonSchema, request.schema);
  assert.equal(result.content, '{"ok":"yes"}');
});

test("GeminiProvider turns blocked and empty responses into provider errors", async () => {
  const blocked = new GeminiProvider("key", "gemini-test", {
    fetchImpl: async () => Response.json({ promptFeedback: { blockReason: "SAFETY" } }),
  });
  await assert.rejects(blocked.completeJson(request), ProviderBlockedError);

  const empty = new GeminiProvider("key", "gemini-test", {
    fetchImpl: async () => Response.json({ candidates: [] }),
  });
  await assert.rejects(empty.completeJson(request), ProviderBlockedError);
});

test("completeJsonWithProviders retries a short Gemini rate limit then succeeds", async () => {
  let calls = 0;
  const provider = new GeminiProvider("key", "gemini-test", {
    batchDelayMs: 0,
    fetchImpl: async () => {
      calls++;
      if (calls === 1) {
        return Response.json({
          error: {
            message: "rate limited",
            details: [{
              "@type": "type.googleapis.com/google.rpc.RetryInfo",
              retryDelay: "0.001s",
            }],
          },
        }, { status: 429 });
      }
      return Response.json({
        candidates: [{
          finishReason: "STOP",
          content: { parts: [{ text: '{"ok":"yes"}' }] },
        }],
      });
    },
  });

  const result = await completeJsonWithProviders([provider], request);
  assert.equal(calls, 2);
  assert.equal(result.content, '{"ok":"yes"}');
});

test("createLlmProviders defaults to Gemini 2.0 Flash with a free-tier-friendly delay", () => {
  const providers = createLlmProviders({
    GEMINI_API_KEY: "gemini-key",
    GROQ_API_KEY: "groq-key",
  });

  assert.equal(providers[0].name, "gemini");
  assert.equal(providers[0].model, "gemini-2.0-flash");
  assert.equal(providers[0].batchDelayMs, 4_500);
  assert.equal(providers[1].name, "groq");
  assert.equal(providers[1].batchDelayMs, 30_000);
});

test("createLlmProviders honors provider model and delay overrides", () => {
  const providers = createLlmProviders({
    LLM_PROVIDER_ORDER: "gemini",
    GEMINI_API_KEY: "gemini-key",
    GEMINI_MODEL: "gemini-test",
    GEMINI_BATCH_DELAY_MS: "0",
  });

  assert.equal(providers.length, 1);
  assert.equal(providers[0].model, "gemini-test");
  assert.equal(providers[0].batchDelayMs, 0);
});

test("GroqProvider retries without JSON mode when Groq rejects structured output", async () => {
  const bodies: any[] = [];
  const provider = new GroqProvider("key", "qwen-test", {
    batchDelayMs: 0,
    fetchImpl: async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      if (bodies.length === 1) {
        return Response.json({
          error: { message: "Failed to validate JSON. See failed_generation for more details." },
        }, { status: 400 });
      }
      return Response.json({
        choices: [{
          message: { content: '{"ok":"yes"}' },
        }],
      });
    },
  });

  const result = await provider.completeJson(request);
  assert.equal(result.provider, "groq");
  assert.equal(bodies[0].response_format.type, "json_object");
  assert.equal(bodies[1].response_format, undefined);
  assert.equal(result.content, '{"ok":"yes"}');
});
