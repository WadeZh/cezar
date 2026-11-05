/**
 * factory fault-drill (spec §16 T12 / 验收矩阵): injects the automatable faults
 * against a SCRATCH repo and reports pass/fail per scenario:
 *   A13 — double instance: a second serve on the same repo hands off, never double-serves.
 *   A14 — hard stop: POST /factory/stop tree-kills the active task and keeps the
 *         stopped intent across a restart.
 *   A10 — kill mid-run: SIGKILL the server mid-task; on restart the run is
 *         reconciled (no two executors on one task) and the pool resumes cleanly.
 * Usage: node scripts/factory/fault-drill.mjs  (scratch dirs under the OS temp)
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DEFAULT_PORT, fetchJson, healthUrl, isAlive, killTree, log, repoRoot, serverEntry } from './_lib.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'cezar-fault-drill-'));
const repo = join(scratch, 'repo');
const home = join(scratch, 'home');
const port = Number(process.env.CEZ_DRILL_PORT || DEFAULT_PORT + 7);
const results = [];

function git(args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function setup() {
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# fault drill\n');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, '-c', 'user.email=drill@test', '-c', 'user.name=drill', 'commit', '-qm', 'init']);
  // a counter check that NEVER passes → the task stays active for the drills
  writeFileSync(join(repo, 'check-fail.js'), "process.exit(1);\n");
  mkdirSync(join(repo, '.ai', 'cezar', 'factory'), { recursive: true });
  writeFileSync(join(repo, '.ai', 'cezar', 'factory', 'profiles.json'), JSON.stringify({
    profiles: { 'drill-standard': { executable: 'node', args: ['check-fail.js'], timeoutMs: 30_000 } },
  }), 'utf8');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, '-c', 'user.email=drill@test', '-c', 'user.name=drill', 'commit', '-qm', 'check']);
}

let serverPid;
function startServer(extraEnv = {}) {
  const child = spawn(process.execPath, [serverEntry(repoRoot()), 'serve', '--repo', repo, '--port', String(port), '--no-open'], {
    cwd: repo,
    env: { ...process.env, CEZ_DRY_RUN: '1', CEZ_HOME: home, CEZ_NO_BANNER: '1', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  serverPid = child.pid;
  const out = [];
  child.stdout.on('data', (d) => out.push(String(d)));
  child.stderr.on('data', (d) => out.push(String(d)));
  child._tail = () => out.join('').slice(-2000);
  return child;
}

async function waitHealth(timeoutMs = 30_000) {
  for (let i = 0; i < timeoutMs / 1000; i++) {
    if (await isAlive(port)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function importTask(key) {
  const { status } = await fetchJson(healthUrl(port).replace('/health', `/p/${basename(repo)}/factory/tasks/import`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tasks: [{
      key,
      title: `drill ${key}`,
      description: `fault drill task ${key}. mock:done`,
      scope: ['.'],
      acceptanceCriteria: ['never passes (drill)'],
      acceptanceProfileId: 'drill-standard',
      category: 'software',
      priority: 1,
      timeoutSeconds: 900,
      maxRepairAttempts: 2,
      publishMode: 'local_review',
    }] }),
  }, 15_000);
  return status === 200;
}

async function factoryStatus() {
  const { body } = await fetchJson(healthUrl(port).replace('/health', '/factory/status'));
  return body;
}

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  log(`  ${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? ` (${detail})` : ''}`);
}

async function main() {
  log(`factory fault-drill — scratch ${scratch}`);
  setup();

  // ---- A13: double instance -------------------------------------------------------------
  const first = startServer();
  if (!(await waitHealth())) {
    log(first._tail());
    fail('first server did not boot');
  }
  const second = startServer();
  let secondExited = false;
  second.on('exit', () => (secondExited = true));
  await new Promise((r) => setTimeout(r, 6000));
  // Upstream singleton handoff: the SECOND serve exits after pointing at the live one.
  const firstStillHealthy = (await factoryStatus())?.counts !== undefined;
  record('A13 双实例：第二个进程让位（handoff/退出），不双服', secondExited && firstStillHealthy,
    secondExited ? 'second exited (handed off), first healthy' : `second still alive (exited=${secondExited})`);
  try { second.kill(); } catch { /* fine */ }

  // ---- A14 + A10: active task, hard stop, restart keeps the intent ----------------------
  await importTask('drill-a14');
  await new Promise((r) => setTimeout(r, 8000));
  const mid = await factoryStatus();
  record('A10 前置：任务确已激活', (mid?.counts?.running ?? 0) >= 1, JSON.stringify(mid?.counts));

  const { status: stopStatus } = await fetchJson(healthUrl(port).replace('/health', '/factory/stop'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason: 'drill A14' }),
  }, 20_000);
  record('A14 硬停止被接受', stopStatus === 200, `HTTP ${stopStatus}`);

  // the stopped intent must survive a restart
  try { await killTree(serverPid); } catch { /* already down */ }
  await new Promise((r) => setTimeout(r, 1500));
  const restarted = startServer();
  if (!(await waitHealth())) {
    log(restarted._tail());
    fail('restarted server did not boot');
  }
  const after = await factoryStatus();
  record('A14 停止意图跨重启保持', after?.stopped === true, `stopped=${after?.stopped}`);

  // resume, then the A10 kill drill
  await fetchJson(healthUrl(port).replace('/health', '/factory/resume'), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
  }, 10_000);
  await importTask('drill-a10');
  await new Promise((r) => setTimeout(r, 6000));
  // SIGKILL the server mid-run (the agent mock + engine die with it)
  try { await killTree(serverPid); } catch { /* racing exit */ }
  await new Promise((r) => setTimeout(r, 1500));
  const third = startServer();
  if (!(await waitHealth())) {
    log(third._tail());
    fail('post-kill server did not boot');
  }
  await new Promise((r) => setTimeout(r, 8000));
  const recovered = await factoryStatus();
  // one engine owns the task: no double-running, and the ledger is intact
  const tasks = await fetchJson(healthUrl(port).replace('/health', `/p/${basename(repo)}/factory/tasks?limit=10`));
  const rows = tasks.body?.tasks ?? [];
  const doubleQueued = rows.filter((t) => t.lifecycle === 'running').length;
  record('A10 强杀后重启：无双执行，台账完整', doubleQueued <= 1 && rows.length === 2, `rows=${rows.length} running=${doubleQueued} stopped=${recovered?.stopped}`);

  // ---- cleanup ---------------------------------------------------------------------------
  try { await killTree(serverPid); } catch { /* fine */ }
  if (!process.env.CEZ_DRILL_KEEP) {
    try {
      rmSync(scratch, { recursive: true, force: true });
    } catch {
      // Windows EBUSY on worktree handles — the scratch stays under the OS temp, harmless.
      log(`(scratch left at ${scratch} — cleanup hit a file lock)`);
    }
  }

  const failed = results.filter((r) => !r.ok);
  log('');
  log(`drill 结果：${results.length - failed.length}/${results.length} PASS${failed.length ? ` — FAILED: ${failed.map((f) => f.name).join('; ')}` : ''}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (err) => {
  log(`drill crashed: ${err?.stack ?? err}`);
  try { await killTree(serverPid); } catch { /* fine */ }
  process.exit(1);
});