import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../pipeline/atomic-write.ts";

const ASSETS = ["app.js", "app.css", "mobile-reader-state.js", "theme.js", "sw-register.js", "archive.js", "policy.js"];
const MANIFEST_START = "// CHRONICLE_ASSETS_START";
const MANIFEST_END = "// CHRONICLE_ASSETS_END";
const digest = (content: string) => createHash("sha256").update(content).digest("hex").slice(0, 16);

// New HTML must never request a mutable URL that an older service worker can
// resolve to old code. Query parameters cannot fix workers using ignoreSearch.
export async function publishVersionedAssets(publicDir: string): Promise<void> {
  const manifest: Record<string, string> = {};
  for (const name of ASSETS) {
    const content = await optionalText(path.join(publicDir, name));
    if (content === null) continue; // Minimal renderer fixtures need no browser assets.
    const extension = path.extname(name);
    const versioned = `/assets/${path.basename(name, extension)}.${digest(content)}${extension}`;
    await writeFileAtomic(path.join(publicDir, versioned), content);
    manifest[`/${name}`] = versioned;
  }
  if (!Object.keys(manifest).length) return;
  const manifestText = JSON.stringify(manifest, null, 2) + "\n";
  await writeFileAtomic(path.join(publicDir, "assets/manifest.json"), manifestText);

  const rewrite = (html: string) => html.replace(/\b(src|href)="(\/[^"?#]+)(?:\?[^"#]*)?"/g, (match, attribute, url) => {
    const original = url.replace(/^\/assets\//, "/").replace(/\.[a-f0-9]{16}\.(js|css)$/, ".$1");
    return manifest[original] ? `${attribute}="${manifest[original]}"` : match;
  });
  await rewritePages(publicDir, rewrite);

  const workerPath = path.join(publicDir, "sw.js");
  const worker = await optionalText(workerPath);
  if (worker !== null) {
    const section = new RegExp(`${MANIFEST_START}[\\s\\S]*?${MANIFEST_END}`);
    if (!section.test(worker)) throw new Error("Service worker asset markers missing");
    const normalized = worker.replace(section, "ASSET_MANIFEST").replace(/const CACHE_VERSION = "[^"]+";/, "CACHE_VERSION");
    const next = worker
      .replace(section, `${MANIFEST_START}\nconst VERSIONED_ASSETS = ${JSON.stringify(Object.values(manifest), null, 2)};\n${MANIFEST_END}`)
      .replace(/const CACHE_VERSION = "[^"]+";/, `const CACHE_VERSION = "assets-${digest(manifestText + normalized)}";`);
    if (next !== worker) await writeFileAtomic(workerPath, next);
  }
}

async function rewritePages(directory: string, rewrite: (html: string) => string): Promise<void> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.name === "assets") continue;
    const location = path.join(directory, entry.name);
    if (entry.isDirectory()) await rewritePages(location, rewrite);
    else if (entry.name.endsWith(".html")) {
      const current = await fs.readFile(location, "utf8");
      const next = rewrite(current);
      if (next !== current) await writeFileAtomic(location, next);
    }
  }
}

async function optionalText(file: string): Promise<string | null> {
  try { return await fs.readFile(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
