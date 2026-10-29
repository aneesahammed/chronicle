import assert from "node:assert/strict";
import test, { mock } from "node:test";
import dns from "node:dns/promises";
import { safeFetch, boundedText, sameSourceHost, publicFetchError } from "./safe-fetch.ts";

test.afterEach(() => mock.restoreAll());
test("untrusted URLs cannot use a publisher substring as a host allowlist", () => {
  assert.equal(sameSourceHost("https://evil.test/example.com/news", "https://example.com/feed"), false);
  assert.equal(sameSourceHost("https://example.com/news", "https://example.com/feed"), true);
});
test("fetch rejects private DNS answers and redirects before contacting the destination", async () => {
  const lookup = mock.method(dns, "lookup", async () => [{ address: "127.0.0.1", family: 4 }]);
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response("ok"); };
  await assert.rejects(safeFetch("https://example.com/feed", {}, fetchImpl), /private/);
  assert.equal(calls, 0);
  lookup.mock.restore();
  mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  await assert.rejects(safeFetch("https://example.com/feed", {}, async () => { calls++; return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } }); }), /Blocked/);
  assert.equal(calls, 1);
});
test("stream limits apply even without Content-Length", async () => {
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("123456789")); controller.close(); } });
  await assert.rejects(boundedText(new Response(body), 5), /too large/);
  assert.equal(await boundedText(new Response("hello"), 5), "hello");
});
test("public errors exclude challenge-page markup", () => {
  assert.equal(publicFetchError(new Error("HTTP 403 Forbidden <html>Just a moment</html>")), "HTTP 403 / access denied");
  assert.equal(publicFetchError(new Error("Invalid character in entity name")), "Invalid feed format");
});
