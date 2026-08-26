import { MAX_FILE_BYTES, MAX_TREE_LINES } from "./prompt";

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

const SKIP =
  /(^|\/)(node_modules|\.git|dist|build|out|target|vendor|\.next|__pycache__|\.venv|coverage)(\/|$)|\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|mp4|mov|pdf|zip|gz|min\.js|map)$|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.lock|poetry\.lock|uv\.lock/i;

export function parseRepoUrl(input: string): { owner: string; repo: string } | null {
  const s = input.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  const m =
    s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)/i) ??
    s.match(/^([\w.-]+)\/([\w.-]+)$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

export class GitHubSource {
  private tree: TreeEntry[] | null = null;
  private cache = new Map<string, string>();
  filesRead = 0;
  truncated = false;

  readonly ref: RepoRef;
  private token?: string;

  constructor(ref: RepoRef, token?: string) {
    this.ref = ref;
    this.token = token;
  }

  static async resolve(owner: string, repo: string, token?: string): Promise<RepoRef> {
    const meta = await ghFetch<{
      default_branch: string;
      description: string | null;
      language: string | null;
      stargazers_count: number;
    }>(`/repos/${owner}/${repo}`, token);
    return {
      owner,
      repo,
      branch: meta.default_branch,
      description: meta.description ?? "",
      language: meta.language,
      stars: meta.stargazers_count,
    };
  }

  async listTree(): Promise<string> {
    if (!this.tree) {
      const t = await ghFetch<{ tree: TreeEntry[]; truncated: boolean }>(
        `/repos/${this.ref.owner}/${this.ref.repo}/git/trees/${encodeURIComponent(this.ref.branch)}?recursive=1`,
        this.token,
      );
      this.truncated = t.truncated;
      this.tree = t.tree.filter((e) => e.type === "blob" && !SKIP.test(e.path));
    }
    const lines = this.tree.slice(0, MAX_TREE_LINES).map((e) => `${e.path} (${e.size ?? 0}b)`);
    const more = this.tree.length > MAX_TREE_LINES ? `\n… ${this.tree.length - MAX_TREE_LINES} more files omitted` : "";
    return `${this.tree.length} files\n${lines.join("\n")}${more}`;
  }

  async readFile(path: string): Promise<string> {
    if (!path) return "error: path required";
    const hit = this.cache.get(path);
    if (hit !== undefined) return hit;
    const r = await fetch(
      `https://raw.githubusercontent.com/${this.ref.owner}/${this.ref.repo}/${this.ref.branch}/${path}`,
    );
    if (!r.ok) return `error: ${r.status} fetching ${path}`;
    let text = await r.text();
    if (text.length > MAX_FILE_BYTES) text = text.slice(0, MAX_FILE_BYTES) + `\n… [truncated at ${MAX_FILE_BYTES} bytes]`;
    this.cache.set(path, text);
    this.filesRead++;
    return text;
  }
}

async function ghFetch<T>(path: string, token?: string): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`https://api.github.com${path}`, { headers });
  if (r.status === 403 && r.headers.get("x-ratelimit-remaining") === "0") {
    throw new Error("GitHub API rate limit reached for this IP. Add a GitHub token in Settings, or wait an hour.");
  }
  if (r.status === 404) throw new Error("Repository not found. Groundwork reads public repositories only (or private ones with a GitHub token).");
  if (!r.ok) throw new Error(`GitHub returned ${r.status} for ${path}`);
  return r.json() as Promise<T>;
}
