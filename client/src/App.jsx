import React, { useEffect, useMemo, useRef, useState } from 'react'
import { analyzeChanges, fetchConfig, fetchBranches } from './api.js'
import { marked } from 'marked'

const ANY_BRANCH = '__ANY__'

export default function App() {
  const [repo, setRepo] = useState('facebook/react')
  const [since, setSince] = useState(new Date(Date.now()-7*864e5).toISOString().slice(0,10))
  const [until, setUntil] = useState(new Date().toISOString().slice(0,10))

  // Branch handling
  const [branch, setBranch] = useState('main')
  const [branchList, setBranchList] = useState([])
  const [defaultBranch, setDefaultBranch] = useState('main')
  const [repoChecking, setRepoChecking] = useState(false)
  const [repoError, setRepoError] = useState('')
  const [repoValid, setRepoValid] = useState(false)

  // Server config indicators
  const [cfg, setCfg] = useState({ hasOpenAIKey: false, hasGithubToken: false, openaiModel: 'gpt-4o-mini' })

  // Progress / results
  const [includeMerges, setIncludeMerges] = useState(false)
  const [maxCommits, setMaxCommits] = useState(60)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [data, setData] = useState(null)
  const [pct, setPct] = useState(0)

  // Live progress log
  const [logLines, setLogLines] = useState([])
  const esRef = useRef(null)             // EventSource
  const logBoxRef = useRef(null)         // Scrollable div
  const [isAtBottom, setIsAtBottom] = useState(true)     // auto-scroll only when true
  const isAtBottomRef = useRef(true)                     // ref mirror for handlers
  const [isAutoScrolling, setIsAutoScrolling] = useState(false) // suppress jump button while programmatic scroll

  useEffect(() => { fetchConfig().then(setCfg).catch(console.error) }, [])
  useEffect(() => { isAtBottomRef.current = isAtBottom }, [isAtBottom])

  // ------- Repo validation + branches (debounced) -------
  const debouncedRepo = useDebounce(repo, 400)
  useEffect(() => {
    if (!debouncedRepo?.trim()) {
      setRepoValid(false); setRepoError(''); setBranchList([]); return
    }
    checkRepoAndBranches(debouncedRepo)
  }, [debouncedRepo])

  async function checkRepoAndBranches(value) {
    setRepoChecking(true); setRepoError('')
    try {
      const info = await fetchBranches(value.trim())
      setRepoValid(true)
      setDefaultBranch(info.defaultBranch || 'main')
      const list = [{ name:'Any branch', value: ANY_BRANCH }, ...info.branches.map(n => ({ name:n, value:n }))]
      setBranchList(list)
      if (!list.some(b => b.value === branch)) setBranch(info.defaultBranch || ANY_BRANCH)
    } catch (e) {
      setRepoValid(false); setRepoError(e.message || 'Repo not accessible'); setBranchList([])
    } finally { setRepoChecking(false) }
  }
  function onRepoBlur() { if (repo.trim()) checkRepoAndBranches(repo.trim()) }

  // ------- Log auto-scroll behavior -------
  // If user is at bottom when new lines arrive, start an auto-scroll cycle and
  // keep the Jump button hidden until we've actually reached bottom again.
  useEffect(() => {
    const el = logBoxRef.current
    if (!el) return
    if (isAtBottomRef.current && logLines.length > 0) {
      setIsAutoScrolling(true)
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
      // Poll via rAF until we're really at bottom, then end the auto-scroll cycle
      const threshold = 4
      const tick = () => {
        const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - threshold
        if (atBottom) {
          setIsAutoScrolling(false)
          // also ensure state reflects truth if no scroll event fires
          setIsAtBottom(prev => (prev ? prev : true))
        } else {
          requestAnimationFrame(tick)
        }
      }
      requestAnimationFrame(tick)
    }
  }, [logLines]) // run on new lines only

  function onLogScroll() {
    const el = logBoxRef.current
    if (!el) return
    const threshold = 4
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - threshold
    // any user scroll cancels auto-scroll cycle
    if (!atBottom && isAutoScrolling) setIsAutoScrolling(false)
    setIsAtBottom(prev => (prev !== atBottom ? atBottom : prev))
  }

  function jumpToBottom() {
    const el = logBoxRef.current
    if (!el) return
    setIsAutoScrolling(true)
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    // end cycle once we hit bottom
    const threshold = 4
    const tick = () => {
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - threshold
      if (atBottom) {
        setIsAtBottom(true)
        setIsAutoScrolling(false)
      } else {
        requestAnimationFrame(tick)
      }
    }
    requestAnimationFrame(tick)
  }

  function openLogStream(requestId) {
    if (esRef.current) { try { esRef.current.close() } catch {} esRef.current = null }
    const es = new EventSource(`/api/progress/${requestId}`)
    es.onmessage = (evt) => {
      try {
        const { msg } = JSON.parse(evt.data)
        // If we were at bottom when the line arrived, flag auto-scroll now (prevents blip)
        if (isAtBottomRef.current) setIsAutoScrolling(true)
        setLogLines(prev => [...prev, msg])
      } catch {}
    }
    es.addEventListener('ready', () => setLogLines(prev => [...prev, 'Connected to progress stream…']))
    es.addEventListener('done', () => { setLogLines(prev => [...prev, 'Analysis complete.']); es.close(); esRef.current = null })
    es.onerror = () => { setLogLines(prev => [...prev, 'Progress stream error (reconnect may be needed).']) }
    esRef.current = es
  }

  async function onSubmit(e) {
    e.preventDefault()
    setError(''); setData(null); setLoading(true); setPct(5)
    setLogLines([]); setIsAtBottom(true); setIsAutoScrolling(false)

    const requestId = (crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now())
    openLogStream(requestId)

    try {
      const payload = {
        repo: repo.trim(),
        since: new Date(since + 'T00:00:00Z').toISOString(),
        until: new Date(until + 'T23:59:59Z').toISOString(),
        branch: branch || undefined,   // could be "__ANY__"
        includeMerges,
        maxCommits: Number(maxCommits) || 60,
        requestId
      }
      setPct(20)
      const result = await analyzeChanges(payload)
      setPct(95); setData(result); setPct(100)
    } catch (err) {
      setError(err.message || String(err))
      setLogLines(prev => [...prev, `Client error: ${err.message || String(err)}`])
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
    a.download = `${data.repo}-${data.since?.slice(0,10)}_${data.until?.slice(0,10)}.md`
    a.click()
    URL.revokeObjectURL(a.href)
  }
  function copyMarkdown() { navigator.clipboard.writeText(data?.summaryMarkdown || '') }

  const branchSelectDisabled = !repoValid || repoChecking || branchList.length === 0
  const analyzeDisabled = loading || !cfg.hasOpenAIKey || !repoValid

  return (
    <div className="container">
      <div className="card">
        <h1>GitHub Change Summarizer</h1>
        <p className="small">Enter a repo and date range. We’ll validate the repo, load branches, analyze diffs with OpenAI, and render a concise report.</p>
        <form onSubmit={onSubmit}>
          <div className="row">
            <div>
              <label>Repository (owner/repo or URL)</label>
              <input
                value={repo}
                onChange={e=>{ setRepo(e.target.value); setRepoError(''); setRepoValid(false); }}
                onBlur={onRepoBlur}
                placeholder="owner/repo or https://github.com/owner/repo"
              />
              <div className="small" style={{ marginTop: 6 }}>
                {repoChecking && <span className="badge">Checking…</span>}
                {!repoChecking && repoValid && <span className="badge">Repo OK</span>}
                {repoError && <span className="badge" style={{ background:'#1e0f0f', borderColor:'#7a1f1f' }}>Error: {repoError}</span>}
              </div>
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
              <select value={branch} onChange={e=>setBranch(e.target.value)} disabled={branchSelectDisabled}>
                {branchList.map(b => <option key={b.value} value={b.value}>{b.name}</option>)}
              </select>
              <div className="small" style={{ marginTop: 6 }}>
                {repoValid && !repoChecking && defaultBranch && <span className="badge">Default: {defaultBranch}</span>}
              </div>
            </div>

            <div>
              <label>Max commits</label>
              <input type="number" min="1" max="500" value={maxCommits} onChange={e=>setMaxCommits(e.target.value)} />
            </div>
            <div>
              <label>Include merge commits?</label>
              <select value={includeMerges ? 'yes' : 'no'} onChange={e=>setIncludeMerges(e.target.value==='yes')}>
                <option value="no">No</option>
                <option value="yes">Yes</option>
              </select>
            </div>
          </div>

          {/* Environment Status (non-editable) */}
          <div className="row mt">
            <div className="card" style={{ padding: '12px' }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>Environment Status</div>
              <div className="small">
                OpenAI key: <span className="badge" style={{ background: cfg.hasOpenAIKey ? '#0e1b12' : '#1e0f0f', borderColor: cfg.hasOpenAIKey ? '#1f7a3e' : '#7a1f1f' }}>
                  {cfg.hasOpenAIKey ? 'Loaded from .env' : 'Missing'}
                </span>
                GitHub token: <span className="badge" style={{ background: cfg.hasGithubToken ? '#0e1b12' : '#1e0f0f', borderColor: cfg.hasGithubToken ? '#1f7a3e' : '#7a1f1f' }}>
                  {cfg.hasGithubToken ? 'Loaded from .env' : 'Missing (optional)'}
                </span>
                Model: <span className="badge">{cfg.openaiModel}</span>
              </div>
            </div>
          </div>

          <div className="mt actions">
            <button disabled={analyzeDisabled}>{loading ? 'Analyzing…' : 'Analyze'}</button>
            <div style={{flex:1}} />
            <div className="progress" style={{width:240}}>
              <div style={{width:`${pct}%`, transition:'width .4s'}} />
            </div>
          </div>
        </form>
      </div>

      {/* Live Analysis Log with auto-scroll + Jump-to-bottom */}
      {(loading || logLines.length > 0) && (
        <div className="card mt">
          <h2>Live Analysis Log</h2>

          <div style={{ position: 'relative' }}>
            <div
              ref={logBoxRef}
              onScroll={onLogScroll}
              className="small"
              style={{
                maxHeight: 260,
                overflowY: 'auto',
                background:'#0b1020',
                border:'1px solid var(--border)',
                borderRadius: 10,
                padding: 10,
                scrollBehavior: 'smooth'
              }}
              aria-label="Live analysis progress log"
            >
              {logLines.length === 0 ? (
                <div className="small">Waiting for progress…</div>
              ) : (
                <ul style={{ paddingLeft: 18, margin: 0 }}>
                  {logLines.map((ln, i) => (
                    <li key={i} style={{ marginBottom: 4, whiteSpace: 'pre-wrap' }}>{ln}</li>
                  ))}
                </ul>
              )}
            </div>

            {/* The blip is eliminated by hiding this while isAutoScrolling */}
            {!isAtBottom && !isAutoScrolling && logLines.length > 0 && (
              <button
                onClick={jumpToBottom}
                title="Jump to bottom"
                style={{
                  position: 'absolute',
                  right: 12,
                  bottom: 12,
                  padding: '8px 10px',
                  borderRadius: 999,
                  fontSize: 13,
                  boxShadow: '0 4px 18px rgba(0,0,0,.35)'
                }}
              >
                ↓ Jump to bottom
              </button>
            )}
          </div>

          <div className="small" style={{ marginTop: 8 }}>
            Auto-scroll: <span className="badge">{isAtBottom ? 'ON (at bottom)' : (isAutoScrolling ? 'AUTO-SCROLLING…' : 'PAUSED (scroll down to resume)')}</span>
          </div>
        </div>
      )}

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

/* --- tiny debounce hook --- */
function useDebounce(value, delay) {
  const [v, setV] = useState(value)
  useEffect(() => { const t = setTimeout(()=>setV(value), delay); return ()=>clearTimeout(t) }, [value, delay])
  return v
}
