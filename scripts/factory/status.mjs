/**
 * factory status (spec §5): 服务、任务、额度状态和最近心跳。Exit 0 running / 1 down.
 */
import { fetchJson, factoryHome, healthUrl, isAlive, join, log, mtimeOf, readPid, DEFAULT_PORT, serverLog, existsSync, statSync } from './_lib.mjs';

const port = Number(process.env.CEZ_PORT || DEFAULT_PORT);
const pid = readPid();
const pidAlive = pid && processAliveSafe(pid);
const alive = await isAlive(port);

log(`factory status — ${new Date().toISOString()}`);
log(`  server: ${alive ? `UP on :${port}` : 'DOWN'}${pid ? ` · pid ${pid}${pidAlive ? '' : ' (record stale)'}` : ' · no pid record'}`);

if (alive) {
  const { body: health } = await fetchJson(healthUrl(port));
  log(`  version: ${health?.version} · boot project: ${health?.bootProject}`);
  const { status, body: factory } = await fetchJson(healthUrl(port).replace('/health', '/factory/status'));
  if (status === 200 && factory) {
    log(`  factory: ${factory.stopped ? 'STOPPED' : factory.paused ? 'PAUSED' : 'RUNNING'} · concurrency ${factory.concurrency}`);
    log(`  tasks: ${JSON.stringify(factory.counts)}`);
    log(`  budget: ${factory.dailyBudget.startedToday}/${factory.dailyBudget.maxNewTasksPerDay} (${factory.dailyBudget.timeZone})`);
    if (factory.activeTaskId) log(`  active: ${factory.activeTaskId}`);
    for (const a of factory.accounts ?? []) log(`  hold: ${a.account}${a.heldUntil ? ` until ${a.heldUntil}` : ' — reset 未知'}`);
    log(`  disk: ${factory.diskFreeBytes == null ? '未知' : `${Math.round(factory.diskFreeBytes / 2 ** 30)} GiB free`}`);
  } else {
    log(`  factory status: HTTP ${status}`);
  }
}

const instance = join(factoryHome(), 'factory', 'instance.json');
log(`  instance heartbeat: ${mtimeOf(instance) || 'none'}`);
const controls = join(factoryHome(), 'factory', 'controls.json');
log(`  controls mtime: ${mtimeOf(controls) || 'none'}`);
if (existsSync(serverLog())) {
  const sizeKiB = Math.round(statSync(serverLog()).size / 1024);
  log(`  log: ${serverLog()} (${sizeKiB} KiB)`);
}

process.exit(alive ? 0 : 1);

function processAliveSafe(p) {
  try {
    process.kill(p, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}
