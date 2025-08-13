import React, { useState } from 'react'
import { analyzeChanges } from './api.js'
import { marked } from 'marked'

export default function App() {
  const [repo, setRepo] = useState('facebook/react')
  const [since, setSince] = useState(new Date(Date.now()-7*864e5).toISOString().slice(0,10))
  const [until, setUntil] = useState(new Date().toISOString().slice(0,10))
  const [branch, setBranch] = useState('main')
  const [includeMerges, setIncludeMerges] = useState(false)
  const [maxCommits, setMaxCommits] = useState(40)
  const [githubToken, setGithubToken] = useState('')
  const [model, setModel] = useState('gpt-4o-mini')

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [data, setData] = useState(null)
  const [pct, setPct] = useState(0)

  async function onSubmit(e) {
    e.preventDefault()
    setError('')
    setData(null)
    setLoading(true)
    setPct(5)

    try {
      const payload = {
        repo: repo.trim(),
        since: new Date(since + 'T00:00:00Z').toISOString(),
        until: new Date(until + 'T23:59:59Z').toISOString(),
        branch: branch.trim() || undefined,
        includeMerges,
        maxCommits: Number(maxCommits) || 40,
        githubToken: githubToken.trim() || undefined
      }
      setPct(20)
      const result = await analyzeChanges(payload)
      setPct(95)
      setData(result)
      setPct(100)
    } catch (err) {
      setError(err.message || String(err))
    } finally {
      setLoading(false)
      setTimeout(()=>setPct(0), 1500)
    }
  }

  function downloadMarkdown() {
    if (!data?.summaryMarkdown) return
    const blob = new Blob([data.summaryMarkdown], { type: 'text/markdown;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${data.repo}-${data.since.slice(0,10)}_${data.until.slice(0,10)}.md`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  function copyMarkdown() {
    navigator.clipboard.writeText(data?.summaryMarkdown || '')
  }

  return (
    <div className="container">
      <div className="card">
        <h1>GitHub Change Summarizer</h1>
        <p className="small">Enter a repo and date range. We’ll fetch commits, analyze diffs with OpenAI, and render a concise report.</p>
        <form onSubmit={onSubmit}>
          <div className="row">
            <div>
              <label>Repository (owner/repo or URL)</label>
              <input value={repo} onChange={e=>setRepo(e.target.value)} placeholder="owner/repo or https://github.com/owner/repo" />
            </div>
            <div>
              <label>Since (UTC)</label>
              <input type="date" value={since} onChange={e=>setSince(e.target.value)} />
            </div>
            <div>
              <label>Until (UTC)</label>
              <input type="date" value={until} onChange={e=>setUntil(e.target.value)} />
            </div>
          </div>

          <div className="row mt">
            <div>
              <label>Branch</label>
              <input value={branch} onChange={e=>setBranch(e.target.value)} placeholder="main" />
            </div>
            <div>
              <label>Max commits</label>
              <input type="number" min="1" max="200" value={maxCommits} onChange={e=>setMaxCommits(e.target.value)} />
            </div>
            <div>
              <label>Include merge commits?</label>
              <select value={includeMerges ? 'yes' : 'no'} onChange={e=>setIncludeMerges(e.target.value==='yes')}>
                <option value="no">No</option>
                <option value="yes">Yes</option>
              </select>
            </div>
          </div>

          <div className="row mt">
            <div>
              <label>GitHub Token (optional, boosts rate limits)</label>
              <input value={githubToken} onChange={e=>setGithubToken(e.target.value)} placeholder="ghp_..." />
            </div>
            <div>
              <label>OpenAI Model (server uses env default)</label>
              <input value={model} onChange={e=>setModel(e.target.value)} placeholder="gpt-4o-mini" disabled />
            </div>
          </div>

          <div className="mt actions">
            <button disabled={loading}>{loading ? 'Analyzing…' : 'Analyze'}</button>
            <div style={{flex:1}} />
            <div className="progress" style={{width:240}}>
              <div style={{width:`${pct}%`, transition:'width .4s'}} />
            </div>
          </div>
        </form>
      </div>

      {error && <div className="card mt" style={{borderColor:'var(--err)'}}><b>Error:</b> {error}</div>}

      {data && (
        <>
          <div className="card mt">
            <h2>Period Summary</h2>
            <div className="small">
              Repo: <span className="badge">{data.repo}</span>
              Range: <span className="badge">{new Date(data.since).toISOString().slice(0,10)} → {new Date(data.until).toISOString().slice(0,10)}</span>
              Commits: <span className="badge">{data.aggregate.count}</span>
              Files: <span className="badge">{data.aggregate.files}</span>
              LOC: <span className="badge">+{data.aggregate.additions}/-{data.aggregate.deletions}</span>
            </div>
            <div className="actions mt">
              <button onClick={copyMarkdown}>Copy Markdown</button>
              <button onClick={downloadMarkdown}>Download .md</button>
            </div>
            <hr className="sep" />
            <div dangerouslySetInnerHTML={{ __html: marked.parse(data.summaryMarkdown || '') }} />
          </div>

          <div className="card mt">
            <h2>Commits</h2>
            {data.commits.map(c => (
              <div className="commit" key={c.sha}>
                <h4>
                  <code>{c.sha.slice(0,7)}</code> — {c.message.split('\n')[0]}
                </h4>
                <div className="small">
                  {new Date(c.date).toLocaleString()} · {c.author}
                  {'  '}<span className="badge">{c.ai.change_type || 'other'}</span>
                  <span className="badge">risk: {c.ai.risk}</span>
                  {c.ai.areas?.slice(0,4).map(a => <span key={a} className="badge">{a}</span>)}
                </div>
                <div className="mt">
                  <b>AI Summary:</b>
                  <div className="small">{c.ai.summary}</div>
                </div>
                <details className="mt">
                  <summary>Files (+{c.stats.additions}/-{c.stats.deletions})</summary>
                  <table className="table mt">
                    <thead><tr><th>File</th><th>Status</th><th>Add</th><th>Del</th></tr></thead>
                    <tbody>
                      {c.files.map(f => (
                        <tr key={f.filename}>
                          <td>{f.filename}</td>
                          <td>{f.status}</td>
                          <td>{f.additions}</td>
                          <td>{f.deletions}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
                <details className="mt">
                  <summary>Show first patch</summary>
                  {c.files[0]?.patch ? <pre className="code">{c.files[0].patch.slice(0,5000)}</pre> : <div className="small">No patch available.</div>}
                </details>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
