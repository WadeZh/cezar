/**
 * Shared plumbing for the Cezar-GLM factory ops scripts (spec §5 运维脚本).
 * Zero dependencies, cross-platform; PowerShell appears only in install-autostart.ps1.
 * Paths with spaces must survive everywhere — every spawn uses argv arrays, never a shell line.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const DEFAULT_PORT = 4321;

export function factoryHome() {
  return process.env.CEZ_HOME ? resolve(process.env.CEZ_HOME) : join(homedir(), '.cezar');
}

export function repoRoot() {
  // scripts/factory/_lib.mjs → repo root is two levels up.
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

import { fileURLToPath } from 'node:url';

export function serverEntry(root = repoRoot()) {
  // The built CLI (spec §5: 使用已构建的本地固定版本); `npm run build` produces it.
  const dist = join(root, 'packages', 'cezar', 'dist', 'index.js');
  if (!existsSync(dist)) throw new Error(`built server not found: ${dist} — run "npm run build" first`);
  return dist;
}

export function pidFile() {
  return join(factoryHome(), 'factory', 'server.pid');
}

export function readPid() {
  try {
    const raw = parseInt(readFileSync(pidFile(), 'utf8').trim(), 10);
    return Number.isSafeInteger(raw) && raw > 0 ? raw : undefined;
  } catch {
    return undefined;
  }
}

export function writePid(pid) {
  mkdirSync(dirname(pidFile()), { recursive: true });
  writeFileSync(pidFile(), String(pid), 'utf8');
}

export function clearPid() {
  try {
    unlinkSync(pidFile());
  } catch {
    /* absent is fine */
  }
}

export function serverLog() {
  return join(factoryHome(), 'factory', 'server.log');
}

export async function fetchJson(url, init, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

export function healthUrl(port) {
  return `http://127.0.0.1:${port}/api/v1/health`;
}

export async function isAlive(port) {
  try {
    const { status } = await fetchJson(healthUrl(port), undefined, 2500);
    return status === 200;
  } catch {
    return false;
  }
}

export function spawnDetached(entry, args, cwd, out) {
  mkdirSync(dirname(out), { recursive: true });
  const fd = openSync(out, 'a');
  const child = spawn(process.execPath, [entry, ...args], {
    cwd,
    detached: true,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

/** Kill a process TREE. Windows: taskkill /T /F (the same primitive the service trusts). */
export async function killTree(pid) {
  if (process.platform === 'win32') {
    await new Promise((resolvePromise, reject) => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 6000, windowsHide: true }, (err) =>
        err ? reject(err) : resolvePromise(),
      );
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    process.kill(pid, 'SIGKILL');
  }
}

export function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err && err.code) !== 'ESRCH';
  }
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function mtimeOf(path) {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return '';
  }
}

export function log(message) {
  process.stdout.write(`${message}\n`);
}

export function fail(message) {
  process.stderr.write(`[factory] ${message}\n`);
  process.exit(1);
}

export { existsSync, join, mkdirSync, readFileSync, statSync, writeFileSync };
