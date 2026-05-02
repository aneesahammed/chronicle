import assert from "node:assert/strict";
import test from "node:test";
import { canonicalizeUrl } from "./canonicalize.ts";

test("canonicalizeUrl strips tracking params, fragments, and www host prefix", () => {
  assert.equal(
    canonicalizeUrl("https://www.example.com/post/?utm_source=hn&b=2&a=1#comments"),
    "https://example.com/post?a=1&b=2",
  );
});

test("canonicalizeUrl rejects non-http URLs", () => {
  assert.equal(canonicalizeUrl("javascript:alert(1)"), "");
  assert.equal(canonicalizeUrl("mailto:test@example.com"), "");
});

test("canonicalizeUrl normalizes arXiv PDF URLs to abs URLs", () => {
  assert.equal(
    canonicalizeUrl("https://arxiv.org/pdf/2401.12345.pdf?utm_campaign=x"),
    "https://arxiv.org/abs/2401.12345",
  );
});
