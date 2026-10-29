import assert from "node:assert/strict";
import test from "node:test";
import { assertFreshEdition } from "./freshness.ts";
import type { FeedFile } from "../types.ts";

const startedAt = Date.parse("2026-10-29T18:00:00Z");
const now = startedAt + 60_000;
const good = { source_total: 5, source_ok: 4, count: 3, refresh_status: "partial", generated_at: new Date(now).toISOString(), last_successful_generated_at: new Date(now).toISOString() } as FeedFile;
test("freshness gate accepts partial sources with a current successful edition", () => {
  assert.doesNotThrow(() => assertFreshEdition(good, { startedAt, now }));
});
test("freshness gate rejects renewed attempt time on preserved old content", () => {
  assert.throws(() => assertFreshEdition({ ...good, refresh_status: "failed", last_successful_generated_at: "2026-10-28T18:00:00Z" }, { startedAt, now }), /failed/);
  assert.throws(() => assertFreshEdition({ ...good, last_successful_generated_at: "2026-10-28T18:00:00Z" }, { startedAt, now }), /not fresh/);
  assert.throws(() => assertFreshEdition({ ...good, last_successful_generated_at: null }, { startedAt, now }), /not fresh/);
});
