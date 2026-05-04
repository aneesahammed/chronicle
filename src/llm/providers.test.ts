import assert from "node:assert/strict";
import test from "node:test";
import {
  completeJsonWithProviders,
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
