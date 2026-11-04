import type { FactoryCategory } from '@open-mercato/cezar-contract';
import type { RunManager } from '../workflows/run.ts';
import type { RunRecord, RunStore } from '../runs/store.ts';
import { dispatchAllowed, loadFactoryControls, recordTaskStart } from './controls.ts';
import { moveLifecycle } from './lifecycle.ts';
import { FactoryState } from './state.ts';
import { isEligible, selectNext, SchedulableTask } from './scheduler.ts';

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
  manager: Pick<RunManager, 'promote'>;
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
      if (winner.factory) moveLifecycle(handle.store, winner.id, winner.factory, 'preparing', { note: 'factory dispatch' });
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
    const factory = run.factory;
    if (!factory) continue;
    const lifecycle = factory.lifecycle;
    if (['preparing', 'running', 'verifying', 'reviewing', 'publishing'].includes(lifecycle)) {
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
    changes += 1;
  }
  void now;
  return changes;
}
