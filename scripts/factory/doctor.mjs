/**
 * factory doctor (spec §5): 版本、CLI 登录、Git、目录、磁盘、端口、模型调用自检。
 * Never prints a secret — env presence is reported as set/unset only (spec §6.2.1).
 * Exit 0 = everything a live GLM run needs is present; 1 = at least one BLOCKER.
 */
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { promisify } from 'node:util';
import {
  DEFAULT_PORT,
  factoryHome,
  healthUrl,
  fetchJson,
  join,
  log,
  mtimeOf,
  readPid,
  serverEntry,
  serverLog,
} from './_lib.mjs';

const execFileAsync = promisify(execFile);
const BLOCKERS = [];
const WARNS = [];

function check(name, ok, detail, blocker = false) {
  const mark = ok ? '✓' : blocker ? '✗' : '!';
  log(`  ${mark} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok && blocker) BLOCKERS.push(name);
  if (!ok && !blocker) WARNS.push(name);
}

async function version(cmd, args) {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: 10_000, windowsHide: true });
    return stdout.trim().split(/\r?\n/)[0] || 'present';
  } catch {
    return null;
  }
}

async function main() {
  log(`factory doctor — ${new Date().toISOString()}`);

  // 1. runtime
  const nodeOk = process.versions.node.startsWith('20') || process.versions.node.startsWith('22') || Number(process.versions.node.split('.')[0]) >= 20;
  check('Node >= 20', nodeOk, `v${process.versions.node}`, true);

  // 2. built server (start runs the fixed local build, never a floating npx)
  let entry = null;
  try {
    entry = serverEntry();
    check('built server', true, entry);
  } catch (err) {
    check('built server', false, String(err.message), true);
  }

  // 3. git
  const gitV = await version('git', ['--version']);
  check('git', !!gitV, gitV ?? 'not found', true);

  // 4. gh (optional for local_review; required for draft-PR publishing)
  const ghV = await version('gh', ['--version']);
  check('gh CLI', !!ghV, ghV ?? 'not found (draft-PR publishing disabled)', false);

  // 5. opencode (the GLM executor)
  const ocV = await version('opencode', ['--version']);
  check('OpenCode CLI', !!ocV, ocV ?? 'not found — install OpenCode to run GLM tasks (docs/COMPATIBILITY.md §3)', true);

  // 6. GLM wiring: which env names EXIST, never their values (spec: 不能输出密钥)
  const anthropicBase = process.env.ANTHROPIC_BASE_URL;
  const anthropicAuth = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
  const openaiBase = process.env.OPENAI_BASE_URL;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (ocV) {
    const viaAnthropic = !!anthropicBase && !!anthropicAuth;
    const viaOpenai = !!openaiBase && !!openaiKey;
    check(
      'GLM 端点配置（经环境变量传给 opencode 子进程）',
      viaAnthropic || viaOpenai,
      viaAnthropic
        ? `ANTHROPIC_BASE_URL=${anthropicBase} + ANTHROPIC_AUTH_TOKEN=<set>`
        : viaOpenai
          ? `OPENAI_BASE_URL=${openaiBase} + OPENAI_API_KEY=<set>`
          : '未检测到 — 运行 opencode auth login 或设置 ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN（见 docs/factory/README.md）',
      false,
    );
  }

  // 7. CEZ_HOME + factory state
  const home = factoryHome();
  check('CEZ_HOME', existsSync(home), home);
  const statePath = join(home, 'factory', 'controls.json');
  check('factory controls', existsSync(statePath), existsSync(statePath) ? `mtime ${mtimeOf(statePath)}` : 'fresh (created on first run)');
  const instancePath = join(home, 'factory', 'instance.json');
  check('factory instance', existsSync(instancePath), existsSync(instancePath) ? `mtime ${mtimeOf(instancePath)}` : 'no instance yet');

  // 8. disk (spec §9.2: 开启任务前建议剩余磁盘不少于 10 GiB)
  try {
    const { statfsSync } = await import('node:fs');
    const freeGiB = statfsSync(home || process.cwd()).bavail * statfsSync(home || process.cwd()).bsize / 2 ** 30;
    check('磁盘余量', freeGiB >= 10, `${freeGiB.toFixed(1)} GiB free ${freeGiB < 10 ? '(< 10 GiB — 调度器会保守停领)' : ''}`);
  } catch {
    WARNS.push('disk');
    log('  ! 磁盘余量 — 无法探测（statfs 不可用）');
  }

  // 9. port — live server wins; otherwise the port must be bindable
  const port = Number(process.env.CEZ_PORT || DEFAULT_PORT);
  const alive = await (async () => {
    try {
      const { status } = await fetchJson(healthUrl(port), undefined, 2500);
      return status === 200;
    } catch {
      return false;
    }
  })();
  let bindable = false;
  if (!alive) {
    bindable = await new Promise((resolve) => {
      import('node:net').then(({ createServer }) => {
        const srv = createServer();
        srv.once('error', () => resolve(false));
        srv.once('listening', () => srv.close(() => resolve(true)));
        srv.listen(port, '127.0.0.1');
      });
    });
  }
  check(`端口 ${port}`, alive || bindable, alive ? 'server responding' : bindable ? 'free' : 'occupied by something else');
  if (alive) {
    const { body } = await fetchJson(healthUrl(port));
    const version = body?.version;
    const bootProject = body?.bootProject;
    log(`      server: v${version} · boot project: ${bootProject}`);
    const pid = readPid();
    check('pid 记录', !!pid, pid ? `${pid}${serverLog() ? '' : ''}` : 'server running without a pid file (started outside factory/start)');
  }

  // 10. server log presence (最近心跳的旁观证据)
  if (existsSync(serverLog())) {
    const size = statSync(serverLog()).size;
    check('server log', true, `${serverLog()} (${Math.round(size / 1024)} KiB)`);
  }

  log('');
  if (BLOCKERS.length > 0) {
    log(`结果：BLOCKED — ${BLOCKERS.join(', ')}`);
    process.exit(1);
  }
  log(`结果：OK${WARNS.length ? `（警告 ${WARNS.length} 项：${WARNS.join(', ')}）` : ''}`);
}

    bindable = await new Promise((resolve) => {
      import('node:net').then(({ createServer }) => {
        const srv = createServer();
        srv.once('error', () => resolve(false));
        srv.once('listening', () => srv.close(() => resolve(true)));
        srv.listen(port, '127.0.0.1');
      });
    });main().catch((err) => {
  process.stderr.write(`[factory] doctor failed: ${err}\n`);
  process.exit(1);
});
