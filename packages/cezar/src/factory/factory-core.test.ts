import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalDigest,
  FactoryState,
  FactoryStateError,
  factoryStatePath,
} from './state.ts';
import {
  assertTransition,
  FactoryTransitionError,
  lifecycleStatus,
  FACTORY_TRANSITIONS,
} from './lifecycle.ts';
import {
  effectivePriority,
  isEligible,
  isStarved,
  selectNext,
  SchedulableTask,
} from './scheduler.ts';
import {
  dispatchAllowed,
  loadFactoryControls,
  recordTaskStart,
  setPaused,
  setStopped,
  shanghaiDay,
} from './controls.ts';
import { composeTaskText, findCycle, preflightItem } from './import.ts';
import type { FactoryTaskInput } from '@open-mercato/cezar-contract';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cezar-factory-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const BASE_TASK: FactoryTaskInput = {
  key: 'demo-1',
  title: 'T',
  description: 'D',
  scope: ['src'],
  acceptanceCriteria: ['a'],
  acceptanceProfileId: 'node-standard',
  category: 'software',
  priority: 2,
  dependsOn: [],
  dependencyMode: 'review_ready',
  estimatedMinutes: null,
  timeoutSeconds: 3600,
  maxRepairAttempts: 2,
  notBefore: null,
  publishMode: 'local_review',
};

describe('factory state', () => {
  it('starts empty and registers tasks idempotently by key', () => {
    const state = FactoryState.open(dir);
    expect(Object.keys(state.tasks)).toHaveLength(0);
    state.registerTask({ key: 'k1', taskId: 'r1', requestDigest: 'd', version: 1, lifecycle: 'queued', publishMode: 'local_review' });
    state.registerTask({ key: 'k1', taskId: 'r1', requestDigest: 'd', version: 1, lifecycle: 'queued', publishMode: 'local_review' });
    expect(Object.keys(state.tasks)).toHaveLength(1);
    expect(FactoryState.open(dir).task('k1')?.taskId).toBe('r1');
  });

  it('quarantines a corrupt file and refuses to continue silently', () => {
    writeFileSync(factoryStatePath(dir), '{not json', 'utf8');
    expect(() => FactoryState.open(dir)).toThrow(FactoryStateError);
    const files = readdirSync(join(dir, 'factory'));
    expect(files.some((f) => f.startsWith('state.json.corrupt-'))).toBe(true);
  });

  it('fails unwritable state instead of pretending it saved', () => {
    const state = FactoryState.open(dir);
    // Simulate unwritable: point the store at a path whose parent is a file.
    const blocked = FactoryState.open(join(dir, 'file-not-dir'));
    writeFileSync(join(dir, 'file-not-dir'), 'x', 'utf8');
    expect(() => blocked.registerTask({ key: 'k', taskId: 'r', requestDigest: 'd', version: 1, lifecycle: 'queued', publishMode: 'local_review' })).toThrow(FactoryStateError);
    void state;
  });

  it('canonical digest ignores key order but not values', () => {
    expect(canonicalDigest({ a: 1, b: [2, 3] })).toBe(canonicalDigest({ b: [2, 3], a: 1 }));
    expect(canonicalDigest({ a: 1 })).not.toBe(canonicalDigest({ a: 2 }));
    expect(canonicalDigest({ a: undefined })).toBe(canonicalDigest({}));
  });
});

describe('factory lifecycle', () => {
  it('maps lifecycle stages onto the upstream status without renaming it', () => {
    expect(lifecycleStatus('queued')).toBe('queued');
    expect(lifecycleStatus('verifying')).toBe('running');
    expect(lifecycleStatus('review_ready')).toBe('review');
    expect(lifecycleStatus('pr_ready')).toBe('review');
    expect(lifecycleStatus('accepted')).toBe('done');
    expect(lifecycleStatus('blocked')).toBe('waiting');
  });

  it('enforces the spec §8 transition table', () => {
    expect(() => assertTransition('queued', 'preparing')).not.toThrow();
    expect(() => assertTransition('verifying', 'repairing')).not.toThrow();
    expect(() => assertTransition('queued', 'running')).toThrow(FactoryTransitionError);
    // the repair loop closes: repairing goes back to verifying, at most twice (caller counts)
    expect(FACTORY_TRANSITIONS.repairing).toContain('verifying');
    // terminals have no exits
    expect(FACTORY_TRANSITIONS.accepted).toHaveLength(0);
    expect(FACTORY_TRANSITIONS.cancelled).toHaveLength(0);
    // a hard stop leaves an interrupted task recoverable or blocked
    expect(FACTORY_TRANSITIONS.running).toContain('interrupted');
    expect(FACTORY_TRANSITIONS.interrupted).toContain('blocked');
  });
});

