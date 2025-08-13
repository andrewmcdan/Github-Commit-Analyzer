// server/index.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { Octokit } from 'octokit';
import OpenAI from 'openai';

const app = express();
app.use(cors());
app.use(express.json({ limit: '8mb' }));

// --- ENV ---
const PORT = process.env.PORT || 8787;
const DEFAULT_BRANCH = 'main';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const ANY_BRANCH = '__ANY__';

// Add this:
const IS_GPT5 = (OPENAI_MODEL || '').toLowerCase().includes('gpt-5');

// Init OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/** Create OpenAI response with model-specific options.
 *  GPT-5 models ignore/ban `temperature`, so omit it when model includes "gpt-5".
 */
function createOpenAIResponse(input) {
  const opts = { model: OPENAI_MODEL, input };
  if (!IS_GPT5) opts.temperature = 0.2;
  return openai.responses.create(opts);
}

// ============ Progress Streaming (SSE) ============
const channels = new Map(); // id -> { res?, buffer: string[] }

function progressSend(id, text) {
  if (!id) return;
  const ch = channels.get(id) || { buffer: [] };
  const line = String(text);
  if (ch.res) {
    ch.res.write(`data: ${JSON.stringify({ ts: Date.now(), msg: line })}\n\n`);
  } else {
    ch.buffer.push(line);
    if (ch.buffer.length > 2000) ch.buffer.shift();
  }
  channels.set(id, ch);
}
function progressDone(id) {
  const ch = channels.get(id);
  if (ch?.res) ch.res.write(`event: done\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
  channels.delete(id);
}
app.get('/api/progress/:id', (req, res) => {
  const { id } = req.params;
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  res.flushHeaders?.();
  const ch = channels.get(id) || { buffer: [] };
  ch.res = res;
  channels.set(id, ch);
  for (const line of ch.buffer) res.write(`data: ${JSON.stringify({ ts: Date.now(), msg: line })}\n\n`);
  res.write(`event: ready\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
  const ping = setInterval(() => res.write(`: ping ${Date.now()}\n\n`), 15000);
  req.on('close', () => { clearInterval(ping); if (channels.get(id)?.res === res) channels.get(id).res = null; });
});

// ============ Config endpoint for UI indicators ============
app.get('/api/config', (_req, res) => {
  res.json({
    hasOpenAIKey: Boolean(process.env.OPENAI_API_KEY),
    hasGithubToken: Boolean(process.env.GITHUB_TOKEN),
    openaiModel: OPENAI_MODEL
  });
});

// ============ Utilities ============
function parseRepo(input) {
  const urlish = (input || '').trim();
  const matchUrl = urlish.match(/github\.com\/([^/]+)\/([^/.]+)(?:\.git)?/i);
  if (matchUrl) return { owner: matchUrl[1], repo: matchUrl[2] };
  const matchSimple = urlish.match(/^([^/]+)\/([^/]+)$/);
  if (matchSimple) return { owner: matchSimple[1], repo: matchSimple[2] };
  throw new Error('Invalid repo format. Use "owner/repo" or a GitHub URL.');
}
function truncate(str, max = 12000) { if (!str) return ''; return str.length > max ? str.slice(0, max) + '\n...[truncated]...' : str; }
function isMergeCommit(commit) { return Array.isArray(commit.parents) && commit.parents.length > 1; }

