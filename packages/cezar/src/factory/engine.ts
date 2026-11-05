import type { FactoryCategory } from '@open-mercato/cezar-contract';
import type { RunManager } from '../workflows/run.ts';
import type { RunRecord, RunStore } from '../runs/store.ts';
import { dispatchAllowed, loadFactoryControls, recordTaskStart } from './controls.ts';
import { moveLifecycle } from './lifecycle.ts';
import { FactoryState } from './state.ts';
import { isEligible, selectNext, SchedulableTask } from './scheduler.ts';
import { isWallClockExceeded, repairCountFromSteps } from './runner.ts';
import { resultMdOf, writeResultReport } from './report.ts';
import { writeDispatchIntent, writeSettleCheckpoint, sweepCheckpoints } from './checkpoint.ts';
import { holdsWorkspaceLease } from './lease.ts';

/**
 * Factory dispatch engine (spec §9).
 *
 * The upstream pump (RunManager.pump) already owns dispatch: every queued run
 * flows through its capacity/hold gates. This engine contributes the factory's
 * SELECTION to that pump — a `queueSelector` the server wires onto every
 * factory-enabled manager — plus a slow tick that (a) reconciles settled runs
 * back onto factory lifecycles and (b) wakes the pump so `notBefore` tasks and
 * lifted gates get re-evaluated without waiting for an unrelated queue event.
 *
 * Selection contract (pump §queueSelector): user (non-factory) runs keep strict
 * FIFO precedence — the pool never delays a composer task; among factory runs
 * the order is promoted → P0 → aged priority → weighted round-robin → createdAt
 * (spec §9.1), and the workspace gates (paused/stopped/budget) can decline the
 * whole sweep by returning undefined.
 */

export const DEFAULT_TICK_MS = 15_000;

export interface FactoryProjectHandle {
  id: string;
  root: string;
  dataDir: string;
  manager: Pick<RunManager, 'promote' | 'cancel'>;
  store: Pick<RunStore, 'listRuns' | 'getRun' | 'updateRun' | 'appendEvent'>;
}

export interface FactoryEngineHost {
  homeDir: string;
  /** Factory-enabled projects (those with a task pool), freshly resolved per tick. */
  projects(): FactoryProjectHandle[];
  /** Wake every manager's pump (re-evaluate gates without a queue event). */
  wake(): void;
  now?: () => Date;
}

export class FactoryEngine {
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;
  /** Persisted WFQ credit per category, workspace-wide. */
  private credit: Record<FactoryCategory, number> = { software: 0, traffic: 0, weather: 0 };

  constructor(
    private readonly host: FactoryEngineHost,
    private readonly tickMs: number = DEFAULT_TICK_MS,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => {
        /* a tick never kills the engine; the next one retries */
      });
    }, this.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * The pump's queueSelector for one project. Candidates already passed the
   * pump's capacity/hold gates; the factory layer adds its own gates (paused,
   * stopped, local budget, dependencies, notBefore) and its ordering.
   */
  selectorFor(handle: FactoryProjectHandle): (startable: RunRecord[]) => RunRecord | undefined {
    return (startable) => {
      const now = this.host.now?.() ?? new Date();
      // User tasks first, in strict FIFO: the pool exists to run the pool, not
      // to tax the composer (spec §9.1 step 3 — 置顶/普通用户任务优先于工厂选择).
      const plain = startable.find((r) => !r.factory);
      if (plain) return plain;
      // The workspace dispatch lease gates FACTORY dispatch only: a second
      // legitimate server process (another repo, same CEZ_HOME) keeps serving
      // its users, but only one instance counts budgets and picks pool work.
      if (!holdsWorkspaceLease()) return undefined;
      const controls = loadFactoryControls(this.host.homeDir, now);
      if (!dispatchAllowed(controls).ok) return undefined;
      let state: FactoryState;
      try {
        state = FactoryState.open(handle.dataDir);
      } catch {
        return undefined; // corrupt/unwritable pool state: freeze, never guess (spec §7)
      }
      const eligible: Array<{ run: RunRecord; task: SchedulableTask }> = [];
      for (const run of startable) {
        const factory = run.factory;
        if (!factory || factory.lifecycle !== 'queued') continue;
        const dependenciesSatisfied = factory.dependsOn.every(
          (key: string) => state.task(key)?.lifecycle === 'review_ready' || state.task(key)?.lifecycle === 'accepted',
        );
        if (
          !isEligible(factory, {
            now,
            stopped: false, // dispatchAllowed already ruled the workspace gates
            paused: false,
            dependenciesSatisfied,
            accountHeld: false, // the pump's startable gate covers holds
          }).ok
        ) {
          continue;
        }
        eligible.push({
          run,
          task: {
            taskId: run.id,
            key: factory.key,
            createdAt: run.createdAt,
            priority: factory.priority,
            category: factory.category,
            promoted: run.promotedAt !== undefined,
          },
        });
      }
      if (eligible.length === 0) return undefined;
      const chosen = selectNext(
        eligible.map((e) => e.task),
        now,
        controls.weights,
        this.credit,
      );
      if (!chosen) return undefined;
      const winner = eligible.find((e) => e.task.taskId === chosen.taskId)!.run;
      // Record-first (spec §7): the lifecycle leaves `queued` BEFORE the pump
      // starts the run, so a crash in between reconciles a preparing task, not
      // a phantom queued one. queued → preparing is a legal transition.
      if (winner.factory) {
        moveLifecycle(handle.store, winner.id, winner.factory, 'preparing', { note: 'factory dispatch' });
        writeDispatchIntent(handle.dataDir, {
          runId: winner.id,
          key: winner.factory.key,
          policyVersion: winner.factory.policyVersion,
          workflowName: '(factory)',
          acceptanceProfileId: winner.factory.acceptanceProfileId,
        }, now);
      }
      // The daily budget is whole-file workspace state. Only the lease holder
      // ever reaches this line (the gate above), so a direct synchronous write
      // is the racy-window-free path — a deferred write would let the pump
      // start the run before the budget counted it.
      recordTaskStart(this.host.homeDir, now);
      return winner;
    };
  }

  /** One reconciliation + a pump wake. Public for tests. */
  async tick(): Promise<{ reconciled: number }> {
    if (this.ticking) return { reconciled: 0 };
    this.ticking = true;
    try {
      let reconciled = 0;
      for (const project of this.host.projects()) {
        reconciled += reconcileProject(project, new Date());
      }
      // Wake the pump so a notBefore that came due, a lifted pause/stop, or a
      // rolled budget day gets re-evaluated without waiting for the next queue
      // event. Harmless when the queue is empty.
      if (reconciled > 0) this.host.wake();
      return { reconciled };
    } finally {
      this.ticking = false;
    }
  }
}

