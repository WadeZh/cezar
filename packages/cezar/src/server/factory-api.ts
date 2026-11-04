import { Hono } from 'hono';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  factoryControlActionSchema,
  factoryErrorSchema,
  factoryImportBodySchema,
  factoryTaskActionSchema,
  factoryTaskInputSchema,
  factoryTaskPatchSchema,
  factoryTasksQuerySchema,
  type FactoryImportResponse,
  type FactoryState as FactoryStateShape,
  type FactoryStatus,
  type FactoryTaskSummary,
  type FactoryTasksResponse,
  type FactoryUsageResponse,
} from '@open-mercato/cezar-contract';
import { jsonZodValidator, queryZodValidator } from './validators.ts';
import type { ProjectContext } from './project-context.ts';
import { AgentUsageHolds } from '../workspace/agent-usage-holds.ts';
import { FactoryState as FactoryStateStore } from '../factory/state.ts';
import { importFactoryTasks } from '../factory/import.ts';
import { moveLifecycle } from '../factory/lifecycle.ts';
import { publishFactoryTask } from '../factory/publish.ts';
import {
  dispatchAllowed,
  loadFactoryControls,
  setPaused,
  setStopped,
} from '../factory/controls.ts';
import type { FactoryProjectHandle } from '../factory/engine.ts';
import { reconcileProject } from '../factory/engine.ts';
import type { RunRecord } from '../runs/store.ts';

/**
 * The FACTORY route families (spec docs/CEZAR_GLM_DEVELOPMENT_SPEC.md §12).
 *
 * Two chained builders: the project family mounts under `/api/v1/p/:projectId`
 * AND `/api/v1` (the runs-family aliasing), the workspace family is
 * single-mount. Chaining is load-bearing — a loose `app.get` never reaches
 * `AppType` (AGENTS.md §HTTP API), and every registered route must be
 * inventoried in BACKWARD_COMPATIBILITY.md §2 or `bc-route-inventory.test.ts`
 * fails the suite.
 */

type ProjectApiEnv = { Variables: { project: ProjectContext } };

export interface FactoryApiDeps {
  /** CEZ_HOME — workspace control state lives here (spec §7 存储原则). */
  homeDir: string;
  /** All factory-enabled projects, boot first. */
  projects(): ProjectContext[];
}

const err = (message: string, code = 'factory_error') => ({ code, message });

function taskSummaryOf(run: RunRecord, version: number): FactoryTaskSummary {
  const factory = run.factory!;
  return {
    taskId: run.id,
    key: factory.key,
    title: run.title,
    category: factory.category,
    priority: factory.priority,
    lifecycle: factory.lifecycle,
    status: run.status,
    waitReason: typeof run.queueWaitReason === 'string' ? run.queueWaitReason : undefined,
    repairAttemptCount: factory.repairAttemptCount,
    createdAt: run.createdAt,
    notBefore: factory.notBefore ?? undefined,
    publishMode: factory.publishMode,
    pullRequestUrl: run.pullRequestUrl ?? undefined,
    version,
  };
}

function factoryRuns(project: ProjectContext): RunRecord[] {
  return project.store.listRuns().filter((r) => r.factory !== undefined);
}

function stateOf(project: ProjectContext): FactoryStateStore {
  // Routes treat a corrupt factory state as 409 for mutations and read-only for
  // listings — never a crash, never a silent reset (spec §7).
  return FactoryStateStore.open(project.dataDir);
}

