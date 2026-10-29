import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { publishVersionedAssets } from "./assets.ts";

test("page and worker references change with asset content and keep old assets available", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chronicle-assets-"));
  try {
    await fs.mkdir(path.join(root, "daily", "2026-10-29"), { recursive: true });
    const html = '<link href="/app.css" rel="stylesheet"><script src="/app.js"></script>';
    for (const file of ["index.html", "methodology.html", "daily/2026-10-29/index.html"]) await fs.writeFile(path.join(root, file), html);
    await fs.writeFile(path.join(root, "app.js"), "console.log('one')");
    await fs.writeFile(path.join(root, "app.css"), "body { color: black; }");
    await fs.writeFile(path.join(root, "sw.js"), 'const CACHE_VERSION = "old";\n// CHRONICLE_ASSETS_START\nconst VERSIONED_ASSETS = [];\n// CHRONICLE_ASSETS_END\n');
    await publishVersionedAssets(root);
    const before = JSON.parse(await fs.readFile(path.join(root, "assets/manifest.json"), "utf8"));
    const workerBefore = await fs.readFile(path.join(root, "sw.js"), "utf8");
    for (const file of ["index.html", "methodology.html", "daily/2026-10-29/index.html"]) {
      const rendered = await fs.readFile(path.join(root, file), "utf8");
      assert.ok(rendered.includes(before["/app.js"]));
      assert.ok(rendered.includes(before["/app.css"]));
    }
    assert.ok(workerBefore.includes(before["/app.js"]));
    await publishVersionedAssets(root);
    assert.equal(await fs.readFile(path.join(root, "sw.js"), "utf8"), workerBefore);
    await fs.writeFile(path.join(root, "app.js"), "console.log('two')");
    await publishVersionedAssets(root);
    const after = JSON.parse(await fs.readFile(path.join(root, "assets/manifest.json"), "utf8"));
    assert.notEqual(after["/app.js"], before["/app.js"]);
    assert.equal(after["/app.css"], before["/app.css"]);
    assert.notEqual(await fs.readFile(path.join(root, "sw.js"), "utf8"), workerBefore);
    assert.equal(await fs.readFile(path.join(root, before["/app.js"]), "utf8"), "console.log('one')");
    assert.ok((await fs.readFile(path.join(root, "index.html"), "utf8")).includes(after["/app.js"]));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