/**
 * Map terminal upstream statuses back onto factory lifecycles for the runs the
 * pool owns. Idempotent per stage; A07 is enforced at M2 when verify steps
 * exist — here a settled success still only reaches `review_ready` (local
 * review), never accepted.
 */
export function reconcileProject(project: FactoryProjectHandle, now: Date): number {
  let changes = 0;
  const moves: Array<{ run: RunRecord; to: 'review_ready' | 'failed' | 'cancelled'; note: string }> = [];
  for (const run of project.store.listRuns()) {
    let factory = run.factory;
    if (!factory) continue;
    // Repair counter sync (spec §9.2: 恢复、网络重试不得清零修复计数 — the step
    // record is the single source; the factory field follows it upward only).
    const repairs = repairCountFromSteps(run.steps, factory);
    if (repairs !== factory.repairAttemptCount) {
      factory = { ...factory, repairAttemptCount: repairs };
      project.store.updateRun(run.id, { factory });
      run.factory = factory;
    }
    const lifecycle = factory.lifecycle;
    if (['preparing', 'running', 'verifying', 'reviewing', 'publishing'].includes(lifecycle)) {
      // Wall clock (spec §9.2): the tick is the enforcer — cancel first (stops
      // the process tree upstream), then the forced lifecycle records WHY.
      if (isWallClockExceeded(factory, run, now)) {
        project.manager.cancel(run.id);
        moveLifecycle(project.store, run.id, factory, 'failed', {
          note: `wall-clock timeout after ${factory.timeoutSeconds}s`, force: true,
        });
        changes += 1;
        continue;
      }
      if (run.status === 'review' || run.status === 'done') {
        moves.push({ run, to: 'review_ready', note: `run settled as ${run.status}` });
      } else if (run.status === 'failed') {
        moves.push({ run, to: 'failed', note: run.error ? String(run.error).slice(0, 200) : 'run failed' });
      } else if (run.status === 'cancelled') {
        moves.push({ run, to: 'cancelled', note: 'run cancelled' });
      }
    }
  }
  for (const m of moves) {
    if (!m.run.factory) continue;
    // Reconciliation jump: the upstream run settled while the lifecycle still
    // names a mid-flight stage — force the move, the event carries the audit.
    moveLifecycle(project.store, m.run.id, m.run.factory, m.to, { note: m.note, force: true });
    // The report is written AT SETTLEMENT, from the settled record (spec §15).
    const markdown = resultMdOf(m.run, m.run.factory);
    const path = writeResultReport(project.dataDir, m.run.id, markdown);
    // The settle checkpoint carries the git facts a restart reasons from (§11.1).
    writeSettleCheckpoint(project.dataDir, {
      runId: m.run.id,
      key: m.run.factory.key,
      policyVersion: m.run.factory.policyVersion,
      workflowName: '(factory)',
      acceptanceProfileId: m.run.factory.acceptanceProfileId,
      outcome: {
        status: m.run.status,
        branch: m.run.branch,
        baseBranch: m.run.baseBranch,
        baseCommit: m.run.factory.baseCommit,
        diffStat: m.run.diffStat ?? null,
        repairAttemptCount: m.run.factory.repairAttemptCount,
        pullRequestUrl: m.run.pullRequestUrl ?? null,
        error: m.run.error ?? null,
      },
    });
    project.store.appendEvent(m.run.id, {
      type: 'factory',
      report: path ?? null,
      note: path ? 'result.md written to artifacts' : 'result.md could not be written',
    });
    changes += 1;
  }
  if (changes > 0) {
    sweepCheckpoints(project.dataDir, new Set(project.store.listRuns().map((r) => r.id)));
  }
  return changes;
}
