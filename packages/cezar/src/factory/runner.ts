import type { FactoryState } from '@open-mercato/cezar-contract';
import type { WorkflowDef, WorkflowStepDef } from '../workflows/types.ts';
import type { ResolvedProfile } from './acceptance.ts';

/**
 * The factory task's execution shape (spec §10.1 标准过程):
 *
 *   implement (agent) → verify (trusted argv check) — on verify failure the
 *   workflow's own onFail loop retries implement, at most `maxRepairAttempts`
 *   times (spec §9.2 修复上限 2). ONE workflow, the upstream engine — no second
 *   executor anywhere (spec §1.8).
 *
 * The verify step is `argv`-shaped: the acceptance profile's executable and
 * literal arguments, spawned shell-less by the upstream check layer — the task
 * brief can never inject a command (spec §10.2/§10.3).
 */

export const IMPLEMENT_STEP_ID = 'implement';
export const VERIFY_STEP_ID = 'verify';

export function buildFactoryWorkflow(input: {
  taskText: string;
  profile: ResolvedProfile;
  maxRepairAttempts: number;
  workflowName?: string;
}): WorkflowDef {
  const implement: WorkflowStepDef = {
    id: IMPLEMENT_STEP_ID,
    name: 'implement',
    prompt: input.taskText,
  };
  const verify: WorkflowStepDef = {
    id: VERIFY_STEP_ID,
    name: 'verify',
    argv: [input.profile.executable, ...input.profile.args],
    timeoutMs: input.profile.timeoutMs,
    onFail: {
      retry: IMPLEMENT_STEP_ID,
      max: Math.max(1, input.maxRepairAttempts),
    },
  };
  return {
    name: input.workflowName ?? '(factory)',
    source: 'built-in',
    steps: [implement, verify],
  };
}

/**
 * Wall-clock budget (spec §9.2 单任务墙钟超时). Monotonic-ish: derived from the
 * record's own `startedAt` against the tick's now — a suspend/resume that
 * freezes the wall clock is handled by A23's re-evaluation, not here.
 */
export function isWallClockExceeded(
  factory: FactoryState,
  run: Pick<RunRecordLike, 'startedAt' | 'status'>,
  now: Date,
): boolean {
  if (!run.startedAt) return false;
  if (!['running', 'waiting'].includes(run.status)) return false;
  return now.getTime() - new Date(run.startedAt).getTime() > factory.timeoutSeconds * 1000;
}

/** Minimal structural view the helper needs (keeps the engine's fake stores testable). */
export interface RunRecordLike {
  startedAt?: string;
  status: string;
}

/** Sync the repair counter from the verify step's consumed retries (single source: the step record). */
export function repairCountFromSteps(steps: Array<{ id: string; kind: string; retriesUsed?: number }> | undefined, factory: FactoryState): number {
  const verify = steps?.find((s) => s.id === VERIFY_STEP_ID);
  return Math.max(factory.repairAttemptCount, verify?.retriesUsed ?? 0);
}

export function factorySummaryFor(factory: FactoryState): string {
  return `factory[${factory.key}] ${factory.category} P${factory.priority} ${factory.lifecycle}`;
}
