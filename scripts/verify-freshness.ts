import { readFileSync } from "node:fs";
import { assertFreshEdition } from "../src/pipeline/freshness.ts";

for (const file of ["feed", "repos", "learning"]) {
  const feed = JSON.parse(readFileSync(`public/${file}.json`, "utf8"));
  assertFreshEdition(feed, { startedAt: Date.parse(process.env.CHRONICLE_REFRESH_STARTED_AT ?? ""), now: Date.now() });
  console.log(`${file}: successful content is fresh`);
}
