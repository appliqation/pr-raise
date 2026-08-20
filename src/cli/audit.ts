// Extracted out of cli/index.ts so this is testable without triggering that
// file's top-level program.parseAsync(process.argv) side effect — same
// reasoning as appliqation-autotest's cli/resolvers.ts.
//
// No LLM in this repo at all — RecordRaiseRunArgs has no model/usage/turns/
// budgetExceeded (all absent on the underlying AuditRecord type, unlike
// every other agent in this family).

import { safeRecord, type AuditSink } from '@appliqation/agent-core';
import type { RaiseResult } from '../orchestrator/raise.js';

export interface RecordRaiseRunArgs {
  sink: AuditSink;
  startedAt: number;
  endedAt: number;
  projectId: number;
  repoPath: string;
  branchName: string;
  /** undefined means raise() threw — the run never produced a result. */
  result: RaiseResult | undefined;
}

export async function recordRaiseRun(args: RecordRaiseRunArgs): Promise<void> {
  const { sink, startedAt, endedAt, projectId, repoPath, branchName, result } = args;
  await safeRecord(sink, {
    agent: 'appliqation-pr-raise',
    subcommand: 'raise',
    startedAt,
    endedAt,
    durationMillis: endedAt - startedAt,
    exitCode: result ? 0 : 1,
    outcome: result ? { projectId, repoPath, branchName, ...result } : { projectId, repoPath, branchName, error: true },
  });
}
