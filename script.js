// ── State ──────────────────────────────────────────────────────────────────

let groqKey     = '';
let githubToken = '';

// ── Init ───────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  groqKey     = localStorage.getItem('repolens_groq_key')     || '';
  githubToken = localStorage.getItem('repolens_github_token') || '';

  if (groqKey)     document.getElementById('groqKey').value     = groqKey;
  if (githubToken) document.getElementById('githubToken').value = githubToken;
  if (groqKey)     setKeysStatus('Keys loaded', 'ok');

  document.getElementById('repoInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') analyzeRepo();
  });
});

// ── Key management ─────────────────────────────────────────────────────────

function saveKeys() {
  const groqVal   = document.getElementById('groqKey').value.trim();
  const githubVal = document.getElementById('githubToken').value.trim();

  if (!groqVal) {
    setKeysStatus('Groq API key is required', 'err');
    return;
  }

  groqKey     = groqVal;
  githubToken = githubVal;

  localStorage.setItem('repolens_groq_key', groqKey);
  if (githubToken) {
    localStorage.setItem('repolens_github_token', githubToken);
  } else {
    localStorage.removeItem('repolens_github_token');
  }

  setKeysStatus('Keys saved', 'ok');
}

function setKeysStatus(msg, cls) {
  const el = document.getElementById('keysStatus');
  el.textContent = msg;
  el.className = 'keys-status ' + (cls || '');
}

// ── Input parsing ──────────────────────────────────────────────────────────

function parseRepoInput(input) {
  let s = input.trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');

  if (s.startsWith('github.com/')) s = s.slice('github.com/'.length);

  const parts = s.split('/');
  if (parts.length < 2) return null;

  const owner = parts[0];
  const repo  = parts[1];
  if (!owner || !repo) return null;
  if (!/^[\w.\-]+$/.test(owner) || !/^[\w.\-]+$/.test(repo)) return null;

  return { owner, repo };
}

// ── GitHub API helpers ─────────────────────────────────────────────────────

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function githubFetch(url) {
  const headers = githubToken ? { 'Authorization': `Bearer ${githubToken}` } : {};
  return fetch(url, { headers });
}

async function fetchCommitActivity(owner, repo) {
  const url = `https://api.github.com/repos/${owner}/${repo}/stats/commit_activity`;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(1500);
    const res = await githubFetch(url);
    if (res.status === 202) continue;
    if (!res.ok)            return null;
    return res.json();
  }
  return null;
}

async function fetchRepoData(owner, repo) {
  const base = `https://api.github.com/repos/${owner}/${repo}`;

  const [repoRes, languagesRes, contributorsRes, issuesRes, commitActivity] = await Promise.all([
    githubFetch(base),
    githubFetch(`${base}/languages`),
    githubFetch(`${base}/contributors?per_page=100`),
    githubFetch(`${base}/issues?state=all&per_page=100&sort=created&direction=desc`),
    fetchCommitActivity(owner, repo),
  ]);

  if (repoRes.status === 404) throw new Error('NOT_FOUND');
  if (repoRes.status === 403) {
    const remaining = repoRes.headers.get('x-ratelimit-remaining');
    if (remaining !== null && remaining === '0') throw new Error('RATE_LIMIT');
    throw new Error('FORBIDDEN');
  }
  if (!repoRes.ok) throw new Error(`GitHub API error ${repoRes.status}`);

  const [repoData, languages, contributors, issues] = await Promise.all([
    repoRes.json(),
    languagesRes.ok ? languagesRes.json() : {},
    (contributorsRes.ok && contributorsRes.status !== 204) ? contributorsRes.json() : [],
    issuesRes.ok ? issuesRes.json() : [],
  ]);

  return { repo: repoData, languages, commitActivity, contributors, issues };
}

