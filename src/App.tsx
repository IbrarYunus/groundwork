import { useEffect, useRef, useState } from "react";
import { marked } from "marked";
import { parseRepoUrl, resolveRepo, runAudit, type AgentEvent, type RepoRef } from "./agent";

const MODELS = [
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash (fast)" },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro (deeper)" },
];

const EXAMPLES = ["fastapi/fastapi", "tauri-apps/tauri", "vercel/ai", "pallets/flask"];

type Phase = "idle" | "running" | "done" | "error";

function load(key: string, fallback = ""): string {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function save(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* private mode */ }
}

export default function App() {
  const [repoInput, setRepoInput] = useState(load("gw.repo"));
  const [apiKey, setApiKey] = useState(load("gw.key"));
  const [model, setModel] = useState(load("gw.model", MODELS[0].id));
  const [phase, setPhase] = useState<Phase>("idle");
  const [status, setStatus] = useState("");
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [ref, setRef] = useState<RepoRef | null>(null);
  const [result, setResult] = useState<Extract<AgentEvent, { kind: "done" }> | null>(null);
  const [tab, setTab] = useState<"report" | "claude">("report");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const traceEnd = useRef<HTMLDivElement>(null);

  useEffect(() => { traceEnd.current?.scrollIntoView({ block: "nearest" }); }, [events]);

  async function start(e?: React.FormEvent) {
    e?.preventDefault();
    const parsed = parseRepoUrl(repoInput);
    if (!parsed) { setError("Enter a GitHub URL or owner/repo."); setPhase("error"); return; }
    if (!apiKey.trim()) { setError("A Gemini API key is required. It stays in your browser."); setPhase("error"); return; }
    save("gw.repo", repoInput); save("gw.key", apiKey); save("gw.model", model);

    abort.current?.abort();
    abort.current = new AbortController();
    setEvents([]); setResult(null); setError(""); setRef(null);
    setPhase("running"); setStatus("Resolving repository");
    try {
      const r = await resolveRepo(parsed.owner, parsed.repo);
      setRef(r);
      await runAudit(r, apiKey.trim(), model, (ev) => {
        if (ev.kind === "status") setStatus(ev.text);
        else if (ev.kind === "done") { setResult(ev); setPhase("done"); setTab("report"); }
        else setEvents((prev) => [...prev, ev]);
      }, abort.current.signal);
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setError((err as Error).message); setPhase("error");
    }
  }

  function stop() { abort.current?.abort(); setPhase("idle"); setStatus(""); }

  async function copy(text: string) {
    await navigator.clipboard.writeText(text);
    setCopied(true); setTimeout(() => setCopied(false), 1400);
  }

  const toolCount = events.filter((e) => e.kind === "tool").length;

  return (
    <div className="shell">
      <header className="mast">
        <div className="brand">
          <Mark />
          <span>Groundwork</span>
        </div>
        <nav className="mast-links">
          <a href="https://github.com/IbrarYunus/groundwork">Source</a>
          <a href="https://ibraryunus.com/ai-engineer">Ibrar Yunus</a>
        </nav>
      </header>

      <section className="hero">
        <p className="eyebrow">An agent that audits a codebase before your team touches it</p>
        <h1>Point it at a repository. Get the audit and the <em>CLAUDE.md</em>.</h1>
        <p className="lede">
          Groundwork reads a public GitHub repo the way a senior engineer would on day one — manifests, entry points,
          CI, tests — then writes a plain-English technical audit and a ready-to-commit CLAUDE.md so contributors and
          AI coding agents orient in minutes instead of days. Runs entirely in your browser.
        </p>

        <form className="launch" onSubmit={start}>
          <label className="field grow">
            <span>Repository</span>
            <input
              value={repoInput}
              onChange={(e) => setRepoInput(e.target.value)}
              placeholder="github.com/owner/repo"
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          <label className="field">
            <span>Gemini API key</span>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="AIza…"
              autoComplete="off"
            />
          </label>
          <label className="field">
            <span>Model</span>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </label>
          {phase === "running"
            ? <button type="button" className="btn ghost" onClick={stop}>Stop</button>
            : <button type="submit" className="btn">Run audit</button>}
        </form>
        <p className="hint">
          Try {EXAMPLES.map((x, i) => (
            <span key={x}>{i > 0 && ", "}<button type="button" className="link" onClick={() => setRepoInput(x)}>{x}</button></span>
          ))}.
          Key from <a href="https://aistudio.google.com/apikey">AI Studio</a>; it is stored only in this browser and sent only to Google.
        </p>
        {phase === "error" && <p className="error">{error}</p>}
      </section>

      {(phase === "running" || events.length > 0) && (
        <section className="work">
          <aside className="trace">
            <div className="trace-head">
              <span className="eyebrow">Agent trace</span>
              <span className="count">{toolCount} tool call{toolCount === 1 ? "" : "s"}</span>
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
              {phase === "running" && (
                <li className="step live"><span className="dot" /><span>{status}</span></li>
              )}
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
                  <span className="meta">{result.filesRead} files read · {result.steps} steps</span>
                  <button className="btn small" onClick={() => copy(tab === "report" ? result.report : result.claudeMd)}>
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
                {tab === "report"
                  ? <article className="prose" dangerouslySetInnerHTML={{ __html: marked.parse(result.report) as string }} />
                  : <pre className="claude-md">{result.claudeMd}</pre>}
              </>
            ) : (
              <div className="waiting">
                <Mark large />
                <p>{status || "Waiting"}</p>
              </div>
            )}
          </main>
        </section>
      )}

      <footer className="foot">
        <p>
          Groundwork is a tool-using agent: Gemini plans, calls <code>list_tree</code> and <code>read_file</code> against the GitHub API,
          then calls <code>finish</code> with both documents. Nothing is stored server-side; there is no server.
        </p>
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
      <button type="button" onClick={() => setOpen(!open)}>
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
