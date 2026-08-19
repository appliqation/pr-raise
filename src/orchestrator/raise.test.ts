import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFetch, mockCheckoutBranch, mockAddAll, mockCommit, mockPushWithToken, MockGitClient } = vi.hoisted(() => {
  const mockFetch = vi.fn().mockResolvedValue(undefined);
  const mockCheckoutBranch = vi.fn().mockResolvedValue(undefined);
  const mockAddAll = vi.fn().mockResolvedValue(undefined);
  const mockCommit = vi.fn();
  const mockPushWithToken = vi.fn().mockResolvedValue(undefined);
  class MockGitClient {
    fetch = mockFetch;
    checkoutBranch = mockCheckoutBranch;
    addAll = mockAddAll;
    commit = mockCommit;
    pushWithToken = mockPushWithToken;
  }
  return { mockFetch, mockCheckoutBranch, mockAddAll, mockCommit, mockPushWithToken, MockGitClient };
});
vi.mock('../git/gitClient.js', () => ({ GitClient: MockGitClient }));

const { mockEnsurePr, MockPrClient } = vi.hoisted(() => {
  const mockEnsurePr = vi.fn();
  class MockPrClient {
    ensurePr = mockEnsurePr;
  }
  return { mockEnsurePr, MockPrClient };
});
vi.mock('../github/prClient.js', async () => {
  const actual = await vi.importActual<typeof import('../github/prClient.js')>('../github/prClient.js');
  return { ...actual, PrClient: MockPrClient };
});

const { raise } = await import('./raise.js');
import type { McpClient } from '@appliqation/agent-core';

function fakeClient(): McpClient {
  return {
    fetchPrompt: vi.fn(),
    startWorkflow: vi.fn(),
    callTool: vi.fn(),
    listTools: vi.fn(),
    uploadScreenshot: vi.fn(),
  };
}

function baseOpts() {
  return {
    client: fakeClient(),
    projectId: 1349,
    repoPath: '/repo',
    branchName: 'automan/run-1',
    prTitle: 'Add generated spec',
    prBody: 'body',
    githubToken: 'ghp_token',
    gitAuthorName: 'Bot',
    gitAuthorEmail: 'bot@example.com',
    commandTimeoutMs: 30_000,
  };
}

describe('raise', () => {
  beforeEach(() => {
    mockCommit.mockReset().mockResolvedValue({ committed: true });
    mockEnsurePr.mockReset().mockResolvedValue({ number: 1, url: 'https://github.com/acme/widgets/pull/1', created: true });
    mockFetch.mockClear();
    mockCheckoutBranch.mockClear();
    mockAddAll.mockClear();
    mockPushWithToken.mockClear();
  });

  it('throws a clear error when get_project_settings fails', async () => {
    const opts = baseOpts();
    (opts.client.callTool as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, text: 'not found' });
    await expect(raise(opts)).rejects.toThrow(/get_project_settings failed/);
  });

  it('throws a clear error when the project has no GitHub repo configured', async () => {
    const opts = baseOpts();
    (opts.client.callTool as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, text: JSON.stringify({ github_repo_url: null }) });
    await expect(raise(opts)).rejects.toThrow(/no GitHub repo configured/);
  });

  it('checks out the branch from the project-configured base branch by default', async () => {
    const opts = baseOpts();
    (opts.client.callTool as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: JSON.stringify({ github_repo_url: 'https://github.com/acme/widgets', github_branch: 'develop' }),
    });
    await raise(opts);
    expect(mockCheckoutBranch).toHaveBeenCalledWith('automan/run-1', 'develop');
  });

  it('falls back to "main" when the project has no configured branch', async () => {
    const opts = baseOpts();
    (opts.client.callTool as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: JSON.stringify({ github_repo_url: 'https://github.com/acme/widgets' }),
    });
    await raise(opts);
    expect(mockCheckoutBranch).toHaveBeenCalledWith('automan/run-1', 'main');
  });

  it('--base-branch overrides the project-configured branch', async () => {
    const opts = { ...baseOpts(), baseBranchOverride: 'release' };
    (opts.client.callTool as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: JSON.stringify({ github_repo_url: 'https://github.com/acme/widgets', github_branch: 'develop' }),
    });
    await raise(opts);
    expect(mockCheckoutBranch).toHaveBeenCalledWith('automan/run-1', 'release');
  });

  it('stops before pushing or touching GitHub when there is nothing to commit', async () => {
    const opts = baseOpts();
    (opts.client.callTool as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: JSON.stringify({ github_repo_url: 'https://github.com/acme/widgets', github_branch: 'main' }),
    });
    mockCommit.mockResolvedValue({ committed: false });

    const result = await raise(opts);

    expect(result).toEqual({
      committed: false,
      pushed: false,
      pr: null,
      skippedReason: 'Nothing to commit — the working tree already matches HEAD.',
    });
    expect(mockPushWithToken).not.toHaveBeenCalled();
    expect(mockEnsurePr).not.toHaveBeenCalled();
  });

  it('pushes with the agent\'s own token (never a token from appq) once committed', async () => {
    const opts = baseOpts();
    (opts.client.callTool as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: JSON.stringify({ github_repo_url: 'https://github.com/acme/widgets', github_branch: 'main' }),
    });
    await raise(opts);
    expect(mockPushWithToken).toHaveBeenCalledWith('https://github.com/acme/widgets.git', 'ghp_token', 'automan/run-1');
  });

  it('opens/reuses the PR against the correct owner/repo/base/head, returning its result', async () => {
    const opts = baseOpts();
    (opts.client.callTool as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: JSON.stringify({ github_repo_url: 'https://github.com/acme/widgets', github_branch: 'main' }),
    });

    const result = await raise(opts);

    expect(mockEnsurePr).toHaveBeenCalledWith(
      { owner: 'acme', repo: 'widgets' },
      { head: 'automan/run-1', base: 'main', title: 'Add generated spec', body: 'body' },
    );
    expect(result).toEqual({
      committed: true,
      pushed: true,
      pr: { number: 1, url: 'https://github.com/acme/widgets/pull/1', created: true },
    });
  });

  it('commit message defaults to the PR title when not given explicitly', async () => {
    const opts = baseOpts();
    (opts.client.callTool as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: JSON.stringify({ github_repo_url: 'https://github.com/acme/widgets', github_branch: 'main' }),
    });
    await raise(opts);
    expect(mockCommit).toHaveBeenCalledWith('Add generated spec', 'Bot', 'bot@example.com');
  });

  it('an explicit commitMessage overrides the PR title for the commit', async () => {
    const opts = { ...baseOpts(), commitMessage: 'chore: add spec' };
    (opts.client.callTool as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: JSON.stringify({ github_repo_url: 'https://github.com/acme/widgets', github_branch: 'main' }),
    });
    await raise(opts);
    expect(mockCommit).toHaveBeenCalledWith('chore: add spec', 'Bot', 'bot@example.com');
  });
});
