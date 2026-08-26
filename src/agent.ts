export type AgentEvent =
  | { kind: "status"; text: string }
  | { kind: "tool"; name: string; args: Record<string, unknown>; result: string; ms: number }
  | { kind: "thought"; text: string }
  | { kind: "done"; report: string; claudeMd: string; filesRead: number; steps: number }
  | { kind: "error"; text: string };

export interface RepoRef {
  owner: string;
  repo: string;
  branch: string;
  description: string;
  language: string | null;
  stars: number;
}

interface TreeEntry {
  path: string;
  type: "blob" | "tree";
  size?: number;
}

const GEMINI = "https://generativelanguage.googleapis.com/v1beta/models";
const MAX_STEPS = 28;
const MAX_FILE_BYTES = 14_000;

const SYSTEM = `You are Groundwork, a senior engineer auditing an unfamiliar codebase for a founder who is about to add contributors and AI coding agents (Claude Code, Cursor) to it.

Work like a consultant on the clock: you have a limited number of tool calls. Start by listing the tree, then read only the files that decide the audit — manifests (package.json, pyproject.toml, Cargo.toml, go.mod), lockfiles' presence, entry points, config, CI, Dockerfiles, env examples, README, the largest or most central source files, tests. Do not read binaries, lockfile contents, or generated code. Never read more than ~18 files.

When you have enough, call finish with two Markdown documents:

1. report — a technical audit for a non-technical founder AND their engineers. Sections, in this order:
   ## Verdict (3 sentences, plain English: what this is, how healthy it is, the one thing to fix first)
   ## Stack (what it is built with, versions, hosting/infra as far as visible)
   ## Strengths (bullets)
   ## Risks (bullets, each with severity High/Med/Low in bold, and the file path as evidence)
   ## Missing for a team (bullets: what a second contributor or an AI agent would trip on — no tests, no lint, no CI, no env docs, unclear entry point, etc.)
   ## First 5 actions (numbered, concrete, each doable in under a day)
   Be specific: cite file paths. Do not pad. Do not invent things you did not see; say "not visible in the repo" when unsure.

2. claude_md — a complete CLAUDE.md for this repository, ready to commit at the repo root, so that Claude Code or any AI agent orients in minutes. Include: one-paragraph purpose; how to install, run, test, lint (exact commands from the manifests); repo map (key directories and what lives there); conventions you observed (language style, naming, state management, error handling); hard rules (things an agent must never do here: e.g. never edit generated files, never commit .env, package manager to use); where secrets/config come from; how to verify a change before reporting done. Use only what you observed. Keep it under 120 lines.

Write in plain English. No emoji. No filler.`;

const TOOLS = [
  {
    functionDeclarations: [
      {
        name: "list_tree",
        description:
          "List every file path in the repository (default branch), with sizes. Call this first, once.",
        parameters: { type: "OBJECT", properties: {}, required: [] },
      },
      {
        name: "read_file",
        description: `Read a file's text content (truncated at ${MAX_FILE_BYTES} bytes). Only for text files that matter to the audit.`,
        parameters: {
          type: "OBJECT",
          properties: { path: { type: "STRING", description: "Exact path from list_tree" } },
          required: ["path"],
        },
      },
      {
        name: "finish",
        description: "Deliver the final audit report and CLAUDE.md. Ends the session.",
        parameters: {
          type: "OBJECT",
          properties: {
            report: { type: "STRING", description: "Markdown audit report" },
            claude_md: { type: "STRING", description: "Complete CLAUDE.md contents" },
          },
          required: ["report", "claude_md"],
        },
      },
    ],
  },
];

