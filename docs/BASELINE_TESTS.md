# BASELINE_TESTS — 上游基线（commit `71e2eb18`，M0）

环境：Windows 10.0.26200 原生 + Node v22.20.0 + npm 10.9.3。原始日志在 `.ai/cezar-glm/baseline/`（不入库）。

## 结果总表（2026-11-05 实测）

| 命令 | 退出码 | 汇总 |
|---|---|---|
| `npm ci` | 0 | 锁定依赖安装成功 |
| `npm run typecheck` | **0** | contract + api-client + server + web + release 全部通过 |
| `npm test`（vitest 全仓库） | 1 | 889 文件：**735 通过 / 148 失败 / 6 跳过**；14128 用例：**13534 通过 / 539 失败 / 55 跳过**；1 个未处理 rejection |
| `npm run test:unit`（node:test） | 1 | 50 用例：46 通过 / **3 失败** / 1 跳过 |
| `npm run build` | 见下方补录 | |
| `npm run test:package` | 见下方补录 | |

## 失败原因剖析（关键：区分上游既有失败 vs 环境噪声）

vitest 622 个 FAIL 标记中：
- **152+ 为 `Test timed out in 5000ms`**、6 个 `run did not finish in time` —— 全仓 14128 用例并行压满本机 CPU（tests 累计 10885 秒），属于**机器过载超时噪声**，不是断言失败。重跑单项大多会过。
- **~70 个真实断言失败**（AssertionError 等），集中在 tracker 锁、git-diff-base、test-env-launcher 类 POSIX/时序敏感用例。
- 5 个 `spawn EFTYPE` —— Windows 专属 spawn 兼容问题。
- 1 个未处理 rejection：`usage-identity.test.ts`（"Scheduled account binding changed"）——测试自身记录的已知模式。

test:unit 的 3 个失败全部是 `spawnSync /bin/sh ENOENT`（`test/unit/test-env-launcher.test.ts`）——测试硬编码 POSIX shell，**原生 Windows 上游既有失败**。

### M2 期间补充观察（2026-11-05）
- `graph-run.test.ts` / `check-retry-on.test.ts` 在 Windows 上 afterEach `rmSync` 出现 **EBUSY 清理失败**（断言全部通过，失败数随机器负载在 3-6 间浮动；上游原版同跑 3-4 个）——既有平台噪声，非 factory 改动引入（改动仅为 command 检查路径增加 unref'd 超时定时器与 argv 分支）。

### 判定方法
- 失败文件与 factory 增量（contract/factory.ts、store.ts/run.ts 的 optional `factory` 字段）无交集；factory 字段为纯 optional + `.catch(undefined)`，typecheck 全绿。
- 超时类失败与用例内容无关（同文件重跑波动）——按 AGENTS.md 要求如实记录，不掩盖也不武断归因"与本次无关"。

## 环境限制（影响验收解读）

1. 原生 Windows 不是上游首选验证平台：POSIX shell 依赖（`/bin/sh`）、信号语义、路径大小写都会产生平台差失败。spec §5 的 WSL2 部署是目标形态；本基线为"Windows 原生"参照系。
2. 全套件在本机并行会过载 → **后续验证用限定 worker 数运行**（`npm test -- --maxWorkers=4`），并只对失败子集做三连判定（重跑/隔离/对照）。
3. `npm run test:e2e` 未运行：需要 agent-browser 供应，且按仓库契约 `TEST_E2E_STATUS=skipped` 不算通过——留到 M4 UI 阶段再记录。

## 上游原有失败清单（断言类，重跑仍需关注）

| 领域 | 文件（示例） | 现象 |
|---|---|---|
| tracker 凭据锁 | `src/server/tracker/*` | 锁时序断言失败/超时 |
| git 基线解析 | `src/git-diff-base.test.ts` | diverged/stale 分支判定差异 |
| 测试环境启动器 | `test/unit/test-env-launcher.test.ts` | `/bin/sh ENOENT`（Windows 平台限制） |
| spawn 兼容 | `src/core/*`（5 例） | `spawn EFTYPE` |

> 完整原始日志保留于工作区 `.ai/cezar-glm/baseline/`（gitignore 内）。M1 起的每次验证以"不新增失败"为准：新增失败必须归因修复或显式记录。

## 补录区

```
BUILD_EXIT=0          # tsc + vite + check:pack（1293 files, shell+assets present）
TEST_PACKAGE_EXIT=0   # 34/34 通过
```