// ── Metric calculations (pure) ─────────────────────────────────────────────

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function calcActivityScore(repo, commitActivity) {
  const daysSincePush  = (Date.now() - new Date(repo.pushed_at)) / 86400000;
  // 100 at <=7 days, linear decay to 0 at >=365 days
  const recencyScore   = clamp(100 - (daysSincePush - 7) * (100 / 358), 0, 100);

  if (!commitActivity || commitActivity.length === 0) {
    return {
      score:          Math.round(recencyScore),
      daysSincePush:  Math.round(daysSincePush),
      recencyScore:   Math.round(recencyScore),
      frequencyScore: null,
      recentCommits:  null,
    };
  }

  const last4          = commitActivity.slice(-4);
  const recentCommits  = last4.reduce((s, w) => s + w.total, 0);
  const frequencyScore = Math.min(100, recentCommits * 5);
  const score          = Math.round((recencyScore + frequencyScore) / 2);

  return {
    score,
    daysSincePush:  Math.round(daysSincePush),
    recencyScore:   Math.round(recencyScore),
    frequencyScore: Math.round(frequencyScore),
    recentCommits,
  };
}

function calcResponsivenessScore(issues) {
  // GitHub's /issues endpoint includes PRs — exclude them
  const realIssues   = issues.filter(i => !i.pull_request);
  const openIssues   = realIssues.filter(i => i.state === 'open');
  const closedIssues = realIssues.filter(i => i.state === 'closed' && i.closed_at);
  const total        = openIssues.length + closedIssues.length;

  if (total === 0) {
    return { score: 70, noData: true };
  }

  let resolutionScore   = 100;
  let avgResolutionDays = null;

  if (closedIssues.length > 0) {
    const totalDays = closedIssues.reduce((s, i) =>
      s + (new Date(i.closed_at) - new Date(i.created_at)) / 86400000, 0);
    avgResolutionDays = totalDays / closedIssues.length;
    // 100 at <=2 days, linear decay to 0 at >=30 days
    resolutionScore = clamp(100 - (avgResolutionDays - 2) * (100 / 28), 0, 100);
  }

  const openRatio  = openIssues.length / total;
  const ratioScore = (1 - openRatio) * 100;
  const score      = Math.round((resolutionScore + ratioScore) / 2);

  return {
    score,
    noData:           false,
    avgResolutionDays,
    resolutionScore:  Math.round(resolutionScore),
    ratioScore:       Math.round(ratioScore),
    openCount:        openIssues.length,
    closedCount:      closedIssues.length,
  };
}

function calcBusFactorScore(contributors) {
  if (!contributors || contributors.length === 0) {
    return { score: 50 };
  }
  if (contributors.length === 1) {
    return { score: 10, topLogin: contributors[0].login, topShare: 100, singleContributor: true };
  }
  const total    = contributors.reduce((s, c) => s + c.contributions, 0);
  const topShare = contributors[0].contributions / total;
  return {
    score:              Math.round((1 - topShare) * 100),
    topLogin:           contributors[0].login,
    topShare:           Math.round(topShare * 100),
    singleContributor:  false,
    totalContributions: total,
  };
}

function calcHygieneScore(repo) {
  const checks = {
    license:     repo.license !== null,
    description: !!(repo.description && repo.description.trim()),
    notArchived: repo.archived === false,
    hasIssues:   repo.has_issues === true,
  };
  return {
    score:       Object.values(checks).filter(Boolean).length * 25,
    checks,
    licenseName: repo.license?.spdx_id || null,
  };
}

function computeMetrics(rawData) {
  const activity       = calcActivityScore(rawData.repo, rawData.commitActivity);
  const responsiveness = calcResponsivenessScore(rawData.issues);
  const busFactor      = calcBusFactorScore(rawData.contributors);
  const hygiene        = calcHygieneScore(rawData.repo);

  // Weighted overall score
  const score = Math.round(
    activity.score       * 0.30 +
    responsiveness.score * 0.25 +
    busFactor.score      * 0.20 +
    hygiene.score        * 0.25
  );
  const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F';

  return { activity, responsiveness, busFactor, hygiene, overall: { score, grade } };
}

// ── Render helpers ─────────────────────────────────────────────────────────

