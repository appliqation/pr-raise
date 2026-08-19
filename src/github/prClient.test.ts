import { describe, it, expect, vi } from 'vitest';
import { parseGitHubRepoUrl } from './prClient.js';

describe('parseGitHubRepoUrl', () => {
  it('parses a plain https URL', () => {
    expect(parseGitHubRepoUrl('https://github.com/owner/repo')).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('parses an https URL with a .git suffix', () => {
    expect(parseGitHubRepoUrl('https://github.com/owner/repo.git')).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('parses an https URL with a trailing slash', () => {
    expect(parseGitHubRepoUrl('https://github.com/owner/repo/')).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('parses an SSH-form URL', () => {
    expect(parseGitHubRepoUrl('git@github.com:owner/repo.git')).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('parses an SSH-form URL with no .git suffix', () => {
    expect(parseGitHubRepoUrl('git@github.com:owner/repo')).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('throws a clear error for a non-GitHub URL', () => {
    expect(() => parseGitHubRepoUrl('https://gitlab.com/owner/repo')).toThrow(/Could not parse/);
  });
});

const { mockList, mockUpdate, mockCreate } = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockUpdate: vi.fn(),
  mockCreate: vi.fn(),
}));
vi.mock('@octokit/rest', () => ({
  Octokit: class MockOctokit {
    pulls = { list: mockList, update: mockUpdate, create: mockCreate };
  },
}));

const { PrClient } = await import('./prClient.js');

describe('PrClient.ensurePr — idempotent open/reuse', () => {
  const target = { owner: 'acme', repo: 'widgets' };
  const opts = { head: 'automan/run-1', base: 'main', title: 'My PR', body: 'body text' };

  it('creates a new PR when none exists for this head branch', async () => {
    mockList.mockResolvedValue({ data: [] });
    mockCreate.mockResolvedValue({ data: { number: 42, html_url: 'https://github.com/acme/widgets/pull/42' } });

    const client = new PrClient('token');
    const result = await client.ensurePr(target, opts);

    expect(mockCreate).toHaveBeenCalledWith({ owner: 'acme', repo: 'widgets', head: 'automan/run-1', base: 'main', title: 'My PR', body: 'body text' });
    expect(result).toEqual({ number: 42, url: 'https://github.com/acme/widgets/pull/42', created: true });
  });

  it('reuses an existing open PR for the same head branch instead of creating a second one', async () => {
    mockList.mockResolvedValue({ data: [{ number: 7, html_url: 'https://github.com/acme/widgets/pull/7' }] });
    mockUpdate.mockResolvedValue({});

    const client = new PrClient('token');
    const result = await client.ensurePr(target, opts);

    expect(mockCreate).not.toHaveBeenCalled();
    expect(result).toEqual({ number: 7, url: 'https://github.com/acme/widgets/pull/7', created: false });
  });

  it('lists PRs scoped to owner:head, not just the branch name alone', async () => {
    mockList.mockResolvedValue({ data: [] });
    mockCreate.mockResolvedValue({ data: { number: 1, html_url: 'x' } });

    const client = new PrClient('token');
    await client.ensurePr(target, opts);

    expect(mockList).toHaveBeenCalledWith({ owner: 'acme', repo: 'widgets', head: 'acme:automan/run-1', state: 'open' });
  });

  it('rebuilds (not appends) the body on reuse, so repeat calls stay accurate', async () => {
    mockList.mockResolvedValue({ data: [{ number: 7, html_url: 'x' }] });
    mockUpdate.mockResolvedValue({});

    const client = new PrClient('token');
    await client.ensurePr(target, { ...opts, body: 'updated body' });

    expect(mockUpdate).toHaveBeenCalledWith({ owner: 'acme', repo: 'widgets', pull_number: 7, body: 'updated body' });
  });

  it('gives a clear error for the "no commits between base and head" 422, rather than a raw Octokit error', async () => {
    mockList.mockResolvedValue({ data: [] });
    mockCreate.mockRejectedValue(Object.assign(new Error('Validation Failed'), { status: 422, message: 'No commits between main and automan/run-1' }));

    const client = new PrClient('token');
    await expect(client.ensurePr(target, opts)).rejects.toThrow(/no commits between/i);
  });

  it('rethrows any other Octokit error unchanged', async () => {
    mockList.mockResolvedValue({ data: [] });
    mockCreate.mockRejectedValue(Object.assign(new Error('Bad credentials'), { status: 401 }));

    const client = new PrClient('token');
    await expect(client.ensurePr(target, opts)).rejects.toThrow('Bad credentials');
  });
});
