import type { FactoryPublishIntent } from './state.ts';
import { FactoryState } from './state.ts';
import { createDraftPr, resolvePrTarget } from '../server/forge/github.ts';
import { readHandoff } from '../handoff.ts';
import type { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';

/**
 * Idempotent factory publish (spec docs/CEZAR_GLM_DEVELOPMENT_SPEC.md §11.3).
 *
 * The durable intent lives in the project's factory state
 * (`publishIntents[taskId]`): {host, owner, repo, headBranch, baseBranch,
 * state, prUrl, attempts}. The actual push + `gh pr create` reuse the UPSTREAM
 * seam (`createDraftPr`) — it already pushes without force, resolves remotes
 * through `resolveTaskRemotes` (never by remote name alone), adopts an
 * existing open PR for the head instead of creating a second one, and never
 * throws. What the upstream route does NOT have — the durable intent — is the
 * factory's addition: a response lost mid-publish is reconciled on the next
 * attempt by consulting the intent and re-adopting, never by blind retry (A12).
 *
 * Publish intent state machine:
 *   intended → pushed → created(prUrl)
 *        \→ blocked / failed (attempts++) — a later action retries from the intent
 */

export interface PublishOutcome {
  ok: boolean
  status: 'created' | 'adopted' | 'failed' | 'blocked'
  prUrl?: string
  error?: string
}

export async function publishFactoryTask(
  input: {
    repoRoot: string
    dataDir: string
    store: RunStore
    manager: RunManager
    taskId: string
    draft?: boolean
  },
  now = new Date(),
): Promise<PublishOutcome> {
  const run = input.store.getRun(input.taskId)
  const factory = run?.factory
  if (!run || !factory) return { ok: false, status: 'failed', error: 'no such factory task' }
  const state = FactoryState.open(input.dataDir)
  const existing = state.publishIntent(input.taskId)

  // An already-created PR is CLAIMED, never re-created (A12: no duplicate PR) —
  // this outranks the branch guard: a cleaned-up worktree must not turn a
  // recorded PR into a second create attempt.
  if (existing?.state === 'created' && existing.prUrl) {
    return { ok: true, status: 'adopted', prUrl: existing.prUrl }
  }
  if (!run.branch || !run.worktreePath) {
    return { ok: false, status: 'blocked', error: 'the run has no branch/worktree to publish (it never started or ran in place)' }
  }

  const attempt = (existing?.attempts ?? 0) + 1
  // The intent is persisted BEFORE the push (spec §7: 状态先落盘再副作用).
  state.setPublishIntent(
    {
      taskId: input.taskId,
      host: existing?.host ?? '',
      owner: existing?.owner ?? '',
      repo: existing?.repo ?? '',
      headBranch: run.branch,
      baseBranch: existing?.baseBranch ?? run.baseBranch ?? '',
      state: 'intended',
      prUrl: existing?.prUrl,
      attempts: attempt,
    },
    now.toISOString(),
  )

  const outcome = await createDraftPr({
    repoRoot: input.repoRoot,
    run,
    handoffText: readHandoff(input.dataDir, input.taskId) ?? '',
    draft: input.draft ?? true,
  })

  // Enrich the intent with the resolved target so the audit answers "where did
  // this go" — resolvePrTarget is the SAME resolver createDraftPr uses (spec
  // §11.3: 禁止仅按 remote 名字猜目标).
  let host = existing?.host ?? ''
  let owner = existing?.owner ?? ''
  let repo = existing?.repo ?? ''
  let baseBranch = existing?.baseBranch ?? run.baseBranch ?? ''
  try {
    const target = await resolvePrTarget(run)
    if (target?.repo) {
      const parts = target.repo.split('/')
      host = parts[0] ?? host
      owner = parts[1] ?? owner
      repo = parts[2] ?? repo
    }
    if (target?.base) baseBranch = target.base
  } catch {
    /* remotes best-effort — createDraftPr resolved its own target */
  }

  if (outcome.ok) {
    state.setPublishIntent(
      {
        taskId: input.taskId,
        host,
        owner,
        repo,
        headBranch: run.branch,
        baseBranch,
        state: 'created',
        prUrl: outcome.url,
        attempts: attempt,
      },
      now.toISOString(),
    )
    input.store.appendEvent(input.taskId, { type: 'factory', published: true, prUrl: outcome.url, adopted: outcome.dryRun ? false : undefined })
    return { ok: true, status: 'created', prUrl: outcome.url }
  }

  // Push divergence and other refusals BLOCK (a human decides); transient gh
  // failures stay retryable. createDraftPr never throws and maps errors to
  // one-liners — we keep its wording, redacted upstream already.
  const blocked = /diverg|non-fast-forward|rejected/i.test(outcome.error ?? '')
  state.setPublishIntent(
    {
      taskId: input.taskId,
      host,
      owner,
      repo,
      headBranch: run.branch,
      baseBranch,
      state: blocked ? 'blocked' : 'failed',
      prUrl: existing?.prUrl,
      attempts: attempt,
    },
    now.toISOString(),
  )
  input.store.appendEvent(input.taskId, { type: 'factory', published: false, error: (outcome.error ?? 'unknown publish failure').slice(0, 300) })
  return { ok: false, status: blocked ? 'blocked' : 'failed', error: outcome.error }
}