const escHtml = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const fmtNum = n => n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n);

function activityNote(a) {
  const d = a.daysSincePush;
  const push = d === 0 ? 'Pushed today' : d === 1 ? 'Last push yesterday' : `Last push ${d} days ago`;
  if (a.recentCommits !== null) {
    const c = a.recentCommits;
    return `${push} · ${c} commit${c !== 1 ? 's' : ''} in last 4 weeks`;
  }
  return `${push} · commit history unavailable`;
}

function responsivenessNote(r) {
  if (r.noData) return 'No issues found — score defaulted to 70';
  const total     = r.openCount + r.closedCount;
  const pctClosed = Math.round(r.closedCount / total * 100);
  if (r.avgResolutionDays === null) {
    return `${r.openCount} open, ${r.closedCount} closed · no resolved issues to average`;
  }
  const d      = r.avgResolutionDays;
  const avgStr = d < 1 ? '< 1 day' : `${d.toFixed(1)} days`;
  return `Avg. resolution ${avgStr} · ${pctClosed}% of issues closed`;
}

function busFactorNote(b) {
  if (!b.topLogin)          return 'No contributor data';
  if (b.singleContributor)  return 'Single contributor — high bus factor risk';
  return `Top contributor (${escHtml(b.topLogin)}) holds ${b.topShare}% of all commits`;
}

function gradeColorClass(grade) {
  if (grade === 'A' || grade === 'B') return 'grade-good';
  if (grade === 'C')                  return 'grade-warn';
  return 'grade-bad';
}

// ── HTML fragment builders ─────────────────────────────────────────────────

function buildMetricCard(label, score, noteHtml) {
  return `
    <div class="metric-card">
      <div class="metric-header">
        <span class="metric-label">${label}</span>
        <span class="metric-score">${score}</span>
      </div>
      <div class="metric-bar-track">
        <div class="metric-bar-fill" data-target="${score}"></div>
      </div>
      ${noteHtml}
    </div>`;
}

function buildHygieneCard(h) {
  const CHECKS = [
    { pass: h.checks.license,     label: h.checks.license     ? `License · ${h.licenseName || 'present'}` : 'No license detected'     },
    { pass: h.checks.description, label: h.checks.description ? 'Description present'                      : 'No description'          },
    { pass: h.checks.notArchived, label: h.checks.notArchived ? 'Not archived'                             : 'Repository is archived'  },
    { pass: h.checks.hasIssues,   label: h.checks.hasIssues   ? 'Issues enabled'                          : 'Issues disabled'         },
  ];
  const checksHtml = `<div class="hygiene-checks">${
    CHECKS.map(c => `
      <div class="hygiene-row">
        <div class="hygiene-dot ${c.pass ? 'pass' : 'fail'}"></div>
        <span>${c.label}</span>
      </div>`).join('')
  }</div>`;
  return buildMetricCard('Hygiene', h.score, checksHtml);
}

