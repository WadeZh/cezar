# UPSTREAM_AUDIT — Cezar 上游审计（M0）

- 审计对象：https://github.com/open-mercato/cezar （WadeZh fork 同步自上游）
- **基线 commit SHA：`71e2eb181dda0839c981aa3532daa69d8fab021c`**（2026-11-04，fix(cockpit): group a task's PR chips behind +N in the sidebar and palette #1748）
- 审计日期：2026-11-05
- 审计方式：全量读取 AGENTS.md / AGENT_PROTOCOL.md / BACKWARD_COMPATIBILITY.md（前 120 行 + 结构）+ 三个并行深度代码探查（存储与调度、执行器、API/GitHub/工作流）。所有结论附 `文件:行` 依据；"缺口"均指对照 `docs/CEZAR_GLM_DEVELOPMENT_SPEC.md`。

---

## 1. 真实技术栈（已验证）

| 项 | 实际情况 | 依据 |
|---|---|---|
| 语言/运行时 | TypeScript strict ESM，Node >=20 | 根 `package.json` engines |
| 后端 | Hono + Zod（请求/响应全部 zod schema，位于 `packages/contract`），SSE + WebSocket 订阅总线 | `packages/cezar/src/server/server.ts`；AGENTS.md §HTTP API |
| 前端 | React 19 + Vite + Tailwind v4 + shadcn/ui，构建产物进 `packages/cezar/web/dist` | AGENTS.md §Repository layout |
| 持久化 | 纯文件：`.ai/cezar/runs.json`（索引）+ `.ai/cezar/runs/<id>.ndjson`（事件）+ `~/.cezar/config.json`（工作区注册表）。无数据库 | `runs/store.ts:155-534, 2334-2419` |
| 包结构 | 4 个 npm workspace：`contract`、`api-client`、`cezar`（服务+CLI）、`web` | 根 `package.json` workspaces |
| 测试 | vitest（`npm test`）+ node:test 快速单测（`test:unit`）+ 打包 e2e（`test:package`）+ 浏览器 e2e（`test:e2e`，独立命令） | AGENTS.md §Validation |
| 规格验证门 | typecheck（含 contract-parity 双向断言、typed-bodies、route-parity、bc-route-inventory、versioned-surface） | `server/contract-parity.*.test.ts` 等 |

## 2. 真实入口

- **CLI**：`packages/cezar/src/index.ts`。`serve` 为默认命令；`run <task>` 无服务执行工作流（review 按成功退出码 0）；`task create|report|list|tree`（dispatch）；`automation <…>`；`runs list`。用 `node:util parseArgs`，无 CLI 框架。
- **服务**：`startServer`（同入口）绑定 **127.0.0.1**，默认端口 4321；Hono app 在 `createApp`（`server/server.ts:1355`），所有路由 `/api/v1` 前缀，项目级路由三重挂载（`/api/v1/…`、`/api/v1/p/:projectId/…`，`default` 保留别名）。
- **执行器工厂**：`createRunner(backend)`（`core/runner-factory.ts:30-31`）。后端枚举唯一来源是 contract 的 `runnerSchema`（`packages/contract/src/health.ts`）。
- **工作流加载**：`loadWorkflows(repoRoot)`（`workflows/load.ts:27`）读 `.ai/cezar/workflows/*.yaml`，文件优先于内建。

## 3. 已有能力（对照 spec 第 2 节表格逐项核实）

### 3.1 存储
- `RunRecord`（`runs/store.ts:155-534`）：约 60 个字段，全部 zod 校验；新字段必须 optional（旧文件可读，`BACKWARD_COMPATIBILITY.md` 总则）。
- 状态枚举 `queued|running|waiting|review|done|failed|cancelled`（`store.ts:47`）；子状态 `activity:'monitoring'`、`askParked`、`awaitingAnswerSince`、`queueWaitReason`。
- 索引写入：`saveNow`（`store.ts:2334`）= 跨进程 Lamport bakery 票据锁（`store.ts:1142-1224`，ticket 文件含 host/ns/boot/start，死票按 PID 存活性回收）→ 与磁盘做字段级合并（损坏记录 verbatim 保留）→ tmp 文件 → `renameSyncWithRetry`（Windows EPERM/EBUSY 重试在 `fs-rename.ts:14-45`）。**无 fsync**，1s 去抖。
- 事件 NDJSON：同步 `appendFileSync`（`store.ts:1793`），`seq` 单调；SSE 从 NDJSON 回放后增量。
- 损坏处理：逐条 salvage，整文件损坏→全新开始但 NDJSON 不动（`store.ts:1337`）。

