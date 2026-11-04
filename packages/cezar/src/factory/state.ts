import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FactoryPublishMode } from '@open-mercato/cezar-contract';

/**
 * Cezar-GLM factory project state (spec §7 存储原则 / §11 幂等).
 *
 * Lives at `<root>/.ai/cezar/factory/state.json` — beside the upstream run
 * store, never inside it. The upstream `runs.json` index is debounced (1 s)
 * and unsynced; factory state holds the fields whose loss would double-execute
 * work (idempotency registry) or double-publish (publish intents), so it is
 * written atomically with fsync on EVERY mutation, before any side effect.
 *
 * Corruption contract (spec: "对新增工厂状态的损坏不得静默清空后继续执行"):
 * a corrupt file is quarantined and `FactoryStateError` is thrown — scheduling
 * stops until a human looks. A MISSING file is the normal zero-config cold
 * start and yields an empty state.
 */

export const FACTORY_STATE_SCHEMA_VERSION = 1;

export interface FactoryTaskEntry {
  taskId: string;
  /** sha256 of the canonical creation payload — same key + different digest ⇒ 409 (spec §12). */
  requestDigest: string;
  version: number;
  lifecycle: string;
  publishMode: FactoryPublishMode;
  createdAt: string;
  updatedAt: string;
}

export interface FactoryPublishIntent {
  taskId: string;
  host: string;
  owner: string;
  repo: string;
  headBranch: string;
  baseBranch: string;
  state: 'intended' | 'pushed' | 'created' | 'failed' | 'blocked';
  prUrl?: string;
  attempts: number;
  updatedAt: string;
}

export interface FactoryStateFile {
  schemaVersion: number;
  tasks: Record<string, FactoryTaskEntry>;
  publishIntents: Record<string, FactoryPublishIntent>;
}

export class FactoryStateError extends Error {
  constructor(
    message: string,
    readonly code: 'corrupt' | 'unwritable',
  ) {
    super(message);
    this.name = 'FactoryStateError';
  }
}

export function factoryDataDir(dataDir: string): string {
  return join(dataDir, 'factory');
}

export function factoryStatePath(dataDir: string): string {
  return join(factoryDataDir(dataDir), 'state.json');
}

export function canonicalDigest(payload: unknown): string {
  // Stable across key order: canonical JSON with sorted object keys.
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** Write-through store: every mutation rewrites the whole file atomically. State is small (≤ thousands of entries). */
export class FactoryState {
  private constructor(
    private readonly path: string,
    private data: FactoryStateFile,
  ) {}

  static open(dataDir: string): FactoryState {
    const path = factoryStatePath(dataDir);
    if (!existsSync(path)) {
      return new FactoryState(path, { schemaVersion: FACTORY_STATE_SCHEMA_VERSION, tasks: {}, publishIntents: {} });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      quarantine(path, String((err as Error)?.message ?? err));
      throw new FactoryStateError(`factory state is corrupt and was quarantined: ${path}`, 'corrupt');
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      (parsed as FactoryStateFile).schemaVersion !== FACTORY_STATE_SCHEMA_VERSION ||
      typeof (parsed as FactoryStateFile).tasks !== 'object' ||
      typeof (parsed as FactoryStateFile).publishIntents !== 'object'
    ) {
      quarantine(path, 'unexpected shape');
      throw new FactoryStateError(`factory state has an unexpected shape: ${path}`, 'corrupt');
    }
    return new FactoryState(path, parsed as FactoryStateFile);
  }

  get tasks(): Readonly<Record<string, FactoryTaskEntry>> {
    return this.data.tasks;
  }

  get publishIntents(): Readonly<Record<string, FactoryPublishIntent>> {
    return this.data.publishIntents;
  }

  task(key: string): FactoryTaskEntry | undefined {
    return this.data.tasks[key];
  }

  registerTask(
    entry: Omit<FactoryTaskEntry, 'createdAt' | 'updatedAt'> & { key: string },
    now = new Date().toISOString(),
  ): void {
    const existing = this.data.tasks[entry.key];
    this.data.tasks[entry.key] = {
      taskId: entry.taskId,
      requestDigest: entry.requestDigest,
      version: entry.version,
      lifecycle: entry.lifecycle,
      publishMode: entry.publishMode,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.save();
  }

  updateTask(
    key: string,
    patch: Partial<Pick<FactoryTaskEntry, 'taskId' | 'lifecycle' | 'publishMode' | 'version'>>,
    now = new Date().toISOString(),
  ): FactoryTaskEntry | undefined {
    const current = this.data.tasks[key];
    if (!current) return undefined;
    const next = { ...current, ...patch, updatedAt: now };
    this.data.tasks[key] = next;
    this.save();
    return next;
  }

  publishIntent(taskId: string): FactoryPublishIntent | undefined {
    return this.data.publishIntents[taskId];
  }

  setPublishIntent(intent: FactoryPublishIntent, now = new Date().toISOString()): void {
    this.data.publishIntents[intent.taskId] = { ...intent, updatedAt: now };
    this.save();
  }

  /** Flush + atomic replace; called before any side effect that depends on the new state. */
  private save(): void {
    try {
      atomicWriteJsonSync(this.path, this.data);
    } catch (err) {
      throw new FactoryStateError(`factory state is unwritable: ${this.path}: ${String((err as Error)?.message ?? err)}`, 'unwritable');
    }
  }
}

/** Atomic JSON write: same-dir tmp file, fsync, rename. Shared by every factory state file —
 *  spec §7: "文件采用同目录临时文件、flush/fsync、原子替换". */
export function atomicWriteJsonSync(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const body = JSON.stringify(data, null, 2);
  const fd = openSync(tmp, 'w');
  try {
    writeFileSync(fd, body, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

function quarantine(path: string, reason: string): void {
  // Spec: keep the audit trail. The corrupt file is renamed beside itself, never deleted.
  try {
    renameSync(path, `${path}.corrupt-${Date.now()}`);
  } catch {
    /* rename failed too — the throw below surfaces it */
  }
  try {
    // Best-effort breadcrumb for whoever investigates.
    writeFileSync(`${path}.corrupt-reason.txt`, `${new Date().toISOString()} ${reason}\n`, 'utf8');
  } catch {
    /* non-fatal */
  }
}

export function removeStateFileQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* absent is fine */
  }
}