function buildRepoHeader(repo) {
  const ICONS = {
    star: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
    fork: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="2"/><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v4a2 2 0 0 0 2 2h4" stroke-linecap="round"/><path d="M18 7v8a2 2 0 0 1-2 2h-2" stroke-linecap="round"/></svg>`,
    code: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`,
  };
  return `
    <div class="repo-header">
      <div class="repo-title-row">
        <a class="repo-link" href="https://github.com/${escHtml(repo.full_name)}"
           target="_blank" rel="noopener">${escHtml(repo.full_name)}</a>
        ${repo.archived ? '<span class="archived-badge">Archived</span>' : ''}
      </div>
      ${repo.description ? `<p class="repo-description">${escHtml(repo.description)}</p>` : ''}
      <div class="repo-meta">
        <span class="repo-meta-item">${ICONS.star} ${fmtNum(repo.stargazers_count)}</span>
        <span class="repo-meta-item">${ICONS.fork} ${fmtNum(repo.forks_count)}</span>
        ${repo.language ? `<span class="repo-meta-item">${ICONS.code} ${escHtml(repo.language)}</span>` : ''}
      </div>
    </div>`;
}

function buildLanguages(languages) {
  const entries = Object.entries(languages).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return '';

  const total  = entries.reduce((s, [, v]) => s + v, 0);
  const COLORS = ['#818cf8', '#34d399', '#fbbf24', '#f87171', '#a78bfa', '#60a5fa', '#fb923c'];

  const rows = entries.slice(0, 7).map(([lang, bytes], i) => {
    const pct = (bytes / total * 100).toFixed(1);
    return `
      <div class="language-row">
        <span class="language-name">${escHtml(lang)}</span>
        <div class="language-bar-track">
          <div class="language-bar-fill" data-target="${pct}"
               style="background:${COLORS[i % COLORS.length]}"></div>
        </div>
        <span class="language-pct">${pct}%</span>
      </div>`;
  }).join('');

  return `
    <div class="section-block">
      <div class="section-title">Languages</div>
      ${rows}
    </div>`;
}

function buildContributors(contributors) {
  if (!contributors || contributors.length === 0) return '';

  const top5  = contributors.slice(0, 5);
  const total = contributors.reduce((s, c) => s + c.contributions, 0);
  const maxC  = top5[0].contributions;

  const rows = top5.map(c => {
    const pct  = Math.round(c.contributions / total * 100);
    const barW = Math.round(c.contributions / maxC * 100);
    return `
      <div class="contributor-row">
        <img class="contributor-avatar"
             src="${escHtml(c.avatar_url)}" alt="${escHtml(c.login)}" loading="lazy" />
        <span class="contributor-name">${escHtml(c.login)}</span>
        <div class="contributor-bar-track">
          <div class="contributor-bar-fill" data-target="${barW}"></div>
        </div>
        <span class="contributor-count">${fmtNum(c.contributions)} commits · ${pct}%</span>
      </div>`;
  }).join('');

  return `
    <div class="section-block">
      <div class="section-title">Top Contributors</div>
      <div class="contributors-list">${rows}</div>
    </div>`;
}

// ── AI Report ─────────────────────────────────────────────────────────────

function buildAiReportSection() {
  if (!groqKey) {
    return `
      <div class="section-block">
        <div class="section-title">AI Health Report</div>
        <p class="ai-no-key">Add your Groq API key in the sidebar to generate an AI health report.</p>
      </div>`;
  }
  return `
    <div class="section-block" id="aiReportSection">
      <div class="section-title">AI Health Report</div>
      <div id="aiReportInner">
        <div class="ai-loading">
          <div class="ai-loading-track"><div class="ai-loading-fill"></div></div>
          <p class="ai-loading-text">Generating report with Groq · LLaMA 3.3 70B…</p>
        </div>
      </div>
    </div>`;
}

function buildAiPrompt(rawData, metrics) {
  const { repo, languages, contributors } = rawData;
  const { activity, responsiveness, busFactor, hygiene, overall } = metrics;

  const langEntries = Object.entries(languages).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const langTotal   = Object.values(languages).reduce((s, v) => s + v, 0);
  const langStr     = langEntries.length > 0
    ? langEntries.map(([l, b]) => `${l} (${(b / langTotal * 100).toFixed(1)}%)`).join(', ')
    : 'unknown';

  const lines = [
    `Repository: ${repo.full_name}`,
    `Description: ${repo.description || '(none)'}`,
    `Stars: ${repo.stargazers_count.toLocaleString()} | Forks: ${repo.forks_count.toLocaleString()}`,
    `Top Languages: ${langStr}`,
    '',
    `Overall Health: ${overall.grade} (${overall.score}/100)`,
    '',
    `Activity Score: ${activity.score}/100`,
    `  Last push: ${activity.daysSincePush} day${activity.daysSincePush !== 1 ? 's' : ''} ago`,
    activity.recentCommits !== null
      ? `  Commits in last 4 weeks: ${activity.recentCommits}`
      : '  Commit history: unavailable',
    '',
    `Responsiveness Score: ${responsiveness.score}/100`,
  ];

  if (responsiveness.noData) {
    lines.push('  No issues found in this repository');
  } else {
    const tot       = responsiveness.openCount + responsiveness.closedCount;
    const pctClosed = tot > 0 ? Math.round(responsiveness.closedCount / tot * 100) : 0;
    lines.push(
      responsiveness.avgResolutionDays !== null
        ? `  Avg. issue resolution: ${responsiveness.avgResolutionDays.toFixed(1)} days`
        : '  Avg. issue resolution: no closed issues yet'
    );
    lines.push(`  Open: ${responsiveness.openCount} | Closed: ${responsiveness.closedCount} (${pctClosed}% closed)`);
  }

  lines.push(
    '',
    `Bus Factor Score: ${busFactor.score}/100`,
  );
  if (busFactor.topLogin) {
    lines.push(
      `  Top contributor (${busFactor.topLogin}): ${busFactor.topShare}% of all commits`,
      `  Total contributors tracked: ${contributors.length}`,
    );
  } else {
    lines.push('  No contributor data');
  }

  lines.push(
    '',
    `Hygiene Score: ${hygiene.score}/100`,
    `  License: ${hygiene.checks.license ? (hygiene.licenseName || 'present') : 'none'}`,
    `  Description: ${hygiene.checks.description ? 'present' : 'missing'}`,
    `  Archived: ${repo.archived ? 'yes' : 'no'}`,
    `  Issues enabled: ${repo.has_issues ? 'yes' : 'no'}`,
  );

  return lines.join('\n');
}

async function fetchAiReport(rawData, metrics) {
  const containerEl = document.getElementById('aiReportInner');
  if (!containerEl) return; // stale call after a new analysis started

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${groqKey}`,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 500,
        temperature: 0.6,
        messages: [
          {
            role: 'system',
            content: `You are a senior software engineer reviewing an open-source repository's health for a colleague who is deciding whether to depend on it or contribute to it. Write a concise, plain-spoken report (150-220 words, plain prose, no markdown headers, no bullet lists with dashes — just well-organized paragraphs). Structure: one short paragraph with an overall verdict, one short paragraph covering the main strength(s) and the main risk(s), and a final short paragraph with 2-3 concrete, specific recommendations. Be direct and specific — reference actual numbers from the data given, don't be generic.`,
          },
          {
            role: 'user',
            content: buildAiPrompt(rawData, metrics),
          },
        ],
      }),
    });

    if (res.status === 401) throw new Error('INVALID_KEY');
    if (res.status === 429) throw new Error('RATE_LIMIT');
    if (!res.ok)            throw new Error(`API_ERROR`);

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content?.trim() || '';
    if (!text) throw new Error('EMPTY');

    // Guard: if the user started a new analysis while this was in-flight,
    // containerEl is now detached — innerHTML update is a no-op.
    const paragraphs = text.split(/\n\n+/).map(p => p.trim()).filter(Boolean);
    containerEl.innerHTML =
      `<div class="ai-result">${paragraphs.map(p => `<p class="ai-para">${escHtml(p)}</p>`).join('')}</div>`;

  } catch (err) {
    let msg;
    switch (err.message) {
      case 'INVALID_KEY': msg = 'Invalid Groq API key — check it in the sidebar'; break;
      case 'RATE_LIMIT':  msg = 'Rate limit reached, try again in a moment'; break;
      default:            msg = "Couldn't generate the AI report, try again";
    }
    containerEl.innerHTML = `<div class="ai-error">${escHtml(msg)}</div>`;
  }
}

