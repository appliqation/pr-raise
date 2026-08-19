#!/usr/bin/env node
// `raise`: commit whatever's already changed in a local checkout, push,
// and open (or reuse) a pull request. No LLM involved — this is a
// mechanical git+GitHub operation, reusable by any caller that's already
// made the file changes it wants raised (appliqation-scriptgen today, a
// future defect-fix agent later, or a human running this directly).

import { readFile } from 'node:fs/promises';
import { Command } from 'commander';
import { createMcpClient } from '@appliqation/agent-core';
import { config } from '../config/env.js';
import { raise } from '../orchestrator/raise.js';

const program = new Command();
program
  .name('appliqation-pr-raise')
  .description('Commit local changes in a repo checkout and open/reuse a pull request for them.');

program
  .command('raise')
  .description(
    "Resolves the project's GitHub repo/branch via appq's get_project_settings (no credentials come from " +
      "appq — this agent's own GITHUB_TOKEN does the actual git/GitHub work), then in --repo-path: fetch, " +
      'checkout/create --branch-name, `git add -A` + commit whatever is already changed there, push, and ' +
      'open a PR — or update the existing open PR for that branch if one is already there, never opening ' +
      "a second one. If there's nothing to commit, reports that plainly and does not push or touch GitHub at all.",
  )
  .requiredOption('--project-id <id>', 'Appliqation project ID — resolves the target GitHub repo/branch')
  .requiredOption('--repo-path <path>', 'local checkout that already has the changes to raise')
  .requiredOption('--branch-name <name>', 'branch to commit to and open the PR from')
  .requiredOption('--pr-title <title>', 'pull request title')
  .option('--pr-body <text>', 'pull request body', '')
  .option('--pr-body-file <path>', 'read the PR body from a file instead of --pr-body')
  .option('--base-branch <name>', "override the project's configured default branch")
  .option('--commit-message <message>', 'defaults to --pr-title')
  .option('--json', 'print a single structured JSON result instead of a human-readable summary')
  .action(
    async (opts: {
      projectId: string;
      repoPath: string;
      branchName: string;
      prTitle: string;
      prBody: string;
      prBodyFile?: string;
      baseBranch?: string;
      commitMessage?: string;
      json?: boolean;
    }) => {
      const client = createMcpClient({ origin: config.appqOrigin, apiKey: config.appqApiKey() });
      const prBody = opts.prBodyFile ? await readFile(opts.prBodyFile, 'utf-8') : opts.prBody;

      const result = await raise({
        client,
        projectId: Number(opts.projectId),
        repoPath: opts.repoPath,
        branchName: opts.branchName,
        prTitle: opts.prTitle,
        prBody,
        baseBranchOverride: opts.baseBranch,
        commitMessage: opts.commitMessage,
        githubToken: config.githubToken(),
        gitAuthorName: config.gitAuthorName,
        gitAuthorEmail: config.gitAuthorEmail,
        commandTimeoutMs: config.commandTimeoutMs,
      });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (!result.committed) {
        console.log(result.skippedReason);
        return;
      }
      console.log(`Committed and pushed to ${opts.branchName}.`);
      if (result.pr) {
        console.log(result.pr.created ? `Opened PR: ${result.pr.url}` : `Updated existing PR: ${result.pr.url}`);
      }
    },
  );

program.parseAsync(process.argv);
