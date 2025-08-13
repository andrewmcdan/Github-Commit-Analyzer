# GitHub Change Summarizer

A tiny full-stack app (Express + React/Vite) that:

✅ Takes a GitHub repo + date range

✅ Lists commits (optionally across any branch)

✅ Fetches per-commit file diffs

✅ Uses the OpenAI API to summarize each commit

✅ Rolls everything up into a polished period summary (Markdown)

✅ Shows results in a clean, responsive web UI

✅ Streams a live analysis log with smart auto-scroll + “Jump to bottom”

License: MIT (see License)

# Architecture

### Frontend (React + Vite)

-   Form for repo + date range
-   Repo validation + branch discovery (debounced on type & on blur)
-   Branch dropdown with Any branch option
-   Live analysis log (SSE) with smart auto-scroll and Jump to bottom button
-   Results: period summary (Markdown), commit cards, file tables, export buttons

### Backend (Node/Express)

-   GitHub API (Octokit) to list commits and fetch per-commit diffs
-   OpenAI Responses API to summarize commits and produce a period summary
-   SSE endpoint to stream progress messages to the UI
-   Repo validation & branches endpoint
-   Model-aware invocation (omits temperature for GPT-5 models)

# Repo Layout

```
gh-change-summarizer/
├─ server/
│  ├─ package.json
│  ├─ .env.example
│  └─ index.js
├─ client/
│  ├─ package.json
│  ├─ vite.config.js
│  ├─ index.html
│  └─ src/
│     ├─ main.jsx
│     ├─ App.jsx
│     ├─ api.js
│     └─ styles.css
└─ README.md
```

# Requirements

-   Node.js 18+ (tested on 18/20)
-   npm 9+ (or pnpm/yarn if you prefer)
-   OpenAI API key (required)
-   GitHub token (optional but recommended for higher rate limits; required for private repos)

# Quick Start

```bash
# 1) Backend
cd server
cp .env.example .env
# edit .env and set OPENAI_API_KEY; optionally GITHUB_TOKEN
npm install
npm run dev

# 2) Frontend (new terminal)
cd ../client
npm install
npm run dev
```

### Open the app:

http://localhost:5173

# Configuration

Create server/.env:

```ini
# Required
OPENAI_API_KEY=sk-...yourkey...

# Optional, but highly recommended to avoid rate limits and to access private repos
GITHUB_TOKEN=ghp_...yourtoken...

# Model: Examples: gpt-4o-mini, gpt-4o, gpt-5, gpt-5-mini, gpt-5-nano
# For GPT-5 models, temperature is omitted by the server.
OPENAI_MODEL=gpt-4o-mini

# Server port
PORT=8787
```

Environment Status: The UI shows whether your OpenAI key / GitHub token are loaded from .env, and which model is active. Inputs are not exposed in the UI by design.

# Running

### Development

The server runs on http://localhost:8787

The client (Vite dev server) runs on http://localhost:5173 and proxies /api to the server

```bash
# server
cd server && npm run dev

# client
cd client && npm run dev
```

### Production (simple)

1. Build the client:

```bash
cd client
npm run build
npm run preview # quick local test
```

2. Serve the built client/dist with your preferred static hosting (Nginx, Netlify, S3+CloudFront, etc.) and run the server separately behind a reverse proxy (or add a static handler to Express if you want a single process). Keep the /api/\* routes pointing to the server.

-   This repo ships as two lightweight services for clarity. For a single-process deployment, you can add “serve built UI from Express” if desired.

# Using the App

1. Enter Repository as owner/repo or a GitHub URL
2. Pause typing or tab out → the app validates the repo and loads branches
3. Choose Branch (or Any branch)
4. Pick your date range
5. Click Analyze
6. Watch the Live Analysis Log to track progress
7. Read the Period Summary, inspect Commits, and copy/download the Markdown report

# API Reference

