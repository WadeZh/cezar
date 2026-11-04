import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteJsonSync } from './state.ts';

/**
 * Workspace-level factory controls (spec §8 全局暂停 / §9.2 每日预算 / §12 stop).
 *
 * Lives at `<cezarHome>/factory/controls.json` — workspace scope (one per
 * machine-level CEZ_HOME), NOT per project, because the spec puts the global
 * pause/stop and the local daily budget at workspace level ("全局预算和账户
 * hold 存在工作区级").
 *
 * Semantics (spec §8): 软暂停 (paused) blocks NEW dispatch only — the active
 * task may finish. 硬停止 (stopped) interrupts the current process tree and
 * blocks everything; the stopped flag survives restarts ("重启保持停止意图",
 * A14) and only an explicit resume clears it. Neither is ever conflated with a
 * run failure.
 */

const CONTROLS_SCHEMA_VERSION = 1;

export const DEFAULT_MAX_NEW_TASKS_PER_DAY = 20;

export interface FactoryControls {
  schemaVersion: number;
  paused: boolean;
  pausedReason?: string;
  stopped: boolean;
  stoppedReason?: string;
  /** Local-statistics day (Asia/Shanghai) the counter belongs to. */
  budgetDay: string;
  startedToday: number;
  maxNewTasksPerDay: number;
  /** Category weights for weighted round-robin; software:traffic:weather = 5:3:2 (spec §9.1). */
  weights: { software: number; traffic: number; weather: number };
  updatedAt: string;
}

export function factoryControlsPath(homeDir: string): string {
  return join(homeDir, 'factory', 'controls.json');
}

/** The local-statistics day for Asia/Shanghai regardless of host TZ (spec §9.2). */
export function shanghaiDay(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return parts; // en-CA yields YYYY-MM-DD
}

export function loadFactoryControls(homeDir: string, now = new Date()): FactoryControls {
  const path = factoryControlsPath(homeDir);
  const today = shanghaiDay(now);
  if (!existsSync(path)) {
    return {
      schemaVersion: CONTROLS_SCHEMA_VERSION,
      paused: false,
      stopped: false,
      budgetDay: today,
      startedToday: 0,
      maxNewTasksPerDay: DEFAULT_MAX_NEW_TASKS_PER_DAY,
      weights: { software: 5, traffic: 3, weather: 2 },
      updatedAt: now.toISOString(),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // Controls are a BRAKE. A file we cannot read must never unlock dispatch —
    // fail safe: treat as hard-stopped until a human fixes the file.
    return {
      schemaVersion: CONTROLS_SCHEMA_VERSION,
      paused: false,
      stopped: true,
      stoppedReason: 'controls.json unreadable — factory stopped fail-safe',
      budgetDay: today,
      startedToday: 0,
      maxNewTasksPerDay: DEFAULT_MAX_NEW_TASKS_PER_DAY,
      weights: { software: 5, traffic: 3, weather: 2 },
      updatedAt: now.toISOString(),
    };
  }
  const raw = (parsed ?? {}) as Partial<FactoryControls>;
  const rolled = raw.budgetDay !== today;
  return {
    schemaVersion: CONTROLS_SCHEMA_VERSION,
    paused: raw.paused === true,
    pausedReason: typeof raw.pausedReason === 'string' ? raw.pausedReason : undefined,
    stopped: raw.stopped === true,
    stoppedReason: typeof raw.stoppedReason === 'string' ? raw.stoppedReason : undefined,
    budgetDay: rolled ? today : raw.budgetDay ?? today,
    startedToday: rolled ? 0 : typeof raw.startedToday === 'number' ? raw.startedToday : 0,
    maxNewTasksPerDay:
      typeof raw.maxNewTasksPerDay === 'number' && raw.maxNewTasksPerDay >= 1
        ? raw.maxNewTasksPerDay
        : DEFAULT_MAX_NEW_TASKS_PER_DAY,
    weights: {
      software: raw.weights?.software && raw.weights.software >= 0 ? raw.weights.software : 5,
      traffic: raw.weights?.traffic && raw.weights.traffic >= 0 ? raw.weights.traffic : 3,
      weather: raw.weights?.weather && raw.weights.weather >= 0 ? raw.weights.weather : 2,
    },
    updatedAt: now.toISOString(),
  };
}

export function saveFactoryControls(homeDir: string, controls: FactoryControls, now = new Date()): void {
  atomicWriteJsonSync(factoryControlsPath(homeDir), { ...controls, updatedAt: now.toISOString() });
}

export function setPaused(homeDir: string, paused: boolean, reason?: string, now = new Date()): FactoryControls {
  const next = loadFactoryControls(homeDir, now);
  next.paused = paused;
  next.pausedReason = paused ? reason : undefined;
  saveFactoryControls(homeDir, next, now);
  return next;
}

export function setStopped(homeDir: string, stopped: boolean, reason?: string, now = new Date()): FactoryControls {
  const next = loadFactoryControls(homeDir, now);
  next.stopped = stopped;
  next.stoppedReason = stopped ? reason : undefined;
  saveFactoryControls(homeDir, next, now);
  return next;
}

/**
 * Whether a NEW task may start right now. Stopped beats paused; the daily
 * budget is a local knob only (spec §6.3: 与官方额度分开显示).
 */
export function dispatchAllowed(controls: FactoryControls): { ok: boolean; reason?: string } {
  if (controls.stopped) return { ok: false, reason: controls.stoppedReason ?? 'factory stopped' };
  if (controls.paused) return { ok: false, reason: controls.pausedReason ?? 'factory paused' };
  if (controls.startedToday >= controls.maxNewTasksPerDay) {
    return { ok: false, reason: 'daily local budget exhausted — waits for the next Asia/Shanghai day' };
  }
  return { ok: true };
}

export function recordTaskStart(homeDir: string, now = new Date()): FactoryControls {
  const next = loadFactoryControls(homeDir, now);
  next.startedToday += 1;
  saveFactoryControls(homeDir, next, now);
  return next;
}
