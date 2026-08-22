// A thin, real `git` CLI wrapper. No LLM is involved anywhere in this agent
// — committing and pushing a known set of local changes is fully mechanical,
// so there's no tool-calling loop, no allowlist-gated dispatch the way
// appliqation-scriptgen's shell surface needs (that one exists specifically
// because an LLM chooses what to run there; here, this code is the only
// thing that ever decides what git command runs).

import { execFile } from 'node:child_process';

interface ExecOutcome {
  stdout: string;
  stderr: string;
}

interface ExecFailure extends Error {
  code?: number;
  stdout?: string;
  stderr?: string;
}

// Same hand-rolled wrapper as appliqation-scriptgen's codingTools.ts, for
// the same reason: util.promisify(execFile) only resolves {stdout, stderr}
// via an internal Node symbol that a mocked module in tests won't carry.
function execFileAsync(
  command: string,
  args: string[],
  options: { cwd: string; timeout: number; maxBuffer: number; env?: NodeJS.ProcessEnv },
): Promise<ExecOutcome> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        const failure = error as ExecFailure;
        failure.stdout = String(stdout ?? '');
        failure.stderr = String(stderr ?? '');
        rejectPromise(failure);
      } else {
        resolvePromise({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      }
    });
  });
}

export class GitClient {
  constructor(
    private readonly repoPath: string,
    private readonly timeoutMs: number,
  ) {}

  private async git(args: string[], extraEnv?: Record<string, string>): Promise<ExecOutcome> {
    return execFileAsync('git', args, {
      cwd: this.repoPath,
      timeout: this.timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      env: extraEnv ? { ...process.env, ...extraEnv } : undefined,
    });
  }

  async statusPorcelain(): Promise<string> {
    return (await this.git(['status', '--porcelain'])).stdout;
  }

  async hasUncommittedChanges(): Promise<boolean> {
    return (await this.statusPorcelain()).trim().length > 0;
  }

  async fetch(remote = 'origin'): Promise<void> {
    await this.git(['fetch', remote]);
  }

  private async localBranchExists(branchName: string): Promise<boolean> {
    try {
      await this.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`]);
      return true;
    } catch {
      return false;
    }
  }

  /** Checks out branchName, creating it from origin/baseBranch if it doesn't exist locally yet. Never force-resets an existing local branch. */
  async checkoutBranch(branchName: string, baseBranch: string): Promise<void> {
    if (await this.localBranchExists(branchName)) {
      await this.git(['checkout', branchName]);
      return;
    }
    await this.git(['checkout', '-b', branchName, `origin/${baseBranch}`]);
  }

  async addAll(): Promise<void> {
    await this.git(['add', '-A']);
  }

  /** Returns { committed: false } for "nothing to commit" rather than throwing — that's a legitimate outcome, not a failure. */
  async commit(message: string, authorName: string, authorEmail: string): Promise<{ committed: boolean }> {
    try {
      await this.git(['-c', `user.name=${authorName}`, '-c', `user.email=${authorEmail}`, 'commit', '-m', message]);
      return { committed: true };
    } catch (err) {
      const e = err as ExecFailure;
      if (/nothing to commit/i.test(e.stdout ?? '')) return { committed: false };
      throw err;
    }
  }

  /**
   * Pushes HEAD to branchName on remoteUrl, authenticating with token only
   * for this one push — never persisted into .git/config, so the token
   * doesn't linger in the checkout after this process exits.
   *
   * The token used to be embedded directly in the push URL, which becomes an
   * argv element of the spawned `git` process — visible to anyone who can
   * list this process's command line (`ps`, `/proc/<pid>/cmdline`) for
   * however briefly the push runs, even though execFile never touches a
   * shell. Instead it's passed as an HTTP Authorization header via Git's
   * env-based config mechanism (GIT_CONFIG_COUNT/_KEY_n/_VALUE_n, supported
   * since Git 2.31) — the remote URL argv stays a plain, tokenless string,
   * and the credential only ever lives in this process's environment, which
   * a plain `ps` does not expose.
   */
  async pushWithToken(remoteUrl: string, token: string, branchName: string): Promise<void> {
    const basicAuth = Buffer.from(`x-access-token:${token}`).toString('base64');
    await this.git(['push', remoteUrl, `HEAD:refs/heads/${branchName}`], {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basicAuth}`,
    });
  }
}
