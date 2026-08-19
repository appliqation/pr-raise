// Idempotent PR open/reuse — mirrors workers/automan-worker's
// GitHubCommitClientAdapter.ensurePr() exactly (list open PRs for this
// head first, reuse if found; rebuild the body rather than append, so
// repeat calls stay accurate rather than accumulating stale text), the one
// proven pattern in this workspace for "don't open a second PR for a
// branch that already has one open".

import { Octokit } from '@octokit/rest';

export interface PrTarget {
  owner: string;
  repo: string;
}

/** Parses owner/repo from either https://github.com/owner/repo(.git) or git@github.com:owner/repo(.git). */
export function parseGitHubRepoUrl(url: string): PrTarget {
  const match = url.match(/github\.com[/:]([^/]+)\/([^/.]+?)(\.git)?\/?$/);
  if (!match) {
    throw new Error(`Could not parse a GitHub owner/repo out of repo_url "${url}"`);
  }
  return { owner: match[1], repo: match[2] };
}

export interface EnsurePrResult {
  number: number;
  url: string;
  created: boolean;
}

export class PrClient {
  private readonly octokit: Octokit;

  constructor(token: string) {
    this.octokit = new Octokit({ auth: token });
  }

  async ensurePr(target: PrTarget, opts: { head: string; base: string; title: string; body: string }): Promise<EnsurePrResult> {
    const existing = await this.octokit.pulls.list({
      owner: target.owner,
      repo: target.repo,
      head: `${target.owner}:${opts.head}`,
      state: 'open',
    });

    if (existing.data.length > 0) {
      const pr = existing.data[0];
      await this.octokit.pulls.update({ owner: target.owner, repo: target.repo, pull_number: pr.number, body: opts.body });
      return { number: pr.number, url: pr.html_url, created: false };
    }

    try {
      const created = await this.octokit.pulls.create({
        owner: target.owner,
        repo: target.repo,
        head: opts.head,
        base: opts.base,
        title: opts.title,
        body: opts.body,
      });
      return { number: created.data.number, url: created.data.html_url, created: true };
    } catch (err) {
      const e = err as { status?: number; message?: string };
      if (e.status === 422 && /No commits between/i.test(e.message ?? '')) {
        throw new Error(
          `GitHub rejected the PR: no commits between "${opts.base}" and "${opts.head}" yet. ` +
            'This can happen if the push hasn\'t landed yet — check the push actually succeeded.',
        );
      }
      throw err;
    }
  }
}
