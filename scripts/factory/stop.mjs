/**
 * factory stop (spec §5): hard stop through the API first (tree-kills active
 * tasks and records the stopped intent), then terminate the server process
 * tree and clear the pid record.
 */
import { clearPid, fail, fetchJson, isAlive, killTree, log, mtimeOf, readPid, DEFAULT_PORT, healthUrl } from './_lib.mjs';

const port = Number(process.env.CEZ_PORT || DEFAULT_PORT);

if (await isAlive(port)) {
  // 1. hard stop through the service: tree-kills active tasks (10s budget),
  //    records the stopped intent, survives restarts.
  const { status, body } = await fetchJson(healthUrl(port).replace('/health', '/factory/stop'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason: 'factory stop script' }),
  }, 15_000);
  if (status === 200) {
    const killed = body?.killed?.length ?? 0;
    const uncertain = body?.uncertain?.length ?? 0;
    log(`hard stop accepted — killed ${killed}, uncertain ${uncertain} (${body?.elapsedMs ?? '?'} ms)`);
    for (const u of body?.uncertain ?? []) log(`  ⚠ uncertain: ${u.taskId} — ${u.reason}`);
  } else {
    log(`hard stop answered ${status} — continuing with process termination`);
  }
} else {
  log('server not answering — stopping by pid record only');
}

// 2. terminate the server process tree.
const pid = readPid();
if (pid && processAliveSafe(pid)) {
  try {
    await killTree(pid);
    log(`server tree terminated (${pid})`);
  } catch (err) {
    fail(`could not terminate server tree ${pid}: ${err.message}`);
  }
} else {
  log(pid ? `pid ${pid} not alive — clearing stale record` : 'no pid record');
}
clearPid();
log(`stopped. controls.json keeps stopped:true — resume with scripts/factory/resume or POST /factory/resume (mtime ${mtimeOf(pidFileMention())})`);

function processAliveSafe(p) {
  try {
    process.kill(p, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}
function pidFileMention() {
  return '<home>/factory/controls.json';
}
