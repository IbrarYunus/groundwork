# Groundwork

An agent that audits a codebase before your team — or your AI coding agents — touch it.

Give it a public GitHub repository. It explores the repo with tools the way a senior engineer would on day one (tree → manifests → entry points → CI → tests), then delivers two documents:

1. **Audit report** — verdict, stack, strengths, risks with severity and file evidence, what's missing for a team, first five actions.
2. **CLAUDE.md** — a ready-to-commit orientation file so Claude Code, Cursor or a new contributor is productive in minutes: install/run/test commands, repo map, observed conventions, hard rules, how to verify a change.

Everything runs in the browser. No server, nothing stored. Bring your own Gemini API key.

## How the agent works

`src/agent.ts` is a tool-use loop over Gemini function calling:

- `list_tree` — GitHub trees API, recursive, filtered to text sources (lockfiles, binaries, build output excluded)
- `read_file` — raw.githubusercontent.com, truncated at 14 KB, cached
- `finish` — the model's only exit; it must return both documents

The system prompt forces consultant behaviour: a step budget, a file budget, cite paths, say "not visible in the repo" rather than guess. Every tool call is streamed to the UI as a trace so you can see what it read and why.

## Run

```
pnpm install
pnpm dev
```

Deploy: `pnpm build && firebase deploy --only hosting`.

## Stack

Vite · React 19 · TypeScript · Gemini 2.5 (Flash or Pro) · GitHub REST API · Firebase Hosting

Built by [Ibrar Yunus](https://ibraryunus.com/ai-engineer).
