import type { AgentRunner } from './agent-runner.ts';
import { ClaudeCliRunner, mockClaudePath } from './claude-cli-runner.ts';

/**
 * CodeBuddy runner — Tencent WorkBuddy's coding-agent CLI (`codebuddy`, the CLI
 * half of the WorkBuddy desktop app) in headless stream-json mode.
 *
 * The official CLI reference documents the exact Claude-Code-compatible surface
 * this seam already speaks: `--print --input-format stream-json --output-format
 * stream-json --include-partial-messages --permission-mode {default|acceptEdits|
 * auto|dontAsk|plan|bypassPermissions} --append-system-prompt --resume <id>
 * --mcp-config --allowedTools --model --max-turns --add-dir` — so the arg
 * builder, the mock and the whole v1+v2 event mapping are the Claude CLI's,
 * inherited verbatim. What differs is identity only: the backend id, the
 * executable, and the env allowlist (agent-env.ts).
 *
 * Unverified against a live CLI (none installed at integration time — recorded
 * in docs/COMPATIBILITY.md §3): `--session-id` (session pinning) and
 * `--append-system-prompt-file` (Windows long-prompt spool). Both come from the
 * Claude wire this CLI documents itself compatible with; if a live capture
 * disagrees, the fix is here.
 */

export class CodeBuddyRunner extends ClaudeCliRunner implements AgentRunner {
  override readonly backend = 'codebuddy' as const;

  constructor(opts: ConstructorParameters<typeof ClaudeCliRunner>[0] = {}) {
    // `bin` wins over CEZ_CODEBUDDY_BIN over the dry-run mock over the documented
    // command name. The parent's own resolution is deliberately bypassed so a
    // stray CEZ_CLAUDE_BIN can never redirect a codebuddy run.
    super({
      ...opts,
      bin: opts.bin ?? process.env.CEZ_CODEBUDDY_BIN ?? (process.env.CEZ_DRY_RUN === '1' ? mockClaudePath() : 'codebuddy'),
    });
  }
}
