import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkpointPath,
  readCheckpoint,
  sweepCheckpoints,
  writeDispatchIntent,
  writeSettleCheckpoint,
} from './checkpoint.ts';
import {
  acquireWorkspaceLease,
  holdsWorkspaceLease,
  releaseWorkspaceLease,
  withDispatchLease,
} from './lease.ts';
import { FactoryState, factoryStatePath } from './state.ts';

vi.mock('../server/forge/github.ts', () => ({
  createDraftPr: vi.fn(),
  resolvePrTarget: vi.fn(),
}));

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cezar-factory-m3-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  releaseWorkspaceLease();
});

describe('checkpoints (spec §11.1)', () => {
  const base = { runId: 'r-1', key: 'k-1', policyVersion: 'v1', workflowName: '(factory)', acceptanceProfileId: 'node-standard' };

  it('writes the dispatch intent BEFORE the run starts and reads it back', () => {
    writeDispatchIntent(dir, base);
    const cp = readCheckpoint(dir, 'r-1');
    expect(cp?.stage).toBe('dispatched');
    expect(cp?.key).toBe('k-1');
    expect(cp?.outcome).toBeUndefined();
  });

  it('records the settle facts — identifiers and git facts, never model prose', () => {
    writeDispatchIntent(dir, base);
    writeSettleCheckpoint(dir, {
      ...base,
      outcome: {
        status: 'review',
        branch: 'cez/abc12345',
        baseBranch: 'main',
        baseCommit: 'deadbeef',
        diffStat: { adds: 10, dels: 2, files: 3 },
        repairAttemptCount: 1,
        pullRequestUrl: null,
        error: null,
      },
    });
    const cp = readCheckpoint(dir, 'r-1');
    expect(cp?.stage).toBe('settled');
    expect(cp?.outcome?.branch).toBe('cez/abc12345');
    expect(cp?.outcome?.diffStat).toEqual({ adds: 10, dels: 2, files: 3 });
  });

  it('sweeps checkpoints of runs that no longer exist', () => {
    writeDispatchIntent(dir, base);
    writeDispatchIntent(dir, { ...base, runId: 'r-gone' });
    expect(sweepCheckpoints(dir, new Set(['r-1']))).toBe(1);
    expect(existsSync(checkpointPath(dir, 'r-1'))).toBe(true);
    expect(existsSync(checkpointPath(dir, 'r-gone'))).toBe(false);
  });

  it('answers undefined for a corrupt checkpoint (the run record decides)', () => {
    const { mkdirSync, writeFileSync } = require('node:fs') as typeof import('node:fs');
    mkdirSync(join(dir, 'factory', 'checkpoints'), { recursive: true });
    writeFileSync(checkpointPath(dir, 'r-bad'), '{nope', 'utf8');
    expect(readCheckpoint(dir, 'r-bad')).toBeUndefined();
  });
});

describe('workspace dispatch lease (spec §11.1)', () => {
  it('is exclusive while held and re-acquirable after release', async () => {
    expect(await acquireWorkspaceLease(dir)).toBe(true);
    expect(holdsWorkspaceLease()).toBe(true);
    // a second process/lease attempt on the same home fails while we hold it
    // proper-lockfile's CJS default export IS the lock function (with methods attached).
    const lockfile = (await import('proper-lockfile')).default;
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'factory'), { recursive: true });
    await expect(
      lockfile.lock(join(dir, 'factory', 'dispatch.lock'), { realpath: false, retries: 0, stale: 60_000 }),
    ).rejects.toThrow();
    releaseWorkspaceLease();
    // release() is async upstream — give it a beat before contending again.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(holdsWorkspaceLease()).toBe(false);
    // now lockable again — and the contender's lock is released for the next test
    await expect(
      lockfile.lock(join(dir, 'factory', 'dispatch.lock'), { realpath: false, retries: 0, stale: 60_000 }),
    ).resolves.toStrictEqual(expect.any(Function));
    const { unlockSync } = lockfile;
    try {
      unlockSync(join(dir, 'factory', 'dispatch.lock'));
    } catch {
      /* already gone */
    }
  });

  it('serializes a critical section for NON-holders and declines while the long lock is held', async () => {
    // A process WITHOUT the long hold can take the short lease to mutate state.
    let ran = 0;
    const result = await withDispatchLease(dir, () => {
      ran += 1;
      return 'ran';
    });
    expect(result).toBe('ran');
    expect(ran).toBe(1);
    // the long-lived hold blocks a short lease — caller sees undefined, not a hang
    expect(await acquireWorkspaceLease(dir)).toBe(true);
    const blocked = await withDispatchLease(dir, () => 'never');
    expect(blocked).toBeUndefined();
    releaseWorkspaceLease();
  });
});

