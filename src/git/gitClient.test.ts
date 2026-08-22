import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockExecFile } = vi.hoisted(() => ({ mockExecFile: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: mockExecFile }));

const { GitClient } = await import('./gitClient.js');

function mockSuccess(stdout: string, stderr = '') {
  mockExecFile.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
    process.nextTick(() => cb(null, stdout, stderr));
  });
}

function mockFailure(code: number, stdout = '', stderr = 'boom') {
  mockExecFile.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
    const err = Object.assign(new Error('Command failed'), { code });
    process.nextTick(() => cb(err, stdout, stderr));
  });
}

describe('GitClient', () => {
  let git: InstanceType<typeof GitClient>;

  beforeEach(() => {
    git = new GitClient('/repo', 30_000);
    mockExecFile.mockReset();
  });

  describe('statusPorcelain / hasUncommittedChanges', () => {
    it('reports no uncommitted changes for empty status output', async () => {
      mockSuccess('');
      expect(await git.hasUncommittedChanges()).toBe(false);
    });

    it('reports uncommitted changes when status output is non-empty', async () => {
      mockSuccess(' M src/file.ts\n');
      expect(await git.hasUncommittedChanges()).toBe(true);
    });
  });

  describe('fetch', () => {
    it('calls git fetch origin by default', async () => {
      mockSuccess('');
      await git.fetch();
      expect(mockExecFile).toHaveBeenCalledWith('git', ['fetch', 'origin'], expect.objectContaining({ cwd: '/repo' }), expect.any(Function));
    });
  });

  describe('checkoutBranch', () => {
    it('creates a new branch from origin/base when the local branch does not exist', async () => {
      // rev-parse --verify fails (branch doesn't exist locally) -> then checkout -b succeeds
      mockExecFile
        .mockImplementationOnce((_f, _a, _o, cb) => process.nextTick(() => cb(Object.assign(new Error('fail'), { code: 1 }), '', '')))
        .mockImplementationOnce((_f, _a, _o, cb) => process.nextTick(() => cb(null, '', '')));

      await git.checkoutBranch('feature-x', 'main');

      expect(mockExecFile).toHaveBeenNthCalledWith(2, 'git', ['checkout', '-b', 'feature-x', 'origin/main'], expect.anything(), expect.any(Function));
    });

    it('checks out the existing local branch as-is when it already exists, without force-resetting', async () => {
      mockExecFile
        .mockImplementationOnce((_f, _a, _o, cb) => process.nextTick(() => cb(null, '', ''))) // rev-parse succeeds
        .mockImplementationOnce((_f, _a, _o, cb) => process.nextTick(() => cb(null, '', '')));

      await git.checkoutBranch('feature-x', 'main');

      expect(mockExecFile).toHaveBeenNthCalledWith(2, 'git', ['checkout', 'feature-x'], expect.anything(), expect.any(Function));
    });
  });

  describe('addAll', () => {
    it('calls git add -A', async () => {
      mockSuccess('');
      await git.addAll();
      expect(mockExecFile).toHaveBeenCalledWith('git', ['add', '-A'], expect.anything(), expect.any(Function));
    });
  });

  describe('commit', () => {
    it('commits with the given message and author, reporting committed:true', async () => {
      mockSuccess('[feature-x abc1234] my message');
      const result = await git.commit('my message', 'Bot', 'bot@example.com');
      expect(result).toEqual({ committed: true });
      expect(mockExecFile).toHaveBeenCalledWith(
        'git',
        ['-c', 'user.name=Bot', '-c', 'user.email=bot@example.com', 'commit', '-m', 'my message'],
        expect.anything(),
        expect.any(Function),
      );
    });

    it('reports committed:false (not an error) when there is nothing to commit', async () => {
      mockFailure(1, 'nothing to commit, working tree clean');
      const result = await git.commit('my message', 'Bot', 'bot@example.com');
      expect(result).toEqual({ committed: false });
    });

    it('rethrows a genuine commit failure (e.g. bad author config) rather than swallowing it', async () => {
      mockFailure(128, '', 'fatal: bad config');
      await expect(git.commit('my message', 'Bot', 'bot@example.com')).rejects.toThrow();
    });
  });

  describe('pushWithToken', () => {
    it('never embeds the token in the push URL argv — the URL stays plain', async () => {
      mockSuccess('');
      await git.pushWithToken('https://github.com/owner/repo.git', 'ghp_secret123', 'feature-x');
      const [, args] = mockExecFile.mock.calls[0];
      expect(args).toEqual(['push', 'https://github.com/owner/repo.git', 'HEAD:refs/heads/feature-x']);
      expect(args.join(' ')).not.toContain('ghp_secret123');
    });

    it('passes the credential as a base64 Authorization header via env-based git config, not argv', async () => {
      mockSuccess('');
      await git.pushWithToken('https://github.com/owner/repo.git', 'ghp_secret123', 'feature-x');
      const [, , opts] = mockExecFile.mock.calls[0];
      const expectedAuth = Buffer.from('x-access-token:ghp_secret123').toString('base64');
      expect(opts.env).toMatchObject({
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.extraheader',
        GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${expectedAuth}`,
      });
    });

    it('never persists the credential to the repo config — no `git config`/`git remote` call ever runs', async () => {
      mockSuccess('');
      await git.pushWithToken('https://github.com/owner/repo.git', 'ghp_secret123', 'feature-x');
      const persistentConfigCalls = mockExecFile.mock.calls.filter(
        (c) => c[1].includes('remote') || (c[1].includes('config') && !c[1].includes('-c')),
      );
      expect(persistentConfigCalls).toHaveLength(0);
    });

    it('still inherits the rest of the process env alongside the injected header', async () => {
      process.env.SOME_UNRELATED_VAR = 'x';
      mockSuccess('');
      await git.pushWithToken('https://github.com/owner/repo.git', 'ghp_secret123', 'feature-x');
      const [, , opts] = mockExecFile.mock.calls[0];
      expect(opts.env.SOME_UNRELATED_VAR).toBe('x');
      delete process.env.SOME_UNRELATED_VAR;
    });
  });

  describe('all git commands run scoped to the given repo path', () => {
    it('passes cwd: repoPath on every call', async () => {
      mockSuccess('');
      await git.fetch();
      const call = mockExecFile.mock.calls[0];
      expect(call[2]).toMatchObject({ cwd: '/repo' });
    });
  });
});
