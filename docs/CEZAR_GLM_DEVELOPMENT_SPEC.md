# Cezar-GLM 本地自动编程任务池开发规格书
版本：V1.0 · 日期：2026-11-05（北京时间）
交付对象：Zcode · 目标环境：现有 Windows 常开电脑 + GLM Coding Plan + GitHub

## 1. 开发目标与必须遵守的决定

在开源 Cezar 基础上进行增量改造，让电脑从本地任务池持续领取任务，完成代码实现、自动测试、有限次数修复、结果归档和 GitHub Draft PR。任务覆盖软件开发、流量网站、气象科研代码三个方向。用户每天主要检查结果、处理阻塞和审核合并。

本项目代号 Cezar-GLM。上游：https://github.com/open-mercato/cezar 。

必须遵守：
1. 先在测试仓库跑通上游，再做必要改造；复用现有 Web、任务执行、Git worktree、工作流和持久化。
2. 本地任务池是调度事实来源；GitHub 是代码协作和可选任务导入渠道，不依赖 GitHub Issues 才能运行。
3. 第一版全局并发 1；规划、编码、审查采用串行角色。稳定性通过后再考虑并发 2。
4. Zcode 是本次开发工具。运行时先适配 Cezar 已有的 OpenCode → GLM Coding Plan 链路；不把未核实的 Zcode CLI 当成依赖。
5. OpenCode 兼容性不通过时，可在同一 GLM 套餐下评估上游 Claude Code runner；切换必须留可见记录，不默认切换账户或付费 API。
6. 任务自动推进到本地待审结果；经项目级启用后可自动推送任务分支、创建 Draft PR。合并、发布和部署由用户决定。
7. 无任务即空闲，有额度不等于必须消耗。目标是交付可验收成果，不是耗尽 Token。
8. V1 不重写成 Python 调度器，不引入 SQLite/Redis/PostgreSQL，不做自研 Agent 框架。
9. 普通编码和测试不逐次请求用户确认；只有缺少需求、受保护变更、外部副作用不确定、凭据失效等明确阻塞才等待处理。

本规格书是开发设计，不代表功能已经实现或已在用户电脑验证。

## 2. 已核实基础与开工核验

截至编写时读取了上游 README、package.json、AGENTS.md 和 docs/reference.md。上游持续变化，Zcode 开工必须记录 checkout 的 commit SHA；本次读取到的单文件 blob SHA 不是提交 SHA。

| 项目 | 当前读取结果 | 开发约束 |
|---|---|---|
| 持久化 | .ai/cezar/ 下 JSON、NDJSON、Markdown 文件；无数据库 | 在原存储层扩展，旧文件继续读取 |
| 后端 | TypeScript ESM、Node 20+、Hono、Zod | 复用当前版本依赖与锁文件 |
| 前端 | React、Vite、Tailwind、shadcn/ui | 在现有控制台增加字段与视图 |
| 工作区 | 每个任务独立 worktree、等待队列 | 继续使用原有创建和清理机制 |
| 工作流 | YAML、Agent 步骤、命令检查、有限重试 | 不另建第二个工作流引擎 |
| 执行器 | 含 OpenCode 和 Claude Code | OpenCode 的协议及版本兼容需实测 |
| 队列 | 全局并发控制、FIFO、Run First、排队恢复 | 优先扩展调度选择逻辑 |
| 限额 | 已有账户 hold、部分自动恢复及 fallback | 核验 GLM 错误是否被正确识别 |
| GitHub | 支持 Draft PR | 显式配置目标仓库和目标分支 |

以前出现过的“Cezar 自带 SQLite”“zcode --prompt / --resume 可直接调用”等说法，不可作为实施依据。未验证参数不得写入可运行脚本。

### M0 必须产生的审计文件

- docs/UPSTREAM_AUDIT.md：上游提交 SHA、依赖、真实入口、已有能力、实际缺口。
- docs/COMPATIBILITY.md：Windows/WSL、Node、Cezar、OpenCode、GLM 模型的已验证组合。
- docs/BASELINE_TESTS.md：上游原始测试结果、已有失败、环境限制。
- docs/IMPLEMENTATION_PLAN.md：需要改动的文件、每个里程碑和验证命令。

不要仅交审计文档就停止。审计通过后继续 M1；外部账号尚不可用时继续 mock 开发，并准确标识 live 验收未完成。

## 3. 范围和首版交付

### P0：必须完成

- 本地任务创建、编辑、导入、暂停、取消和重试。
- 三个方向标签、P0—P3 优先级、依赖关系、超时时间。
- GLM 通过受支持编程工具接入；模型和账户配置可诊断。
- 任务领取、执行、可信测试、最多 2 次修复、待审报告。
- 重启恢复、断网退避、额度暂停、幂等 GitHub 发布。
- 全局停止、受控目录、凭据隔离、资源上限。
- 中文可读控制台与安装、启动、恢复说明。
- 故障注入测试和连续运行记录。

### P1：稳定后增加

- 用户启用的定时任务、GitHub Issues 导入。
- 分类运行时间配额、统计报表和任务模板。
- 多项目并发 2、资源压力调度。
- 通过验证的自动 Draft PR。

### 本期不做

