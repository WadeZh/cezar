import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { registeredRunPids } from '../core/process-usage.ts';
import { moveLifecycle } from './lifecycle.ts';
import type { FactoryProjectHandle } from './engine.ts';

/**
 * The factory HARD STOP (spec docs/CEZAR_GLM_DEVELOPMENT_SPEC.md §13.3):
 * "硬停止 10 秒内停止所属 Agent/测试进程树并禁止新领取，UI 显示停止结果；
 * 无法确认终止时保持安全阻塞。停止不能只杀父 PID。"
 *
 * Per active factory task, in order:
 *   1. TREE-KILL the registered process tree (Windows: `taskkill /PID x /T /F`
 *      — the same primitive the worktree-lifecycle executor trusts; POSIX:
 *      negative-pid group kill when the child was spawned detached, else a
 *      plain signal to the root and the runner's own SIGKILL watchdog finishes
 *      the job).
 *   2. `manager.cancel(runId)` — the upstream settle path (interrupt, child
 *      reports, slot release).
 *   3. Force the factory lifecycle to `interrupted` — restart must NOT revive
 *      it silently; the recorded stopped intent (controls.json) keeps the pool
 *      down until an explicit resume.
 *
 * The 10-second budget bounds the whole sweep; anything not CONFIRMED dead in
 * that window is reported uncertain and left BLOCKED, never claimed killed.
 */

const execFileAsync = promisify(execFile);
const HARD_STOP_BUDGET_MS = 10_000;
const TREE_KILL_TIMEOUT_MS = 5_000;

export interface HardStopReport {
  stoppedAt: string;
  killed: string[];
  uncertain: Array<{ taskId: string; reason: string }>;
  elapsedMs: number;
}

async function killTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: TREE_KILL_TIMEOUT_MS, windowsHide: true });
    return;
  }
  // POSIX: the agent CLI is not spawned detached, so there is no group to
  // signal; signal the root. The runner's SIGTERM→SIGKILL escalation
  // (`trackChildExit`) finishes the descendants it owns.
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    process.kill(pid, 'SIGKILL');
  }
}

export async function hardStopFactoryTasks(projects: FactoryProjectHandle[], now = new Date()): Promise<HardStopReport> {
  const startedAt = Date.now();
  const report: HardStopReport = { stoppedAt: now.toISOString(), killed: [], uncertain: [], elapsedMs: 0 };
  const pids = registeredRunPids();
  const deadline = startedAt + HARD_STOP_BUDGET_MS;

  const jobs: Array<Promise<void>> = [];
  for (const project of projects) {
    for (const run of project.store.listRuns()) {
      const factory = run.factory;
      if (!factory) continue;
      if (!['preparing', 'running', 'verifying', 'reviewing', 'publishing'].includes(factory.lifecycle)) continue;
      jobs.push((async () => {
        // 1. tree kill first — cancel alone would leave grandchildren running.
        const pid = pids[run.id];
        try {
          if (pid) {
            await Promise.race([
              killTree(pid),
              new Promise((_, reject) => setTimeout(() => reject(new Error('tree kill exceeded budget')), Math.max(1, deadline - Date.now()))),
            ]);
          }
          // 2. settle the run upstream (interrupt + reports + slot release).
          project.manager.cancel(run.id);
          // 3. audited lifecycle jump; restart keeps the stopped intent.
          if (run.factory) {
            moveLifecycle(project.store, run.id, run.factory, 'interrupted', { note: 'hard stop — process tree terminated', force: true });
          }
          report.killed.push(run.id);
        } catch (err) {
          // Unconfirmed termination stays SAFE-BLOCKED (spec §13.3), never "killed".
          project.manager.cancel(run.id);
          if (run.factory) {
            moveLifecycle(project.store, run.id, run.factory, 'blocked', {
              reason: 'hard stop could not confirm process-tree termination',
              force: true,
            });
          }
          report.uncertain.push({ taskId: run.id, reason: String((err as Error)?.message ?? err).slice(0, 200) });
        }
      })());
    }
  }
  await Promise.race([
    Promise.allSettled(jobs),
    new Promise((resolve) => setTimeout(resolve, Math.max(1, deadline - Date.now()))),
  ]);
  report.elapsedMs = Date.now() - startedAt;
  return report;
}
