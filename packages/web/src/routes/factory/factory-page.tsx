import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { PauseIcon, PlayIcon, SquareIcon, RefreshCwIcon, SendIcon, BanIcon } from 'lucide-react'
import * as React from 'react'

import {
  getFactoryReport,
  getFactoryStatus,
  getFactoryTasks,
  postFactoryControl,
  postFactoryTaskAction,
} from '@/api/factory'
import { Button } from '@/components/ui/button'
import { CenteredState } from '@/components/centered-state'
import { Pill } from '@/components/pill'
import { toast } from '@/components/ui/toaster'

/**
 * The Cezar-GLM factory task pool page (spec docs/CEZAR_GLM_DEVELOPMENT_SPEC.md
 * §12 必须增加的页面能力, scoped to one project). Counts, budget and controls at
 * the top, the task table below. Usage/额度 renders 未知 as 未知 — never a
 * fabricated remainder bar (spec §12, A09).
 */

export function FactoryPage(): React.ReactElement {
  const queryClient = useQueryClient()

  const status = useQuery({ queryKey: ['factory', 'status'], queryFn: ({ signal }) => getFactoryStatus({ signal }), refetchInterval: 15_000 })
  const tasks = useQuery({
    queryKey: ['factory', 'tasks'],
    queryFn: ({ signal }) => getFactoryTasks({ limit: 100 }, { signal }),
    refetchInterval: 15_000,
  })

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['factory'] })
  }

  const control = useMutation({
    mutationFn: ({ action, reason }: { action: 'pause' | 'stop' | 'resume'; reason?: string }) => postFactoryControl(action, reason),
    onSuccess: (_data, variables) => {
      toast(`${controlLabel(variables.action)}完成`)
      invalidate()
    },
    onError: (err) => toast(`操作失败：${String(err)}`),
  })

  const taskAction = useMutation({
    mutationFn: ({ taskId, action }: { taskId: string; action: 'pause' | 'resume' | 'cancel' | 'retry' | 'publish' }) =>
      postFactoryTaskAction(taskId, { action } as never),
    onSuccess: () => invalidate(),
    onError: (err) => toast(`操作失败：${String(err)}`),
  })

  if (status.isPending || tasks.isPending) return <CenteredState icon={<RefreshCwIcon className="size-5" />} title="任务池加载中…" />
  if (status.isError || tasks.isError || !status.data || !tasks.data) {
    return <CenteredState icon={<BanIcon className="size-5" />} title="任务池不可用" subtitle={String(status.error ?? tasks.error)} />
  }

  const s = status.data
  const budgetPct = Math.min(100, Math.round((s.dailyBudget.startedToday / s.dailyBudget.maxNewTasksPerDay) * 100))

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6" data-testid="factory-page">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">任务池</h1>
          <p className="text-muted-foreground text-sm">
            本地任务池是调度事实来源；合并与部署始终由你决定（spec §1）。
          </p>
        </div>
        <div className="flex items-center gap-2">
          {s.paused || s.stopped ? (
            <Button size="sm" onClick={() => control.mutate({ action: 'resume' })} data-testid="factory-resume">
              <PlayIcon className="mr-1 size-4" /> 恢复调度
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={() => control.mutate({ action: 'pause', reason: 'paused from the cockpit' })} data-testid="factory-pause">
              <PauseIcon className="mr-1 size-4" /> 软暂停
            </Button>
          )}
          <Button
            size="sm"
            variant="danger-ghost"
            onClick={() => {
              if (globalThis.confirm('硬停止：终止当前任务进程树并停止领取（重启后保持停止）？')) {
                control.mutate({ action: 'stop', reason: 'hard stop from the cockpit' })
              }
            }}
            data-testid="factory-stop"
          >
            <SquareIcon className="mr-1 size-4" /> 硬停止
          </Button>
        </div>
      </header>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-5" data-testid="factory-counts">
        <CountPill label="运行中" value={s.counts.running} />
        <CountPill label="排队" value={s.counts.queued} />
        <CountPill label="等待" value={s.counts.waiting} />
        <CountPill label="阻塞" value={s.counts.blocked} />
        <CountPill label="待审核" value={s.counts.reviewReady} />
      </section>

      <section className="text-muted-foreground flex flex-wrap items-center gap-4 text-sm">
        <span>
          状态：
          <Pill dot={s.stopped ? 'danger' : s.paused ? 'pending' : 'success'}>{s.stopped ? '已硬停止' : s.paused ? '已暂停' : '运行'}</Pill>
        </span>
        <span>
          今日预算（Asia/Shanghai）：<strong className="text-foreground">{s.dailyBudget.startedToday}</strong> / {s.dailyBudget.maxNewTasksPerDay}
          <span className="ml-2 inline-block h-1.5 w-24 overflow-hidden rounded bg-muted align-middle">
            <span className="bg-primary block h-full" style={{ width: `${budgetPct}%` }} />
          </span>
        </span>
        {s.accounts.length > 0 && (
          <span>
            账户 hold：
            {s.accounts.map((a) => (
              <Pill key={a.account} dot="pending">
                {a.account}
                {a.heldUntil ? ` → ${new Date(a.heldUntil).toLocaleTimeString()}` : '（恢复时刻未知）'}
              </Pill>
            ))}
          </span>
        )}
        <span>磁盘余量：{s.diskFreeBytes == null ? '未知' : `${Math.round(s.diskFreeBytes / 2 ** 30)} GiB`}</span>
      </section>

      <TaskTable
        tasks={tasks.data.tasks}
        onAction={(taskId, action) => taskAction.mutate({ taskId, action })}
        pending={taskAction.isPending}
      />
    </div>
  )
}

