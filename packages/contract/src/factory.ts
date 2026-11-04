import { z } from 'zod';

/**
 * The FACTORY namespace of `/api/v1` — the Cezar-GLM local task-pool layer
 * (spec `docs/CEZAR_GLM_DEVELOPMENT_SPEC.md` §7/§12), an additive extension on
 * top of the runs family. A factory task IS a run: creation routes build a run
 * through `POST /runs` internals and the `factory` object below hangs off the
 * run record as an OPTIONAL field, so records written by older cezar versions
 * (no `factory`) keep parsing and factory-less runs keep rendering.
 *
 * Naming: the spec's "taskId" is the run id everywhere on the wire; the
 * caller-stable identity is `key` (the idempotency key), which is what
 * `dependsOn` entries and import dedupe reference.
 */

// ---- enums --------------------------------------------------------------------------------

/** Software development / traffic site / weather research (spec §7). */
export const factoryCategorySchema = z.enum(['software', 'traffic', 'weather']);
export type FactoryCategory = z.infer<typeof factoryCategorySchema>;

/** Fine-grained stage, kept BESIDE the run status (never replacing it) — spec §8. */
export const factoryLifecycleSchema = z.enum([
  'needs_spec',
  'queued',
  'preparing',
  'running',
  'verifying',
  'repairing',
  'reviewing',
  'waiting',
  'interrupted',
  'review_ready',
  'publishing',
  'pr_ready',
  'accepted',
  'blocked',
  'failed',
  'cancelled',
]);
export type FactoryLifecycle = z.infer<typeof factoryLifecycleSchema>;

/** What a dependency must reach before this task may start (spec §8). */
export const factoryDependencyModeSchema = z.enum(['review_ready', 'merged']);
export type FactoryDependencyMode = z.infer<typeof factoryDependencyModeSchema>;

/** Where a finished task goes: stay local for review, or auto-push + draft PR (spec §1.6). */
export const factoryPublishModeSchema = z.enum(['local_review', 'draft_pr']);
export type FactoryPublishMode = z.infer<typeof factoryPublishModeSchema>;

// ---- the record extension ------------------------------------------------------------------

/**
 * The `factory` object on a RunRecord. Every field is optional at the RECORD
 * level (old files have no `factory` at all); inside the object the fields the
 * spec fixes are required so a half-written object fails loudly instead of
 * silently rescheduling.
 */
export const factoryStateSchema = z.object({
  schemaVersion: z.literal(1),
  category: factoryCategorySchema,
  /** 0 highest … 3 lowest; user/trusted-service controlled only (spec §7). */
  priority: z.number().int().min(0).max(3),
  lifecycle: factoryLifecycleSchema,
  /** Task keys (`idempotencyKey`s) this task waits for. */
  dependsOn: z.array(z.string().min(1)).max(20),
  dependencyMode: factoryDependencyModeSchema,
  estimatedMinutes: z.number().int().min(1).max(24 * 60).nullable(),
  /** Per-task wall-clock budget, default 3600 (spec §9.2); enforced server-side. */
  timeoutSeconds: z.number().int().min(60).max(24 * 3600),
  maxRepairAttempts: z.number().int().min(0).max(2),
  networkRetryCount: z.number().int().min(0).max(50),
  repairAttemptCount: z.number().int().min(0).max(50),
  interruptionCount: z.number().int().min(0).max(50),
  /** Earliest start (ISO); re-evaluated on wake — never trusted across sleep without a re-check. */
  notBefore: z.string().datetime().nullable(),
  blockedReason: z.string().max(500).nullable(),
  baseCommit: z.string().min(1).nullable(),
  checkpointId: z.string().min(1).nullable(),
  acceptanceProfileId: z.string().min(1).max(100),
  policyVersion: z.string().min(1).max(20),
  key: z.string().min(1).max(200),
  publishMode: factoryPublishModeSchema,
});
export type FactoryState = z.infer<typeof factoryStateSchema>;

// ---- task input ------------------------------------------------------------------------------

