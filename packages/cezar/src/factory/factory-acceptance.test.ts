import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listProfileIds, ProfileError, resolveProfile } from './acceptance.ts';
import { buildFactoryWorkflow, isWallClockExceeded, repairCountFromSteps } from './runner.ts';
import { resultMdOf } from './report.ts';
import type { FactoryState, FactoryTaskSummary } from '@open-mercato/cezar-contract';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cezar-factory-acc-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeProfiles(profiles: unknown): void {
  mkdirSync(join(dir, '.ai', 'cezar', 'factory'), { recursive: true });
  writeFileSync(join(dir, '.ai', 'cezar', 'factory', 'profiles.json'), JSON.stringify({ profiles }), 'utf8');
}

describe('acceptance profiles', () => {
  it('answers built-ins with no project file (zero config)', () => {
    const p = resolveProfile(dir, 'node-standard');
    expect(p).toBeDefined();
    expect(p!.executable).toBe('npm');
    expect(p!.args).toEqual(['test']);
    expect(p!.cwd).toBe(dir);
    expect(p!.source).toBe('built-in');
    expect(listProfileIds(dir)).toContain('python-standard');
  });

  it('lets a project override win by id and adds new ids', () => {
    writeProfiles({
      'node-standard': { executable: 'node', args: ['run', 'test'], timeoutMs: 5000 },
      'weather-qc': { executable: 'python', args: ['-m', 'pytest', '-q', 'tests/qc'], timeoutMs: 60_000, relativeCwd: 'research' },
    });
    const p = resolveProfile(dir, 'node-standard');
    expect(p!.executable).toBe('node');
    expect(p!.source).toBe('project');
    const q = resolveProfile(dir, 'weather-qc');
    expect(q!.cwd).toBe(join(dir, 'research'));
  });

  it('degrades a corrupt profiles file to built-ins (never a boot failure)', () => {
    mkdirSync(join(dir, '.ai', 'cezar', 'factory'), { recursive: true });
    writeFileSync(join(dir, '.ai', 'cezar', 'factory', 'profiles.json'), '{broken', 'utf8');
    expect(resolveProfile(dir, 'node-standard')!.source).toBe('built-in');
  });

  it('refuses escapes and shell-shaped executables', () => {
    writeProfiles({
      escapee: { executable: 'npm', args: ['test'], timeoutMs: 5000, relativeCwd: '../outside' },
      absolute: { executable: 'npm', args: ['test'], timeoutMs: 5000, relativeCwd: 'C:\\Windows' },
      shelly: { executable: 'npm;rm', args: [], timeoutMs: 5000 },
      noTimeout: { executable: 'npm', args: [] },
    });
    expect(() => resolveProfile(dir, 'escapee')).toThrow(ProfileError);
    expect(() => resolveProfile(dir, 'absolute')).toThrow(ProfileError);
    expect(() => resolveProfile(dir, 'shelly')).toThrow(ProfileError);
    expect(() => resolveProfile(dir, 'noTimeout')).toThrow(ProfileError);
  });

  it('answers undefined for an unknown id', () => {
    expect(resolveProfile(dir, 'no-such-profile')).toBeUndefined();
  });
});

describe('factory workflow builder', () => {
  it('builds implement → verify(argv) with the profile timeout and the repair cap', () => {
    const profile = resolveProfile(dir, 'node-standard')!;
    const wf = buildFactoryWorkflow({ taskText: 'TASK TEXT', profile, maxRepairAttempts: 2 });
    expect(wf.steps).toHaveLength(2);
    const implement = wf.steps[0]!;
    const verify = wf.steps[1]!;
    expect(implement.prompt).toBe('TASK TEXT');
    expect(verify.argv).toEqual(['npm', 'test']);
    expect(verify.timeoutMs).toBe(profile.timeoutMs);
    expect(verify.onFail).toEqual({ retry: 'implement', max: 2 });
    // the engine's own refines must accept the chain (XOR argv/command holds)
    expect(verify.command).toBeUndefined();
  });

  it('never builds a repair loop wider than the spec cap', () => {
    const profile = resolveProfile(dir, 'node-standard')!;
    const wf = buildFactoryWorkflow({ taskText: 't', profile, maxRepairAttempts: 0 });
    expect(wf.steps[1]!.onFail!.max).toBe(1); // at least one verify pass; 0 extra repairs
  });
});

describe('wall clock and repair accounting', () => {
  const factory = (over: Partial<FactoryState>): FactoryState => ({
    schemaVersion: 1,
    category: 'software',
    priority: 2,
    lifecycle: 'running',
    dependsOn: [],
    dependencyMode: 'review_ready',
    estimatedMinutes: null,
    timeoutSeconds: 60,
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

  it('times a running run against its startedAt only', () => {
    const now = new Date('2026-11-05T01:10:00.000Z');
    const f = factory({});
    expect(isWallClockExceeded(f, { startedAt: '2026-11-05T01:00:00.000Z', status: 'running' }, now)).toBe(true);
    expect(isWallClockExceeded(f, { startedAt: '2026-11-05T01:09:30.000Z', status: 'running' }, now)).toBe(false);
    // queued/waiting-for-slot runs have not begun their budget
    expect(isWallClockExceeded(f, { startedAt: '2026-11-05T00:00:00.000Z', status: 'queued' }, now)).toBe(false);
    expect(isWallClockExceeded(f, { status: 'running' }, now)).toBe(false);
  });

  it('follows the verify step retries upward, never down', () => {
    const f = factory({ repairAttemptCount: 1 });
    expect(repairCountFromSteps([{ id: 'verify', kind: 'check', retriesUsed: 2 }], f)).toBe(2);
    expect(repairCountFromSteps([{ id: 'verify', kind: 'check', retriesUsed: 0 }], f)).toBe(1);
    expect(repairCountFromSteps(undefined, f)).toBe(1);
  });
});

describe('result.md report', () => {
  it('renders facts with explicit unknowns and an unverifiable section', () => {
    const factoryState: FactoryState = {
      schemaVersion: 1,
      category: 'traffic',
      priority: 1,
      lifecycle: 'review_ready',
      dependsOn: [],
      dependencyMode: 'review_ready',
      estimatedMinutes: null,
      timeoutSeconds: 3600,
      maxRepairAttempts: 2,
      networkRetryCount: 0,
      repairAttemptCount: 2,
      interruptionCount: 0,
      notBefore: null,
      blockedReason: null,
      baseCommit: null,
      checkpointId: null,
      acceptanceProfileId: 'node-standard',
      policyVersion: 'v1',
      key: 'wind-v1',
      publishMode: 'local_review',
    };
    const md = resultMdOf(
      {
        id: 'run-1',
        title: '风速换算',
        task: '正文',
        status: 'review',
        runner: 'opencode',
        tokensUsed: 1234,
        costUsd: 0.02,
        steps: [{ id: 'verify', kind: 'check', status: 'done', retriesUsed: 2, iterations: 3, tokensUsed: 0 }],
        factory: factoryState,
      } as unknown as Parameters<typeof resultMdOf>[0],
      factoryState,
    );
    expect(md).toContain('风速换算');
    expect(md).toContain('wind-v1');
    expect(md).toContain('修复尝试: 2');
    expect(md).toContain('Token 用量（估计）: 1234');
    expect(md).toContain('无法验证的事项');
    // no fabricated cost semantics
    expect(md).toContain('估计（上游逐项 input/output/cache 拆分未持久化');
    void ({} as FactoryTaskSummary);
  });
});
