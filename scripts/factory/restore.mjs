/**
 * factory restore (spec §5/§15): 校验 manifest 的 sha256 → 停服务 → 覆盖项目状态与
 * workspace controls → 不重放任务（下次启动由上游 recover() 对账；spec §11.2）。
 * worktree 未提交快照作为 git stash 留在项目里，由人工决定是否恢复。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  DEFAULT_PORT,
  clearPid,
  factoryHome,
  fail,
  fetchJson,
  healthUrl,
  isAlive,
  killTree,
  log,
  readPid,
  sha256File,
} from './_lib.mjs';

const backupDir = resolve(process.argv[2] || fail('usage: node scripts/factory/restore.mjs <backup-dir>'));
const manifestPath = join(backupDir, 'manifest.json');
if (!existsSync(manifestPath)) fail(`no manifest.json in ${backupDir}`);

// ---- 1. verify EVERY file before touching anything -------------------------------------
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
let bad = 0;
for (const file of manifest.files) {
  const path = join(backupDir, file.path);
  if (!existsSync(path)) {
    log(`  ✗ missing: ${file.path}`);
    bad += 1;
    continue;
  }
  const digest = sha256File(path);
  if (digest !== file.sha256) {
    log(`  ✗ corrupt: ${file.path} (sha256 mismatch)`);
    bad += 1;
  }
}
if (bad > 0) fail(`backup failed verification (${bad} files) — NOT restoring. 备份文件存在不等于可恢复。`);
log(`verified ${manifest.files.length} files (${bad} bad)`);

// ---- 2. stop the server (a restore over a live index would be overwritten) --------------
const port = Number(process.env.CEZ_PORT || DEFAULT_PORT);
if (await isAlive(port)) {
  log('stopping the running server first');
  try {
    await fetchJson(healthUrl(port).replace('/health', '/factory/stop'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'factory restore' }),
    }, 15_000);
  } catch {
    /* offline is fine */
  }
}
const pid = readPid();
if (pid && processAliveSafe(pid)) await killTree(pid).catch(() => undefined);
clearPid();

// ---- 3. restore projects ---------------------------------------------------------------
const restored = [];
const projectsDir = join(backupDir, 'projects');
for (const slug of existsSync(projectsDir) ? readdirSync(projectsDir) : []) {
  const src = join(projectsDir, slug);
  if (!existsSync(join(src, '.ai', 'cezar'))) continue;
  // The backup names projects by folder slug; resolve against the backup's projects root.
  const projectRoot = resolve(manifest.projectsRoot, slug);
  const projectDataDir = join(projectRoot, '.ai', 'cezar');
  if (!existsSync(projectDataDir)) {
    log(`  ! project ${slug}: ${projectDataDir} does not exist — skipped (register the project first)`);
    continue;
  }
  // move the current state aside instead of deleting (rollback path)
  const aside = `${projectDataDir}.pre-restore-${Date.now()}`;
  renameSync(projectDataDir, aside);
  mkdirSync(projectDataDir, { recursive: true });
  cpSync(src, projectDataDir, { recursive: true });
  restored.push({ project: slug, previousState: aside });
  log(`  ✓ restored ${slug} (previous state kept at ${basename(aside)})`);
}

// ---- 4. workspace controls --------------------------------------------------------------
mkdirSync(join(factoryHome(), 'factory'), { recursive: true });
for (const f of ['factory/controls.json', 'factory/instance.json']) {
  const src = join(backupDir, 'home', f);
  if (existsSync(src)) cpSync(src, join(factoryHome(), f));
}
// the pid record of the PREVIOUS machine/session must not survive a restore
clearPid();

writeFileSync(join(backupDir, 'RESTORED.json'), JSON.stringify({ restoredAt: new Date().toISOString(), restored }, null, 2), 'utf8');
log(`restore complete — ${restored.length} projects`);
log('下一步：启动服务（scripts/factory/start）——recover() 会对账 running/queued 任务；');
log('git stash 里保留了各 worktree 的未提交快照，由人工决定是否恢复（不自动重放任务）。');

function processAliveSafe(p) {
  try {
    process.kill(p, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}