export function parseRepoUrl(input: string): { owner: string; repo: string } | null {
  const m = input
    .trim()
    .replace(/\.git$/, "")
    .match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)/i)
    ?? input.trim().match(/^([\w.-]+)\/([\w.-]+)$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

async function gh<T>(path: string): Promise<T> {
  const r = await fetch(`https://api.github.com${path}`, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (r.status === 403 && r.headers.get("x-ratelimit-remaining") === "0") {
    throw new Error("GitHub API rate limit hit for this IP. Wait an hour or try again later.");
  }
  if (!r.ok) throw new Error(`GitHub ${r.status} on ${path}`);
  return r.json() as Promise<T>;
}

export async function resolveRepo(owner: string, repo: string): Promise<RepoRef> {
  const meta = await gh<{
    default_branch: string;
    description: string | null;
    language: string | null;
    stargazers_count: number;
    private: boolean;
  }>(`/repos/${owner}/${repo}`);
  return {
    owner,
    repo,
    branch: meta.default_branch,
    description: meta.description ?? "",
    language: meta.language,
    stars: meta.stargazers_count,
  };
}

const SKIP = /(^|\/)(node_modules|\.git|dist|build|out|target|vendor|\.next|__pycache__|\.venv|coverage)(\/|$)|\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|mp4|mov|pdf|zip|gz|lock|min\.js|map)$|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.lock|poetry\.lock/i;

export async function runAudit(
  ref: RepoRef,
  apiKey: string,
  model: string,
  emit: (e: AgentEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  let tree: TreeEntry[] | null = null;
  let filesRead = 0;
  const fileCache = new Map<string, string>();

  const tools: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
    async list_tree() {
      if (!tree) {
        const t = await gh<{ tree: TreeEntry[]; truncated: boolean }>(
          `/repos/${ref.owner}/${ref.repo}/git/trees/${encodeURIComponent(ref.branch)}?recursive=1`,
        );
        tree = t.tree.filter((e) => e.type === "blob" && !SKIP.test(e.path));
        if (t.truncated) emit({ kind: "status", text: "Tree truncated by GitHub — very large repo, showing what it returned." });
      }
      const lines = tree.slice(0, 900).map((e) => `${e.path} (${e.size ?? 0}b)`);
      const more = tree.length > 900 ? `\n… ${tree.length - 900} more files omitted` : "";
      return `${tree.length} files\n${lines.join("\n")}${more}`;
    },
    async read_file(args) {
      const path = String(args.path ?? "");
      if (!path) return "error: path required";
      if (fileCache.has(path)) return fileCache.get(path)!;
      const r = await fetch(
        `https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/${ref.branch}/${path}`,
      );
      if (!r.ok) return `error: ${r.status} fetching ${path}`;
      let text = await r.text();
      if (text.length > MAX_FILE_BYTES) text = text.slice(0, MAX_FILE_BYTES) + `\n… [truncated at ${MAX_FILE_BYTES} bytes]`;
      fileCache.set(path, text);
      filesRead++;
      return text;
    },
  };

  const contents: unknown[] = [
    {
      role: "user",
      parts: [
        {
          text: `Audit https://github.com/${ref.owner}/${ref.repo} (default branch: ${ref.branch}).\nGitHub description: ${ref.description || "none"}. Primary language per GitHub: ${ref.language ?? "unknown"}. Stars: ${ref.stars}.\nBegin.`,
        },
      ],
    },
  ];

  for (let step = 1; step <= MAX_STEPS; step++) {
    if (signal.aborted) return;
    emit({ kind: "status", text: step === 1 ? "Reading the repository" : `Thinking (step ${step})` });

    const res = await fetch(`${GEMINI}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents,
        tools: TOOLS,
        toolConfig: { functionCallingConfig: { mode: "ANY" } },
        generationConfig: { temperature: 0.2 },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const msg = body.match(/"message":\s*"([^"]+)"/)?.[1] ?? res.statusText;
      throw new Error(`Gemini ${res.status}: ${msg}`);
    }
    const data = await res.json();
    const parts: Array<{ text?: string; functionCall?: { name: string; args: Record<string, unknown> } }> =
      data?.candidates?.[0]?.content?.parts ?? [];
    if (!parts.length) throw new Error("Model returned nothing — try again.");

    contents.push({ role: "model", parts });

    const responses: unknown[] = [];
    for (const p of parts) {
      if (p.text?.trim()) emit({ kind: "thought", text: p.text.trim() });
      if (!p.functionCall) continue;
      const { name, args } = p.functionCall;
      if (name === "finish") {
        emit({
          kind: "done",
          report: String(args.report ?? ""),
          claudeMd: String(args.claude_md ?? ""),
          filesRead,
          steps: step,
        });
        return;
      }
      const t0 = performance.now();
      let result: string;
      try {
        result = tools[name] ? await tools[name](args) : `error: unknown tool ${name}`;
      } catch (e) {
        result = `error: ${(e as Error).message}`;
      }
      emit({ kind: "tool", name, args, result, ms: Math.round(performance.now() - t0) });
      responses.push({ functionResponse: { name, response: { content: result } } });
    }
    if (!responses.length) throw new Error("Model stopped without finishing.");
    contents.push({ role: "user", parts: responses });
  }
  throw new Error(`Hit the ${MAX_STEPS}-step limit before finishing. Try a smaller repository.`);
}
