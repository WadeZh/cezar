# CodeBuddy fixtures — provenance (AGENT_PROTOCOL.md §7)

**Not a live capture.** No `codebuddy` CLI was installed on the integration
machine, so these files are COPIES of `__fixtures__/claude/` — the wire
CodeBuddy documents itself compatible with.

## Why that is the right presumption (and what it presumes)

The official CodeBuddy CLI reference (workbuddy.ai / Tencent Cloud docs,
`--print`, `--input-format stream-json`, `--output-format stream-json`,
`--include-partial-messages`, `--permission-mode {default|acceptEdits|auto|
dontAsk|plan|bypassPermissions}`, `--append-system-prompt`, `--resume <id>`,
`--mcp-config`, `--allowedTools`, `--disallowedTools`, `--model`, `--max-turns`,
`--add-dir`) names the exact Claude-Code headless surface `ClaudeCliRunner`
speaks, flag for flag and value for value — the runner class this backend
inherits (`codebuddy-runner.ts`).

## Unverified flags (live capture pending — docs/COMPATIBILITY.md §3)

- `--session-id` — session pinning. Documented for CodeBuddy only via
  `--resume`/`--continue`; `--session-id` comes from the Claude wire it forks.
- `--append-system-prompt-file` — Windows long-prompt spool (>8 KiB argv).
  The reference documents `--system-prompt-file` (replace) and
  `--append-system-prompt` (append) but not the append-file variant.

If a live capture disagrees, the fixtures AND the inherited arg builder are the
two places to correct — record the capture date and CLI version here.
