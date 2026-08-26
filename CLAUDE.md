# Groundwork

Browser-only agent that audits a GitHub repository and writes a CLAUDE.md for it. Vite + React 19 + TypeScript. No server.

## Commands
- `pnpm install` — never npm or yarn (shared pnpm store)
- `pnpm dev` — local dev server
- `pnpm exec tsc -p tsconfig.app.json --noEmit` — typecheck (CI gate)
- `pnpm build` — production build to `dist/`
- `firebase deploy --only hosting` — deploy (site `groundwork-audit`)

## Map
- `src/agent/prompt.ts` system prompt + tool specs (single source of truth for both providers)
- `src/agent/providers.ts` Anthropic (official SDK, browser mode) and Gemini (REST) sessions
- `src/agent/github.ts` GitHub tree/file access, skip filter, rate-limit errors
- `src/agent/index.ts` provider-agnostic loop, emits `AgentEvent`s
- `src/App.tsx` UI; `src/index.css` all styles (dark, single theme)
- `cli/groundwork.mjs` Claude Code headless runner for local repos

## Rules
- Tool names/schemas live only in `prompt.ts`; providers map from it. Do not duplicate.
- API keys never leave the browser except to the chosen provider. No telemetry, no proxies.
- `tsconfig` has `erasableSyntaxOnly`: no parameter properties, no enums.
- Keep the UI single-theme dark; colours come from the `:root` tokens in `index.css`.

## Verify
Typecheck + build, then run one audit end to end on `pallets/flask` with each provider.
