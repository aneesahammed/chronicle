import { readFile, readdir } from "node:fs/promises";
import YAML from "yaml";
import { fetchAll } from "../src/sources/fetchers.ts";
import type { FeedFile, Registry } from "../src/types.ts";

const registry: Registry = YAML.parse(await readFile("src/sources/registry.yaml", "utf8"));
const ids = new Set(["learn_huggingface", "learn_fullstack", "learn_fastai", "repo_vllm_releases", "metr"]);
const sources = registry.sources.filter(source => ids.has(source.id));
if (process.argv.includes("--fetch")) {
  const now = new Date();
  const result = await fetchAll({ ...registry, sources }, { now });
  for (const source of sources) {
    const items = result.items.filter(item => item.source_id === source.id);
    const hours = source.source_role === "repo" ? 168 : 36;
    const fresh = items.filter(item => item.learning?.track !== "foundations" && Date.parse(item.published_at) >= now.getTime() - hours * 36e5);
    const health = result.source_health.find(health => health.id === source.id)!;
    console.log(`${source.name}: ${health.status}; ${items.length} fetched, ${fresh.length} within ${hours}h, ${items.filter(item => item.learning?.track === "foundations").length} evergreen`);
    for (const item of items.slice(0, 2)) console.log(`  ${item.title} | ${item.learning?.publication_label ?? item.published_at} | ${item.url}`);
  }
  if (result.source_failed) process.exitCode = 1;
} else {
  const days = (await readdir("public/daily")).filter(name => /^\d{4}-\d{2}-\d{2}$/.test(name)).sort().slice(-30);
  for (const source of sources) {
    const selected = new Set<string>(), unique = new Set<string>();
    let observations = 0, healthy = 0, fresh = 0;
    const file = source.source_role === "learning" ? "learning" : source.source_role === "repo" ? "repos" : "feed";
    for (const day of days) {
      let feed: FeedFile;
      try { feed = JSON.parse(await readFile(`public/daily/${day}/${file}.json`, "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      const health = feed.source_health.find(health => health.id === source.id);
      if (!health) continue;
      observations++; healthy += Number(health.status === "ok"); fresh += health.fresh_count ?? 0;
      if (feed.refresh_status === "failed") continue; // held content is not a new contribution
      for (const cluster of feed.clusters) {
        const members = cluster.members?.length ? cluster.members : [cluster.primary];
        if (!members.some(item => item.source_id === source.id)) continue;
        selected.add(cluster.primary.url);
        if (members.every(item => item.source_id === source.id)) unique.add(cluster.primary.url);
      }
    }
    console.log(`${source.name}: ${observations} observed editions; ${healthy} reachable, ${fresh} fresh candidates; ${selected.size} distinct selected URLs, ${unique.size} unique to source`);
  }
  console.log("Counts describe archived editions, not independent verification or human usefulness ratings. Review sample items before widening the pilot.");
}
