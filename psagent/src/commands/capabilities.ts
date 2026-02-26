import { Command } from "commander";
import { wrapAction, commandFromArgs } from "../core/command.js";
import { printData } from "../core/output.js";
import { buildRuntime } from "../core/runtime.js";

export function registerCapabilitiesCommand(program: Command): void {
  program
    .command("capabilities")
    .description("List adapter capabilities")
    .action(
      wrapAction(async (...args) => {
        const command = commandFromArgs(args);
        const runtime = buildRuntime(command);

        const data = {
          mode: runtime.config.mode,
          capabilities: runtime.adapter.capabilities()
        };

        printData(runtime.config.outputMode, data, [
          `mode=${data.mode}`,
          ...Object.entries(data.capabilities).map(([key, value]) => `${key}=${String(value)}`)
        ]);
      })
    );
}