### 3.2 调度
- 工作区 `maxParallel`（默认 2，`semaphore.ts:126`）+ 项目级覆盖（`semaphore.ts:345`）；`busy()` 汇总所有 manager（`semaphore.ts:202`）；`pump()` 双重容量闸 + **账户 hold 闸**（`run.ts:2244-2287`）。
- 队列：进程内 FIFO（`run.ts:1402`），`promote()` 置顶（Run First，持久化 `promotedAt`），`startNow()` 绕过并发上限但**不绕过 hold**。
- `refresh()` 热更新并发设置（`semaphore.ts:357`）。

### 3.3 生命周期与恢复
- 重启恢复 `manager.recover()`（`run.ts:2465+`）：queued→重新入队（按 createdAt）；running→标记中断、按 session 尝试 Continue；waiting→按 askParked/attention 分流。worktree 孤儿在启动时清理（project-context `build()`）。
- 延迟启动（最接近 spec `notBefore`）：`deferredBinding` + `deferredStartStateSchema`（`contract/src/deferred-start-state.ts:11-23`）——含 **`notBefore`、`creationKey`、`requestDigest`（幂等去重）**，由 `automations/deferred-start.ts:132-204` 驱动。
- 检查步骤重试：`onFail {retry, max 默认 2, retryOn}`（`workflows/types.ts:50-60`）→ 编译为 graph loop（`run.ts:6367`）；消耗记录在 step `retriesUsed`。
- 瞬时故障自动恢复：`autoResumeAt/Attempts/Reason`，`MAX_TRANSIENT_RETRIES=2`，退避 [30s, 120s]（`core/agent-failure-class.ts:79-88`）。

### 3.4 执行器（GLM 链路核心）
- OpenCode runner（`core/opencode-server-runner.ts`）：spawn `opencode serve --hostname 127.0.0.1 --port <40000-60000>`（无 shell），每会话随机密码（Basic auth + 环境变量），v1/v2 API 探测（`GET /api/info`）；模型以规范 `provider/model` 传入（`parseModelIdentity`，非法即抛错——fail loud）。
- 权限：v2 会话体带 `permissions:[{action:'*',resource:'*',effect:'allow'}]`（L562-595），v1 `permission.asked` 走 `opencodePermissionReply`（L1086-1105）——**只对运行自身 handoff 文件放行一次，其余 reject**；`allowedTools` 不被 OpenCode 支持（#430 已知）。
- 额度识别：`isUsageLimitRejection`（L1110-1116）= 助手消息错误 `statusCode 429|402` 或文本匹配 `/limit|quota/i`；静默重试 >10 分钟放弃（`giveUpOnLongRetry`）。
- 错误分类（`core/agent-failure-class.ts:51-64`）：`transient|auth|billing|usage_limit|context_too_large|disk_full|other`；**billing 先于 usage_limit**（`insufficient_quota`/402→billing）；纯 429 throttle 明确**不**算耗尽（`core/usage-limit.ts:86 THROTTLE_RE` 否决 `isUsageExhaustion`）——与 spec §6.3 的"普通 429 ≠ 额度耗尽"完全一致。
- 认证失败闩锁：`core/provider-auth.ts:229-243`（401/token 失效等模式），`provider-auth-required` 事件持久化 provider + 脱敏 incident id，`verifyRuntimeAuthFailure` 冷却 60s 重探。
- 账户 hold（`workspace/agent-usage-holds.ts`，55 行）：`{account, until}`，每 hold 一个文件（sha256 命名，不可变），读取时删除过期；由 `claimAgentFallback`（`run.ts:3697`）在**已证实耗尽**时写入；`RunManager.accountHolds()`（`run.ts:4227`）联合 gate 排队并产出 `queueWaitReason`。
- auto-resume：`armUsageLimitResume`（`run.ts:3617`）解析 reset 时刻（`parseUsageLimit`，7 天上限），`MAX_AUTO_RESUMES=12`，可 `DELETE /runs/:id/auto-resume` 取消。
- 环境隔离：`buildChildEnv`（`core/agent-env.ts:365`）白名单转发；**opencode 允许 `OPENAI_*`、`ANTHROPIC_*` 等 MULTI_PROVIDER_PREFIXES**（L203-226）→ GLM Coding Plan 可经 `ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api/anthropic` + `ANTHROPIC_AUTH_TOKEN` 直达 opencode 子进程，cezar 自身不经手密钥。
- 用量：`token-usage`/`cost` 事件 → step 与 run 汇总（`store.ts:1615`）；usage-windows（5h/周窗口快照）目前仅 Claude+Codex 转发，**OpenCode 无窗口观测**（`core/usage-windows-runner.test.ts` 只循环两者）。
- CEZ_DRY_RUN=1：claude/cursor/pi/junie/antigravity/copilot/omp/gemini/kimi 有捆绑 mock；**codex 与 opencode 无 mock，仍探测真实二进制**（`backend-detect.ts:92,111`）。