/** Project-scoped family: the task pool of one project. */
export function factoryProjectRoutes() {
  return new Hono<ProjectApiEnv>()

    .get('/factory/tasks', queryZodValidator(factoryTasksQuerySchema), (c) => {
      const project = c.get('project');
      const query = c.req.valid('query');
      const state = stateOf(project);
      const rows = factoryRuns(project)
        .filter((r) => (!query.lifecycle || r.factory?.lifecycle === query.lifecycle)
          && (!query.category || r.factory?.category === query.category))
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
      const tasks = rows
        .slice(query.offset, query.offset + query.limit)
        .map((r) => taskSummaryOf(r, state.task(r.factory!.key)?.version ?? 1));
      const body: FactoryTasksResponse = { tasks, total: rows.length };
      return c.json(body);
    })

    .post('/factory/tasks', jsonZodValidator(factoryTaskInputSchema), async (c) => {
      const project = c.get('project');
      const input = c.req.valid('json');
      // spec §12: creating a task REQUIRES an Idempotency-Key. The header is the
      // wire contract; the body key (required for batch import) fills in when a
      // client sends only one of the two.
      const headerKey = c.req.header('idempotency-key');
      if (headerKey && input.key && headerKey !== input.key) {
        return c.json(err('Idempotency-Key header does not match the body key', 'key_mismatch'), 400);
      }
      const key = headerKey ?? input.key;
      if (!key) return c.json(err('missing Idempotency-Key header (or body key)', 'key_required'), 400);
      const body: FactoryImportResponse = await importFactoryTasks(
        { root: project.root, dataDir: project.dataDir, manager: project.manager, store: project.store },
        { tasks: [{ ...input, key }] },
        { now: new Date() },
      );
      const first = body.items[0];
      if (first?.status === 'error') {
        const status = first.code === 'key_conflict' ? 409 : 400;
        return c.json(err(first.message, first.code), status);
      }
      if (first?.status === 'duplicate') return c.json({ taskId: first.taskId, key, duplicated: true }, 200);
      return c.json({ taskId: (first as { taskId?: string })?.taskId ?? null, key, duplicated: false }, 201);
    })

    .post('/factory/tasks/import', jsonZodValidator(factoryImportBodySchema), async (c) => {
      const project = c.get('project');
      return c.json(
        await importFactoryTasks(
          { root: project.root, dataDir: project.dataDir, manager: project.manager, store: project.store },
          c.req.valid('json'),
          { now: new Date() },
        ),
      );
    })

    .patch('/factory/tasks/:taskId', jsonZodValidator(factoryTaskPatchSchema), (c) => {
      const project = c.get('project');
      const run = project.store.getRun(c.req.param('taskId'));
      const factory = run?.factory;
      if (!run || !factory) return c.json(err('no such factory task', 'not_found'), 404);
      if (factory.lifecycle !== 'queued' && factory.lifecycle !== 'needs_spec') {
        return c.json(err(`task already claimed (lifecycle ${factory.lifecycle}) — only queued tasks are editable`, 'claimed'), 409);
      }
      let state: FactoryStateStore;
      try {
        state = stateOf(project);
      } catch {
        return c.json(err('factory state unavailable', 'state_corrupt'), 409);
      }
      const entry = state.task(factory.key);
      const expected = c.req.valid('json').expectedVersion;
      const version = entry?.version ?? 1;
      if (expected !== version) return c.json(err(`version conflict: expected ${expected}, current ${version}`, 'version_conflict'), 409);
      const patch = c.req.valid('json');
      const nextFactory: FactoryStateShape = {
        ...factory,
        priority: patch.priority ?? factory.priority,
        dependsOn: patch.dependsOn ?? factory.dependsOn,
        dependencyMode: patch.dependencyMode ?? factory.dependencyMode,
        notBefore: patch.notBefore !== undefined ? (patch.notBefore ?? null) : factory.notBefore,
        timeoutSeconds: patch.timeoutSeconds ?? factory.timeoutSeconds,
        maxRepairAttempts: patch.maxRepairAttempts ?? factory.maxRepairAttempts,
        publishMode: patch.publishMode ?? factory.publishMode,
      };
      project.store.updateRun(run.id, { factory: nextFactory });
      // Editing the brief re-folds the task text so the agent sees the edit; only while queued.
      if (patch.title || patch.description || patch.scope || patch.acceptanceCriteria) {
        project.store.updateRun(run.id, {
          task: composeBrief({ title: patch.title ?? titleOf(run.task), description: patch.description ?? descriptionOf(run.task), scope: patch.scope ?? [], acceptanceCriteria: patch.acceptanceCriteria ?? [] }),
        });
      }
      if (entry) state.updateTask(factory.key, { version: version + 1, lifecycle: nextFactory.lifecycle });
      project.store.appendEvent(run.id, { type: 'factory', edited: true, version: version + 1 });
      return c.json({ taskId: run.id, version: version + 1 });
    })

    .post('/factory/tasks/:taskId/actions', jsonZodValidator(factoryTaskActionSchema), async (c) => {
      const project = c.get('project');
      const run = project.store.getRun(c.req.param('taskId'));
      const factory = run?.factory;
      if (!run || !factory) return c.json(err('no such factory task', 'not_found'), 404);
      const action = c.req.valid('json');
      try {
        switch (action.action) {
          case 'pause': {
            if (run.status !== 'queued') return c.json(err('only a queued task can be paused', 'invalid_state'), 409);
            moveLifecycle(project.store, run.id, factory, 'waiting', { reason: 'paused by user', note: 'task pause is a scheduling gate, not a failure' });
            return c.json({ paused: true });
          }
          case 'resume': {
            if (factory.lifecycle !== 'waiting' && factory.lifecycle !== 'blocked') {
              return c.json(err(`cannot resume from ${factory.lifecycle}`, 'invalid_state'), 409);
            }
            moveLifecycle(project.store, run.id, factory, 'queued', { note: 'resumed by user' });
            return c.json({ resumed: true });
          }
          case 'cancel': {
            // Terminal intent (spec §8): restart must NOT auto-recover it.
            moveLifecycle(project.store, run.id, factory, 'cancelled', { note: 'cancelled by user' });
            if (run.status === 'queued' || run.status === 'running' || run.status === 'waiting') {
              project.manager.cancel(run.id);
            }
            return c.json({ cancelled: true });
          }
          case 'retry': {
            if (factory.lifecycle !== 'failed' && factory.lifecycle !== 'blocked') {
              return c.json(err(`cannot retry from ${factory.lifecycle}`, 'invalid_state'), 409);
            }
            moveLifecycle(project.store, run.id, factory, 'queued', { note: 'retry requested' });
            project.manager.promote(run.id);
            return c.json({ retried: true });
          }
          case 'publish': {
            // Idempotent publish chain (spec §11.3): the durable intent lives in
            // the factory state; createDraftPr (upstream) pushes without force
            // and ADOPTS an existing PR for the head instead of duplicating.
            const outcome = await publishFactoryTask({
              repoRoot: project.root,
              dataDir: project.dataDir,
              store: project.store,
              manager: project.manager,
              taskId: run.id,
              draft: action.draft !== false,
            });
            if (outcome.ok) return c.json({ published: true, status: outcome.status, prUrl: outcome.prUrl ?? null });
            return c.json(err(outcome.error ?? 'publish failed', `publish_${outcome.status}`), outcome.status === 'blocked' ? 409 : 502);
          }
        }
      } catch (e) {
        return c.json(err(String((e as Error)?.message ?? e), 'action_failed'), 409);
      }
    })

    .get('/factory/tasks/:taskId/report', (c) => {
      const project = c.get('project');
      const run = project.store.getRun(c.req.param('taskId'));
      if (!run?.factory) return c.json(err('no such factory task', 'not_found'), 404);
      // The settled report lives in the run's artifacts dir (spec §15); an
      // unfinished run reports its live facts instead of a fabricated verdict.
      const reportPath = join(project.dataDir, 'artifacts', run.id, 'result.md');
      const resultMd = existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : null;
      return c.json({
        taskId: run.id,
        lifecycle: run.factory.lifecycle,
        status: run.status,
        diffStat: run.diffStat ?? null,
        baseCommit: run.factory.baseCommit,
        branch: run.branch ?? null,
        pullRequestUrl: run.pullRequestUrl ?? null,
        error: run.error ?? null,
        resultMd,
      });
    });
}

