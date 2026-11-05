/**
 * factory backup (spec §5/§15): 一致性备份 — 运行状态（.ai/cezar 索引/事件/factory
 * 状态/artifacts/workflows/skills）、任务分支清单与 worktree 未提交快照（stash create，
 * 不触碰工作树），manifest 记录每个文件的 sha256。不含任何 CEZ_HOME 密钥文件
 * （agent-accounts/tracker-connections/secrets 明确排除）。
 * 若服务在跑：软暂停 + 等待活动任务排空，再快照；结束恢复运行（不解除 stop 意图）。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import {
  DEFAULT_PORT,
  factoryHome,
  fail,
  fetchJson,
  healthUrl,
  isAlive,
  log,
  sha256File,
} from './_lib.mjs';

const port = Number(process.env.CEZ_PORT || DEFAULT_PORT);
const projectsRoot = resolve(process.env.CEZ_PROJECTS_ROOT || process.cwd());
const backupRoot = resolve(process.env.CEZ_BACKUP_DIR || join(process.cwd(), 'factory-backups'));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = join(backupRoot, `backup-${stamp}`);
const wasAlive = await isAlive(port);

// ---- consistency gate -----------------------------------------------------------------
if (wasAlive) {
  log('server running — soft pause + wait for the active task to drain');
  await fetchJson(healthUrl(port).replace('/health', '/factory/pause'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason: 'factory backup' }),
  }, 10_000);
  for (let i = 0; i < 120; i++) {
    const { body } = await fetchJson(healthUrl(port).replace('/health', '/factory/status'));
    if (!body?.activeTaskId && body?.counts?.running === 0) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  const { body } = await fetchJson(healthUrl(port).replace('/health', '/factory/status'));
  if (body?.counts?.running > 0) {
    fail('active task did not drain within 10 minutes — backup aborted (nothing copied)');
  }
}

// ---- copy project state ----------------------------------------------------------------
const STATE_DIRS = ['runs', 'factory', 'artifacts', 'workflows', 'skills'];
const STATE_FILES = ['runs.json', 'config.json', 'todos.json'];
const files = [];
let projectCount = 0;

for (const project of listProjects()) {
  const dataDir = join(project, '.ai', 'cezar');
  if (!existsSync(dataDir)) continue;
  projectCount += 1;
  const slug = basename(project);
  const dest = join(out, 'projects', slug);
  mkdirSync(dest, { recursive: true });
  for (const dir of STATE_DIRS) {
    if (!existsSync(join(dataDir, dir))) continue;
    cpSync(join(dataDir, dir), join(dest, dir), { recursive: true, // tmp files are mid-write atoms — a backup of one would be a lie
        filter: (src) => !src.endsWith('.tmp') && !src.includes('.tmp-') });
  }
  for (const file of STATE_FILES) {
    if (existsSync(join(dataDir, file))) cpSync(join(dataDir, file), join(dest, file));
  }
  // task branches + uncommitted worktree snapshots (never touching the work tree)
  const worktrees = join(dataDir, 'worktrees');
  const git = [];
  if (existsSync(worktrees)) {
    for (const wt of readdirSync(worktrees)) {
      const wtPath = join(worktrees, wt);
      try {
        const branch = execFileSync('git', ['-C', wtPath, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
        const head = execFileSync('git', ['-C', wtPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
        // `stash create` records a WIP commit WITHOUT mutating the worktree; clean trees return empty.
        const wip = execFileSync('git', ['-C', wtPath, 'stash', 'create'], { encoding: 'utf8' }).trim();
        git.push({ worktree: wt, branch, head, wipSnapshot: wip || null });
        if (wip) execFileSync('git', ['-C', wtPath, 'stash', 'store', '-m', `factory backup ${stamp}`, wip], { encoding: 'utf8' });
      } catch {
        git.push({ worktree: wt, error: 'not a git worktree' });
      }
    }
  }
  writeFileSync(join(dest, 'git-branches.json'), JSON.stringify({ project: project, worktrees: git }, null, 2), 'utf8');
}

// ---- CEZ_HOME factory controls (workspace scope, NO secrets) ---------------------------
mkdirSync(join(out, 'home'), { recursive: true });
for (const f of ['factory/controls.json', 'factory/instance.json']) {
  const src = join(factoryHome(), f);
  if (existsSync(src)) cpSync(src, join(out, 'home', f));
}
// explicitly excluded (secrets/credentials): agent-accounts.json, tracker-connections/,
// secrets*, agent-fallback.json, usage-windows.json — the restore path re-reads the live home.
writeFileSync(join(out, 'home', 'EXCLUDED.txt'), 'credentials and per-account state intentionally excluded (spec §15: 不含明文密钥)\n', 'utf8');

// ---- manifest with sha256 ---------------------------------------------------------------
function walk(dir) {
  const acc = [];
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) acc.push(...walk(full));
    else acc.push(full);
  }
  return acc;
}
const manifest = {
  createdAt: new Date().toISOString(),
  node: process.version,
  projectsRoot,
  projectCount,
  files: walk(out).map((path) => ({ path: path.slice(out.length + 1), sha256: sha256File(path), bytes: 0 })),
};
manifest.files = manifest.files.map((f) => ({ ...f, bytes: fileSize(join(out, f.path)) }));
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

if (wasAlive) {
  await fetchJson(healthUrl(port).replace('/health', '/factory/resume'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  }, 10_000);
  log('server resumed (soft pause lifted)');
}

log(`backup complete → ${out} (${projectCount} projects, ${manifest.files.length} files)`);
log('restore with scripts/factory/restore.mjs <backup-dir> — 恢复后先对账，不重放任务');

// ---- helpers ---------------------------------------------------------------------------
function listProjects() {
  // The boot project is the cwd; sibling projects come from the workspace registry.
  const projects = [projectsRoot];
  try {
    const registry = JSON.parse(readFileSync(join(factoryHome(), 'config.json'), 'utf8'));
    for (const p of registry.projects ?? []) {
      if (p.root && existsSync(p.root) && !projects.includes(resolve(p.root))) projects.push(resolve(p.root));
    }
  } catch {
    /* registry absent — boot project only */
  }
  return projects;
}

function fileSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