/** Task input (spec §7 "任务输入必须包含"). No verifiable goal ⇒ the import answers `needs_spec` and nothing runs. */
export const factoryTaskInputSchema = z.object({
  key: z.string().min(1).max(200),
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(32768),
  /** Pathspec-ish scope entries the task may touch; informational + review guard. */
  scope: z.array(z.string().min(1).max(500)).max(50),
  /** Empty is legal and lands the task in `needs_spec` (spec §7: 没有可验证目标时不能自动执行). */
  acceptanceCriteria: z.array(z.string().min(1).max(2000)).max(100),
  acceptanceProfileId: z.string().min(1).max(100),
  category: factoryCategorySchema.default('software'),
  priority: z.number().int().min(0).max(3).default(2),
  dependsOn: z.array(z.string().min(1).max(200)).max(20).default([]),
  dependencyMode: factoryDependencyModeSchema.default('review_ready'),
  estimatedMinutes: z.number().int().min(1).max(24 * 60).nullish(),
  timeoutSeconds: z.number().int().min(60).max(24 * 3600).default(3600),
  maxRepairAttempts: z.number().int().min(0).max(2).default(2),
  notBefore: z.string().datetime().nullish(),
  publishMode: factoryPublishModeSchema.default('local_review'),
});
export type FactoryTaskInput = z.infer<typeof factoryTaskInputSchema>;

/**
 * Batch import body (spec §7): at most 100 tasks, whole batch preflighted —
 * the server answers per-item errors instead of a partial create.
 */
export const factoryImportBodySchema = z.object({
  tasks: z.array(factoryTaskInputSchema).min(1).max(100),
});
export type FactoryImportBody = z.infer<typeof factoryImportBodySchema>;

/** One per-item import result. `status: 'created' | 'duplicate' | 'error'`. */
export const factoryImportResultItemSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('created'),
    key: z.string(),
    taskId: z.string(),
  }),
  z.object({
    status: z.literal('duplicate'),
    key: z.string(),
    taskId: z.string(),
  }),
  z.object({
    status: z.literal('error'),
    key: z.string().nullish(),
    code: z.string(),
    message: z.string(),
  }),
]);
export type FactoryImportResultItem = z.infer<typeof factoryImportResultItemSchema>;

/** Whole-batch preflight answer: 200 with per-item results when the batch is well-formed, 400 with item errors when the envelope itself is not. */
export const factoryImportResponseSchema = z.object({
  created: z.number().int().min(0),
  duplicates: z.number().int().min(0),
  errors: z.array(factoryImportResultItemSchema),
  items: z.array(factoryImportResultItemSchema),
});
export type FactoryImportResponse = z.infer<typeof factoryImportResponseSchema>;

// ---- task edit / actions ---------------------------------------------------------------------

/** PATCH body (spec §12): unclaimed fields only, guarded by optimistic version. */
export const factoryTaskPatchSchema = z.object({
  expectedVersion: z.number().int().min(1),
  title: z.string().min(1).max(200).optional(),
  description: z.string().min(1).max(32768).optional(),
  scope: z.array(z.string().min(1).max(500)).max(50).optional(),
  acceptanceCriteria: z.array(z.string().min(1).max(2000)).min(1).optional(),
  priority: z.number().int().min(0).max(3).optional(),
  dependsOn: z.array(z.string().min(1).max(200)).max(20).optional(),
  dependencyMode: factoryDependencyModeSchema.optional(),
  notBefore: z.string().datetime().nullish(),
  timeoutSeconds: z.number().int().min(60).max(24 * 3600).optional(),
  maxRepairAttempts: z.number().int().min(0).max(2).optional(),
  publishMode: factoryPublishModeSchema.optional(),
});
export type FactoryTaskPatch = z.infer<typeof factoryTaskPatchSchema>;

/** POST /tasks/:taskId/actions body. */
export const factoryTaskActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('pause') }),
  z.object({ action: z.literal('resume') }),
  z.object({ action: z.literal('cancel') }),
  z.object({ action: z.literal('retry') }),
  z.object({ action: z.literal('publish'), draft: z.boolean().default(true) }),
]);
export type FactoryTaskAction = z.infer<typeof factoryTaskActionSchema>;

