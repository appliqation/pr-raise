// Ties it together: resolve the target repo/branch via appq's existing
// get_project_settings (repo_url/branch/tests_dir only — no credentials;
// appq never hands out the per-project GitHub PAT to this client. This
// agent's own GitHub token, from its own .env, is what actually
// authenticates every git/GitHub call below), commit whatever's already
// changed in the given local checkout, push, and open or reuse a PR.

import type { McpClient } from '@appliqation/agent-core';
import { GitClient } from '../git/gitClient.js';
import { PrClient, parseGitHubRepoUrl } from '../github/prClient.js';
import type { EnsurePrResult } from '../github/prClient.js';

export interface RaiseOptions {
  client: McpClient;
  projectId: number;
  repoPath: string;
  branchName: string;
  prTitle: string;
  prBody: string;
  baseBranchOverride?: string;
  commitMessage?: string;
  githubToken: string;
  gitAuthorName: string;
  gitAuthorEmail: string;
  commandTimeoutMs: number;
}

export interface RaiseResult {
  committed: boolean;
  pushed: boolean;
  pr: EnsurePrResult | null;
  skippedReason?: string;
}

interface ProjectSettings {
  github_repo_url?: string | null;
  github_branch?: string | null;
}

export async function raise(opts: RaiseOptions): Promise<RaiseResult> {
  const settingsResult = await opts.client.callTool('get_project_settings', { project_id: opts.projectId });
  if (!settingsResult.ok) {
    throw new Error(`get_project_settings failed for project ${opts.projectId}: ${settingsResult.text}`);
  }
  const settings = JSON.parse(settingsResult.text) as ProjectSettings;
  if (!settings.github_repo_url) {
    throw new Error(`Project ${opts.projectId} has no GitHub repo configured (github_repo_url is empty).`);
  }
  const baseBranch = opts.baseBranchOverride ?? settings.github_branch ?? 'main';
  const target = parseGitHubRepoUrl(settings.github_repo_url);

  const git = new GitClient(opts.repoPath, opts.commandTimeoutMs);
  await git.fetch();
  await git.checkoutBranch(opts.branchName, baseBranch);
  await git.addAll();
  const { committed } = await git.commit(opts.commitMessage ?? opts.prTitle, opts.gitAuthorName, opts.gitAuthorEmail);

  if (!committed) {
    return {
      committed: false,
      pushed: false,
      pr: null,
      skippedReason: 'Nothing to commit — the working tree already matches HEAD.',
    };
  }

  await git.pushWithToken(`https://github.com/${target.owner}/${target.repo}.git`, opts.githubToken, opts.branchName);

  const prClient = new PrClient(opts.githubToken);
  const pr = await prClient.ensurePr(target, { head: opts.branchName, base: baseBranch, title: opts.prTitle, body: opts.prBody });

  return { committed: true, pushed: true, pr };
}
