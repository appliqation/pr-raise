import { describe, it, expect, vi } from 'vitest';
import { recordRaiseRun } from './audit.js';
import type { AuditSink } from '@appliqation/agent-core';

describe('recordRaiseRun', () => {
  it('records one call with agent/subcommand and no LLM fields at all', async () => {
    const sink: AuditSink = { record: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) };
    await recordRaiseRun({
      sink,
      startedAt: 1000,
      endedAt: 3000,
      projectId: 1349,
      repoPath: '/repo',
      branchName: 'feature/x',
      result: { committed: true, pushed: true, pr: { number: 1, created: true, url: 'https://github.com/x/y/pull/1' } },
    });

    expect(sink.record).toHaveBeenCalledTimes(1);
    const record = (sink.record as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(record).toMatchObject({ agent: 'appliqation-pr-raise', subcommand: 'raise', startedAt: 1000, endedAt: 3000, durationMillis: 2000, exitCode: 0 });
    expect(record.model).toBeUndefined();
    expect(record.usage).toBeUndefined();
    expect(record.turns).toBeUndefined();
    expect(record.outcome).toMatchObject({ projectId: 1349, repoPath: '/repo', branchName: 'feature/x', committed: true, pushed: true });
  });

  it('exitCode 0 even when nothing was committed — a legitimate outcome, not a failure', async () => {
    const sink: AuditSink = { record: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) };
    await recordRaiseRun({
      sink,
      startedAt: 0,
      endedAt: 1,
      projectId: 1,
      repoPath: '/repo',
      branchName: 'x',
      result: { committed: false, pushed: false, pr: null, skippedReason: 'Nothing to commit.' },
    });
    const record = (sink.record as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(record.exitCode).toBe(0);
  });

  it('records exitCode 1 and an error outcome when result is undefined — raise() threw', async () => {
    const sink: AuditSink = { record: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) };
    await recordRaiseRun({ sink, startedAt: 0, endedAt: 1, projectId: 1, repoPath: '/repo', branchName: 'x', result: undefined });
    const record = (sink.record as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(record.exitCode).toBe(1);
    expect(record.outcome).toEqual({ projectId: 1, repoPath: '/repo', branchName: 'x', error: true });
  });

  it('a sink failure never rejects — safeRecord swallows it', async () => {
    const sink: AuditSink = { record: vi.fn().mockRejectedValue(new Error('down')), close: vi.fn().mockResolvedValue(undefined) };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      recordRaiseRun({ sink, startedAt: 0, endedAt: 1, projectId: 1, repoPath: '/repo', branchName: 'x', result: { committed: false, pushed: false, pr: null } }),
    ).resolves.toBeUndefined();
  });

  it('closes the sink after recording — N-03: an unclosed Mongo client hangs the process since this CLI never calls process.exit()', async () => {
    const sink: AuditSink = { record: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) };
    await recordRaiseRun({ sink, startedAt: 0, endedAt: 1, projectId: 1, repoPath: '/repo', branchName: 'x', result: undefined });
    expect(sink.close).toHaveBeenCalledTimes(1);
  });

  it('still closes the sink even when record() failed', async () => {
    const sink: AuditSink = { record: vi.fn().mockRejectedValue(new Error('down')), close: vi.fn().mockResolvedValue(undefined) };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await recordRaiseRun({ sink, startedAt: 0, endedAt: 1, projectId: 1, repoPath: '/repo', branchName: 'x', result: undefined });
    expect(sink.close).toHaveBeenCalledTimes(1);
  });
});