- 自动合并或自动上线。
- 自动寻找商机并无限生成任务。
- 大规模模型训练、自动抓取任意网站、无人审核发布科研结论。
- 为消耗额度自动调用收费后备模型。
- 默认接入微信、邮件或第三方通知；首版报告留在控制台和本地。

## 4. 整体架构与改造边界

控制台提交任务 → 原任务存储 → 调度选择与账户闸门 → 原 worktree 管理 →
原工作流引擎 → OpenCode runner → GLM Coding Plan →
可信测试与有限修复 → 审查报告 → 本地待审 / Draft PR。

横向能力：恢复协调器、资源看护、凭据代理、审计日志、全局停止。

| 模块 | 责任 | 优先检查的上游位置 |
|---|---|---|
| 契约 | 可选扩展字段、Zod 校验、前后端类型 | packages/contract、packages/api-client |
| 调度 | 分类、优先级、闸门、单例领取 | packages/cezar/src/workspace/semaphore.ts 及实际调用者 |
| 任务存储 | 快照、事件、恢复、兼容性 | packages/cezar/src/runs/store.ts |
| 执行器 | GLM 兼容、错误归类、事件标准化 | packages/cezar/src/core/agent-runner.ts、runner-factory.ts、opencode-server-runner.ts |
| 工作流 | 测试、修复、阶段检查点 | packages/cezar/src/workflows/types.ts、load.ts、run.ts |
| 服务 | 新字段、控制接口、项目权限 | packages/cezar/src/server/server.ts、project-context.ts |
| GitHub | 分支推送与 Draft PR 幂等 | packages/cezar/src/server/github.ts、pr.ts |
| 前端 | 任务表、详情、统计、设置 | packages/web/src 下对应路由 |

这些是已读取文档列出的定位入口，不是保证当前所有实现都在同一文件。实际函数由 Zcode 检索确认。新增模块名称可以按仓库规范调整，不创建平行的 task/runs 数据体系。

## 5. Windows 部署方式

默认使用 Windows + WSL2 Linux 环境运行服务，浏览器在 Windows 打开本地控制台。此项是本项目部署选择，不是宣称上游所有 Windows 功能都已验证。原生 Windows 作为后续兼容目标。

建议：
- Cezar、Node、Git、OpenCode、gh、项目仓库统一放在 WSL 环境。
- 仓库与 worktree 放 Linux 文件系统，例如 ~/cezar-workspace，避免混用 Windows 与 Linux 的 Git、node_modules 和绝对路径。
- 固定受支持的 Node LTS 版本和执行器版本，使用 npm 锁文件；不要常驻运行 nightly/latest 浮动版本。
- Windows 任务计划程序负责启动发行版/监督入口，WSL 内 systemd 或等效单一监督进程负责服务。
- 开机启动和登录后启动必须分别验证，不能把“用户登录后自动启动”表述成“未登录也能运行”。
- 电脑睡眠、关机和网络断开时不能继续计算；恢复后进行任务对账。电源设置由安装说明明确提示。
- UI 绑定 loopback；不自动开放公网端口。WSL localhost 转发和防火墙行为在实际电脑上验证。

WSL 和 worktree 都不是安全沙箱。首版普通试运行可使用专用低权限账户与测试仓库；只有第 13 节的隔离验收通过，才能标记为“无人值守模式可用”。

### Zcode 交付的运维脚本

| 文件（建议） | 行为 |
|---|---|
| scripts/factory/doctor | 检查版本、CLI 登录、Git、目录、磁盘、端口、沙箱及模型调用 |
| scripts/factory/start | 单例启动；使用已构建的本地固定版本 |
| scripts/factory/stop | 停止领取、保存状态、终止所属进程树 |
| scripts/factory/status | 显示服务、任务、额度状态和最近心跳 |
| scripts/factory/backup | 一致性备份状态、分支和未提交成果 |
| scripts/factory/restore | 校验备份，恢复后先对账，不直接重放任务 |
| scripts/factory/install-autostart.ps1 | 安装计划任务，提供卸载入口 |

命令名字是拟新增的交付项，不是现有 Cezar 命令。PowerShell 使用 LiteralPath，路径含空格也要可用；后台启动不得弹出额外终端窗口。

## 6. GLM 接入与额度模型

### 6.1 执行链路

Zcode 开发本项目；运行时优先 Cezar 原 OpenCode runner。保留上游 runner 协议，禁止再套一层通过模拟键盘点击桌面工具的执行器。

智谱官方配置助手可用 npx @z_ai/coding-helper，选择中国大陆 GLM Coding Plan 和 OpenCode。模型使用账户实际可用型号，不在代码中假定套餐型号永远不变。配置之后记录版本，运行最小编码任务并核对实际消耗来源。

已核实的大陆协议地址：
- OpenAI 兼容 Coding 端点：https://open.bigmodel.cn/api/coding/paas/v4
- Anthropic 兼容端点：https://open.bigmodel.cn/api/anthropic

两个地址协议不同，不可互换；不能把 Coding 端点替换成通用计费 API 来“解决”额度不足。凭据交给执行器支持的安全配置方式，文档和示例只用占位符。

不得因为 OpenCode 有 opencode run 命令，就把 Cezar 的现有 server runner 改写成拼接 shell。非交互任务、事件流、取消、恢复均以固定版本真实接口和测试为准。

