import { promises as fs } from "node:fs";
import { writeRenderedHomePage, writeRenderedDailyPage, writeFeedSchema, writeSyndicationFeeds } from "../src/render/static-site.ts";

const root = "public";
const feed = JSON.parse(await fs.readFile(`${root}/feed.json`, "utf8"));
feed.section_counts = { main: feed.count };
for (const [role, file] of [["repo", "repos"], ["learning", "learning"]]) feed.section_counts[role] = JSON.parse(await fs.readFile(`${root}/${file}.json`, "utf8")).count;
await writeRenderedHomePage(root, feed);
await writeFeedSchema(root);
await writeSyndicationFeeds(root, feed);
for (const date of (await fs.readdir(`${root}/daily`)).filter(name => /^\d{4}-\d{2}-\d{2}$/.test(name))) {
  const snapshot = JSON.parse(await fs.readFile(`${root}/daily/${date}/feed.json`, "utf8"));
  snapshot.section_counts = { main: snapshot.count };
  for (const [role, file] of [["repo", "repos"], ["learning", "learning"]]) {
    try { snapshot.section_counts[role] = JSON.parse(await fs.readFile(`${root}/daily/${date}/${file}.json`, "utf8")).count; } catch { /* no role snapshot */ }
  }
  await writeRenderedDailyPage(root, snapshot);
}
