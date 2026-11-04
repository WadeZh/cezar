import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FactoryEngine, type FactoryEngineHost, type FactoryProjectHandle } from './engine.ts';
import { setStopped, setPaused } from './controls.ts';
import { acquireWorkspaceLease, releaseWorkspaceLease } from './lease.ts';
import type { FactoryState as FactoryStateShape } from '@open-mercato/cezar-contract';

let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cezar-factory-engine-'));
  // The selector's workspace-lease gate (spec §11.1) must be satisfied for
  // dispatch tests; afterEach releases it.
  await acquireWorkspaceLease(dir);
});

afterEach(() => {
  releaseWorkspaceLease();
  rmSync(dir, { recursive: true, force: true });
});

// ---- minimal fakes ---------------------------------------------------------------------------

interface FakeRun {
  id: string;
  title: string;
  task: string;
  status: 'queued' | 'running' | 'waiting' | 'review' | 'done' | 'failed' | 'cancelled';
  createdAt: string;
  promotedAt?: string;
  error?: string;
  factory?: FactoryStateShape;
}

function fakeStore(runs: FakeRun[]) {
  return {
    listRuns: () => runs,
    getRun: (id: string) => runs.find((r) => r.id === id),
    updateRun: (id: string, patch: Partial<FakeRun>) => {
      const run = runs.find((r) => r.id === id);
      if (run) Object.assign(run, patch);
      return run;
    },
    appendEvent: (_id: string, _event: { type: string }) => undefined,
  } as unknown as FactoryProjectHandle['store'];
}

function task(over: Partial<FactoryStateShape> & { key: string }): FactoryStateShape {
  return {
    schemaVersion: 1,
    category: 'software',
    priority: 2,
    lifecycle: 'queued',
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
    publishMode: 'local_review',
    ...over,
  };
}

function makeRun(id: string, factory?: FactoryStateShape, over: Partial<FakeRun> = {}): FakeRun {
  return {
    id,
    title: factory?.key ?? id,
    task: 't',
    status: 'queued',
    createdAt: '2026-11-05T00:00:00.000Z',
    factory,
    ...over,
  };
}

function makeHost(over: Partial<FactoryEngineHost> = {}): FactoryEngineHost & { woken: number } {
  const woken = { count: 0 };
  return {
    homeDir: dir,
    woken: 0,
    projects: () => [{
      id: 'p1',
      root: dir,
      dataDir: dir,
      manager: { promote: () => undefined } as unknown as FactoryProjectHandle['manager'],
      store: fakeStore([]),
    }],
    wake: () => {
      woken.count += 1;
    },
    now: () => new Date('2026-11-05T01:00:00.000Z'),
    ...over,
  } as FactoryEngineHost & { woken: number };
}

// The engine only reads the factory-relevant fields; the fake runs are cast to
// the real record shape at the selector boundary.
const asRuns = (runs: FakeRun[]) => runs as unknown as Parameters<ReturnType<typeof FactoryEngine.prototype.selectorFor>>[0];

function selectorOf(host: FactoryEngineHost) {
  const engine = new FactoryEngine(host);
  const handle = host.projects()[0]!;
  return { engine, select: engine.selectorFor(handle) };
}

