import { useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import {
  PROVIDERS,
  parseRepoUrl,
  GitHubSource,
  runAudit,
  type AgentEvent,
  type AuditResult,
  type ProviderId,
  type RepoRef,
} from "./agent";

const EXAMPLES = ["fastapi/fastapi", "pallets/flask", "vercel/ai", "tauri-apps/tauri"];
type Phase = "idle" | "running" | "done" | "error";

function load(key: string, fallback = ""): string {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function save(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}
function loadHistory(): AuditResult[] {
  try { return JSON.parse(localStorage.getItem("gw.history") ?? "[]"); } catch { return []; }
}

export default function App() {
  const [repoInput, setRepoInput] = useState(load("gw.repo"));
  const [provider, setProvider] = useState<ProviderId>((load("gw.provider", "anthropic") as ProviderId));
  const [keys, setKeys] = useState<Record<ProviderId, string>>({
    anthropic: load("gw.key.anthropic"),
    gemini: load("gw.key.gemini"),
  });
  const [model, setModel] = useState(load(`gw.model.${provider}`, PROVIDERS[provider].models[0].id));
  const [ghToken, setGhToken] = useState(load("gw.gh"));
  const [showSettings, setShowSettings] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [status, setStatus] = useState("");
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [ref, setRef] = useState<RepoRef | null>(null);
  const [result, setResult] = useState<AuditResult | null>(null);
  const [history, setHistory] = useState<AuditResult[]>(loadHistory);
  const [tab, setTab] = useState<"report" | "claude">("report");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const traceEnd = useRef<HTMLDivElement>(null);
  const startedAt = useRef(0);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => { traceEnd.current?.scrollIntoView({ block: "nearest" }); }, [events]);
  useEffect(() => {
    if (phase !== "running") return;
    const id = setInterval(() => setElapsed(Math.round((Date.now() - startedAt.current) / 1000)), 1000);
    return () => clearInterval(id);
  }, [phase]);

  function pickProvider(p: ProviderId) {
    setProvider(p);
    setModel(load(`gw.model.${p}`, PROVIDERS[p].models[0].id));
    save("gw.provider", p);
  }

  async function start(e?: React.FormEvent) {
    e?.preventDefault();
    const parsed = parseRepoUrl(repoInput);
    const apiKey = keys[provider].trim();
    if (!parsed) return fail("Enter a GitHub URL or owner/repo.");
    if (!apiKey) return fail(`Add your ${PROVIDERS[provider].label} API key. It stays in this browser.`);
    save("gw.repo", repoInput); save(`gw.key.${provider}`, apiKey); save(`gw.model.${provider}`, model); save("gw.gh", ghToken);

    abort.current?.abort();
    abort.current = new AbortController();
    setEvents([]); setResult(null); setError(""); setRef(null);
    setPhase("running"); setStatus("Resolving repository");
    startedAt.current = Date.now(); setElapsed(0);
    try {
      const r = await GitHubSource.resolve(parsed.owner, parsed.repo, ghToken.trim() || undefined);
      setRef(r);
      await runAudit(r, { provider, apiKey, model, githubToken: ghToken.trim() || undefined }, (ev) => {
        if (ev.kind === "status") setStatus(ev.text);
        else if (ev.kind === "done") {
          setResult(ev.result); setPhase("done"); setTab("report");
          setHistory((h) => {
            const next = [ev.result, ...h.filter((x) => `${x.repo.owner}/${x.repo.repo}` !== `${r.owner}/${r.repo}`)].slice(0, 12);
            save("gw.history", JSON.stringify(next));
            return next;
          });
        } else setEvents((prev) => [...prev, ev]);
      }, abort.current.signal);
    } catch (err) {
      if ((err as Error).name === "AbortError" || (err as Error).name === "APIUserAbortError") return;
      fail((err as Error).message);
    }
  }

  function fail(msg: string) { setError(msg); setPhase("error"); }
  function stop() { abort.current?.abort(); setPhase("idle"); setStatus(""); }

  async function copy(text: string) {
    await navigator.clipboard.writeText(text);
    setCopied(true); setTimeout(() => setCopied(false), 1400);
  }
  function download(name: string, text: string) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
    a.download = name; a.click(); URL.revokeObjectURL(a.href);
  }

  const toolCount = events.filter((e) => e.kind === "tool").length;
  const reportHtml = useMemo(() => (result ? (marked.parse(result.report) as string) : ""), [result]);
  const models = PROVIDERS[provider].models;

  return (
    <div className="shell">
      <header className="mast">
        <a className="brand" href="/"><Mark /><span>Groundwork</span></a>
        <nav className="mast-links">
          <button type="button" className="link-btn" onClick={() => setShowSettings((s) => !s)}>Settings</button>
          <a href="https://github.com/IbrarYunus/groundwork">Source</a>
          <a href="https://ibraryunus.com/ai-engineer">Ibrar Yunus</a>
        </nav>
      </header>

      <section className="hero">
        <p className="eyebrow">An agent that audits a codebase before your team touches it</p>
        <h1>Point it at a repository.<br />Get the audit and the <em>CLAUDE.md</em>.</h1>
        <p className="lede">
          Groundwork reads a GitHub repo the way a senior engineer would on day one, then writes a plain-English
          technical audit and a ready-to-commit CLAUDE.md so contributors and AI coding agents orient in minutes.
          It runs entirely in your browser with your own API key.
        </p>

        <form className="launch" onSubmit={start}>
          <div className="row">
            <label className="field grow">
              <span>Repository</span>
              <input value={repoInput} onChange={(e) => setRepoInput(e.target.value)} placeholder="github.com/owner/repo" spellCheck={false} autoComplete="off" />
            </label>
            {phase === "running"
              ? <button type="button" className="btn ghost" onClick={stop}>Stop</button>
              : <button type="submit" className="btn">Run audit</button>}
          </div>
          <div className="row">
            <div className="segmented" role="radiogroup" aria-label="Provider">
              {(Object.keys(PROVIDERS) as ProviderId[]).map((p) => (
                <button key={p} type="button" role="radio" aria-checked={provider === p} className={provider === p ? "on" : ""} onClick={() => pickProvider(p)}>
                  {PROVIDERS[p].label}
                </button>
              ))}
            </div>
            <label className="field grow">
              <span>{PROVIDERS[provider].label} API key</span>
              <input type="password" value={keys[provider]} onChange={(e) => setKeys({ ...keys, [provider]: e.target.value })} placeholder={PROVIDERS[provider].keyHint} autoComplete="off" />
            </label>
            <label className="field">
              <span>Model</span>
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </label>
          </div>
          {showSettings && (
            <div className="row settings">
              <label className="field grow">
                <span>GitHub token (optional: private repos, higher rate limit)</span>
                <input type="password" value={ghToken} onChange={(e) => setGhToken(e.target.value)} placeholder="github_pat_…" autoComplete="off" />
              </label>
              <button type="button" className="btn ghost small" onClick={() => { setKeys({ anthropic: "", gemini: "" }); setGhToken(""); ["gw.key.anthropic", "gw.key.gemini", "gw.gh"].forEach((k) => save(k, "")); }}>
                Forget all keys
              </button>
            </div>
          )}
        </form>
        <p className="hint">
          Try {EXAMPLES.map((x, i) => (
            <span key={x}>{i > 0 && ", "}<button type="button" className="link-btn" onClick={() => setRepoInput(x)}>{x}</button></span>
          ))}.
          Get a key from <a href={PROVIDERS[provider].keyUrl}>{PROVIDERS[provider].label}</a>. Keys are stored only in this browser and sent only to that provider.
          Prefer the terminal? <a href="https://github.com/IbrarYunus/groundwork#claude-code-cli">Run it with Claude Code</a> on a local checkout.
        </p>
        {phase === "error" && <p className="error" role="alert">{error}</p>}
      </section>

      {(phase === "running" || events.length > 0) && (
        <section className="work">
          <aside className="trace">
            <div className="trace-head">
              <span className="eyebrow">Agent trace</span>
              <span className="count">{toolCount} tool call{toolCount === 1 ? "" : "s"}{phase === "running" && ` · ${elapsed}s`}</span>
            </div>
            {ref && (
              <div className="repo-card">
                <strong>{ref.owner}/{ref.repo}</strong>
                <span>{ref.language ?? "—"} · {ref.branch} · {ref.stars.toLocaleString()} stars</span>
                {ref.description && <p>{ref.description}</p>}
              </div>
            )}
            <ol className="steps">
              {events.map((ev, i) => <Step key={i} ev={ev} />)}
              {phase === "running" && <li className="step live"><span className="dot" /><span>{status}</span></li>}
            </ol>
            <div ref={traceEnd} />
          </aside>

          <main className="output">
            {result ? (
              <>
                <div className="tabs">
                  <button className={tab === "report" ? "on" : ""} onClick={() => setTab("report")}>Audit report</button>
                  <button className={tab === "claude" ? "on" : ""} onClick={() => setTab("claude")}>CLAUDE.md</button>
                  <span className="spacer" />
                  <span className="meta">{result.filesRead} files · {result.steps} steps · {result.model}</span>
                  <button className="btn ghost small" onClick={() => download(tab === "report" ? `${result.repo.repo}-audit.md` : "CLAUDE.md", tab === "report" ? result.report : result.claudeMd)}>Download</button>
                  <button className="btn small" onClick={() => copy(tab === "report" ? result.report : result.claudeMd)}>{copied ? "Copied" : "Copy"}</button>
                </div>
                {tab === "report"
                  ? <article className="prose" dangerouslySetInnerHTML={{ __html: reportHtml }} />
                  : <pre className="claude-md">{result.claudeMd}</pre>}
              </>
            ) : (
              <div className="waiting"><Mark large /><p>{status || "Waiting"}</p></div>
            )}
          </main>
        </section>
      )}

      {history.length > 0 && phase !== "running" && (
        <section className="history">
          <p className="eyebrow">Recent audits</p>
          <ul>
            {history.map((h) => (
              <li key={`${h.repo.owner}/${h.repo.repo}/${h.finishedAt}`}>
                <button type="button" onClick={() => { setResult(h); setRef(h.repo); setEvents([]); setPhase("done"); setTab("report"); window.scrollTo({ top: 0 }); }}>
                  <strong>{h.repo.owner}/{h.repo.repo}</strong>
                  <span>{new Date(h.finishedAt).toLocaleDateString()} · {h.model}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="how">
        <div>
          <p className="eyebrow">How it works</p>
          <h2>One loop, three tools, two documents.</h2>
        </div>
        <ol className="how-steps">
          <li><strong>list_tree</strong><span>The agent pulls the file tree from the GitHub API, with lockfiles, binaries and build output filtered out.</span></li>
          <li><strong>read_file</strong><span>It chooses which files decide the audit (manifests, entry points, CI, tests) and reads at most ~18 of them.</span></li>
          <li><strong>finish</strong><span>The only exit. It must return the audit report and the CLAUDE.md together, so a run never ends half done.</span></li>
        </ol>
      </section>

      <footer className="foot">
        <p>No server, no analytics, nothing stored outside this browser. The agent loop, prompts and tool definitions are open source.</p>
        <p>Built by <a href="https://ibraryunus.com/ai-engineer">Ibrar Yunus</a>.</p>
      </footer>
    </div>
  );
}

function Step({ ev }: { ev: AgentEvent }) {
  const [open, setOpen] = useState(false);
  if (ev.kind === "thought") return <li className="step thought">{ev.text}</li>;
  if (ev.kind !== "tool") return null;
  const label = ev.name === "read_file" ? String(ev.args.path) : "repository tree";
  const isErr = ev.result.startsWith("error:");
  return (
    <li className={`step tool ${isErr ? "err" : ""}`}>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}>
        <code>{ev.name}</code>
        <span className="path">{label}</span>
        <span className="ms">{ev.ms} ms</span>
      </button>
      {open && <pre>{ev.result.slice(0, 4000)}{ev.result.length > 4000 ? "\n…" : ""}</pre>}
    </li>
  );
}

function Mark({ large = false }: { large?: boolean }) {
  const s = large ? 56 : 22;
  return (
    <svg className={large ? "mark large" : "mark"} width={s} height={s} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 19h18M6 19V9l6-5 6 5v10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M9 19v-5h6v5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}
