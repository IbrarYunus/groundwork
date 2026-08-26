#!/usr/bin/env node
// Run the Groundwork audit on a LOCAL checkout using Claude Code (headless).
// Usage:  node cli/groundwork.mjs [path-to-repo] [--model opus|sonnet]
// Requires the `claude` CLI on PATH and an authenticated Claude Code session.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join, basename } from "node:path";

const args = process.argv.slice(2);
const repo = resolve(args.find((a) => !a.startsWith("--")) ?? ".");
const model = args.includes("--model") ? args[args.indexOf("--model") + 1] : "opus";
if (!existsSync(repo)) { console.error(`No such directory: ${repo}`); process.exit(1); }

const prompt = `You are Groundwork, a senior engineer auditing this repository for a founder about to add contributors and AI coding agents.
Explore with Glob, Grep and Read only (never edit, never run anything). Read manifests, entry points, config, CI, tests: at most ~18 files.
Then output EXACTLY this structure and nothing else:

=== REPORT ===
## Verdict
## Stack
## Strengths
## Risks   (each bullet starts with **High**, **Medium** or **Low**, cite file paths)
## Missing for a team
## First 5 actions
=== CLAUDE.md ===
(a complete CLAUDE.md for this repo, under 120 lines: purpose, install/run/test/lint commands from the manifests, repo map, observed conventions, hard rules, where config and secrets come from, how to verify a change)
=== END ===

Plain English. No emoji. Say "not visible in the repo" rather than guess.`;

console.error(`Groundwork: auditing ${repo} with Claude Code (${model})…`);
const run = spawnSync(
  "claude",
  ["-p", prompt, "--model", model, "--allowedTools", "Read,Glob,Grep", "--output-format", "text"],
  { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] },
);
if (run.error) { console.error(`Could not start \`claude\`: ${run.error.message}. Install Claude Code first.`); process.exit(1); }
if (run.status !== 0) process.exit(run.status ?? 1);

const out = run.stdout;
const report = out.split("=== REPORT ===")[1]?.split("=== CLAUDE.md ===")[0]?.trim();
const claudeMd = out.split("=== CLAUDE.md ===")[1]?.split("=== END ===")[0]?.trim();
if (!report || !claudeMd) { console.error("Unexpected output; raw text follows.\n"); console.log(out); process.exit(2); }

const dir = join(repo, ".groundwork");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "audit.md"), report + "\n");
writeFileSync(join(dir, "CLAUDE.md"), claudeMd + "\n");
console.log(report);
console.error(`\nWritten: ${dir}/audit.md and ${dir}/CLAUDE.md  (review, then: cp .groundwork/CLAUDE.md ./CLAUDE.md)`);
console.error(`Repository: ${basename(repo)}`);
