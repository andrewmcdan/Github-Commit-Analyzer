// server/index.js
import "dotenv/config";
import express from "express";
import cors from "cors";
import { Octokit } from "octokit";
import OpenAI from "openai";

const app = express();
app.use(cors());
app.use(express.json({ limit: "8mb" }));

// --- ENV ---
const PORT = process.env.PORT || 8787;
const DEFAULT_BRANCH = "main"; // user can override
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// Init OpenAI
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// Utility: parse "owner/repo" or full GitHub URL
function parseRepo(input) {
    // supports: owner/repo, https://github.com/owner/repo(.git)
    const urlish = input.trim();
    const matchUrl = urlish.match(/github\.com\/([^/]+)\/([^/.]+)(?:\.git)?/i);
    if (matchUrl) return { owner: matchUrl[1], repo: matchUrl[2] };
    const matchSimple = urlish.match(/^([^/]+)\/([^/]+)$/);
    if (matchSimple) return { owner: matchSimple[1], repo: matchSimple[2] };
    throw new Error('Invalid repo format. Use "owner/repo" or a GitHub URL.');
}

function truncate(str, max = 12000) {
    if (!str) return "";
    return str.length > max ? str.slice(0, max) + "\n...[truncated]..." : str;
}

function extOf(path) {
    const i = path.lastIndexOf(".");
    return i > -1 ? path.slice(i + 1).toLowerCase() : "";
}

function isMergeCommit(commit) {
    return Array.isArray(commit.parents) && commit.parents.length > 1;
}

// Build a compact prompt per commit
function buildCommitPrompt({ repoFull, commit, files }) {
    const fileList = files
        .map((f) => `- ${f.filename} (+${f.additions}/-${f.deletions})`)
        .join("\n");

    // Aggressive but safe truncation to keep tokens sane
    const patches = files
        .map((f, idx) => {
            const body = [
                `FILE: ${f.filename} (${f.status}, +${f.additions}/-${f.deletions})`,
                truncate(f.patch ?? "", 4000),
            ].join("\n");
            return body;
        })
        .join("\n\n");

    return [
        `You are a senior engineer writing concise, actionable commit summaries.`,
        `Repository: ${repoFull}`,
        `Commit: ${commit.sha.slice(0, 7)} | Author: ${
            commit.commit.author?.name || "unknown"
        } | Date: ${commit.commit.author?.date || "unknown"}`,
        `Title: ${commit.commit.message.split("\n")[0]}`,
        `Files changed:\n${fileList || "(none)"}\n`,
        `Diff hunks (truncated as needed):\n${
            patches || "(no patch available)"
        }\n\n`,
        `OUTPUT STRICT JSON with this shape (and nothing else):`,
        `{
      "summary": "1-3 bullets, terse but informative. What changed and why (if inferable).",
      "change_type": "feat|fix|refactor|docs|chore|test|build|ci|perf|style|other",
      "areas": ["short tags like 'api', 'ui', 'build', 'infra', 'auth'"],
      "risk": "low|medium|high",
      "test_impact": "did tests change or are tests recommended?",
      "notable_files": ["top 3 relevant files"]
    }`,
    ].join("\n");
}

async function summarizeCommit({ repoFull, commit, files }) {
    const prompt = buildCommitPrompt({ repoFull, commit, files });

    const resp = await openai.responses.create({
        model: OPENAI_MODEL,
        input: prompt,
        temperature: 0.2,
    });

    let parsed;
    try {
        const text = resp.output_text?.trim() || "";
        parsed = JSON.parse(text);
    } catch {
        parsed = {
            summary: "Could not parse summary (model returned non-JSON).",
            change_type: "other",
            areas: [],
            risk: "low",
            test_impact: "N/A",
            notable_files: files.slice(0, 3).map((f) => f.filename),
        };
    }

    return parsed;
}