### 3.5 HTTP API / GitHub / 工作流
- 路由必须走链式 family builder（Hono 类型推导依赖链式）；schema 在 `packages/contract/src/*.ts`；校验必须用 `validators.ts` 三件套中间件；新增路由需同步 `BACKWARD_COMPATIBILITY.md` §2（`bc-route-inventory.test.ts` 从构建后的 app 路由表反查）+ `contract-parity.<domain>.test.ts` + route-parity 三重拼写逐字节一致。**api-client 零改动**（`AppType = ReturnType<typeof createApp>` 自动扩宽）。
- `POST /runs`（`contract/src/runs.ts:1203-1290`）：`workflow` XOR `steps`（内联 1-8 步，agent XOR check）、`task ≤100k`、`model`、`runner`、`variants 1-3`、`autonomous`、`systemPrompt`、`images`、`dispatch`。queued 时 `PATCH /runs/:id` 可改 task。
- 动作：`cancel/promote/start-now/finish/land/continue/messages/pin/archive`、`DELETE auto-resume`、`POST /runs/:id/pr`（默认 draft）+ `/pr/adopt`。
- Draft PR（`server/forge/github.ts:2787 createDraftPr`）：从不抛错；目标解析 `resolveTaskRemotes`（`git-remotes.ts:99`：gh-resolved → fork-parent 查询 → origin；push 取 `pushDefault`→origin）——**明确禁止只按 remote 名猜**；先 `git push -u`（60s 超时）再 `gh pr create --draft`；重试 2 次（2s 间隔），每次先 `gh pr list --head` **认领已存在 PR**（幂等）；进程内 single-flight map（`server.ts:617`）合并并发发布。**无持久化 publish intent**（仅 `run.pullRequestUrl` 落盘）。
- 工作流：step `agent(prompt/skill/model/runner) XOR check(command, onFail)`；YAML v2 graph 含 `github.draft-pr`、`gate.human`、`git.commit/push`、`fork/join/loop` 等节点。check 执行 `spawn('bash',['-lc',command])`，输出截断 20000，**check 无超时、无每步/每 run 墙钟超时**。
- 报告：`handoff.md`（`.ai/cezar/runs/<id>.handoff.md`）+ artifacts 目录（`.ai/cezar/artifacts/<runId>`）+ diff/diffStat/commits 路由。**无 result.md**（dispatch 子任务有 `units/<id>/report.md`）。
- 仪表盘：工作区级 `/workspace/dashboard*` 已有 per-day token/cost 序列、完成/失败分类（`dashboard-costs.ts:51-62`）。

## 4. 实际缺口（factory 增量 = spec − 上游）

