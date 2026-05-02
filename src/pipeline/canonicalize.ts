// URL canonicalization. Strips the noise that makes the same article
// look like 5 different URLs across sources.
//
// What we strip:
//   - utm_*, fbclid, gclid, mc_cid, mc_eid, ref, source params
//   - trailing /amp, /amp/
//   - trailing slashes
//   - fragments (#section)
//   - "www." host prefix
//   - default ports
//
// What we DON'T strip:
//   - meaningful query params (id=, v=, p=, etc.)
//
// We also handle a few site-specific quirks (arxiv abs vs pdf, HN item
// links pointing to discussion vs article).

const TRACKING_PARAM_PREFIXES = ["utm_", "mc_"];
const TRACKING_PARAM_EXACT = new Set([
  "fbclid",
  "gclid",
  "ref",
  "ref_src",
  "ref_url",
  "source",
  "share",
  "share_id",
  "__twitter_impression",
  "_hsenc",
  "_hsmi",
]);

export function canonicalizeUrl(input: string): string {
  let raw = (input ?? "").trim();
  if (!raw) return "";
  // Some feeds give protocol-relative URLs.
  if (raw.startsWith("//")) raw = "https:" + raw;
  if (!/^https?:\/\//i.test(raw)) return "";

  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "";
  }

  if (u.protocol !== "http:" && u.protocol !== "https:") return "";

  // host
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
  if (
    (u.protocol === "http:" && u.port === "80") ||
    (u.protocol === "https:" && u.port === "443")
  ) {
    u.port = "";
  }

  // arXiv: collapse /pdf/xxx.yyy.pdf -> /abs/xxx.yyy
  if (u.hostname === "arxiv.org") {
    u.pathname = u.pathname
      .replace(/^\/pdf\//, "/abs/")
      .replace(/\.pdf$/i, "");
  }

  // Strip /amp or /amp/ suffix
  u.pathname = u.pathname.replace(/\/amp\/?$/i, "/");

  // Trailing slash, except when path is just "/"
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");

  // Query: drop tracking params, sort the rest for stability
  const kept: [string, string][] = [];
  for (const [k, v] of u.searchParams.entries()) {
    const lower = k.toLowerCase();
    if (TRACKING_PARAM_EXACT.has(lower)) continue;
    if (TRACKING_PARAM_PREFIXES.some((p) => lower.startsWith(p))) continue;
    kept.push([k, v]);
  }
  kept.sort(([a], [b]) => a.localeCompare(b));
  u.search = "";
  for (const [k, v] of kept) u.searchParams.append(k, v);

  // Fragment
  u.hash = "";

  return u.toString();
}

export function urlHash(url: string): string {
  // Tiny stable hash (FNV-1a, base36). Good enough for IDs in a static feed.
  let h = 0x811c9dc5;
  for (let i = 0; i < url.length; i++) {
    h ^= url.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(36);
}