// ── renderResults ──────────────────────────────────────────────────────────

function renderResults(rawData, metrics) {
  const { repo, languages, contributors } = rawData;
  const { activity, responsiveness, busFactor, hygiene, overall } = metrics;

  const html = `
    ${buildRepoHeader(repo)}

    <div class="grade-section">
      <div class="grade-badge ${gradeColorClass(overall.grade)}">
        <span class="grade-letter">${overall.grade}</span>
        <div class="grade-info">
          <div class="grade-score-line">
            <span class="grade-score-num">${overall.score}</span>
            <span class="grade-score-denom">/100</span>
          </div>
          <span class="grade-score-label">Health Score</span>
        </div>
      </div>
    </div>

    <div class="metrics-grid">
      ${buildMetricCard('Activity',       activity.score,       `<p class="metric-note">${activityNote(activity)}</p>`)}
      ${buildMetricCard('Responsiveness', responsiveness.score, `<p class="metric-note">${responsivenessNote(responsiveness)}</p>`)}
      ${buildMetricCard('Bus Factor',     busFactor.score,      `<p class="metric-note">${busFactorNote(busFactor)}</p>`)}
      ${buildHygieneCard(hygiene)}
    </div>

    ${buildLanguages(languages)}
    ${buildContributors(contributors)}
    ${buildAiReportSection()}
  `;

  const resultsEl = document.getElementById('results');
  resultsEl.innerHTML = html;
  resultsEl.classList.add('visible');
  document.getElementById('placeholderState').style.display = 'none';

  // Animate all progress bars: CSS transition from 0% → target% after first paint
  requestAnimationFrame(() => requestAnimationFrame(() => {
    resultsEl.querySelectorAll('[data-target]').forEach(el => {
      el.style.width = el.dataset.target + '%';
    });
  }));

  // Kick off AI report in the background — metrics are already visible above
  if (groqKey) fetchAiReport(rawData, metrics);
}

