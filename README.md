# RepoLens

Paste a GitHub repo URL and get an instant health report — calculated metrics plus an AI-written narrative, all client-side.

**Live demo:** https://ns-cehelsky.github.io/repolens/

---

## How it works

1. **Paste a URL** — any GitHub repo URL (`https://github.com/owner/repo`) or bare `owner/repo` slug.
2. **Data is fetched** — five GitHub REST API endpoints are called in parallel: repo metadata, languages, commit activity, contributors, and recent issues.
3. **Four health metrics are computed** — Activity, Responsiveness, Bus Factor, and Hygiene — each scored 0–100 and combined into a weighted overall score with a letter grade (A–F).
4. **An AI report is generated** — the metric data is summarised and sent to the Groq API (Llama 3.3 70B), which returns a concise plain-prose health report with a verdict, strengths/risks, and concrete recommendations.

Metrics render immediately; the AI report loads in a few seconds below them.

---

## Features

- **Activity score** — days since last push + commit frequency over the last 4 weeks
- **Responsiveness score** — average issue resolution time and open/closed issue ratio (pull requests filtered out automatically)
- **Bus factor score** — top contributor's share of all commits; penalises single-contributor projects
- **Hygiene score** — checks for license, description, archived status, and issues enabled (25 pts each)
- **Weighted overall grade** — A/B/C/D/F, with Activity weighted heaviest (30 %)
- **Language breakdown** — horizontal bar chart of the top 7 languages by byte count
- **Top contributors** — avatars, commit counts, and relative share bars for the top 5 contributors
- **AI narrative report** — 150–220-word plain-prose report from Llama 3.3 70B via Groq, referencing actual numbers from the repo
- **Optional GitHub token** — raises the unauthenticated rate limit from 60 to 5,000 requests/hour
- **Keys persisted locally** — Groq key and GitHub token saved to `localStorage` so you don't re-enter them each visit

---

## Tech stack

| Layer | Detail |
|---|---|
| Frontend | Vanilla HTML, CSS, JavaScript — no framework, no build step |
| Data | [GitHub REST API v3](https://docs.github.com/en/rest) — fetched directly from the browser |
| AI | [Groq API](https://console.groq.com) — `llama-3.3-70b-versatile` |
| Hosting | Static file — works on GitHub Pages, Netlify, or any file server |

No backend. No npm. No bundler. Open the file and it works.

---

## Setup

### Option A — open directly

```
open index.html
```

Most modern browsers allow direct file access. If the GitHub API calls are blocked by CORS in your browser's strict mode, use Option B.

### Option B — local server (recommended)

```bash
# Python 3
python -m http.server 8080

# Node (npx)
npx serve .
```

Then open `http://localhost:8080`.

### Usage

1. Get a free Groq API key at [console.groq.com/keys](https://console.groq.com/keys)
2. (Optional) Create a GitHub Personal Access Token at [github.com/settings/tokens](https://github.com/settings/tokens) — no scopes needed for public repos
3. Paste both keys in the sidebar and click **Save Keys**
4. Enter any public GitHub repo URL or `owner/repo` and click **Analyze**

---

## Privacy

API keys are stored only in your browser's `localStorage`. They are never sent to any server except directly from your browser to GitHub's API (`api.github.com`) and Groq's API (`api.groq.com`). No analytics, no tracking, no backend.

---

## Metric weights

| Metric | Weight | What it measures |
|---|---|---|
| Activity | 30 % | Recency of last push + commit frequency (last 4 weeks) |
| Responsiveness | 25 % | Issue resolution speed + open/closed ratio |
| Bus Factor | 20 % | Contributor concentration risk |
| Hygiene | 25 % | License, description, archived status, issues enabled |

---

Built by [NS-Cehelsky](https://github.com/NS-Cehelsky)
