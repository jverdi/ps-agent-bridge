import { Command } from "commander";
import { wrapAction, commandFromArgs } from "../core/command.js";
import { CliError } from "../core/errors.js";
import { printData } from "../core/output.js";
import { buildRuntime, persistSession } from "../core/runtime.js";
import type { AdapterMode } from "../types.js";

function parseMode(input: string | undefined): AdapterMode | undefined {
  if (!input) {
    return undefined;
  }
  if (input === "desktop" || input === "cloud") {
    return input;
  }
  throw new CliError(`Invalid mode '${input}'. Expected: desktop|cloud`, 2);
}

export function registerSessionCommands(program: Command): void {
  const session = program.command("session").description("Session lifecycle");

  session
    .command("start")
    .description("Start a psagent session")
    .option("--mode <mode>", "desktop|cloud")
    .option("--profile <name>", "Profile name")
    .action(
      wrapAction(async (...args) => {
        const command = commandFromArgs(args);
        const options = command.opts<{ mode?: string; profile?: string }>();
        const mode = parseMode(options.mode);

        const runtime = buildRuntime(command, {
          mode,
          profile: options.profile
        });

        const health = await runtime.adapter.health();
        if (!health.ok) {
          throw new CliError(health.detail, 4);
        }

        const sessionState = persistSession({
          mode: runtime.config.mode,
          profile: runtime.config.profile,
          startedAt: new Date().toISOString(),
          activeDocument: runtime.session?.activeDocument,
          checkpoints: runtime.session?.checkpoints ?? []
        });

        printData(runtime.config.outputMode, { started: true, session: sessionState, health }, [
          "started=true",
          `mode=${sessionState.mode}`,
          `profile=${sessionState.profile}`,
          `startedAt=${sessionState.startedAt}`
        ]);
      })
    );

  session
    .command("status")
    .description("Show active session")
    .action(
      wrapAction(async (...args) => {
        const command = commandFromArgs(args);
        const runtime = buildRuntime(command);

        if (!runtime.session) {
          throw new CliError("No session. Run: psagent session start", 4);
        }

        const health = await runtime.adapter.health();

        printData(runtime.config.outputMode, { session: runtime.session, health }, [
          `mode=${runtime.session.mode}`,
          `profile=${runtime.session.profile}`,
          `startedAt=${runtime.session.startedAt}`,
          `activeDocument=${runtime.session.activeDocument ?? ""}`,
          `healthOk=${String(health.ok)}`,
          `healthDetail=${health.detail}`
        ]);
      })
    );
}
