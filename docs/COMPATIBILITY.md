# COMPATIBILITY — 已验证 / 未验证组合（M0）

本文件只记录**已在本机实际执行过并观察到结果**的组合；未列出的即为未验证，不得当作实施依据。

## 1. 本机环境（实测，2026-11-05）

| 组件 | 版本/状态 | 来源 |
|---|---|---|
| OS | Windows 10.0.26200 x64（原生，非 WSL 内开发） | 系统信息 |
| Node | v22.20.0 ✓（满足 engines >=20） | `node --version` |
| npm | 10.9.3 | `npm --version` |
| Git | 2.33.0.windows.2 | `git --version` |
| WSL2 | 已安装；可见发行版 `docker-desktop`（版本 2） | `wsl --status` / `wsl -l -v` |
| OpenCode CLI | **未安装** | `opencode --version` → command not found |
| gh CLI | **未安装** | `gh --version` → command not found |
| GLM 凭据 | **未配置、未验证** | 无任何 bigmodel/OpenCode 配置文件 |

## 2. 已验证组合

| 组合 | 结果 | 证据 |
|---|---|---|
| Windows 原生 + Node 22.20 + cezar `71e2eb18` + `npm ci` | 依赖安装成功（锁定 lockfile） | 安装日志 exit 0 |
| Windows 原生 + Node 22 + 上游单测基线 | 见 `BASELINE_TESTS.md`（运行结果逐项记录） | `.ai/cezar-glm/baseline/*.log` |
| Git Bash 作为 shell 运行仓库脚本 | 可用（vitest/tsx 经 npm scripts 正常启动） | 基线运行 |

## 3. 未验证 / 明确不依赖的组合

| 组合 | 状态 | 对策 |
|---|---|---|
| OpenCode CLI + GLM Coding Plan（Anthropic 兼容端点 `https://open.bigmodel.cn/api/anthropic`） | **未验证**（opencode 未安装） | doctor 脚本将检查；M2 live 验收前必须安装并 `opencode auth login` 或经 `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` 注入（`core/agent-env.ts:203-226` 白名单已放行这两个变量到 opencode 子进程——代码已核实，**链路本身未实测**） |
| OpenCode CLI + GLM OpenAI 兼容端点 `https://open.bigmodel.cn/api/coding/paas/v4` | 未验证 | 同上；两协议不可互换（spec §6.1） |
| `npx @z_ai/coding-helper` 配置助手 | 包可下载（0.1.1，`--version` 实测）；**交互式配置 GLM+OpenCode 未执行** | 仅作为安装文档提示；不写入任何脚本 |
| WSL2 Ubuntu 内运行 cezar 服务 | 未验证（本机仅有 docker-desktop 发行版） | spec §5 建议项；M5 交付时按实际机器配置 Ubuntu 后再验证 |
| gh Draft PR 发布链路 | **未验证**（gh 未安装） | `createDraftPr` 在无 gh 时返回 `{ok:false}`（代码保证不抛错）；mock 发布先行 |
| CodeBuddy（WorkBuddy 的 CLI）runner | **已实现、未 live 验证**：CLI 未安装。实现依据其官方 CLI 参考（与 Claude Code 逐旗标兼容的 stream-json 头less 模式）；fixtures 为 claude 捕获副本，出处记于 `__fixtures__/codebuddy/README.md`。两个未核实旗标：`--session-id`、`--append-system-prompt-file` | 安装后跑 `node scripts/factory/doctor.mjs` → 最小任务实测 → 用真实转录替换 fixtures 并补录本表 |
| CEZ_DRY_RUN=1 mock 控制台 | 待基线测试覆盖（上游 e2e 即用此模式） | M0 收尾运行 |
| Windows 原生信号语义 | 代码已核实：Node 在 win32 将 SIGTERM 映射为 TerminateProcess 且**仅杀子进程本身**（`opencode-server-runner.ts:371-379` 无 tree-kill 分支） | factory 硬停止必须自行实现进程树终止（`taskkill /T`），不依赖上游 |

## 4. 版本固定约定

- 上游代码：锁定 fork 的 `main` @ `71e2eb181dda0839c981aa3532daa69d8fab021c`；升级须重跑 `BASELINE_TESTS.md` 全套。
- Node：使用本机 v22 LTS 系（不追 nightly）；若迁 WSL，在发行版内固定同大版本。
- 执行器：安装 OpenCode 后**记录精确版本号**写入本文件 §5，浮动版本不进入验收。
- 所有 `CEZ_*` 环境变量的权威清单 = 仓库根 `.env.example` + `docs/reference.md`（AGENTS.md 要求同提交更新）。

## 5. 待补录（live 验收通过后填写）

```
OpenCode 版本：____
GLM 套餐标识别名：____
实际可用模型（provider/model）：____
最小编码任务（测试仓库创建函数+测试并运行）：____ 通过/失败
事件捕获（text/tool/usage/session）：____
取消执行树：____
端点类型：anthropic 兼容 / openai 兼容（勾选）
```

> 规格书 §2 要求：不得把未验证组合表述为可用。上表任何空白都意味着对应能力**未验收**。