### 6.2 必须通过的连接测试

1. doctor 能报告执行器安装与版本、账户标识别名、模型和端点类型，不能输出密钥。
2. 测试仓库内创建一个函数和对应测试，运行测试并得到真实退出码。
3. 能捕获模型/工具事件和正常完成事件。
4. 能取消整个执行树；执行器报错不能被当成成功。
5. 同一套餐在 Zcode 和执行器中的可用性分别验证；不能假定客户端登录自动跨工具共享。

### 6.3 配额与错误分类

当前套餐文档包含短周期和周额度约束，不能实现成“每天零点自动清零”。应用自设的每日运行时间限额仅为本地预算，与官方额度分开显示。

| 条件 | 处理 |
|---|---|
| 短暂网络错误或 5xx | 指数退避、抖动，最多 5 次 |
| 普通 429 | 按 Retry-After 或退避；不直接判定套餐耗尽 |
| 明确额度耗尽 | hold 对应 provider/account，保存 resetAt（若已知） |
| 401 / 凭据失效 | 阻塞账户，等待更新，禁止无限重试 |
| 403 | 区分权限、模型不可用和账户限制，保留脱敏错误 |
| 错误不识别 | unknown_error，有限重试后等待处理 |
| 本地预算耗尽 | 等待本地预算窗口，不能伪装成官方限额 |

退避默认 30 秒起，指数增长，上限 15 分钟；服务端指定更长等待时尊重该值。额度 resetAt 未知时默认等待 30 分钟后仅允许一个探测任务；连续探测失败逐步延长，最多每小时一次。其余队列不同时探测。

用量字段：reportedInputTokens、reportedOutputTokens、reportedCachedTokens、reportedCredits、estimatedTokens、usageSource、confidence。缺失值用 null/未知，不填 0，不据此承诺剩余额度。费用为供应方报告或估计时分别标注。

模型调用限于受支持工具和当前套餐允许用途。网站和科研方向首先自动开发代码、测试、数据处理工具；正式业务 API 服务、批量商业内容生产及其他非编码负载另行确认适用产品。

## 7. 任务对象与持久化

复用上游 RunRecord，下面的 factory 对象是拟新增的可选扩展。上游原状态、字段和事件不得破坏。旧任务缺 factory 时按旧逻辑处理。

```json
{
  "factory": {
    "schemaVersion": 1,
    "category": "software",
    "priority": 1,
    "lifecycle": "queued",
    "dependsOn": [],
    "dependencyMode": "review_ready",
    "estimatedMinutes": 30,
    "timeoutSeconds": 3600,
    "maxRepairAttempts": 2,
    "networkRetryCount": 0,
    "repairAttemptCount": 0,
    "interruptionCount": 0,
    "notBefore": null,
    "blockedReason": null,
    "baseCommit": null,
    "checkpointId": null,
    "acceptanceProfileId": "node-standard",
    "policyVersion": "v1",
    "idempotencyKey": "project-demo-task-001",
    "publishMode": "local_review",
    "lease": null
  }
}
```

category 枚举 software、traffic、weather；priority 0 最高、3 最低。优先级及策略由用户/受信服务控制，Agent 不可自行提高权限或改变预算。

### 任务输入必须包含

title、projectId、description、scope、acceptanceCriteria、acceptanceProfileId；可选 dependencies、category、priority、notBefore。没有可验证目标时进入 needs_spec，不能自动执行模糊大目标。

标题最多 200 字符，描述建议最大 32 KiB；所有路径、枚举和数值在后端校验。任务 JSON 导入最多 100 条，整批先预检，返回逐项错误；同一 idempotencyKey 只能创建一个任务。

### 存储原则

- 索引继续使用上游存储，增加可选字段；重要状态变更必须在启动副作用前落盘。
- 文件采用同目录临时文件、flush/fsync、原子替换；保留最近有效快照和校验信息。
- 事件采用 NDJSON，带 eventId、taskId、attemptId、序号、时间、类型。
- 重启遇到尾部不完整事件可截断无效尾记录，保留审计；中间损坏应隔离并报错。
- 对新增工厂状态的损坏不得静默清空后继续执行；不能因容错导致重复 push 或丢失任务。
- 全局预算和账户 hold 存在工作区级，项目任务仍留在各自项目状态目录。
- 写入权只有调度服务。执行器不获得控制面状态目录和全局设置的可写权限。

## 8. 状态机与完成定义

保留上游状态作为兼容展示；factory.lifecycle 描述细阶段，审计中维护清晰映射。

| lifecycle | 意义 | 下一步 |
|---|---|---|
| needs_spec | 验收条件不完整 | 补齐后 queued |
| queued | 可被评估领取 | preparing / blocked / waiting |
| preparing | 解析基线、校验权限、建立 worktree | running / blocked |
| running | Agent 实现 | verifying / waiting / interrupted |
| verifying | 可信检查运行 | reviewing / repairing / failed |
| repairing | 修复本轮检查失败 | verifying，最多 2 次 |
| reviewing | 独立上下文审查 diff 和证据 | review_ready / repairing / blocked |
| waiting | 等待网络、额度、预算或未来时间 | 条件满足后 queued |
| interrupted | 进程异常或重启待对账 | 恢复既定阶段 / blocked |
| review_ready | 本地可供用户审查 | publishing / accepted |
| publishing | 幂等推送及 Draft PR | pr_ready / waiting / blocked |
| pr_ready | PR 已创建，等待人工审查 | accepted / 追加修复任务 |
| accepted | 用户确认验收完成 | 终态 |
| blocked | 需要明确外部处理 | 用户处理后回到允许阶段 |
| failed | 超过重试或不可恢复 | 新 attempt 或终止 |
| cancelled | 用户取消 | 终态，不自动恢复 |