-   All endpoints are under the server base URL (default http://localhost:8787).


### `GET /api/health`

-   Health check.

#### Response

```json
{ "ok": true }
```

----
### `GET /api/config`

-   Returns environment indicators for the UI.

#### Response

```json
{
    "hasOpenAIKey": true,
    "hasGithubToken": true,
    "openaiModel": "gpt-4o-mini"
}
```

----
### `GET /api/repo/branches`

-   Validates a repo and returns its branch list.

#### Query

```bash
/api/repo/branches?repo=<owner/repo or full GitHub URL>
```

#### Response

```json
{
    "ok": true,
    "repo": "owner/repo",
    "defaultBranch": "main",
    "private": false,
    "branches": ["main", "develop", "release"]
}
```

----
### `GET /api/progress/:id (SSE)`

-   Server-Sent Events stream for incremental progress log lines.
-   The client generates a requestId and opens this endpoint before calling /api/analyze.

#### Events:

-   message (default) { ts, msg }
-   ready (SSE event) → stream established
-   done (SSE event) → analysis finished; server closes channel

The UI auto-scrolls while you’re at the bottom and shows a Jump to bottom button if you scroll up. During programmatic scrolls the button is suppressed to avoid flicker.

-----
### `POST /api/analyze`

-   Triggers analysis for a repo within a date range.

#### Body

```json
{
    "repo": "owner/repo or URL",
    "since": "2025-07-01T00:00:00.000Z",
    "until": "2025-07-31T23:59:59.999Z",
    "branch": "main | <branchName> | **ANY**",
    "includeMerges": false,
    "maxCommits": 60,
    "requestId": "uuid-string-used-for-SSE"
}
```

#### Response

```json
{
    "repo": "owner/repo",
    "since": "2025-07-01T00:00:00.000Z",
    "until": "2025-07-31T23:59:59.999Z",
    "summaryMarkdown": "# Period Summary\n ...",
    "aggregate": {
        "count": 18,
        "files": 93,
        "additions": 1450,
        "deletions": 980,
        "typeCounts": { "feat": 5, "fix": 7, "refactor": 4, "docs": 2 },
        "riskCounts": { "low": 12, "medium": 5, "high": 1 },
        "topAreas": ["api", "ui", "build"]
    },
    "commits": [
        {
            "sha": "abc123...",
            "date": "2025-07-12T16:34:40Z",
            "author": "Jane Dev",
            "message": "feat: add API for X",
            "stats": { "additions": 220, "deletions": 35 },
            "files": [
                {
                    "filename": "src/api/x.ts",
                    "status": "modified",
                    "additions": 120,
                    "deletions": 12,
                    "patch": "..."
                }
            ],
            "ai": {
                "summary": "Short JSON-driven summary text…",
                "change_type": "feat",
                "areas": ["api"],
                "risk": "medium",
                "test_impact": "add tests for new API",
                "notable_files": ["src/api/x.ts"]
            }
        }
    ]
}
```

# Model Handling (GPT-5)

The server omits the temperature parameter whenever the selected model name includes "gpt-5" (e.g., gpt-5, gpt-5-mini, gpt-5o).
For all other models, the server uses temperature: 0.2.

### Configure in server/.env:

```ini
OPENAI_MODEL=gpt-5-mini
```

# Branch Selection: “Any branch”

When you select Any branch:

1. The server lists all branches for the repo
2. It fetches commits across those branches constrained by since/until
3. Dedupes by SHA (a commit reachable from multiple branches is counted once)
4. Caps total commits to maxCommits
5. Analyzes and aggregates as a single period report

-   You can toggle Include merge commits in the UI.

# Performance, Limits & Costs

-   Commit cap: maxCommits (UI configurable)
-   Patch truncation: Each file patch sent to the LLM is truncated (safe token budget)
-   Skip noise: Consider ignoring node_modules, dist, images, etc. (future enhancement)
-   Rate limits: Add a GitHub token to .env for higher limits & private repos
-   Costs: LLM calls scale with number/size of diffs. For very large windows, reduce maxCommits, or adopt a staged summarization pipeline (file → commit → period).

# Troubleshooting

### “Missing OpenAI key” in UI

-   Add OPENAI_API_KEY to server/.env and restart the server.

### “Repo not accessible”

-   Check the repo string format (owner/repo or GitHub URL). For private repos, set GITHUB_TOKEN in server/.env.

### Empty/short summaries

-   Large patches are truncated. Increase the window size gradually or reduce noise in the repo.

### SSE not streaming

-   Ensure your reverse proxy allows HTTP/1.1 and doesn’t buffer SSE. In dev, it should “just work.”

### CORS

-   Dev config proxies /api from client to server. In production, configure your reverse proxy accordingly.

# Roadmap

-   PR metadata enrichment (titles/links)
-   File-level first-pass summaries for better token efficiency
-   OAuth flow for per-user GitHub access
-   Caching layer for repeated analyses
-   Server-side rendered report exports (PDF/HTML)
-   Advanced filters (path globs, authors, labels)

# Contributing

PRs and issues welcome! Please keep the code paths light and dependency-minimal. If you add a feature, include a brief note in this README and keep the UI consistent with the current aesthetic.

# License
[MIT License](LICENSE)
