export function sanitizeImageUrl(value: string | undefined, baseUrl?: string): string | undefined {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;
  try {
    const url = baseUrl ? new URL(raw, baseUrl) : new URL(raw);
    if (url.protocol !== "https:") return undefined;
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

export function extractFirstImageFromHtml(html: string | undefined, baseUrl?: string): string | undefined {
  if (!html) return undefined;
  const imgTags = html.match(/<img\b[^>]*>/gi) ?? [];
  for (const tag of imgTags) {
    const src = attr(tag, "src") ?? attr(tag, "data-src");
    const safe = sanitizeImageUrl(src, baseUrl);
    if (safe) return safe;
  }
  return undefined;
}

export function attr(tag: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = tag.match(new RegExp(`\\b${escaped}\\s*=\\s*(["'])(.*?)\\1`, "i"));
  return match?.[2];
}