全局暂停与任务暂停是调度闸门，不混入“执行失败”。软暂停阻止新领取，当前任务可完成；硬停止中断当前进程并留下 interrupted。取消是终止意图，重启也不自动恢复。

“Agent 自称完成”不构成成功。review_ready 要求可信检查通过、差异符合范围、报告完整、没有未处理高风险项。pr_ready 不等于已合并、已部署或人工验收。

依赖默认要求前置任务 review_ready。若依赖前置代码，必须声明 inputRef 为固定提交并记录基线；不能仅凭状态就假定代码已合并进 main。需要主线代码的任务使用 dependencyMode=merged，核对实际合并提交后再启动。

## 9. 调度规则

### 9.1 所有入口同一闸门

UI 新建、Run First、定时、导入、重试、恢复、子任务、CLI 启动都经过同一 dispatch 检查。不能通过备用入口绕过并发、额度或停止限制。

领取顺序：
1. 排除暂停/取消、依赖未满足、未来开始时间、账户 hold、项目禁用、安全策略不合格的任务。
2. 检查单实例所有权和全局并发 1。
3. 用户置顶任务优先选择，但不能抢占当前任务，也不能越过安全和额度限制。
4. P0 队列优先；非 P0 根据等待老化提升有效优先级，每等待 6 小时提升一级，最高到 P1。
5. 同一有效优先级按分类加权轮转；初始 software:traffic:weather=5:3:2，可修改。
6. 同分类按创建时间，再按任务 ID 稳定排序。

权重是有积压时的近似资源份额，不保证每 10 个任务恰好 5/3/2。空分类额度可借用；P0 长期占用超过一个工作日显示饥饿提示。第二版可基于实际运行分钟数用 deficit round robin 替代任务数轮转。

### 9.2 资源与无限循环限制

- 单任务墙钟超时：默认 60 分钟；各阶段可设更小上限。
- 修复上限：2 次；恢复、网络重试、审查失败不得把该计数清零。
- 自动中断恢复上限：3 次，之后 blocked。
- 初始全局并发 1；禁止模型自发绕过调度器另开不受控子 Agent。
- 已批准待办可自动推进；Agent 提出的新任务放建议区，默认不执行。
- 默认每日最多启动 20 个新任务；用户可调整，但重试另设总运行时预算。
- 开启任务前建议剩余磁盘不少于 10 GiB；阈值按机器配置。
- 内存上限基于 doctor 实测，给系统保留至少 2 GiB；配置不足时降低任务规模。
- 本地统计日界线 Asia/Shanghai；服务内部时间保存 UTC，超时使用单调时钟。

## 10. 工作流、检查与修复

### 10.1 标准过程

准备 → 读取任务和项目规范 → 必要的短计划 → 实现 → 可信检查 →
最多两轮修复 → 独立上下文审查 → 输出结果。

不是每个小任务都启动多个 Agent。简单修复可以实现后直接检查；复杂任务规划输出限于本任务范围。审查是独立上下文，仍使用同一已配置执行器；其意见不替代自动测试。

### 10.2 上游 YAML 示例

以下采用已读取 README 中的步骤语法。真正启用前由本版本 loader 校验；runner 名称也要与已安装版本匹配。

```yaml
name: factory-implement-and-verify
steps:
  - id: implement
    prompt: "{{task}}"
    runner: opencode
  - id: verify
    command: "npm test"
    onFail:
      retry: implement
      max: 2
```

该示例只说明上游重试结构，不是完整安全实现。正式工厂模式不能让任务正文直接提供任意 shell command；检查必须来自受信验收配置，并由同一个工作流执行层执行。

### 10.3 可信验收配置

每个项目配置 acceptanceProfile，包含 executable、args、relativeCwd、timeout、输出上限和允许环境变量。服务端将其解析为固定命令；调用使用参数数组，避免拼接用户字符串。

- Node 网站：类型检查、单元测试、构建、必要的浏览器冒烟。
- Python 科研：固定环境中的 pytest、轻量数据验证、可复现的基线训练小样本。
- 文档任务：结构检查、引用完整性、示例或链接检查（按任务实际需要）。
- 无既有测试：先记录测试缺口，创建有意义的最小验收；不能用“没有测试所以通过”。
- 检查保存 command、cwd、exitCode、开始/结束时间、超时标记、日志路径和产物哈希。
- 无输出不等于进程卡死；长测试以超时和进程资源判断，不能只按 stdout 心跳杀进程。

任务可以修改业务测试，但不得修改受保护验收入口来让检查失效。package.json 的 scripts、测试配置和验收文件变化应进入审查范围；服务控制的外部验收测试保留只读副本。

