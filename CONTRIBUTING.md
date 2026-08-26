# Contributing

Groundwork is small on purpose. Before adding anything, ask whether it makes the audit more accurate or the CLAUDE.md more useful; if not, it probably does not belong.

## Setup

```
pnpm install
pnpm dev
```

`pnpm exec tsc -p tsconfig.app.json --noEmit && pnpm build` must pass; CI runs the same two commands.

## Where things live

- `src/agent/prompt.ts` — the system prompt and tool specs. Changing the prompt changes the product; test against three repos of different sizes before opening a PR.
- `src/agent/providers.ts` — one `Session` per provider. Adding a provider means implementing `step()` and registering it in `PROVIDERS`.
- `src/agent/github.ts` — repository access and the file filter.
- `src/agent/index.ts` — the loop. It should stay provider-agnostic.
- `cli/groundwork.mjs` — the Claude Code runner for local checkouts.

## Pull requests

One change per PR. Include the repo you tested on and, if you touched the prompt, a before/after excerpt of the report.
