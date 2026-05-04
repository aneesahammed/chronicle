# Chronicle

Chronicle is a daily AI signal filter for builders. It clusters duplicate
AI/ML links, classifies each item, scores novelty against a 30-day rolling
history, and ranks by a composite signal score.

Static site, no backend. The Chronicle workflow runs the pipeline three times a
day at 09:00, 12:00, and 18:00 UTC, commits two JSON files, uploads `public/`
as the GitHub Pages artifact, and deploys GitHub Pages.

`public/feed.json` and `data/history.json` are intentionally committed by the
scheduled workflow. The feed gives GitHub Pages a static file to serve, and the
history file gives novelty scoring durable state without adding a database or
separate storage service.

## Pipeline

```
sources → fetch → canonicalize → window-filter → cluster
                                                     ↓
                 novelty ← history ← classify (Gemini, Groq fallback)
                                                     ↓
                                                   score
                                                     ↓
                                feed.json / repos.json / learning.json
```

- **Canonicalize** strips `utm_*`, `fbclid`, `/amp`, fragments, default ports,
  `www.`, normalizes arXiv `pdf` ↔ `abs`.
- **Cluster** is two-stage: exact canonical URL match, then trigram Jaccard on
  titles (≥ 0.55). No embeddings in v1.
- **Classify** runs main-feed clusters through Gemini structured output first,
  then Groq as fallback. Repo and learning feeds use deterministic
  classification so release/video sources do not burn LLM tokens.
- **Novelty** is `1 − max trigram-Jaccard against 30 days of history`.
- **Score** is a weighted sum of trust, novelty, quality, cluster-size, recency.

## Local run

```bash
npm install
GEMINI_API_KEY=... npm run run:pipeline
npm run verify:all
npx --yes serve public
```

Run without an API key to see the fallback path for the main feed. Repo and
learning feeds are deterministic by design.

## Deploy

1. Settings → Pages → Source: **GitHub Actions**.
2. Settings → Secrets and variables → Actions → add `GEMINI_API_KEY`.
   `GROQ_API_KEY` is optional fallback.
3. Push the `pages` branch for app and feed code changes.
4. Trigger `Refresh Chronicle` manually for the first run.

Scheduled workflows run from the repository default branch. Keep the workflow
on `main`; it checks out `pages`, refreshes the feed there, commits the feed
state back to `pages`, and deploys `public/` to GitHub Pages.

## Tuning

All knobs live in source. Eyeball output for a week, then adjust:

- **Trust weights**: `src/sources/registry.yaml`
- **Cluster threshold**: `TITLE_THRESHOLD` in `src/pipeline/cluster.ts`
- **Score weights**: `W` in `src/pipeline/score.ts`
- **Main window**: `WINDOW_HOURS` env (default 36)
- **Repo window**: `REPO_WINDOW_HOURS` env (default 168)
- **Learning window**: `LEARNING_WINDOW_HOURS` env (default 720)
- **Output cap**: `MAX_OUTPUT` env (default 60)
- **Repo output cap**: `REPO_MAX_OUTPUT` env (default 40)
- **Learning output cap**: `LEARNING_MAX_OUTPUT` env (default 40)
- **LLM provider order**: `LLM_PROVIDER_ORDER` env (default `gemini,groq`)
- **Gemini model**: `GEMINI_MODEL` env (default `gemini-2.5-flash`)
- **Groq fallback model**: `GROQ_MODEL` env (default `qwen/qwen3-32b`)

## Cost

Gemini calls are roughly proportional to fresh main-feed clusters. Repo releases,
trending repos, videos, and courses skip LLM classification. GitHub Actions
provides `GITHUB_TOKEN` for repo radar API calls.

DataCamp AI and Karpathy's YouTube are intentionally not enabled as scheduled
sources yet. DataCamp returned 403 to direct Node fetches, and Karpathy's
verified YouTube feed had no new 2026 video when checked on 2026-05-04.

## v2 backlog (deferred on purpose)

- **Claims as units.** Cluster across stories that report the *same fact*,
  not just the same URL/title. Needs entity extraction + claim normalization.
- **Embedding-based clustering** for paraphrased coverage that trigrams miss.
- **Per-source quality learning.** Track how often a source produces `signal`
  vs `hype` over time, fold into trust.
- **Personal weighting.** Let the user upvote/downvote; persist to localStorage.
- **RSS output** of the curated feed.
- **Email digest** via a separate Action.
- **Twitter/X** ingestion (probably via Nitter mirrors, fragile).
