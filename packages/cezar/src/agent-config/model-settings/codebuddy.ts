import type { AgentModelSettingsStrategy } from './types.ts';

/**
 * CodeBuddy's native-settings policy. The CLI's settings layout under
 * `~/.codebuddy` is not documented (its reference names `--settings` for inline
 * overrides only), so cezar claims NO native default: the run's model is
 * whatever the task or workspace config says. A row here still exists — an
 * absent row is a type error — and the day the layout is verified this is the
 * single place to start reading it.
 */
export const codebuddyModelSettingsStrategy: AgentModelSettingsStrategy = {
  runner: 'codebuddy',
  async read() {
    return {};
  },
};
