import type { RunStore } from '../runs/store.ts';

/**
 * Cezar-GLM factory lifecycle (spec §8).
 *
 * Upstream run statuses (`queued|running|waiting|review|done|failed|cancelled`)
 * stay the COMPATIBLE display surface — they are never renamed and old records
 * keep rendering. `factory.lifecycle` is the finer-grained pool state beside
 * them; the audit requirement (spec §8 "审计中维护清晰映射") is this module.
 */

import type { FactoryLifecycle, FactoryState } from '@open-mercato/cezar-contract';
import type { RunStatus } from '../runs/store.ts';

/** The upstream status a lifecycle stage renders as. Several stages fold into `running`. */
export function lifecycleStatus(lifecycle: FactoryLifecycle): RunStatus {
  switch (lifecycle) {
    case 'needs_spec':
    case 'queued':
      return 'queued';
    case 'preparing':
    case 'running':
    case 'verifying':
    case 'repairing':
    case 'reviewing':
    case 'publishing':
      return 'running';
    case 'waiting':
      return 'waiting';
    // Reconcile-pending: upstream recover() re-enqueues; beyond limits it fails (both legal).
    case 'interrupted':
      return 'queued';
    case 'review_ready':
    case 'pr_ready':
      return 'review';
    case 'accepted':
      return 'done';
    case 'blocked':
      return 'waiting';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
  }
}

/** Legal moves, one row per spec §8's "下一步" column. */
export const FACTORY_TRANSITIONS: Readonly<Record<FactoryLifecycle, readonly FactoryLifecycle[]>> = {
  needs_spec: ['queued', 'cancelled'],
  queued: ['preparing', 'blocked', 'waiting', 'cancelled'],
  preparing: ['running', 'blocked', 'cancelled'],
  running: ['verifying', 'waiting', 'interrupted', 'cancelled'],
  verifying: ['reviewing', 'repairing', 'failed', 'cancelled'],
  repairing: ['verifying', 'failed', 'cancelled'],
  reviewing: ['review_ready', 'repairing', 'blocked', 'cancelled'],
  waiting: ['queued', 'cancelled'],
  interrupted: ['preparing', 'running', 'verifying', 'blocked', 'failed', 'cancelled'],
  review_ready: ['publishing', 'accepted', 'cancelled'],
  publishing: ['pr_ready', 'waiting', 'blocked', 'cancelled'],
  pr_ready: ['accepted'],
  accepted: [],
  blocked: ['queued', 'review_ready', 'cancelled'],
  failed: ['queued', 'cancelled'],
  cancelled: [],
};

export class FactoryTransitionError extends Error {
  constructor(
    readonly from: FactoryLifecycle,
    readonly to: FactoryLifecycle,
  ) {
    super(`illegal factory lifecycle transition: ${from} -> ${to}`);
    this.name = 'FactoryTransitionError';
  }
}

export function assertTransition(from: FactoryLifecycle, to: FactoryLifecycle): void {
  if (from === to) return; // re-asserting the same stage is idempotent, not a move
  if (!FACTORY_TRANSITIONS[from]?.includes(to)) throw new FactoryTransitionError(from, to);
}

export function isTerminal(lifecycle: FactoryLifecycle): boolean {
  return lifecycle === 'accepted' || lifecycle === 'cancelled';
}

/**
 * Persist a lifecycle move: transition-checked, record-first, event-second.
 * Spec §7: "重要状态变更必须在启动副作用前落盘" — the record write (atomic
 * index save) happens before the NDJSON event that narrates it.
 */
export function moveLifecycle(
  store: RunStore,
  taskId: string,
  factory: FactoryState,
  to: FactoryLifecycle,
  extra?: { reason?: string; note?: string },
): { factory: FactoryState; status: RunStatus } {
  const from = factory.lifecycle;
  assertTransition(from, to);
  const next: FactoryState = { ...factory, lifecycle: to };
  if (to === 'blocked') next.blockedReason = extra?.reason ?? factory.blockedReason ?? 'blocked';
  if (to !== 'blocked') next.blockedReason = null;
  const status = lifecycleStatus(to);
  store.updateRun(taskId, { factory: next, status });
  store.appendEvent(taskId, {
    type: 'factory',
    from,
    to,
    ...(extra?.reason ? { reason: extra.reason } : {}),
    ...(extra?.note ? { note: extra.note } : {}),
  });
  return { factory: next, status };
}
