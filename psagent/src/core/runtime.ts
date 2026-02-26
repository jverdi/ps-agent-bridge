import type { Command } from "commander";
import { createAdapter } from "../adapters/factory.js";
import type { PsAdapter } from "../adapters/base.js";
import type { AdapterMode, GlobalCliOptions, ResolvedConfig, SessionState } from "../types.js";
import { resolveConfig } from "./config.js";
import { loadSession, saveSession } from "./state.js";

export interface RuntimeContext {
  config: ResolvedConfig;
  adapter: PsAdapter;
  session: SessionState | null;
}

function createRuntime(cliOptions: GlobalCliOptions): RuntimeContext {
  const session = loadSession();

  const config = resolveConfig(cliOptions, session);
  const adapter = createAdapter(config);

  return {
    config,
    adapter,
    session
  };
}

function readGlobalOptions(command: Command): GlobalCliOptions {
  return command.optsWithGlobals() as GlobalCliOptions;
}

export function buildRuntime(command: Command, overrides?: { mode?: AdapterMode; profile?: string }): RuntimeContext {
  const cliOptions = readGlobalOptions(command);
  return createRuntime(
    {
      ...cliOptions,
      mode: overrides?.mode ?? cliOptions.mode,
      profile: overrides?.profile ?? cliOptions.profile
    }
  );
}

export function buildRuntimeFromOptions(cliOptions: GlobalCliOptions): RuntimeContext {
  return createRuntime(cliOptions);
}

export function persistSession(next: SessionState): SessionState {
  saveSession(next);
  return next;
}
