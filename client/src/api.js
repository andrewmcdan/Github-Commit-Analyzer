export async function analyzeChanges(payload) {
    const r = await fetch("/api/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error((await r.json()).error || r.statusText);
    return r.json();
}

export async function fetchConfig() {
    const r = await fetch("/api/config");
    if (!r.ok) throw new Error("Failed to fetch server config");
    return r.json();
}

export async function fetchBranches(repo) {
    const r = await fetch(
        `/api/repo/branches?repo=${encodeURIComponent(repo)}`
    );
    const body = await r.json().catch(() => ({}));
    if (!r.ok || !body.ok) {
        const msg = body?.error || r.statusText || "Failed to fetch branches";
        throw new Error(msg);
    }
    return body; // { ok, repo, defaultBranch, private, branches: [] }
}
