import { readFileSync } from "node:fs";
import type { FeedFile } from "../src/types.ts";

for (const file of ["feed", "repos", "learning"]) {
  const feed: FeedFile = JSON.parse(readFileSync(`public/${file}.json`, "utf8"));
  console.log(`${file}: ${feed.source_ok}/${feed.source_total} reachable; ${feed.source_health.filter(s => (s.fresh_count ?? 0) > 0).length} contributed fresh items`);
  for (const source of feed.source_health) {
    if (source.selected_count !== undefined) {
      console.log(`  ${source.id}: ${source.fetched_count} fetched, ${source.fresh_count ?? 0} fresh, ${source.evergreen_count ?? 0} evergreen; ${source.selected_count} selected, ${source.unique_selected_count ?? 0} unique to this source`);
    }
    if ((source.consecutive_failures ?? 0) >= 3) {
      console.warn(`::warning::${source.id}: ${source.consecutive_failures} consecutive failed runs; repair or quarantine this source`);
    } else if ((source.consecutive_empty ?? 0) >= 9) {
      console.warn(`::warning::${source.id}: no fresh items for ${source.consecutive_empty} runs; review cadence and timestamps`);
    }
  }
  for (const cluster of feed.clusters) {
    const learning = cluster.primary.learning;
    if (learning?.track === "foundations" && (!learning.reviewed_at || Date.now() - Date.parse(learning.reviewed_at) > 90 * 864e5)) {
      console.warn(`::warning::${cluster.primary.title}: course syllabus review is due (90-day cadence)`);
    }
  }
}
