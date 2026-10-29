import type { FeedFile } from "../types.ts";

export function assertFreshEdition(feed: FeedFile, options: { startedAt: number; now: number; maxAgeHours?: number }): void {
  if (!Number.isFinite(options.startedAt)) throw new Error("Invalid refresh start");
  if (feed.source_total === 0 && feed.count === 0) return;
  if (feed.refresh_status === "failed" || feed.count === 0 || feed.source_ok === 0) throw new Error("Refresh failed or produced no usable content");
  const success = Date.parse(feed.last_successful_generated_at ?? "");
  if (!Number.isFinite(success) || success < options.startedAt || success > options.now + 60_000
    || options.now - success > (options.maxAgeHours ?? 30) * 3.6e6) throw new Error("Content is not fresh for this run");
}
