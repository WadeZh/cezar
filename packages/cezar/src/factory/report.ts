import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunRecord } from '../runs/store.ts';
import type { FactoryState } from '@open-mercato/cezar-contract';

/**
 * The factory result report (spec docs/CEZAR_GLM_DEVELOPMENT_SPEC.md §15).
 *
 * `result.md` is written into the run's OWN artifacts directory
 * (`<root>/.ai/cezar/artifacts/<runId>/`), where the cockpit's Assets tab
 * already renders markdown artifacts — the report surfaces in the console
 * without a second serving path. Facts only: every claim maps to a field on
 * the record; unverifiable things are LISTED as unverifiable, never phrased
 * as "should pass" (spec §15 无法验证的事项单列).
 */

export function resultMdOf(run: RunRecord, factory: FactoryState): string {
  const lines: string[] = [];
  const at = (label: string, value: string | number | null | undefined) => lines.push(`- ${label}: ${value ?? '未知'}`);

  lines.push(`# Factory 任务报告：${run.title}`);
  lines.push('');
  lines.push(`- 任务键（key）: \`${factory.key}\``);
  at('任务 ID', run.id);
  at('生命周期', `${factory.lifecycle}（上游状态: ${run.status}）`);
  at('分类 / 优先级', `${factory.category} / P${factory.priority}`);
  at('开始于', run.startedAt ?? null);
  at('结束于', run.finishedAt ?? null);
  lines.push('');

  lines.push('## 目标与验收');
  lines.push('');
  lines.push('<details><summary>原始任务正文</summary>');
  lines.push('');
  lines.push(run.task);
  lines.push('');
  lines.push('</details>');
  lines.push('');

  lines.push('## 检查证据');
  lines.push('');
  const checkSteps = (run.steps ?? []).filter((s) => s.kind === 'check');
  if (checkSteps.length === 0) {
    lines.push('- 本任务没有受信检查步骤（验收证据=Agent 自述，不构成通过 — 见 spec §8）');
  } else {
    for (const s of checkSteps) {
      lines.push(`### 检查步骤 \`${s.id}\``);
      lines.push('');
      lines.push(`- 状态: ${s.status}${s.retriesUsed ? `（修复重试 ${s.retriesUsed} 次）` : ''}`);
      if (s.error) lines.push(`- 错误: ${s.error.slice(0, 300)}`);
      lines.push('');
    }
  }
  lines.push('');

  lines.push('## 交付差异');
  lines.push('');
  at('分支', run.branch ?? null);
  at('基线分支', run.baseBranch ?? null);
  if (run.diffStat) {
    lines.push(`- 变更统计: +${run.diffStat.adds} −${run.diffStat.dels}，${run.diffStat.files} 个文件`);
  } else {
    lines.push('- 变更统计: 未知（差异尚未计算）');
  }
  lines.push('- 差异内容: 见任务页 Changes 标签（此处不内嵌，避免报告与事实脱节）');
  lines.push('');

  lines.push('## 执行器与用量');
  lines.push('');
  at('执行器（runner）', run.runner ?? null);
  at('模型', run.model ?? null);
  at('修复尝试', `${factory.repairAttemptCount} / 上限 ${factory.maxRepairAttempts}`);
  at('中断次数', factory.interruptionCount);
  at('Token 用量（估计）', run.tokensUsed ?? null);
  at('费用（供应方报告，USD）', run.costUsd ?? null);
  lines.push('- 用量来源: 估计（上游逐项 input/output/cache 拆分未持久化 — spec §6.3 缺失值填未知，不填 0）');
  lines.push('');

  lines.push('## 发布');
  lines.push('');
  at('发布模式', factory.publishMode);
  at('PR 链接', run.pullRequestUrl ?? '未创建（local_review 模式等待人工审查，或发布未启用）');
  lines.push('');

  if (run.error) {
    lines.push('## 失败原因');
    lines.push('');
    lines.push('```');
    lines.push(String(run.error).slice(0, 2000));
    lines.push('```');
    lines.push('');
  }

  lines.push('## 无法验证的事项');
  lines.push('');
  lines.push('- 验收条件的语义正确性：自动化检查只能证明检查命令退出码为 0，语义由人工审查确认');
  if (checkSteps.length === 0) lines.push('- 全部验收条件：本任务没有可执行检查，逐项人工验证前不视为完成');
  lines.push('');

  return lines.join('\n');
}

/** Write the report into the run's artifacts directory; best-effort (an unwritable dir degrades to no report). */
export function writeResultReport(dataDir: string, runId: string, markdown: string): string | undefined {
  try {
    const dir = join(dataDir, 'artifacts', runId);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'result.md');
    writeFileSync(path, markdown, 'utf8');
    return path;
  } catch {
    return undefined;
  }
}