describe('factory scheduler', () => {
  const at = (iso: string): Date => new Date(iso);
  const task = (over: Partial<SchedulableTask>): SchedulableTask => ({
    taskId: 'r',
    key: 'k',
    createdAt: '2026-11-05T00:00:00.000Z',
    priority: 2,
    category: 'software',
    promoted: false,
    ...over,
  });

  it('ages waiting tasks one level per 6 hours, floored at P1', () => {
    expect(effectivePriority({ priority: 2, createdAt: '2026-11-05T00:00:00.000Z' }, at('2026-11-05T05:59:00Z'))).toBe(2);
    expect(effectivePriority({ priority: 2, createdAt: '2026-11-05T00:00:00.000Z' }, at('2026-11-05T06:00:00Z'))).toBe(1);
    expect(effectivePriority({ priority: 3, createdAt: '2026-11-05T00:00:00.000Z' }, at('2026-11-05T12:00:00Z'))).toBe(1);
    expect(effectivePriority({ priority: 0, createdAt: '2026-11-05T00:00:00.000Z' }, at('2026-11-06T00:00:00Z'))).toBe(0);
  });

  it('prefers P0, then round-robins categories by weight deficit, stably', () => {
    const now = at('2026-11-05T01:00:00Z');
    const software = task({ key: 's1', category: 'software' });
    const traffic = task({ key: 't1', category: 'traffic' });
    const p0 = task({ key: 'p0', priority: 0, category: 'weather' });
    // P0 wins regardless of category weights
    expect(selectNext([software, traffic, p0], now)?.key).toBe('p0');
    // same priority: software (weight 5) leads first
    expect(selectNext([software, traffic], now)?.key).toBe('s1');
  });

  it('lets an empty-weight category starve behind others with backlog', () => {
    const now = at('2026-11-05T01:00:00Z');
    const traffic = task({ key: 't1', category: 'traffic' });
    const weather = task({ key: 'w1', category: 'weather' });
    const credit = { software: 0, traffic: 5, weather: 5 };
    expect(selectNext([traffic, weather], now, { software: 5, traffic: 0, weather: 2 }, credit)?.key).toBe('w1');
  });

  it('flags a category starved for over a working day', () => {
    const now = at('2026-11-07T01:00:00Z');
    expect(isStarved([task({ key: 'w', category: 'weather', createdAt: '2026-11-05T00:00:00Z' })], 'weather', now)).toBe(true);
    expect(isStarved([task({ key: 'w', category: 'weather', createdAt: '2026-11-07T00:00:00Z' })], 'weather', now)).toBe(false);
  });

  it('gates eligibility on the environment, not on wishes', () => {
    const f = { lifecycle: 'queued' as const, notBefore: null, blockedReason: null };
    const env = { now: new Date(), stopped: false, paused: false, dependenciesSatisfied: true, accountHeld: false };
    expect(isEligible(f, env)).toEqual({ ok: true });
    expect(isEligible(f, { ...env, stopped: true })).toEqual({ ok: false, reason: 'factory stopped' });
    expect(isEligible(f, { ...env, paused: true })).toEqual({ ok: false, reason: 'factory paused (soft)' });
    expect(isEligible(f, { ...env, dependenciesSatisfied: false }).ok).toBe(false);
    expect(isEligible(f, { ...env, accountHeld: true }).ok).toBe(false);
    const future = { ...f, notBefore: '2099-01-01T00:00:00.000Z' };
    expect(isEligible(future, env).ok).toBe(false);
    expect(isEligible({ ...f, lifecycle: 'needs_spec' }, env).ok).toBe(false);
  });
});

