import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

const root = resolve("public");
const port = Number(process.env.CHRONICLE_E2E_PORT || 4179);

const mime = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".woff2": "font/woff2",
  ".xml": "application/xml; charset=utf-8",
};

createServer((request, response) => {
  const url = new URL(request.url || "/", `http://127.0.0.1:${port}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith("/")) pathname += "index.html";

  const filePath = resolve(join(root, normalize(pathname)));
  if (!filePath.startsWith(root + sep) && filePath !== root) {
    response.writeHead(403).end("Forbidden");
    return;
  }

  let candidate = filePath;
  if (!existsSync(candidate) || statSync(candidate).isDirectory()) {
    candidate = resolve(join(root, "index.html"));
  }

  response.writeHead(200, {
    "Content-Type": mime[extname(candidate)] || "application/octet-stream",
    "Cache-Control": "no-store",
  });
  createReadStream(candidate).pipe(response);
}).listen(port, "127.0.0.1", () => {
  console.log(`Chronicle e2e server listening on http://127.0.0.1:${port}`);
});
