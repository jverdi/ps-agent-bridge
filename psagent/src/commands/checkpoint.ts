import { Command } from "commander";
import { wrapAction, commandFromArgs } from "../core/command.js";
import { CliError } from "../core/errors.js";
import { printData } from "../core/output.js";
import { buildRuntime } from "../core/runtime.js";

export function registerCheckpointCommands(program: Command): void {
  const checkpoint = program.command("checkpoint").description("Checkpoint operations");

  checkpoint
    .command("list")
    .description("List known checkpoints")
    .option("--doc <ref>", "Document ref override")
    .action(
      wrapAction(async (...args) => {
        const command = commandFromArgs(args);
        const options = command.opts<{ doc?: string }>();
        const runtime = buildRuntime(command);
        const docRef = options.doc ?? runtime.session?.activeDocument ?? "active";

        const items = runtime.adapter.listCheckpoints
          ? await runtime.adapter.listCheckpoints(docRef)
          : (runtime.session?.checkpoints ?? []);

        const plainLines = items.map((c) => `${c.id}\t${c.createdAt}\t${c.label ?? ""}`);
        printData(runtime.config.outputMode, { docRef, checkpoints: items }, plainLines);
      })
    );

  checkpoint
    .command("restore")
    .description("Restore a checkpoint")
    .argument("<id>", "Checkpoint ID")
    .option("--doc <ref>", "Document ref override")
    .action(
      wrapAction(async (...args) => {
        const command = commandFromArgs(args);
        const checkpointId = args[0] as string;
        const options = command.opts<{ doc?: string }>();
        const runtime = buildRuntime(command);

        const docRef = options.doc ?? runtime.session?.activeDocument ?? "active";

        if (!runtime.adapter.restoreCheckpoint) {
          throw new CliError(`Checkpoint restore not supported in mode=${runtime.config.mode}`, 8);
        }

        const result = await runtime.adapter.restoreCheckpoint(docRef, checkpointId);

        printData(runtime.config.outputMode, { checkpointId, ...result }, [
          `checkpointId=${checkpointId}`,
          `restored=${String(result.restored)}`,
          `detail=${result.detail}`
        ]);
      })
    );
}
