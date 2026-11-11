import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteJsonSync } from './state.ts';

/**
 * Factory stage intents and checkpoints (spec docs/CEZAR_GLM_DEVELOPMENT_SPEC.md §11.1).
 *
 * One file per run at `<root>/.ai/cezar/factory/checkpoints/<runId>.json`:
 *   - INTENT, written BEFORE the pump starts the run the selector picked
 *     ("每个阶段开始前写 intent");
 *   - CHECKPOINT, written when the pool reconciles the settled run
 *     ("完成后写 checkpoint"), carrying the facts a restart needs to reason
 *     about the run without re-deriving them from the transcript.
 *
 * Spec §11.1: "不能只存一段 AI 摘要" — the checkpoint holds identifiers and
 * git facts, never model output. Upstream `manager.recover()` still owns run
 * recovery; these files make the POOL's own bookkeeping auditable and let a
 * fresh boot answer "what was this task doing?" without replaying NDJSON.
 */

export const FACTORY_CHECKPOINT_SCHEMA_VERSION = 1;

export interface FactoryCheckpoint {
  schemaVersion: number;
  runId: string;
  key: string;
  /** 'dispatched' = intent (the pump is about to start it); 'settled' = checkpoint. */
  stage: 'dispatched' | 'settled';
  at: string;
  policyVersion: string;
  workflowName: string;
  acceptanceProfileId: string;
  /** Set at settle: the git facts the run produced. */
  outcome?: {
    status: string;
    branch?: string;
    baseBranch?: string;
    baseCommit?: string | null;
    headCommit?: string | null;
    diffStat?: { adds: number; dels: number; files: number } | null;
    repairAttemptCount: number;
    pullRequestUrl?: string | null;
    error?: string | null;
  };
}

export function factoryCheckpointsDir(dataDir: string): string {
  return join(dataDir, 'factory', 'checkpoints');
}

export function checkpointPath(dataDir: string, runId: string): string {
  return join(factoryCheckpointsDir(dataDir), `${runId}.json`);
}

export function writeDispatchIntent(
  dataDir: string,
  input: { runId: string; key: string; policyVersion: string; workflowName: string; acceptanceProfileId: string },
  now = new Date(),
): void {
  const checkpoint: FactoryCheckpoint = {
    schemaVersion: FACTORY_CHECKPOINT_SCHEMA_VERSION,
    stage: 'dispatched',
    at: now.toISOString(),
    outcome: undefined,
    ...input,
  };
  try {
    atomicWriteJsonSync(checkpointPath(dataDir, input.runId), checkpoint);
  } catch {
    /* best-effort: the run record itself stays authoritative */
  }
}

export function writeSettleCheckpoint(
  dataDir: string,
  input: {
    runId: string;
    key: string;
    policyVersion: string;
    workflowName: string;
    acceptanceProfileId: string;
    outcome: NonNullable<FactoryCheckpoint['outcome']>;
  },
  now = new Date(),
): void {
  const checkpoint: FactoryCheckpoint = {
    schemaVersion: FACTORY_CHECKPOINT_SCHEMA_VERSION,
    stage: 'settled',
    at: now.toISOString(),
    ...input,
  };
  try {
    atomicWriteJsonSync(checkpointPath(dataDir, input.runId), checkpoint);
  } catch {
    /* best-effort */
  }
}

export function readCheckpoint(dataDir: string, runId: string): FactoryCheckpoint | undefined {
  const path = checkpointPath(dataDir, runId);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as FactoryCheckpoint;
    return parsed.schemaVersion === FACTORY_CHECKPOINT_SCHEMA_VERSION ? parsed : undefined;
  } catch {
    return undefined; // a corrupt checkpoint degrades to "unknown" — the run record decides
  }
}

/** Checkpoints of runs that no longer exist get swept (retention mirrors the run store). */
export function sweepCheckpoints(dataDir: string, liveRunIds: ReadonlySet<string>): number {
  let swept = 0;
  try {
    for (const file of readdirSync(factoryCheckpointsDir(dataDir))) {
      if (!file.endsWith('.json')) continue;
      const runId = file.slice(0, -'.json'.length);
      if (liveRunIds.has(runId)) continue;
      try {
        unlinkSync(join(factoryCheckpointsDir(dataDir), file));
        swept += 1;
      } catch {
        /* keep it; next sweep retries */
      }
    }
  } catch {
    /* no dir yet */
  }
  return swept;
}