function buildCommitPrompt({ repoFull, commit, files }) {
  const fileList = files.map(f => `- ${f.filename} (+${f.additions}/-${f.deletions})`).join('\n');
  const patches = files.map(f => [
    `FILE: ${f.filename} (${f.status}, +${f.additions}/-${f.deletions})`,
    truncate(f.patch ?? '', 4000)
  ].join('\n')).join('\n\n');

  return [
    `You are a senior engineer writing concise, actionable commit summaries.`,
    `Repository: ${repoFull}`,
    `Commit: ${commit.sha.slice(0,7)} | Author: ${commit.commit.author?.name || 'unknown'} | Date: ${commit.commit.author?.date || 'unknown'}`,
    `Title: ${commit.commit.message.split('\n')[0]}`,
    `Files changed:\n${fileList || '(none)'}\n`,
    `Diff hunks (truncated as needed):\n${patches || '(no patch available)'}\n\n`,
    `OUTPUT STRICT JSON with this shape (and nothing else):`,
    `{
      "summary": "1-3 bullets, terse but informative. What changed and why (if inferable).",
      "change_type": "feat|fix|refactor|docs|chore|test|build|ci|perf|style|other",
      "areas": ["short tags like 'api', 'ui', 'build', 'infra', 'auth'"],
      "risk": "low|medium|high",
      "test_impact": "did tests change or are tests recommended?",
      "notable_files": ["top 3 relevant files"]
    }`
  ].join('\n');
}
async function summarizeCommit({ repoFull, commit, files }) {
  const prompt = buildCommitPrompt({ repoFull, commit, files });
  const resp = await createOpenAIResponse(prompt);
  try {
    const text = resp.output_text?.trim() || '';
    return JSON.parse(text);
  } catch {
    return {
      summary: "Could not parse summary (model returned non-JSON).",
      change_type: "other",
      areas: [],
      risk: "low",
      test_impact: "N/A",
      notable_files: files.slice(0,3).map(f => f.filename)
    };
  }
}
function buildPeriodPrompt({ repoFull, since, until, aggregate, commitSummaries }) {
  const bullets = commitSummaries.map(c => `- ${c.sha.slice(0,7)}: ${c.ai?.summary || '(no summary)'}`).join('\n');
  return [
    `You are creating a crisp, executive-ready summary of code changes over a period.`,
    `Repository: ${repoFull}`,
    `Window: ${since} to ${until}`,
    `Commits: ${aggregate.count}, Files changed: ${aggregate.files}, LOC +${aggregate.additions}/-${aggregate.deletions}`,
    `Change-type counts: ${JSON.stringify(aggregate.typeCounts)}`,
    `Risk distribution: ${JSON.stringify(aggregate.riskCounts)}`,
    `Areas touched (top): ${aggregate.topAreas.join(', ') || '(n/a)'}`,
    `Below are commit-level bullets:`,
    bullets,
    `\nReturn MARKDOWN with these sections:\n` +
    `# Period Summary\n## Highlights\n## Potential Risks / Breaking Changes\n## Areas & Components Touched\n## Suggested Next Steps (QA, docs, cleanup)\n## Changelog (by commit)\n` +
    `Render the changelog as a table with: short SHA, date, author, one-liner summary.`
  ].join('\n');
}

// ============ Repo meta (validate + branches) ============
app.get('/api/repo/branches', async (req, res) => {
  try {
    const { repo } = req.query;
    if (!repo) return res.status(400).json({ ok: false, error: 'Missing ?repo=owner/repo' });
    const { owner, repo: repoName } = parseRepo(repo);
    const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

    const r = await octokit.rest.repos.get({ owner, repo: repoName });
    // List branches (paginated)
    const branches = await octokit.paginate(octokit.rest.repos.listBranches, { owner, repo: repoName, per_page: 100 });
    res.json({
      ok: true,
      repo: `${owner}/${repoName}`,
      defaultBranch: r.data.default_branch,
      private: r.data.private,
      branches: branches.map(b => b.name).sort((a,b)=>a.localeCompare(b))
    });
  } catch (err) {
    const code = err.status || 500;
    res.status(code).json({ ok: false, error: String(err?.message || err) });
  }
});