审查检查：删测试、跳过断言、修改基线答案、引入新依赖、泄漏凭据、无关大改、实现与验收不一致。发现问题允许在同一总修复预算内返工；预算耗尽后阻塞。

## 11. 断点恢复与幂等

### 11.1 单实例与租约

一个工作区只有一个调度主进程。使用操作系统锁或上游已验证的跨进程锁；文件存在不等于锁仍被持有。锁记录实例 ID、进程启动标识、boot ID 和心跳，避免 PID 重用误判。

任务 lease 至少包含 owner、generation、acquiredAt、heartbeatAt。所有完成回写携带 generation；过期实例不能提交新状态。单机设计不承诺跨机器分布式 exactly-once。

每个阶段开始前写 intent，完成后写 checkpoint。检查点包含 task/attempt、工作流版本、基线提交、分支、工作树状态、阶段、执行器会话 ID（如支持）、测试证据和策略版本。不能只存一段 AI 摘要。

### 11.2 恢复顺序

1. 取得独占所有权，加载最后有效快照与事件。
2. 检查残留进程的真实身份、所属工作区和启动时间。
3. 仍在运行且可安全重新接管则观察；不能确认时阻塞，不能同时重启第二份。
4. 确认旧进程结束后，检查 worktree、dirty diff、最近提交和外部副作用记录。
5. 可恢复会话则恢复；不支持时用任务、已完成事实、diff、失败日志重新开始当前阶段。
6. 不重复执行已经验证完成的代码改动；验证阶段可以重跑可信检查。
7. 超出恢复上限后报告需要处理的具体原因。

每次成功实现/修复后，保留本地 WIP 提交或包含未跟踪文件的受控快照；忽略敏感文件。不能只保存 git diff，因为它不包含未跟踪文件。备份未提交成果也不能依赖“推送过分支”来保证安全。

### 11.3 GitHub 幂等发布

发布前固定 host、owner/repo、baseBranch、taskBranch、commit SHA。Fork 场景禁止仅按 remote 名字猜目标，尤其不能意外向上游 Cezar 提业务任务 PR。

- 持久化 publish intent：taskId + 目标仓库 + head + base。
- push 使用普通非强推；远端分叉时 blocked，不 force。
- 创建 PR 前按 head/base 查询现有 PR，并在正文加入机器可识别 taskId。
- 网络超时后先查询结果，已存在则认领 PR；无法确定时暂停，不盲目重复创建。
- 工作流重试保持相同逻辑任务身份；用户要求重新做才创建新任务。
- Issue 导入去重键：host/repo/issueNumber + 用户指定 revision；不能每次轮询都建新任务。
- 发布由受信服务完成，Agent 执行环境不持有 GitHub 写凭据。

## 12. API 与前端设计

复用现有项目级 /api/v1/p/:projectId 路由与客户端。下表为拟新增 factory 命名空间，并非声称上游已经支持。M0 若发现等效接口，应扩展既有接口。

| 方法/路径 | 功能 |
|---|---|
| GET /api/v1/factory/status | 全局停止状态、资源、账户 hold、活动任务 |
| POST /api/v1/factory/pause | 软暂停 |
| POST /api/v1/factory/stop | 硬停止 |
| POST /api/v1/factory/resume | 恢复调度，重新检查资格 |
| GET /api/v1/p/:projectId/factory/tasks | 查询和分页 |
| POST /api/v1/p/:projectId/factory/tasks | 创建任务，要求 Idempotency-Key |
| POST /api/v1/p/:projectId/factory/tasks/import | 导入预检和批量创建 |
| PATCH /api/v1/p/:projectId/factory/tasks/:taskId | 编辑未领取字段，带 expectedVersion |
| POST /api/v1/p/:projectId/factory/tasks/:taskId/actions | pause/resume/cancel/retry/publish |
| GET /api/v1/p/:projectId/factory/tasks/:taskId/report | 结果与证据 |
| GET /api/v1/factory/usage | reported/estimated/unknown 分开返回 |

统一错误结构 code、message、retryable、retryAt、requestId；禁止把底层完整环境或密钥放进错误。版本冲突返回 409；验证错误 400；未授权 403；不存在 404。幂等重放相同 payload 返回已有结果，不同 payload 返回 409。

沿用上游认证、请求 Origin 防护和 SSE。项目接口验证 task 所属 project，防止只换 taskId 读取其他项目。UI 不暴露任意服务器路径读写接口。

### 必须增加的页面能力

- 总览：运行/排队/等待额度/阻塞/待审核数量，最近交付，磁盘与全局停止按钮。
- 任务表：分类、优先级、阶段、等待原因、开始条件、修复次数、项目。
- 任务详情：验收条件、受影响文件、日志、测试证据、检查点、PR。
- 设置：执行器诊断、本地预算、分类权重、目录白名单、自动发布开关。
- 任务模板：软件开发、网站工具、科研实验；创建前预览完整任务。
- 额度未知时显示“未知”，禁止画一个推测的精确剩余额度进度条。

SSE 断线后获取权威快照，按事件 ID 去重；页面刷新不应创建任务。按钮禁用状态和后端约束一致。

## 13. 无人值守安全边界

