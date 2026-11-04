import type {
  FactoryControlAction,
  FactoryStatus,
  FactoryTaskAction,
  FactoryTaskInput,
  FactoryTasksQuery,
  FactoryTasksResponse,
  FactoryUsageResponse,
} from '@open-mercato/cezar-api-client'
import { cez } from './client'
import { queryScope } from '@open-mercato/cezar-api-client'

/**
 * The Cezar-GLM factory task pool API (spec docs/CEZAR_GLM_DEVELOPMENT_SPEC.md
 * §12) over the typed client. Usage numbers come back with explicit provenance
 * — the UI must render 未知 as 未知, never a fabricated remainder (spec §12).
 */

type ReadOptions = { signal?: AbortSignal }

export async function getFactoryStatus(opts?: ReadOptions): Promise<FactoryStatus> {
  const res = await cez.api.v1.factory.status.$get({}, init(opts))
  return (await res.json()) as FactoryStatus
}

export async function getFactoryUsage(opts?: ReadOptions): Promise<FactoryUsageResponse> {
  const res = await cez.api.v1.factory.usage.$get({}, init(opts))
  return (await res.json()) as FactoryUsageResponse
}

export interface FactoryControlResult {
  stopped?: boolean
  paused?: boolean
  resumed?: boolean
  dispatchAllowed?: boolean
  killed?: string[]
  uncertain?: Array<{ taskId: string; reason: string }>
  elapsedMs?: number
  note?: string
}

export async function postFactoryControl(action: 'pause' | 'stop' | 'resume', reason?: string): Promise<FactoryControlResult> {
  const body: FactoryControlAction = { reason: reason || undefined }
  const res =
    action === 'pause'
      ? await cez.api.v1.factory.pause.$post({ json: body })
      : action === 'stop'
        ? await cez.api.v1.factory.stop.$post({ json: body })
        : await cez.api.v1.factory.resume.$post({ json: body })
  return (await res.json()) as FactoryControlResult
}

export async function getFactoryTasks(query?: Partial<FactoryTasksQuery>, opts?: ReadOptions): Promise<FactoryTasksResponse> {
  const res = await cez.api.v1.p[':projectId'].factory.tasks.$get(
    {
      param: { projectId: queryScope() },
      query: {
        lifecycle: query?.lifecycle,
        category: query?.category,
        limit: query?.limit !== undefined ? String(query.limit) : undefined,
        offset: query?.offset !== undefined ? String(query.offset) : undefined,
      },
    },
    init(opts),
  )
  return (await res.json()) as FactoryTasksResponse
}

export async function createFactoryTask(input: Omit<FactoryTaskInput, 'key'> & { key?: string }): Promise<{ taskId: string | null; duplicated: boolean }> {
  // The server requires an Idempotency-Key: the UI mints one per submission,
  // so a double-click replays instead of creating twice (spec §12).
  const key = input.key ?? globalThis.crypto.randomUUID()
  const res = await cez.api.v1.p[':projectId'].factory.tasks.$post(
    { param: { projectId: queryScope() }, json: { ...input, key } },
    { headers: { 'Idempotency-Key': key } },
  )
  return (await res.json()) as { taskId: string | null; duplicated: boolean }
}

export interface FactoryImportResult {
  created: number
  duplicates: number
  errors: Array<{ key?: string | null; code: string; message: string }>
}

export async function importFactoryTasks(tasks: FactoryTaskInput[]): Promise<FactoryImportResult> {
  const res = await cez.api.v1.p[':projectId'].factory.tasks.import.$post({
    param: { projectId: queryScope() },
    json: { tasks },
  })
  return (await res.json()) as FactoryImportResult
}

export async function postFactoryTaskAction(taskId: string, action: FactoryTaskAction): Promise<Record<string, unknown>> {
  const res = await cez.api.v1.p[':projectId'].factory.tasks[':taskId'].actions.$post({
    param: { projectId: queryScope(), taskId },
    json: action,
  })
  return (await res.json()) as Record<string, unknown>
}

export async function getFactoryReport(taskId: string, opts?: ReadOptions): Promise<{ resultMd: string | null; status: string; lifecycle: string }> {
  const res = await cez.api.v1.p[':projectId'].factory.tasks[':taskId'].report.$get(
    { param: { projectId: queryScope(), taskId } },
    init(opts),
  )
  return (await res.json()) as { resultMd: string | null; status: string; lifecycle: string }
}

// ---- plumbing ----------------------------------------------------------------------

function init(opts?: ReadOptions): { init: { signal?: AbortSignal } } {
  // Same shape the shared client module uses: `hc` takes { init: { signal } }.
  return { init: { signal: opts?.signal } }
}