describe('factory queue selector (pump hook)', () => {
  it('never delays a plain user run — FIFO wins over the whole pool', () => {
    const { select } = selectorOf(makeHost());
    const plain = makeRun('user-1');
    const p0 = makeRun('f-p0', task({ key: 'k-p0', priority: 0 }));
    expect(select(asRuns([p0, plain]))).toBe(plain);
    expect(select(asRuns([plain]))).toBe(plain);
  });

  it('declines the sweep while stopped or paused (the gates, in order)', () => {
    const { select } = selectorOf(makeHost());
    const f = makeRun('f1', task({ key: 'k1' }));
    setStopped(dir, true, 'test stop');
    expect(select(asRuns([f]))).toBeUndefined();
    setStopped(dir, false);
    setPaused(dir, true, 'test pause');
    expect(select(asRuns([f]))).toBeUndefined();
    setPaused(dir, false);
    expect(select(asRuns([f]))?.id).toBe('f1');
  });

  it('counts the daily budget on every dispatch', () => {
    const { select } = selectorOf(makeHost());
    const f = makeRun('f1', task({ key: 'k1' }));
    select(asRuns([f]));
    const controls = JSON.parse(readFileSync(join(dir, 'factory', 'controls.json'), 'utf8')) as { startedToday: number };
    expect(controls.startedToday).toBe(1);
  });

  it('skips tasks with unmet dependencies or a future notBefore', () => {
    const { select } = selectorOf(makeHost());
    const dep = makeRun('f-dep', task({ key: 'k-dep', dependsOn: ['k0'] }));
    const future = makeRun('f-future', task({ key: 'k-future', notBefore: '2099-01-01T00:00:00.000Z' }));
    expect(select(asRuns([dep, future]))).toBeUndefined();
  });

  it('picks P0 first, then aged priority, then WFQ rotation across dispatches', () => {
    const { select } = selectorOf(makeHost());
    const p0 = makeRun('f-p0', task({ key: 'k-p0', priority: 0 }));
    const p1 = makeRun('f-p1', task({ key: 'k-p1', priority: 1 }));
    expect(select(asRuns([p1, p0]))?.id).toBe('f-p0');
    // fresh engine: WFQ credit starts clean (it is engine-instance state, and the
    // P0 pick above already charged software's account)
    const { select: selectFresh } = selectorOf(makeHost());
    // same priority: WFQ credit rotates software → traffic → weather (5:3:2)
    const runs = [
      makeRun('s1', task({ key: 's1', category: 'software' })),
      makeRun('s2', task({ key: 's2', category: 'software' })),
      makeRun('t1', task({ key: 't1', category: 'traffic' })),
      makeRun('w1', task({ key: 'w1', category: 'weather' })),
    ];
    const picks: string[] = [];
    let pool = [...runs];
    for (let i = 0; i < 7 && pool.length > 0; i += 1) {
      const picked = selectFresh(asRuns(pool));
      if (!picked) break;
      picks.push(picked.id);
      pool = pool.filter((r) => r.id !== picked.id);
    }
    expect(picks[0]).toBe('s1'); // software weight 5 leads
    const counts = (c: string) => picks.filter((id) => id.startsWith(c)).length;
    expect(counts('s')).toBeGreaterThanOrEqual(counts('t'));
    expect(counts('t')).toBeGreaterThanOrEqual(counts('w'));
  });
});

describe('factory engine tick', () => {
  it('reconciles settled runs onto factory lifecycles (success → review_ready, never accepted — A07) and wakes the pump', async () => {
    const runs = [
      makeRun('r1', task({ key: 'k1', lifecycle: 'running' }), { status: 'done' }),
      makeRun('r2', task({ key: 'k2', lifecycle: 'verifying' }), { status: 'failed', error: 'boom' }),
      makeRun('r3', task({ key: 'k3', lifecycle: 'preparing' }), { status: 'cancelled' }),
    ];
    let woken = 0;
    const host = makeHost({
      projects: () => [{ id: 'p1', root: dir, dataDir: dir, manager: { promote: () => undefined } as unknown as FactoryProjectHandle['manager'], store: fakeStore(runs) }],
      wake: () => {
        woken += 1;
      },
    });
    const result = await new FactoryEngine(host).tick();
    expect(result.reconciled).toBe(3);
    expect(woken).toBe(1);
    expect(runs.find((r) => r.id === 'r1')?.factory?.lifecycle).toBe('review_ready');
    expect(runs.find((r) => r.id === 'r2')?.factory?.lifecycle).toBe('failed');
    expect(runs.find((r) => r.id === 'r3')?.factory?.lifecycle).toBe('cancelled');
    // idempotent: a second tick finds nothing new
    expect((await new FactoryEngine(host).tick()).reconciled).toBe(0);
  });

  it('leaves everything alone when the pool holds no settled runs', async () => {
    let woken = 0;
    const host = makeHost({ wake: () => { woken += 1; } });
    const result = await new FactoryEngine(host).tick();
    expect(result.reconciled).toBe(0);
    expect(woken).toBe(0);
  });
});
