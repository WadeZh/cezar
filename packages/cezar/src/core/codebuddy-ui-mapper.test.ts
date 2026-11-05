import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { UiEvent } from './ui-events.ts';
import {
  claudeTurnStarted,
  createClaudeUiState,
  mapClaudeMessage,
  type ClaudeUiMapping,
} from './claude-ui-mapper.ts';
import { CodeBuddyRunner } from './codebuddy-runner.ts';

/**
 * CodeBuddy golden fixtures — replayed through the INHERITED claude mapper
 * (CodeBuddy documents the Claude-Code headless wire; `codebuddy-runner.ts`
 * adds identity, not protocol). See `__fixtures__/codebuddy/README.md` for the
 * fixture provenance: copies of the claude captures, live capture pending a
 * CLI install — the round-trip here proves the inherited mapping and the
 * fixtures agree, not that the live wire was observed.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '__fixtures__', 'codebuddy');

function replay(fixture: string): UiEvent[] {
  const raw = readFileSync(join(FIXTURES, `${fixture}.ndjson`), 'utf8');
  let state = createClaudeUiState();
  const events: UiEvent[] = [];
  const push = (mapped: ClaudeUiMapping): void => {
    state = mapped.state;
    events.push(...mapped.events);
  };
  push(claudeTurnStarted(state));
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      push(mapClaudeMessage(JSON.parse(line), state));
    } catch {
      continue; // malformed lines are skipped, as the runner does
    }
  }
  return events;
}

const GOLDEN_FIXTURES = [
  'text-turn',
  'bash-and-screenshot',
  'thinking-edit-write-todo',
  'subagent-task',
  'failed-and-denied',
  'task-tools-plan',
  'partial-messages',
] as const;

describe('codebuddy → v2 golden fixtures (inherited claude wire)', () => {
  for (const fixture of GOLDEN_FIXTURES) {
    it(`maps ${fixture} to the exact UiEvent sequence`, () => {
      const actual = JSON.parse(JSON.stringify(replay(fixture)));
      expect(actual).toStrictEqual(JSON.parse(readFileSync(join(FIXTURES, `${fixture}.expected.json`), 'utf8')));
    });
  }

  it('identifies as the codebuddy backend and resolves its own executable', () => {
    const runner = new CodeBuddyRunner();
    expect(runner.backend).toBe('codebuddy');
  });

  it('honors CEZ_CODEBUDDY_BIN, never a stray CEZ_CLAUDE_BIN (a claude override must not redirect a codebuddy run)', () => {
    const savedBuddy = process.env.CEZ_CODEBUDDY_BIN;
    const savedClaude = process.env.CEZ_CLAUDE_BIN;
    process.env.CEZ_CLAUDE_BIN = 'claude-from-a-claude-user';
    process.env.CEZ_CODEBUDDY_BIN = 'codebuddy-explicit';
    try {
      expect((new CodeBuddyRunner() as unknown as { bin: string }).bin).toBe('codebuddy-explicit');
      delete process.env.CEZ_CODEBUDDY_BIN;
      expect((new CodeBuddyRunner() as unknown as { bin: string }).bin).toBe('codebuddy');
    } finally {
      if (savedBuddy === undefined) delete process.env.CEZ_CODEBUDDY_BIN;
      else process.env.CEZ_CODEBUDDY_BIN = savedBuddy;
      if (savedClaude === undefined) delete process.env.CEZ_CLAUDE_BIN;
      else process.env.CEZ_CLAUDE_BIN = savedClaude;
    }
  });
});
