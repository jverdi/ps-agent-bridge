import type { ResolvedConfig } from "../types.js";
import type { PsAdapter } from "./base.js";
import { CloudAdapter } from "./cloud.js";
import { DesktopAdapter } from "./desktop.js";

export function createAdapter(config: ResolvedConfig): PsAdapter {
  if (config.mode === "desktop") {
    return new DesktopAdapter(config.pluginEndpoint, config.timeoutMs);
  }

  return new CloudAdapter(config.apiBase, config.token);
}
