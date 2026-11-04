# IMPLEMENTATION_PLAN — Cezar-GLM 增量改造实施计划（M0 产出）

依据：`docs/CEZAR_GLM_DEVELOPMENT_SPEC.md`（下称 spec）+ `docs/UPSTREAM_AUDIT.md`（审计结论）。
原则：**纯增量**——不改上游既有字段语义、不建第二存储/工作流引擎、所有新字段 optional 旧文件可读；每步真实测试。

## 0. 总体改造边界

```
新增目录 packages/cezar/src/factory/           ← factory 全部服务端逻辑（新模块，不散改上游）
新增     packages/contract/src/factory.ts      ← 全部请求/响应 zod schema
新增     packages/cezar/src/server/contract-parity.factory.test.ts
修改     packages/cezar/src/server/server.ts   ← 仅追加两个链式 family（factory 工作区级 / 项目级）
修改     packages/cezar/src/runs/store.ts      ← 仅追加 RunRecord.factory 可选字段（optional + .catch）
修改     BACKWARD_COMPATIBILITY.md §2          ← bc-route-inventory 强制
修改     .env.example                          ← 任何新 CEZ_* 同提交更新
```

关键复用（已核实存在，见 UPSTREAM_AUDIT §3）：
- 任务=RunRecord；调度=workspace `maxParallel`（设 1）+ `pump()` 闸门 + `accountHolds`；
- 修复轮=内联 steps（agent XOR check）+ `onFail{retry,max}`（默认 2 恰合 spec）；
- 恢复=`manager.recover()`；hold=`agent-usage-holds` + `queueWaitReason`；
- 发布=`createDraftPr`（已认领重复 PR）+ single-flight；
- 延迟启动=`deferredBinding`（含 notBefore/幂等键）。

## 1. 新增文件清单（按里程碑）

### M1 — factory schema、导入、状态映射、单并发调度
| 文件 | 内容 |
|---|---|
| `packages/contract/src/factory.ts` | `factoryStateSchema`（spec §7 全字段，含 schemaVersion/lifecycle/category/priority/dependsOn/…）、`factoryTaskImportSchema`（≤100 条，整批预检）、`factoryTaskPatchSchema`（expectedVersion）、`factoryActionsSchema`（pause/resume/cancel/retry/publish）、`factoryStatusSchema`、分页查询 schema；`index.ts` 导出 |
| `packages/cezar/src/factory/state.ts` | 项目级状态文件 `<root>/.ai/cezar/factory/state.json`：idempotencyKey 注册表、version 计数器、publish intent、checkpoint 索引。原子写（tmp+rename+flush）、损坏隔离（同上游 salvage 原则，**不清空后继续**） |
| `packages/cezar/src/factory/lifecycle.ts` | lifecycle 细阶段与上游 status 的映射表 + 合法迁移表 + NDJSON 事件（`type:'factory'`）写入；"重要状态先落盘再执行副作用" |
| `packages/cezar/src/factory/import.ts` | 批量导入预检（逐项错误、projectId/profile 存在性校验、依赖图静态检查含循环拒绝 A05）、经 `manager.startRun` 创建 |
| `packages/cezar/src/factory/scheduler.ts` | 领取选择器：资格过滤（notBefore/dependsOn/hold/停止闸）→ promote 优先 → P0 优先 → 非 P0 老化（每 6h 升一级至 P1）→ 分类加权轮转 5:3:2 → createdAt/taskId 稳定排序。以**独立 tick** 驱动（运行完成事件 + 定时器），用上游 `promote()` 排队，不抢占运行中任务（A03） |
| `packages/cezar/src/factory/controls.ts` | 工作区级控制 `cezarHomeDir()/factory/controls.json`（pause/stop 状态 + 日界线 Asia/Shanghai 的每日新任务计数 ≤20） |
| `packages/cezar/src/factory/*.test.ts` | 调度公平性、老化、依赖循环、导入预检、并发 1（A02-A05）、旧数据可读（A20） |

### M2 — 验收 profile、修复预算、报告
| 文件 | 内容 |
|---|---|
| `packages/cezar/src/factory/acceptance.ts` | profile 定义（`<root>/.ai/cezar/factory/profiles.json`，可选）+ 内建 `node-standard` 等；解析为**参数数组**（拒绝 shell 拼接）、executable/relativeCwd 路径规范化校验（拒 `..`/绝对越界）、timeout 必填 |
| `packages/cezar/src/factory/runner.ts` | factory 执行编排：创建 run（内联 implement+verify steps，onFail.max=maxRepairAttempts）；**墙钟超时**（单调时钟，含 check 步骤超时——上游 check 无超时，factory 对自己发起的 run 用外层定时器 + interrupt() 实现）；超 repair 上限→failed（A06/A07：测试不过绝不 review_ready） |
| `packages/cezar/src/factory/report.ts` | `result.md` 生成 → 写入 run artifacts 目录；含 baseCommit/headCommit/diffStat、逐检查命令 exitCode/时长、用量（reported/estimated/null 未知语义）、修复次数、PR URL、无法验证事项单列 |
| 上游微改 `workflows/run.ts` | check 步骤执行增加可选 `timeoutMs`（step schema optional 字段，向后兼容；仅 factory 生成的工作流使用） |