describe('idempotent publish (spec §11.3, A12)', () => {
  it('adopts an already-created PR from the durable intent without calling gh again', async () => {
    const state = FactoryState.open(dir);
    state.setPublishIntent({
      taskId: 'r-1',
      host: 'github.com',
      owner: 'me',
      repo: 'demo',
      headBranch: 'cez/abc',
      baseBranch: 'main',
      state: 'created',
      prUrl: 'https://github.com/me/demo/pull/7',
      attempts: 1,
    });
    const { createDraftPr } = await import('../server/forge/github.ts');
    const { publishFactoryTask } = await import('./publish.ts');
    const store = fakeStore('r-1');
    const outcome = await publishFactoryTask({
      repoRoot: dir,
      dataDir: dir,
      store: store as never,
      manager: {} as never,
      taskId: 'r-1',
    });
    expect(outcome).toEqual({ ok: true, status: 'adopted', prUrl: 'https://github.com/me/demo/pull/7' });
    expect(createDraftPr).not.toHaveBeenCalled();
  });

  it('persists the intent before the side effect and records created/blocked outcomes', async () => {
    const { createDraftPr, resolvePrTarget } = await import('../server/forge/github.ts');
    const { publishFactoryTask } = await import('./publish.ts');
    const store = fakeStore('r-2', { branch: 'cez/abc', baseBranch: 'main', worktreePath: join(dir, 'wt') });
    vi.mocked(resolvePrTarget).mockResolvedValue({ repo: 'github.com/me/demo', head: 'cez/abc', base: 'main', pushRemote: 'origin' });

    // success path: intended → created, PR url persisted
    vi.mocked(createDraftPr).mockResolvedValue({ ok: true, url: 'https://github.com/me/demo/pull/9', dryRun: false });
    const ok = await publishFactoryTask({ repoRoot: dir, dataDir: dir, store: store as never, manager: {} as never, taskId: 'r-2' });
    expect(ok).toMatchObject({ ok: true, status: 'created', prUrl: 'https://github.com/me/demo/pull/9' });
    const state = FactoryState.open(dir);
    expect(state.publishIntent('r-2')).toMatchObject({ state: 'created', host: 'github.com', owner: 'me', repo: 'demo', attempts: 1 });

    // divergence path: push refused → blocked, NOT force-pushed, attempts counted
    rmSync(factoryStatePath(dir), { force: true });
    const store2 = fakeStore('r-3', { branch: 'cez/def', baseBranch: 'main', worktreePath: join(dir, 'wt2') });
    vi.mocked(createDraftPr).mockResolvedValue({ ok: false, error: 'the branch diverged from its base (rejected non-fast-forward)' });
    const blocked = await publishFactoryTask({ repoRoot: dir, dataDir: dir, store: store2 as never, manager: {} as never, taskId: 'r-3' });
    expect(blocked.status).toBe('blocked');
    const state3 = FactoryState.open(dir);
    expect(state3.publishIntent('r-3')).toMatchObject({ state: 'blocked', attempts: 1 });
  });

  it('refuses to publish a run that never produced a branch', async () => {
    const { publishFactoryTask } = await import('./publish.ts');
    const store = fakeStore('r-4', { branch: undefined, worktreePath: undefined });
    const outcome = await publishFactoryTask({ repoRoot: dir, dataDir: dir, store: store as never, manager: {} as never, taskId: 'r-4' });
    expect(outcome).toMatchObject({ ok: false, status: 'blocked' });
  });
});

function fakeStore(runId: string, over: Record<string, unknown> = {}) {
  const run = {
    id: runId,
    title: 't',
    task: 't',
    status: 'review',
    workflow: 'x',
    createdAt: new Date().toISOString(),
    tokensUsed: 0,
    archived: false,
    steps: [],
    factory: {
      schemaVersion: 1, category: 'software', priority: 1, lifecycle: 'review_ready',
      dependsOn: [], dependencyMode: 'review_ready', estimatedMinutes: null,
      timeoutSeconds: 3600, maxRepairAttempts: 2, networkRetryCount: 0,
      repairAttemptCount: 0, interruptionCount: 0, notBefore: null,
      blockedReason: null, baseCommit: null, checkpointId: null,
      acceptanceProfileId: 'node-standard', policyVersion: 'v1', key: 'k',
      publishMode: 'draft_pr',
    },
    ...over,
  };
  const events: unknown[] = [];
  return {
    getRun: (id: string) => (id === runId ? run : undefined),
    appendEvent: (_id: string, e: unknown) => void events.push(e),
    listRuns: () => [run],
    updateRun: () => undefined,
    _events: events,
  };
}

void readdirSync;
