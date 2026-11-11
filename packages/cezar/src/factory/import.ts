import type { FactoryImportBody, FactoryImportResponse, FactoryImportResultItem, FactoryState } from '@open-mercato/cezar-contract';
import type { RunManager } from '../workflows/run.ts';
import type { RunStore } from '../runs/store.ts';
import { loadWorkflows } from '../workflows/load.ts';
import { resolveProfile } from './acceptance.ts';
import { buildFactoryWorkflow } from './runner.ts';
import { canonicalDigest, FactoryState as FactoryStateStore } from './state.ts';
import { listProfileIds } from './acceptance.ts';
import { moveLifecycle } from './lifecycle.ts';

/**
 * Factory batch import (spec §7): at most 100 tasks, whole batch preflighted,
 * per-item results, same idempotency key ⇒ existing task (same payload) or 409
 * (different payload). Valid items are created even when others in the batch
 * error — the response itemizes everything so a client can resubmit exactly the
 * failed subset.
 *
 * Tasks are created QUEUED (or needs_spec without acceptance criteria) — import
 * never starts anything, that is the scheduler's job (spec §9.1: 所有入口同一闸门).
 */

const DEFAULT_WORKFLOW = 'quick-task';

export interface ImportProject {
  root: string;
  dataDir: string;
  manager: RunManager;
  store: RunStore;
}

export function composeTaskText(input: { title: string; description: string; scope: string[]; acceptanceCriteria: string[] }): string {
  const lines = [input.title, '', input.description];
  if (input.scope.length > 0) {
    lines.push('', '## 允许触碰的范围（scope）');
    for (const s of input.scope) lines.push(`- ${s}`);
  }
  lines.push('', '## 验收条件');
  if (input.acceptanceCriteria.length === 0) {
    lines.push('-（缺失：本任务在补齐可验证的验收条件前不会执行）');
  } else {
    for (const a of input.acceptanceCriteria) lines.push(`- ${a}`);
  }
  return lines.join('\n');
}

/** One item's static preflight, independent of the others' validity. */
export function preflightItem(
  input: FactoryImportBody['tasks'][number],
  existing: Readonly<Record<string, { taskId: string; requestDigest: string }>>,
  batchKeyCounts: ReadonlyMap<string, number>,
): { error?: { code: string; message: string }; duplicateOf?: string } {
  // Batch import REQUIRES a stable key per item (spec §7 幂等); the single-create
  // route fills it from the Idempotency-Key header instead.
  if (!input.key) return { error: { code: 'key_required', message: 'every imported task needs a key (idempotency)' } };
  const entry = existing[input.key];
  if (entry) {
    const digest = canonicalDigest({ ...input, key: undefined });
    if (digest === entry.requestDigest) return { duplicateOf: entry.taskId };
    return { error: { code: 'key_conflict', message: `idempotency key '${input.key}' already exists with a different payload` } };
  }
  // The batch map COUNTS keys, so this item's own key does not self-collide;
  // a genuine duplicate appears with a count > 1.
  if ((batchKeyCounts.get(input.key) ?? 0) > 1) {
    return { error: { code: 'key_conflict', message: `duplicate key in batch: '${input.key}'` } };
  }
  // Dependencies must name keys that exist, are in this batch, or are impossible (unknown) —
  // unknown dependency keys are a hard error (spec §7: 导入器必须校验对应项目实际存在).
  for (const dep of input.dependsOn) {
    if (dep === input.key) return { error: { code: 'self_dependency', message: `task '${input.key}' depends on itself` } };
    if (!existing[dep] && !batchKeyCounts.has(dep)) {
      return { error: { code: 'unknown_dependency', message: `dependency '${dep}' does not exist in this project or batch` } };
    }
  }
  // The acceptance profile is checked at preflight (spec §14: 导入器必须校验对应项目实际存在):
  // a task naming an unresolvable profile would only fail later, at dispatch, invisibly.
  if (input.acceptanceCriteria.length > 0 && !profileExists(_preflightRoot, input.acceptanceProfileId)) {
    return {
      error: {
        code: 'unknown_profile',
        message: `acceptance profile '${input.acceptanceProfileId}' does not exist (built-ins: node-standard, python-standard, docs-standard; or .ai/cezar/factory/profiles.json)`,
      },
    };
  }
  return {};
}

let _preflightRoot: string | undefined;
/** Set once per import so preflightItem can resolve profiles without a signature change for tests. */
export function setProfileRoot(root: string): void {
  _preflightRoot = root;
}
function profileExists(root: string | undefined, id: string): boolean {
  if (!root) return true; // profile existence uncheckable (unit tests) — dispatch re-validates
  return listProfileIds(root).includes(id);
}

