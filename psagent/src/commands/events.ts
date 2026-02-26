import { Command } from "commander";
import { wrapAction, commandFromArgs } from "../core/command.js";
import { printData } from "../core/output.js";
import { buildRuntime } from "../core/runtime.js";

export function registerEventsCommands(program: Command): void {
  const events = program.command("events").description("Event stream");

  events
    .command("tail")
    .description("Read recent events")
    .option("--count <n>", "Number of events", "20")
    .action(
      wrapAction(async (...args) => {
        const command = commandFromArgs(args);
        const options = command.opts<{ count: string }>();
        const runtime = buildRuntime(command);

        const count = Math.max(1, Number.parseInt(options.count, 10) || 20);
        const result = await runtime.adapter.tailEvents(count);

        const plainLines = result.map((event) => `${event.timestamp}\t${event.level}\t${event.message}`);
        printData(runtime.config.outputMode, { events: result }, plainLines);
      })
    );
}
