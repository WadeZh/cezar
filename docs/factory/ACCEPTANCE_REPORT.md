# Cezar-GLM 验收报告（截至 2026-11-05，分支 `factory/main`）

规格：`docs/CEZAR_GLM_DEVELOPMENT_SPEC.md` §17 验收矩阵 + §19 交付清单。
原则：报告区分**已实现 / 已测试 / 跳过 / 阻塞**；不伪造成功。

## 1. 已实现且已测试（真实执行证据）

| 交付 | 证据 |
|---|---|
| M0 审计四件套 | docs/UPSTREAM_AUDIT、COMPATIBILITY、BASELINE_TESTS、IMPLEMENTATION_PLAN |
| factory schema（contract，zod） | contract-parity.factory.test ✓；bc-route-inventory / route-parity / versioned-surface ✓ |
| RunRecord.factory 可选扩展（旧数据可读 A20） | store 单测 + 10 任务真实运行 ✓ |
| REST：tasks CRUD / import / actions / report；workspace status/pause/stop/resume/usage | HTTP 实测（M1/M4 e2e、ops smoke）✓ |
| 批量导入（≤100、整批预检、逐项错误、幂等重放、循环拒绝） | 单测 + HTTP 实测（duplicate/conflict/dependency_cycle）✓ |
| 生命周期状态机 + 审计事件（spec §8 全表） | factory-core.test ✓；运行事件落 NDJSON ✓ |
| 调度：用户 FIFO 优先 → P0 → 老化(6h→P1) → WFQ 5:3:2；pump 级选择器（默认路径逐字节不变） | factory-engine.test（10 任务轮转 5/3/2 精确）+ M1 e2e 10 任务 ✓ |
| 可信验收 profile → argv（无 shell）+ 必填超时；路径越界/shell 元字符拒绝 | factory-acceptance.test ✓ |
| 修复循环：实现→检查→修复≤2（A06）；测试不过绝不 review_ready（A07） | 真实仓库"失败→修复→通过"e2e ✓（retriesUsed=2 持久化） |
| 墙钟超时（timeoutSeconds，单调判定→failed 审计） | runner 单测 ✓ |
| result.md（事实/未知/无法验证单列，A09 语义） | 生成+路由返回 ✓；M2 e2e 输出核对 ✓ |
| 工作区调度租约（单实例派发/预算） | factory-m3.test（互斥/序列化）✓ |
| 检查点（intent 先于副作用、settle 记 git 事实、清扫） | factory-m3.test ✓ |
| 幂等发布（intent 先落盘、认领优先、分叉 blocked 不强推，A12） | factory-m3.test（mock forge）✓ |
| 硬停止（树杀、10s 预算、不确定→blocked、意图跨重启，A14） | factory-hardstop.test（真实 Windows 进程树）✓ |
| 额度分类：普通 429≠耗尽（A08）、401 闩锁、reset 未知不伪造（A09） | factory-glm-fixtures.test 9/9 ✓ |
| 控制台任务池页面（计数/预算/hold 未知/操作按钮/result.md 面板） | 真实浏览器渲染 + retry→200→自动刷新 ✓ |
| 运维脚本 doctor/start/stop/status/backup/restore + autostart.ps1 | 本机 smoke 全链路（start→import→backup→stop[killed 1]→restore[7 文件校验]）✓ |
| 故障演练 A10/A13/A14 | fault-drill 5/5 PASS ✓ |
| 任务模板与样例 | docs/factory/templates/tasks-samples.json（3 类 10 个，含依赖链与 notBefore） |
| GLM mock fixtures | fixtures/factory-glm/（6 场景）+ 分类测试 ✓ |
| CHANGELOG | 顶部条目（改了什么/复用了什么/限制） |

## 2. 已实现、待 live 验证（阻塞清单）

| 项 | 阻塞原因 | 解除动作 |
|---|---|---|
| OpenCode→GLM live 编码任务（§6.2 全部 5 项连接测试） | OpenCode 未安装、GLM 凭据未配置 | 安装 + `doctor` 转 OK + 最小任务实测，补录 COMPATIBILITY §5 |
| Draft PR 发布链路 live | gh 未安装 | `gh auth login` 后对测试项目启用 publishMode=draft_pr |
| 8h live 验收（≥5 任务、3 方向、一次真实故障恢复） | 同上 | 按 spec §17 执行并记录；无法完成时如实报数 |
| 72h mock 长跑（≥100 任务、无泄漏、A24） | 长时项 | `CEZ_DRY_RUN=1` 下执行脚本化压测并出报告 |
| A11 写快照时崩溃（进程级 kill 竞态窗口） | 需定向故障注入（kill during atomic write） | 单元层已有原子写损坏隔离测试；进程级演练待补 |

## 3. 明确未实现 / 跳过

- **额度未知探测闸**（单探测任务、退避延长）——hold + auto-resume 已覆盖等待语义，探测是优化；见 CHANGELOG 限制节。
- **无人值守隔离声明**——spec §13 隔离验收未做；当前定位为**有人监督试运行**。
- A16 子进程逃逸/资源上限细粒度验证——上游 cgroup 探测在 win32 降级，依赖执行器不越界的目录/凭据边界（agent-env 白名单已验证），完整沙箱评估未做。
- `npm run test:e2e`（浏览器冒烟）——需 agent-browser 供应；本机浏览器验证已人工完成并记录。

## 4. 平台备注

- Windows 原生为开发参照系；上游既有平台失败与 EBUSY 清理噪声见 BASELINE_TESTS.md（未掩盖）。
- spec §5 建议的 WSL2 部署形态未在本机验证（仅有 docker-desktop 发行版）——文档如实标注。

## 5. 提交清单

| 提交 | 内容 |
|---|---|
| 492692fe | M0 审计 + factory 骨架 |
| 8ac3460a | 调度修正（P0 不老化、WFQ） |
| 9f17eb3e | M1 任务池 API/导入/调度 |
| b37ca21a | M2 验收 profile/argv/修复预算/报告 |
| 59646a93 | XOR refine 修复 |
| 08af9ca2 | M3 租约/检查点/发布 intent |
| ce42336a | M4 硬停止 + 任务池页面 |
| 本提交 | M5 运维脚本/自启动/故障演练/fixtures/模板/文档/CHANGELOG |
