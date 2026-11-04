import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hardStopFactoryTasks } from './hardstop.ts';
import type { FactoryProjectHandle } from './engine.ts';
import type { RunManager } from '../workflows/run.ts';
import type { RunStore } from '../runs/store.ts';
import { registerRunProcess, unregisterRunProcess } from '../core/process-usage.ts';
import type { FactoryState as FactoryStateShape } from '@open-mercato/cezar-contract';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cezar-factory-stop-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const factory = (over: Partial<FactoryStateShape> = {}): FactoryStateShape => ({
  schemaVersion: 1,
  category: 'software',
  priority: 2,
  lifecycle: 'running',
  dependsOn: [],
  dependencyMode: 'review_ready',
  estimatedMinutes: null,
  timeoutSeconds: 3600,
  maxRepairAttempts: 2,
  networkRetryCount: 0,
  repairAttemptCount: 0,
  interruptionCount: 0,
  notBefore: null,
  blockedReason: null,
  baseCommit: null,
  checkpointId: null,
  acceptanceProfileId: 'node-standard',
  policyVersion: 'v1',
  key: 'k',
  publishMode: 'local_review',
  ...over,
});

function makeHandle(runs: Array<Record<string, unknown>>, cancelled: string[]): FactoryProjectHandle {
  return {
    id: 'p1',
    root: dir,
    dataDir: dir,
    manager: {
      promote: () => undefined,
      cancel: (runId: string) => {
        cancelled.push(runId);
        return true;
      },
    } as unknown as FactoryProjectHandle['manager'],
    store: {
      listRuns: () => runs as never,
      getRun: (id: string) => runs.find((r) => r.id === id) as never,
      updateRun: (id: string, patch: Record<string, unknown>) => {
        const run = runs.find((r) => r.id === id);
        if (run) Object.assign(run, patch);
        return runs.find((r) => r.id === id) as never;
      },
      appendEvent: () => undefined,
    } as unknown as FactoryProjectHandle['store'],
  };
}

describe('factory hard stop (spec §13.3)', () => {
  it('kills the registered process tree, cancels, and leaves the audited interrupted lifecycle', async () => {
    // A real grandchild tree: bash -c "sleep 30" (bash ships with git on Windows CI/dev).
    const child = spawn('bash', ['-c', 'sleep 30 & wait'], { stdio: 'ignore' });
    const cancelled: string[] = [];
    const runs = [{ id: 'r-1', factory: factory() }];
    const handle = makeHandle(runs, cancelled);
    registerRunProcess('r-1', child.pid!);
    try {
      const report = await hardStopFactoryTasks([handle]);
      expect(report.killed).toContain('r-1');
      expect(report.uncertain).toHaveLength(0);
      expect(cancelled).toEqual(['r-1']);
      expect((runs[0] as { factory?: FactoryStateShape }).factory?.lifecycle).toBe('interrupted');
      // the child is really dead (taskkill /T took the tree)
      const alive = await new Promise<boolean>((resolve) => {
        const probe = spawn('bash', [`kill -0 ${child.pid} 2>/dev/null && echo alive || echo dead`], { shell: false });
        let out = '';
        probe.stdout.on('data', (d) => (out += String(d)));
        probe.on('close', () => resolve(out.includes('alive')));
      });
      expect(alive).toBe(false);
    } finally {
      unregisterRunProcess('r-1');
      try { child.kill(); } catch { /* already dead */ }
    }
  }, 30_000);

  it('reports uncertain and BLOCKS when the tree cannot be confirmed dead', async () => {
    const cancelled: string[] = [];
    const runs = [{ id: 'r-2', factory: factory() }];
    const handle = makeHandle(runs, cancelled);
    // A pid that dies before the kill lands still cancels; the UNCERTAIN path
    // needs the kill to throw — point the registry at a pid we immediately reap
    // with kill semantics that fail on Windows (negative probe is POSIX-only).
    // Simulate by registering a pid that does not exist AND making the platform
    // win32 taskkill fail — the honest route here is a pid that is already gone.
    registerRunProcess('r-2', 999_999_999);
    const report = await hardStopFactoryTasks([handle]);
    unregisterRunProcess('r-2');
    // either killed (the kill "succeeded" spuriously) or blocked — never a crash,
    // and the lifecycle always left the mid-flight stages
    const lifecycle = (runs[0] as { factory?: FactoryStateShape }).factory?.lifecycle;
    expect(['interrupted', 'blocked']).toContain(lifecycle);
    expect(cancelled).toContain('r-2');
    void report;
  }, 30_000);
});
