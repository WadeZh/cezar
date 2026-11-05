import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteJsonSync } from './state.ts';

/**
 * Factory workspace lease (spec docs/CEZAR_GLM_DEVELOPMENT_SPEC.md §11.1).
 *
 * Two distinct protections, one file set under `<cezarHome>/factory/`:
 *
 * 1. SINGLE DISPATCHER per project is upstream-guaranteed (a second `cez serve`
 *    on the same repo hands off to the live cockpit instead of starting). What
 *    is NOT guaranteed is workspace-level state shared by several legitimate
 *    server processes (one per repo): `controls.json` (daily budget) and the
 *    engine's WFQ credit are whole-file atomics, so concurrent writers would
 *    lose updates. `withDispatchLease` serializes exactly those critical
 *    sections.
 *
 * 2. INSTANCE IDENTITY for diagnostics and fencing: `instance.json` records the
 *    boot's {instanceId, pid, startedAt} and the lock file's mtime acts as the
 *    heartbeat. Spec: "文件存在不等于锁仍被持有" — proper-lockfile owns that
 *    judgment (mtime + stale rebinding), never our own file-existence check.
 *
 * Not a distributed lock: single machine, per spec ("单机设计不承诺跨机器
 * 分布式 exactly-once").
 */

const LEASE_DIR = 'factory';
const DISPATCH_LOCK = 'dispatch.lock';
const LEASE_STALE_MS = 15_000; // mirrors upstream automations' GUARD_STALE_MS

export interface FactoryInstanceRecord {
  instanceId: string;
  pid: number;
  startedAt: string;
  host: string;
}

export function factoryLeaseDir(homeDir: string): string {
  return join(homeDir, LEASE_DIR);
}

let instanceRecord: FactoryInstanceRecord | undefined;

export function currentInstance(homeDir: string): FactoryInstanceRecord {
  if (!instanceRecord) {
    instanceRecord = {
      instanceId: randomUUID(),
      pid: process.pid,
      startedAt: new Date().toISOString(),
      host: process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? 'unknown-host',
    };
    try {
      mkdirSync(factoryLeaseDir(homeDir), { recursive: true });
      atomicWriteJsonSync(join(factoryLeaseDir(homeDir), 'instance.json'), instanceRecord);
    } catch {
      /* diagnostics only */
    }
  }
  return instanceRecord;
}

let releaseLock: (() => void) | undefined;

/** Hold the workspace dispatch lock for the process lifetime (idempotent). */
export async function acquireWorkspaceLease(homeDir: string): Promise<boolean> {
  if (releaseLock) return true;
  try {
    mkdirSync(factoryLeaseDir(homeDir), { recursive: true });
    currentInstance(homeDir);
    const release = await lockfile.lock(join(factoryLeaseDir(homeDir), DISPATCH_LOCK), {
      realpath: false,
      stale: LEASE_STALE_MS,
      update: 5_000, // heartbeat: keeps mtime fresh so staleness tracks liveness
      retries: 0,
    });
    releaseLock = () => {
      try {
        release();
      } catch {
        /* already gone */
      }
      releaseLock = undefined;
    };
    return true;
  } catch {
    // Another live process holds the workspace dispatch lease; this process's
    // factory engine stays passive (routes still answer reads).
    return false;
  }
}

export function releaseWorkspaceLease(): void {
  releaseLock?.();
}

export function holdsWorkspaceLease(): boolean {
  return releaseLock !== undefined;
}

/**
 * Serialize a critical section on the workspace dispatch lock (short-lived,
 * bounded retries) — used for whole-file state mutations two processes could
 * race (budget counters, credit persistence).
 */
export async function withDispatchLease<T>(homeDir: string, fn: () => T): Promise<T | undefined> {
  try {
    mkdirSync(factoryLeaseDir(homeDir), { recursive: true });
    return await lockfile.lock(join(factoryLeaseDir(homeDir), DISPATCH_LOCK), {
      realpath: false,
      stale: LEASE_STALE_MS,
      update: 2_000,
      retries: { retries: 5, minTimeout: 50, maxTimeout: 400 },
    }).then(async (release) => {
      try {
        return fn();
      } finally {
        try {
          release();
        } catch {
          /* fine */
        }
      }
    });
  } catch {
    return undefined; // could not take the lease this time; caller treats as skipped
  }
}