/** Workspace-scoped family: pool status, global pause/stop, usage. Single-mount. */
export function factoryWorkspaceRoutes(deps: FactoryApiDeps) {
  const factoryProjects = (): FactoryProjectHandle[] =>
    deps.projects().map((p) => ({ id: p.id, root: p.root, dataDir: p.dataDir, manager: p.manager, store: p.store }));

  return new Hono()

    .get('/factory/status', (c) => {
      const controls = loadFactoryControls(deps.homeDir);
      const counts = { running: 0, queued: 0, waiting: 0, blocked: 0, reviewReady: 0 };
      let activeTaskId: string | undefined;
      for (const project of deps.projects()) {
        reconcileProject(factoryProjectHandleOf(project), new Date());
        for (const run of factoryRuns(project)) {
          const f = run.factory!;
          switch (f.lifecycle) {
            case 'running': case 'preparing': case 'verifying': case 'repairing': case 'reviewing': case 'publishing':
              counts.running += 1;
              activeTaskId = activeTaskId ?? run.id;
              break;
            case 'queued': case 'needs_spec': case 'interrupted': counts.queued += 1; break;
            case 'waiting': counts.waiting += 1; break;
            case 'blocked': counts.blocked += 1; break;
            case 'review_ready': case 'pr_ready': counts.reviewReady += 1; break;
            default: break;
          }
        }
      }
      const holds = new AgentUsageHolds().active();
      const body: FactoryStatus = {
        paused: controls.paused,
        stopped: controls.stopped,
        concurrency: 1,
        activeTaskId,
        counts,
        accounts: holds.map((h) => ({ account: h.account, heldUntil: h.until })),
        diskFreeBytes: null,
        dailyBudget: {
          startedToday: controls.startedToday,
          maxNewTasksPerDay: controls.maxNewTasksPerDay,
          timeZone: 'Asia/Shanghai',
        },
      };
      return c.json(body);
    })

    .post('/factory/pause', jsonZodValidator(factoryControlActionSchema), (c) => {
      const { reason } = c.req.valid('json');
      setPaused(deps.homeDir, true, reason);
      return c.json({ paused: true });
    })

    .post('/factory/stop', jsonZodValidator(factoryControlActionSchema), (c) => {
      const { reason } = c.req.valid('json');
      // M1 records the stop intent (no new dispatch, survives restart). The M4
      // hard stop adds the 10-second process-tree kill; claiming more here
      // would be a lie (spec: 报告区分已实现、已测试、跳过和阻塞).
      setStopped(deps.homeDir, true, reason);
      return c.json({ stopped: true, note: 'process-tree termination arrives in M4; no new tasks will start' });
    })

    .post('/factory/resume', jsonZodValidator(factoryControlActionSchema), (c) => {
      setStopped(deps.homeDir, false);
      setPaused(deps.homeDir, false);
      return c.json({ resumed: true, dispatchAllowed: dispatchAllowed(loadFactoryControls(deps.homeDir)).ok });
    })

    .get('/factory/usage', (c) => {
      const byTask: FactoryUsageResponse['byTask'] = [];
      let reportedInput: number | null = null;
      let reportedOutput: number | null = null;
      for (const project of deps.projects()) {
        for (const run of factoryRuns(project)) {
          const ran = (run.tokensUsed ?? 0) > 0;
          const usage = {
            reportedInputTokens: ran ? null : null, // per-direction splits are not persisted upstream yet
            reportedOutputTokens: null,
            reportedCachedTokens: null,
            reportedCredits: null,
            estimatedTokens: ran ? run.tokensUsed : null,
            usageSource: ran ? ('estimated' as const) : ('unknown' as const),
            confidence: ran ? ('partial' as const) : ('unknown' as const),
          };
          byTask.push({ taskId: run.id, usage });
          if (ran) reportedOutput = (reportedOutput ?? 0); // totals stay unknown until M5 splits arrive
          void reportedInput;
        }
      }
      const anyEstimate = byTask.some((t) => t.usage.usageSource === 'estimated');
      const body: FactoryUsageResponse = {
        totals: {
          reportedInputTokens: null,
          reportedOutputTokens: null,
          reportedCachedTokens: null,
          reportedCredits: null,
          estimatedTokens: anyEstimate ? byTask.reduce((sum, t) => sum + (t.usage.estimatedTokens ?? 0), 0) : null,
          usageSource: anyEstimate ? 'estimated' : 'unknown',
          confidence: anyEstimate ? 'partial' : 'unknown',
        },
        byTask,
      };
      return c.json(body);
    });
}

function factoryProjectHandleOf(project: ProjectContext): FactoryProjectHandle {
  return { id: project.id, root: project.root, dataDir: project.dataDir, manager: project.manager, store: project.store };
}

function titleOf(taskText: string): string {
  return taskText.split('\n', 1)[0] ?? '';
}

function descriptionOf(taskText: string): string {
  const lines = taskText.split('\n');
  const cut = lines.findIndex((l) => l.startsWith('## '));
  return (cut > 1 ? lines.slice(1, cut) : lines.slice(1)).join('\n').trim();
}

function composeBrief(input: { title: string; description: string; scope: string[]; acceptanceCriteria: string[] }): string {
  const lines = [input.title, '', input.description];
  if (input.scope.length > 0) {
    lines.push('', '## 允许触碰的范围（scope）');
    for (const s of input.scope) lines.push(`- ${s}`);
  }
  lines.push('', '## 验收条件');
  if (input.acceptanceCriteria.length === 0) lines.push('-（缺失：本任务在补齐可验证的验收条件前不会执行）');
  else for (const a of input.acceptanceCriteria) lines.push(`- ${a}`);
  return lines.join('\n');
}