/** One task row of the project task list. */
export const factoryTaskSummarySchema = z.object({
  taskId: z.string(),
  key: z.string(),
  title: z.string(),
  category: factoryCategorySchema,
  priority: z.number().int().min(0).max(3),
  lifecycle: factoryLifecycleSchema,
  /** Upstream run status beside the factory lifecycle (spec §8 "保留上游状态作为兼容展示"). */
  status: z.enum(['queued', 'running', 'waiting', 'review', 'done', 'failed', 'cancelled']),
  waitReason: z.string().nullish(),
  repairAttemptCount: z.number().int().min(0),
  createdAt: z.string(),
  notBefore: z.string().datetime().nullish(),
  publishMode: factoryPublishModeSchema,
  pullRequestUrl: z.string().nullish(),
  version: z.number().int().min(1),
});
export type FactoryTaskSummary = z.infer<typeof factoryTaskSummarySchema>;

/** `GET …/factory/tasks` query. */
export const factoryTasksQuerySchema = z.object({
  lifecycle: factoryLifecycleSchema.optional(),
  category: factoryCategorySchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type FactoryTasksQuery = z.infer<typeof factoryTasksQuerySchema>;

export const factoryTasksResponseSchema = z.object({
  tasks: z.array(factoryTaskSummarySchema),
  total: z.number().int().min(0),
});
export type FactoryTasksResponse = z.infer<typeof factoryTasksResponseSchema>;

// ---- workspace-level status / usage ------------------------------------------------------------

/** Aggregate counters for the overview page (spec §12). */
export const factoryStatusSchema = z.object({
  paused: z.boolean(),
  stopped: z.boolean(),
  concurrency: z.number().int().min(1),
  activeTaskId: z.string().nullish(),
  counts: z.object({
    running: z.number().int().min(0),
    queued: z.number().int().min(0),
    waiting: z.number().int().min(0),
    blocked: z.number().int().min(0),
    reviewReady: z.number().int().min(0),
  }),
  accounts: z.array(
    z.object({
      account: z.string(),
      heldUntil: z.string().datetime().nullish(),
    }),
  ),
  diskFreeBytes: z.number().nullish(),
  dailyBudget: z.object({
    startedToday: z.number().int().min(0),
    maxNewTasksPerDay: z.number().int().min(1),
    /** Local-statistics day boundary is Asia/Shanghai (spec §9.2). */
    timeZone: z.literal('Asia/Shanghai'),
  }),
});
export type FactoryStatus = z.infer<typeof factoryStatusSchema>;

export const factoryControlActionSchema = z.object({
  /** Optional reason recorded on the control state (audit only). */
  reason: z.string().max(500).optional(),
});
export type FactoryControlAction = z.infer<typeof factoryControlActionSchema>;

// ---- usage -------------------------------------------------------------------------------------

/**
 * Usage numbers with explicit provenance (spec §6.3): a missing value is
 * `null`/`'unknown'` — NEVER 0 and NEVER a fabricated remainder.
 */
export const factoryUsageSchema = z.object({
  reportedInputTokens: z.number().int().min(0).nullable(),
  reportedOutputTokens: z.number().int().min(0).nullable(),
  reportedCachedTokens: z.number().int().min(0).nullable(),
  reportedCredits: z.number().nullable(),
  estimatedTokens: z.number().int().min(0).nullable(),
  usageSource: z.enum(['reported', 'estimated', 'unknown']),
  confidence: z.enum(['exact', 'partial', 'unknown']),
});
export type FactoryUsage = z.infer<typeof factoryUsageSchema>;

export const factoryUsageResponseSchema = z.object({
  totals: factoryUsageSchema,
  byTask: z.array(
    z.object({
      taskId: z.string(),
      usage: factoryUsageSchema,
    }),
  ),
});
export type FactoryUsageResponse = z.infer<typeof factoryUsageResponseSchema>;

// ---- errors ------------------------------------------------------------------------------------

/**
 * Factory namespace error shape (spec §12). Deliberately narrower than the
 * legacy `{error}` body: no底层环境、密钥 or raw vendor text reaches the wire.
 */
export const factoryErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean().default(false),
  retryAt: z.string().datetime().nullish(),
  requestId: z.string().max(100).optional(),
});
export type FactoryError = z.infer<typeof factoryErrorSchema>;
