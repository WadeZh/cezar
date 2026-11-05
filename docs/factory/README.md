# Cezar-GLM 任务池运维手册（M5 交付）

规格：`docs/CEZAR_GLM_DEVELOPMENT_SPEC.md` · 本仓库改动见 `CHANGELOG.md` 与 `docs/IMPLEMENTATION_PLAN.md`。
所有脚本零依赖（Node 内置模块），路径含空格可用；PowerShell 仅用于自启动安装。

## 0. 安装（一次性）

```bash
npm ci                # 锁定依赖
npm run build         # tsc → dist/ + vite → web/dist + check:pack（start 使用该产物）
node scripts/factory/doctor.mjs   # 自检：版本/CLI/目录/磁盘/端口（不输出密钥）
```

doctor 报告的 BLOCKER 必须先解决（如 OpenCode 未安装）。GLM 接线方式二选一：

1. `opencode auth login`（OpenCode 自己的凭据库）；或
2. 环境变量经 `buildChildEnv` 白名单直达 opencode 子进程：
   `ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api/anthropic` + `ANTHROPIC_AUTH_TOKEN=<你的 key>`
   （或 OpenAI 兼容端点 `https://open.bigmodel.cn/api/coding/paas/v4` + `OPENAI_API_KEY`。两协议不可互换。）

## 1. 启动 / 停止 / 状态

```bash
node scripts/factory/start.mjs     # 单例：已在跑则幂等退出 0；pid 写入 <CEZ_HOME>/factory/server.pid
node scripts/factory/status.mjs    # 服务/任务/额度/心跳；exit 0=运行中
node scripts/factory/stop.mjs      # 先 POST /factory/stop（树杀活动任务、记停止意图），再杀服务进程树
```

- `stop` 后 `controls.json` 保持 `stopped:true` —— 重启也保持停止意图（A14），恢复需显式：
  `curl -X POST http://127.0.0.1:4321/api/v1/factory/resume` 或控制台「恢复调度」。
- 服务绑定 127.0.0.1，不开公网端口。

## 2. 任务导入

```bash
curl -X POST http://127.0.0.1:4321/api/v1/p/<projectId>/factory/tasks/import \
  -H 'content-type: application/json' \
  --data @docs/factory/templates/tasks-samples.json
```

整批预检（≤100 条），逐项返回 `created | duplicate | error`；同一 key 同 payload 重放=幂等，异 payload=409。
控制台：Tasks 页头「任务池」→ `/p/<projectId>/factory`。

## 3. 自启动（Windows 计划任务）

```powershell
powershell -ExecutionPolicy Bypass -File scripts\factory\install-autostart.ps1          # 安装（登录时、隐藏窗口）
powershell -ExecutionPolicy Bypass -File scripts\factory\install-autostart.ps1 -Uninstall # 卸载
```

- 声明边界：这是**用户登录后自启动**；"未登录也能运行"（ONSTART + 无头会话、电源策略）需按本机单独验证后才可声明。
- 电脑睡眠/关机期间不计算；唤醒后调度器按 `notBefore` 与账户 hold 重新评估（A23）。

## 4. 备份 / 恢复

```bash
node scripts/factory/backup.mjs    # 一致性：软暂停+等待排空 → 复制状态/分支/未提交快照 → manifest(sha256)
node scripts/factory/restore.mjs <backup-dir>   # 校验 sha256 → 停服 → 覆盖 → 不重放任务
```

- 备份**不含**明文密钥（agent-accounts / tracker-connections / secrets 明确排除，见备份内 EXCLUDED.txt）。
- worktree 未提交成果以 `git stash create` 记录（不触碰工作树）；恢复时留在项目 stash 里，由人工决定。
- 恢复把旧状态改名保留（`.pre-restore-<ts>`），可回滚；恢复后启动服务由 `recover()` 对账（A10/A11）。
- **备份文件存在不等于可恢复**：restore 全量 sha256 校验失败即中止。

## 5. 故障演练

```bash
node scripts/factory/fault-drill.mjs
```

注入 A13（双实例让位）、A14（硬停止+跨重启保持）、A10（强杀后重启对账，无双执行）。全部 PASS 输出 exit 0。

## 6. 验收状态（诚实清单）

| 项 | 状态 |
|---|---|
| A01 无凭据 mock 演示 / live 显示未配置 | mock ✓；live 未验收（OpenCode/GLM 未配置） |
| A02–A07、A09、A15(部分)、A20 | 单测 + e2e 覆盖 ✓ |
| A08 429 vs 耗尽 | fixtures + 分类器单测 ✓（live 待验） |
| A10/A13/A14 | fault-drill 实测 ✓ |
| A12 幂等发布 | mock 级单测 ✓（gh 未装，live 待验） |
| 72h mock 长跑 / 8h live | **未执行**——长时项，按 spec §17 独立执行并记录 |
| 无人值守隔离 | 未声明（spec §13：隔离验收通过前只允许有人监督试运行） |