/** Batch-level cycle check over dependsOn (batch keys only; edges to existing tasks are leaves). */
export function findCycle(tasks: FactoryImportBody['tasks']): string[] | undefined {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const batchKeys = new Set(byKey.keys());
  const state = new Map<string, 'visiting' | 'done'>();
  const path: string[] = [];
  const visit = (key: string): string[] | undefined => {
    const mark = state.get(key);
    if (mark === 'done') return undefined;
    if (mark === 'visiting') return path.slice(path.indexOf(key));
    state.set(key, 'visiting');
    path.push(key);
    for (const dep of byKey.get(key)?.dependsOn ?? []) {
      if (!batchKeys.has(dep)) continue;
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    path.pop();
    state.set(key, 'done');
    return undefined;
  };
  for (const t of tasks) {
    if (!t.key) continue; // keyless items fail their own preflight; they form no edges
    const cycle = visit(t.key);
    if (cycle) return cycle;
  }
  return undefined;
}

export async function importFactoryTasks(
  project: ImportProject,
  body: FactoryImportBody,
  opts: { now?: Date } = {},
): Promise<FactoryImportResponse> {
  const now = opts.now ?? new Date();
  const state = FactoryStateStore.open(project.dataDir);
  const items: FactoryImportResultItem[] = [];
  let created = 0;
  let duplicates = 0;

  // ---- whole-batch preflight (spec: 整批先预检) --------------------------------------------
  setProfileRoot(project.root);
  const batchKeyCounts = new Map<string, number>();
  for (const k of body.tasks.map((t) => t.key)) {
    if (!k) continue;
    batchKeyCounts.set(k, (batchKeyCounts.get(k) ?? 0) + 1);
  }
  const preflight = new Map<string, ReturnType<typeof preflightItem>>();
  for (const task of body.tasks) {
    if (!task.key) {
      preflight.set('', preflightItem(task, state.tasks, batchKeyCounts));
      continue;
    }
    preflight.set(task.key, preflightItem(task, state.tasks, batchKeyCounts));
  }
  const cycle = findCycle(body.tasks);
  if (cycle) {
    // A cycle poisons every member: nothing is created, each item explains why.
    const keys = cycle.join(' -> ');
    for (const task of body.tasks) {
      items.push({
        status: 'error',
        key: task.key,
        code: 'dependency_cycle',
        message: `dependency cycle in batch: ${keys}`,
      });
    }
    return { created: 0, duplicates: 0, errors: items, items };
  }

  // ---- create the valid subset --------------------------------------------------------------
  const { workflows } = await loadWorkflows(project.root);
  const workflow = workflows.find((w) => w.name === DEFAULT_WORKFLOW) ?? workflows[0];
  if (!workflow) {
    throw new Error(`no workflow available to run factory tasks (looked for '${DEFAULT_WORKFLOW}')`);
  }
  for (const task of body.tasks) {
    const check = preflight.get(task.key ?? '') ?? {};
    if (check.duplicateOf) {
      duplicates += 1;
      items.push({ status: 'duplicate', key: task.key ?? '', taskId: check.duplicateOf });
      continue;
    }
    if (check.error) {
      items.push({ status: 'error', key: task.key, code: check.error.code, message: check.error.message }); // key may be undefined here — schema allows it on error items
      continue;
    }
    try {
      // A keyless task already errored in preflight; this guard narrows the type.
      const key = task.key;
      if (!key) continue;
      const initialLifecycle: FactoryState['lifecycle'] = task.acceptanceCriteria.length === 0 ? 'needs_spec' : 'queued';
      // Spec §10.1: a task WITH acceptance criteria runs the implement → verify
      // chain from its trusted profile (repair loop = the workflow's own onFail);
      // needs_spec tasks keep quick-task until a human completes the criteria.
      let runWorkflow = workflow;
      if (initialLifecycle === 'queued') {
        const profile = resolveProfile(project.root, task.acceptanceProfileId);
        if (!profile) throw new Error(`acceptance profile '${task.acceptanceProfileId}' vanished between preflight and create`);
        runWorkflow = buildFactoryWorkflow({
          taskText: composeTaskText(task),
          profile,
          maxRepairAttempts: task.maxRepairAttempts,
        });
      }
      const run = project.manager.startRun(runWorkflow, {
        task: composeTaskText(task),
        factory: {
          schemaVersion: 1,
          category: task.category,
          priority: task.priority,
          lifecycle: initialLifecycle,
          dependsOn: task.dependsOn,
          dependencyMode: task.dependencyMode,
          estimatedMinutes: task.estimatedMinutes ?? null,
          timeoutSeconds: task.timeoutSeconds,
          maxRepairAttempts: task.maxRepairAttempts,
          networkRetryCount: 0,
          repairAttemptCount: 0,
          interruptionCount: 0,
          notBefore: task.notBefore ?? null,
          blockedReason: null,
          baseCommit: null,
          checkpointId: null,
          acceptanceProfileId: task.acceptanceProfileId,
          policyVersion: 'v1',
          key,
          publishMode: task.publishMode,
        },
      });
      state.registerTask({
        key,
        taskId: run.id,
        requestDigest: canonicalDigest({ ...task, key: undefined }),
        version: 1,
        lifecycle: initialLifecycle,
        publishMode: task.publishMode,
      });
      if (initialLifecycle === 'needs_spec') {
        const record = project.store.getRun(run.id);
        if (record?.factory) moveLifecycle(project.store, run.id, record.factory, 'needs_spec', { note: 'import: no acceptance criteria' });
      }
      created += 1;
      items.push({ status: 'created', key, taskId: run.id });
    } catch (err) {
      items.push({
        status: 'error',
        key: task.key,
        code: 'create_failed',
        message: String((err as Error)?.message ?? err).slice(0, 300),
      });
    }
  }
  const errors = items.filter((i) => i.status === 'error');
  return { created, duplicates, errors, items };
}