function controlLabel(action: 'pause' | 'stop' | 'resume'): string {
  return action === 'pause' ? '软暂停' : action === 'stop' ? '硬停止' : '恢复调度'
}

function CountPill({ label, value }: { label: string; value: number }): React.ReactElement {
  return (
    <div className="bg-card rounded-md border p-3 text-center">
      <div className="text-2xl font-semibold" data-testid={`factory-count-${label}`}>
        {value}
      </div>
      <div className="text-muted-foreground text-xs">{label}</div>
    </div>
  )
}

const LIFECYCLE_LABEL: Record<string, string> = {
  needs_spec: '缺验收条件',
  queued: '排队',
  preparing: '准备',
  running: '执行',
  verifying: '检查',
  repairing: '修复',
  reviewing: '审查',
  waiting: '等待',
  interrupted: '已中断',
  review_ready: '待审核',
  publishing: '发布中',
  pr_ready: 'PR 就绪',
  accepted: '已验收',
  blocked: '阻塞',
  failed: '失败',
  cancelled: '已取消',
}

function TaskTable({
  tasks,
  onAction,
  pending,
}: {
  tasks: Awaited<ReturnType<typeof getFactoryTasks>>['tasks']
  onAction: (taskId: string, action: 'pause' | 'resume' | 'cancel' | 'retry' | 'publish') => void
  pending: boolean
}): React.ReactElement {
  const [expanded, setExpanded] = React.useState<string | null>(null)
  const report = useQuery({
    queryKey: ['factory', 'report', expanded],
    queryFn: ({ signal }) => getFactoryReport(expanded!, { signal }),
    enabled: expanded !== null,
  })

  if (tasks.length === 0) {
    return <CenteredState icon={<SendIcon className="size-5" />} title="任务池为空" subtitle="通过 API 导入任务（见 docs/IMPLEMENTATION_PLAN.md）后这里会出现任务列表。" />
  }

  return (
    <div className="bg-card overflow-hidden rounded-md border" data-testid="factory-task-table">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-muted-foreground text-left text-xs">
          <tr>
            <th className="px-3 py-2">任务</th>
            <th className="px-3 py-2">分类</th>
            <th className="px-3 py-2">优先级</th>
            <th className="px-3 py-2">阶段</th>
            <th className="px-3 py-2">修复</th>
            <th className="px-3 py-2 text-right">操作</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((t) => (
            <React.Fragment key={t.taskId}>
              <tr className="border-t" data-testid={`factory-row-${t.key}`}>
                <td className="px-3 py-2">
                  <button className="hover:underline" onClick={() => setExpanded(expanded === t.taskId ? null : t.taskId)}>
                    {t.title}
                  </button>
                  {t.waitReason ? <div className="text-muted-foreground text-xs">等待原因：{t.waitReason}</div> : null}
                </td>
                <td className="px-3 py-2">{t.category}</td>
                <td className="px-3 py-2">P{t.priority}</td>
                <td className="px-3 py-2">
                  <Pill dot={lifecycleTone(t.lifecycle)}>{LIFECYCLE_LABEL[t.lifecycle] ?? t.lifecycle}</Pill>
                  {t.pullRequestUrl ? (
                    <a className="ml-2 text-xs underline" href={t.pullRequestUrl} target="_blank" rel="noreferrer">
                      PR
                    </a>
                  ) : null}
                </td>
                <td className="px-3 py-2">{t.repairAttemptCount}</td>
                <td className="px-3 py-2 text-right">
                  <div className="inline-flex gap-1">
                    {t.lifecycle === 'queued' && (
                      <IconAction label="暂停" disabled={pending} onClick={() => onAction(t.taskId, 'pause')}>
                        <PauseIcon className="size-3.5" />
                      </IconAction>
                    )}
                    {(t.lifecycle === 'waiting' || t.lifecycle === 'blocked') && (
                      <IconAction label="恢复" disabled={pending} onClick={() => onAction(t.taskId, 'resume')}>
                        <PlayIcon className="size-3.5" />
                      </IconAction>
                    )}
                    {(t.lifecycle === 'failed' || t.lifecycle === 'blocked') && (
                      <IconAction label="重试" disabled={pending} onClick={() => onAction(t.taskId, 'retry')}>
                        <RefreshCwIcon className="size-3.5" />
                      </IconAction>
                    )}
                    {t.lifecycle === 'review_ready' && t.publishMode === 'draft_pr' && (
                      <IconAction label="发布 Draft PR" disabled={pending} onClick={() => onAction(t.taskId, 'publish')}>
                        <SendIcon className="size-3.5" />
                      </IconAction>
                    )}
                    {!['accepted', 'cancelled'].includes(t.lifecycle) && (
                      <IconAction label="取消" disabled={pending} onClick={() => onAction(t.taskId, 'cancel')}>
                        <BanIcon className="size-3.5" />
                      </IconAction>
                    )}
                  </div>
                </td>
              </tr>
              {expanded === t.taskId && (
                <tr className="bg-muted/30 border-t">
                  <td colSpan={6} className="px-6 py-4">
                    {report.isPending ? (
                      <span className="text-muted-foreground text-xs">报告加载中…</span>
                    ) : report.data?.resultMd ? (
                      <pre className="max-h-80 overflow-auto whitespace-pre-wrap text-xs">{report.data.resultMd}</pre>
                    ) : (
                      <span className="text-muted-foreground text-xs">
                        尚无 result.md（任务结束后生成，见任务页 Assets 标签）。
                      </span>
                    )}
                  </td>
                </tr>
              )}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function lifecycleTone(lifecycle: string): 'success' | 'pending' | 'danger' | 'neutral' {
  if (['review_ready', 'pr_ready', 'accepted'].includes(lifecycle)) return 'success'
  if (['blocked', 'failed', 'interrupted'].includes(lifecycle)) return 'danger'
  if (['waiting', 'needs_spec'].includes(lifecycle)) return 'pending'
  return 'neutral'
}

function IconAction({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.ReactElement {
  return (
    <Button size="icon" variant="ghost" title={label} aria-label={label} disabled={disabled} onClick={onClick} className="size-7">
      {children}
    </Button>
  )
}
