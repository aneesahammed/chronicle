# Chronicle

Chronicle is a daily AI/ML signal filter for builders. It clusters duplicate
coverage, scores novelty against recent history, ranks source quality, and
downranks repeated hype.

Public site: https://chronicle.tinycrafts.ai/

The product code and generated static artifacts live on the `pages` branch. The
scheduled GitHub Actions workflow refreshes Chronicle at 05:17, 12:17, and
18:17 UTC, then deploys the rendered static site to GitHub Pages.

## What Chronicle Generates

- Rendered HTML for the current brief and daily archives.
- JSON feeds for news, repositories, and learning resources.
- RSS and Atom feeds for feed-reader users.
- Source-health and refresh metadata for trust and debugging.

## Development

```bash
git checkout pages
npm ci
npm run check
npm run run:pipeline
npm run verify:all
```
