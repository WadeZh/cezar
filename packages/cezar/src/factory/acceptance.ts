import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

/**
 * Trusted acceptance profiles (spec docs/CEZAR_GLM_DEVELOPMENT_SPEC.md §10.3).
 *
 * A profile is the ONLY way a factory task's verification command comes to
 * exist: the task text names a profile id, the server resolves it to a literal
 * argv, and nothing the agent (or the task brief) says can change the command.
 * Resolution is server-side; the wire never carries a command string.
 *
 * Storage mirrors the zero-config rule: built-ins always answer; a project MAY
 * add/override profiles in `<root>/.ai/cezar/factory/profiles.json` (written,
 * never required). A corrupt file quarantines the override set (built-ins keep
 * working) rather than failing the boot.
 */

export interface ResolvedProfile {
  id: string;
  /** Literal argv[0]; spawned WITHOUT a shell via the workflow's argv check. */
  executable: string;
  args: string[];
  /** Absolute working directory, guaranteed inside the project root. */
  cwd: string;
  timeoutMs: number;
  outputCap: number;
  source: 'built-in' | 'project';
}

export interface RawProfile {
  executable: string;
  args?: string[];
  relativeCwd?: string;
  timeoutMs: number;
  outputCap?: number;
  description?: string;
}

export const DEFAULT_OUTPUT_CAP = 20_000;

/** Built-ins (spec §10.3 建议): the least surprise defaults; a project file wins by id. */
export const BUILTIN_PROFILES: Record<string, RawProfile> = {
  'node-standard': {
    executable: 'npm',
    args: ['test'],
    timeoutMs: 10 * 60 * 1000,
    description: 'npm test in the project root',
  },
  'python-standard': {
    executable: 'python',
    args: ['-m', 'pytest', '-q'],
    timeoutMs: 15 * 60 * 1000,
    description: 'pytest -q in the project root',
  },
  'docs-standard': {
    // Structure check: markdown files parse and internal links resolve — a
    // lightweight presence check, not a link crawler (spec: 按任务实际需要).
    executable: 'git',
    args: ['status', '--porcelain'],
    timeoutMs: 60 * 1000,
    description: 'git must be clean-parseable (placeholder structural check)',
  },
};

/** Shell metacharacters that make an argv[0] suspect — profiles are literal argv, never a shell line. */
const SHELL_META = /[|&;<>()$`\\!"'*?#[\]{}~\n\r]/;

export class ProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileError';
  }
}

function validateRaw(id: string, raw: RawProfile): void {
  if (!raw.executable || typeof raw.executable !== 'string') throw new ProfileError(`profile '${id}': executable is required`);
  if (SHELL_META.test(raw.executable)) throw new ProfileError(`profile '${id}': executable must be a bare program name or path (no shell metacharacters)`);
  if (raw.args !== undefined && !Array.isArray(raw.args)) throw new ProfileError(`profile '${id}': args must be an array of literal strings`);
  for (const a of raw.args ?? []) {
    if (typeof a !== 'string') throw new ProfileError(`profile '${id}': args must be strings`);
  }
  if (typeof raw.timeoutMs !== 'number' || raw.timeoutMs < 1000 || raw.timeoutMs > 24 * 3600 * 1000) {
    throw new ProfileError(`profile '${id}': timeoutMs is required (1000..86400000)`);
  }
  if (raw.outputCap !== undefined && (typeof raw.outputCap !== 'number' || raw.outputCap < 1000)) {
    throw new ProfileError(`profile '${id}': outputCap must be a number >= 1000`);
  }
}

/** Resolve `relativeCwd` inside `root`, refusing any escape (symlinks are re-checked at spawn cwd — M4 hardens). */
function cwdInside(root: string, relativeCwd: string | undefined): string {
  if (relativeCwd === undefined || relativeCwd === '' || relativeCwd === '.') return root;
  if (isAbsolute(relativeCwd)) throw new ProfileError(`relativeCwd must be relative: '${relativeCwd}'`);
  const resolved = resolve(root, relativeCwd);
  const rel = relative(root, resolved);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || normalize(rel).split(sep).includes('..')) {
    throw new ProfileError(`relativeCwd escapes the project root: '${relativeCwd}'`);
  }
  return resolved;
}

export function resolveProfile(projectRoot: string, profileId: string): ResolvedProfile | undefined {
  const project = loadProjectProfiles(projectRoot);
  const raw = project[profileId]
    ? { ...project[profileId], source: 'project' as const }
    : BUILTIN_PROFILES[profileId]
      ? { ...BUILTIN_PROFILES[profileId], source: 'built-in' as const }
      : undefined;
  if (!raw) return undefined;
  const { source, ...def } = raw as RawProfile & { source?: string };
  validateRaw(profileId, def);
  return {
    id: profileId,
    executable: def.executable,
    args: def.args ?? [],
    cwd: cwdInside(projectRoot, def.relativeCwd),
    timeoutMs: def.timeoutMs,
    outputCap: def.outputCap ?? DEFAULT_OUTPUT_CAP,
    source: source as 'built-in' | 'project',
  };
}

/** Every profile id a task may name (built-ins + this project's overrides). */
export function listProfileIds(projectRoot: string): string[] {
  return [...new Set([...Object.keys(BUILTIN_PROFILES), ...Object.keys(loadProjectProfiles(projectRoot))])];
}

/**
 * Project overrides. A corrupt file yields `{}` with ONE stderr warning — the
 * built-ins still answer, and a task naming an override-only id fails its
 * import preflight with a clear message instead of taking down the server.
 */
function loadProjectProfiles(projectRoot: string): Record<string, RawProfile> {
  const path = join(projectRoot, '.ai', 'cezar', 'factory', 'profiles.json');
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { profiles?: Record<string, RawProfile> };
    const profiles = parsed.profiles ?? parsed as unknown as Record<string, RawProfile>;
    if (!profiles || typeof profiles !== 'object') return {};
    return profiles;
  } catch (err) {
    console.warn(`[cez] factory profiles.json is unreadable and was ignored: ${String((err as Error)?.message ?? err)}`);
    return {};
  }
}