describe('factory controls', () => {
  it('rolls the Asia/Shanghai daily counter per local day, independent of host clock', () => {
    expect(shanghaiDay(new Date('2026-11-05T16:30:00Z'))).toBe('2026-11-06'); // 00:30 +8
    expect(shanghaiDay(new Date('2026-11-05T15:59:00Z'))).toBe('2026-11-05'); // 23:59 +8
  });

  it('blocks dispatch when stopped, paused, or out of local budget', () => {
    let c = loadFactoryControls(dir);
    expect(dispatchAllowed(c).ok).toBe(true);
    c = setPaused(dir, true, 'reviewing a suspicious task');
    expect(dispatchAllowed(c)).toEqual({ ok: false, reason: 'reviewing a suspicious task' });
    c = setPaused(dir, false);
    c = setStopped(dir, true, 'hard stop');
    expect(dispatchAllowed(c).ok).toBe(false);
    setStopped(dir, false);
    c = loadFactoryControls(dir);
    c.maxNewTasksPerDay = 2;
    c.startedToday = 2;
    expect(dispatchAllowed(c).ok).toBe(false);
  });

  it('counts task starts and survives a restart', () => {
    recordTaskStart(dir);
    recordTaskStart(dir);
    expect(loadFactoryControls(dir).startedToday).toBe(2);
  });

  it('fails safe on an unreadable controls file (brake, never accelerator)', () => {
    writeFileSync(join(dir, 'factory', 'controls.json'), 'garbage', 'utf8');
    const c = loadFactoryControls(dir);
    expect(c.stopped).toBe(true);
    expect(dispatchAllowed(c).ok).toBe(false);
  });
});

describe('factory import preflight', () => {
  it('accepts a fresh key, dedupes an identical payload, conflicts on a different one', () => {
    const existing = { 'demo-1': { taskId: 'r1', requestDigest: canonicalDigest({ ...BASE_TASK, key: undefined }) } };
    expect(preflightItem(BASE_TASK, existing, new Set()).duplicateOf).toBe('r1');
    expect(preflightItem({ ...BASE_TASK, title: 'changed' }, existing, new Set()).error?.code).toBe('key_conflict');
    expect(preflightItem({ ...BASE_TASK, key: 'demo-2' }, existing, new Set(['demo-2'])).error?.code).toBe('key_conflict');
    expect(preflightItem({ ...BASE_TASK, key: 'demo-2' }, existing, new Set()).error).toBeUndefined();
  });

  it('rejects unknown and self dependencies', () => {
    expect(preflightItem({ ...BASE_TASK, dependsOn: ['nope'] }, {}, new Set()).error?.code).toBe('unknown_dependency');
    expect(preflightItem({ ...BASE_TASK, dependsOn: ['demo-1'] }, {}, new Set()).error?.code).toBe('self_dependency');
    expect(preflightItem({ ...BASE_TASK, dependsOn: ['other-batch'] }, {}, new Set(['other-batch'])).error).toBeUndefined();
  });

  it('finds cycles across the batch', () => {
    const a = { ...BASE_TASK, key: 'a', dependsOn: ['b'] };
    const b = { ...BASE_TASK, key: 'b', dependsOn: ['a'] };
    expect(findCycle([a, b])).toBeDefined();
    expect(findCycle([{ ...a, dependsOn: [] }, b])).toBeUndefined();
    // deps on EXISTING tasks are leaves, not cycle edges
    expect(findCycle([{ ...BASE_TASK, key: 'a', dependsOn: ['existing-task'] }])).toBeUndefined();
  });

  it('composes a readable task text with an explicit missing-criteria marker', () => {
    const text = composeTaskText({ title: '风速换算', description: '加一个工具页', scope: ['src/tools/wind'], acceptanceCriteria: ['10 m/s = 36 km/h'] });
    expect(text).toContain('风速换算');
    expect(text).toContain('10 m/s = 36 km/h');
    const empty = composeTaskText({ title: 'T', description: 'D', scope: [], acceptanceCriteria: [] });
    expect(empty).toContain('缺失');
  });
});
