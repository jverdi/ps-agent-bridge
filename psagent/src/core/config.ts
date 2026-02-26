import path from "node:path";
import os from "node:os";
import type { AdapterMode, GlobalCliOptions, ResolvedConfig, SessionState } from "../types.js";
import { readConfigFile } from "./state.js";

interface ConfigFileShape {
  mode?: AdapterMode;
  profile?: string;
  pluginEndpoint?: string;
  apiBase?: string;
  token?: string;
  timeoutMs?: number;
  dryRun?: boolean;
}

function parseNumber(input: string | undefined, fallback: number): number {
  if (!input) {
    return fallback;
  }
  const parsed = Number.parseInt(input, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(input: string | undefined, fallback: boolean): boolean {
  if (input === undefined) {
    return fallback;
  }
  const value = input.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function readUserConfig(configPath: string): ConfigFileShape {
  return readConfigFile<ConfigFileShape>(configPath) ?? {};
}

function readProjectConfig(projectConfigPath: string): ConfigFileShape {
  return readConfigFile<ConfigFileShape>(projectConfigPath) ?? {};
}

export function resolveConfig(cli: GlobalCliOptions, session: SessionState | null): ResolvedConfig {
  const userConfigPath = cli.config ?? path.join(os.homedir(), ".config", "psagent", "config.json");
  const projectConfigPath = path.join(process.cwd(), ".psagent.json");

  const userConfig = readUserConfig(userConfigPath);
  const projectConfig = readProjectConfig(projectConfigPath);

  const mode =
    cli.mode ??
    (process.env.PSAGENT_MODE as AdapterMode | undefined) ??
    session?.mode ??
    projectConfig.mode ??
    userConfig.mode ??
    "desktop";

  const profile =
    cli.profile ?? process.env.PSAGENT_PROFILE ?? session?.profile ?? projectConfig.profile ?? userConfig.profile ?? "default";

  const outputMode = cli.json ? "json" : cli.plain ? "plain" : "human";

  const timeoutMs =
    parseNumber(cli.timeout, NaN) ||
    parseNumber(process.env.PSAGENT_TIMEOUT_MS, NaN) ||
    projectConfig.timeoutMs ||
    userConfig.timeoutMs ||
    15_000;

  const pluginEndpoint =
    process.env.PSAGENT_PLUGIN_ENDPOINT ?? projectConfig.pluginEndpoint ?? userConfig.pluginEndpoint ?? "http://127.0.0.1:43120";

  const apiBase = process.env.PSAGENT_API_BASE ?? projectConfig.apiBase ?? userConfig.apiBase ?? "https://image.adobe.io/pie/psdService";

  const token = process.env.PSAGENT_TOKEN ?? projectConfig.token ?? userConfig.token;

  const dryRun =
    Boolean(cli.dryRun) ||
    parseBoolean(process.env.PSAGENT_DRY_RUN, false) ||
    projectConfig.dryRun === true ||
    userConfig.dryRun === true;

  return {
    mode,
    profile,
    outputMode,
    timeoutMs,
    pluginEndpoint,
    apiBase,
    token,
    dryRun,
    configPath: userConfigPath,
    projectConfigPath
  };
}
