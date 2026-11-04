import type { FactoryCategory, FactoryState, FactoryTaskSummary } from '@open-mercato/cezar-contract';

/**
 * Factory dispatch ordering (spec §9.1 领取顺序).
 *
 * The upstream queue is FIFO with an explicit promote() (audited: no priority,
 * weights or aging anywhere). The factory layer keeps FIFO as the base and adds
 * its selection AS A PROMOTION: a tick picks the highest-ranked eligible factory
 * task and calls the manager's promote(), which persists `promotedAt` and jumps
 * the queue within the concurrency cap — never preempting the active task
 * (A03) and never bypassing the semaphore or account holds, because promote
 * routes through the same pump gate as everything else.
 *
 * Ordering rules, in order:
 *   1. eligibility (caller filters: stopped/paused, deps unmet, notBefore in the
 *      future, account hold, needs_spec, blocked…) — see `isEligible`
 *   2. user-pinned (promoted) tasks first — they were already queued ahead
 *   3. P0 first
 *   4. non-P0 aging: +1 effective priority per 6 h waited, floor at P1
 *   5. same effective priority: weighted round-robin over category
 *      (software:traffic:weather = 5:3:2 default) via deficit counting
 *   6. same category: createdAt, then key — stable
 */

export const AGING_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const AGING_FLOOR_PRIORITY = 1; // aging never creates a new P0
export const DEFAULT_WEIGHTS: Record<FactoryCategory, number> = { software: 5, traffic: 3, weather: 2 };

export interface SchedulableTask {
  taskId: string;
  key: string;
  createdAt: string;
  /** Effective priority after aging; computed here. */
  priority: number;
  category: FactoryCategory;
  /** True when a user explicitly promoted this task (spec §9.1 step 3). */
  promoted: boolean;
}

export interface EligibilityFailure {
  ok: false;
  reason: string;
}
export interface EligibilityOk {
  ok: true;
}
export type Eligibility = EligibilityOk | EligibilityFailure;

/** Static eligibility — cheap, no side effects. Caller supplies the environment answers. */
export function isEligible(
  factory: Pick<FactoryState, 'lifecycle' | 'notBefore' | 'blockedReason'>,
  env: { now: Date; stopped: boolean; paused: boolean; dependenciesSatisfied: boolean; accountHeld: boolean },
): Eligibility {
  if (env.stopped) return { ok: false, reason: 'factory stopped' };
  if (factory.lifecycle === 'needs_spec') return { ok: false, reason: 'missing acceptance criteria — needs_spec' };
  if (factory.lifecycle === 'blocked') return { ok: false, reason: factory.blockedReason ?? 'blocked' };
  if (['accepted', 'cancelled', 'failed', 'pr_ready', 'review_ready'].includes(factory.lifecycle)) {
    return { ok: false, reason: `terminal or gated stage: ${factory.lifecycle}` };
  }
  if (!env.dependenciesSatisfied) return { ok: false, reason: 'dependencies not review_ready yet' };
  if (env.accountHeld) return { ok: false, reason: 'account usage hold' };
  if (factory.notBefore && new Date(factory.notBefore).getTime() > env.now.getTime()) {
    return { ok: false, reason: `not before ${factory.notBefore}` };
  }
  // paused is checked LAST for reporting clarity: a paused factory still
  // reports the task's own reason on its detail page otherwise.
  if (env.paused) return { ok: false, reason: 'factory paused (soft)' };
  return { ok: true };
}

/** Aging per spec §9.1 step 4: every full 6 h waited lifts one level, never past P1. */
export function effectivePriority(task: { priority: number; createdAt: string; promoted?: boolean }, now: Date): number {
  const waitedMs = now.getTime() - new Date(task.createdAt).getTime();
  const levels = Math.floor(waitedMs / AGING_INTERVAL_MS);
  return Math.max(AGING_FLOOR_PRIORITY, task.priority - levels);
}

/**
 * Pick the next task to promote. `credit` tracks round-robin deficits across
 * ticks (callers persist it); the implementation is a weighted deficit round
 * robin on TASK COUNT (spec §9.1: 第二版才换运行分钟数).
 */
export function selectNext(
  tasks: SchedulableTask[],
  now: Date,
  weights: Record<FactoryCategory, number> = DEFAULT_WEIGHTS,
  credit: Record<FactoryCategory, number> = { software: 0, traffic: 0, weather: 0 },
): SchedulableTask | undefined {
  if (tasks.length === 0) return undefined;
  const ranked = tasks
    .map((t) => ({ ...t, priority: effectivePriority(t, now) }))
    .sort((a, b) => {
      // promoted first (already ahead in the FIFO queue; keep the choice stable)
      if (a.promoted !== b.promoted) return a.promoted ? -1 : 1;
      if (a.priority !== b.priority) return a.priority - b.priority;
      // weighted round-robin: lower remaining credit (more deficit) first, by weight
      const wa = credit[a.category] ?? weights[a.category];
      const wb = credit[b.category] ?? weights[b.category];
      if (wa !== wb) return wa - wb;
      if (a.createdAt !== b.createdAt) return (a.createdAt < b.createdAt ? -1 : 1);
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });
  const chosen = ranked[0];
  if (!chosen) return undefined; // ranked mirrors tasks, which the early return already covered
  // Charge the chosen category one token of its weight budget; a category with
  // weight 0 (user-configured) never gains credit and thus never leads while
  // competitors have backlog.
  credit[chosen.category] = (credit[chosen.category] ?? weights[chosen.category]) - 1;
  return chosen;
}

/** True when a category monopolized the queue for more than one working day (spec §9.1 hunger hint). */
export function isStarved(tasks: SchedulableTask[], category: FactoryCategory, now: Date): boolean {
  const ofCategory = tasks.filter((t) => t.category === category);
  if (ofCategory.length === 0) return false;
  const oldest = Math.min(...ofCategory.map((t) => new Date(t.createdAt).getTime()));
  return now.getTime() - oldest > 24 * 60 * 60 * 1000;
}

/** Compose a wait reason string for the task table (spec §12 任务表). */
export function waitReasonOf(eligibility: EligibilityFailure | undefined, upstream: FactoryTaskSummary['waitReason']): string | undefined {
  return eligibility?.reason ?? upstream ?? undefined;
}
