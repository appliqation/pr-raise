# CLAUDE.md — appliqation-pr-raise

Part of the Appliqation workspace. See `~/Sites/localhost/CLAUDE.md` for how the
product fits together; this file is the map of **this repo only**.

## What this repo is

A standalone agent that commits whatever's already changed in a local repo checkout,
pushes, and opens (or reuses) a pull request. **Fully mechanical — no LLM anywhere in
this repo.** Committing a known set of files and opening a PR needs no judgment, so
unlike `appliqation-autotest`/`appliqation-scriptgen` there's no tool-calling loop, no
`@appliqation/agent-core` engine/provider usage at all — the only thing pulled from
that shared package is `createMcpClient`/`McpClient`, used for exactly one read call
(`get_project_settings`).

**Deliberately generic**, not scriptgen-specific: reusable for whatever a caller has
already changed on disk — today, `appliqation-scriptgen`'s generated spec; later, a
defect-fix agent's code change (not built yet, discussed as the next planned agent in
this family). This repo makes no assumption about *what* changed, only that the caller
(human or another agent) has already made the changes in `--repo-path` before invoking
`raise`.

## The two real design decisions here

1. **No credentials come from appq — this agent holds its own.** appq's
   `GitHubConfigStore` (per-project, encrypted GitHub PAT) is never read by this
   client. `get_project_settings` (already a listed, ordinary appq MCP tool) gives
   `github_repo_url`/`github_branch`/`github_tests_dir` — repo location only, nothing
   sensitive. This agent's own `GITHUB_TOKEN` (from its own `.env`) is what actually
   authenticates every git push and GitHub API call. Explicit choice, made mid-build:
   keep this client's credential surface entirely separate from appq's per-project PAT
   model, not routed through it.
2. **Operates on an existing checkout, doesn't clone one itself.** `--repo-path` is
   assumed to already have the target repo checked out with the changes to raise
   already made there (mirrors `appliqation-scriptgen`'s own `--repo-path`
   convention). Simpler than a self-managed clone/cleanup lifecycle; a future headless
   chain (e.g. a defect-fix agent → this one, no human involved) will need to guarantee
   a checkout exists before invoking `raise` — not this repo's job to solve.

## Where to find what

- `src/cli/index.ts` — the `raise` command. `--project-id` resolves the target
  repo/branch (never accepted as a raw repo URL — always derived, same reasoning as
  every other agent in this family: a caller-supplied value that diverges from the
  real one has no server-side check catching it). `--repo-path`/`--branch-name`/
  `--pr-title` are required; `--pr-body`/`--pr-body-file`/`--base-branch`/
  `--commit-message` are optional.
- `src/orchestrator/raise.ts` — `raise()`: the whole sequence — resolve repo/branch via
  `get_project_settings`, `git fetch` + checkout/create the branch, `git add -A` +
  commit, and if (and only if) something was actually committed, push and
  `ensurePr()`. If there's nothing to commit, stops there and reports that plainly —
  never pushes or touches GitHub for a no-op.
- `src/git/gitClient.ts` — `GitClient`: a thin real-`git`-CLI wrapper
  (`child_process.execFile`, explicit argv, never a shell string — same discipline as
  `appliqation-scriptgen`'s `codingTools.ts`, though there's no LLM-facing allowlist
  here since this code is the only thing that ever decides what git command runs, not
  a model). `pushWithToken()` embeds the token in the push URL for that one push only
  — never written into `.git/config`, so it doesn't linger in the checkout afterward.
  `commit()` treats "nothing to commit" as a legitimate non-error outcome
  (`{committed: false}`), not a thrown failure.
- `src/github/prClient.ts` — `PrClient.ensurePr()`: idempotent PR open/reuse, mirroring
  `workers/automan-worker`'s `GitHubCommitClientAdapter.ensurePr()` exactly (list open
  PRs for this head first, reuse if found, rebuild the body rather than append so
  repeat calls stay accurate). `parseGitHubRepoUrl()` handles both the `https://` and
  `git@github.com:` forms `GitHubConfigStore.repo_url` can hold.
- `src/config/env.ts` — this agent's own config; `required()`/`optional()` still come
  from `@appliqation/agent-core/config`, everything else is local (no engine/provider
  imports at all, since there's no LLM in this repo).

## Explicitly out of scope for v1

- Any LLM involvement — deciding *what* to change, or composing commit/PR content
  beyond what's passed in via CLI flags, is the caller's job, not this agent's.
- Cloning a fresh checkout itself — see "design decisions" above.
- Reading appq's per-project GitHub PAT, or any appq write tool call.
- Handling merge conflicts, rebasing, or force-pushing — `checkoutBranch()` never
  force-resets an existing local branch; if a push is rejected as non-fast-forward,
  that surfaces as a real error, not something this agent tries to resolve itself.

## Commands

- `npm run dev -- raise --project-id <id> --repo-path <path> --branch-name <name> --pr-title <title> [--pr-body <text>|--pr-body-file <path>] [--base-branch <name>] [--commit-message <message>] [--json]`
- `npm run build` / `npm run typecheck`
- `npm test` / `npm run test:watch` — vitest, colocated `src/**/*.test.ts` files

## Config

Copy `.env.example` to `.env`. Requires `APPQ_API_KEY` and `GITHUB_TOKEN` (this
agent's own, with repo write access — see `.env.example`'s comments; deliberately not
the same credential model appq's own GitHub integration uses).

## Keeping this file current

When you add, remove, or rename a top-level file or a directory under `src/`, update
the map above in the same change.
