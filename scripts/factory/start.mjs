/**
 * factory start (spec §5): 单例启动 — already-alive answers and exits 0; otherwise
 * spawn the BUILT server detached (no extra console window), record the pid, and
 * wait for /health before declaring success.
 */
import { DEFAULT_PORT, clearPid, fail, isAlive, log, readPid, repoRoot, serverEntry, serverLog, spawnDetached, writePid } from './_lib.mjs';

const port = Number(process.env.CEZ_PORT || DEFAULT_PORT);
const repoArg = process.env.CEZ_REPO || repoRoot();
const entry = serverEntry();

if (await isAlive(port)) {
  log(`factory server already running on port ${port} — nothing to do`);
  const pid = readPid();
  if (pid) log(`pid: ${pid}`);
  process.exit(0);
}

const stale = readPid();
if (stale && !processAliveSafe(stale)) {
  clearPid();
  log(`cleared stale pid record (${stale})`);
}

const pid = spawnDetached(entry, ['serve', '--repo', repoArg, '--port', String(port), '--no-open'], repoArg, serverLog());
writePid(pid);
log(`spawned pid ${pid} → ${serverLog()}`);

for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  if (await isAlive(port)) {
    log(`factory is up → http://127.0.0.1:${port}/p/  (cockpit)`);
    process.exit(0);
  }
  if (!processAliveSafe(pid)) {
    fail(`server process ${pid} exited during startup — see ${serverLog()}`);
  }
}
fail(`server did not answer /health within 30s — see ${serverLog()}`);

function processAliveSafe(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}
