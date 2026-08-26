import { GitHubSource, type RepoRef } from "./github";
import { MAX_STEPS } from "./prompt";
import { openSession, type ProviderId, type ToolReply } from "./providers";

export type { RepoRef } from "./github";
export { parseRepoUrl, GitHubSource } from "./github";
export { PROVIDERS, type ProviderId } from "./providers";

export type AgentEvent =
  | { kind: "status"; text: string }
  | { kind: "thought"; text: string }
  | { kind: "tool"; name: string; args: Record<string, unknown>; result: string; ms: number }
  | { kind: "done"; result: AuditResult };

export interface AuditResult {
  report: string;
  claudeMd: string;
  filesRead: number;
  steps: number;
  provider: ProviderId;
  model: string;
  repo: RepoRef;
  finishedAt: number;
}

export interface AuditOptions {
  provider: ProviderId;
  apiKey: string;
  model: string;
  githubToken?: string;
}

export async function runAudit(
  ref: RepoRef,
  opts: AuditOptions,
  emit: (e: AgentEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const source = new GitHubSource(ref, opts.githubToken);
  const task = `Audit https://github.com/${ref.owner}/${ref.repo} (default branch: ${ref.branch}).
GitHub description: ${ref.description || "none"}. Primary language per GitHub: ${ref.language ?? "unknown"}. Stars: ${ref.stars}.
Begin.`;
  const session = openSession(opts.provider, opts.apiKey, opts.model, task);

  let replies: ToolReply[] = [];
  for (let step = 1; step <= MAX_STEPS; step++) {
    if (signal.aborted) return;
    emit({ kind: "status", text: step === 1 ? "Reading the repository" : `Thinking (step ${step})` });
    const turn = await session.step(replies, signal);
    for (const t of turn.text) emit({ kind: "thought", text: t });
    if (!turn.calls.length) throw new Error("The model stopped without calling finish. Try again or use a stronger model.");

    replies = [];
    for (const call of turn.calls) {
      if (call.name === "finish") {
        emit({
          kind: "done",
          result: {
            report: String(call.args.report ?? ""),
            claudeMd: String(call.args.claude_md ?? ""),
            filesRead: source.filesRead,
            steps: step,
            provider: opts.provider,
            model: opts.model,
            repo: ref,
            finishedAt: Date.now(),
          },
        });
        return;
      }
      const t0 = performance.now();
      let result: string;
      try {
        if (call.name === "list_tree") {
          result = await source.listTree();
          if (source.truncated) emit({ kind: "status", text: "GitHub truncated the tree; this is a very large repository." });
        } else if (call.name === "read_file") {
          result = await source.readFile(String(call.args.path ?? ""));
        } else {
          result = `error: unknown tool ${call.name}`;
        }
      } catch (e) {
        result = `error: ${(e as Error).message}`;
      }
      emit({ kind: "tool", name: call.name, args: call.args, result, ms: Math.round(performance.now() - t0) });
      replies.push({ id: call.id, name: call.name, result });
    }
  }
  throw new Error(`Reached the ${MAX_STEPS}-step limit before finishing. Try a smaller repository or a stronger model.`);
}