function buildPeriodPrompt({
    repoFull,
    since,
    until,
    aggregate,
    commitSummaries,
}) {
    const bullets = commitSummaries
        .map(
            (c) => `- ${c.sha.slice(0, 7)}: ${c.ai?.summary || "(no summary)"}`
        )
        .join("\n");

    return [
        `You are creating a crisp, executive-ready summary of code changes over a period.`,
        `Repository: ${repoFull}`,
        `Window: ${since} to ${until}`,
        `Commits: ${aggregate.count}, Files changed: ${aggregate.files}, LOC +${aggregate.additions}/-${aggregate.deletions}`,
        `Change-type counts: ${JSON.stringify(aggregate.typeCounts)}`,
        `Risk distribution: ${JSON.stringify(aggregate.riskCounts)}`,
        `Areas touched (top): ${aggregate.topAreas.join(", ") || "(n/a)"}`,
        `Below are commit-level bullets:`,
        bullets,
        `\nReturn MARKDOWN with these sections:\n` +
            `# Period Summary\n` +
            `## Highlights\n` +
            `## Potential Risks / Breaking Changes\n` +
            `## Areas & Components Touched\n` +
            `## Suggested Next Steps (QA, docs, cleanup)\n` +
            `## Changelog (by commit)\n` +
            `Render the changelog as a table with: short SHA, date, author, one-liner summary.`,
    ].join("\n");
}

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.post("/api/analyze", async (req, res) => {
    try {
        const {
            repo, // "owner/repo" or URL
            since, // ISO (e.g., "2025-07-01T00:00:00Z")
            until, // ISO
            branch, // optional, default main
            includeMerges = false,
            maxCommits = 60,
            githubToken, // optional; otherwise use process.env.GITHUB_TOKEN
        } = req.body || {};

        if (!repo || !since || !until) {
            return res
                .status(400)
                .json({ error: "repo, since, and until are required" });
        }

        const { owner, repo: repoName } = parseRepo(repo);
        const repoFull = `${owner}/${repoName}`;
        const octokit = new Octokit({
            auth: githubToken || process.env.GITHUB_TOKEN,
        });

        // 1) List commits in date range (paginate)
        //    Docs: GET /repos/{owner}/{repo}/commits with since/until.
        //    (We’ll let GitHub handle default branch if sha is omitted.)
        const listParams = {
            owner,
            repo: repoName,
            since,
            until,
            per_page: 100,
            sha: branch || DEFAULT_BRANCH,
        };

        const commits = await octokit.paginate(
            octokit.rest.repos.listCommits,
            listParams
        );

        // filter merges if needed
        const filtered = includeMerges
            ? commits
            : commits.filter((c) => !isMergeCommit(c));

        const limited = filtered.slice(
            0,
            Math.min(maxCommits, filtered.length)
        );

        // 2) For each commit, fetch details (files + patch)
        const results = [];
        let aggFiles = 0,
            aggAdd = 0,
            aggDel = 0;
        const typeCounts = {};
        const riskCounts = {};
        const areaCounts = new Map();

        for (const c of limited) {
            const sha = c.sha;
            const detail = await octokit.rest.repos.getCommit({
                owner,
                repo: repoName,
                ref: sha,
            });
            const files = (detail.data.files || []).map((f) => ({
                filename: f.filename,
                status: f.status,
                additions: f.additions || 0,
                deletions: f.deletions || 0,
                changes: f.changes || 0,
                patch: f.patch || "",
            }));

            aggFiles += files.length;
            aggAdd += detail.data.stats?.additions || 0;
            aggDel += detail.data.stats?.deletions || 0;

            // 3) Summarize this commit with OpenAI
            const ai = await summarizeCommit({ repoFull, commit: c, files });

            // track aggregates
            typeCounts[ai.change_type] = (typeCounts[ai.change_type] || 0) + 1;
            riskCounts[ai.risk] = (riskCounts[ai.risk] || 0) + 1;
            (ai.areas || []).forEach((a) =>
                areaCounts.set(a, (areaCounts.get(a) || 0) + 1)
            );

            results.push({
                sha,
                date: c.commit.author?.date || c.commit.committer?.date,
                author:
                    c.commit.author?.name ||
                    c.commit.committer?.name ||
                    "unknown",
                message: c.commit.message,
                files,
                stats: {
                    additions: detail.data.stats?.additions || 0,
                    deletions: detail.data.stats?.deletions || 0,
                },
                ai,
            });
        }

        // 4) Build period-level summary
        const sortedAreas = [...areaCounts.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([k]) => k);
        const aggregate = {
            count: results.length,
            files: aggFiles,
            additions: aggAdd,
            deletions: aggDel,
            typeCounts,
            riskCounts,
            topAreas: sortedAreas.slice(0, 10),
        };

        const periodPrompt = buildPeriodPrompt({
            repoFull,
            since,
            until,
            aggregate,
            commitSummaries: results.map((r) => ({ sha: r.sha, ai: r.ai })),
        });

        const periodResp = await openai.responses.create({
            model: OPENAI_MODEL,
            input: periodPrompt,
            temperature: 0.2,
        });

        const summaryMarkdown =
            periodResp.output_text?.trim() || "# Period Summary\n(No content)";

        res.json({
            repo: repoFull,
            since,
            until,
            summaryMarkdown,
            commits: results,
            aggregate,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: String(err?.message || err) });
    }
});

app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
});
