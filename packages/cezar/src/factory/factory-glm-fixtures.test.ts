import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isUsageLimitMessage, parseUsageLimit, isUsageExhaustion } from '../core/usage-limit.ts';
import { classifyAgentFailure } from '../core/agent-failure-class.ts';
import { isRuntimeProviderAuthFailure } from '../core/provider-auth.ts';

/**
 * GLM mock fixtures (spec §19: 成功、429、额度耗尽、401、网络断开、异常结束).
 *
 * Each fixture is a REAL error surface the GLM Coding Plan endpoints can emit
 * through the OpenCode runner (OpenAI-compatible `/api/coding/paas/v4` and
 * Anthropic-compatible `/api/anthropic` wire shapes), paired with the
 * classification the pool MUST produce. These pin the taxonomy WITHOUT a live
 * credential — live acceptance (M5 8h) records which real frames actually
 * appear and extends these files; it does not weaken them.
 *
 * The classification entry points are the upstream ones the pool rides on:
 * isUsageLimitMessage / isUsageExhaustion (throttle vs exhaustion, A08),
 * classifyAgentFailure (transient vs auth vs billing), parseUsageLimit (reset
 * extraction) and isRuntimeProviderAuthFailure (401 latch).
 */

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, '..', '..', '..', '..', 'fixtures', 'factory-glm');

interface GlmFixture {
  name: string;
  scenario: string;
  /** The error text the runner would surface (assistant-message error / session.error). */
  surfacedError: string;
  /** Optional wire context (what the endpoint returned, e.g. statusCode). */
  wire: Record<string, unknown>;
  expect: {
    usageLimit?: boolean;
    exhaustion?: boolean;
    failureClass: string;
    authFailure?: boolean;
    resetAt?: string | null;
  };
}

function loadFixtures(): GlmFixture[] {
  const names = ['success', 'throttled-429', 'quota-exhausted', 'invalid-credentials-401', 'network-offline', 'abnormal-end'];
  return names.map((name) =>
    JSON.parse(readFileSync(join(fixturesDir, `${name}.json`), 'utf8')) as GlmFixture,
  );
}

describe('GLM mock fixtures — error taxonomy (A01/A08/A09 离线可验证)', () => {
  const fixtures = loadFixtures();

  it('covers the six required scenarios', () => {
    expect(fixtures.map((f) => f.name)).toEqual([
      'success',
      'throttled-429',
      'quota-exhausted',
      'invalid-credentials-401',
      'network-offline',
      'abnormal-end',
    ]);
  });

  for (const fixture of fixtures) {
    it(`${fixture.name}: ${fixture.scenario}`, () => {
      if (fixture.expect.authFailure !== undefined) {
        expect(isRuntimeProviderAuthFailure(fixture.surfacedError)).toBe(fixture.expect.authFailure);
      }
      if (fixture.expect.usageLimit !== undefined) {
        expect(isUsageLimitMessage(fixture.surfacedError)).toBe(fixture.expect.usageLimit);
      }
      if (fixture.expect.exhaustion !== undefined) {
        expect(isUsageExhaustion(fixture.surfacedError)).toBe(fixture.expect.exhaustion);
      }
      expect(classifyAgentFailure(fixture.surfacedError)).toBe(fixture.expect.failureClass);
      if (fixture.expect.resetAt !== undefined) {
        const parsed = parseUsageLimit(fixture.surfacedError);
        expect(parsed?.resetAt ?? null).toBe(fixture.expect.resetAt);
      }
    });
  }

  it('the pool treats a plain 429 as throttle, NOT account exhaustion (A08)', () => {
    const throttled = fixtures.find((f) => f.name === 'throttled-429')!;
    expect(throttled.expect.exhaustion).toBe(false);
    // throttle never books a hold by itself — only proven exhaustion does (spec §6.3)
  });

  it('quota exhaustion carries NO fabricated reset time (A09: 未知就是未知)', () => {
    const exhausted = fixtures.find((f) => f.name === 'quota-exhausted')!;
    expect(exhausted.expect.resetAt).toBeNull();
  });
});
