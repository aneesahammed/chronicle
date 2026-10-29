import dns from "node:dns/promises";
import { isIP } from "node:net";

const MAX_BYTES = 10_000_000;
export function isPublicAddress(address: string): boolean {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(ip) === 6) {
    // Only global unicast; excludes loopback, link-local, ULA and mapped IPv4.
    return /^[23][0-9a-f]{3}:/.test(ip) && !ip.startsWith("2001:db8:");
  }
  if (isIP(ip) !== 4) return false;
  const [a, b] = ip.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)));
}

export function sameSourceHost(a: string, b: string): boolean {
  try {
    const url = new URL(a), source = new URL(b);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
      && url.hostname.replace(/^www\./, "") === source.hostname.replace(/^www\./, "")
      && url.port === source.port;
  } catch { return false; }
}

export async function safeFetch(input: string | URL, init: RequestInit = {}, fetchImpl = fetch): Promise<Response> {
  const origin = String(input);
  let current = origin;
  for (let redirects = 0; redirects <= 5; redirects++) {
    const url = new URL(current);
    if (!sameSourceHost(current, origin) || (url.port && !["80", "443"].includes(url.port))) throw new Error("Blocked fetch destination");
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(hostname) ? [{ address: hostname }] : await dns.lookup(hostname, { all: true });
    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) throw new Error("Blocked private-network destination");
    const response = await fetchImpl(url.toString(), { ...init, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) throw new Error("Redirect missing location");
    const next = new URL(location, url);
    if (url.protocol === "https:" && next.protocol !== "https:") throw new Error("Blocked HTTPS downgrade");
    current = next.toString();
  }
  throw new Error("Too many redirects");
}

export async function boundedText(response: Response, maxBytes = MAX_BYTES): Promise<string> {
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    throw new Error("Response too large");
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) { await reader.cancel(); throw new Error("Response too large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}

export function publicFetchError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/GitHub rate limit exhausted/.test(text)) return "GitHub rate limit exhausted";
  if (/invalid GitHub releases API URL/.test(text)) return "invalid GitHub releases API URL";
  const http = text.match(/HTTP\s+(\d{3})/);
  if (http) return `HTTP ${http[1]}${http[1] === "403" ? " / access denied" : ""}`;
  if (/xml|rss|entity|feed not recognized/i.test(text)) return "Invalid feed format";
  if (/timeout|abort/i.test(text)) return "Request timed out";
  if (/too large/i.test(text)) return "Response too large";
  if (/blocked/i.test(text)) return "Blocked fetch destination";
  return "Source request failed";
}