本节是运行工程要求，不依赖提示词让模型自觉遵守。

### 13.1 最低可用隔离

- 执行器在受限容器或专用虚拟机里运行；具体选择以可支持该 CLI 和账户接入为准。
- 仅挂载当前任务 checkout 和必要的只读测试/数据；不挂载用户主目录、SSH、云凭据、Docker socket、控制面状态目录。
- 禁用提权及多余能力，限制 CPU、内存、进程数、磁盘和网络。
- worktree 的 .git 指向主仓库元数据，不能直接暴露给不受信执行器。受信服务保留 canonical worktree；执行阶段使用脱离 .git 的代码副本或受限独立克隆，结束后校验 patch 并由服务回写。
- 校验 symlink/junction、绝对路径、..、大小写/路径规范化，拒绝越界读取和写入。
- GitHub 凭据在发布服务；模型凭据尽量由固定目标代理注入，不把供应商密钥暴露给测试代码。
- 网络只开放必要模型代理与批准资源；模型代理固定上游和账号，不接受任意转发 URL。
- npm/pip 安装脚本也是不受信代码。依赖安装在无生产凭据的隔离环境进行，网络按阶段开放。
- 沙箱内不能访问控制 API，或仅使用限于该任务、不能改策略的能力令牌。

若执行器必须与控制服务同用户运行且不能可靠隔离，只能交付“有人监督试运行”，不能把 denylist、WSL 或 worktree 包装成完整沙箱。

### 13.2 权限策略

允许自动：任务范围内读写代码、离线测试、隔离构建、创建本地任务提交、生成报告。

项目级开关允许：推送指定仓库的任务分支、创建 Draft PR。

阻塞处理：删除业务目录、写主分支、强推、合并、生产部署、真实业务数据迁移、购买资源、修改安全策略、超范围读取敏感数据。

README、网页、Issue、依赖输出和模型文本都是不受信输入；其中要求读取密钥、改变策略或向外发送数据的内容不能成为授权。

### 13.3 停止与清理

硬停止 10 秒内停止所属 Agent/测试进程树并禁止新领取，UI 显示停止结果；无法确认终止时保持安全阻塞。停止不能只杀父 PID。

自动清理只能作用于登记的、归属确定的任务资源。待审、未提交、恢复中和发布状态未知的 worktree 不可清理。任何递归删除先校验规范化绝对路径与所属根目录。

## 14. 三类任务模板

### A. 软件开发

示例：给指定 API 增加分页参数校验。

输入：项目路径、接口约定、允许修改模块、现有测试。
验收：合法分页正常返回；非法值返回指定错误；已有测试通过；不改变无关接口。
交付：代码、测试、变更摘要、运行证据、待审 diff。

### B. 流量网站

示例：在现有工具站增加风速单位换算工具。

输入：固定设计、支持单位、移动端要求、数值精度。
验收：m/s、km/h 等指定单位换算正确；边界输入受控；移动端可用；构建通过；标题和描述齐全。
交付：页面代码、计算测试、冒烟截图、部署说明。
不自动上线，不承诺搜索排名、访问量和广告收益，不自动生成大量相似 SEO 页面。

### C. 气象科研

示例：为乌兰察布站点温度数据编写质量检查与基线实验脚本。

输入：授权样例数据、字段说明、缺测编码、单位、时间区间、训练/验证/测试划分。
验收：识别重复时次、异常单位和缺测；输出质量报告；按时间划分数据；固定随机种子；产出可重复基线指标。
交付：数据字典、清洗脚本、训练入口、环境锁定、运行配置、结果及数据哈希。
真实资料不默认上传模型或 GitHub。用合成/脱敏样例开发，真实数据只在指定只读数据目录处理。合成结果必须标为合成，不能用于论文实证结论。数据驱动阈值只能在训练集拟合，测试集不参与调参。

### 可导入的任务样例

```json
{
  "schemaVersion": 1,
  "tasks": [{
    "idempotencyKey": "demo-wind-converter-v1",
    "projectId": "demo-tools",
    "title": "增加风速单位换算工具",
    "description": "在现有工具页面增加 m/s 与 km/h 双向换算。",
    "scope": ["src/tools/wind", "tests/wind"],
    "category": "traffic",
    "priority": 2,
    "acceptanceProfileId": "node-standard",
    "acceptanceCriteria": [
      "10 m/s 等于 36 km/h",
      "36 km/h 等于 10 m/s",
      "空值、非数值与负值给出清晰校验提示",
      "项目已有测试与构建通过"
    ],
    "timeoutSeconds": 3600,
    "maxRepairAttempts": 2,
    "publishMode": "local_review"
  }]
}
```

projectId、路径和 profileId 为演示值，导入器必须校验对应项目实际存在。

## 15. 结果报告与运行维护

每个任务生成 result.md，并同步显示到控制台。包含：

- 原始目标、完成/未完成项、验收结论。
- baseCommit、headCommit、分支、实际修改文件和 diff 统计。
- 每项检查命令、退出码、时间、日志和证据。
- 模型、执行器版本、用量来源、耗时、修复次数。
- PR URL（若创建）、已知限制、下一步建议。
- 无法验证的事项单列，不能用“应该通过”代替结果。