| spec 要求 | 上游现状 | 缺口判定 |
|---|---|---|
| category/priority/dependsOn/timeoutSeconds/maxRepairAttempts/idempotencyKey 等 factory 字段 | RunRecord 完全没有（grep 验证） | **新增** `factory` 可选扩展对象（§7 schema） |
| 全局并发 1 + 分类加权轮转 + 老化 | FIFO + promote，无优先级/权重/老化 | 新增调度选择器，挂在 `pump()` 的 startable 判定处；并发上限复用 `maxParallel`（设 1） |
| lifecycle 细阶段（preparing/verifying/repairing/reviewing/publishing…） | 仅 7 状态 + monitoring 子状态 | 新增 `factory.lifecycle` 字段 + 与原 status 的映射审计，不改原枚举 |
| 批量导入（≤100 条，预检，逐项错误） | 无任何批量端点 | 新增 `POST /api/v1/p/:projectId/factory/tasks/import` |
| 任务编辑（expectedVersion 乐观锁） | PATCH 仅 queued 可改 task/title，无版本号 | factory PATCH 自带 expectedVersion |
| 验收 profile（executable+args+timeout） | check step 有 command 无超时；无项目级 profile | 新增 acceptanceProfile 存储 + 服务端解析为参数数组；给 check 步骤补超时 |
| 每 run 墙钟超时 | 无（仅 agent runner 默认 30 分钟会话超时） | 在 factory 执行层加单调时钟墙钟超时 |
| result.md 报告 | handoff.md + artifacts | 新增报告生成器聚合检查证据 → result.md（走 artifacts markdown 展示） |
| publish intent 持久化 | 无（仅进程内 single-flight + 认领） | 新增持久化 publish intent 文件/字段 |
| 全局暂停/硬停止 | 无全局闸（仅 per-run 取消、hold 闸） | 新增工作区级 factory 控制状态文件 + 闸门 |
| 单实例租约（generation/fencing） | 无跨进程调度锁（bakery 锁只保护索引写；pid handoff 不是锁） | 新增实例锁 + lease generation |
| 自动修复轮（实现→检查→修复≤2） | check onFail retry 机制等价物存在（max 默认 2） | **部分复用**：工作流模板 + 计数器持久化，不新建引擎 |
| 依赖（dependsOn/dependencyMode） | 无 | 新增（领取资格判定 + 循环检测） |
| 额度未知显示 | usage-windows 不覆盖 opencode；字段缺 null 语义 | factory usage 视图显式 `null=未知`，不伪造 |
| OpenCode 的 usage-windows | 未实现 | 按 spec 记录为已知限制（用量仍可从 token-usage 累计） |
| WRR/配额/模板 | 无 | M1/M5 增量 |

**结论**：spec 设想的"复用上游、增量扩展"成立——持久化/调度/执行/恢复/GitHub 幂等骨架全部存在且质量高；factory 是纯增量层（新可选字段 + 新路由 family + 新调度选择器 + 新控制闸），不需要第二个存储体系，不违反"不建第二工作流引擎"。

## 5. 风险与已记录的上游约束

1. **无 fsync/去抖写**：spec §7 要求重要状态先落盘——factory 关键状态（lease/intent/预算）放**独立文件 + 原子替换**，不塞进去抖的 runs.json。
2. **Windows SIGTERM 只杀子进程**（无 taskkill /T）→ 硬停止需要自建进程树终止（`taskkill /pid X /T /F` 或 job object）。
3. **check 步骤无超时** → factory 验收执行必须自带超时与进程树终止。
4. **CEZ_DRY_RUN 无 opencode mock** → M0 的 mock 路线用 claude runner mock 演示控制台；GLM live 链路单独验证。
5. **OpenCode 权限模型**：v2 会话默认 `action:* allow` + runner 内 `allowedTools` 无效 → 隔离不能依赖执行器，必须靠 M4 的目录/凭据边界（agent-env 白名单已限制控制面状态不可达）。
6. `promotedAt` 等既有字段与 factory priority 语义并存：调度选择器里 factory 排序独立于 promote（promote 仍优先，spec §9.1 允许置顶）。

---

*本文件由 M0 审计产出；上游演进后需重新核对。规格书（docs/CEZAR_GLM_DEVELOPMENT_SPEC.md）中的 factory 设计不声称上游已有。*
