import assert from "node:assert/strict";
import test from "node:test";
import { novelty } from "./novelty.ts";

test("novelty is high for unseen titles and low for repeated titles", () => {
  const history = {
    entries: [{
      id: "old",
      title: "DeepSeek releases a new sparse MoE model",
      url: "https://example.com/old",
      date: "2026-05-01",
    }],
  };

  assert.equal(novelty("DeepSeek releases a new sparse MoE model", history), 0);
  assert.ok(novelty("A new GPU kernel improves attention prefill", history) > 0.7);
});

test("novelty ignores same-day history entries during manual reruns", () => {
  const today = new Date("2026-05-02T12:00:00.000Z");
  const history = {
    entries: [{
      id: "same-day",
      title: "Anthropic releases Claude for creative work",
      url: "https://example.com/same-day",
      date: "2026-05-02",
    }],
  };

  assert.equal(novelty("Anthropic releases Claude for creative work", history), 0);
  assert.equal(novelty("Anthropic releases Claude for creative work", history, today), 1);
});