每日摘要按 Asia/Shanghai 统计，包含已交付任务、待审、失败原因、等待额度时间、运行时间和未知用量；先在控制台生成，不默认发送邮件。

日志脱敏在写盘和推送 UI 之前执行；截断过长输出并标记。建议单任务日志上限 20 MiB、默认保留 14 天，报告保留 90 天，可配置。事件关键状态不得因日志轮转被删掉。

备份需要短暂停止状态写入或取得一致性快照；包含运行状态、任务分支和未提交快照，不含明文密钥。恢复在独立测试位置演练，备份文件存在不等于可恢复。

升级流程：暂停领取 → 等待/中断活动任务 → 一致性备份 → 迁移试跑 → 固定版本升级 → 核验 → 恢复。安全开关、单实例锁和状态兼容失败时不可带病启动。

## 16. 开发里程碑与任务拆分

| 阶段 | 开发内容 | 退出条件 |
|---|---|---|
| M0 | 审计上游、基线、版本固定、GLM 最小连接 | mock 跑通；live 可用性有明确记录 |
| M1 | 任务扩展、导入、状态映射、单并发调度 | 10 个 mock 任务正确完成，旧任务可读 |
| M2 | 执行器事件、可信测试、修复预算、报告 | 真实测试仓库完成“实现—失败—修复—通过” |
| M3 | 账户 hold、恢复、租约、幂等发布 | 故障矩阵通过，无重复 PR/双执行 |
| M4 | 隔离、停止、路径与权限、UI | 越权用例被真实阻断，界面可用 |
| M5 | Windows 自启动、长跑、备份恢复、交付 | 72 小时 mock 长跑 + 8 小时 live 验收 |

开发时采用小提交，按依赖顺序推进：

T01 上游审计 → T02 factory schema 与兼容测试 → T03 任务 API/导入 →
T04 调度与停止闸门 → T05 GLM 诊断和错误归类 → T06 可信验收配置 →
T07 检查点与恢复 → T08 GitHub 幂等 → T09 隔离边界 →
T10 UI → T11 运维脚本 → T12 故障注入与交付。

隔离架构在 T01 选择，不能等到 T09 才发现 runner 无法运行；T09 是完成和验证隔离，不是首次设计。无 live 凭据时推进 mock 和离线测试，禁止伪造 live 完成。

## 17. 必须通过的验收矩阵

| 编号 | 场景 | 通过标准 |
|---|---|---|
| A01 | 无 GLM 凭据 | mock 可演示，live 显示未配置 |
| A02 | 10 个任务、并发 1 | Agent/测试组合活动任务不超过 1，无遗漏 |
| A03 | P0 插队 | 等当前任务释放后优先开始，不抢占 |
| A04 | 分类公平 | 同优先级积压时按定义轮转，不饿死低权重分类 |
| A05 | 依赖链/循环 | 未满足依赖不运行；循环依赖拒绝 |
| A06 | 测试失败 | 修复最多 2 次，随后失败/阻塞 |
| A07 | Agent 口头成功 | 测试未过绝不进入 review_ready |
| A08 | 普通 429 与额度耗尽 | 分别退避与账户 hold，不混淆 |
| A09 | 额度未知 | UI 显示未知，无伪造余额或复位时间 |
| A10 | 执行中强杀服务 | 重启对账，无同时两份执行，无丢失已确认检查点 |
| A11 | 写快照时崩溃 | 可恢复上一有效版本，损坏隔离，无重复副作用 |
| A12 | push/建 PR 后丢响应 | 查询认领既有结果，无重复 PR |
| A13 | 双实例启动 | 第二个实例不能领取同一工作区任务 |
| A14 | 硬停止 | 10 秒内停止所属进程树，重启保持停止意图 |
| A15 | 路径越界/符号链接 | 主目录、凭据和控制面状态不可读写 |
| A16 | 子进程逃逸/修改测试 | 资源限制生效，可信测试入口不可绕过 |
| A17 | 断网和 gh 不可用 | 本地成果保留，发布等待，不重跑编码 |
| A18 | 磁盘不足/内存超限 | 安全停领或中断，控制台给出原因 |
| A19 | SSE 断线重连 | 数据最终一致，不重复任务 |
| A20 | 旧任务与关闭扩展 | 旧数据可读取，原功能可用 |
| A21 | 恢复备份 | 新测试目录能恢复任务与未提交成果 |
| A22 | Windows 重启 | 按声明的启动模式启动，队列不丢失 |
| A23 | 时钟/休眠恢复 | 重新评估 notBefore 与账户 hold，不重复派发 |
| A24 | 长期运行 | 满足下述 mock/live 标准 |

72 小时 mock：累计至少 100 个短任务，覆盖成功、失败、等待、取消、重启；无任务丢失和重复领取；资源稳定，没有持续单调增长的句柄/子进程；所有故障有可定位事件。内存阈值由 M0 基线确定并写入测试报告。

8 小时 live：至少 5 个小任务覆盖三个方向，真实执行 GLM、测试和一次失败修复；若套餐限制导致无法完成，报告实际完成数并标记未通过，不能以 mock 替代。一次真实故障恢复在测试仓库验证。Draft PR 若未启用，可单列为待验收；不得声称整套发布链路通过。

所有指标为项目验收目标，不是本规格书已经执行的结果。