// ── analyzeRepo ────────────────────────────────────────────────────────────

async function analyzeRepo() {
  const input = document.getElementById('repoInput').value.trim();
  hideError();

  const parsed = parseRepoInput(input);
  if (!parsed) {
    showError('Enter a valid GitHub repo URL or owner/repo (e.g. torvalds/linux)');
    return;
  }

  const { owner, repo } = parsed;
  setLoading(true);

  try {
    const rawData = await fetchRepoData(owner, repo);
    const metrics = computeMetrics(rawData);

    console.log('Raw repo data:', rawData);
    console.log('Health metrics:', {
      activity:       metrics.activity,
      responsiveness: metrics.responsiveness,
      busFactor:      metrics.busFactor,
      hygiene:        metrics.hygiene,
      overall:        metrics.overall,
    });

    renderResults(rawData, metrics);

  } catch (err) {
    switch (err.message) {
      case 'NOT_FOUND':
        showError(`Repository "${owner}/${repo}" not found — check the URL and make sure it's public.`);
        break;
      case 'RATE_LIMIT':
        showError('GitHub rate limit exceeded. Add a Personal Access Token in the sidebar to raise the limit to 5,000 requests/hour.');
        break;
      case 'FORBIDDEN':
        showError('Access denied — this repository may be private.');
        break;
      default:
        showError('Failed to fetch repository data: ' + err.message);
    }
  } finally {
    setLoading(false);
  }
}

// ── UI state helpers ───────────────────────────────────────────────────────

function setLoading(on) {
  document.getElementById('loadingTrack').classList.toggle('active', on);
  const btn = document.getElementById('analyzeBtn');
  btn.disabled = on;
  btn.innerHTML = on
    ? `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5">
         <circle cx="8" cy="8" r="5" stroke-dasharray="20" stroke-dashoffset="7">
           <animateTransform attributeName="transform" type="rotate"
             from="0 8 8" to="360 8 8" dur="0.7s" repeatCount="indefinite"/>
         </circle>
       </svg> Fetching…`
    : `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
         <circle cx="6.5" cy="6.5" r="4"/>
         <path d="M10 10L14 14" stroke-linecap="round"/>
       </svg> Analyze`;
}

function showError(msg) {
  const el = document.getElementById('errorBox');
  el.textContent = msg;
  el.classList.add('visible');
}

function hideError() {
  document.getElementById('errorBox').classList.remove('visible');
}