// ============ API ============
app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.post('/api/analyze', async (req, res) => {
  const startedAt = Date.now();
  const {
    repo, since, until,
    branch,               // string or "__ANY__"
    includeMerges = false,
    maxCommits = 60,
    requestId
  } = req.body || {};

  const progress = (msg) => progressSend(requestId, msg);

  try {
    if (!repo || !since || !until) return res.status(400).json({ error: 'repo, since, and until are required' });

    progress(`Starting analysis for ${repo} from ${since} to ${until}…`);
    const { owner, repo: repoName } = parseRepo(repo);
    const repoFull = `${owner}/${repoName}`;
    const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

    // Collect commits
    let commits = [];
    if (branch === ANY_BRANCH) {
      progress('Loading branches for ANY selection…');
      const branches = await octokit.paginate(octokit.rest.repos.listBranches, { owner, repo: repoName, per_page: 100 });
      const names = branches.map(b => b.name);
      progress(`Found ${names.length} branches. Aggregating commits across all…`);

      const seen = new Map(); // sha -> commit obj from listCommits
      for (const bname of names) {
        progress(`Listing commits for branch "${bname}"…`);
        const list = await octokit.paginate(octokit.rest.repos.listCommits, {
          owner, repo: repoName, since, until, per_page: 100, sha: bname
        });
        for (const c of list) {
          if (!includeMerges && isMergeCommit(c)) continue;
          if (!seen.has(c.sha)) {
            seen.set(c.sha, c);
            if (seen.size >= maxCommits) break;
          }
        }
        if (seen.size >= maxCommits) break;
      }
      commits = Array.from(seen.values());
      // Sort by author date desc for readability
      commits.sort((a,b) => new Date(b.commit.author?.date || b.commit.committer?.date || 0) - new Date(a.commit.author?.date || a.commit.committer?.date || 0));
      progress(`Aggregated ${commits.length} unique commits across branches (cap ${maxCommits}).`);
    } else {
      const shaParam = branch || DEFAULT_BRANCH;
      progress(`Listing commits for branch "${shaParam}"…`);
      const listParams = { owner, repo: repoName, since, until, per_page: 100, sha: shaParam };
      const listed = await octokit.paginate(octokit.rest.repos.listCommits, listParams);
      commits = (includeMerges ? listed : listed.filter(c => !isMergeCommit(c))).slice(0, Math.min(maxCommits, listed.length));
      progress(`Found ${commits.length} commits to analyze.`);
    }

    // For each commit, fetch details + summarize
    const results = [];
    let aggFiles = 0, aggAdd = 0, aggDel = 0;
    const typeCounts = {}, riskCounts = {};
    const areaCounts = new Map();

    for (let i = 0; i < commits.length; i++) {
      const c = commits[i];
      const shaShort = c.sha.slice(0,7);
      progress(`(${i+1}/${commits.length}) Fetching commit ${shaShort} details…`);

      const detail = await octokit.rest.repos.getCommit({ owner, repo: repoName, ref: c.sha });
      const files = (detail.data.files || []).map(f => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions || 0,
        deletions: f.deletions || 0,
        changes: f.changes || 0,
        patch: f.patch || ''
      }));

      aggFiles += files.length;
      aggAdd += detail.data.stats?.additions || 0;
      aggDel += detail.data.stats?.deletions || 0;

      progress(`(${i+1}/${commits.length}) Summarizing ${shaShort} "${c.commit.message.split('\n')[0]}"…`);
      const ai = await summarizeCommit({ repoFull, commit: c, files });

      typeCounts[ai.change_type] = (typeCounts[ai.change_type] || 0) + 1;
      riskCounts[ai.risk] = (riskCounts[ai.risk] || 0) + 1;
      (ai.areas || []).forEach(a => areaCounts.set(a, (areaCounts.get(a) || 0) + 1));

      results.push({
        sha: c.sha,
        date: c.commit.author?.date || c.commit.committer?.date,
        author: c.commit.author?.name || c.commit.committer?.name || 'unknown',
        message: c.commit.message,
        files,
        stats: { additions: detail.data.stats?.additions || 0, deletions: detail.data.stats?.deletions || 0 },
        ai
      });
    }

    const sortedAreas = [...areaCounts.entries()].sort((a,b)=>b[1]-a[1]).map(([k]) => k);
    const aggregate = { count: results.length, files: aggFiles, additions: aggAdd, deletions: aggDel, typeCounts, riskCounts, topAreas: sortedAreas.slice(0, 10) };

    progress('Generating period summary…');
    const periodPrompt = buildPeriodPrompt({ repoFull, since, until, aggregate, commitSummaries: results.map(r => ({ sha: r.sha, ai: r.ai })) });
    const periodResp = await createOpenAIResponse(periodPrompt);
    const summaryMarkdown = periodResp.output_text?.trim() || '# Period Summary\n(No content)';

    progress(`Done in ${Math.round((Date.now()-startedAt)/1000)}s.`);
    progressDone(requestId);
    res.json({ repo: repoFull, since, until, summaryMarkdown, commits: results, aggregate });
  } catch (err) {
    progress(`Error: ${String(err?.message || err)}`);
    progressDone(requestId);
    console.error(err);
    res.status(500).json({ error: String(err?.message || err) });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