## 18. 上游项目验证命令

截至本次读取 AGENTS.md，上游要求提交/PR 前按顺序运行：

```bash
npm run typecheck
npm test
npm run test:unit
npm run build
npm run test:package
```

变更 UI 时追加适用的 npm run test:e2e；若脚本输出 TEST_E2E_STATUS=skipped，即使退出码 0 也必须记为跳过而非通过。文档站改动遵循当前文档检查规则。

优先使用 npm 执行锁定的测试，不临时用 npx 下载另一个测试框架版本。记录上游原有失败，不能把它们掩盖，也不能在没有证据时归为“与本次无关”。

第一阶段实际工作流程：
1. 在 Zcode 打开用户自己的 Cezar Fork/本地 checkout。
2. 读取仓库 AGENTS.md、AGENT_PROTOCOL.md、BACKWARD_COMPATIBILITY.md 及相关 specs。
3. 记录提交 SHA，安装锁定依赖，运行基线。
4. 使用 CEZ_DRY_RUN=1 的上游 mock 模式验证控制台。
5. 通过固定版本 OpenCode 连接 GLM，运行测试仓库的小任务。
6. 对照缺口实现 M1—M5，不重复制造已有的调度和恢复功能。

## 19. 最终交付清单

- 可运行的 Cezar Fork 修改；保持上游 MIT 许可与版权声明。
- 本项目 spec 与 UPSTREAM_AUDIT、COMPATIBILITY、BASELINE_TESTS。
- 安装/启动/停止/自启动/卸载/备份/恢复说明和脚本。
- 三类任务模板和不少于 9 个小任务样例。
- GLM mock fixtures：成功、429、额度耗尽、401、网络断开、异常结束。
- 状态恢复、调度、公平性、安全边界、发布幂等测试。
- acceptance profiles 与 result.md 示例。
- 72 小时 mock 和 8 小时 live 验收报告，标注所有 skipped/blocked。
- CHANGELOG：改了什么、复用了什么、仍有什么限制。
- 可审查的 Git diff 与提交记录；不得自动合并或发布。

## 20. 直接发给 Zcode 的启动提示词

将本文件放到 Cezar Fork 的 docs/CEZAR_GLM_DEVELOPMENT_SPEC.md 后，复制下文：

> 请以 docs/CEZAR_GLM_DEVELOPMENT_SPEC.md 为开发规格，基于当前 Cezar 仓库完成本地自动编程任务池的增量改造。
>
> 先读取当前仓库的 AGENTS.md、AGENT_PROTOCOL.md、BACKWARD_COMPATIBILITY.md 和相关 specs，记录当前 commit SHA，核对真实技术栈、runner、任务存储、调度、恢复和 GitHub 能力。以当前代码为准，不使用未经验证的命令参数。
>
> 按 M0 到 M5 顺序推进。先审计并跑通上游 mock 与 GLM 最小编码任务，再补齐实际缺口。复用现有文件持久化、工作流和 Web，不另起 Python/SQLite 调度平台。默认并发 1、本地任务池为事实来源、最多两轮修复。优先使用现有 OpenCode runner 接 GLM Coding Plan；你是开发工具，不要求运行时必须调用 Zcode。
>
> 每个阶段实现代码、运行真实测试、更新进度和未解决问题。审计结束后继续开发，不要只输出建议。缺少 live 凭据时继续完成 mock、离线验证和实现，明确列出待验证项；不要伪造成功。
>
> 开发过程中可以修改当前工作分支并创建本地提交；不得强推、写主分支、合并、部署、删除项目或使用生产凭据。GitHub 发布功能先使用 mock 验证，真实推送/Draft PR 由测试项目配置明确启用。
>
> 对自动执行、恢复、重试、子任务和 UI 入口实行统一调度与权限约束。实现真实的停止和隔离；WSL、worktree 和提示词不能代替沙箱。若隔离验证失败，只标记有人监督试运行。
>
> 最终交付可运行实现、Windows/WSL 运维脚本、三类任务模板、故障测试和验收记录。报告区分已实现、已测试、跳过和阻塞。先从 M0 开始，并持续推进所有不受阻塞的工作。

## 21. 参考依据与版本说明

以下为本次核实来源；上游和套餐可能更新，M0 应在固定版本下再次核验。

1. Cezar 仓库与 README：https://github.com/open-mercato/cezar
2. Cezar 开发规则：https://github.com/open-mercato/cezar/blob/main/AGENTS.md
3. Cezar package.json：https://github.com/open-mercato/cezar/blob/main/package.json
4. Cezar 参考文档：https://github.com/open-mercato/cezar/blob/main/docs/reference.md
5. 智谱 Coding Plan 套餐概览：https://docs.bigmodel.cn/cn/coding-plan/overview
6. 智谱编码工具配置助手：https://docs.bigmodel.cn/cn/coding-plan/extension/coding-tool-helper
7. Zcode 模型接入：https://zcode.z.ai/en/docs/configuration
8. OpenCode CLI 文档：https://opencode.ai/v2/docs/cli

本文件第 5—20 节中 factory 字段、接口、默认阈值、任务模板、验收标准和部署流程为本项目设计；不应将其误认成上游现有功能说明。