### M3 — hold、恢复、租约、幂等发布
| 文件 | 内容 |
|---|---|
| `packages/cezar/src/factory/lease.ts` | 单实例锁 + 任务租约（owner/generation/acquiredAt/heartbeatAt，proper-lockfile + PID 存活性；所有回写校验 generation—— fencing）；恢复对账（interrupted→按阶段 checkpoint 重入） |
| `packages/cezar/src/factory/checkpoint.ts` | 阶段 intent/checkpoint 文件（`<root>/.ai/cezar/factory/checkpoints/<runId>.json`）：task/attempt、工作流版本、基线提交、分支、工作树状态、阶段、sessionId、测试证据、policyVersion |
| `packages/cezar/src/factory/publish.ts` | publish intent 持久化（taskId+host+repo+head+base+状态机）；复用 `createDraftPr`（自带重复认领）；push 冲突→blocked 不 force；超时后先查询认领（A12）；发布由服务完成，执行器无 GitHub 写凭据（上游 gh 凭据本就不进 agent env 的模型命名空间——`GH_ALLOW_NAMES` 保留给 gh 自身，需实测确认后记录） |
| `packages/cezar/src/factory/probe.ts` | 额度未知时的单探测任务闸（30 分钟窗口、逐次延长、最多每小时一次） |

### M4 — 停止、路径、UI
| 文件 | 内容 |
|---|---|
| `packages/cezar/src/factory/hardstop.ts` | 硬停止：Windows `taskkill /pid <pid> /T /F`，POSIX 负进程组 `kill(-pgid)`；10 秒预算；无法确认→保持 blocked（A14） |
| `packages/cezar/src/factory/paths.ts` | 越界防护（symlink/junction/`..`/大小写规范化校验，供 acceptance 执行与清理共用）（A15/A16） |
| `packages/web/src/routes/factory/*` | 总览（运行/排队/等待/阻塞/待审计数、磁盘、全局停止）、任务表（分类/优先级/阶段/等待原因/修复次数）、详情（验收条件/日志/证据/checkpoint/PR）、设置（执行器诊断/预算/权重/白名单/自动发布开关）；额度未知显示"未知"（A09） |
| `packages/contract` + api-client | 零 client 改动（AppType 自动扩宽）；SSE 复用 |

### M5 — Windows 交付
| 文件 | 内容 |
|---|---|
| `scripts/factory/doctor`（mjs，Windows 可执行） | 版本/CLI 登录/Git/目录/磁盘/端口/模型调用自检（不输出密钥） |
| `scripts/factory/start|stop|status` | 单例启动/停止（调用 hardstop）/状态快照 |
| `scripts/factory/backup|restore` | 一致性备份（状态+分支+未提交快照，无明文密钥）/恢复演练校验（A21） |
| `scripts/factory/install-autostart.ps1` | `schtasks` 计划任务（LiteralPath，无额外窗口），含卸载（A22） |
| `docs/factory/*` | 安装/启动/恢复说明（中文） |
| `docs/factory/templates/*` | 三类任务模板 + ≥9 个小任务样例（spec §14/§19） |
| `packages/cezar/src/factory/fixtures/*` | GLM mock fixtures：成功/429/额度耗尽/401/断网/异常结束 |

## 2. 新增 API（spec §12 → 上游挂载规范）

工作区级（single-mount，不镜像）：`GET /api/v1/factory/status`、`POST /api/v1/factory/{pause,stop,resume}`、`GET /api/v1/factory/usage`。
项目级（三重拼写自动镜像）：`GET/POST /api/v1/p/:projectId/factory/tasks`、`POST …/tasks/import`、`PATCH …/tasks/:taskId`、`POST …/tasks/:taskId/actions`、`GET …/tasks/:taskId/report`。

每个 family：contract schema → 链式 builder + validators 三件套 → `contract-parity.factory.test.ts` → `BACKWARD_COMPATIBILITY.md` §2 登记（bc-route-inventory 反查）→ route-parity 自动覆盖。

错误结构：`{code, message, retryable?, retryAt?, requestId}`；版本冲突 409、验证 400、越权 403、不存在 404；幂等重放同 payload 返回既有结果、异 payload 409。

## 3. 里程碑验证命令（每阶段退出条件）

| 阶段 | 命令（按 AGENTS.md 顺序） | 额外验收 |
|---|---|---|
| M0（已完成） | `npm run typecheck` ✅ exit 0；`npm test`；`npm run test:unit`；`npm run build`；`npm run test:package` | 结果记入 BASELINE_TESTS.md |
| M1 | 同上 + `npm test -- packages/cezar/src/factory` | 10 个 mock 任务正确完成、旧任务可读、A02-A05 |
| M2 | 同上 + 测试仓库"实现—失败—修复—通过"实测 | A06/A07 |
| M3 | 同上 + 故障矩阵（强杀/双实例/断网/丢响应） | A10-A13/A17 |
| M4 | 同上 + `npm run test:e2e`（UI 变更时；skipped 不算通过） | A14-A16/A19 |
| M5 | 同上 + 72h mock 长跑 + 8h live | A22-A24 |

**明确标记**：无 OpenCode/GLM 凭据 → 所有 live 步骤按 spec 记 `live 未验收`，不伪造；mock/离线部分全部真实执行。

## 4. 顺序与提交纪律

T01 审计（本文件+UPSTREAM_AUDIT）→ T02 schema 与兼容测试 → T03 API/导入 → T04 调度与停止闸门 → T05 GLM 诊断与错误归类（复用上游分类，补 opencode 用量视图）→ T06 验收配置 → T07 检查点恢复 → T08 GitHub 幂等 → T09 隔离边界 → T10 UI → T11 运维脚本 → T12 故障注入与交付。

小提交；每提交前跑 `npm run typecheck && npm test`（快速门）；主分支只读——全部工作在新分支 `factory/main`（或按仓库规范 `feat/factory-*`）。
